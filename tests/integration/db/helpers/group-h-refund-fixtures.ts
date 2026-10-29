import { randomUUID } from 'node:crypto';
import { acceptHCheckout, hDiscount, seedHCheckout, seedHDiscount, seedHMember } from './group-h-fixtures';
import { createCatalogFixture, shipFixtureOrder } from './order-fixtures';
import type { PgClient } from './local-db';

/** Real H3 -> H4 acceptance and payment; each payment has its own intent. */
export async function hRefundFixture(db: PgClient, shipped: boolean | number = false, quantity = 2, unitDiscount = 3000) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  const actor = await seedHMember(db);
  const code = `H5-${randomUUID().toUpperCase()}`;
  const catalog = await createCatalogFixture(db, { stock: quantity });
  const discountId = await seedHDiscount(db, hDiscount({ code, kind: 'repeat', value: { type: 'amount', value: unitDiscount },
    targetMode: 'include', itemIds: [catalog.itemId], minimum: { type: 'amount', value: 40000 },
    repeatInOrder: true, allowGuests: true }));
  const f = await seedHCheckout(db, { discountId, code, lines: [{ catalog, quantity }] });
  const accepted = await acceptHCheckout(db, f);
  if (!accepted.order_id || accepted.rejection) throw new Error('H5_ACCEPTANCE_FAILED');
  const orderId = accepted.order_id;
  // place_order_from_checkout_draft leaves the order in payment_in_progress; pay it from that state.
  const paid = (await db.query("select * from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'payment_received')",
    [orderId, f.paymentIntentId, f.result.totalAmount])).rows[0];
  if (!paid?.updated) throw new Error('H5_PAYMENT_FAILED');
  const itemId = (await db.query('select id from public.order_items where order_id=$1', [orderId])).rows[0].id as string;
  const fulfillment = shipped ? await shipFixtureOrder(db, { orderId, actorId: actor,
    trackingNumber: 'H5-TEST', lines: [{ order_item_id: itemId, quantity: typeof shipped === 'number' ? shipped : quantity }] }) : null;
  return { orderId, itemId, actor, discountId, catalog, f, fulfillment };
}
export type HRefundFixture = Awaited<ReturnType<typeof hRefundFixture>>;
export async function hBegin(db: PgClient, f: HRefundFixture, amount: number, before = false, key = randomUUID(), quantity = 1) {
  return (await db.query(`select * from public.begin_order_refund($1,'admin',$2,$3::jsonb,false,0,$4,null,'requested_by_customer',null,false,$5)`,
    [f.orderId, key, JSON.stringify([{ order_item_id: f.itemId, before_shipment: before, quantity }]), amount, f.actor])).rows[0] as { refund_id: string; amount: number; replayed: boolean };
}
export async function hResult(db: PgClient, id: string, status: 'pending' | 'succeeded' | 'failed') {
  return (await db.query("select * from public.record_order_refund_result($1,$2,$3,null,$4,null,'card',null,null)",
    [id, `re_${id.replaceAll('-', '')}`, status, status === 'failed' ? 'lost_or_stolen_card' : null])).rows[0];
}
export async function hReturn(db: PgClient, f: HRefundFixture, quantity = 1, exchange = false) {
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222' where id=1`);
  const r = (await db.query(`select * from public.admin_create_return($1,$2,$3,$4::jsonb,'customer_ships','customer',null,null,0,0,0,0,null,false)`,
    [f.orderId, f.actor, randomUUID(), JSON.stringify([{ fulfillment_id: f.fulfillment?.fulfillment_id, order_item_id: f.itemId, quantity,
      reason: 'unknown', reason_note: null, resolution: exchange ? 'exchange' : 'refund',
      exchange_variant_id: exchange ? f.catalog.variantId : null, exchange_method: exchange ? 'make' : null }])])).rows[0];
  const lineId = (await db.query('select id from public.order_return_lines where return_id=$1', [r.return_id])).rows[0].id as string;
  return { returnId: r.return_id as string, lineId };
}
export async function hReceive(db: PgClient, f: HRefundFixture, r: Awaited<ReturnType<typeof hReturn>>, quantity = 1, choice = 'consult') {
  return (await db.query(`select * from public.admin_receive_return($1,$2,true,$3,$4::jsonb,'[]'::jsonb,$5,null,0,null,false,null,null,null)`,
    [r.returnId, f.actor, randomUUID(), JSON.stringify([{ return_line_id: r.lineId, disposition: 'not_restocked', quantity }]), choice])).rows[0];
}
export const hClaims = async (db: PgClient, item: string) => (await db.query(`select paid_amount,refund_id,refund_before_shipment,return_line_id
  from public.order_line_unit_amounts where order_item_id=$1 order by paid_amount,unit_index`, [item])).rows;
