/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import type { UnitPricingPlan } from '@/lib/orders/unit-pricing/unit-pricing-types';
import { amount } from '../../unit/lib/discounts/fixtures';
import { buildOrder } from '../../unit/lib/orders/unit-pricing/fixtures';
import { seedFactSlip } from './helpers/accounting-orders-fixtures';
import { hDiscount, seedHDiscount, seedHMember, seedHOrderUnits, seedHUnitSlots, type HCatalog } from './helpers/group-h-fixtures';
import { hClaims, hRefundFixture, hResult, type HRefundFixture } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, shipFixtureOrder } from './helpers/order-fixtures';
import { buildReceivePricing, createUbReturn, materialsOf, ubReceive, type ReceiveUnit } from './helpers/unit-binding-receive';

jest.setTimeout(60000);

const directory = path.join(process.cwd(), 'supabase', 'migrations');
const file = fs.readdirSync(directory).find((name) => name.endsWith('_unit_binding_refunds.sql'));
const sql = file ? fs.readFileSync(path.join(directory, file), 'utf8') : '';

describe('FREQ-642-AC-27: unit binding migration D source contract', () => {
  test('FREQ-642-AC-27: 移行Dは単一取引・ASCII・LF・末尾の確かめを持つ', () => {
    expect(file).toBeDefined();
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(sql).toContain('UNIT_BINDING_REFUNDS_MIGRATION_ASSERTION_FAILED');
    for (const detail of ['ubf_functions', 'ubf_acl', 'ubf_allowlist', 'ubf_schema']) expect(sql).toContain(`'${detail}'`);
  });
});

type Failure = { code?: string; message?: string; detail?: string };
const unit = (lineId: string, quantity = 1, refundChoice?: 'now' | 'consult', disposition = 'not_restocked'): ReceiveUnit =>
  ({ return_line_id: lineId, disposition, quantity, ...(refundChoice ? { refund_choice: refundChoice } : {}) });

