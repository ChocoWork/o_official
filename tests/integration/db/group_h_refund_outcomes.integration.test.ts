/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describeLocalDb, isLocalDatabase, type PgClient } from './helpers/local-db';
import { hBegin, hClaims, hReceive, hRefundFixture, hResult, hReturn, type HRefundFixture } from './helpers/group-h-refund-fixtures';
import { seedGroupG1Shipment, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { createCatalogFixture, insertCancelRequest, shipFixtureOrder } from './helpers/order-fixtures';
import { hDiscount, seedHDiscount, seedHOrderUnits } from './helpers/group-h-fixtures';
import { seedFactSlip } from './helpers/accounting-orders-fixtures';
import { ubReceive } from './helpers/unit-binding-receive';

type Outcome = 'sent_back' | 'missing' | 'waived';
type AmountRow = { orderId: string; lineAmount: number; quantity: number };
const receiveOrders = ['sent_back_then_refund', 'refund_then_sent_back', 'together_sent_back_first', 'together_refund_first'] as const;
type ReceiveOrder = typeof receiveOrders[number];

async function receiveUnits(db: PgClient, f: HRefundFixture, r: Awaited<ReturnType<typeof hReturn>>,
  dispositions: Array<'sent_back' | 'not_restocked'>, choice: 'none' | 'now' | 'consult', amount: number | null = null) {
  // 注文の時の写しのある注文は、値段の計画（FREQ-642）を付けて受け取る
  return ubReceive(db, { returnId: r.returnId, actorId: f.actor, choice, amount, notify: true, sentBackMessage: 'Fixture',
    units: dispositions.map(disposition => ({ return_line_id: r.lineId, disposition, quantity: 1 })) });
}

async function receivePair(db: PgClient, f: HRefundFixture, r: Awaited<ReturnType<typeof hReturn>>,
  order: ReceiveOrder, choice: 'none' | 'now' | 'consult') {
  if (order === 'sent_back_then_refund') {
    await receiveUnits(db, f, r, ['sent_back'], 'none');
    expect((await hClaims(db, f.itemId)).map(unit => unit.return_line_id)).toEqual([r.lineId, null]);
    return receiveUnits(db, f, r, ['not_restocked'], choice);
  }
  if (order === 'refund_then_sent_back') {
    const received = await receiveUnits(db, f, r, ['not_restocked'], choice);
    await receiveUnits(db, f, r, ['sent_back'], 'none');
    return received;
  }
  return receiveUnits(db, f, r, order === 'together_sent_back_first' ? ['sent_back', 'not_restocked'] : ['not_restocked', 'sent_back'], choice);
}

async function finishCheapestRefund(db: PgClient, f: HRefundFixture, r: Awaited<ReturnType<typeof hReturn>>, refundId: string) {
  expect((await db.query('select amount,adjustment_amount from public.order_refunds where id=$1', [refundId])).rows)
    .toEqual([{ amount: 17000, adjustment_amount: 0 }]);
  expect((await db.query('select order_item_id,quantity,amount from public.order_refund_lines where refund_id=$1', [refundId])).rows)
    .toEqual([{ order_item_id: f.itemId, quantity: 1, amount: 17000 }]);
  expect((await hClaims(db, f.itemId)).map(unit => ({ paid: unit.paid_amount, refund: unit.refund_id, returnLine: unit.return_line_id })))
    .toEqual([{ paid: 17000, refund: refundId, returnLine: r.lineId }, { paid: 20000, refund: null, returnLine: null }]);
  await hResult(db, refundId, 'succeeded');
  expect((await db.query('select lines from public.load_order_refund_materials($1)', [f.orderId])).rows[0].lines[0])
    .toMatchObject({ shipped_refundable: 1, available_unit_amounts: [20000] });
  const normal = await hBegin(db, f, 20000);
  expect(normal.amount).toBe(20000);
  expect((await db.query('select quantity,amount from public.order_refund_lines where refund_id=$1', [normal.refund_id])).rows)
    .toEqual([{ quantity: 1, amount: 20000 }]);
  expect((await db.query('select adjustment_amount from public.order_refunds where id=$1', [normal.refund_id])).rows[0].adjustment_amount).toBe(0);
  await hResult(db, normal.refund_id, 'succeeded');
  expect((await hClaims(db, f.itemId)).map(unit => unit.refund_id)).toEqual([refundId, normal.refund_id]);
  expect((await db.query('select refunded_amount from public.orders where id=$1', [f.orderId])).rows[0].refunded_amount).toBe(37000);
}
async function completed(db: PgClient, outcome: Outcome) {
  const f = await hRefundFixture(db, true, 2, outcome === 'waived' ? 20000 : 3000);
  const r = await hReturn(db, f);
  if (outcome === 'missing') {
    await db.query('select * from public.admin_close_return_missing($1,$2,$3)', [r.returnId, f.actor, randomUUID()]);
  } else if (outcome === 'waived') {
    await hReceive(db, f, r, 1, 'now');
  } else {
    await ubReceive(db, { returnId: r.returnId, actorId: f.actor, choice: 'none', notify: true, sentBackMessage: 'Fixture',
      units: [{ return_line_id: r.lineId, disposition: 'sent_back', quantity: 1 }] });
  }
  await db.query(`insert into public.user_roles(user_id,role_id,active) select $1,id,true from public.roles where code='admin'`, [f.actor]);
  return { ...f, completedReturn: r };
}

describeLocalDb('H5 G-1 return outcomes and late refund recovery (controller)', db => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });
  test.each(receiveOrders.flatMap(order => (['now', 'consult'] as const).map(choice => ({ order, choice }))))(
    'FREQ-551-AC-01: 返品2着の$order・$choiceでも返金17000円・調整0・解放後の通常返金20000円になる', async ({ order, choice }) => {
      const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2);
      const received = await receivePair(db(), f, r, order, choice);
      const detail = (await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j;
      expect(detail.lines[0].refund_waiting_amount).toBe(choice === 'consult' ? 17000 : 0);
      const refund = choice === 'now' ? received : (await db().query(
        'select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [r.returnId, f.actor, randomUUID()])).rows[0];
      expect(choice === 'now' ? refund.refund_amount : refund.amount).toBe(17000);
      await finishCheapestRefund(db(), f, r, refund.refund_id);
    });
  test.each(['missing_then_refund', 'refund_then_missing'] as const)(
    'FREQ-551-AC-01: 返品2着の%sでも返金17000円・調整0・解放後の通常返金20000円になる', async order => {
      const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2);
      // G-1 closes every unprocessed unit as missing; receive one into consultation first.
      const received = await hReceive(db(), f, r, 1, order === 'missing_then_refund' ? 'consult' : 'now');
      await db().query('select * from public.admin_close_return_missing($1,$2,$3)', [r.returnId, f.actor, randomUUID()]);
      const detail = (await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j;
      expect(detail.lines[0].refund_waiting_amount).toBe(order === 'missing_then_refund' ? 17000 : 0);
      const refund = order === 'refund_then_missing' ? received : (await db().query(
        'select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [r.returnId, f.actor, randomUUID()])).rows[0];
      expect(order === 'refund_then_missing' ? refund.refund_amount : refund.amount).toBe(17000);
      await finishCheapestRefund(db(), f, r, refund.refund_id);
    });
  test.each(receiveOrders)('FREQ-551-AC-02: 返品2着の%sでも交換元は17000円でお返しした20000円を通常返金できる', async order => {
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2, true);
    const received = await receivePair(db(), f, r, order, 'none');
    expect(received.exchange_order_item_ids).toHaveLength(1);
    expect((await db().query('select exchange_paid_amount from public.order_items where id=$1', [received.exchange_order_item_ids[0]])).rows[0].exchange_paid_amount).toBe(17000);
    expect((await hClaims(db(), f.itemId)).map(unit => unit.return_line_id)).toEqual([r.lineId, null]);
    const refund = await hBegin(db(), f, 20000);
    expect((await db().query('select quantity,amount from public.order_refund_lines where refund_id=$1', [refund.refund_id])).rows)
      .toEqual([{ quantity: 1, amount: 20000 }]);
    await hResult(db(), refund.refund_id, 'succeeded');
    expect((await hClaims(db(), f.itemId)).map(unit => unit.refund_id)).toEqual([null, refund.refund_id]);
  });
  test('FREQ-551-AC-01: 届かない2着を開き直して1着を返金し残りを再び閉じても17000円と20000円を保つ', async () => {
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2);
    await db().query('select * from public.admin_close_return_missing($1,$2,$3)', [r.returnId, f.actor, randomUUID()]);
    expect((await hClaims(db(), f.itemId)).every(unit => unit.return_line_id === null)).toBe(true);
    await db().query('select * from public.admin_reopen_return($1,$2,$3)', [r.returnId, f.actor, randomUUID()]);
    expect((await hClaims(db(), f.itemId)).map(unit => unit.return_line_id)).toEqual([r.lineId, r.lineId]);
    const received = await hReceive(db(), f, r, 1, 'now');
    await db().query('select * from public.admin_close_return_missing($1,$2,$3)', [r.returnId, f.actor, randomUUID()]);
    expect(received.refund_amount).toBe(17000);
    await finishCheapestRefund(db(), f, r, received.refund_id);
  });
  test.each(['waived_then_refund', 'refund_then_waived'] as const)(
    'FREQ-641-AC-07: 返品2着の%sでは0円で終えるnowの着を解放し残る着だけを返金する', async order => {
      const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2);
      const waive = () => receiveUnits(db(), f, r, ['not_restocked'], 'now', 0);
      if (order === 'waived_then_refund') {
        expect(await waive()).toMatchObject({ refund_id: null, refund_status: 'waived', refund_amount: 0 });
        expect((await hClaims(db(), f.itemId)).map(unit => unit.return_line_id)).toEqual([null, r.lineId]);
      }
      const received = await hReceive(db(), f, r, 1, 'now');
      if (order === 'refund_then_waived') expect(await waive()).toMatchObject({ refund_id: null, refund_status: 'waived', refund_amount: 0 });
      if (order === 'refund_then_waived') {
        expect(received.refund_amount).toBe(17000);
        await finishCheapestRefund(db(), f, r, received.refund_id);
      } else {
        expect(received.refund_amount).toBe(20000);
        expect((await db().query('select amount,adjustment_amount from public.order_refunds where id=$1', [received.refund_id])).rows)
          .toEqual([{ amount: 20000, adjustment_amount: 0 }]);
        expect((await hClaims(db(), f.itemId)).map(unit => unit.refund_id)).toEqual([null, received.refund_id]);
        await hResult(db(), received.refund_id, 'succeeded');
        const normal = await hBegin(db(), f, 17000);
        expect(normal.amount).toBe(17000); await hResult(db(), normal.refund_id, 'succeeded');
        expect((await db().query('select refunded_amount from public.orders where id=$1', [f.orderId])).rows[0].refunded_amount).toBe(37000);
      }
    });
  test('FREQ-551-AC-02: 返金の公開入口も過剰な3着を業務拒否してclaimを増やさない', async () => {
    const f = await hRefundFixture(db(), true);
    await db().query('savepoint h5_excess');
    try {
      await expect(hBegin(db(), f, 37000, false, randomUUID(), 3)).rejects.toMatchObject({ code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_SHIPPED' });
    } finally { await db().query('rollback to savepoint h5_excess'); await db().query('release savepoint h5_excess'); }
    expect((await hClaims(db(), f.itemId)).every(unit => unit.refund_id === null)).toBe(true);
  });
  test('FREQ-551-AC-02: auto_cancelled_order_paymentはHでも数量なし調整の既存契約を保つ', async () => {
    const f = await hRefundFixture(db());
    await setOrderStatusForFixture(db(), [f.orderId], 'cancelled');
    const result = (await db().query(`select * from public.begin_order_refund($1,'auto_cancelled_order_payment',null,'[]',false,null,null,null,null,null,false,null,$2)`,
      [f.orderId, 37000])).rows[0];
    expect(result.amount).toBe(37000);
    expect((await db().query('select adjustment_amount from public.order_refunds where id=$1', [result.refund_id])).rows[0].adjustment_amount).toBe(37000);
    expect((await hClaims(db(), f.itemId)).every(unit => unit.refund_id === null)).toBe(true);
  });
  test('FREQ-551-AC-02: Hのキャンセル申請も共通返金17000円で解決し単位額を保つ', async () => {
    const f = await hRefundFixture(db());
    const request = await insertCancelRequest(db(), { orderId: f.orderId, lines: [{ orderItemId: f.itemId, quantity: 1 }] });
    const refund = await hBegin(db(), f, 17000, true); await hResult(db(), refund.refund_id, 'pending');
    expect((await db().query('select * from public.admin_resolve_cancel_request($1,$2,$3,false)',
      [request.cancelRequestId, f.actor, refund.refund_id])).rows).toEqual([{ cancel_request_id: request.cancelRequestId, status: 'resolved' }]);
    expect((await hClaims(db(), f.itemId)).map(unit => unit.paid_amount)).toEqual([17000, 20000]);
  });
  test('FREQ-551-AC-04: Hの交換行は0円で元行の状態額と交換元額を保つ', async () => {
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 1, true);
    const received = await hReceive(db(), f, r, 1, 'none');
    const rows = (await db().query('select * from private.group_g_order_item_rows($1)', [[f.orderId]])).rows;
    expect(rows.filter(row => !row.is_exchange).reduce((sum, row) => sum + row.line_amount, 0)).toBe(37000);
    expect(rows.filter(row => row.is_exchange).every(row => row.line_amount === 0)).toBe(true);
    expect((await db().query('select exchange_paid_amount from public.order_items where id=$1', [received.exchange_order_item_ids[0]])).rows[0].exchange_paid_amount).toBe(17000);
  });
  test('FREQ-551-AC-04: Hの送料500円は商品状態の37000円へ混ぜない', async () => {
    await db().query('select pg_advisory_xact_lock(190521,1)');
    const catalog = await createCatalogFixture(db());
    const discountId = await seedHDiscount(db(), hDiscount({ kind: 'repeat', targetMode: 'include', itemIds: [catalog.itemId],
      repeatInOrder: true, value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 40000 } }));
    const order = await seedHOrderUnits(db(), { legacy: false, shippingAmount: 500,
      lines: [{ catalog, itemPrice: 20000, quantity: 2, discounts: [{ discountId, amount: 3000 }], unitAmounts: [17000, 20000] }] });
    expect((await db().query('select sum(line_amount)::int n from private.group_g_order_item_rows($1)', [[order.orderId]])).rows[0].n).toBe(37000);
    expect((await db().query('select shipping_amount,total_amount from public.orders where id=$1', [order.orderId])).rows[0])
      .toEqual({ shipping_amount: 500, total_amount: 37500 });
  });
  test('FREQ-551-AC-04: 二つの発送の離れた返品済み区間もH単位を一度ずつ割り当てる', async () => {
    const f = await hRefundFixture(db(), false, 4);
    const shipments = [];
    for (const suffix of ['A', 'B']) shipments.push(await shipFixtureOrder(db(), { orderId: f.orderId, actorId: f.actor,
      trackingNumber: `H5-SPLIT-${suffix}`, lines: [{ order_item_id: f.itemId, quantity: 2 }] }));
    // 会計の発送の事実（出荷済みの着の印）。値段の計画は出荷済みの枠からだけ発送後の返品を選ぶ
    for (let i = 0; i < 2; i++) await seedFactSlip(db(), { orderItemId: f.itemId, quantity: 2 });
    for (const fulfillment of shipments) {
      const r = await hReturn(db(), { ...f, fulfillment }); await hReceive(db(), f, r);
      const refund = (await db().query('select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [r.returnId, f.actor, randomUUID()])).rows[0];
      await hResult(db(), refund.refund_id, 'succeeded');
    }
    const ranges = (await db().query("select unit_from,unit_to from private.group_g_item_state_ranges($1) where status='returned' order by unit_from", [[f.orderId]])).rows;
    expect(ranges).toEqual([{ unit_from: 0, unit_to: 1 }, { unit_from: 2, unit_to: 3 }]);
    const rows = (await db().query('select status,quantity,line_amount from private.group_g_order_item_rows($1)', [[f.orderId]])).rows;
    expect(rows).toEqual(expect.arrayContaining([
      { status: 'returned', quantity: 2, line_amount: 34000 }, { status: 'shipped', quantity: 2, line_amount: 37000 },
    ]));
  });
  test('FREQ-551-AC-04: 発送後に届いた発送前返金の成功はcancelled区間0でも既存の行へ返金額を付ける', async () => {
    const f = await hRefundFixture(db());
    const a = await hBegin(db(), f, 17000, true);
    await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',true)", [a.refund_id]);
    await shipFixtureOrder(db(), { orderId: f.orderId, actorId: f.actor, trackingNumber: 'H5-LATE', lines: [{ order_item_id: f.itemId, quantity: 2 }] });
    await hResult(db(), a.refund_id, 'succeeded');
    const rows = (await db().query('select status,line_amount,refund_amount from private.group_g_order_item_rows($1)', [[f.orderId]])).rows;
    expect(rows.some(row => row.status === 'cancelled')).toBe(false);
    expect(rows.reduce((sum, row) => sum + row.line_amount, 0)).toBe(37000);
    expect(rows.reduce((sum, row) => sum + row.refund_amount, 0)).toBe(17000);
  });
  test.each<Outcome>(['sent_back', 'missing', 'waived'])('FREQ-551-AC-04: %s後も複数注文の一覧と詳細の数量・金額がG-1と一致する', async outcome => {
    const f = await completed(db(), outcome);
    const other = await hRefundFixture(db(), true);
    const rows = (await db().query('select * from private.group_g_order_item_rows($1)', [[f.orderId, other.orderId]])).rows;
    for (const order of [f, other]) {
      const own = rows.filter(row => row.order_id === order.orderId);
      expect(own.reduce((sum, row) => sum + row.quantity, 0)).toBe(2);
      expect(own.reduce((sum, row) => sum + row.line_amount, 0)).toBe(order.f.result.totalAmount);
      const detail = (await db().query('select public.get_admin_order_detail($1,$2) j', [order.orderId, f.actor])).rows[0].j;
      expect(detail.rows.reduce((sum: number, row: AmountRow) => sum + row.lineAmount, 0)).toBe(order.f.result.totalAmount);
    }
    const page = (await db().query("select public.list_admin_order_item_rows('{}',100,0,$1) j", [f.actor])).rows[0].j;
    expect(page.rows.map((row: AmountRow) => row.orderId)).toEqual(expect.arrayContaining([f.orderId, other.orderId]));
  });
  test.each<Outcome>(['sent_back', 'missing', 'waived'])('FREQ-551-AC-02: %s後も通常返金の全部2着は安い単位から成功する', async outcome => {
    const f = await completed(db(), outcome);
    const material = (await db().query('select lines from public.load_order_refund_materials($1)', [f.orderId])).rows[0].lines[0];
    expect(material.shipped_refundable).toBe(2);
    expect(material.available_unit_amounts).toEqual(outcome === 'waived' ? [0, 20000] : [17000, 20000]);
    expect((await hClaims(db(), f.itemId)).every(unit => unit.return_line_id === null)).toBe(true);
    const refund = await hBegin(db(), f, f.f.result.totalAmount, false, randomUUID(), 2);
    await hResult(db(), refund.refund_id, 'succeeded');
    expect((await db().query('select amount,quantity from public.order_refund_lines where refund_id=$1', [refund.refund_id])).rows)
      .toEqual([{ amount: f.f.result.totalAmount, quantity: 2 }]);
  });
  test('FREQ-551-AC-02: missing中の通常返金後に開き直して受け取ってもG-1が空ける残り20000円を返せる', async () => {
    const f = await completed(db(), 'missing');
    const a = await hBegin(db(), f, 17000); await hResult(db(), a.refund_id, 'succeeded');
    await db().query('select * from public.admin_reopen_return($1,$2,$3)', [f.completedReturn.returnId, f.actor, randomUUID()]);
    await hReceive(db(), f, f.completedReturn);
    const material = (await db().query('select lines from public.load_order_refund_materials($1)', [f.orderId])).rows[0].lines[0];
    expect(material.shipped_refundable).toBe(1); expect(material.available_unit_amounts).toEqual([20000]);
    const b = await hBegin(db(), f, 20000); await hResult(db(), b.refund_id, 'succeeded');
    expect((await db().query('select sum(line_amount)::int n from private.group_g_order_item_rows($1)', [[f.orderId]])).rows[0].n).toBe(37000);
  });
  test.each([{ quantity: 1, reviewed: false }, { quantity: 2, reviewed: false }, { quantity: 1, reviewed: true }])(
    'FREQ-551-AC-02: A error→B $quantity着成功→A遅延成功でもwebhookは記録し要対応を残す（旧対応済み=$reviewed）', async ({ quantity, reviewed }) => {
    const f = await hRefundFixture(db(), true);
    const a = await hBegin(db(), f, 17000);
    await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',true)", [a.refund_id]);
    if (reviewed) await db().query(`select private.resolve_group_g_payment_exception_row(id,'Fixture reviewed')
      from public.payment_exceptions where payment_ref=$1 and reason='refund_failed'`, [a.refund_id]);
    const b = await hBegin(db(), f, quantity === 1 ? 17000 : 37000, false, randomUUID(), quantity);
    await hResult(db(), b.refund_id, 'succeeded');
    const result = await hResult(db(), a.refund_id, 'succeeded');
    expect(result.status).toBe('succeeded');
    expect((await db().query('select status,amount from public.order_refunds where id=$1', [a.refund_id])).rows[0])
      .toEqual({ status: 'succeeded', amount: 17000 });
    expect((await hClaims(db(), f.itemId)).filter(unit => unit.refund_id === a.refund_id)).toHaveLength(2 - quantity);
    expect((await db().query("select count(*)::int n from public.payment_exceptions where payment_ref=any($1::text[]) and reason='refund_failed' and resolved_at is null",
      [[a.refund_id, `re_${a.refund_id.replaceAll('-', '')}`]])).rows[0].n).toBe(1);
    await hResult(db(), a.refund_id, 'succeeded');
    expect((await hClaims(db(), f.itemId)).filter(unit => unit.refund_id === b.refund_id)).toHaveLength(quantity);
    expect((await db().query('select sum(line_amount)::int n from private.group_g_order_item_rows($1)', [[f.orderId]])).rows[0].n).toBe(37000);
  });
  test('FREQ-551-AC-04: 分割発送の一方が配達済みでも発送中の単位を返金できる', async () => {
    const f = await hRefundFixture(db());
    await seedGroupG1Shipment(db(), { orderId: f.orderId, lines: [{ orderItemId: f.itemId, quantity: 1 }],
      shippedAt: '2026-10-28T00:00:00Z', deliveredAt: '2026-10-29T00:00:00Z' });
    await seedGroupG1Shipment(db(), { orderId: f.orderId, lines: [{ orderItemId: f.itemId, quantity: 1 }], shippedAt: '2026-10-29T01:00:00Z' });
    const a = await hBegin(db(), f, 17000); await hResult(db(), a.refund_id, 'succeeded');
    const b = await hBegin(db(), f, 20000); await hResult(db(), b.refund_id, 'succeeded');
    const rows = (await db().query('select status,quantity,line_amount from private.group_g_order_item_rows($1)', [[f.orderId]])).rows;
    expect(rows).toEqual(expect.arrayContaining([
      { status: 'shipped', quantity: 1, line_amount: 17000 }, { status: 'delivered', quantity: 1, line_amount: 20000 },
    ]));
  });
});

const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
if (!apiUrl || !serviceKey) {
  test.skip('FREQ-551-AC-04: H5 outcomes PostgREST requires local API configuration', () => {});
} else if (!isLocalDatabase(apiUrl)) {
  test('FREQ-551-AC-04: localhost以外のAPIには接続しない', () => { throw new Error('H5_LOCAL_API_REQUIRED'); });
} else {
  describeLocalDb('H5 outcomes list/detail HTTP status (controller reset required)', db => {
    const service = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    afterEach(async () => { await db().query('rollback'); });
    test.each<Outcome>(['sent_back', 'missing', 'waived'])('FREQ-551-AC-04: %s後の一覧と詳細はHTTP 200で総額を保つ', async outcome => {
      await db().query('begin');
      const f = await completed(db(), outcome), other = await hRefundFixture(db(), true);
      await db().query('set constraints all immediate'); await db().query('commit');
      // The controller resets these committed fixtures, as in the existing concurrency suites.
      const page = await service.rpc('list_admin_order_item_rows', { _filters: {}, _limit: 100, _offset: 0, _actor_id: f.actor });
      expect(page.status).toBe(200);
      const pageRows = page.data.rows as AmountRow[];
      for (const order of [f, other]) {
        const own = pageRows.filter(row => row.orderId === order.orderId);
        expect(own.reduce((sum, row) => sum + row.lineAmount, 0)).toBe(order.f.result.totalAmount);
        const detail = await service.rpc('get_admin_order_detail', { _order_id: order.orderId, _actor_id: f.actor });
        expect(detail.status).toBe(200);
        expect(detail.data.rows.reduce((sum: number, row: AmountRow) => sum + row.lineAmount, 0)).toBe(order.f.result.totalAmount);
      }
    });
  });
}
