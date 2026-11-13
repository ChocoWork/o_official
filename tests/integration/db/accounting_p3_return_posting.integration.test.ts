/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { amount } from '../../unit/lib/discounts/fixtures';
import { buildOrder } from '../../unit/lib/orders/unit-pricing/fixtures';
import { insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import { seedFactSlip, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, correctArrival, failRefund, orderBalance, orderLines, postOrderPayment, postRefundEvents, postReturnEvents, postShipments,
  receiveReturn, refundPending, returnFacts, seedReturnFlow, seedTwoPriceReturnFlow, setRequestedAt, shipUnits, succeedRefund, type ReturnFlow,
} from './helpers/accounting-returns-fixtures';
import { hDiscount, seedHDiscount, seedHMember, seedHOrderUnits, seedHUnitSlots, type HCatalog } from './helpers/group-h-fixtures';
import { hRefundFixture } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, shipFixtureOrder } from './helpers/order-fixtures';
import { createUbReturn, ubReceive, type ReceiveUnit } from './helpers/unit-binding-receive';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';

// 計画3 Task 7（S21）: 返品の係（届いた日・額の決定〔0円で終える決定を含む〕）と、計上係の入口の返品の係の呼び出し。
// 届いた日の直しは accounting_p3_return_redate、並行は accounting_p3_return_concurrency。
jest.setTimeout(180000);

type Failure = { code?: string; message?: string; detail?: string };
const unit = (lineId: string, quantity = 1, refundChoice?: 'now' | 'consult', disposition = 'not_restocked'): ReceiveUnit =>
  ({ return_line_id: lineId, disposition, quantity, ...(refundChoice ? { refund_choice: refundChoice } : {}) });
const NONE = { posted: 0, parked_new: 0, reparked: 0, resolved: 0, reversed: 0, redated: 0 };

