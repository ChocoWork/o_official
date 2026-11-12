/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import type { UnitPricingMaterials } from '@/lib/orders/unit-pricing/unit-pricing-types';
import { seedFactSlip } from './helpers/accounting-orders-fixtures';
import { hBegin, hClaims, hRefundFixture, hResult, type HRefundFixture } from './helpers/group-h-refund-fixtures';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { acceptHCheckout, hDiscount, seedHCheckout, seedHDiscount, seedHMember } from './helpers/group-h-fixtures';
import { createCatalogFixture, insertOrderWithLines, insertRestockMovement, shipFixtureOrder } from './helpers/order-fixtures';
import { buildReceivePricing, createUbReturn, materialsOf, ubReceive, type ReceiveUnit } from './helpers/unit-binding-receive';

jest.setTimeout(60000);

const directory = path.join(process.cwd(), 'supabase', 'migrations');
const file = fs.readdirSync(directory).find((name) => name.endsWith('_unit_binding_receive.sql'));
const sql = file ? fs.readFileSync(path.join(directory, file), 'utf8') : '';

describe('FREQ-642-AC-17: unit binding migration C source contract', () => {
  test('FREQ-642-AC-17: 移行Cは単一取引・ASCII・LF・末尾の確かめを持つ', () => {
    expect(file).toBeDefined();
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(sql).toContain('UNIT_BINDING_RECEIVE_MIGRATION_ASSERTION_FAILED');
    for (const detail of ['ubr_functions', 'ubr_acl', 'ubr_allowlist']) expect(sql).toContain(`'${detail}'`);
  });
});

const unit = (lineId: string, quantity = 1, refundChoice?: 'now' | 'consult', disposition = 'not_restocked'): ReceiveUnit =>
  ({ return_line_id: lineId, disposition, quantity, ...(refundChoice ? { refund_choice: refundChoice } : {}) });

