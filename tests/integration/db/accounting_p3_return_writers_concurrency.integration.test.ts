/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { seedReturnFlow } from './helpers/accounting-returns-fixtures';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { buildReceivePricing, ubReceive, type ReceiveInput } from './helpers/unit-binding-receive';

// 計画3 Task 4（S18）の並行の試験。2つの接続でコミットまで流す（使い捨ての手元の DB だけ）。
// 注文・受け取り・返品の事実をコミットして残すので、計画2の並行の試験と同じく ACCOUNTING_COMMIT_SUITE=1 で、2つの db reset の間に単独で流す。
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p3_return_writers_concurrency --runInBand; db reset
jest.setTimeout(120000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('FREQ-578-AC-07: S18 return facts under concurrency', () => {
	if (!COMMIT_SUITE) {
		test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
		return;
	}
	const clients: PgClient[] = [];
	const open = async () => { const c = await connectLocalDb(); clients.push(c); return c; };
	const returnIds: string[] = [];
	// 返品を作る道具は返品の設定（返送先・手数料の有効）をコミットで変えるので、前の値に戻す（後の試験が最初の値を見る）
	const SETTING_COLUMNS = 'return_address_name, return_address_postal_code, return_address_line, return_address_phone, restocking_fee_enabled';
	let settings: Record<string, unknown> | null = null;
	beforeAll(async () => {
		const c = await connectLocalDb();
		try { settings = (await c.query(`select ${SETTING_COLUMNS} from public.shop_return_settings where id=1`)).rows[0]; } finally { await c.end(); }
	});
	afterAll(async () => {
		if (!settings) return;
		const c = await connectLocalDb();
		try {
			await c.query(`update public.shop_return_settings set (${SETTING_COLUMNS}) = ($1, $2, $3, $4, $5) where id=1`,
				[settings.return_address_name, settings.return_address_postal_code, settings.return_address_line, settings.return_address_phone, settings.restocking_fee_enabled]);
		} finally { await c.end(); }
	});
	afterEach(async () => {
		for (const c of clients.splice(0)) { await c.query('rollback').catch(() => null); await c.end(); }
		// コミットした事実の行を消す（決定の無い届いた行が残ると、S15 の decided_on の NOT NULL の改ざんの試験が別の誤りで落ちる）
		const cleaner = await connectLocalDb();
		try {
			await cleaner.query('begin');
			await cleaner.query('alter table public.accounting_return_facts disable trigger accounting_return_facts_no_update_delete');
			await cleaner.query('delete from public.accounting_return_facts where return_id = any($1::uuid[])', [returnIds.splice(0)]);
			await cleaner.query('alter table public.accounting_return_facts enable always trigger accounting_return_facts_no_update_delete');
			await cleaner.query('commit');
		} finally { await cleaner.end(); }
	});

	test('FREQ-578-AC-07: 同じ受け取りを2つの接続から同時に送っても、受け取りと返品の事実は1回分だけ残り、片方は前の結果を返す', async () => {
		const setup = await open();
		await setup.query('begin');
		await setup.query('select pg_advisory_xact_lock(190521,1)');
		const flow = await seedReturnFlow(setup);
		returnIds.push(flow.returnId);
		const input: ReceiveInput = { returnId: flow.returnId, actorId: flow.f.actor, choice: 'now', key: randomUUID(),
			units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' }] };
		const plan = await buildReceivePricing(setup, input);
		await setup.query('commit');

		const a = await open();
		const b = await open();
		await a.query('begin');
		await b.query('begin');
		const results = await Promise.allSettled([
			ubReceive(a, input, plan).then(async (row) => { await a.query('commit'); return row; }),
			ubReceive(b, input, plan).then(async (row) => { await b.query('commit'); return row; }),
		]);
		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
		const rows = results.map((r) => (r as PromiseFulfilledResult<{ receipt_id: string; replayed: boolean }>).value);
		expect(rows[0].receipt_id).toBe(rows[1].receipt_id);
		expect(rows.map((r) => r.replayed).sort()).toEqual([false, true]);

		const check = await open();
		expect(Number((await check.query("select count(*) n from public.order_return_receipts where return_id=$1 and kind='receive'", [flow.returnId])).rows[0].n)).toBe(1);
		const facts = (await check.query('select kind, goods_amount, fee_amount, covers_amount, decided_amount from public.accounting_return_facts where return_id=$1 order by seq', [flow.returnId])).rows;
		expect(facts).toEqual([
			{ kind: 'arrival', goods_amount: 18750, fee_amount: 1875, covers_amount: 0, decided_amount: null },
			{ kind: 'decision', goods_amount: 0, fee_amount: 1875, covers_amount: 16875, decided_amount: 16875 },
		]);
	});

	test('FREQ-578-AC-07: 同じ返品の別々の受け取りを同時に送っても、事実の番号は返品の中で重ならない', async () => {
		const setup = await open();
		await setup.query('begin');
		await setup.query('select pg_advisory_xact_lock(190521,1)');
		const flow = await seedReturnFlow(setup, { snapshot: false, groups: [{ quantity: 1 }, { quantity: 1 }] });
		returnIds.push(flow.returnId);
		await setup.query('commit');
		const inputs: ReceiveInput[] = flow.lineIds.map((lineId) => ({ returnId: flow.returnId, actorId: flow.f.actor, choice: 'consult', key: randomUUID(),
			units: [{ return_line_id: lineId, disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] }));

		const a = await open();
		const b = await open();
		await a.query('begin');
		await b.query('begin');
		const results = await Promise.allSettled([
			ubReceive(a, inputs[0], null).then(() => a.query('commit')),
			ubReceive(b, inputs[1], null).then(() => b.query('commit')),
		]);
		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
		const check = await open();
		expect((await check.query('select seq, kind from public.accounting_return_facts where return_id=$1 order by seq', [flow.returnId])).rows)
			.toEqual([{ seq: 1, kind: 'arrival' }, { seq: 2, kind: 'arrival' }]);
	});
});