describeLocalDb('FREQ-578-AC-01: S21 return posting', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint s21_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint s21_expected'); await q('release savepoint s21_expected'); }
  }
  /** 日本時間の今日から n 日前（YYYY-MM-DD）。 */
  const day = async (n = 0) => (await q("select (((now() at time zone 'Asia/Tokyo')::date) - $1::integer)::text as d", [n])).rows[0].d as string;
  const facts = (returnId: string) => returnFacts(db(), returnId);
  const kindLines = async (orderId: string, kind: string) => (await orderLines(db(), orderId)).filter((l) => l.event_kind === kind);
  const shape = (rows: Array<Record<string, unknown>>) => rows.map((l) => [l.account_code, l.debit, l.credit, l.sub_account ?? null]);
  /** 2130（返品の返金）の残り（貸方 − 借方）。 */
  const payable = (orderId: string) => orderBalance(db(), orderId, '2130', 'return_refund');
  /** 4020 の返品の側（借方 − 貸方）。 */
  const returns4020 = async (orderId: string) => 0 - (await orderBalance(db(), orderId, '4020'));
  const fee4050 = (orderId: string) => orderBalance(db(), orderId, '4050');
  const now = (flow: ReturnFlow, extra: Record<string, unknown> = {}) =>
    receiveReturn(db(), flow, { choice: 'now', units: [unit(flow.lineIds[0], 1, 'now')], ...extra });
  const consult = (flow: ReturnFlow, extra: Record<string, unknown> = {}) =>
    receiveReturn(db(), flow, { choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')], ...extra });
  const refundReturn = async (returnId: string, actor: string, value: number | null = null) =>
    (await q('select * from public.admin_refund_return($1,$2,$3,$4,0,null,false)', [returnId, actor, randomUUID(), value])).rows[0] as {
      refund_id: string | null; amount: number; status: string };
  const pending = (sourceId: string) => refundPending(db(), sourceId);
  const decisionsOf = async (returnId: string) => (await facts(returnId)).filter((f) => f.kind === 'decision');
  const factIds = async (returnId: string) => (await q('select id, kind, seq from public.accounting_return_facts where return_id=$1 order by seq', [returnId])).rows as Array<{ id: string; kind: string }>;
  /** 個人の事業のまま法人に切り替え、法人の期間が無い日を作る（期間が無い日の試験）。 */
  const toCorporation = async () => {
    const admin = await insertAccountingAdmin(db());
    const version = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0].v;
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, version, randomUUID()]);
  };
  const STANDARD_ARRIVAL = [['4020', 18750, 0, null], ['2130', 0, 18750, 'return_refund'], ['2130', 1875, 0, 'return_refund'], ['4050', 0, 1875, null]];
  const WAIVE_LINES = [['2130', 16875, 0, 'return_refund'], ['4050', 1875, 0, null], ['4020', 0, 18750, null]];

  describe('the arrival entry', () => {
    test('FREQ-578-AC-01: 届いた日に「売上値引・返品18,750／未払金（返品の返金）18,750」と「未払金1,875／返品の手数料の売上1,875」が1本の仕訳で入る', async () => {
      const flow = await seedReturnFlow(db());
      const received = await consult(flow);
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1 });
      const lines = await kindLines(flow.f.orderId, 'return_arrived');
      expect(shape(lines)).toEqual(STANDARD_ARRIVAL);
      expect(new Set(lines.map((l) => l.entry_id)).size).toBe(1);
      expect(lines.every((l) => l.dedupe_key === `return_arrived:${received.receipt_id}` && l.entry_date === lines[0].entry_date
        && l.source_table === 'order_return_receipts' && l.source_id === received.receipt_id && l.order_id === flow.f.orderId)).toBe(true);
      expect(lines.find((l) => l.account_code === '4050')!.memo).toBe(ACCOUNTING_LABELS.returnFeeRevenue);
      const description = (await q('select description from public.accounting_journal_entries where id=$1', [lines[0].entry_id])).rows[0].description;
      expect(description).toBe(ACCOUNTING_LABELS.returnArrived);
      expect(await payable(flow.f.orderId)).toBe(16875);
      // Nothing more on the next call.
      expect(await postReturnEvents(db())).toEqual(NONE);
    });

    test('FREQ-578-AC-01: 日は受け取りの届いた日で、記録した日（created_at）ではない', async () => {
      const flow = await seedReturnFlow(db());
      await setRequestedAt(db(), flow.returnId, `${await day(5)}T12:00:00+09:00`);
      const received = await consult(flow, { arrivedOn: await day(3) });
      const created = (await q("select ((created_at at time zone 'Asia/Tokyo')::date)::text as d from public.order_return_receipts where id=$1",
        [received.receipt_id])).rows[0].d;
      expect(created).toBe(await day(0));
      await postReturnEvents(db());
      const lines = await kindLines(flow.f.orderId, 'return_arrived');
      expect(lines).toHaveLength(4);
      expect(new Set(lines.map((l) => l.entry_date))).toEqual(new Set([await day(3)]));
    });

    test('FREQ-578-AC-01: 返金を始める受け取りは、返金が成功する前に届いた日の仕訳が入り、未払金（返品の返金）が16,875円残る', async () => {
      const flow = await seedReturnFlow(db());
      const received = await now(flow);
      expect(received.refund_status).not.toBe('succeeded');
      // The arrival is posted; the refund decision (as expected) closes as no_revenue.
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1, parked_new: 1, resolved: 1 });
      expect(shape(await kindLines(flow.f.orderId, 'return_arrived'))).toEqual(STANDARD_ARRIVAL);
      expect(await payable(flow.f.orderId)).toBe(16875);
    });

    test('FREQ-578-AC-01: 返品の返金（Task 6）が入ると未払金が0になり、4020は18,750円、4050は1,875円のまま', async () => {
      const flow = await seedReturnFlow(db());
      const received = await now(flow);
      await postReturnEvents(db());
      await succeedRefund(db(), received.refund_id!, { at: `${await day(0)}T03:00:00+09:00` });
      expect((await postRefundEvents(db())).posted).toBe(1);
      expect(await payable(flow.f.orderId)).toBe(0);
      expect(await returns4020(flow.f.orderId)).toBe(18750);
      expect(await fee4050(flow.f.orderId)).toBe(1875);
    });

    test('FREQ-578-AC-01: 受け取りで手数料を免除した（restocking_fee_waived が真）受け取りは、写しのある注文でも無い注文でも、届いた日の仕訳に 4050 の行が無く（F = 0）、返金を始めた決定の事実の手数料欄も0（F今 = F相 = 0）で、未払金は返す額のまま返金で0になる', async () => {
      for (const snapshot of [true, false]) {
        const flow = await seedReturnFlow(db(), { snapshot });
        const received = await now(flow, { restockingFeeWaived: true });
        expect((await q('select restocking_fee_waived from public.order_return_receipts where id=$1', [received.receipt_id])).rows[0].restocking_fee_waived).toBe(true);
        expect((await decisionsOf(flow.returnId)).map((d) => d.fee_amount)).toEqual([0]);
        await postReturnEvents(db());
        expect(shape(await kindLines(flow.f.orderId, 'return_arrived'))).toEqual([['4020', 18750, 0, null], ['2130', 0, 18750, 'return_refund']]);
        expect(await payable(flow.f.orderId)).toBe(received.refund_amount);
        await succeedRefund(db(), received.refund_id!, { at: `${await day(0)}T03:00:00+09:00` });
        await postRefundEvents(db());
        expect(await payable(flow.f.orderId)).toBe(0);
        expect((await orderLines(db(), flow.f.orderId)).filter((l) => l.account_code === '4050')).toEqual([]);
      }
    });

    test('FREQ-578-AC-10: 交換の設計の例7の返品は、届いた日に 4020 5,500／2130 5,500 だけが入り、残る着の +3,000円の直しの仕訳は無く、出荷の額も変わらない', async () => {
      // 例7 の注文（ジャケット 20,000円×2・パンツ 10,000円、セットの割引 4,500円）と受け取りは Task 4（S18）の試験と同じ作り
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
      await q('update public.orders set paid_amount=total_amount, payment_intent_id=$2 where id=$1', [seeded.orderId, `pi_s21_${randomUUID().replaceAll('-', '')}`]);
      const fulfillment = await shipFixtureOrder(db(), { orderId: seeded.orderId, actorId: userId, trackingNumber: 'S21-EX7',
        lines: seeded.orderItemIds.map((id, i) => ({ order_item_id: id, quantity: lines[i].quantity })) });
      for (const [i, id] of seeded.orderItemIds.entries()) await seedFactSlip(db(), { orderItemId: id, quantity: lines[i].quantity });
      await postOrderPayment(db(), seeded.orderId);
      await postShipments(db());
      const shipmentsBefore = await kindLines(seeded.orderId, 'shipment_confirmed');
      const sales = await orderBalance(db(), seeded.orderId, '4010');
      const entriesBefore = (await orderLines(db(), seeded.orderId)).length;
      const ret = await createUbReturn(db(), { orderId: seeded.orderId, itemId: seeded.orderItemIds[1], actor: userId, fulfillment, catalog: pants },
        [{ quantity: 1 }]);
      await ubReceive(db(), { returnId: ret.returnId, actorId: userId, choice: 'consult', units: [unit(ret.lineIds[0], 1, 'consult')] });
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1 });
      const all = await orderLines(db(), seeded.orderId);
      expect(all).toHaveLength(entriesBefore + 2);
      expect(shape(all.slice(entriesBefore))).toEqual([['4020', 5500, 0, null], ['2130', 0, 5500, 'return_refund']]);
      expect(all.slice(entriesBefore).every((l) => l.event_kind === 'return_arrived')).toBe(true);
      expect(await kindLines(seeded.orderId, 'shipment_confirmed')).toEqual(shipmentsBefore);
      expect(await orderBalance(db(), seeded.orderId, '4010')).toBe(sales);
    });
  });

  describe('the amount decision', () => {
    test('FREQ-578-AC-02: 相談で受け取ると見込み16,875円で立ち、14,000円と決めた日に「未払金2,875／売上値引・返品2,875」が入って未払金が14,000円になる', async () => {
      const flow = await seedReturnFlow(db());
      await consult(flow);
      await postReturnEvents(db());
      expect(await payable(flow.f.orderId)).toBe(16875);
      await refundReturn(flow.returnId, flow.f.actor, 14000);
      const [decision] = await decisionsOf(flow.returnId);
      const decisionId = (await factIds(flow.returnId)).find((f) => f.kind === 'decision')!.id;
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1 });
      const lines = await kindLines(flow.f.orderId, 'return_amount_decided');
      expect(shape(lines)).toEqual([['2130', 2875, 0, 'return_refund'], ['4020', 0, 2875, null]]);
      expect(lines.every((l) => l.entry_date === decision.decided_on && l.dedupe_key === `return_amount_decided:${decisionId}`
        && l.source_table === 'accounting_return_facts' && l.source_id === decisionId)).toBe(true);
      expect(await payable(flow.f.orderId)).toBe(14000);
    });

    test('FREQ-578-AC-02: 規約と違う額15,000円で返金すると、同じ日に「未払金1,875／売上値引・返品1,875」が入る', async () => {
      const flow = await seedReturnFlow(db());
      const received = await now(flow, { amount: 15000 });
      expect(received.refund_amount).toBe(15000);
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2 });
      const arrival = await kindLines(flow.f.orderId, 'return_arrived');
      const lines = await kindLines(flow.f.orderId, 'return_amount_decided');
      expect(shape(lines)).toEqual([['2130', 1875, 0, 'return_refund'], ['4020', 0, 1875, null]]);
      expect(lines[0].entry_date).toBe(arrival[0].entry_date);
      expect(await payable(flow.f.orderId)).toBe(15000);
    });

    test('FREQ-578-AC-02: 額が見込みどおりなら決定の仕訳は作らず no_revenue で解決済みになる', async () => {
      const flow = await seedReturnFlow(db());
      await now(flow);
      await postReturnEvents(db());
      const decisionId = (await factIds(flow.returnId)).find((f) => f.kind === 'decision')!.id;
      expect(await kindLines(flow.f.orderId, 'return_amount_decided')).toEqual([]);
      expect(await pending(decisionId)).toMatchObject([{ event_kind: 'return_amount_decided', source_table: 'accounting_return_facts',
        reason: 'no_revenue', resolved_entry_id: null }]);
      expect((await pending(decisionId))[0].resolved_at).not.toBeNull();
      expect(await postReturnEvents(db())).toEqual(NONE);
    });

    test('FREQ-578-AC-02: 受け取り1を相談（G1=10,000・F1=1,000、見込み9,000）、受け取り2を now で返金 7,200円（G2=8,000・F2=800）で受け取ると、受け取り2の返金の決定は差0で仕訳を作らず、受け取り1の見込み 9,000円は 2130（return_refund）に残る（借方2130 9,000／貸方4020 9,000 は入らない）', async () => {
      const flow = await seedTwoPriceReturnFlow(db(), { snapshot: false });
      await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')] });
      const second = await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'now', units: [unit(flow.lineIds[1], 1, 'now')] });
      expect(second.refund_amount).toBe(7200);
      expect((await facts(flow.returnId)).filter((f) => f.kind === 'arrival').map((f) => [f.goods_amount, f.fee_amount])).toEqual([[10000, 1000], [8000, 800]]);
      expect(await decisionsOf(flow.returnId)).toEqual([expect.objectContaining({ covers_amount: 7200, decided_amount: 7200, payable_delta: 0 })]);
      await postReturnEvents(db());
      expect(await kindLines(flow.orderId, 'return_amount_decided')).toEqual([]);
      expect(await payable(flow.orderId)).toBe(9000 + 7200);
      await succeedRefund(db(), second.refund_id, { at: `${await day(0)}T03:00:00+09:00` });
      await postRefundEvents(db());
      expect(await payable(flow.orderId)).toBe(9000);
    });

    test('FREQ-578-AC-02: 受け取り1の返金 r1 9,000円が引かれる前に失敗し、受け取り2を now で返金 7,200円で受け取り、受け取り2の返金が成功しても、r1 の借り 9,000円は 2130（return_refund）に残り、その後 r1 を振込で返すと 2130（return_refund）は0、4020 の返品は 18,000円、4050 は 1,800円で合う', async () => {
      const flow = await seedTwoPriceReturnFlow(db(), { snapshot: false });
      await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')] });
      const r1 = await refundReturn(flow.returnId, flow.actor);
      expect(r1.amount).toBe(9000);
      await failRefund(db(), r1.refund_id!);
      const second = await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'now', units: [unit(flow.lineIds[1], 1, 'now')] });
      expect(second.refund_amount).toBe(7200);
      await succeedRefund(db(), second.refund_id, { at: `${await day(0)}T03:00:00+09:00` });
      await postReturnEvents(db());
      await postRefundEvents(db());
      expect(await payable(flow.orderId)).toBe(9000);
      const admin = await insertAccountingAdmin(db());
      await bankTransfer(db(), { actor: admin, orderId: flow.orderId, origin: 'return', amount: 9000, on: await day(0), txn: `S21-${r1.refund_id!.slice(0, 8)}` });
      expect(await payable(flow.orderId)).toBe(0);
      expect(await returns4020(flow.orderId)).toBe(18000);
      expect(await fee4050(flow.orderId)).toBe(1800);
    });

    test('FREQ-578-AC-02: 写しの無い注文の相談の受け取り（手数料10%）で、返品の返金が引かれる前に失敗し（その返金の return_fee_deduction は fee_pending_deduction へ戻る）、admin_refund_return で返し直して成功すると、4050 は届いた日の F の1回だけで、2130（return_refund）は0、失敗した返金は 4050 にも 2130 にも何も足さない', async () => {
      const flow = await seedReturnFlow(db(), { snapshot: false });
      await consult(flow);
      const r1 = await refundReturn(flow.returnId, flow.f.actor);
      const deduction = Number((await q('select return_fee_deduction from public.order_refunds where id=$1', [r1.refund_id])).rows[0].return_fee_deduction);
      expect(deduction).toBe(1875);
      await failRefund(db(), r1.refund_id!);
      expect(Number((await q('select fee_pending_deduction from public.order_returns where id=$1', [flow.returnId])).rows[0].fee_pending_deduction)).toBe(deduction);
      const r2 = await refundReturn(flow.returnId, flow.f.actor);
      expect(r2.amount).toBe(16875);
      await succeedRefund(db(), r2.refund_id!, { at: `${await day(0)}T03:00:00+09:00` });
      await postReturnEvents(db());
      await postRefundEvents(db());
      expect(await fee4050(flow.f.orderId)).toBe(1875);
      expect((await orderLines(db(), flow.f.orderId)).filter((l) => l.account_code === '4050')).toHaveLength(1);
      expect(await payable(flow.f.orderId)).toBe(0);
      expect((await orderLines(db(), flow.f.orderId)).filter((l) => l.source_id === r1.refund_id)).toEqual([]);
    });

    test('FREQ-578-AC-06: 額の決定の事実が届いた日の仕訳より先に見つかっても、届いた日の仕訳が入るまで待ち、入った後に入る', async () => {
      const flow = await seedReturnFlow(db());
      await setRequestedAt(db(), flow.returnId, `${await day(5)}T12:00:00+09:00`);
      const received = await consult(flow, { arrivedOn: await day(3) });
      await refundReturn(flow.returnId, flow.f.actor, 14000);
      const decisionId = (await factIds(flow.returnId)).find((f) => f.kind === 'decision')!.id;
      // The arrival day is before the cutover for now: the arrival parks, and the decision waits for it.
      await setCutoverForTest(db(), await day(1));
      expect(await postReturnEvents(db())).toEqual({ ...NONE, parked_new: 2 });
      expect(await pending(received.receipt_id)).toMatchObject([{ event_kind: 'return_arrived', reason: 'before_cutover', resolved_at: null }]);
      expect(await pending(decisionId)).toMatchObject([{ reason: 'refund_prior_unposted', detail: { why: 'return_prior' }, resolved_at: null }]);
      expect(await kindLines(flow.f.orderId, 'return_amount_decided')).toEqual([]);
      await setCutoverForTest(db(), '2026-01-01');
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2, resolved: 2 });
      expect(shape(await kindLines(flow.f.orderId, 'return_amount_decided'))).toEqual([['2130', 2875, 0, 'return_refund'], ['4020', 0, 2875, null]]);
      expect(await payable(flow.f.orderId)).toBe(14000);
    });

    describe('the receive refund cap (FREQ-578-AC-02, 2026-11-06)', () => {
      test('FREQ-578-AC-02: 受け取り1の相談分を受け取り2の今すぐへ上乗せすると上限で拒否される', async () => {
        const flow = await seedTwoPriceReturnFlow(db(), { snapshot: false });
        await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'consult', units: [unit(flow.lineIds[0], 1, 'consult')] });
        const counts = async () => (await q(`select
          (select count(*)::int from public.order_return_receipts where return_id=$1 and kind='receive') receipts,
          (select count(*)::int from public.order_refunds where order_id=$2) refunds,
          (select count(*)::int from public.accounting_return_facts where return_id=$1 and kind='arrival') arrivals,
          (select count(*)::int from public.accounting_return_facts where return_id=$1 and kind='decision') decisions`, [flow.returnId, flow.orderId])).rows[0];
        const error = await failure(() => ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'now', amount: 16200,
          units: [unit(flow.lineIds[1], 1, 'now')] }));
        expect(error.message).toBe('RETURN_RECEIVE_REFUND_CAP_EXCEEDED');
        // receipt2 / refund2 / arrival2 / decision2: none
        expect(await counts()).toEqual({ receipts: 1, refunds: 0, arrivals: 1, decisions: 0 });
        await postReturnEvents(db());
        expect(await payable(flow.orderId)).toBe(9000);
      });

      test('FREQ-578-AC-02: mixedの決定は今すぐ分だけを覆い相談分を残す', async () => {
        const flow = await seedTwoPriceReturnFlow(db(), { snapshot: false });
        const received = await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'mixed',
          units: [unit(flow.lineIds[1], 1, 'now'), unit(flow.lineIds[0], 1, 'consult')] });
        expect(received.refund_amount).toBe(7200);
        const all = await facts(flow.returnId);
        const arrivalCount = all.filter((f) => f.kind === 'arrival').length;
        expect(arrivalCount).toBe(1);
        expect(all.filter((f) => f.kind === 'decision')).toEqual([expect.objectContaining({ covers_amount: 7200, fee_amount: 800, payable_delta: 0 })]);
        await postReturnEvents(db());
        await succeedRefund(db(), received.refund_id, { at: `${await day(0)}T03:00:00+09:00` });
        await postRefundEvents(db());
        expect(await payable(flow.orderId)).toBe(9000);
      });

      test('FREQ-578-AC-02: 上限内で手数料を負けた差は既存どおり記録する', async () => {
        const flow = await seedTwoPriceReturnFlow(db(), { snapshot: false });
        await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'mixed', amount: 8000,
          units: [unit(flow.lineIds[1], 1, 'now'), unit(flow.lineIds[0], 1, 'consult')] });
        const [decision] = await decisionsOf(flow.returnId);
        expect(decision).toMatchObject({ covers_amount: 7200, payable_delta: 800 });
        expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2 });
        expect(shape(await kindLines(flow.orderId, 'return_amount_decided'))).toEqual([['4020', 800, 0, null], ['2130', 0, 800, 'return_refund']]);
      });
    });
  });

  describe('the 0 yen close', () => {
    test('FREQ-578-AC-08: 返金を0円で終えた返品（G=18,750・F=1,875）は、決めた日に借方2130 16,875・借方4050 1,875・貸方4020 18,750が1本で入り、2130（返品の返金）・4020の返品・4050の累計が0になる（admin_refund_return に額0を渡す道）', async () => {
      const flow = await seedReturnFlow(db());
      await consult(flow);
      expect(await refundReturn(flow.returnId, flow.f.actor, 0)).toMatchObject({ refund_id: null, amount: 0, status: 'waived' });
      const [decision] = await decisionsOf(flow.returnId);
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2 });
      const lines = await kindLines(flow.f.orderId, 'return_amount_decided');
      expect(shape(lines)).toEqual(WAIVE_LINES);
      expect(new Set(lines.map((l) => l.entry_id)).size).toBe(1);
      expect(lines.every((l) => l.entry_date === decision.decided_on)).toBe(true);
      expect(lines.find((l) => l.account_code === '4050')!.memo).toBe(ACCOUNTING_LABELS.returnFeeRevenue);
      expect(await payable(flow.f.orderId)).toBe(0);
      expect(await returns4020(flow.f.orderId)).toBe(0);
      expect(await fee4050(flow.f.orderId)).toBe(0);
    });

    test('FREQ-578-AC-08: 受け取りを now にして返金額0で受け取る道でも、同じ仕訳・同じ残り（0）になる', async () => {
      const flow = await seedReturnFlow(db());
      expect(await now(flow, { amount: 0 })).toMatchObject({ refund_id: null, refund_status: 'waived' });
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2 });
      expect(shape(await kindLines(flow.f.orderId, 'return_amount_decided'))).toEqual(WAIVE_LINES);
      expect(await payable(flow.f.orderId)).toBe(0);
      expect(await returns4020(flow.f.orderId)).toBe(0);
      expect(await fee4050(flow.f.orderId)).toBe(0);
    });

    test('FREQ-578-AC-08: 0円の決定の仕訳の 4020・4050・2130 の行に注文番号が付く', async () => {
      const flow = await seedReturnFlow(db());
      await consult(flow);
      await refundReturn(flow.returnId, flow.f.actor, 0);
      await postReturnEvents(db());
      const lines = await kindLines(flow.f.orderId, 'return_amount_decided');
      expect(lines.map((l) => l.account_code).sort()).toEqual(['2130', '4020', '4050']);
      expect(lines.every((l) => l.order_id === flow.f.orderId)).toBe(true);
    });

    test('FREQ-578-AC-08: admin_refund_return に額0を渡す道で、0円の決定の事実がその返品の届いた日の仕訳より先に見つかっても、届いた日の仕訳が全部入るまで待ち、入った後に入る', async () => {
      const flow = await seedReturnFlow(db());
      await setRequestedAt(db(), flow.returnId, `${await day(5)}T12:00:00+09:00`);
      const received = await consult(flow, { arrivedOn: await day(3) });
      await refundReturn(flow.returnId, flow.f.actor, 0);
      const decisionId = (await factIds(flow.returnId)).find((f) => f.kind === 'decision')!.id;
      // The waive_refund receipt of this path has no arrival fact; the decision still waits for the arrival of the receive receipt.
      expect((await facts(flow.returnId)).find((f) => f.kind === 'decision')!.receipt_id).not.toBe(received.receipt_id);
      await setCutoverForTest(db(), await day(1));
      expect(await postReturnEvents(db())).toEqual({ ...NONE, parked_new: 2 });
      expect(await pending(decisionId)).toMatchObject([{ reason: 'refund_prior_unposted', detail: { why: 'return_prior' }, resolved_at: null }]);
      expect(await kindLines(flow.f.orderId, 'return_amount_decided')).toEqual([]);
      await setCutoverForTest(db(), '2026-01-01');
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2, resolved: 2 });
      expect(shape(await kindLines(flow.f.orderId, 'return_amount_decided'))).toEqual(WAIVE_LINES);
      expect(await payable(flow.f.orderId)).toBe(0);
    });

    test('FREQ-578-AC-08: 受け取りを now にして返金額0で受け取る道で、0円の決定の事実が届いた日の仕訳より先に見つかっても、届いた日の仕訳が入るまで待ち、入った後に入る', async () => {
      const flow = await seedReturnFlow(db());
      await setRequestedAt(db(), flow.returnId, `${await day(5)}T12:00:00+09:00`);
      const received = await now(flow, { amount: 0, arrivedOn: await day(3) });
      const decisionId = (await factIds(flow.returnId)).find((f) => f.kind === 'decision')!.id;
      await setCutoverForTest(db(), await day(1));
      expect(await postReturnEvents(db())).toEqual({ ...NONE, parked_new: 2 });
      expect(await pending(received.receipt_id)).toMatchObject([{ reason: 'before_cutover' }]);
      expect(await pending(decisionId)).toMatchObject([{ reason: 'refund_prior_unposted', detail: { why: 'return_prior' } }]);
      await setCutoverForTest(db(), '2026-01-01');
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 2, resolved: 2 });
      expect(shape(await kindLines(flow.f.orderId, 'return_amount_decided'))).toEqual(WAIVE_LINES);
    });

    test('FREQ-578-AC-08: 失敗した返金の借りが残る受け取りがある返品で、別の受け取りを now・返金額0で終えても、その借りの2130（返品の返金）は残り、振込で返せる', async () => {
      const flow = await seedReturnFlow(db(), { groups: [{ quantity: 2 }] });
      const first = await now(flow);
      await failRefund(db(), first.refund_id!);
      const second = await now(flow, { amount: 0 });
      expect(second).toMatchObject({ refund_id: null, refund_status: 'waived' });
      await postReturnEvents(db());
      await postRefundEvents(db());
      const [a1] = (await facts(flow.returnId)).filter((f) => f.kind === 'arrival');
      expect(first.refund_amount).toBe(a1.goods_amount - a1.fee_amount);
      expect(await payable(flow.f.orderId)).toBe(first.refund_amount);
      const admin = await insertAccountingAdmin(db());
      await bankTransfer(db(), { actor: admin, orderId: flow.f.orderId, origin: 'return', amount: first.refund_amount!, on: await day(0),
        txn: `S21-${first.refund_id!.slice(0, 8)}` });
      expect(await payable(flow.f.orderId)).toBe(0);
    });

    test('FREQ-578-AC-08: 受け取り2件（どちらも返金前）の返品を admin_refund_return(0) でまとめて終えると、1本の仕訳で2130（返品の返金）・4020の返品・4050が0になる', async () => {
      const flow = await seedReturnFlow(db(), { groups: [{ quantity: 2 }] });
      await consult(flow);
      await consult(flow);
      await refundReturn(flow.returnId, flow.f.actor, 0);
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 3 });
      const lines = await kindLines(flow.f.orderId, 'return_amount_decided');
      expect(new Set(lines.map((l) => l.entry_id)).size).toBe(1);
      expect(await payable(flow.f.orderId)).toBe(0);
      expect(await returns4020(flow.f.orderId)).toBe(0);
      expect(await fee4050(flow.f.orderId)).toBe(0);
    });

    test('FREQ-578-AC-08: 1件目の受け取りを返金した後に2件目を admin_refund_return(0) で終えると、戻す手数料は1件目の返金で引いた手数料を除いた2件目の分だけで、4050 に1件目の手数料が残る', async () => {
      const flow = await seedReturnFlow(db(), { groups: [{ quantity: 2 }] });
      const first = await now(flow);
      await succeedRefund(db(), first.refund_id!, { at: `${await day(0)}T03:00:00+09:00` });
      await consult(flow);
      await refundReturn(flow.returnId, flow.f.actor, 0);
      const [a1, a2] = (await facts(flow.returnId)).filter((f) => f.kind === 'arrival');
      await postReturnEvents(db());
      await postRefundEvents(db());
      const waive = (await kindLines(flow.f.orderId, 'return_amount_decided'));
      expect(shape(waive)).toEqual([['2130', a2.goods_amount - a2.fee_amount, 0, 'return_refund'], ['4050', a2.fee_amount, 0, null], ['4020', 0, a2.goods_amount, null]]);
      expect(await fee4050(flow.f.orderId)).toBe(a1.fee_amount);
      expect(await payable(flow.f.orderId)).toBe(0);
    });

    test('FREQ-578-AC-08: 手数料で返金額が0になった受け取り（割合100%）の0円の決定は仕訳を作らず no_revenue で、4020 G・4050 G が残る', async () => {
      const flow = await seedReturnFlow(db(), { percent: 100 });
      const received = await now(flow);
      expect(received).toMatchObject({ refund_id: null });
      const [decision] = await decisionsOf(flow.returnId);
      expect(decision).toMatchObject({ refund_id: null, covers_amount: 0, decided_amount: 0 });
      await postReturnEvents(db());
      expect(await kindLines(flow.f.orderId, 'return_amount_decided')).toEqual([]);
      const decisionId = (await factIds(flow.returnId)).find((f) => f.kind === 'decision')!.id;
      expect(await pending(decisionId)).toMatchObject([{ reason: 'no_revenue' }]);
      expect(await returns4020(flow.f.orderId)).toBe(18750);
      expect(await fee4050(flow.f.orderId)).toBe(18750);
      expect(await payable(flow.f.orderId)).toBe(0);
    });

    test('FREQ-576-AC-03: 手数料が支払額と同じ（割合100%）の返品は、4020 G／2130 G と 2130 G／4050 G で未払金が0になり、その後の0円の決定は no_revenue で、4020 G・4050 G が残る', async () => {
      const flow = await seedReturnFlow(db(), { percent: 100 });
      await consult(flow);
      await postReturnEvents(db());
      expect(shape(await kindLines(flow.f.orderId, 'return_arrived'))).toEqual([['4020', 18750, 0, null], ['2130', 0, 18750, 'return_refund'],
        ['2130', 18750, 0, 'return_refund'], ['4050', 0, 18750, null]]);
      expect(await payable(flow.f.orderId)).toBe(0);
      await refundReturn(flow.returnId, flow.f.actor, 0);
      expect(await postReturnEvents(db())).toEqual({ ...NONE, parked_new: 1, resolved: 1 });
      expect(await kindLines(flow.f.orderId, 'return_amount_decided')).toEqual([]);
      expect(await returns4020(flow.f.orderId)).toBe(18750);
      expect(await fee4050(flow.f.orderId)).toBe(18750);
    });

    test('FREQ-578-AC-08: 写しのある注文で受け取りの今すぐの返金が引かれる前に失敗し、admin_refund_return(0) で閉じると、order_unit_event_waives にその出来事の now と consult が入り、0円の決定の C は失敗した今すぐの分を含む未払金の残りで、決めた日の仕訳で 2130（return_refund）・4020 の返品・4050 が0になり、後の admin_refund_return はその分を覆わない', async () => {
      const flow = await seedReturnFlow(db(), { groups: [{ quantity: 1 }, { quantity: 1 }] });
      const received = await receiveReturn(db(), flow, { choice: 'mixed', units: [unit(flow.lineIds[0], 1, 'now'), unit(flow.lineIds[1], 1, 'consult')] });
      const event = (await q('select id, now_refund, consult_refund from public.order_unit_events where receipt_id=$1', [received.receipt_id])).rows[0];
      await failRefund(db(), received.refund_id!);
      await refundReturn(flow.returnId, flow.f.actor, 0);
      expect((await q('select event_id, part from public.order_unit_event_waives where event_id=$1 order by part', [event.id])).rows)
        .toEqual([{ event_id: event.id, part: 'consult' }, { event_id: event.id, part: 'now' }]);
      const [arrival] = (await facts(flow.returnId)).filter((f) => f.kind === 'arrival');
      const waive = (await decisionsOf(flow.returnId)).find((d) => d.refund_id === null)!;
      expect(waive.covers_amount).toBe(arrival.goods_amount - arrival.fee_amount);
      expect(waive.covers_amount).toBe(event.now_refund + event.consult_refund);
      await postReturnEvents(db());
      await postRefundEvents(db());
      expect(waive.decided_on).toBe((await kindLines(flow.f.orderId, 'return_amount_decided'))[0].entry_date);
      expect(await payable(flow.f.orderId)).toBe(0);
      expect(await returns4020(flow.f.orderId)).toBe(0);
      expect(await fee4050(flow.f.orderId)).toBe(0);
      const refundsBefore = Number((await q('select count(*) n from public.order_refunds where order_id=$1', [flow.f.orderId])).rows[0].n);
      const later = await failure(() => refundReturn(flow.returnId, flow.f.actor));
      expect(later.message).toBeDefined();
      expect(Number((await q('select count(*) n from public.order_refunds where order_id=$1', [flow.f.orderId])).rows[0].n)).toBe(refundsBefore);
    });

    test('FREQ-578-AC-08: mixed の受け取り（G今=8,000・F今=800・G相=10,000・F相=1,000）を今すぐの返金額0で受け取ると、決めた日に借方2130 7,200・借方4050 800・貸方4020 8,000が1本で入り、相談の分の2130（return_refund）9,000・4020 10,000・4050 1,000 は残る', async () => {
      const flow = await seedTwoPriceReturnFlow(db(), { snapshot: false });
      const received = await ubReceive(db(), { returnId: flow.returnId, actorId: flow.actor, choice: 'mixed', amount: 0,
        units: [unit(flow.lineIds[1], 1, 'now'), unit(flow.lineIds[0], 1, 'consult')] });
      expect(received).toMatchObject({ refund_id: null, refund_status: 'waived' });
      await postReturnEvents(db());
      const lines = await kindLines(flow.orderId, 'return_amount_decided');
      expect(shape(lines)).toEqual([['2130', 7200, 0, 'return_refund'], ['4050', 800, 0, null], ['4020', 0, 8000, null]]);
      expect(new Set(lines.map((l) => l.entry_id)).size).toBe(1);
      expect(await payable(flow.orderId)).toBe(9000);
      expect(await returns4020(flow.orderId)).toBe(10000);
      expect(await fee4050(flow.orderId)).toBe(1000);
    });

    test('FREQ-578-AC-08: 写しのある注文の mixed の受け取り（割合の手数料10%）を今すぐの返金額0で受け取り、相談の分を admin_refund_return(0) で終えると、今すぐの0円の決定は手数料を戻さず、相談の0円の決定が出来事の手数料 F の全部を戻し、2130（返品の返金）・4020 の返品・4050 が0になる（未確認 #23）', async () => {
      const flow = await seedReturnFlow(db(), { groups: [{ quantity: 1 }, { quantity: 1 }] });
      const received = await receiveReturn(db(), flow, { choice: 'mixed', amount: 0,
        units: [unit(flow.lineIds[0], 1, 'now'), unit(flow.lineIds[1], 1, 'consult')] });
      expect(received).toMatchObject({ refund_id: null, refund_status: 'waived' });
      const event = (await q('select fee_amount, now_refund, consult_refund from public.order_unit_events where receipt_id=$1', [received.receipt_id])).rows[0];
      expect(event.fee_amount).toBeGreaterThan(0);
      await refundReturn(flow.returnId, flow.f.actor, 0);
      const [arrival] = (await facts(flow.returnId)).filter((f) => f.kind === 'arrival');
      const [nowClose, consultClose] = await decisionsOf(flow.returnId);
      // Ruling P3-B2: F今 = 0 and F相 = F on a snapshot mixed event.
      expect(arrival.fee_amount).toBe(event.fee_amount);
      expect(nowClose).toMatchObject({ fee_amount: 0, covers_amount: event.now_refund });
      expect(consultClose).toMatchObject({ fee_amount: event.fee_amount, covers_amount: event.consult_refund });
      await postReturnEvents(db());
      expect(await payable(flow.f.orderId)).toBe(0);
      expect(await returns4020(flow.f.orderId)).toBe(0);
      expect(await fee4050(flow.f.orderId)).toBe(0);
    });
  });

  describe('what is not posted', () => {
    test('FREQ-578-AC-04: 品を送り返すだけの受け取りと交換だけの受け取りは、仕訳も計上待ちも作らない', async () => {
      const flow = await seedReturnFlow(db());
      const sentBack = await receiveReturn(db(), flow, { choice: 'none', notify: true, units: [unit(flow.lineIds[0], 1, undefined, 'sent_back')], sentBackMessage: '送り返す' });
      const exchange = await seedReturnFlow(db(), { groups: [{ quantity: 1, exchange: true }] });
      const swapped = await receiveReturn(db(), exchange, { choice: 'none', units: [unit(exchange.lineIds[0])] });
      expect(await postReturnEvents(db())).toEqual(NONE);
      for (const o of [flow.f.orderId, exchange.f.orderId]) {
        expect((await orderLines(db(), o)).filter((l) => l.event_kind.startsWith('return_'))).toEqual([]);
      }
      expect(await pending(sentBack.receipt_id)).toEqual([]);
      expect(await pending(swapped.receipt_id)).toEqual([]);
      expect((await q('select count(*)::int n from public.accounting_pending_events where order_id = any($1::uuid[]) and resolved_at is null',
        [[flow.f.orderId, exchange.f.orderId]])).rows[0].n).toBe(0);
    });

    test('FREQ-578-AC-04: 同じ受け取りに戻す品と送り返す品が混ざる時、戻す品の額だけで立つ', async () => {
      const flow = await seedReturnFlow(db(), { groups: [{ quantity: 1 }, { quantity: 1 }] });
      await receiveReturn(db(), flow, { choice: 'consult', notify: true, sentBackMessage: '送り返す',
        units: [unit(flow.lineIds[0], 1, 'consult'), unit(flow.lineIds[1], 1, undefined, 'sent_back')] });
      const [arrival] = await facts(flow.returnId);
      await postReturnEvents(db());
      const lines = await kindLines(flow.f.orderId, 'return_arrived');
      expect(lines.find((l) => l.account_code === '4020')!.debit).toBe(arrival.goods_amount);
      // One returned unit only (the order has 20,000 + 18,750).
      expect([20000, 18750]).toContain(arrival.goods_amount);
      expect(await payable(flow.f.orderId)).toBe(arrival.goods_amount - arrival.fee_amount);
    });
  });

  describe('order independence', () => {
    test('FREQ-578-AC-06: 受け取りの仕訳が支払い・出荷より先に流れても、同じ額で入る', async () => {
      // A: payment and shipments first, then the arrival. B: the arrival first, then payment and shipments.
      const a = await seedReturnFlow(db());
      await postOrderPayment(db(), a.f.orderId);
      await postShipments(db());
      await consult(a);
      await postReturnEvents(db());
      const b = await seedReturnFlow(db());
      await consult(b);
      await postReturnEvents(db());
      await postOrderPayment(db(), b.f.orderId);
      await postShipments(db());
      expect(shape(await kindLines(a.f.orderId, 'return_arrived'))).toEqual(STANDARD_ARRIVAL);
      expect(shape(await kindLines(b.f.orderId, 'return_arrived'))).toEqual(STANDARD_ARRIVAL);
      for (const o of [a.f.orderId, b.f.orderId]) {
        expect(await payable(o)).toBe(16875);
        expect(await returns4020(o)).toBe(18750);
        expect(await fee4050(o)).toBe(1875);
      }
    });

    test('FREQ-578-AC-06: 届いた日の仕訳が入った後に手数料の割合の設定を変えても、入った額は変わらない（事実の額で立つため）', async () => {
      const flow = await seedReturnFlow(db());
      await setRequestedAt(db(), flow.returnId, `${await day(5)}T12:00:00+09:00`);
      const received = await consult(flow, { arrivedOn: await day(3) });
      await postReturnEvents(db());
      await q('alter table public.order_returns disable trigger user');
      await q('update public.order_returns set restocking_fee_percent = 50 where id=$1', [flow.returnId]);
      await q('alter table public.order_returns enable trigger user');
      // A correction books the arrival again from the fact: the fee is still 1,875 (never 50%).
      await correctArrival(db(), received.receipt_id, await day(1));
      expect(await postReturnEvents(db())).toMatchObject({ posted: 1, redated: 1 });
      expect(shape(await kindLines(flow.f.orderId, 'return_arrival_redated'))).toEqual(STANDARD_ARRIVAL);
      expect(await payable(flow.f.orderId)).toBe(16875);
      expect(await fee4050(flow.f.orderId)).toBe(1875);
    });
  });

  describe('the entry point and the parked days', () => {
    test('FREQ-562-AC-05: 返品の係は返金の前に呼ばれ、戻りの returns が返品の件数を数える', async () => {
      const flow = await seedReturnFlow(db());
      const received = await now(flow);
      await succeedRefund(db(), received.refund_id!, { at: `${await day(0)}T03:00:00+09:00` });
      const base = (await q('select public.accounting_run_posting(50) as r')).rows[0].r;
      // In one call the return poster books the arrival first, so the return refund does not wait for it.
      expect(base).toMatchObject({ returns: 1, refunds: 1 });
      expect(await pending(received.refund_id!)).toEqual([]);
      expect(await payable(flow.f.orderId)).toBe(0);
      // has_more counts the return poster: limit 1 with one arrival left.
      const other = await seedReturnFlow(db());
      await consult(other);
      expect((await q('select public.accounting_run_posting(1) as r')).rows[0].r).toMatchObject({ returns: 1, has_more: true });
    });

    test('FREQ-569-AC-01: S21の届いた日・額の決定・届いた日の直しのすべてのperiod_missingでdetail.entry_dateが各仕訳の日になる', async () => {
      await setCutoverForTest(db(), '2025-01-01');
      // A: the arrival is booked in 2025 while sole; its decision and correction come after the switch to a corporation.
      const a = await seedReturnFlow(db());
      await setRequestedAt(db(), a.returnId, '2025-12-20T12:00:00+09:00');
      const ra = await consult(a, { arrivedOn: '2025-12-25' });
      expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1 });
      const b = await seedReturnFlow(db());
      const rb = await consult(b);
      await toCorporation();
      await refundReturn(a.returnId, a.f.actor, 14000);
      const decisionId = (await factIds(a.returnId)).find((f) => f.kind === 'decision')!.id;
      const correction = await correctArrival(db(), ra.receipt_id, await day(1));
      expect(await postReturnEvents(db())).toEqual({ ...NONE, parked_new: 3 });
      expect(await pending(rb.receipt_id)).toMatchObject([{ event_kind: 'return_arrived', reason: 'period_missing', detail: { entry_date: await day(0) } }]);
      const [decision] = await decisionsOf(a.returnId);
      expect(await pending(decisionId)).toMatchObject([{ event_kind: 'return_amount_decided', reason: 'period_missing', detail: { entry_date: decision.decided_on } }]);
      expect(await pending(correction.correction_id)).toMatchObject([{ event_kind: 'return_arrival_redated', reason: 'period_missing', detail: { entry_date: await day(1) } }]);
      for (const sourceId of [rb.receipt_id, decisionId, correction.correction_id]) {
        expect(Object.keys((await pending(sourceId))[0].detail)).toEqual(['entry_date']);
      }
      // Once the corporation period exists, every one of them goes in.
      await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-01-01', endsOn: '2026-12-31' });
      expect(await postReturnEvents(db())).toMatchObject({ posted: 3, resolved: 3, redated: 1 });
    });
  });

  describe('carried checks', () => {
    test('FREQ-578-AC-01: 店が作った返品の届いた日は注文の最初の発送日を下限にするので、後で送った着の届いた日の仕訳がその着の出荷の仕訳より前の日に入りうる（未確認 n2。今の動きを記録する）', async () => {
      // Two units of one line, shipped on two slips: the first 10 days ago, the second 2 days ago. A shop-made return of the
      // second unit (no request time) may take an arrival day between the two.
      const f = await hRefundFixture(db(), false, 2, 1250);
      await postOrderPayment(db(), f.orderId);
      const first = await shipUnits(db(), f.orderId, f.itemId, 1, f.actor);
      const second = await shipUnits(db(), f.orderId, f.itemId, 1, f.actor);
      // The slip and its fulfillment carry the same day (the shipment poster checks they agree).
      await q("set local session_replication_role = 'replica'");
      for (const [slip, n] of [[first, 10], [second, 2]] as const) {
        await q("update public.shipment_slips set shipment_date = (((now() at time zone 'Asia/Tokyo')::date) - $2::integer) where id=$1", [slip.slipId, n]);
        await q("update public.order_fulfillments set shipment_date = (((now() at time zone 'Asia/Tokyo')::date) - $2::integer) where id=$1",
          [slip.fulfillmentId, n]);
      }
      await q("set local session_replication_role = 'origin'");
      await postShipments(db());
      const shipped = await kindLines(f.orderId, 'shipment_confirmed');
      expect([...new Set(shipped.map((l) => l.entry_date))].sort()).toEqual([await day(10), await day(2)]);
      const fulfillment = { fulfillment_id: second.fulfillmentId };
      const ret = await createUbReturn(db(), { ...f, fulfillment }, [{ quantity: 1 }], { percent: 10 });
      await q('alter table public.order_returns disable trigger user');
      await q("update public.order_returns set source='shop', requested_at=null where id=$1", [ret.returnId]);
      await q('alter table public.order_returns enable trigger user');
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', arrivedOn: await day(5),
        units: [unit(ret.lineIds[0], 1, 'consult')] });
      await postReturnEvents(db());
      const arrival = await kindLines(f.orderId, 'return_arrived');
      expect(arrival[0].entry_date).toBe(await day(5));
      const [fact] = await facts(ret.returnId);
      // The record: the 4020 of the returned unit is dated before the shipment entry of the second slip (its 4010).
      const secondSale = shipped.filter((l) => l.entry_date === (shipped.map((x) => x.entry_date).sort().at(-1)) && l.account_code === '4010');
      expect(arrival[0].entry_date < secondSale[0].entry_date).toBe(true);
      // First slip (d-10): 2150 20,000 / 4010 20,000. Second slip (d-2): 2150 18,750 / 4010 18,750. The arrival of that second
      // unit (d-5): 4020 18,750 / 2130 18,750 and 2130 1,875 / 4050 1,875, three days before its sale.
      expect(received.receipt_id).toBeTruthy();
      expect([fact.goods_amount, fact.fee_amount]).toEqual([18750, 1875]);
      expect(shape(shipped.filter((l) => l.entry_date === shipped.map((x) => x.entry_date).sort()[0])))
        .toEqual([['2150', 20000, 0, null], ['4010', 0, 20000, null]]);
      expect(shape(secondSale.length ? shipped.filter((l) => l.entry_id === secondSale[0].entry_id) : []))
        .toEqual([['2150', 18750, 0, null], ['4010', 0, 18750, null]]);
      expect(shape(arrival)).toEqual(STANDARD_ARRIVAL);
    });
  });
});