describeLocalDb('FREQ-642-AC-17: unit binding receive (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);

  test('FREQ-642-AC-35: 10%を免除した今すぐ返金は17,000円、次の受け取りにも率0で残る', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 2 }], { percent: 10 });
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])], restockingFeeWaived: true };
    const first = await ubReceive(db(), input);
    expect(first.refund_amount).toBe(17000);
    expect((await q('select restocking_fee_waived from public.order_return_receipts where id=$1', [first.receipt_id])).rows[0])
      .toEqual({ restocking_fee_waived: true });
    await hResult(db(), first.refund_id, 'succeeded');
    const materials = (await materialsOf(db(), f.orderId))!;
    expect(materials.target.slots.filter(s => s.state === 'returned_customer').map(s => s.returnedFeePercent)).toEqual([0]);
    const nextInput = { ...input, restockingFeeWaived: false };
    const nextPlan = (await buildReceivePricing(db(), nextInput))!;
    expect(nextPlan).toMatchObject({ feeAmount: 2000, standardRefund: 18000 });
    const second = await ubReceive(db(), nextInput, nextPlan);
    expect(second.refund_amount).toBe(18000);
    expect((await q('select restocking_fee_waived from public.order_return_receipts where id=$1', [second.receipt_id])).rows[0])
      .toEqual({ restocking_fee_waived: false });
  });

  test('FREQ-642-AC-35: 同じ受け取りの今すぐと相談を両方免除し、固定の返送料800円だけ残す', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 2 }], { percent: 10, fixed: 800 });
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'mixed', restockingFeeWaived: true,
      units: [unit(ret.lineIds[0], 1, 'now'), unit(ret.lineIds[0], 1, 'consult')] };
    const received = await ubReceive(db(), input);
    expect(received.refund_amount).toBe(16200);
    expect((await q('select fee_amount,now_refund,consult_refund from public.order_unit_events where receipt_id=$1', [received.receipt_id])).rows[0])
      .toEqual({ fee_amount: 0, now_refund: 17000, consult_refund: 20000 });
    expect((await q('select fee_pending_deduction,fee_due_amount from public.order_returns where id=$1', [ret.returnId])).rows[0])
      .toEqual({ fee_pending_deduction: 0, fee_due_amount: 0 });
    const materials = (await materialsOf(db(), f.orderId))!;
    expect(materials.target.slots.map(s => s.returnedFeePercent)).toEqual([0, 0]);
    expect(planUnitEvent(materials, { kind: 'return_receive', returns: [], excludedSlots: [] }).feeAmount).toBe(0);
    await hResult(db(), received.refund_id, 'succeeded');
    const refundMaterials = (await materialsOf(db(), f.orderId))!;
    const refundPlan = planUnitEvent(refundMaterials, { kind: 'return_receive', returns: [], excludedSlots: [] });
    const pricing = { orderId: f.orderId, version: refundPlan.version, releases: refundPlan.releases };
    const consult = (await q('select * from public.admin_refund_return($1,$2,$3,NULL,0,NULL,false,$4::jsonb)',
      [ret.returnId, f.actor, randomUUID(), JSON.stringify(pricing)])).rows[0];
    expect(consult.amount).toBe(20000);
  });

  test.each(['now', 'consult'])('FREQ-642-AC-35: 返金の権限なしは免除をDBでも拒否（%s）', async (choice) => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }], { percent: 10 });
    const input = { returnId: ret.returnId, actorId: f.actor, can: false, choice, restockingFeeWaived: true, units: [unit(ret.lineIds[0])] };
    expect(await failure(() => ubReceive(db(), input))).toMatchObject({ code: '22023', message: 'RETURN_FORBIDDEN' });
    expect((await q('select count(*)::int n from public.order_return_receipts where return_id=$1', [ret.returnId])).rows[0].n).toBe(0);
  });

  test.each([false, true])('FREQ-642-AC-35: 同じ免除の再送は同じ結果、免除を変えた再送は拒否（%s）', async (restockingFeeWaived) => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }], { percent: 10 });
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', key: randomUUID(), units: [unit(ret.lineIds[0])], restockingFeeWaived };
    const plan = (await buildReceivePricing(db(), input))!;
    const first = await ubReceive(db(), input, plan);
    const replay = await ubReceive(db(), input, plan);
    expect(replay).toMatchObject({ receipt_id: first.receipt_id, refund_id: first.refund_id, refund_amount: first.refund_amount, replayed: true });
    if (!restockingFeeWaived) {
      const omitted = { ...input, restockingFeeWaived: undefined };
      expect((await ubReceive(db(), omitted, plan)).replayed).toBe(true);
    }
    expect(await failure(() => ubReceive(db(), { ...input, restockingFeeWaived: !restockingFeeWaived }, plan)))
      .toMatchObject({ code: '22023', message: 'RETURN_REQUEST_MISMATCH' });
  });

  test('FREQ-642-AC-35: 写しの無い注文も10%を今すぐと相談で免除する', async () => {
    const f = await legacyFixture(db(), 2, 10);
    expect((await q('select restocking_fee_percent from public.order_returns where id=$1', [f.returnId])).rows[0].restocking_fee_percent).toBe(10);
    const input = { returnId: f.returnId, actorId: f.actor, choice: 'mixed', restockingFeeWaived: true,
      units: [unit(f.lineIds[0], 1, 'now'), unit(f.lineIds[0], 1, 'consult')] };
    const received = await ubReceive(db(), input);
    expect(received.refund_amount).toBe(17000);
    expect((await q('select restocking_fee_waived from public.order_return_receipts where id=$1', [received.receipt_id])).rows[0])
      .toEqual({ restocking_fee_waived: true });
    expect((await q('select fee_pending_deduction,fee_due_amount from public.order_returns where id=$1', [f.returnId])).rows[0])
      .toEqual({ fee_pending_deduction: 0, fee_due_amount: 0 });
    await hResult(db(), received.refund_id, 'succeeded');
    const consult = (await q('select * from public.admin_refund_return($1,$2,$3,NULL,0,NULL,false,NULL)',
      [f.returnId, f.actor, randomUUID()])).rows[0];
    expect(consult.amount).toBe(20000);
  });

  async function failure(run: () => Promise<unknown>): Promise<{ code?: string; message?: string; detail?: string }> {
    await q('savepoint ubr_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as { code?: string; message?: string; detail?: string }; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint ubr_expected'); await q('release savepoint ubr_expected'); }
  }
  const slotsOf = async (orderId: string) => (await q(`select s.state, s.current_price, s.unit_index, s.order_item_id, s.holder_order_item_id, s.holder_unit_index
    from public.order_unit_slots s where s.order_id=$1 order by s.order_item_id, s.unit_index`, [orderId])).rows;
  const refundedTotal = async (orderId: string) => Number((await q(
    "select coalesce(sum(amount),0) n from public.order_refunds where order_id=$1 and status<>'failed'", [orderId])).rows[0].n);
  const linksOf = async (orderId: string) => (await q(`select l.exchange_order_item_id, l.exchange_unit_index, l.slot_order_item_id, l.slot_unit_index,
    l.previous_order_item_id, l.previous_unit_index from public.order_unit_exchange_links l join public.order_unit_slots s
    on s.order_item_id=l.slot_order_item_id and s.unit_index=l.slot_unit_index where s.order_id=$1 order by 1,2`, [orderId])).rows;
  const eventsOf = async (orderId: string) => (await q('select * from public.order_unit_events where order_id=$1 order by seq', [orderId])).rows;

  /** 数量2の交換の品を1行にまとめ、元の着を全部交換して、交換の品の発送を作る（交換の品の返品の土台）。 */
  async function exchangedAll(f: HRefundFixture, quantity = 2) {
    const ret = await createUbReturn(db(), f, [{ quantity, exchange: true }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'none', units: [unit(ret.lineIds[0], quantity)] });
    const exchangeItemId = received.exchange_order_item_ids[0] as string;
    const shipment = await shipFixtureOrder(db(), { orderId: f.orderId, actorId: f.actor, trackingNumber: 'UB-EX', lines: [{ order_item_id: exchangeItemId, quantity }] });
    return { exchangeItemId, shipment, received };
  }
  async function returnExchangeItem(f: HRefundFixture, x: { exchangeItemId: string; shipment: { fulfillment_id: string } }, quantity = 1, choice: 'now' | 'consult' = 'now', reason = 'unknown') {
    const ret = await createUbReturn(db(), { ...f, fulfillment: { fulfillment_id: x.shipment.fulfillment_id } },
      [{ quantity, reason, itemId: x.exchangeItemId }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice, units: [unit(ret.lineIds[0], quantity)] });
    return { ...ret, received };
  }

  test('FREQ-642-AC-02: 交換が先でも返品が先でも、交換0円・返品17,000円', async () => {
    const a = await hRefundFixture(db(), true);
    const ra = await createUbReturn(db(), a, [{ quantity: 1, exchange: true }]);
    const exchangeA = await ubReceive(db(), { returnId: ra.returnId, actorId: a.actor, choice: 'none', units: [unit(ra.lineIds[0])] });
    const rb = await createUbReturn(db(), a, [{ quantity: 1 }]);
    const returnA = await ubReceive(db(), { returnId: rb.returnId, actorId: a.actor, choice: 'now', units: [unit(rb.lineIds[0])] });
    const b = await hRefundFixture(db(), true);
    const rc = await createUbReturn(db(), b, [{ quantity: 1 }]);
    const returnB = await ubReceive(db(), { returnId: rc.returnId, actorId: b.actor, choice: 'now', units: [unit(rc.lineIds[0])] });
    // FREQ-642-AC-01: 例1 返品を1着受け取った後、返した着は returned_customer、残る着は手元にある（kept）
    expect((await slotsOf(b.orderId)).map((s) => s.state).sort()).toEqual(['kept', 'returned_customer']);
    const rd = await createUbReturn(db(), b, [{ quantity: 1, exchange: true }]);
    const exchangeB = await ubReceive(db(), { returnId: rd.returnId, actorId: b.actor, choice: 'none', units: [unit(rd.lineIds[0])] });
    const byOrder = { exchangeFirst: [exchangeA.refund_amount ?? 0, returnA.refund_amount], returnFirst: [returnB.refund_amount, exchangeB.refund_amount ?? 0] };
    expect(byOrder).toEqual({ exchangeFirst: [0, 17000], returnFirst: [17000, 0] });
    expect(exchangeA.release_refund_ids).toEqual([]);
    // 交換の結びは交換の品の着ごとに1行、枠の持ち主は交換の品の着
    const links = await linksOf(a.orderId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ exchange_order_item_id: exchangeA.exchange_order_item_ids[0], exchange_unit_index: 0, previous_order_item_id: null });
    const held = (await slotsOf(a.orderId)).filter((s) => s.holder_order_item_id === exchangeA.exchange_order_item_ids[0]);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ state: 'kept', holder_unit_index: 0 });
  });

  test.each([['exchange-first', 0], ['refund-first', 1]] as const)(
    'FREQ-642-AC-03: 交換と返品を同じ受け取りで、行の id の順を入れ替えても 0円と17,000円 (%s)', async (_name, swap) => {
      const f = await hRefundFixture(db(), true);
      const groups = swap ? [{ quantity: 1 }, { quantity: 1, exchange: true }] : [{ quantity: 1, exchange: true }, { quantity: 1 }];
      const ret = await createUbReturn(db(), f, groups);
      const units = swap ? [unit(ret.lineIds[1]), unit(ret.lineIds[0], 1, 'now')] : [unit(ret.lineIds[0]), unit(ret.lineIds[1], 1, 'now')];
      const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units });
      expect(received.refund_amount).toBe(17000);
      expect(received.exchange_order_item_ids).toHaveLength(1);
      const [event] = await eventsOf(f.orderId);
      expect(event).toMatchObject({ kind: 'return_receive', entitlement: 17000, now_refund: 17000, receipt_id: received.receipt_id, return_id: ret.returnId });
      expect(await linksOf(f.orderId)).toHaveLength(1);
    });

  test('FREQ-642-AC-04: 例4 交換の品の返品で20,000円、合計37,000円（34,000円にならない）', async () => {
    const f = await hRefundFixture(db(), true);
    const ex = await createUbReturn(db(), f, [{ quantity: 1, exchange: true }]);
    const exchanged = await ubReceive(db(), { returnId: ex.returnId, actorId: f.actor, choice: 'none', units: [unit(ex.lineIds[0])] });
    const rest = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const first = await ubReceive(db(), { returnId: rest.returnId, actorId: f.actor, choice: 'now', units: [unit(rest.lineIds[0])] });
    expect(first.refund_amount).toBe(17000);
    await hResult(db(), first.refund_id, 'succeeded');
    const exchangeItemId = exchanged.exchange_order_item_ids[0] as string;
    const shipment = await shipFixtureOrder(db(), { orderId: f.orderId, actorId: f.actor, trackingNumber: 'UB-EX4', lines: [{ order_item_id: exchangeItemId, quantity: 1 }] });
    const second = await returnExchangeItem(f, { exchangeItemId, shipment }, 1, 'now');
    const secondRefund = second.received.refund_amount;
    await hResult(db(), second.received.refund_id, 'succeeded');
    expect(secondRefund).toBe(20000);
    expect(await refundedTotal(f.orderId)).toBe(37000);
    // 元の着（FREQ-641 の取り押さえが付いていた着）に返金が結ばれ、返品の行の取り押さえは外れている
    const claimed = (await hClaims(db(), f.itemId)).filter((u) => u.refund_id === second.received.refund_id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ refund_before_shipment: false, return_line_id: null });
    const links = await linksOf(f.orderId);
    expect(links).toHaveLength(1);
    expect((await slotsOf(f.orderId)).map((s) => s.state).sort()).toEqual(['returned_customer', 'returned_customer']);
  });

  test('FREQ-642-AC-05: 交換の品を2着とも error を挟んで返しても合計37,000円で交換の結びが動かない', async () => {
    const f = await hRefundFixture(db(), true);
    const x = await exchangedAll(f, 2);
    const linksBefore = await linksOf(f.orderId);
    expect(linksBefore).toHaveLength(2);
    // 交換の品1着を今すぐ返金 → error → 交換の品のもう1着 → 今すぐ返金 → error → やり直し（どちらも成功）
    const one = await returnExchangeItem(f, x, 1, 'now');
    await q("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [one.received.refund_id]);
    const two = await returnExchangeItem(f, x, 1, 'now');
    await q("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [two.received.refund_id]);
    await hResult(db(), one.received.refund_id, 'succeeded');
    await hResult(db(), two.received.refund_id, 'succeeded');
    expect(await refundedTotal(f.orderId)).toBeLessThanOrEqual(37000);
    expect(await refundedTotal(f.orderId)).toBe(37000);
    expect(await linksOf(f.orderId)).toEqual(linksBefore);
    // やり直しで付け直した着は、出来事が返した着そのもの（取り押さえは位置では選ばない）
    const claimsByRefund = (await q(`select refund_id, count(*)::int n from public.order_line_unit_amounts where order_item_id=$1 and refund_id is not null group by 1`, [f.itemId])).rows;
    expect(claimsByRefund.map((r) => r.n).sort()).toEqual([1, 1]);
  });

  test('FREQ-642-AC-05: 既知の点4の順（数量2の交換の行を届かないで終える → ふつうの返金 → 開き直し → error → 交換 → 今すぐ返金 → error → やり直し）', async () => {
    const f = await hRefundFixture(db(), true);
    // 数量2の交換の行 1本（在庫から交換）。2着目は在庫が無くなって、同じ行のまま返金（上書き refund）に変わる
    const ret = await createUbReturn(db(), f, [{ quantity: 2, exchange: true, method: 'stock' }]);
    const line = ret.lineIds[0];
    await q('select * from public.admin_close_return_missing($1,$2,$3)', [ret.returnId, f.actor, randomUUID()]);
    const ordinary = await hBegin(db(), f, 17000);
    await q('select * from public.admin_reopen_return($1,$2,$3)', [ret.returnId, f.actor, randomUUID()]);
    await q("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [ordinary.refund_id]);
    await insertRestockMovement(db(), f.catalog.variantId, 1);
    const exchanged = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'none', units: [unit(line)] });
    expect(exchanged.exchange_order_item_ids).toHaveLength(1);
    const linksBefore = await linksOf(f.orderId);
    expect(linksBefore).toHaveLength(1);
    // 在庫を0にしてから、同じ行の2着目を今すぐ返金に変えて受け取る（店の側の扱い）
    const free = Number((await q('select stock_quantity n from public.item_variants where id=$1', [f.catalog.variantId])).rows[0].n);
    if (free > 0) await insertRestockMovement(db(), f.catalog.variantId, -free);
    const now = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(line)],
      overrides: [{ return_line_id: line, action: 'refund' }] });
    expect(now.refund_id).not.toBeNull();
    await q("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [now.refund_id]);
    await hResult(db(), now.refund_id, 'succeeded');
    await hResult(db(), ordinary.refund_id, 'succeeded');
    // 限度（移行 D、設計書 5-2・AC-28）: 通常の返金は返品なしの発送後の返金で、着も E も動かさない。上限は注文の返せる額（払った合計）。
    // 受け取りの返金（E の流れ）は E の最高以内。支払いの例外は作らない。
    const max = Number((await q('select entitlement_max n from private.order_unit_totals($1)', [f.orderId])).rows[0].n);
    const viaEvents = Number((await q(`select coalesce(sum(amount - shipping_amount),0) n from public.order_refunds
      where order_id=$1 and source='return' and status<>'failed'`, [f.orderId])).rows[0].n);
    const allRefunded = await refundedTotal(f.orderId);
    expect(viaEvents).toBeLessThanOrEqual(max);
    expect(allRefunded).toBeLessThanOrEqual(37000);
    // 着ごとの割り振り（この注文の出来事だけ）は払った額以内
    expect((await q(`select count(*)::int n from (select el.order_item_id, el.unit_index from public.order_unit_event_lines el
      join public.order_unit_events ev on ev.id=el.event_id and ev.order_id=$1
      join public.order_line_unit_amounts u on u.order_item_id=el.order_item_id and u.unit_index=el.unit_index
      group by el.order_item_id, el.unit_index, u.paid_amount having sum(el.allocation) > u.paid_amount) x`, [f.orderId])).rows[0].n).toBe(0);
    const claimed = (await q('select refund_id, count(*)::int n from public.order_line_unit_amounts where order_item_id=$1 and refund_id is not null group by 1', [f.itemId])).rows;
    for (const c of claimed) expect(c.n).toBeLessThanOrEqual(1);
    expect(await linksOf(f.orderId)).toEqual(linksBefore);
    // 通常の返金は着を取り押さえないので、error の後の遅い成功でも着の食い違いは起きず、支払いの例外は 0 件
    expect((await q('select detail,payment_ref from public.payment_exceptions where order_id=$1', [f.orderId])).rows).toEqual([]);
  });

  test('FREQ-642-AC-17: 受け取りの計画の返す着は返品の行の品が持つ着でなければ断る', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] };
    const plan = (await buildReceivePricing(db(), input))!;
    const tampered = { ...plan, lines: plan.lines.map((l) => (l.lineKind === 'returned' ? { ...l, holderOrderItemId: randomUUID() } : l)) };
    expect(await failure(() => ubReceive(db(), input, tampered))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID', detail: 'ub_receive_lines' });
  });

  test('FREQ-642-AC-17: 計画の後に交換だけの受け取りが入ると、計画は STALE（40001）で断られる', async () => {
    const f = await hRefundFixture(db(), true);
    const refundReturn = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const input = { returnId: refundReturn.returnId, actorId: f.actor, choice: 'now', units: [unit(refundReturn.lineIds[0])] };
    const plan = (await buildReceivePricing(db(), input))!;
    // 別の交換だけの受け取りが、計画の返す枠を交換に出した（出来事は書かれず版は動かない。枠の持ち主だけが動く）
    const planned = plan.lines.find((l) => l.lineKind === 'returned')!;
    await q('update public.order_unit_slots set holder_unit_index=holder_unit_index+10 where order_item_id=$1 and unit_index=$2', [planned.orderItemId, planned.unitIndex]);
    expect(await failure(() => ubReceive(db(), input, plan))).toMatchObject({ code: '40001', message: 'UNIT_PRICING_STALE' });
  });

  test('FREQ-642-AC-06: 10%で1着ずつ2回相談すると控えは1,700円と2,000円', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 2 }], { percent: 10 });
    await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[0])] });
    await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[0])] });
    const events = await eventsOf(f.orderId);
    expect(events.map((e) => e.fee_amount)).toEqual([1700, 2000]);
    expect(events.map((e) => e.consult_refund)).toEqual([15300, 18000]);
  });

  test('FREQ-642-AC-12: 数量2の交換の品を1行にまとめた後に1着返すと17,000円', async () => {
    const f = await hRefundFixture(db(), true);
    const x = await exchangedAll(f, 2);
    const exchangePaid = Number((await q('select exchange_paid_amount n from public.order_items where id=$1', [x.exchangeItemId])).rows[0].n);
    expect(exchangePaid).toBe(37000);
    const one = await returnExchangeItem(f, x, 1, 'now');
    // 平均の 18,500円ではなく、返した着の枠の値段
    expect(one.received.refund_amount).toBe(17000);
  });

  test('FREQ-642-AC-07: 2行の返品の一部の行だけ受け取ると、計画の見込みと返した額が同じで、残りの行は未処理のまま', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }, { quantity: 1 }]);
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[1], 1, 'now')] };
    const plan = (await buildReceivePricing(db(), input))!;
    const received = await ubReceive(db(), input, plan);
    expect(plan.nowRefund).toBe(17000);
    expect(received.refund_amount).toBe(plan.nowRefund);
    const left = (await q("select count(*)::int n from public.order_return_receipt_lines l join public.order_return_receipts r on r.id=l.receipt_id where r.return_id=$1 and l.return_line_id=$2", [ret.returnId, ret.lineIds[0]])).rows[0].n;
    expect(left).toBe(0);
  });

  test('FREQ-642-AC-30: 交換の頼みを返金に変えた行は、お店の側の事情で返った枠になる（17,000円）', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1, exchange: true, method: 'stock' }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])],
      overrides: [{ return_line_id: ret.lineIds[0], action: 'refund' }] });
    expect(received.refund_amount).toBe(17000);
    expect((await slotsOf(f.orderId)).map((x) => x.state).sort()).toEqual(['kept', 'returned_shop']);
  });

  test('FREQ-642-AC-17: 同じ requestKey の送り直しは、間に状態が変わっても同じ結果', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 2 }]);
    const key = randomUUID();
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', key, units: [unit(ret.lineIds[0], 1)] };
    const plan = await buildReceivePricing(db(), input);
    const first = await ubReceive(db(), input, plan);
    // 間に状態を変える（別の受け取りで版が進む）。送り直しは古い計画のままで、版を確かめる前に前の結果を返す
    const other = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'consult', units: [unit(ret.lineIds[0], 1)] });
    expect(other.receipt_id).not.toBe(first.receipt_id);
    const replay = await ubReceive(db(), input, plan);
    expect(replay).toMatchObject({ receipt_id: first.receipt_id, refund_id: first.refund_id, refund_amount: first.refund_amount, replayed: true });
    expect(replay.release_refund_ids).toEqual([]);
    // 計画が無い送り直しも同じ（版や計画の確かめより前に探す）
    expect(await ubReceive(db(), input, null)).toMatchObject({ receipt_id: first.receipt_id, replayed: true });
    expect((await eventsOf(f.orderId))).toHaveLength(2);
  });

  test('FREQ-642-AC-17: 版が違う計画は STALE で何も書かない', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 2 }]);
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0], 1)] };
    const stale = await buildReceivePricing(db(), input);
    await ubReceive(db(), { ...input, units: [unit(ret.lineIds[0], 1)] });
    const before = (await q('select (select count(*)::int from public.order_unit_events) e, (select count(*)::int from public.order_return_receipts) r')).rows[0];
    const failed = await failure(() => ubReceive(db(), { ...input, key: randomUUID() }, stale));
    expect(failed).toMatchObject({ code: '40001', message: 'UNIT_PRICING_STALE' });
    expect((await q('select (select count(*)::int from public.order_unit_events) e, (select count(*)::int from public.order_return_receipts) r')).rows[0]).toEqual(before);
  });

  test('FREQ-642-AC-17: error の後のやり直しで、結んだ着だけを付け直す', async () => {
    const f = await hRefundFixture(db(), true);
    const x = await exchangedAll(f, 1);
    // 交換の品の返品（元の着の取り押さえは外れ、返金だけが元の着に付く）
    const back = await returnExchangeItem(f, x, 1, 'now');
    const refundId = back.received.refund_id as string;
    const claimedAtEvent = (await q('select order_item_id, unit_index, refund_id, refund_before_shipment, return_line_id from public.order_line_unit_amounts where refund_id=$1', [refundId])).rows;
    expect(claimedAtEvent).toHaveLength(1);
    const slotsBefore = await slotsOf(f.orderId);
    await q("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [refundId]);
    expect((await q('select count(*)::int n from public.order_line_unit_amounts where refund_id=$1', [refundId])).rows[0].n).toBe(0);
    await hResult(db(), refundId, 'succeeded');
    const claimedAfterRetry = (await q('select order_item_id, unit_index, refund_id, refund_before_shipment, return_line_id from public.order_line_unit_amounts where refund_id=$1', [refundId])).rows;
    expect(claimedAfterRetry).toEqual(claimedAtEvent);
    expect(await slotsOf(f.orderId)).toEqual(slotsBefore);
    expect((await q("select count(*)::int n from public.payment_exceptions where order_id=$1 and detail='group_h_refund_unit_mismatch'", [f.orderId])).rows[0].n).toBe(0);
  });

  test('FREQ-642-AC-17: failed は取り押さえを外し、枠の状態は変えない', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
    const slotsBefore = await slotsOf(f.orderId);
    expect(slotsBefore.filter((s) => s.state === 'returned_customer')).toHaveLength(1);
    await hResult(db(), received.refund_id, 'failed');
    expect((await q('select count(*)::int n from public.order_line_unit_amounts where refund_id=$1', [received.refund_id])).rows[0].n).toBe(0);
    expect(await slotsOf(f.orderId)).toEqual(slotsBefore);
    expect(await eventsOf(f.orderId)).toHaveLength(1);
  });

  test('FREQ-642-AC-17: 計画が無い・合わない呼び出しは UNIT_PRICING_REQUIRED / INVALID', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 2 }]);
    const input = { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0], 1)] };
    const plan = (await buildReceivePricing(db(), input))!;
    expect(await failure(() => ubReceive(db(), input, null))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_REQUIRED' });
    // 返す着の数が受け取りと合わない
    const twoReturned = { ...plan, lines: [...plan.lines, { ...plan.lines.find((l) => l.lineKind === 'returned')!, unitIndex: 1 }] };
    expect(await failure(() => ubReceive(db(), input, twoReturned))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID', detail: 'ub_receive_lines' });
    // 割引の扱いが計画の側と違う
    const wrongSide = { ...plan, treatments: [{ returnLineId: ret.lineIds[0], treatment: 'shop' }] };
    expect(await failure(() => ubReceive(db(), input, wrongSide))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID', detail: 'ub_treatment' });
    // 他の注文の計画
    expect(await failure(() => ubReceive(db(), input, { ...plan, orderId: randomUUID() }))).toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID' });
    expect((await eventsOf(f.orderId))).toHaveLength(0);
  });

  test('FREQ-642-AC-20: 写しの無い注文は14の引数の時と同じ額（計画が NULL のまま）で、計画を渡すと断る', async () => {
    const legacy = await legacyFixture(db());
    const units = JSON.stringify([{ return_line_id: legacy.lineIds[0], disposition: 'not_restocked', quantity: 1 }]);
    expect(await failure(() => q(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,'now',null,0,null,false,null,null,null,$5::jsonb)`,
      [legacy.returnId, legacy.actor, randomUUID(), units, '{"kind":"return_receive"}'])))
      .toMatchObject({ code: '22023', message: 'UNIT_PRICING_INVALID', detail: 'ub_legacy' });
    // 14の引数の呼び出し（_pricing の既定は NULL）。今の本文のとおり、安い着の17,000円
    const r14 = (await q(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,'now',null,0,null,false,null,null,null)`,
      [legacy.returnId, legacy.actor, randomUUID(), units])).rows[0];
    expect(r14.refund_amount).toBe(17000);
    expect(r14.release_refund_ids).toEqual([]);
    expect((await q('select count(*)::int n from public.order_unit_events where order_id=$1', [legacy.orderId])).rows[0].n).toBe(0);
    expect((await q('select count(*)::int n from public.order_unit_exchange_links l join public.order_return_receipts r on r.id=l.receipt_id where r.return_id=$1', [legacy.returnId])).rows[0].n).toBe(0);
  });

  test('FREQ-642-AC-31: 例17 セットの1着を交換すると 0円で、残りのセットの割引と枠の値段は変わらない', async () => {
    const set = await setFixture(db());
    const ret = await createUbReturn(db(), { ...set, itemId: set.pantsItemId, catalog: set.pantsCatalog },
      [{ quantity: 1, exchange: true, reason: 'defective', itemId: set.pantsItemId }]);
    const slotPricesBefore = (await slotsOf(set.orderId)).map((s) => [s.state, s.current_price]);
    const result = await ubReceive(db(), { returnId: ret.returnId, actorId: set.actor, choice: 'none', units: [unit(ret.lineIds[0])] });
    expect(result.refund_amount ?? 0).toBe(0);
    expect(result.exchange_order_item_ids).toHaveLength(1);
    const slotPricesAfter = (await slotsOf(set.orderId)).map((s) => [s.state, s.current_price]);
    expect(slotPricesAfter).toEqual(slotPricesBefore);
    expect(await eventsOf(set.orderId)).toHaveLength(0);
    expect(Number((await q('select exchange_paid_amount n from public.order_items where id=$1', [result.exchange_order_item_ids[0]])).rows[0].n)).toBe(17000);
  });

  test('FREQ-642-AC-25: 割引の扱いを直した行は受け取りの id と店長で残る', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])], sides: { [ret.lineIds[0]]: 'shop' } });
    const rows = (await q('select return_line_id, treatment, receipt_id, actor_id from public.order_return_line_treatments where return_line_id=$1', [ret.lineIds[0]])).rows;
    expect(rows).toEqual([{ return_line_id: ret.lineIds[0], treatment: 'shop', receipt_id: received.receipt_id, actor_id: f.actor }]);
    const [event] = await eventsOf(f.orderId);
    expect(event).toMatchObject({ fee_amount: 0 });
    expect((await slotsOf(f.orderId)).some((s) => s.state === 'returned_shop')).toBe(true);
  });

  test('FREQ-642-AC-15: お詫びの返金の後の返品は、注文の返せる額で止まる', async () => {
    const f = await hRefundFixture(db(), true);
    const apology = (await q("select * from public.begin_order_refund($1,'admin',$2,'[]',false,0,30000,null,'requested_by_customer',null,false,$3)", [f.orderId, randomUUID(), f.actor])).rows[0];
    await hResult(db(), apology.refund_id, 'succeeded');
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', units: [unit(ret.lineIds[0])] });
    // 17,000円の見込みだが、返せる額は 37,000 - 30,000 = 7,000円。起点は計算した E なので、枠は返した状態になる
    expect(received.refund_amount).toBe(7000);
    const [event] = await eventsOf(f.orderId);
    expect(event).toMatchObject({ standard_refund: 17000, now_refund: 17000 });
    expect(await refundedTotal(f.orderId)).toBe(37000);
  });

  test('FREQ-642-AC-23: 店長が額を0円に直した受け取りは waived で終わり、枠は返した状態・取り押さえは付かない', async () => {
    const f = await hRefundFixture(db(), true);
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }]);
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now', amount: 0, units: [unit(ret.lineIds[0])] });
    expect(received).toMatchObject({ refund_id: null, refund_status: 'waived', refund_amount: 0 });
    const [event] = await eventsOf(f.orderId);
    expect(event).toMatchObject({ standard_refund: 17000, now_refund: 17000 });
    expect((await slotsOf(f.orderId)).filter((s) => s.state === 'returned_customer')).toHaveLength(1);
    expect((await q('select count(*)::int n from public.order_unit_event_refunds')).rows[0].n).toBe(0);
    expect((await q("select count(*)::int n from public.order_return_receipt_lines where receipt_id=$1 and disposition='refund_waived'", [received.receipt_id])).rows[0].n).toBe(1);
  });

  test('FREQ-642-AC-16: 交換 → 交換の品を全部返金 → 同じ商品の前の注文の着数は0（会員の注文）', async () => {
    const buyer = (await q("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),$1,'{}','{}') returning id", [`ub-${randomUUID()}@example.invalid`])).rows[0].id as string;
    const f = await hRefundFixture(db(), true, 2, 3000, buyer);
    const itemId = Number((await q('select item_id n from public.order_items where id=$1', [f.itemId])).rows[0].n);
    const prior = async () => Number((await q("select public.get_checkout_discount_context($1,null,'{}',$2,now(),'confirm') j", [buyer, [itemId]])).rows[0].j.facts.priorUnitsByItem?.[String(itemId)] ?? 0);
    expect(await prior()).toBe(2);
    const x = await exchangedAll(f, 2);
    expect(await prior()).toBe(2);
    const back = await returnExchangeItem(f, x, 2, 'now');
    await hResult(db(), back.received.refund_id, 'succeeded');
    expect((await slotsOf(f.orderId)).filter((s) => s.state === 'kept')).toHaveLength(0);
    expect(await prior()).toBe(0);
  });

  test('FREQ-642-AC-17: 受け取りの計画は他の受け取りと同じ関数で作る材料と一致する', async () => {
    const f = await hRefundFixture(db(), true);
    const m = (await materialsOf(db(), f.orderId)) as UnitPricingMaterials;
    expect(planUnitEvent(m, { kind: 'return_receive', excludedSlots: [], returns: [{ returnLineId: null, holderOrderItemId: f.itemId, quantity: 1, side: 'customer', part: 'now', feePercent: 0 }] }).standardRefund).toBe(17000);
  });
});

