/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin, insertAccountingPeriod, postJournal } from './helpers/accounting-fixtures';
import { addDisputeHistory, seedDispute } from './helpers/accounting-orders-fixtures';
import { receiveReturn, returnFacts, seedReturnFlow, type ReturnFlow } from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';
import type { ReceiveUnit } from './helpers/unit-binding-receive';

// 計画3 Task 4（S18）: 返品の届いた日（受け取りで選ぶ・後で直す・配達日の設定）。
jest.setTimeout(120000);

type Failure = { code?: string; message?: string; detail?: string };
const unit = (lineId: string, quantity = 1, refundChoice?: 'now' | 'consult'): ReceiveUnit =>
	({ return_line_id: lineId, disposition: 'not_restocked', quantity, ...(refundChoice ? { refund_choice: refundChoice } : {}) });

describeLocalDb('FREQ-575-AC-01: S18 return arrival date', (db) => {
	beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
	afterEach(async () => { await db().query('rollback'); });

	const q = (text: string, params?: unknown[]) => db().query(text, params);
	async function failure(run: () => Promise<unknown>): Promise<Failure> {
		await q('savepoint s18_arrival');
		try { await run(); return {}; }
		catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
		finally { await q('rollback to savepoint s18_arrival'); await q('release savepoint s18_arrival'); }
	}
	/** 日本時間の今日から n 日前（YYYY-MM-DD）。 */
	const day = async (n: number) => (await q("select (((now() at time zone 'Asia/Tokyo')::date) - $1::integer)::text as d", [n])).rows[0].d as string;
	/** 返品の申し込みを n 日前にする（前の日を選ぶ試験の土台）。 */
	const requestedDaysAgo = async (returnId: string, n: number) => {
		// 申し込みの時刻は変えられない列なので、試験の取引の中だけ利用者のトリガーを外して直す
		await q('alter table public.order_returns disable trigger user');
		await q("update public.order_returns set requested_at = now() - make_interval(days => $2::integer) where id=$1", [returnId, n]);
		await q('alter table public.order_returns enable trigger user');
	};
	const receive = (flow: ReturnFlow, arrivedOn: string | null, key = randomUUID()) =>
		receiveReturn(db(), flow, { choice: 'consult', key, arrivedOn, units: [unit(flow.lineIds[0], 1, 'consult')] });
	const receipts = async (returnId: string) => (await q("select id, arrived_on::text as arrived_on from public.order_return_receipts where return_id=$1 and kind='receive'", [returnId])).rows;
	const correct = async (actor: string, receiptId: string, newOn: string, version: number, key = randomUUID(), reason = '配送の記録を見直した') =>
		(await q('select public.admin_correct_return_arrival_date($1,$2,$3::date,$4,$5,$6) as r', [actor, receiptId, newOn, reason, version, key])).rows[0].r as {
			receipt_id: string; version: number; previous_on: string; new_on: string; correction_id: string; replayed: boolean };
	const arrivalOn = async (receiptId: string) => (await q('select private.accounting_return_arrival_on($1)::text as d', [receiptId])).rows[0].d as string;
	const invalidDate = (detail: string) => ({ code: '22023', message: 'RETURN_ARRIVAL_DATE_INVALID', detail });

	/** 注文の支払いの取り消しを、days 日前に負けが確定した物にする（C の仕訳は withEntryDaysAgo 日前の日付で入れる）。 */
	async function lostDispute(orderId: string, days: number, withEntryDaysAgo?: number) {
		const at = `${await day(days)}T03:00:00+09:00`;
		const { disputeId } = await seedDispute(db(), { orderId, amount: 1000, withdrawnAt: null, createdAt: at });
		await addDisputeHistory(db(), { disputeId, status: 'lost', occurredAt: at, stripeEventCreatedAt: at });
		if (withEntryDaysAgo !== undefined) {
			const entryDate = await day(withEntryDaysAgo);
			const existing = (await q('select id from public.accounting_periods where $1::date between starts_on and ends_on order by starts_on limit 1', [entryDate])).rows[0];
			const periodId = existing?.id ?? await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: `${entryDate.slice(0, 4)}-01-01`, endsOn: `${entryDate.slice(0, 4)}-12-31` });
			const posted = await postJournal(db(), { periodId, entryDate, kind: 'dispute_event', parts: [disputeId, 'confirmed', 'lost'],
				lines: [{ account: '7530', debit: 1000 }, { account: '1470', credit: 1000 }] });
			expect((await q('select dedupe_key = private.accounting_dispute_key($2,$3,$4) as ok from public.accounting_journal_entries where id=$1',
				[posted.entryId, disputeId, 'confirmed', 'lost'])).rows[0].ok).toBe(true);
		}
		return disputeId;
	}

	test('FREQ-575-AC-01: 届いた日を渡さない受け取りは記録した日（日本時間）が入る', async () => {
		const flow = await seedReturnFlow(db());
		const received = await receive(flow, null);
		expect(await receipts(flow.returnId)).toEqual([{ id: received.receipt_id, arrived_on: await day(0) }]);
		expect(await arrivalOn(received.receipt_id)).toBe(await day(0));
	});

	test('FREQ-575-AC-01: 前の日を選べるが、未来の日・申し込みの前の日は RETURN_ARRIVAL_DATE_INVALID で断り、受け取りも事実も残らない', async () => {
		const flow = await seedReturnFlow(db());
		await requestedDaysAgo(flow.returnId, 5);
		expect(await failure(() => receive(flow, '2999-01-01'))).toMatchObject(invalidDate('future'));
		expect(await failure(() => receive(flow, '2000-01-01'))).toMatchObject(invalidDate('before_request'));
		expect(await failure(() => receive(flow, '2000-01-01'))).toMatchObject(invalidDate('before_request'));
		expect(await failure(async () => receive(flow, await day(-1)))).toMatchObject(invalidDate('future'));
		expect(await failure(async () => receive(flow, await day(6)))).toMatchObject(invalidDate('before_request'));
		expect(await receipts(flow.returnId)).toEqual([]);
		expect(await returnFacts(db(), flow.returnId)).toEqual([]);
		const received = await receive(flow, await day(5));
		expect(await receipts(flow.returnId)).toEqual([{ id: received.receipt_id, arrived_on: await day(5) }]);
		expect(await returnFacts(db(), flow.returnId)).toHaveLength(1);
	});

	test('FREQ-575-AC-01: 注文のカード会社の取り消しが確定した日以前の届いた日は断る', async () => {
		const flow = await seedReturnFlow(db());
		await requestedDaysAgo(flow.returnId, 10);
		await lostDispute(flow.f.orderId, 6);
		expect(await failure(async () => receive(flow, await day(6)))).toMatchObject(invalidDate('dispute_confirmed'));
		expect(await failure(async () => receive(flow, await day(8)))).toMatchObject(invalidDate('dispute_confirmed'));
		const received = await receive(flow, await day(5));
		expect(received.receipt_id).toBeTruthy();
	});

	test('FREQ-575-AC-01: 注文に確定した取り消しが2件以上あっても、届いた日の検査は確定の日のうち一番遅い日以前を断る（C の有無は取り消しごと）', async () => {
		const flow = await seedReturnFlow(db());
		await requestedDaysAgo(flow.returnId, 10);
		// 1件目は7日前に負け、C の仕訳は6日前。2件目は3日前に負け、C はまだ無い
		await lostDispute(flow.f.orderId, 7, 6);
		await lostDispute(flow.f.orderId, 3);
		expect((await q('select private.accounting_order_dispute_confirmed_on($1)::text as d', [flow.f.orderId])).rows[0].d).toBe(await day(3));
		expect(await failure(async () => receive(flow, await day(3)))).toMatchObject(invalidDate('dispute_confirmed'));
		expect((await receive(flow, await day(2))).receipt_id).toBeTruthy();
	});

	test('FREQ-575-AC-01: 取り消しの確定の日は、C の仕訳があればその日付（負けの時刻の日でなく）', async () => {
		const flow = await seedReturnFlow(db());
		await requestedDaysAgo(flow.returnId, 10);
		await lostDispute(flow.f.orderId, 7, 4);
		expect((await q('select private.accounting_order_dispute_confirmed_on($1)::text as d', [flow.f.orderId])).rows[0].d).toBe(await day(4));
		expect(await failure(async () => receive(flow, await day(4)))).toMatchObject(invalidDate('dispute_confirmed'));
		expect((await q('select private.accounting_order_dispute_confirmed_on($1) as d', [randomUUID()])).rows[0].d).toBeNull();
	});

	test('FREQ-575-AC-01: 確定の後の同じ要求の再送は、検査で断られず前の結果を返す', async () => {
		const flow = await seedReturnFlow(db());
		await requestedDaysAgo(flow.returnId, 10);
		const key = randomUUID();
		const first = await receive(flow, await day(5), key);
		await lostDispute(flow.f.orderId, 2);
		const again = await receive(flow, await day(5), key);
		expect(again).toMatchObject({ receipt_id: first.receipt_id, replayed: true });
		// 違う日の同じ番号は、前と違う要求
		expect(await failure(async () => receive(flow, await day(4), key))).toMatchObject({ message: 'RETURN_REQUEST_MISMATCH' });
	});

	describe('corrections', () => {
		async function received(daysAgo = 5) {
			const flow = await seedReturnFlow(db());
			await requestedDaysAgo(flow.returnId, 10);
			const r = await receive(flow, await day(daysAgo));
			const admin = await insertAccountingAdmin(db());
			return { flow, receiptId: r.receipt_id, admin };
		}

		test('FREQ-575-AC-02: 届いた日を直すと版1・前の日・新しい日・理由・人が残り、受け取りの行は変わらない', async () => {
			const { receiptId, admin } = await received();
			const before = (await q('select * from public.order_return_receipts where id=$1', [receiptId])).rows[0];
			const result = await correct(admin, receiptId, await day(3), 0);
			expect(result).toMatchObject({ receipt_id: receiptId, version: 1, previous_on: await day(5), new_on: await day(3), replayed: false });
			expect((await q('select version, previous_on::text, new_on::text, reason, actor_id from public.order_return_arrival_corrections where receipt_id=$1', [receiptId])).rows)
				.toEqual([{ version: 1, previous_on: await day(5), new_on: await day(3), reason: '配送の記録を見直した', actor_id: admin }]);
			expect((await q('select * from public.order_return_receipts where id=$1', [receiptId])).rows[0]).toEqual(before);
			expect(await arrivalOn(receiptId)).toBe(await day(3));
		});

		test('FREQ-575-AC-03: 今の届いた日は最新の直しで、直しを2回すると版2が最新になる', async () => {
			const { receiptId, admin } = await received();
			await correct(admin, receiptId, await day(3), 0);
			const second = await correct(admin, receiptId, await day(4), 1);
			expect(second).toMatchObject({ version: 2, previous_on: await day(3), new_on: await day(4) });
			expect(await arrivalOn(receiptId)).toBe(await day(4));
			const info = (await q('select public.get_return_arrival_info($1::uuid[]) as j', [[receiptId]])).rows[0].j;
			expect(info).toEqual([expect.objectContaining({ receipt_id: receiptId, arrived_on_original: await day(5), arrived_on_current: await day(4), version: 2,
				corrections: [expect.objectContaining({ version: 1, previous_on: await day(5), new_on: await day(3) }),
					expect.objectContaining({ version: 2, previous_on: await day(3), new_on: await day(4) })] })]);
		});

		test('FREQ-575-AC-02: 直しの権限が無い人は42501で断られ、版違いはVERSION_CONFLICT、同じ日・検品の受け取り・未来の日も断る', async () => {
			const { flow, receiptId, admin } = await received();
			expect(await failure(async () => correct(flow.f.actor, receiptId, await day(3), 0))).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
			expect(await failure(async () => correct(admin, receiptId, await day(3), 1))).toMatchObject({ code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' });
			expect(await failure(async () => correct(admin, receiptId, await day(5), 0))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
			expect(await failure(async () => correct(admin, receiptId, await day(-1), 0))).toMatchObject(invalidDate('future'));
			expect(await failure(async () => correct(admin, receiptId, await day(11), 0))).toMatchObject(invalidDate('before_request'));
			expect(await failure(async () => correct(admin, randomUUID(), await day(3), 0))).toMatchObject({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
			expect(await failure(async () => correct(admin, receiptId, await day(3), 0, randomUUID(), ''))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
		});

		test('FREQ-575-AC-05: 同じ要求番号で同じ内容は前の結果、違う内容はREQUEST_KEY_CONFLICT', async () => {
			const { receiptId, admin } = await received();
			const key = randomUUID();
			const first = await correct(admin, receiptId, await day(3), 0, key);
			const again = await correct(admin, receiptId, await day(3), 0, key);
			expect(again).toEqual({ ...first, replayed: true });
			expect(await failure(async () => correct(admin, receiptId, await day(2), 0, key))).toMatchObject({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
			expect(Number((await q('select count(*) n from public.order_return_arrival_corrections where receipt_id=$1', [receiptId])).rows[0].n)).toBe(1);
		});

		test('FREQ-581-AC-07: 確定済みの注文では、確定の日以前への届いた日の入れ替え（直し）も断る', async () => {
			const { flow, receiptId, admin } = await received(2);
			await lostDispute(flow.f.orderId, 4);
			expect(await failure(async () => correct(admin, receiptId, await day(4), 0))).toMatchObject(invalidDate('dispute_confirmed'));
			expect(await failure(async () => correct(admin, receiptId, await day(6), 0))).toMatchObject(invalidDate('dispute_confirmed'));
			expect((await correct(admin, receiptId, await day(1), 0)).version).toBe(1);
		});

		test('FREQ-581-AC-07: 確定の相殺が入った後、確定の日以前だった届いた日を後の日へ直すのも断る', async () => {
			const { flow, receiptId, admin } = await received(6);
			await lostDispute(flow.f.orderId, 5, 4);
			expect(await failure(async () => correct(admin, receiptId, await day(2), 0))).toMatchObject(invalidDate('dispute_confirmed'));
			expect(Number((await q('select count(*) n from public.order_return_arrival_corrections where receipt_id=$1', [receiptId])).rows[0].n)).toBe(0);
		});
	});

	describe('carrier delivery date option', () => {
		const setOption = async (actor: string, enabled: boolean, version: number, key = randomUUID()) =>
			(await q('select public.admin_set_return_arrival_option($1,$2,$3,$4) as r', [actor, enabled, version, key])).rows[0].r as Record<string, unknown>;
		const option = async () => (await q('select public.get_return_arrival_option() as j')).rows[0].j as Record<string, unknown>;

		test('FREQ-575-AC-04: 配達日の設定は既定オフで、切り替えると日と人が残り、版違いはVERSION_CONFLICT', async () => {
			expect(await option()).toMatchObject({ use_carrier_delivery_date: false, changed_at: null, changed_by: null, version: '1' });
			const admin = await insertAccountingAdmin(db());
			const key = randomUUID();
			const result = await setOption(admin, true, 1, key);
			expect(result).toMatchObject({ use_carrier_delivery_date: true, changed_by: admin, version: '2', replayed: false });
			expect(await option()).toMatchObject({ use_carrier_delivery_date: true, changed_by: admin, version: '2' });
			expect((await option()).changed_at).not.toBeNull();
			expect(await setOption(admin, true, 1, key)).toMatchObject({ version: '2', replayed: true });
			expect(await failure(() => setOption(admin, false, 2, key))).toMatchObject({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
			expect(await failure(() => setOption(admin, false, 1))).toMatchObject({ code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' });
			const member = (await seedReturnFlow(db())).f.actor;
			expect(await failure(() => setOption(member, false, 2))).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
		});

		test('FREQ-575-AC-04: 設定をオンにしても、返品の追跡は登録されていないので届いた日は自動で入らない', async () => {
			const admin = await insertAccountingAdmin(db());
			await setOption(admin, true, 1);
			const flow = await seedReturnFlow(db());
			await requestedDaysAgo(flow.returnId, 3);
			const r = await receive(flow, null);
			expect((await q('select public.get_return_carrier_arrival($1) as d', [flow.returnId])).rows[0].d).toBeNull();
			expect(await arrivalOn(r.receipt_id)).toBe(await day(0));
		});

		test('FREQ-575-AC-03: 届いた日の読み口は200件まで', async () => {
			const ids = Array.from({ length: 201 }, () => randomUUID());
			expect(await failure(() => q('select public.get_return_arrival_info($1::uuid[])', [ids]))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
			expect((await q('select public.get_return_arrival_info($1::uuid[]) as j', [ids.slice(0, 200)])).rows[0].j).toEqual([]);
		});
	});
});
