import { randomUUID } from 'node:crypto';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { PgClient } from './local-db';
import { createCatalogFixture } from './order-fixtures';
import type { DiscountDefinition } from '@/lib/discounts/discount-types';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import type { DiscountFacts, DiscountRefusal } from '@/lib/discounts/discount-types';
import type { CheckoutDiscountClaim, CheckoutDiscountDraft } from '@/features/checkout/services/checkout-draft.service';
import { createHash } from 'node:crypto';

export type DiscountSeed = Omit<DiscountDefinition, 'id' | 'version'> & { code?: string; userIds?: readonly string[] };
export type HOrderSeed = {
  lines: readonly { itemPrice: number; quantity: number; discounts: readonly { discountId: string; amount: number }[];
    unitAmounts: readonly number[]; catalog?: HCatalog }[];
  legacy: boolean; buyerUserId?: string; email?: string; paidAt?: string | null; status?: OrderStatus;
};

export const hDiscount = (overrides: Partial<DiscountSeed> = {}): DiscountSeed => ({
  name: 'H fixture', kind: 'product', method: 'code', value: { type: 'percent', value: 10 },
  targetMode: 'all', itemIds: [], minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: false,
  firstOrderOnly: false, usageLimit: null, oncePerCustomer: false, startsAt: '2026-01-01T00:00:00Z', endsAt: null,
  stopped: false, combinesWithProduct: false, combinesWithOrder: false, advertise: false, advertisingText: null,
  repeatPrevious: false, repeatInOrder: false, ...overrides,
});