/** 写しの無い（この変更より前の）注文: 2着 17,000円・20,000円の発送済み。返品1件（返金1着）。写しは作らない。 */
async function legacyFixture(db: PgClient, quantity = 1, restockingPercent = 0) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  const actor = (await db.query("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),$1,'{}','{}') returning id", [`ub-${randomUUID()}@example.invalid`])).rows[0].id as string;
  const catalog = await createCatalogFixture(db, { stock: 4 });
  const order = await insertOrderWithLines(db, { status: 'paid', shippingAmount: 0, discountAmount: 3000, paidAmount: 37000,
    paymentIntentId: `pi_ub_${randomUUID()}`,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 2, itemPrice: 20000, fulfillmentType: 'stock' }] });
  const itemId = order.orderItemIds[0];
  const discountId = await seedHDiscount(db, hDiscount({ value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 40000 } }));
  await db.query('insert into public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount) values($1,$2,$3,$4)', [order.orderId, itemId, discountId, 3000]);
  for (const [index, amount] of [17000, 20000].entries()) await db.query(
    'insert into public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount) values($1,$2,$3,$4)', [order.orderId, itemId, index, amount]);
  const fulfillment = await shipFixtureOrder(db, { orderId: order.orderId, actorId: actor, trackingNumber: 'UB-LEGACY', lines: [{ order_item_id: itemId, quantity: 2 }] });
  const ret = await createUbReturn(db, { orderId: order.orderId, itemId, actor, fulfillment, catalog }, [{ quantity }], { percent: restockingPercent });
  return { orderId: order.orderId, itemId, actor, ...ret };
}

