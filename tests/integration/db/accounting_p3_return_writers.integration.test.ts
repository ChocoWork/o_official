/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { amount } from '../../unit/lib/discounts/fixtures';
import { buildOrder } from '../../unit/lib/orders/unit-pricing/fixtures';
import { seedFactSlip } from './helpers/accounting-orders-fixtures';
import {
	dropDiscountSnapshot, receiveReturn, restorePreS18Receive, returnFacts, returnPayable, seedReturnFlow, type ReturnFlow,
} from './helpers/accounting-returns-fixtures';
import { hDiscount, seedHDiscount, seedHMember, seedHOrderUnits, seedHUnitSlots, type HCatalog } from './helpers/group-h-fixtures';
import { hRefundFixture, hResult } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, shipFixtureOrder } from './helpers/order-fixtures';
import { createUbReturn, ubReceive, type ReceiveUnit } from './helpers/unit-binding-receive';

// 計画3 Task 4（S18）: 返品の受け取り・返金の関数が残す返品の事実（届いた日 arrival・決定 decision）。
// 未払金（2130 return_refund）の残りは、計上係（Task 7）の前なので、事実だけから同じ式で読む（returnPayable）。
jest.setTimeout(120000);

type Failure = { code?: string; message?: string; detail?: string };
const unit = (lineId: string, quantity = 1, refundChoice?: 'now' | 'consult', disposition = 'not_restocked'): ReceiveUnit =>
	({ return_line_id: lineId, disposition, quantity, ...(refundChoice ? { refund_choice: refundChoice } : {}) });