/** Execute only an explicitly named H entry, as the real service role; no JWT/session fixture. */
export async function hRpc<T = unknown>(client: PgClient, name: string, args: unknown[]): Promise<T> {
  if (!/^(admin_(create|update|set|duplicate|assign|unassign|generate)_discount(?:_stopped|_codes)?|list_admin_discounts|get_admin_discount|search_admin_discount_members|get_checkout_discount_context|record_discount_search_fallback|get_admin_discount_activation_context)$/.test(name)) throw new Error('H_RPC_NAME_INVALID');
  await client.query('set local role service_role');
  // An error leaves the transaction aborted; hFailure/the race's savepoint restores the role too.
  const row = (await client.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`,
    args.map(v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v))).rows[0];
  await client.query('reset role');
  return row.result as T;
}

/** Keep expected diagnostics fixed and recover the transaction without exposing raw DB text. */
export async function hFailure(client: PgClient, run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  await client.query('savepoint h_expected_failure');
  try { await run(); return {}; }
  catch (caught) { const e = caught as { code?: string; message?: string }; return { code: e.code,
    message: /^GROUP_H_[A-Z_]+$/.test(e.message ?? '') ? e.message : 'H_UNEXPECTED_DB_ERROR' }; }
  finally { await client.query('rollback to savepoint h_expected_failure'); await client.query('release savepoint h_expected_failure'); }
}

/** An actual auth member, never a JWT or customer metadata used for authority. */
export async function seedHMember(client: PgClient, email = `h-${randomUUID()}@example.invalid`): Promise<string> {
  const id = randomUUID();
  await client.query("insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values($1,$2,'{}','{}')", [id, email]);
  return id;
}

/** Reservation fixture only: Task 7 replaces the paired race with the real acceptance entry. */
export async function seedHRedemption(client: PgClient, discountId: string, input: {
  state: 'reserved' | 'confirmed' | 'cancelled'; codeId?: string; userId?: string; email?: string;
  reservedAt?: string; firstOrderOnly?: boolean;
}): Promise<{ id: string; orderId: string }> {
  const order = await seedHOrderUnits(client, { legacy: true, buyerUserId: input.userId, email: input.email,
    status: input.state === 'confirmed' ? 'paid' : 'pending', paidAt: input.state === 'confirmed' ? new Date().toISOString() : null,
    lines: [{ itemPrice: 1000, quantity: 1, discounts: [], unitAmounts: [] }] });
  const email = input.email?.trim().toLowerCase() ?? `h-${randomUUID()}@example.invalid`;
  const identity = input.userId ? `member:${input.userId}` : `guest:${email}`;
  const row = (await client.query(`insert into public.discount_redemptions
    (discount_id,code_id,order_id,user_id,identity_key,normalized_email,state,reserved_at,confirmed_at,cancelled_at,
      name_snapshot,code_snapshot,class_snapshot,amount,first_order_only_snapshot)
    select d.id,$2,$3,$4,$5,$6,$7,$8,case when $7='confirmed' then $8::timestamptz end,
      case when $7='cancelled' then $8::timestamptz end,d.name,c.code,
      case when d.kind in ('order_percent','order_amount') then 'order' else 'product' end,100,$9
    from public.discounts d left join public.discount_codes c on c.id=$2 where d.id=$1 returning id`,
  [discountId, input.codeId ?? null, order.orderId, input.userId ?? null, identity, email, input.state,
    input.reservedAt ?? new Date().toISOString(), input.firstOrderOnly ?? false])).rows[0];
  return { id: row.id as string, orderId: order.orderId };
}

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
    const catalog = line.catalog ?? await createCatalogFixture(client);
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

/** H1 is a historical assertion: remove the H2 additions it never knew. The caller's savepoint must restore them. */
export async function dropH2Additions(client: PgClient): Promise<void> {
  await client.query(`drop trigger if exists h2_assignment_identity on public.discount_assignments;
    alter table public.discount_assignments drop column if exists original_user_id;
    alter table public.discount_codes drop column if exists unassigned_at`);
}

/** Pin the pre-H1 permission state BEFORE a caller tampers with the applied catalog. */
export async function withH1PermissionBaseline(client: PgClient, assertSql: string): Promise<void> {
  await dropH2Additions(client);
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

export type HCatalog = Awaited<ReturnType<typeof createCatalogFixture>>;

/**
 * Real frozen H3 material; the acceptance tests never fabricate frozen JSON or disable guards.
 * `lines` defaults to one line of 2 units at 20000; pass catalogs created earlier to target items from a discount definition.
 */
export async function seedHCheckout(client: PgClient, input: { discountId?: string; code?: string; userId?: string; email?: string;
  lines?: readonly { catalog?: HCatalog; quantity: number }[] } = {}) {
  const sessionId = `h4-${randomUUID()}`, checkoutSessionId = `cs_test_h4${randomUUID().replaceAll('-', '')}`;
  // create-session stores the shipping email trimmed and lower-cased (checkoutShippingSchema); do the same here.
  const email = (input.email ?? `h4-${randomUUID()}@example.invalid`).trim().toLowerCase();
  // A member owns one cart (carts_user_id_key); a second draft for the same member reuses it.
  const cartId = (input.userId ? (await client.query('select id from public.carts where user_id=$1', [input.userId])).rows[0]?.id as string | undefined : undefined)
    ?? (await client.query('insert into public.carts(user_id,guest_token_hash) values($1,$2) returning id',
      [input.userId ?? null, input.userId ? null : createHash('sha256').update(sessionId).digest('hex')])).rows[0].id as string;
  const specs = input.lines ?? [{ quantity: 2 }];
  const built: { catalog: HCatalog; lineId: string; quantity: number }[] = [];
  for (const spec of specs) {
    const catalog = spec.catalog ?? await createCatalogFixture(client);
    await client.query('update public.items set price=20000 where id=$1', [catalog.itemId]);
    const lineId = (await client.query('insert into public.cart_lines(cart_id,variant_id,quantity) values($1,$2,$3) returning id', [cartId, catalog.variantId, spec.quantity])).rows[0].id as string;
    built.push({ catalog, lineId, quantity: spec.quantity });
  }
  const catalog = built[0].catalog;
  const subtotal = built.reduce((sum, line) => sum + 20000 * line.quantity, 0);
  const context = await hRpc<{ discounts: DiscountDefinition[]; facts: DiscountFacts; refusals: DiscountRefusal[] }>(client,
    'get_checkout_discount_context', [input.userId ?? null, email, input.code ? [input.code] : [], built.map(line => line.catalog.itemId), new Date(), 'confirm']);
  const discounts = input.discountId ? context.discounts.filter(d => d.id === input.discountId) : [];
  const facts: DiscountFacts = { ...context.facts, usage: context.facts.usage.filter(u => discounts.some(d => d.id === u.discountId)) };
  const result = calculateDiscounts({ lines: built.map(line => ({ lineKey: line.lineId, itemId: line.catalog.itemId, unitPrice: 20000, quantity: line.quantity, lineKind: 'order' as const })),
    codes: input.code ? [input.code] : [], discounts, facts });
  const claim: CheckoutDiscountClaim = { sessionId, requestVersion: 1, requestFingerprint: `v1:${'b'.repeat(64)}`, checkoutUiMode: 'custom', checkoutOrigin: 'https://shop.example.invalid', paymentMethod: 'stripe_card', currency: 'jpy', subtotalAmount: subtotal, taxAmount: 0, shippingAmount: 0, totalAmount: subtotal,
    shippingSnapshot: { email, fullName: 'Fixture', kanaName: null, postalCode: '1000001', prefecture: 'Tokyo', city: 'City', address: '1-1', building: null, phone: '0312345678' },
    itemsSnapshot: built.map(line => ({ source_cart_line_id: line.lineId, item_id: line.catalog.itemId, item_name: 'Fixture', item_price: 20000, quantity: line.quantity, line_total: 20000 * line.quantity, color: 'BLACK', size: 'M', item_image_url: null })),
    buyerUserId: input.userId ?? null, cartId };
  await client.query('set local role service_role');
  const saved = (await client.query('select public.claim_checkout_discount_draft($1::jsonb,$2::jsonb,$3::jsonb) result', [JSON.stringify(claim), JSON.stringify(result), JSON.stringify(facts)])).rows[0].result as CheckoutDiscountDraft;
  await client.query('reset role');
  await client.query('update public.checkout_drafts set checkout_session_id=$2 where id=$1', [saved.draftId, checkoutSessionId]);
  return { ...saved, checkoutSessionId, sessionId, paymentIntentId: `pi_${checkoutSessionId.slice(3)}`, result, facts, claim, catalog, catalogs: built.map(line => line.catalog), userId: input.userId ?? null };
}
export async function acceptHCheckout(client: PgClient, f: Awaited<ReturnType<typeof seedHCheckout>>, state?: 'paid' | 'awaiting_payment') {
  await client.query('set local role service_role');
  const fn = state ? 'place_reconciled_order_from_checkout_draft' : 'place_order_from_checkout_draft';
  const args = [f.draftId, f.checkoutSessionId, f.sessionId, f.result.totalAmount, f.result.discountAmount, 'jpy', new Date(), f.paymentIntentId, ...(state ? [state] : [[], f.userId])];
  const row = (await client.query(`select * from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args)).rows[0] as { order_id: string | null; order_status: OrderStatus | null; created: boolean; rejection: string | null };
  await client.query('reset role'); return row;
}
