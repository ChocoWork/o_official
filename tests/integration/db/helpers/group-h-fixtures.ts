import { randomUUID } from 'node:crypto';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { PgClient } from './local-db';
import { createCatalogFixture } from './order-fixtures';

// Task 2 owns the production type; keep this fixture contract identical until it exists.
type DiscountDefinition = {
  id: string; version: string; name: string; kind: 'order_percent' | 'order_amount' | 'product' | 'repeat' | 'set';
  method: 'code' | 'automatic'; value: { type: 'percent' | 'amount'; value: number };
  targetMode: 'all' | 'exclude' | 'include'; itemIds: readonly number[];
  minimum: { type: 'none'; value: 0 } | { type: 'amount' | 'quantity'; value: number };
  audience: 'assigned' | 'anyone'; allowGuests: boolean; firstOrderOnly: boolean; usageLimit: number | null;
  oncePerCustomer: boolean; startsAt: string; endsAt: string | null; stopped: boolean;
  combinesWithProduct: boolean; combinesWithOrder: boolean; advertise: boolean; advertisingText: string | null;
  repeatPrevious: boolean; repeatInOrder: boolean;
};
export type DiscountSeed = Omit<DiscountDefinition, 'id' | 'version'> & { code?: string; userIds?: readonly string[] };
export type HOrderSeed = {
  lines: readonly { itemPrice: number; quantity: number; discounts: readonly { discountId: string; amount: number }[];
    unitAmounts: readonly number[] }[];
  legacy: boolean; buyerUserId?: string; email?: string; paidAt?: string | null; status?: OrderStatus;
};

export const hDiscount = (overrides: Partial<DiscountSeed> = {}): DiscountSeed => ({
  name: 'H fixture', kind: 'product', method: 'code', value: { type: 'percent', value: 10 },
  targetMode: 'all', itemIds: [], minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: false,
  firstOrderOnly: false, usageLimit: null, oncePerCustomer: false, startsAt: '2026-01-01T00:00:00Z', endsAt: null,
  stopped: false, combinesWithProduct: false, combinesWithOrder: false, advertise: false, advertisingText: null,
  repeatPrevious: false, repeatInOrder: false, ...overrides,
});

/** Transaction-owned material, written as postgres; never bypass H guards or disable triggers. */
export async function seedHDiscount(client: PgClient, input: DiscountSeed): Promise<string> {
  const id = (await client.query(`insert into public.discounts
    (name,kind,method,value_type,value,target_mode,minimum_type,minimum_value,audience,allow_guests,
     first_order_only,usage_limit,once_per_customer,starts_at,ends_at,stopped,combines_with_product,
     combines_with_order,advertise,advertising_text,repeat_previous,repeat_in_order,creation_request_key,creation_request_hash)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
  [input.name, input.kind, input.method, input.value.type, input.value.value, input.targetMode, input.minimum.type,
    input.minimum.value, input.audience, input.allowGuests, input.firstOrderOnly, input.usageLimit, input.oncePerCustomer,
    input.startsAt, input.endsAt, input.stopped, input.combinesWithProduct, input.combinesWithOrder, input.advertise,
    input.advertisingText, input.repeatPrevious, input.repeatInOrder, randomUUID(), 'a'.repeat(64)])).rows[0].id as string;
  for (const itemId of input.itemIds) await client.query('insert into public.discount_items(discount_id,item_id) values($1,$2)', [id, itemId]);
  if (input.code) {
    const code = (await client.query(`insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use)
      values($1,$2,$3,$4,false) returning id`, [id, input.code, input.audience, input.allowGuests])).rows[0].id as string;
    for (const userId of input.userIds ?? []) await client.query(
      'insert into public.discount_assignments(discount_id,code_id,user_id) values($1,$2,$3)', [id, code, userId]);
  }
  return id;
}

/** Each test rolls the surrounding transaction back, including the catalog and order material. */
export async function seedHOrderUnits(client: PgClient, input: HOrderSeed): Promise<{ orderId: string; orderItemIds: string[] }> {
  const subtotal = input.lines.reduce((sum, line) => sum + line.itemPrice * line.quantity, 0);
  const discount = input.lines.reduce((sum, line) => sum + line.discounts.reduce((n, d) => n + d.amount, 0), 0);
  const orderId = (await client.query(`insert into public.orders
    (session_id,checkout_session_id,status,subtotal_amount,shipping_amount,discount_amount,total_amount,currency,
     user_id,paid_at,shipping_email,shipping_full_name,shipping_postal_code,shipping_prefecture,shipping_city,shipping_address,shipping_phone)
    values($1,$2,$3,$4,0,$5,$6,'jpy',$7,$8,$9,'Fixture','1500001','Tokyo','Tokyo','Fixture','0311112222') returning id`,
  [`h-${randomUUID()}`, `cs_h_${randomUUID()}`, input.status ?? 'paid', subtotal, discount, subtotal - discount,
    input.buyerUserId ?? null, input.paidAt === undefined ? new Date().toISOString() : input.paidAt, input.email ?? 'h@example.invalid'])).rows[0].id as string;
  const orderItemIds: string[] = [];
  for (const line of input.lines) {
    const catalog = await createCatalogFixture(client);
    const itemId = (await client.query(`insert into public.order_items
      (order_id,item_id,item_name,item_price,quantity,line_total,variant_id,fulfillment_type)
      values($1,$2,'H fixture',$3,$4,$5,$6,'backorder') returning id`,
    [orderId, catalog.itemId, line.itemPrice, line.quantity, line.itemPrice * line.quantity, catalog.variantId])).rows[0].id as string;
    orderItemIds.push(itemId);
    if (!input.legacy) {
      for (const d of line.discounts) await client.query(`insert into public.order_line_discount_allocations
        (order_id,order_item_id,discount_id,amount) values($1,$2,$3,$4)`, [orderId, itemId, d.discountId, d.amount]);
      for (const [index, amount] of line.unitAmounts.entries()) await client.query(`insert into public.order_line_unit_amounts
        (order_id,order_item_id,unit_index,paid_amount) values($1,$2,$3,$4)`, [orderId, itemId, index, amount]);
    }
  }
  return { orderId, orderItemIds };
}

/** Pin the pre-H1 permission state BEFORE a caller tampers with the applied catalog. */
export async function withH1PermissionBaseline(client: PgClient, assertSql: string): Promise<void> {
  await client.query(`create temp table group_h_permission_baseline(payload jsonb) on commit drop;
    insert into pg_temp.group_h_permission_baseline(payload) select jsonb_build_object(
      'permissions',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.permissions p
        where p.code not in ('admin.discounts.read','admin.discounts.manage')),'[]'::jsonb),
      'role_permissions',coalesce((select jsonb_agg(to_jsonb(rp) order by rp.role_id,rp.permission_id)
        from public.role_permissions rp join public.permissions p on p.id=rp.permission_id
        where p.code not in ('admin.discounts.read','admin.discounts.manage')),'[]'::jsonb),
      'roles',(select jsonb_agg(jsonb_build_object('id',r.id,'code',r.code,'permissions_version',
        r.permissions_version-case when r.code='admin' then 1 else 0 end) order by r.id) from public.roles r),
      'h_permissions',0,'h_grants',0)`);
  await client.query(assertSql);
}