describeLocalDb('FREQ-578-AC-01: S18 return writers keep the return facts', (db) => {
	beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
	afterEach(async () => { await db().query('rollback'); });

	const q = (text: string, params?: unknown[]) => db().query(text, params);
	async function failure(run: () => Promise<unknown>): Promise<Failure> {
		await q('savepoint s18_expected');
		try { await run(); return {}; }
		catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
		finally { await q('rollback to savepoint s18_expected'); await q('release savepoint s18_expected'); }
	}
	const today = async () => (await q("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d as string;
	const facts = (returnId: string) => returnFacts(db(), returnId);
	const payable = (returnId: string) => returnPayable(db(), returnId);
	const eventOf = async (receiptId: string) => (await q('select * from public.order_unit_events where receipt_id=$1', [receiptId])).rows[0];
	const refundReturn = async (returnId: string, actor: string, amountValue: number | null = null, key = randomUUID()) =>
		(await q('select * from public.admin_refund_return($1,$2,$3,$4,0,null,false)', [returnId, actor, key, amountValue])).rows[0] as {
			refund_id: string | null; amount: number; status: string; replayed: boolean };
	const refundCount = async (orderId: string) => Number((await q('select count(*) n from public.order_refunds where order_id=$1', [orderId])).rows[0].n);
	const decide = (args: unknown[]) => q('select private.accounting_record_return_decision($1,$2,$3,$4,$5,$6,$7,$8)', args);
	const now = (flow: ReturnFlow, extra: Record<string, unknown> = {}) =>
		receiveReturn(db(), flow, { choice: 'now', units: [unit(flow.lineIds[0], 1, 'now')], ...extra });
	const consult = (flow: ReturnFlow, extra: Record<string, unknown> = {}) =>
		receiveReturn(db(), flow, { choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')], ...extra });

	describe('arrival', () => {
		test('FREQ-578-AC-01: 返品を受け取ると返品の事実に届いた時の額18,750円と手数料1,875円が残る（出来事の記録の返す額と手数料をそのまま写す）', async () => {
			const flow = await seedReturnFlow(db());
			const received = await now(flow);
			const event = await eventOf(received.receipt_id);
			expect(event).toMatchObject({ standard_refund: 16875, now_refund: 16875, consult_refund: 0, fee_amount: 1875 });
			const [arrival] = await facts(flow.returnId);
			expect(arrival).toMatchObject({ seq: 1, kind: 'arrival', receipt_id: received.receipt_id, refund_id: null,
				goods_amount: event.standard_refund + event.fee_amount, fee_amount: event.fee_amount, covers_amount: 0, decided_amount: null });
			expect(arrival).toMatchObject({ goods_amount: 18750, fee_amount: 1875 });
		});

		test('FREQ-576-AC-03: 返金を始める受け取りは、事実と、返金の額の決定（16,875円・差0・手数料欄に引いた手数料1,875円）が同じトランザクションで残る', async () => {
			const flow = await seedReturnFlow(db());
			const received = await now(flow);
			expect(received.refund_amount).toBe(16875);
			expect(await facts(flow.returnId)).toEqual([
				expect.objectContaining({ seq: 1, kind: 'arrival', goods_amount: 18750, fee_amount: 1875 }),
				expect.objectContaining({ seq: 2, kind: 'decision', receipt_id: received.receipt_id, refund_id: received.refund_id, goods_amount: 0,
					fee_amount: 1875, covers_amount: 16875, decided_amount: 16875, payable_delta: 0, decided_on: await today() }),
			]);
			expect(await payable(flow.returnId)).toBe(0);
		});

		test('FREQ-578-AC-01: 写しの無い注文の受け取りも、届いた時の額18,750円と手数料1,875円、返金の決定16,875円・差0が残る', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false });
			const received = await now(flow);
			expect(received.refund_amount).toBe(16875);
			expect(await facts(flow.returnId)).toEqual([
				expect.objectContaining({ kind: 'arrival', goods_amount: 18750, fee_amount: 1875 }),
				expect.objectContaining({ kind: 'decision', refund_id: received.refund_id, receipt_id: received.receipt_id, fee_amount: 1875,
					covers_amount: 16875, decided_amount: 16875, payable_delta: 0 }),
			]);
		});

		test('FREQ-578-AC-01: 受け取りで手数料を免除すると、写しのある注文でも無い注文でも届いた時の手数料と決定の手数料欄は0', async () => {
			for (const snapshot of [true, false]) {
				const flow = await seedReturnFlow(db(), { snapshot });
				const received = await now(flow, { restockingFeeWaived: true });
				expect(received.refund_amount).toBe(18750);
				expect(await facts(flow.returnId)).toEqual([
					expect.objectContaining({ kind: 'arrival', goods_amount: 18750, fee_amount: 0 }),
					expect.objectContaining({ kind: 'decision', fee_amount: 0, covers_amount: 18750, decided_amount: 18750, payable_delta: 0 }),
				]);
			}
		});

		test('FREQ-578-AC-10: お店の側の事情の受け取り（不良で交換できず返金）は、手数料欄が0', async () => {
			const flow = await seedReturnFlow(db(), { groups: [{ quantity: 1, reason: 'defective' }] });
			const received = await now(flow);
			expect(await facts(flow.returnId)).toEqual([
				expect.objectContaining({ kind: 'arrival', goods_amount: received.refund_amount, fee_amount: 0 }),
				expect.objectContaining({ kind: 'decision', fee_amount: 0, payable_delta: 0 }),
			]);
		});

		test('FREQ-578-AC-10: 交換の設計の例7（セットのパンツ 8,500円をお客様のご都合で返す）の受け取りは、届いた時の額が返す額の5,500円で、残る着の +3,000円の直しは返品の事実にも直しの表にも入らない', async () => {
			const jacket = await createCatalogFixture(db());
			const pants = await createCatalogFixture(db());
			const userId = await seedHMember(db());
			const lines = [{ catalog: jacket, unitPrice: 20000, quantity: 2 }, { catalog: pants, unitPrice: 10000, quantity: 1 }];
			const definitions = [amount('set', 4500, { kind: 'set', targetMode: 'include', itemIds: [jacket.itemId, pants.itemId] })];
			const lineSpecs = (ids: string[]) => lines.map((l, i) => ({ orderItemId: ids[i], itemId: l.catalog.itemId, unitPrice: l.unitPrice, quantity: l.quantity }));
			const priced = buildOrder({ orderId: 'pre', lines: lineSpecs(lines.map((_, i) => `oi-${i}`)), definitions });
			const discountId = await seedHDiscount(db(), hDiscount());
			const seeded = await seedHOrderUnits(db(), { legacy: false, buyerUserId: userId, lines: lines.map((l, i) => {
				const units = priced.slots.filter((s) => s.orderItemId === `oi-${i}`).map((s) => s.paidAmount);
				const allocated = l.unitPrice * l.quantity - units.reduce((a, b) => a + b, 0);
				return { itemPrice: l.unitPrice, quantity: l.quantity, catalog: l.catalog as HCatalog, unitAmounts: units,
					discounts: allocated > 0 ? [{ discountId, amount: allocated }] : [] };
			}) });
			const built = buildOrder({ orderId: seeded.orderId, lines: lineSpecs(seeded.orderItemIds), definitions });
			const snapshotFacts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([k]) => k !== 'phase'));
			snapshotFacts.buyer = { kind: 'member', userId };
			await seedHUnitSlots(db(), { orderId: seeded.orderId, snapshot: { engineVersion: 1, definitions: built.snapshot.definitions,
				codes: built.snapshot.codes, facts: snapshotFacts, lines: built.snapshot.lines } });
			await q('update public.orders set paid_amount=total_amount, payment_intent_id=$2 where id=$1', [seeded.orderId, `pi_s18_${randomUUID().replaceAll('-', '')}`]);
			const fulfillment = await shipFixtureOrder(db(), { orderId: seeded.orderId, actorId: userId, trackingNumber: 'S18-EX7',
				lines: seeded.orderItemIds.map((id, i) => ({ order_item_id: id, quantity: lines[i].quantity })) });
			for (const [i, id] of seeded.orderItemIds.entries()) await seedFactSlip(db(), { orderItemId: id, quantity: lines[i].quantity });
			const ret = await createUbReturn(db(), { orderId: seeded.orderId, itemId: seeded.orderItemIds[1], actor: userId, fulfillment, catalog: pants },
				[{ quantity: 1 }]);
			const corrections = Number((await q('select count(*) n from public.order_return_arrival_corrections')).rows[0].n);
			const received = await ubReceive(db(), { returnId: ret.returnId, actorId: userId, choice: 'consult', units: [unit(ret.lineIds[0], 1, 'consult')] });
			const event = await eventOf(received.receipt_id);
			expect(event).toMatchObject({ standard_refund: 5500, fee_amount: 0 });
			expect(await facts(ret.returnId)).toEqual([expect.objectContaining({ kind: 'arrival', goods_amount: 5500, fee_amount: 0 })]);
			expect(Number((await q('select count(*) n from public.order_return_arrival_corrections')).rows[0].n)).toBe(corrections);
			expect(Number((await q('select count(*) n from public.accounting_return_facts where order_id=$1', [seeded.orderId])).rows[0].n)).toBe(1);
		});

		test('FREQ-578-AC-10: 前の注文から差し引いた分がある受け取り（交換の設計の例10。1回目の注文で 17,000円を返す）は、届いた時の額が差し引いた後の17,000円', async () => {
			const catalog = await createCatalogFixture(db(), { stock: 4 });
			const userId = await seedHMember(db());
			const definition = amount('repeatprev', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [catalog.itemId], repeatPrevious: true });
			const discountId = await seedHDiscount(db(), hDiscount());
			const make = async (createdAt: string, prior: boolean) => {
				const priorUnits = prior ? { [String(catalog.itemId)]: 1 } : {};
				const priced = buildOrder({ orderId: 'pre', lines: [{ orderItemId: 'oi-0', itemId: catalog.itemId, unitPrice: 20000, quantity: 1 }], definitions: [definition], priorUnitsByItem: priorUnits });
				const paid = priced.slots[0].paidAmount;
				const seeded = await seedHOrderUnits(db(), { legacy: false, buyerUserId: userId, createdAt, lines: [{ itemPrice: 20000, quantity: 1, catalog: catalog as HCatalog,
					unitAmounts: [paid], discounts: 20000 - paid > 0 ? [{ discountId, amount: 20000 - paid }] : [] }] });
				const built = buildOrder({ orderId: seeded.orderId, lines: [{ orderItemId: seeded.orderItemIds[0], itemId: catalog.itemId, unitPrice: 20000, quantity: 1 }],
					definitions: [definition], priorUnitsByItem: priorUnits });
				const snapshotFacts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([k]) => k !== 'phase'));
				snapshotFacts.buyer = { kind: 'member', userId };
				await seedHUnitSlots(db(), { orderId: seeded.orderId, snapshot: { engineVersion: 1, definitions: built.snapshot.definitions, codes: built.snapshot.codes, facts: snapshotFacts, lines: built.snapshot.lines } });
				await q('update public.orders set paid_amount=total_amount, payment_intent_id=$2 where id=$1', [seeded.orderId, `pi_s18_${randomUUID().replaceAll('-', '')}`]);
				const itemId = seeded.orderItemIds[0];
				const fulfillment = await shipFixtureOrder(db(), { orderId: seeded.orderId, actorId: userId, trackingNumber: prior ? 'S18-2' : 'S18-1', lines: [{ order_item_id: itemId, quantity: 1 }] });
				await seedFactSlip(db(), { orderItemId: itemId, quantity: 1 });
				return { orderId: seeded.orderId, itemId, actor: userId, catalog, fulfillment, paid };
			};
			const first = await make('2026-11-01T00:00:00Z', false);
			await make('2026-11-02T00:00:00Z', true);
			const ret = await createUbReturn(db(), first, [{ quantity: 1 }]);
			const received = await ubReceive(db(), { returnId: ret.returnId, actorId: userId, choice: 'now', units: [unit(ret.lineIds[0])] });
			expect(received.refund_amount).toBe(17000);
			expect(await facts(ret.returnId)).toEqual([
				expect.objectContaining({ kind: 'arrival', goods_amount: 17000, fee_amount: 0 }),
				expect.objectContaining({ kind: 'decision', covers_amount: 17000, decided_amount: 17000, payable_delta: 0 }),
			]);
		});

		test('FREQ-578-AC-04: 送り返すだけの受け取りと交換だけの受け取りは事実を残さない', async () => {
			const flow = await seedReturnFlow(db());
			await receiveReturn(db(), flow, { choice: 'none', notify: true, units: [unit(flow.lineIds[0], 1, undefined, 'sent_back')], sentBackMessage: '送り返す' });
			expect(await facts(flow.returnId)).toEqual([]);
			const exchange = await seedReturnFlow(db(), { groups: [{ quantity: 1, exchange: true }] });
			await receiveReturn(db(), exchange, { choice: 'none', units: [unit(exchange.lineIds[0])] });
			expect(await facts(exchange.returnId)).toEqual([]);
		});

		test('FREQ-578-AC-07: 同じ受け取りの再送で事実は増えない', async () => {
			const flow = await seedReturnFlow(db());
			const key = randomUUID();
			const first = await now(flow, { key });
			const again = await now(flow, { key });
			expect(again).toMatchObject({ receipt_id: first.receipt_id, replayed: true });
			expect(await facts(flow.returnId)).toHaveLength(2);
		});
	});

	describe('decisions', () => {
		test('FREQ-578-AC-02: 相談で受け取り、後で14,000円と決めて返金を始めると、決定の事実の差が−2,875円になる', async () => {
			const flow = await seedReturnFlow(db());
			await consult(flow);
			expect(await facts(flow.returnId)).toEqual([expect.objectContaining({ kind: 'arrival', goods_amount: 18750, fee_amount: 1875 })]);
			const refund = await refundReturn(flow.returnId, flow.f.actor, 14000);
			const decision = (await facts(flow.returnId))[1];
			expect(decision).toMatchObject({ kind: 'decision', refund_id: refund.refund_id, receipt_id: null, covers_amount: 16875,
				decided_amount: 14000, payable_delta: -2875, decided_on: await today() });
			expect(await payable(flow.returnId)).toBe(0);
		});

		test('FREQ-578-AC-02: 受け取りで規約と違う額（15,000円）を入れて返金を始めると、同じ日に差−1,875円の事実が残る', async () => {
			const flow = await seedReturnFlow(db());
			const received = await now(flow, { amount: 15000 });
			expect(received.refund_amount).toBe(15000);
			expect((await facts(flow.returnId))[1]).toMatchObject({ kind: 'decision', covers_amount: 16875, decided_amount: 15000,
				payable_delta: -1875, fee_amount: 1875, decided_on: await today() });
		});

		test.each([['引かれる前の失敗', ['failed']], ['引かれた後の失敗', ['pending', 'failed']]] as const)(
			'FREQ-578-AC-02: 返品の返金が失敗してやり直した時、前の決定の分を除いた未払金の残りに対する差で決定が立ち、未払金が二重にならない（%s）', async (_label, steps) => {
				for (const snapshot of [true, false]) {
					const flow = await seedReturnFlow(db(), { snapshot });
					const received = await now(flow);
					for (const step of steps) await hResult(db(), received.refund_id!, step);
					expect(await payable(flow.returnId)).toBe(16875);
					const retry = await refundReturn(flow.returnId, flow.f.actor);
					expect(retry.amount).toBe(16875);
					const decisions = (await facts(flow.returnId)).filter((f) => f.kind === 'decision');
					expect(decisions).toHaveLength(2);
					expect(decisions[1]).toMatchObject({ refund_id: retry.refund_id, covers_amount: 16875, decided_amount: 16875, payable_delta: 0 });
					await hResult(db(), retry.refund_id!, 'succeeded');
					expect(await payable(flow.returnId)).toBe(0);
				}
			});

		test('FREQ-578-AC-08: admin_refund_return に額0を渡して返金しないで終えると、受け取りの行に結び付いた額0の決定の事実（未払金の欄16,875円・手数料欄1,875円・差−16,875円）が同じトランザクションで残り、返金の行は増えない', async () => {
			const flow = await seedReturnFlow(db());
			await consult(flow);
			const before = await refundCount(flow.f.orderId);
			const result = await refundReturn(flow.returnId, flow.f.actor, 0);
			expect(result).toMatchObject({ refund_id: null, amount: 0, status: 'waived' });
			const waive = (await q("select id from public.order_return_receipts where return_id=$1 and kind='waive_refund'", [flow.returnId])).rows[0].id;
			expect((await facts(flow.returnId))[1]).toMatchObject({ kind: 'decision', refund_id: null, receipt_id: waive, goods_amount: 0,
				covers_amount: 16875, fee_amount: 1875, decided_amount: 0, payable_delta: -16875 });
			expect(await refundCount(flow.f.orderId)).toBe(before);
			expect(await payable(flow.returnId)).toBe(0);
		});

		test('FREQ-578-AC-08: 受け取りを now にして返金額0で受け取ると、同じ形の決定の事実が残り、未払金の欄はその受け取りの G今 − F今、手数料欄はその受け取りの F今 になる', async () => {
			const flow = await seedReturnFlow(db());
			const received = await now(flow, { amount: 0 });
			expect(received).toMatchObject({ refund_id: null, refund_status: 'waived' });
			expect(await facts(flow.returnId)).toEqual([
				expect.objectContaining({ kind: 'arrival', goods_amount: 18750, fee_amount: 1875 }),
				expect.objectContaining({ kind: 'decision', refund_id: null, receipt_id: received.receipt_id, covers_amount: 16875, fee_amount: 1875,
					decided_amount: 0, payable_delta: -16875 }),
			]);
			expect(await payable(flow.returnId)).toBe(0);
		});

		test('FREQ-578-AC-02: 1着ごとの額が 1,000・1,000・999 のシャツ3着を同じ返品行で今すぐ1着・相談2着にして受け取ると、決定の事実は受け取りの出来事の記録の今すぐの分の額・手数料のまま（明細や着の記録から読み直さない）で、相談の2着の見込みが未払金に残る', async () => {
			const flow = await seedReturnFlow(db(), { quantity: 3, unitDiscount: 3000, groups: [{ quantity: 3 }] });
			const received = await receiveReturn(db(), flow, { choice: 'mixed', units: [unit(flow.lineIds[0], 1, 'now'), unit(flow.lineIds[0], 2, 'consult')] });
			const event = await eventOf(received.receipt_id);
			// 相談の行があるので F今 は0（未確認事項 #23）。G今 は出来事の now_refund
			expect(await facts(flow.returnId)).toEqual([
				expect.objectContaining({ kind: 'arrival', goods_amount: event.standard_refund + event.fee_amount, fee_amount: event.fee_amount }),
				expect.objectContaining({ kind: 'decision', receipt_id: received.receipt_id, refund_id: received.refund_id, fee_amount: 0,
					covers_amount: event.now_refund, decided_amount: received.refund_amount, payable_delta: received.refund_amount! - event.now_refund }),
			]);
			expect(await payable(flow.returnId)).toBe(event.consult_refund);
		});

		test('FREQ-578-AC-08: 受け取りの道の決定に今すぐの分の2つが無い時、admin_refund_return の道に今すぐの分の2つを渡した時、返金を始める道で _fee_amount と _fee_now が違う時は ACCOUNTING_ARGUMENT_INVALID', async () => {
			const flow = await seedReturnFlow(db());
			await consult(flow);
			const receipt = (await q("select id from public.order_return_receipts where return_id=$1 and kind='receive'", [flow.returnId])).rows[0].id;
			const refund = await refundReturn(flow.returnId, flow.f.actor, 1000);
			const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
			// 受け取りの道（0円）で今すぐの分が無い
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, receipt, 0, null, null]))).toMatchObject(invalid);
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, receipt, 0, 100, null]))).toMatchObject(invalid);
			// F今 が G今 を超える・負
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, receipt, 0, 100, 200]))).toMatchObject(invalid);
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, receipt, 0, -1, 0]))).toMatchObject(invalid);
			// admin_refund_return の道（受け取り無し）に今すぐの分を渡す
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, refund.refund_id, 1000, null, 0, 1000, 0]))).toMatchObject(invalid);
			// 返金を始める受け取りの道で _fee_amount と _fee_now が違う
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, refund.refund_id, 1000, receipt, 100, 1000, 0]))).toMatchObject(invalid);
		});

		test('FREQ-578-AC-08: 0円で終える決定に0でない手数料を渡すと ACCOUNTING_ARGUMENT_INVALID、受け取りの行の kind が receive・waive_refund でなくても ACCOUNTING_ARGUMENT_INVALID', async () => {
			const flow = await seedReturnFlow(db());
			await consult(flow);
			const receipt = (await q("select id from public.order_return_receipts where return_id=$1 and kind='receive'", [flow.returnId])).rows[0].id;
			const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, receipt, 1, 100, 0]))).toMatchObject(invalid);
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 1, receipt, 0, 100, 0]))).toMatchObject(invalid);
			// 検品（inspect）の受け取りの行（同じ返品の行を直接入れる）
			const inspect = (await q(`insert into public.order_return_receipts (return_id, request_key, request_fingerprint, kind, notify_customer, actor_id, actor_can_refund)
        values ($1, $2, 's18-inspect', 'inspect', false, $3, true) returning id`, [flow.returnId, randomUUID(), flow.f.actor])).rows[0].id;
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, inspect, 0, null, null]))).toMatchObject(invalid);
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, null, 0, inspect, 0, 100, 0]))).toMatchObject(invalid);
		});

		test('FREQ-578-AC-02: 返金を始める決定に kind が receive でない受け取りや、別の返品の受け取りを渡すと ACCOUNTING_ARGUMENT_INVALID', async () => {
			const flow = await seedReturnFlow(db());
			await consult(flow);
			const other = await seedReturnFlow(db());
			const otherReceived = await now(other);
			const refund = await refundReturn(flow.returnId, flow.f.actor, 1000);
			const waive = await seedReturnFlow(db());
			await consult(waive);
			await refundReturn(waive.returnId, waive.f.actor, 0);
			const waiveReceipt = (await q("select id from public.order_return_receipts where return_id=$1 and kind='waive_refund'", [waive.returnId])).rows[0].id;
			const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
			// 別の返品の受け取り
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, refund.refund_id, 1000, otherReceived.receipt_id, 0, 1000, 0]))).toMatchObject(invalid);
			// 別の返品の返金
			expect(await failure(() => decide([flow.returnId, flow.f.orderId, otherReceived.refund_id, 1000, null, 0, null, null]))).toMatchObject(invalid);
			// kind が waive_refund の受け取りと返金
			expect(await failure(() => decide([waive.returnId, waive.f.orderId, refund.refund_id, 1000, waiveReceipt, 0, null, null]))).toMatchObject(invalid);
		});

		test('FREQ-578-AC-08: 1件目の受け取りを返金した後に2件目を admin_refund_return(0) で終えると、決定の手数料欄は届いた日の手数料の合計から1件目の返金を始めた決定の手数料を除いた額になる', async () => {
			const flow = await seedReturnFlow(db(), { groups: [{ quantity: 2 }] });
			const first = await receiveReturn(db(), flow, { choice: 'now', units: [unit(flow.lineIds[0], 1, 'now')] });
			await hResult(db(), first.refund_id!, 'succeeded');
			await receiveReturn(db(), flow, { choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')] });
			const arrivals = (await facts(flow.returnId)).filter((f) => f.kind === 'arrival');
			expect(arrivals).toHaveLength(2);
			await refundReturn(flow.returnId, flow.f.actor, 0);
			const all = await facts(flow.returnId);
			const firstDecision = all.find((f) => f.refund_id === first.refund_id)!;
			const last = all[all.length - 1];
			expect(last).toMatchObject({ kind: 'decision', refund_id: null, decided_amount: 0,
				fee_amount: arrivals[0].fee_amount + arrivals[1].fee_amount - firstDecision.fee_amount,
				covers_amount: arrivals[1].goods_amount - arrivals[1].fee_amount });
			expect(last.fee_amount).toBe(arrivals[1].fee_amount);
			expect(await payable(flow.returnId)).toBe(0);
		});

		test('FREQ-578-AC-02: 返金の決定の「カバーする額」は、前の決定が済ませた分を引いた残りになる（2回に分けた受け取り）', async () => {
			for (const snapshot of [true, false]) {
				const flow = await seedReturnFlow(db(), { snapshot, groups: [{ quantity: 2 }] });
				await receiveReturn(db(), flow, { choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')] });
				const second = await receiveReturn(db(), flow, { choice: 'now', units: [unit(flow.lineIds[0], 1, 'now')] });
				const arrivals = (await facts(flow.returnId)).filter((f) => f.kind === 'arrival');
				const decision = (await facts(flow.returnId)).find((f) => f.kind === 'decision')!;
				// 受け取り2の分だけ（返品全体の残りではない）
				expect(decision).toMatchObject({ receipt_id: second.receipt_id, covers_amount: arrivals[1].goods_amount - arrivals[1].fee_amount,
					decided_amount: second.refund_amount, payable_delta: 0 });
				expect(await payable(flow.returnId)).toBe(arrivals[0].goods_amount - arrivals[0].fee_amount);
			}
		});

		test('FREQ-578-AC-08: 品の額0の受け取りを now で受け取ると自動で返金額0になり、決定の事実は未払金の欄0・手数料欄0で残り、同じ返品の相談で返金待ちの受け取りの未払金は残る', async () => {
			// 2着目を値引きで0円にした注文（20,000円・0円）。今すぐの1着は安い0円の着になり、返金額0で自動に終わる。同じ受け取りの相談の着の未払金は残る
			const flow = await seedReturnFlow(db(), { unitDiscount: 20000, groups: [{ quantity: 2 }] });
			const received = await receiveReturn(db(), flow, { choice: 'mixed', units: [unit(flow.lineIds[0], 1, 'now'), unit(flow.lineIds[0], 1, 'consult')] });
			const event = await eventOf(received.receipt_id);
			expect(event).toMatchObject({ now_refund: 0 });
			expect(event.consult_refund).toBeGreaterThan(0);
			expect(received).toMatchObject({ refund_id: null, refund_status: 'waived' });
			expect(await facts(flow.returnId)).toEqual([
				expect.objectContaining({ kind: 'arrival', goods_amount: event.standard_refund + event.fee_amount, fee_amount: event.fee_amount }),
				expect.objectContaining({ kind: 'decision', receipt_id: received.receipt_id, refund_id: null, covers_amount: 0, fee_amount: 0,
					decided_amount: 0, payable_delta: 0 }),
			]);
			expect(await payable(flow.returnId)).toBe(event.consult_refund);
		});

		test('FREQ-578-AC-08: error の返金がある返品を admin_refund_return(0) で終えると、0円の決定の事実と、その error の返金を始めた決定の事実が両方残る', async () => {
			// 写しのある注文は X4 がこの0円の閉じ方を断る（ub_refund_lines）ので、写しの無い注文で作る（裁定 P3-D3）
			const flow = await seedReturnFlow(db(), { snapshot: false });
			const received = await now(flow);
			await q("select * from private.mark_order_refund_error($1,'timeout',false)", [received.refund_id]);
			await refundReturn(flow.returnId, flow.f.actor, 0);
			const decisions = (await facts(flow.returnId)).filter((f) => f.kind === 'decision');
			expect(decisions).toEqual([
				expect.objectContaining({ refund_id: received.refund_id, decided_amount: 16875, covers_amount: 16875 }),
				expect.objectContaining({ refund_id: null, decided_amount: 0 }),
			]);
		});

		test('FREQ-578-AC-02: 受け取り1を相談、受け取り2を now で返金すると、返金を始めた決定の事実は受け取りの欄に受け取り2・カバーする額はその受け取りの G今 − F今・差0になる（返品全体の残りではない）', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false, groups: [{ quantity: 1 }, { quantity: 1 }] });
			await receiveReturn(db(), flow, { choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')] });
			const second = await receiveReturn(db(), flow, { choice: 'now', units: [unit(flow.lineIds[1], 1, 'now')] });
			const [a1, a2, decision] = await facts(flow.returnId);
			expect(decision).toMatchObject({ kind: 'decision', receipt_id: second.receipt_id, covers_amount: a2.goods_amount - a2.fee_amount,
				fee_amount: a2.fee_amount, decided_amount: second.refund_amount, payable_delta: 0 });
			expect(await payable(flow.returnId)).toBe(a1.goods_amount - a1.fee_amount);
		});

		test('FREQ-578-AC-02: 1回の受け取りで今すぐと相談が混ざる（mixed）と、届いた日の事実は1行で、返金の決定は受け取りの欄にその受け取り・カバーする額は G今 − F今・手数料欄 F今・差0になる。届いた日の手数料は受け取りの記録（今すぐと相談の和）のまま', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false, groups: [{ quantity: 1 }, { quantity: 1 }] });
			const received = await receiveReturn(db(), flow, { choice: 'mixed', units: [unit(flow.lineIds[0], 1, 'now'), unit(flow.lineIds[1], 1, 'consult')] });
			const all = await facts(flow.returnId);
			expect(all.filter((f) => f.kind === 'arrival')).toHaveLength(1);
			const [arrival, decision] = all;
			// 2着（20,000円・18,750円）の 10% の手数料の和
			expect(arrival).toMatchObject({ goods_amount: 38750, fee_amount: 3875 });
			const feeNow = decision.fee_amount;
			expect(decision).toMatchObject({ kind: 'decision', receipt_id: received.receipt_id, covers_amount: received.refund_amount, payable_delta: 0 });
			expect(feeNow * 10).toBe(received.refund_amount! + feeNow);
			expect(await payable(flow.returnId)).toBe(38750 - 3875 - received.refund_amount!);
		});

		test('FREQ-578-AC-08: mixed の受け取りを今すぐの返金額0で受け取ると、0円の決定は今すぐの分だけで、相談の分の未払金と後で引く手数料は残る', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false, groups: [{ quantity: 1 }, { quantity: 1 }] });
			const received = await receiveReturn(db(), flow, { choice: 'mixed', amount: 0, units: [unit(flow.lineIds[0], 1, 'now'), unit(flow.lineIds[1], 1, 'consult')] });
			expect(received).toMatchObject({ refund_id: null, refund_status: 'waived' });
			const [arrival, decision] = await facts(flow.returnId);
			const goodsNow = decision.covers_amount! + decision.fee_amount;
			expect(decision).toMatchObject({ refund_id: null, decided_amount: 0, payable_delta: -decision.covers_amount! });
			expect(decision.fee_amount * 10).toBe(goodsNow);
			const feeConsult = arrival.fee_amount - decision.fee_amount;
			expect(await payable(flow.returnId)).toBe(arrival.goods_amount - goodsNow - feeConsult);
			expect(Number((await q('select fee_pending_deduction from public.order_returns where id=$1', [flow.returnId])).rows[0].fee_pending_deduction)).toBe(feeConsult);
		});

		test('FREQ-578-AC-02: 品ごとの選びを送らない旧の呼び出し（受け取り全体が now）は親の選びで今すぐの分が決まり、mixed で選びの無い返金の品は RETURN_ARGUMENT_INVALID で断り、事実は残らない', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false });
			const received = await receiveReturn(db(), flow, { choice: 'now', units: [unit(flow.lineIds[0])] });
			expect((await facts(flow.returnId))[1]).toMatchObject({ kind: 'decision', receipt_id: received.receipt_id, covers_amount: 16875,
				fee_amount: 1875, decided_amount: 16875, payable_delta: 0 });
			const mixed = await seedReturnFlow(db(), { snapshot: false, groups: [{ quantity: 1 }, { quantity: 1 }] });
			expect(await failure(() => receiveReturn(db(), mixed, { choice: 'mixed', units: [unit(mixed.lineIds[0]), unit(mixed.lineIds[1], 1, 'consult')] })))
				.toMatchObject({ code: '22023', message: 'RETURN_ARGUMENT_INVALID' });
			expect(await facts(mixed.returnId)).toEqual([]);
		});
	});

	describe('snapshot orders: covers of a refund admin_refund_return starts', () => {
		/** 2着の返品を今すぐ1着・相談1着で受け取る（今すぐの返金は 17,000円、相談の分は 20,000円。手数料の割合0） */
		async function mixedReceive(o: { amount?: number } = {}) {
			const f = await hRefundFixture(db(), true);
			const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
			const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'mixed', amount: o.amount,
				units: [unit(ret.lineIds[0], 1, 'now'), unit(ret.lineIds[1], 1, 'consult')] });
			const event = await eventOf(received.receipt_id);
			return { f, ret, received, event };
		}
		const linksOf = async (refundId: string) => (await q('select event_id, part from public.order_unit_event_refunds where refund_id=$1 order by part', [refundId])).rows;

		test('FREQ-578-AC-02: 写しのある注文の相談の返金の決定のカバーする額は、admin_refund_return が足した v_goods と同じ額で、返品の決定の差は0', async () => {
			const { f, ret, received, event } = await mixedReceive();
			await hResult(db(), received.refund_id, 'succeeded');
			const refund = await refundReturn(ret.returnId, f.actor);
			expect(refund.amount).toBe(event.consult_refund);
			expect((await facts(ret.returnId)).at(-1)).toMatchObject({ refund_id: refund.refund_id, covers_amount: event.consult_refund,
				decided_amount: event.consult_refund, payable_delta: 0 });
			await hResult(db(), refund.refund_id!, 'succeeded');
			expect(await payable(ret.returnId)).toBe(0);
		});

		test('FREQ-578-AC-02: 写しのある注文で、受け取りの今すぐの返金が pending の間に相談の分を admin_refund_return で返し始め、その後に今すぐの返金が失敗すると、相談の決定のカバーする額は相談の出来事の consult_refund の合計で、失敗した今すぐの分の 2130（return_refund）の借りは残る', async () => {
			const { f, ret, received, event } = await mixedReceive();
			await hResult(db(), received.refund_id, 'pending');
			const refund = await refundReturn(ret.returnId, f.actor);
			expect(await linksOf(refund.refund_id!)).toEqual([{ event_id: event.id, part: 'consult' }]);
			expect((await facts(ret.returnId)).at(-1)).toMatchObject({ refund_id: refund.refund_id, covers_amount: event.consult_refund, payable_delta: 0 });
			await hResult(db(), received.refund_id, 'failed');
			await hResult(db(), refund.refund_id!, 'succeeded');
			expect(await payable(ret.returnId)).toBe(event.now_refund);
		});

		test('FREQ-578-AC-02: 写しのある注文で、受け取り（今すぐ17,000・相談20,000）の今すぐの返金を規約と違う15,000円で始めて（差 d1 = −2,000）引かれる前に失敗させ、admin_refund_return を既定の37,000円で始めると、結びは同じ出来事の now と consult の2行、返金の事実は1行（P = 0・Q = 37,000）、決定の覆う額は35,000円・差は +2,000円で、返金が成功すると 2130（return_refund）は0', async () => {
			const { f, ret, received, event } = await mixedReceive({ amount: 15000 });
			expect(event).toMatchObject({ now_refund: 17000, consult_refund: 20000 });
			expect((await facts(ret.returnId))[1]).toMatchObject({ refund_id: received.refund_id, covers_amount: 17000, decided_amount: 15000, payable_delta: -2000 });
			await hResult(db(), received.refund_id, 'failed');
			const r1 = await refundReturn(ret.returnId, f.actor);
			expect(r1.amount).toBe(37000);
			expect(await linksOf(r1.refund_id!)).toEqual([{ event_id: event.id, part: 'consult' }, { event_id: event.id, part: 'now' }]);
			expect((await q('select pre_shipment_amount, post_shipment_amount from public.accounting_refund_facts where refund_id=$1', [r1.refund_id])).rows)
				.toEqual([{ pre_shipment_amount: 0, post_shipment_amount: 37000 }]);
			const decisions = (await facts(ret.returnId)).filter((x) => x.refund_id === r1.refund_id);
			expect(decisions).toEqual([expect.objectContaining({ covers_amount: 35000, decided_amount: 37000, payable_delta: 2000 })]);
			await hResult(db(), r1.refund_id!, 'succeeded');
			expect(await payable(ret.returnId)).toBe(0);
		});

		test('FREQ-578-AC-02: 前の試験の続きで、admin_refund_return の返金 R2 を手で変えた額36,000円（now と consult の2行。差 d2 = +1,000）で始めて失敗させ、R3 を既定の37,000円で始めると、R3 の覆う額は 17,000 ＋ 20,000 − 2,000 ＋ 1,000 ＝ 36,000円（d2 は2行でも1回だけ）、差は +1,000円で、R3 が成功すると 2130（return_refund）は0', async () => {
			const { f, ret, received, event } = await mixedReceive({ amount: 15000 });
			await hResult(db(), received.refund_id, 'failed');
			const r2 = await refundReturn(ret.returnId, f.actor, 36000);
			expect(await linksOf(r2.refund_id!)).toEqual([{ event_id: event.id, part: 'consult' }, { event_id: event.id, part: 'now' }]);
			expect((await facts(ret.returnId)).filter((x) => x.refund_id === r2.refund_id)).toEqual([
				expect.objectContaining({ covers_amount: 35000, decided_amount: 36000, payable_delta: 1000 })]);
			await hResult(db(), r2.refund_id!, 'failed');
			const r3 = await refundReturn(ret.returnId, f.actor);
			expect(r3.amount).toBe(37000);
			expect((await facts(ret.returnId)).filter((x) => x.refund_id === r3.refund_id)).toEqual([
				expect.objectContaining({ covers_amount: 36000, decided_amount: 37000, payable_delta: 1000 })]);
			await hResult(db(), r3.refund_id!, 'succeeded');
			expect(await payable(ret.returnId)).toBe(0);
		});

		test('FREQ-578-AC-02: 写しのある注文で、額を変えた相談の返金が失敗し、見込みの額でやり直して成功すると、2130（return_refund）は0', async () => {
			const { f, ret, received, event } = await mixedReceive();
			await hResult(db(), received.refund_id, 'succeeded');
			const changed = await refundReturn(ret.returnId, f.actor, 14000);
			expect((await facts(ret.returnId)).at(-1)).toMatchObject({ covers_amount: event.consult_refund, decided_amount: 14000,
				payable_delta: 14000 - event.consult_refund });
			await hResult(db(), changed.refund_id!, 'failed');
			const retry = await refundReturn(ret.returnId, f.actor);
			expect(retry.amount).toBe(event.consult_refund);
			expect((await facts(ret.returnId)).at(-1)).toMatchObject({ covers_amount: 14000, decided_amount: event.consult_refund,
				payable_delta: event.consult_refund - 14000 });
			await hResult(db(), retry.refund_id!, 'succeeded');
			expect(await payable(ret.returnId)).toBe(0);
		});
	});

	describe('the rebuilt receive keeps the waiver (FREQ-576-AC-06)', () => {
		const fingerprint = async (key: string) => (await q('select request_fingerprint from public.order_return_receipts where request_key=$1', [key])).rows[0].request_fingerprint as string;

		test('FREQ-576-AC-06: 作り直した受け取りの関数でも、手数料の免除の NULL は RETURN_ARGUMENT_INVALID、返金の権限の無い人の免除は RETURN_FORBIDDEN、免除の受け取りの行は restocking_fee_waived が真で、免除と _arrived_on の有無の4通りで再送の指紋が分かれ、どちらも渡さない再送は作り直す前と同じ指紋になる', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false });
			const sig = 'uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb,boolean,date';
			const units = JSON.stringify([unit(flow.lineIds[0], 1, 'now')]);
			expect(await failure(() => q(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,'now',null,0,null,false,null,null,null,null,null,null)`,
				[flow.returnId, flow.f.actor, randomUUID(), units]))).toMatchObject({ code: '22023', message: 'RETURN_ARGUMENT_INVALID' });
			expect(await failure(() => receiveReturn(db(), flow, { choice: 'consult', can: false, restockingFeeWaived: true, units: [unit(flow.lineIds[0], 1, 'consult')] })))
				.toMatchObject({ message: 'RETURN_FORBIDDEN' });
			expect((await q(`select to_regprocedure('public.admin_receive_return(${sig})') is not null as ok`)).rows[0].ok).toBe(true);
			// 4通りの指紋（同じ返品・同じ入力で、免除と届いた日だけを変える。毎回 savepoint で戻す）
			const day = (await q("select (((now() at time zone 'Asia/Tokyo')::date))::text d")).rows[0].d as string;
			const prints: string[] = [];
			const key = randomUUID();
			for (const [waived, arrivedOn] of [[false, null], [true, null], [false, day], [true, day]] as const) {
				await q('savepoint s18_fp');
				const received = await now(flow, { key, restockingFeeWaived: waived, arrivedOn });
				prints.push(await fingerprint(key));
				if (waived) expect((await q('select restocking_fee_waived from public.order_return_receipts where id=$1', [received.receipt_id])).rows[0].restocking_fee_waived).toBe(true);
				await q('rollback to savepoint s18_fp');
				await q('release savepoint s18_fp');
			}
			expect(new Set(prints).size).toBe(4);
			// 作り直す前（移行 D・C の16の引数）の指紋と同じ
			await q('savepoint s18_old');
			await restorePreS18Receive(db());
			await q(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,'now',null,0,null,false,null,null,null,null,false)`,
				[flow.returnId, flow.f.actor, key, units]);
			const before = await fingerprint(key);
			await q('rollback to savepoint s18_old');
			await q('release savepoint s18_old');
			expect(prints[0]).toBe(before);
		});
	});

	describe('replays', () => {
		test('FREQ-576-AC-06: 受け取りの public 入口は17の引数で、14の引数の位置の呼び出し（既定で埋まる）も通り事実を残す', async () => {
			const flow = await seedReturnFlow(db(), { snapshot: false });
			const row = (await q(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,'now',null,0,null,false,null,null,null)`,
				[flow.returnId, flow.f.actor, randomUUID(), JSON.stringify([unit(flow.lineIds[0], 1, 'now')])])).rows[0];
			expect(row.refund_amount).toBe(16875);
			expect(await facts(flow.returnId)).toHaveLength(2);
			await dropDiscountSnapshot(db(), flow.f.orderId);
		});
	});
});