describeLocalDb('FREQ-642-AC-27: unit binding refunds, cancels and releases (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint ubf_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint ubf_expected'); await q('release savepoint ubf_expected'); }
  }

  const slotsOf = async (orderId: string) => (await q(`select s.order_item_id, s.unit_index, s.state, s.current_price, s.holder_order_item_id, s.last_event_id
    from public.order_unit_slots s where s.order_id=$1 order by s.current_price, s.order_item_id, s.unit_index`, [orderId])).rows;
  const eventsOf = async (orderId: string) => (await q('select * from public.order_unit_events where order_id=$1 order by seq', [orderId])).rows;
  const linesOfEvent = async (eventId: string) => (await q('select * from public.order_unit_event_lines where event_id=$1 order by line_kind, order_item_id, unit_index', [eventId])).rows;
  const refundRow = async (id: string) => (await q('select * from public.order_refunds where id=$1', [id])).rows[0];
  const refundedTotal = async (orderId: string) => Number((await q(
    "select coalesce(sum(amount),0) n from public.order_refunds where order_id=$1 and status<>'failed'", [orderId])).rows[0].n);

  const cancelPlan = async (orderId: string, orderItemId: string, quantity: number) => planUnitEvent(
    (await materialsOf(db(), orderId))!, { kind: 'pre_shipment_cancel', cancels: [{ orderItemId, quantity }] });
  /** public.begin_order_refund with the 14 arguments (the last one is the unit pricing plan). */
  const beginRefund = async (f: { orderId: string; actor: string }, o: {
    source?: 'admin' | 'order_cancel'; lines?: unknown[]; amount?: number | null; shipping?: number | null; key?: string; pricing?: unknown; cancelReason?: string | null }) =>
    (await q(`select * from public.begin_order_refund($1,$2,$3,$4::jsonb,false,$5,$6,null,'requested_by_customer',$7,false,$8,null,$9::jsonb)`,
      [f.orderId, o.source ?? 'admin', o.key ?? randomUUID(), JSON.stringify(o.lines ?? []), o.shipping === undefined ? 0 : o.shipping,
        o.amount === undefined ? null : o.amount, o.cancelReason ?? null, f.actor, o.pricing === undefined || o.pricing === null ? null : JSON.stringify(o.pricing)])).rows[0] as {
      refund_id: string; amount: number; status: string; replayed: boolean; release_refund_ids: string[] };
  const revert = async (refundId: string, actor: string) => (await q('select public.order_unit_revert_cancel($1,$2) as id', [refundId, actor])).rows[0].id as string;

  /** 数量2の交換の品を作って発送する前の土台: 数量1の交換の行を受け取る */
  async function exchangeOne(f: HRefundFixture) {
    const ex = await createUbReturn(db(), f, [{ quantity: 1, exchange: true }]);
    const received = await ubReceive(db(), { returnId: ex.returnId, actorId: f.actor, choice: 'none', units: [unit(ex.lineIds[0])] });
    return { ex, received, exchangeItemId: received.exchange_order_item_ids[0] as string };
  }

  describe('pre-shipment cancel (AC-27)', () => {
    test('FREQ-642-AC-27: 例9 発送前に1着取り消すと枠は returned_shop、標準の額17,000円', async () => {
      const f = await hRefundFixture(db(), false);
      const plan = await cancelPlan(f.orderId, f.itemId, 1);
      expect(plan).toMatchObject({ kind: 'pre_shipment_cancel', standardRefund: 17000, feeAmount: 0 });
      const refund = await beginRefund(f, { lines: [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }], amount: 17000, pricing: plan });
      expect(refund).toMatchObject({ amount: 17000, status: 'awaiting_response', replayed: false, release_refund_ids: [] });
      const slots = await slotsOf(f.orderId);
      const slot = slots.find((s) => s.state === 'returned_shop')!;
      expect(slot).toMatchObject({ state: 'returned_shop', current_price: 17000 });
      expect(slots.filter((s) => s.state === 'kept')).toHaveLength(1);
      const [event] = await eventsOf(f.orderId);
      expect(event).toMatchObject({ kind: 'pre_shipment_cancel', request_key: (await refundRow(refund.refund_id)).request_key, standard_refund: 17000, entitlement: 17000, fee_amount: 0 });
      expect(slot.last_event_id).toBe(event.id);
      // 返金の記録: 出来事に結ばれ（now）、返金の行は取り消しの着の割り振り額、取り押さえは取り消した着だけに付く
      expect((await q('select part from public.order_unit_event_refunds where event_id=$1 and refund_id=$2', [event.id, refund.refund_id])).rows).toEqual([{ part: 'now' }]);
      expect((await q('select before_shipment, quantity, amount from public.order_refund_lines where refund_id=$1', [refund.refund_id])).rows)
        .toEqual([{ before_shipment: true, quantity: 1, amount: 17000 }]);
      const claims = await hClaims(db(), f.itemId);
      expect(claims.filter((u) => u.refund_id === refund.refund_id)).toEqual([{ paid_amount: 17000, refund_id: refund.refund_id, refund_before_shipment: true, return_line_id: null }]);
      // 計画が無い・古い・別の種類は断る
      expect(await failure(() => beginRefund(f, { lines: [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }], amount: 20000 })))
        .toMatchObject({ code: '22023', message: 'UNIT_PRICING_REQUIRED' });
    });

    test('FREQ-642-AC-27: 注文全体の取り消しは全部の枠が returned_shop で払った合計を返す', async () => {
      const f = await hRefundFixture(db(), false);
      const plan = await cancelPlan(f.orderId, f.itemId, 2);
      expect(plan.standardRefund).toBe(37000);
      const refund = await beginRefund(f, { source: 'order_cancel', amount: null, shipping: null, cancelReason: 'customer_request', pricing: plan });
      const states = (await slotsOf(f.orderId)).map((s) => s.state);
      expect(states).toEqual(['returned_shop', 'returned_shop']);
      expect(refund.amount).toBe(37000);
      const [event] = await eventsOf(f.orderId);
      expect(event).toMatchObject({ kind: 'pre_shipment_cancel', standard_refund: 37000, entitlement: 37000 });
      expect((await hClaims(db(), f.itemId)).map((u) => u.refund_id)).toEqual([refund.refund_id, refund.refund_id]);
    });

    test('FREQ-642-AC-27: 取り消しの計画が要る・要らない・食い違う場合の断り方と、同じ二重防止の番号の再送', async () => {
      const f = await hRefundFixture(db(), false);
      const plan = await cancelPlan(f.orderId, f.itemId, 1);
      const lines = [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }];
      const key = randomUUID();
      // 数量が計画と食い違う
      expect(await failure(() => beginRefund(f, { lines: [{ ...lines[0], quantity: 2 }], amount: 17000, pricing: plan })))
        .toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID' });
      // 計画の種類が違う
      expect(await failure(() => beginRefund(f, { lines, amount: 17000, pricing: { ...plan, kind: 'return_receive' } })))
        .toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID' });
      const first = await beginRefund(f, { lines, amount: 17000, key, pricing: plan });
      // 再送は版を確かめる前に前と同じ結果を返し、出来事を増やさない（着の状態が変わっていても）
      const again = await beginRefund(f, { lines, amount: 17000, key, pricing: plan });
      expect(again).toMatchObject({ refund_id: first.refund_id, amount: 17000, replayed: true });
      expect(await eventsOf(f.orderId)).toHaveLength(1);
      // 古い計画は 40001 で何も書かない
      await q("select * from public.record_order_refund_result($1,'re_stale1','pending',null,null,null,'card',null,null)", [first.refund_id]);
      expect(await failure(() => beginRefund(f, { lines, amount: 20000, pricing: plan }))).toMatchObject({ code: '40001', message: 'UNIT_PRICING_STALE' });
      expect(await eventsOf(f.orderId)).toHaveLength(1);
    });

    test('FREQ-642-AC-27: まだ発送していない交換の品の取り消しは元の枠を returned_shop にし、交換の結びを残す (Q10)', async () => {
      const f = await hRefundFixture(db(), true);
      const x = await exchangeOne(f);
      const plan = await cancelPlan(f.orderId, x.exchangeItemId, 1);
      expect(plan.standardRefund).toBe(17000);
      expect(plan.lines.find((l) => l.lineKind === 'returned')).toMatchObject({ shipped: true, holderOrderItemId: x.exchangeItemId });
      const refund = await beginRefund(f, { lines: [{ order_item_id: x.exchangeItemId, before_shipment: true, quantity: 1 }], amount: plan.standardRefund, pricing: plan });
      expect(refund.amount).toBe(17000);
      const slots = await slotsOf(f.orderId);
      expect(slots.map((s) => s.state).sort()).toEqual(['kept', 'returned_shop']);
      expect(slots.find((s) => s.state === 'returned_shop')).toMatchObject({ current_price: 17000, holder_order_item_id: x.exchangeItemId });
      expect((await q('select count(*)::int n from public.order_unit_exchange_links l where l.exchange_order_item_id=$1', [x.exchangeItemId])).rows[0].n).toBe(1);
      expect((await q('select before_shipment, amount from public.order_refund_lines where refund_id=$1', [refund.refund_id])).rows)
        .toEqual([{ before_shipment: true, amount: 17000 }]);
    });
  });

  describe('post-shipment refund without a return (AC-28, AC-15)', () => {
    test('FREQ-642-AC-28: 発送後の品を返品なしで選ぶ返金は枠と E を変えず、取り押さえも付けない', async () => {
      const f = await hRefundFixture(db(), true);
      const slotsBefore = await slotsOf(f.orderId);
      const eventsBefore = await eventsOf(f.orderId);
      const refund = await beginRefund(f, { lines: [{ order_item_id: f.itemId, before_shipment: false, quantity: 1 }], amount: 5000 });
      expect(refund).toMatchObject({ amount: 5000, status: 'awaiting_response', release_refund_ids: [] });
      expect(await slotsOf(f.orderId)).toEqual(slotsBefore);
      expect(await eventsOf(f.orderId)).toHaveLength(eventsBefore.length);
      expect((await hClaims(db(), f.itemId)).every((u) => u.refund_id === null)).toBe(true);
      // 計画を付けると断る（計画は発送前の行・取り消しだけ）
      expect(await failure(() => beginRefund(f, { lines: [{ order_item_id: f.itemId, before_shipment: false, quantity: 1 }], amount: 5000,
        pricing: { orderId: f.orderId, kind: 'pre_shipment_cancel', lines: [], holds: [], version: 'x' } }))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID' });
    });

    test('FREQ-642-AC-28: エラーの後の遅い成功でも、返品なしの発送後の返金は着を取らず支払いの例外も作らない', async () => {
      const f = await hRefundFixture(db(), true);
      const refund = await beginRefund(f, { lines: [{ order_item_id: f.itemId, before_shipment: false, quantity: 1 }], amount: 17000 });
      await q("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [refund.refund_id]);
      await hResult(db(), refund.refund_id, 'succeeded');
      expect((await hClaims(db(), f.itemId)).every((u) => u.refund_id === null)).toBe(true);
      expect(Number((await q("select count(*) n from public.payment_exceptions where reason='refund_failed' and payment_ref=$1", [refund.refund_id])).rows[0].n)).toBe(0);
      expect(await eventsOf(f.orderId)).toHaveLength(0);
    });

    test('FREQ-642-AC-15: お詫びの返金の後の返品は、注文の返せる額で止まる', async () => {
      const f = await hRefundFixture(db(), true);
      const apology = await beginRefund(f, { lines: [], amount: 25000 });
      await hResult(db(), apology.refund_id, 'succeeded');
      const refundableBefore = 37000 - 25000;
      const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
      const [event] = await eventsOf(f.orderId);
      expect(event).toMatchObject({ standard_refund: 17000, entitlement: 17000 });
      expect(received.refund_amount).toBe(refundableBefore);
      expect(await refundedTotal(f.orderId) + 0).toBeLessThanOrEqual(37000);
    });
  });

  describe('consult refund (carry 4)', () => {
    test('FREQ-642-AC-07: 相談の返金は相談の分だけで、今すぐの分を店長が下げても相談の残りに戻らない', async () => {
      const f = await hRefundFixture(db(), true);
      const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'mixed', amount: 5000,
        units: [unit(ret.lineIds[0], 1, 'now'), unit(ret.lineIds[1], 1, 'consult')] });
      expect(received.refund_amount).toBe(5000);
      const [event] = await eventsOf(f.orderId);
      expect(event).toMatchObject({ now_refund: 17000, consult_refund: 20000, standard_refund: 37000, return_id: ret.returnId });
      expect(await screenBasis(ret.returnId)).toBe(20000);
      await hResult(db(), received.refund_id, 'succeeded');
      const consult = (await q('select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [ret.returnId, f.actor, randomUUID()])).rows[0];
      expect(consult).toMatchObject({ amount: 20000, status: 'awaiting_response', replayed: false, release_refund_ids: [] });
      expect((await q('select part from public.order_unit_event_refunds where event_id=$1 and refund_id=$2', [event.id, consult.refund_id])).rows).toEqual([{ part: 'consult' }]);
      expect((await q('select part from public.order_unit_event_refunds where event_id=$1 and refund_id=$2', [event.id, received.refund_id])).rows).toEqual([{ part: 'now' }]);
      // 相談の返金は相談の着だけを握る（今すぐの着は今すぐの返金が握ったまま）
      const claims = await hClaims(db(), f.itemId);
      expect(claims.map((u) => u.refund_id).sort()).toEqual([consult.refund_id, received.refund_id].sort());
      expect(await screenBasis(ret.returnId)).toBe(0);
      expect((await q('select amount from public.order_refund_lines where refund_id=$1', [consult.refund_id])).rows).toEqual([{ amount: 20000 }]);
    });

    /** 画面の見込み(loadConsultOutstanding)と同じ基準: 失敗以外の相談の返金が付いていない返品の受け取りの出来事の consult_refund の和 */
    const screenBasis = async (returnId: string) => Number((await q(`select coalesce(sum(e.consult_refund),0) n from public.order_unit_events e
      where e.return_id=$1 and e.kind='return_receive' and e.consult_refund>0 and not exists (
        select 1 from public.order_unit_event_refunds er join public.order_refunds rf on rf.id=er.refund_id
        where er.event_id=e.id and er.part='consult' and rf.status<>'failed')`, [returnId])).rows[0].n);
    /** 1つ目の相談の返金を (出来事E1の相談の分 + delta) に変えて出し、2つ目の相談の受け取りの後に、額を省いて(店長が見込みのまま)返金する。3着の注文なので、上げても注文の返せる額が残る */
    async function consultTwice(delta: number) {
      const f = await hRefundFixture(db(), true, 3);
      const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
      await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[0])] });
      const [e1] = await eventsOf(f.orderId);
      const firstAmount = e1.consult_refund + delta;
      const first = (await q('select * from public.admin_refund_return($1,$2,$3,$4,0,null,false)', [ret.returnId, f.actor, randomUUID(), firstAmount])).rows[0];
      expect(first.amount).toBe(firstAmount);
      await hResult(db(), first.refund_id, 'succeeded');
      await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[1])] });
      const events = await eventsOf(f.orderId);
      expect(events).toHaveLength(2);
      const screen = await screenBasis(ret.returnId);
      const second = (await q('select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [ret.returnId, f.actor, randomUUID()])).rows[0];
      return { f, ret, screen, second, e2: events[1].consult_refund as number };
    }

    test('FREQ-642-AC-07: R34 1つ目の相談の返金を下げた後の2つ目の相談の返金は、画面の見込み(2つ目の出来事の分)と同じ額', async () => {
      const r = await consultTwice(-11000);
      expect(r.screen).toBe(r.e2);
      expect(r.second.amount).toBe(r.screen);
    });

    test('FREQ-642-AC-07: R34 1つ目の相談の返金を上げた後の2つ目の相談の返金も、画面の見込みと同じ額', async () => {
      const r = await consultTwice(1000);
      expect(r.screen).toBe(r.e2);
      expect(r.second.amount).toBe(r.screen);
    });

  });

  describe('shipped slots after a partial pre-shipment cancel (R33)', () => {
    /** 同じ値段(20,000円)の2着の注文。割引なし、写しあり、払い済み。取り消しは同値の時いちばん若い枠(0)を選ぶ。 */
    async function equalOrder() {
      const catalog = await createCatalogFixture(db(), { stock: 2 });
      const userId = await seedHMember(db());
      const seeded = await seedHOrderUnits(db(), { legacy: false, buyerUserId: userId, createdAt: '2026-11-01T00:00:00Z',
        lines: [{ itemPrice: 20000, quantity: 2, catalog: catalog as HCatalog, unitAmounts: [20000, 20000], discounts: [] }] });
      const itemId = seeded.orderItemIds[0];
      const built = buildOrder({ orderId: seeded.orderId, lines: [{ orderItemId: itemId, itemId: catalog.itemId, unitPrice: 20000, quantity: 2 }] });
      const facts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([k]) => k !== 'phase'));
      facts.buyer = { kind: 'member', userId };
      await seedHUnitSlots(db(), { orderId: seeded.orderId, snapshot: { engineVersion: 1, definitions: built.snapshot.definitions, codes: built.snapshot.codes, facts, lines: built.snapshot.lines } });
      await q('update public.orders set paid_amount=total_amount, payment_intent_id=$2 where id=$1', [seeded.orderId, `pi_ubf_${randomUUID().replaceAll('-', '')}`]);
      return { orderId: seeded.orderId, itemId, actor: userId, catalog, itemNumber: catalog.itemId };
    }
    /** 1着を発送前に取り消し(枠0が returned_shop)、残りの1着を発送して発送票を確定する */
    async function cancelOneThenShip() {
      const o = await equalOrder();
      const refund = await beginRefund(o, { lines: [{ order_item_id: o.itemId, before_shipment: true, quantity: 1 }], amount: 20000, pricing: await cancelPlan(o.orderId, o.itemId, 1) });
      await hResult(db(), refund.refund_id, 'succeeded');
      expect((await slotsOf(o.orderId)).map((s) => [s.state, s.current_price])).toEqual([['returned_shop', 20000], ['kept', 20000]]);
      const fulfillment = await shipFixtureOrder(db(), { orderId: o.orderId, actorId: o.actor, trackingNumber: 'UBF-R33', lines: [{ order_item_id: o.itemId, quantity: 1 }] });
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      return { ...o, fulfillment };
    }
    const shippedSlots = async (itemId: string) => (await q('select unit_index from private.order_unit_shipped_slots($1) order by unit_index', [itemId])).rows;

    test.each([{ claimed: [0] }, { claimed: [0, 1] }])('FREQ-642-AC-34: 部分の発送前返金を残す着 $claimed も発送したら、発送枠を必ず2着返す', async ({ claimed }) => {
      const o = await equalOrder();
      // 取り消しではない部分返金が残る状態を作る。枠の状態は kept のまま。
      const refundId = (await q(`insert into public.order_refunds(order_id,source,stripe_refund_id,status,amount,notify_customer)
        values($1,'stripe_dashboard',$2,'succeeded',5000,false) returning id`, [o.orderId, `re_${randomUUID().replaceAll('-', '')}`])).rows[0].id;
      await q('select private.group_h_claim_refund_units($1,$2,$3::integer[],true,null)', [refundId, o.itemId, claimed]);
      expect((await slotsOf(o.orderId)).map((s) => s.state)).toEqual(['kept', 'kept']);
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 2 });
      expect((await q('select count(*)::int n from private.accounting_shipped_units($1,NULL)', [o.itemId])).rows[0].n).toBe(2);
      expect(await shippedSlots(o.itemId)).toEqual([{ unit_index: 0 }, { unit_index: 1 }]);
    });

    test('FREQ-642-AC-34: 発送数が1なら返金額に依らず取り押さえの無い枠1を先に選ぶ', async () => {
      const o = await equalOrder();
      const refundId = (await q(`insert into public.order_refunds(order_id,source,stripe_refund_id,status,amount,notify_customer)
        values($1,'stripe_dashboard',$2,'pending',1,false) returning id`, [o.orderId, `re_${randomUUID().replaceAll('-', '')}`])).rows[0].id;
      await q('select private.group_h_claim_refund_units($1,$2,array[0],true,null)', [refundId, o.itemId]);
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await shippedSlots(o.itemId)).toEqual([{ unit_index: 1 }]);
    });

    test('FREQ-642-AC-34: 枠0が5,000円・枠1が1円の取り押さえでも、発送数1なら枠0を選ぶ', async () => {
      const o = await equalOrder();
      for (const [unitIndex, amount] of [[0, 5000], [1, 1]]) {
        const refundId = (await q(`insert into public.order_refunds(order_id,source,stripe_refund_id,status,amount,notify_customer)
          values($1,'stripe_dashboard',$2,'succeeded',$3,false) returning id`, [o.orderId, `re_${randomUUID().replaceAll('-', '')}`, amount])).rows[0].id;
        await q('select private.group_h_claim_refund_units($1,$2,array[$3::integer],true,null)', [refundId, o.itemId, unitIndex]);
      }
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await shippedSlots(o.itemId)).toEqual([{ unit_index: 0 }]);
    });

    test('FREQ-642-AC-27: R33 同じ値段の2着の1着を発送前に取り消し、残りを発送したら、残りの1着を返金で受け取れる', async () => {
      const o = await cancelOneThenShip();
      const ret = await createUbReturn(db(), o, [{ quantity: 1 }]);
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: o.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
      expect(received.refund_amount).toBe(20000);
      const slots = await q('select unit_index, state from public.order_unit_slots where order_id=$1 order by unit_index', [o.orderId]);
      expect(slots.rows).toEqual([{ unit_index: 0, state: 'returned_shop' }, { unit_index: 1, state: 'returned_customer' }]);
      expect(await refundedTotal(o.orderId)).toBe(40000);
      expect(await shippedSlots(o.itemId)).toEqual([{ unit_index: 1 }]);
    });

    test('FREQ-642-AC-27: R33 取り消しの返金が失敗したら、その着は発送の数え方に戻る', async () => {
      const o = await equalOrder();
      const refund = await beginRefund(o, { lines: [{ order_item_id: o.itemId, before_shipment: true, quantity: 1 }], amount: 20000, pricing: await cancelPlan(o.orderId, o.itemId, 1) });
      await shipFixtureOrder(db(), { orderId: o.orderId, actorId: o.actor, trackingNumber: 'UBF-R33B', lines: [{ order_item_id: o.itemId, quantity: 1 }] });
      await seedFactSlip(db(), { orderItemId: o.itemId, quantity: 1 });
      expect(await shippedSlots(o.itemId)).toEqual([{ unit_index: 1 }]);
      await hResult(db(), refund.refund_id, 'failed');
      expect(await shippedSlots(o.itemId)).toEqual([{ unit_index: 0 }]);
    });

    test('FREQ-642-AC-20: R33 取り消しに全額返金された注文でも、発送済みで残した着は前の注文の数に入る', async () => {
      const o = await cancelOneThenShip();
      await q("update public.orders set status='cancelled' where id=$1", [o.orderId]);
      const context = (await q("select private.get_checkout_discount_context($1,null,array[]::text[],$2::bigint[],now(),'confirm') as c", [o.actor, [o.itemNumber]])).rows[0].c;
      expect(JSON.stringify(context)).toContain(`"priorUnitsByItem":{"${o.itemNumber}":1}`);
    });
  });

  describe('amounts of closed events (AC-23, AC-19)', () => {
    test('FREQ-642-AC-23: 例2の返品を15,000円に下げても、交換の品の返品は20,000円', async () => {
      const f = await hRefundFixture(db(), true);
      const x = await exchangeOne(f);
      const rest = await createUbReturn(db(), f, [{ quantity: 1 }]);
      const first = await ubReceive(db(), { returnId: rest.returnId, actorId: f.actor, choice: 'now', amount: 15000, units: [unit(rest.lineIds[0])] });
      expect(first.refund_amount).toBe(15000);
      await hResult(db(), first.refund_id, 'succeeded');
      const shipment = await shipFixtureOrder(db(), { orderId: f.orderId, actorId: f.actor, trackingNumber: 'UBF-23', lines: [{ order_item_id: x.exchangeItemId, quantity: 1 }] });
      const back = await createUbReturn(db(), { ...f, fulfillment: { fulfillment_id: shipment.fulfillment_id } }, [{ quantity: 1, itemId: x.exchangeItemId }]);
      const later = await ubReceive(db(), { returnId: back.returnId, actorId: f.actor, choice: 'now', units: [unit(back.lineIds[0])] });
      expect(later.refund_amount).toBe(20000);
      const events = await eventsOf(f.orderId);
      expect(events.map((e) => [e.standard_refund, e.entitlement])).toEqual([[17000, 17000], [20000, 37000]]);
      expect(await refundedTotal(f.orderId)).toBe(35000);
    });

    test('FREQ-642-AC-19: 確定した出来事の額は後の出来事で書き換わらず、書き換えようとしても断られる', async () => {
      const f = await hRefundFixture(db(), true);
      const a = await createUbReturn(db(), f, [{ quantity: 1 }]);
      const first = await ubReceive(db(), { returnId: a.returnId, actorId: f.actor, choice: 'now', units: [unit(a.lineIds[0])] });
      const [firstEventBefore] = await eventsOf(f.orderId);
      const linesBefore = await linesOfEvent(firstEventBefore.id);
      await hResult(db(), first.refund_id, 'succeeded');
      const b = await createUbReturn(db(), f, [{ quantity: 1 }]);
      await ubReceive(db(), { returnId: b.returnId, actorId: f.actor, choice: 'now', units: [unit(b.lineIds[0])] });
      const events = await eventsOf(f.orderId);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(firstEventBefore);
      expect(await linesOfEvent(firstEventBefore.id)).toEqual(linesBefore);
      expect(await failure(() => q('update public.order_unit_events set standard_refund=1 where id=$1', [firstEventBefore.id]))).toMatchObject({ message: 'GROUP_H_IMMUTABLE' });
      expect(await failure(() => q('update public.order_unit_event_lines set allocation=1 where event_id=$1', [firstEventBefore.id]))).toMatchObject({ message: 'GROUP_H_IMMUTABLE' });
    });
  });

  describe('revert of a cancel the shop stopped (5-2 Q7)', () => {
    test('FREQ-642-AC-27: 5-2 Q7: 店が返金をやめた発送前の取り消しは枠を kept へ戻し、後の出来事があれば断る', async () => {
      const f = await hRefundFixture(db(), false);
      const lines = [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }];
      const plan = await cancelPlan(f.orderId, f.itemId, 1);
      const refund = await beginRefund(f, { lines, amount: 17000, pricing: plan });
      // まだ失敗していない返金のために戻すことはできない
      expect(await failure(() => revert(refund.refund_id, f.actor))).toMatchObject({ code: '22023', message: 'UNIT_CANCEL_REVERT_REFUSED' });
      await hResult(db(), refund.refund_id, 'failed');
      // 失敗しても、着の状態と割り振りは動かない（戻すのは店の決定だけ）
      expect((await slotsOf(f.orderId)).filter((s) => s.state === 'returned_shop')).toHaveLength(1);
      const [cancelEvent] = await eventsOf(f.orderId);
      const revertId = await revert(refund.refund_id, f.actor);
      const slots = await slotsOf(f.orderId);
      expect(slots.map((s) => [s.state, s.current_price])).toEqual([['kept', 17000], ['kept', 20000]]);
      const events = await eventsOf(f.orderId);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ id: revertId, kind: 'cancel_reverted', reverts_event_id: cancelEvent.id, entitlement: 0, standard_refund: 0,
        now_refund: 0, consult_refund: 0, fee_amount: 0, hold_total: 0, entitlement_previous: 17000 });
      const reverted = (await linesOfEvent(revertId)).filter((l) => l.line_kind === 'returned');
      expect(reverted).toHaveLength(1);
      expect(reverted[0]).toMatchObject({ state_before: 'returned_shop', state_after: 'kept', price_before: 17000, price_after: 17000, allocation: -17000, correction: 0 });
      // 同じ返金でもう一度呼んでも、同じ出来事を返す
      expect(await revert(refund.refund_id, f.actor)).toBe(revertId);
      // 材料は取り消した出来事を除き、E は 0 に戻っている。同じ着をまた取り消せる
      const materials = (await materialsOf(db(), f.orderId))!;
      expect(materials.target).toMatchObject({ entitlementPrevious: 0, entitlementMax: 0, feeTotal: 0 });
      expect(materials.target.slots.every((s) => s.allocatedAmount === 0 && s.state === 'kept')).toBe(true);
      const again = await beginRefund(f, { lines, amount: 17000, pricing: await cancelPlan(f.orderId, f.itemId, 1) });
      expect(again.amount).toBe(17000);
    });

    test('FREQ-642-AC-27: 5-2 Q7: その出来事の後に同じ注文の出来事があるか、取り消しでない返金なら断る', async () => {
      const f = await hRefundFixture(db(), false);
      const one = [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }];
      const r1 = await beginRefund(f, { lines: one, amount: 17000, pricing: await cancelPlan(f.orderId, f.itemId, 1) });
      await hResult(db(), r1.refund_id, 'pending');
      const r2 = await beginRefund(f, { lines: one, amount: 20000, pricing: await cancelPlan(f.orderId, f.itemId, 1) });
      await hResult(db(), r1.refund_id, 'failed');
      // r1 の取り消しの後に r2 の取り消しがあるので、r1 は戻せない
      expect(await failure(() => revert(r1.refund_id, f.actor))).toMatchObject({ code: '22023', message: 'UNIT_CANCEL_REVERT_REFUSED' });
      expect((await slotsOf(f.orderId)).map((s) => s.state)).toEqual(['returned_shop', 'returned_shop']);
      // 知らない返金・出来事に結ばれていない返金も断る
      expect(await failure(() => revert(randomUUID(), f.actor))).toMatchObject({ message: 'UNIT_CANCEL_REVERT_REFUSED' });
      const g = await hRefundFixture(db(), true);
      const plain = await beginRefund(g, { lines: [], amount: 1000 });
      await hResult(db(), plain.refund_id, 'failed');
      expect(await failure(() => revert(plain.refund_id, g.actor))).toMatchObject({ message: 'UNIT_CANCEL_REVERT_REFUSED' });
      // 最後の取り消しなら戻せる
      await hResult(db(), r2.refund_id, 'failed');
      await revert(r2.refund_id, f.actor);
      expect((await slotsOf(f.orderId)).map((s) => s.state).sort()).toEqual(['kept', 'returned_shop']);
    });

    test('FREQ-642-AC-27: 戻しは枠の状態を直に書き換えるだけでは通らず、返した枠の最後の出来事は固定される', async () => {
      const f = await hRefundFixture(db(), false);
      const lines = [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }];
      const r1 = await beginRefund(f, { lines, amount: 17000, pricing: await cancelPlan(f.orderId, f.itemId, 1) });
      await hResult(db(), r1.refund_id, 'pending');
      await beginRefund(f, { lines, amount: 20000, pricing: await cancelPlan(f.orderId, f.itemId, 1) });
      const [first, second] = await eventsOf(f.orderId);
      const slot = (await slotsOf(f.orderId)).find((s) => s.last_event_id === first.id)!;
      expect(await failure(() => q('update public.order_unit_slots set last_event_id=$3 where order_item_id=$1 and unit_index=$2',
        [slot.order_item_id, slot.unit_index, second.id]))).toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
      expect(await failure(() => q("update public.order_unit_slots set state='kept' where order_item_id=$1 and unit_index=$2", [slot.order_item_id, slot.unit_index])))
        .toMatchObject({ message: 'UNIT_SLOT_IMMUTABLE' });
    });

    test('FREQ-642-AC-27: 取り消しの出来事に holds が付いていたら戻さない（取り消しは holds を持たない前提を確かめる）', async () => {
      const f = await hRefundFixture(db(), false);
      const lines = [{ order_item_id: f.itemId, before_shipment: true, quantity: 1 }];
      const refund = await beginRefund(f, { lines, amount: 17000, pricing: await cancelPlan(f.orderId, f.itemId, 1) });
      await hResult(db(), refund.refund_id, 'failed');
      const [event] = await eventsOf(f.orderId);
      await q('insert into public.order_unit_holds(event_id,held_order_id,later_order_id,item_id,amount) values($1,$2,$2,1,1000)', [event.id, f.orderId]);
      expect(await failure(() => revert(refund.refund_id, f.actor))).toMatchObject({ code: '22023', message: 'UNIT_CANCEL_REVERT_REFUSED', detail: 'ubrr_holds' });
    });
  });

  describe('refund of held money back to a prior order (AC-10)', () => {
    const repeatPrevious = (itemId: number) => amount('repeatprev', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [itemId], repeatPrevious: true });

    /** 同じ会員の、前の注文(20,000円)と後の注文(前の注文があるので 17,000円)。どちらも払い済み・発送済み。 */
    async function twoOrders() {
      const catalog = await createCatalogFixture(db(), { stock: 4 });
      const userId = await seedHMember(db());
      const definition = repeatPrevious(catalog.itemId);
      const discountId = await seedHDiscount(db(), hDiscount());
      const make = async (createdAt: string, prior: boolean) => {
        const priorUnits = prior ? { [String(catalog.itemId)]: 1 } : {};
        const priced = buildOrder({ orderId: 'pre', lines: [{ orderItemId: 'oi-0', itemId: catalog.itemId, unitPrice: 20000, quantity: 1 }], definitions: [definition], priorUnitsByItem: priorUnits });
        const paid = priced.slots[0].paidAmount;
        const seeded = await seedHOrderUnits(db(), { legacy: false, buyerUserId: userId, createdAt, lines: [{ itemPrice: 20000, quantity: 1, catalog: catalog as HCatalog,
          unitAmounts: [paid], discounts: 20000 - paid > 0 ? [{ discountId, amount: 20000 - paid }] : [] }] });
        const built = buildOrder({ orderId: seeded.orderId, lines: [{ orderItemId: seeded.orderItemIds[0], itemId: catalog.itemId, unitPrice: 20000, quantity: 1 }],
          definitions: [definition], priorUnitsByItem: priorUnits });
        const facts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([k]) => k !== 'phase'));
        facts.buyer = { kind: 'member', userId };
        await seedHUnitSlots(db(), { orderId: seeded.orderId, snapshot: { engineVersion: 1, definitions: built.snapshot.definitions, codes: built.snapshot.codes, facts, lines: built.snapshot.lines } });
        await q("update public.orders set paid_amount=total_amount, payment_intent_id=$2 where id=$1", [seeded.orderId, `pi_ubf_${randomUUID().replaceAll('-', '')}`]);
        const itemId = seeded.orderItemIds[0];
        const fulfillment = await shipFixtureOrder(db(), { orderId: seeded.orderId, actorId: userId, trackingNumber: prior ? 'UBF-2' : 'UBF-1', lines: [{ order_item_id: itemId, quantity: 1 }] });
        await seedFactSlip(db(), { orderItemId: itemId, quantity: 1 });
        return { orderId: seeded.orderId, itemId, actor: userId, catalog, fulfillment, paid };
      };
      const first = await make('2026-11-01T00:00:00Z', false);
      const second = await make('2026-11-02T00:00:00Z', true);
      return { first, second, userId };
    }
    async function returnFirst(o: Awaited<ReturnType<typeof twoOrders>>) {
      const ret = await createUbReturn(db(), o.first, [{ quantity: 1 }]);
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: o.userId, choice: 'now', units: [unit(ret.lineIds[0])] });
      await hResult(db(), received.refund_id, 'succeeded');
      return received;
    }

    test('FREQ-642-AC-10: 例10-2 後の注文の受け取りで、前の注文に3,000円の返金ができる', async () => {
      const o = await twoOrders();
      expect(o.second.paid).toBe(17000);
      const firstReceive = await returnFirst(o);
      expect(firstReceive.refund_amount).toBe(17000);
      expect(firstReceive.release_refund_ids).toEqual([]);
      const ret = await createUbReturn(db(), o.second, [{ quantity: 1 }]);
      const input = { returnId: ret.returnId, actorId: o.userId, choice: 'now', units: [unit(ret.lineIds[0])], key: randomUUID() };
      const plan = await buildReceivePricing(db(), input);
      const result = await ubReceive(db(), input, plan);
      expect(result.refund_amount).toBe(17000);
      expect(result.release_refund_ids).toHaveLength(1);
      const releaseRefund = await refundRow(result.release_refund_ids[0]);
      expect(releaseRefund).toMatchObject({ order_id: o.first.orderId, source: 'unit_hold_release', amount: 3000, return_id: null, status: 'awaiting_response', notify_customer: false });
      const order1Refunded = await refundedTotal(o.first.orderId);
      expect(order1Refunded).toBeLessThanOrEqual(20000);
      expect(order1Refunded + (await refundedTotal(o.second.orderId))).toBe(37000);
      // 前の注文に hold_release の出来事ができ、返金は release として結ばれ、holds は 0 に戻る
      const events = await eventsOf(o.first.orderId);
      expect(events.map((e) => e.kind)).toEqual(['return_receive', 'hold_release']);
      expect(events[1]).toMatchObject({ standard_refund: 3000, now_refund: 3000, entitlement: 20000, hold_total: 0 });
      expect((await q('select part from public.order_unit_event_refunds where event_id=$1 and refund_id=$2', [events[1].id, releaseRefund.id])).rows).toEqual([{ part: 'release' }]);
      expect((await materialsOf(db(), o.first.orderId))!.target.holds.reduce((s, h) => s + h.amount, 0)).toBe(0);
      // 同じ二重防止の番号の再送は、同じ返金の番号を返し、返金も出来事も増やさない
      const replay = await ubReceive(db(), input, plan);
      expect(replay).toMatchObject({ replayed: true, refund_id: result.refund_id });
      expect(replay.release_refund_ids).toEqual(result.release_refund_ids);
      expect(await eventsOf(o.first.orderId)).toHaveLength(2);
    });

    test('FREQ-642-AC-10: 前の注文への戻しの計画の版や状態が古ければ 40001 で何も書かない', async () => {
      const o = await twoOrders();
      await returnFirst(o);
      const ret = await createUbReturn(db(), o.second, [{ quantity: 1 }]);
      const base = { returnId: ret.returnId, actorId: o.userId, choice: 'now', units: [unit(ret.lineIds[0])] };
      const plan = (await buildReceivePricing(db(), base)) as UnitPricingPlan;
      expect(plan.releases).toHaveLength(1);
      const before = async () => [await refundedTotal(o.first.orderId), (await eventsOf(o.first.orderId)).length, (await eventsOf(o.second.orderId)).length];
      const snapshot = await before();
      const wrongVersion = structuredClone(plan);
      wrongVersion.releases[0].version = 'x:y';
      expect(await failure(() => ubReceive(db(), { ...base, key: randomUUID() }, wrongVersion))).toMatchObject({ code: '40001', message: 'UNIT_PRICING_STALE' });
      const wrongState = structuredClone(plan);
      wrongState.releases[0].entitlementPrevious += 1;
      expect(await failure(() => ubReceive(db(), { ...base, key: randomUUID() }, wrongState))).toMatchObject({ code: '40001', message: 'UNIT_PRICING_STALE' });
      const strangeOrder = structuredClone(plan);
      strangeOrder.releases[0].orderId = randomUUID();
      expect(await failure(() => ubReceive(db(), { ...base, key: randomUUID() }, strangeOrder))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID' });
      expect(await before()).toEqual(snapshot);
    });

    test('FREQ-642-AC-10: 相談の返金の入口も、前の注文の戻しを同じ取引で行い release_refund_ids に返す', async () => {
      const o = await twoOrders();
      await returnFirst(o);
      const ret = await createUbReturn(db(), o.second, [{ quantity: 1 }]);
      const base = { returnId: ret.returnId, actorId: o.userId, choice: 'consult', units: [unit(ret.lineIds[0])] };
      const plan = (await buildReceivePricing(db(), base)) as UnitPricingPlan;
      const releases = plan.releases;
      expect(releases).toHaveLength(1);
      plan.releases = [];
      const received = await ubReceive(db(), base, plan);
      expect(received.refund_id).toBeNull();
      const version = (await materialsOf(db(), o.second.orderId))!.version;
      const pricing = { orderId: o.second.orderId, version, releases: releases.map((r) => ({ ...r, version })) };
      const key = randomUUID();
      const call = () => q('select * from public.admin_refund_return($1,$2,$3,null,0,null,false,$4::jsonb)', [ret.returnId, o.userId, key, JSON.stringify(pricing)]);
      const out = (await call()).rows[0];
      expect(out).toMatchObject({ amount: 17000, replayed: false });
      expect(out.release_refund_ids).toHaveLength(1);
      expect(await refundRow(out.release_refund_ids[0])).toMatchObject({ order_id: o.first.orderId, source: 'unit_hold_release', amount: 3000 });
      const replay = (await call()).rows[0];
      expect(replay).toMatchObject({ refund_id: out.refund_id, replayed: true });
      expect(replay.release_refund_ids).toEqual(out.release_refund_ids);
      // 相談の返金で計画に古い版を付けると 40001
      const stale = { ...pricing, version: 'x:y' };
      expect(await failure(() => q('select * from public.admin_refund_return($1,$2,$3,null,0,null,false,$4::jsonb)', [ret.returnId, o.userId, randomUUID(), JSON.stringify(stale)])))
        .toMatchObject({ code: '40001', message: 'UNIT_PRICING_STALE' });
    });
  });

  describe('the receive goes through the core (R20)', () => {
    test('FREQ-642-AC-05: 受け取りは返金の記録を自分では書かず begin_order_refund_core を通る', async () => {
      const body = (await q("select prosrc from pg_proc where oid='private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)'::regprocedure")).rows[0].prosrc as string;
      expect(body).not.toMatch(/insert\s+into\s+public\.order_refunds/i);
      expect(body).toMatch(/begin_order_refund_core\(/);
      expect(body).toContain('v_event');
      const f = await hRefundFixture(db(), true);
      const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
      const [event] = await eventsOf(f.orderId);
      expect((await refundRow(received.refund_id))).toMatchObject({ source: 'return', amount: 17000, return_id: ret.returnId });
      expect((await q('select part from public.order_unit_event_refunds where event_id=$1', [event.id])).rows).toEqual([{ part: 'now' }]);
    });
  });
});

