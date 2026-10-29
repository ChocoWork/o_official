/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import type { DiscountDefinition, DiscountFacts, DiscountRefusal } from '@/lib/discounts/discount-types';
import { describeLocalDb } from './helpers/local-db';
import { hDiscount, hRpc, hFailure, seedHDiscount, seedHMember, seedHOrderUnits, seedHRedemption } from './helpers/group-h-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { ensureFixturePaidAllocation, insertReturnRecord } from './helpers/order-fixtures';
import { seedGroupG1Shipment } from './helpers/group-g1-fixtures';

type Context = { discounts: DiscountDefinition[]; facts: DiscountFacts; refusals: DiscountRefusal[] };
describeLocalDb('H2 checkout context and activation snapshot (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  const context = (user: string | null, email: string | null, codes: string[] = [], phase = 'preview', items: number[] = []) =>
    hRpc<Context>(db(), 'get_checkout_discount_context', [user, email, codes, items, '2026-10-29T00:00:00Z', phase]);

  test('FREQ-544-AC-01: confirmだけが同メールの有料履歴を読みpreviewはメールが違っても同じ見込みを返す', async () => {
    const member = await seedHMember(db(), 'paid@example.invalid');
    await seedHOrderUnits(db(), { legacy: true, buyerUserId: member, email: ' PAID@example.invalid ', lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
    await seedHOrderUnits(db(), { legacy: true, email: 'unpaid@example.invalid', status: 'abandoned', paidAt: null,
      lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
    const id = await seedHDiscount(db(), hDiscount({ method: 'automatic', allowGuests: true, firstOrderOnly: true }));
    await seedHRedemption(db(), id, { email: 'reserved@example.invalid', state: 'reserved', firstOrderOnly: true });
    const previews = await Promise.all(['paid@example.invalid', 'none@example.invalid', 'unpaid@example.invalid', 'reserved@example.invalid'].map(email => context(null, email)));
    expect(previews.every(c => JSON.stringify(c) === JSON.stringify(previews[0]))).toBe(true);
    expect(previews[0].facts).toMatchObject({ buyer: { kind: 'guest', normalizedEmail: null }, hasPreviousOrder: null, hasFirstOrderReservation: null, priorUnitsByItem: {} });
    expect(previews[0].facts.usage.every(u => u.buyerUses === null)).toBe(true);
    expect((await context(null, ' PAID@example.invalid ', [], 'confirm')).facts.hasPreviousOrder).toBe(true);
    for (const email of ['none@example.invalid', 'unpaid@example.invalid']) expect((await context(null, email, [], 'confirm')).facts.hasPreviousOrder).toBe(false);
    expect((await context(null, 'reserved@example.invalid', [], 'acceptance')).facts.hasFirstOrderReservation).toBe(true);
    for (const phase of ['invalid', '', null]) expect(await hFailure(db(), () => hRpc(db(), 'get_checkout_discount_context', [null, null, [], [], new Date().toISOString(), phase])))
      .toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    expect((await context(null, 'paid@example.invalid', ['ABSENT', 'OTHER'])).refusals).toEqual([
      { code: 'ABSENT', reason: 'not_eligible' }, { code: 'OTHER', reason: 'not_eligible' }]);
  });

  test('FREQ-544-AC-02: 会員の前回着数は通常行から成功返金だけ引き交換と未入金を除く', async () => {
    const user = await seedHMember(db());
    const order = await seedHOrderUnits(db(), { legacy: true, buyerUserId: user, lines: [{ itemPrice: 1000, quantity: 3, discounts: [], unitAmounts: [] }] });
    const item = Number((await db().query('select item_id from public.order_items where id=$1', [order.orderItemIds[0]])).rows[0].item_id);
    expect((await context(user, null, [], 'confirm', [item])).facts.priorUnitsByItem[String(item)]).toBe(3);
    for (const status of ['pending', 'error', 'succeeded']) {
      const refund = (await db().query(`insert into public.order_refunds(order_id,source,stripe_refund_id,status,amount,notify_customer)
        values($1,'stripe_dashboard',$2,$3,1000,false) returning id`, [order.orderId, `re_${randomUUID().replaceAll('-', '')}`, status])).rows[0].id as string;
      await db().query(`insert into public.order_refund_lines(refund_id,order_item_id,quantity,before_shipment,restock_type,amount)
        values($1,$2,1,true,'cancel',1000)`, [refund, order.orderItemIds[0]]);
      expect((await context(user, null, [], 'confirm', [item])).facts.priorUnitsByItem[String(item)]).toBe(status === 'succeeded' ? 2 : 3);
    }
    // A real exchange line (line_kind is a guarded legal field, so it cannot be flipped by UPDATE) on a second order.
    const second = await seedHOrderUnits(db(), { legacy: true, buyerUserId: user, lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
    const orderItemId = second.orderItemIds[0];
    await ensureFixturePaidAllocation(db(), [{ order_item_id: orderItemId, quantity: 1 }]);
    const fulfillmentId = await seedGroupG1Shipment(db(), { orderId: second.orderId,
      lines: [{ orderItemId, quantity: 1 }], shippedAt: new Date().toISOString() });
    const secondItem = (await db().query('select item_id,variant_id from public.order_items where id=$1', [orderItemId])).rows[0];
    const returned = await insertReturnRecord(db(), { orderId: second.orderId, lines: [{ fulfillmentId, orderItemId,
      quantity: 1, resolution: 'exchange', exchangeVariantId: secondItem.variant_id, exchangeMethod: 'make' }] });
    await db().query(`insert into public.order_items(order_id,item_id,variant_id,item_name,item_price,
      quantity,line_total,line_kind,exchange_paid_amount,exchange_return_line_id,fulfillment_type)
      values($1,$2,$3,'Exchange',0,4,0,'exchange',0,$4,'backorder')`,
    [second.orderId, secondItem.item_id, secondItem.variant_id, returned.lineIds[0]]);
    // Only the original 1-unit order line counts; the 4-unit exchange line on the same item does not.
    expect((await context(user, null, [], 'confirm', [Number(secondItem.item_id)])).facts.priorUnitsByItem[String(secondItem.item_id)]).toBe(1);
  });

  test('FREQ-544-AC-01: guest previewの有料履歴検索は実行されず会員メールからAを与えない', async () => {
    const member = await seedHMember(db(), 'private@example.invalid');
    const order = await seedHOrderUnits(db(), { legacy: true, buyerUserId: member, email: 'private@example.invalid',
      lines: [{ itemPrice: 1000, quantity: 2, discounts: [], unitAmounts: [] }] });
    const item = Number((await db().query('select item_id from public.order_items where id=$1', [order.orderItemIds[0]])).rows[0].item_id);
    expect((await context(null, 'private@example.invalid', [], 'confirm', [item])).facts.priorUnitsByItem).toEqual({});
    await db().query('savepoint h_preview_canary');
    try {
      await db().query(`alter table public.orders rename to h2_orders_canary_source;
        create function private.h2_history_canary() returns boolean language plpgsql volatile as $$
          begin raise exception 'H_HISTORY_QUERY_FORBIDDEN'; end $$;
        create view public.orders as select * from public.h2_orders_canary_source where private.h2_history_canary()`);
      expect((await context(null, 'private@example.invalid')).facts.hasPreviousOrder).toBeNull();
      expect(await hFailure(db(), () => context(null, 'private@example.invalid', [], 'confirm'))).toMatchObject({ code: 'P0001' });
    } finally { await db().query('rollback to savepoint h_preview_canary'); await db().query('release savepoint h_preview_canary'); }
  });

  test('FREQ-547-AC-04: 保存前contextは候補と重なる設定だけを返しコード文字と個人情報を含めない', async () => {
    const actor = await createPurchaseFlow(db).manager();
    const id = await seedHDiscount(db(), hDiscount({ method: 'automatic', allowGuests: true }));
    const result = await hRpc<{ candidate: Omit<DiscountDefinition, 'id' | 'version'>; existing: DiscountDefinition[] }>(db(),
      'get_admin_discount_activation_context', [null, hDiscount({ method: 'automatic', allowGuests: true }), actor]);
    expect(result.existing.map(d => d.id)).toContain(id); expect(result.candidate).not.toHaveProperty('id');
    for (const key of ['email', 'userIds', 'code', 'createdBy']) expect(result.candidate).not.toHaveProperty(key);
    expect(await hFailure(db(), () => hRpc(db(), 'get_admin_discount_activation_context', [id, { id: randomUUID() }, actor])))
      .toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
  });
});