/** 例17 のセット（実際の受け付けで作る）: ジャケット・パンツ各20,000円の組で6,000円引き（払った額は17,000円ずつ）。 */
async function setFixture(db: PgClient) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  const catalogs = [await createCatalogFixture(db, { stock: 1 }), await createCatalogFixture(db, { stock: 1 })];
  const actor = await seedHMember(db); const code = `UB-${randomUUID().toUpperCase()}`;
  const discountId = await seedHDiscount(db, hDiscount({ code, kind: 'set', value: { type: 'amount', value: 6000 },
    targetMode: 'include', itemIds: catalogs.map((c) => c.itemId), minimum: { type: 'amount', value: 40000 }, allowGuests: true }));
  const checkout = await seedHCheckout(db, { discountId, code, userId: await seedHMember(db), lines: catalogs.map((catalog) => ({ catalog, quantity: 1 })) });
  const accepted = await acceptHCheckout(db, checkout);
  await db.query("select * from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'payment_received')", [accepted.order_id, checkout.paymentIntentId, checkout.result.totalAmount]);
  const items = (await db.query('select id,item_id from public.order_items where order_id=$1 order by item_id', [accepted.order_id])).rows;
  const fulfillment = await shipFixtureOrder(db, { orderId: accepted.order_id!, actorId: actor, trackingNumber: 'UB-SET', lines: items.map((i) => ({ order_item_id: i.id, quantity: 1 })) });
  for (const i of items) await seedFactSlip(db, { orderItemId: i.id, quantity: 1 });
  return { orderId: accepted.order_id!, actor, fulfillment, itemId: items[0].id as string, catalog: catalogs[0], pantsItemId: items[1].id as string, pantsCatalog: catalogs[1] };
}