const ubfAssert = sql.split('-- UBF_FINAL_ASSERT_BEGIN\n')[1]?.split('-- UBF_FINAL_ASSERT_END')[0] ?? '';

describeLocalDb('FREQ-642-AC-27: unit binding migration D final assertion (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = ''): Promise<Failure | null> {
    await db().query('savepoint ubf_assert');
    let failure: Failure | null = null;
    try {
      // 移行 D の始めの書き手の一覧（落とした3本の旧い署名は今は無いので、存在しない OID で代える）を、末尾の確かめの前に立てる
      await db().query(`create temp table ubf_writer_baseline on commit drop as
        select x::oid as oid from unnest(private.group_g_writer_allowlist()) as t(x)
        where x::oid not in (to_regprocedure('private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)')::oid,
          to_regprocedure('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)')::oid,
          to_regprocedure('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)')::oid)
        union all select o::oid from unnest(array[4000000001::bigint, 4000000002, 4000000003]) as u(o)`);
      if (change) await db().query(change);
      await db().query(ubfAssert);
    } catch (caught) { const e = caught as Failure; failure = { code: e.code, message: e.message, detail: e.detail }; }
    finally { await db().query('rollback to savepoint ubf_assert'); await db().query('release savepoint ubf_assert'); }
    return failure;
  }
  const replaceBody = (signature: string, from: string, to: string) => `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from}', '${to}'); end $x$`;
  const CORE = 'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)';

  test('FREQ-642-AC-27: 末尾の確かめは改変なしで通る', async () => {
    expect(ubfAssert).not.toBe('');
    expect(await attempt()).toBeNull();
  });

  test.each([
    ['alter table public.order_refunds drop constraint order_refunds_source_check', 'ubf_schema'],
    ['grant execute on function ' + CORE + ' to service_role', 'ubf_acl'],
    ['revoke execute on function public.order_unit_revert_cancel(uuid,uuid) from service_role', 'ubf_acl'],
    ['grant execute on function private.order_unit_apply_releases(jsonb,text,uuid,uuid,uuid) to authenticated', 'ubf_acl'],
    [replaceBody(CORE, 'ub_refund_lines', 'ub_refund_linex'), 'ubf_functions'],
    [replaceBody('private.order_unit_revert_cancel(uuid,uuid)', 'ubrr_holds', 'ubrr_holdx'), 'ubf_functions'],
    ['create function private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer) returns void language sql as $f$ select 1 $f$', 'ubf_functions'],
    ["create or replace function private.group_g_writer_allowlist() returns pg_catalog.regprocedure[] language sql stable security definer set search_path = '' as $f$ select array[]::pg_catalog.regprocedure[] $f$", 'ubf_functions'],
  ])('FREQ-642-AC-27: 改変 %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'UNIT_BINDING_REFUNDS_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
