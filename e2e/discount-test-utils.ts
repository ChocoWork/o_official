/**
 * H E2E: local production HTTP -> public RPC. No application discount route is mocked.
 * Stripe Session/coupon creation stays in test mode; recordPaid/refund result are DB fixtures.
 * Only mockOwnDiscountPreview and the explicit fallback display injection replace business responses.
 * Cookie/token/mail values must never be logged or put in Playwright assertion diffs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import Stripe from 'stripe';
import { isLocalUrl } from '../scripts/e2e/environment';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { createCatalogFixture, insertRestockMovement, shipFixtureOrder } from '../tests/integration/db/helpers/order-fixtures';
import { seedGroupG4MixedOrder } from '../tests/integration/db/helpers/group-g4-fixtures';
import { seedFactSlip } from '../tests/integration/db/helpers/accounting-orders-fixtures';
import { cancelPlanFor } from '../tests/integration/db/helpers/group-h-refund-fixtures';
import { searchBestDiscountPlan } from '@/lib/discounts/discount-search';
import type { DiscountDefinition, DiscountFacts, DiscountResult } from '@/lib/discounts/discount-types';
import type { AdminDiscountDetail, DiscountCreateInput, DiscountPatch } from '@/lib/discounts/admin-discount-types';
import type { AdminOrderDetail } from '@/lib/orders/admin-orders/admin-order-types';
import type { CheckoutConfirmation } from '@/features/checkout/services/checkout-confirmation.service';
import type { CartJson } from '@/features/cart/types/cart-json';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';
import type { RefundMaterials } from '@/lib/orders/refund/refund-types';
import { refundLineAmount } from '@/lib/orders/refund/refund-allocation';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';
import { composeOrderEmail, loadOrderEmailMaterial } from '@/lib/orders/email/order-email-compose';
import { createAdminSessionActor, type AdminSessionActor, type AdminSessionRole, type AdminSessionAal } from './admin-session-test-utils';
import { withOrderAdminScenario } from './order-admin-test-utils';
import { withGroupG1Material } from './group-g1-test-utils';
import { withPermissionScenario, readRolePermissionState, saveRolePermissionsInDb } from './permission-settings-test-utils';

const ORIGIN = 'http://localhost:3000';
export const GUEST_REFUSAL = 'このコードは使えません。会員の方はログインしてからお試しください。';
export type Buyer = 'member' | 'otherMember' | 'guest';
type Who = Buyer | 'admin' | AdminSessionActor;
export type DiscountDraft = { draftId: string; sessionId: string; cartSessionId: string };
type ApiBody = { result?: DiscountResult; confirmation?: CheckoutConfirmation; message?: string; orderId?: string; definitive?: boolean; returnTo?: string };
type Reply<T> = { status: number; body: T; cacheControl: string };
type Catalog = Awaited<ReturnType<typeof createCatalogFixture>>;
type CartLine = Pick<Catalog, 'itemId' | 'variantId'> & { quantity: number };
type Frozen = { discount_result: DiscountResult; discount_facts: DiscountFacts; total_amount: number; checkout_session_id: string; session_id: string; items_snapshot: Array<{ source_cart_line_id: string; item_id: number; item_price: number; quantity: number }> };
type Context = { discounts: DiscountDefinition[]; facts: DiscountFacts };

function localEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !isLocalUrl(url)) throw new Error('H fixtures require local Supabase');
  return { url, key };
}
function stripeClient(): Stripe {
  localEnv();
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_test_/.test(key)) throw new Error('H checkout requires test-mode Stripe');
  return new Stripe(key);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Independent defaults; expected calculations in specs are literal yen amounts. */
export function discountInput(overrides: Partial<DiscountCreateInput> = {}): DiscountCreateInput {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  return { name: `H11 ${suffix}`, kind: 'product', method: 'code', value: { type: 'percent', value: 10 },
    targetMode: 'all', itemIds: [], minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: true,
    firstOrderOnly: false, usageLimit: null, oncePerCustomer: false, startsAt: '2026-01-01T00:00:00.000Z', endsAt: null,
    stopped: false, combinesWithProduct: false, combinesWithOrder: false, advertise: false, advertisingText: null,
    repeatPrevious: false, repeatInOrder: false, code: `H11-${suffix}`, codeMode: 'shared', ...overrides };
}

export class DiscountScenario {
  readonly ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  readonly prefix = `H11${randomUUID().slice(0, 8).toUpperCase()}`;
  readonly guestEmail = `h11-${randomUUID()}@example.invalid`;
  readonly memberId: string;
  readonly otherMemberId: string;
  private readonly actors: AdminSessionActor[];
  private readonly clients = new Map<string, APIRequestContext>();
  private readonly csrf = new Map<string, string>();
  private readonly cartSessions = new Map<string, string>();
  private readonly guestToken = randomBytes(32).toString('base64url');
  private readonly discounts = new Set<string>();
  private readonly orders = new Set<string>();
  private readonly drafts = new Set<string>();
  private readonly pages = new Set<Page>();
  private readonly catalogIds = new Set<number>();
  private readonly nextRequest = new Map<string, number>();
  private cleaned = false;

  constructor(readonly db: PgClient, readonly admin: AdminSessionActor, readonly member: AdminSessionActor, readonly otherMember: AdminSessionActor,
    private readonly trackOrder: (id: string) => void = () => undefined) {
    localEnv();
    this.actors = [admin, member, otherMember];
    this.memberId = member.userId; this.otherMemberId = otherMember.userId;
  }
  private rememberOrder(id: string): void { this.orders.add(id); this.trackOrder(id); }
  private resolve(who: Who): AdminSessionActor | null {
    return typeof who !== 'string' ? who : who === 'guest' ? null : this[who];
  }
  private identity(who: Who): string { return this.resolve(who)?.userId ?? 'guest'; }
  private cartSession(who: Who): string {
    const id = this.identity(who);
    if (!this.cartSessions.has(id)) this.cartSessions.set(id, randomUUID());
    return this.cartSessions.get(id)!;
  }
  async actor(role: AdminSessionRole, aal: AdminSessionAal): Promise<AdminSessionActor> {
    const actor = await createAdminSessionActor(this.db, role, aal);
    this.actors.push(actor); return actor;
  }
  private async cookies(who: Who, cartSessionId = this.cartSession(who)) {
    const actor = this.resolve(who);
    const entries: Array<[string, string]> = [['session_id', cartSessionId]];
    if (actor) {
      let csrf = this.csrf.get(actor.userId);
      if (!csrf) {
        csrf = randomBytes(32).toString('hex'); this.csrf.set(actor.userId, csrf);
        await this.db.query('update public.sessions set csrf_token_hash=$1 where auth_session_id=$2', [hash(csrf), actor.sessionId]);
      }
      entries.push(['sb-access-token', actor.accessToken], ['sb-refresh-token', actor.refreshToken], ['sb-csrf-token', csrf]);
    } else entries.push(['cart', this.guestToken]);
    return entries.map(([name, value]) => ({ name, value, domain: 'localhost', path: '/', httpOnly: name !== 'sb-csrf-token', secure: false, sameSite: 'Lax' as const, expires: -1 }));
  }
  private async client(who: Who): Promise<APIRequestContext> {
    const id = this.identity(who);
    let client = this.clients.get(id);
    if (!client) {
      const cookies = await this.cookies(who);
      client = await request.newContext({ baseURL: ORIGIN, storageState: { cookies, origins: [] },
        extraHTTPHeaders: { origin: ORIGIN, 'x-real-ip': this.ip, ...(this.csrf.has(id) ? { 'x-csrf-token': this.csrf.get(id)! } : {}) }, timeout: 30_000 });
      this.clients.set(id, client);
    }
    return client;
  }
  /** Pace real requests below the unchanged preview IP/session/member limits; never retry a failed write. */
  async pace(who: Who, path: string): Promise<void> {
    if (!path.endsWith('/promotion-code')) return;
    const id = this.identity(who), now = Date.now(), next = this.nextRequest.get(id) ?? now;
    this.nextRequest.set(id, Math.max(now, next) + 6_100);
    if (next > now) await new Promise(resolve => setTimeout(resolve, next - now));
  }
  async api<T = ApiBody>(who: Who, path: string, method = 'GET', data?: unknown): Promise<Reply<T>> {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('H HTTP path refused');
    await this.pace(who, path);
    // pace waits 6.1s, past the server's 5s keep-alive: a reused idle socket can be reset mid-request
    const response = await (await this.client(who)).fetch(path, { method, headers: { connection: 'close' }, ...(data === undefined ? {} : { data }) });
    try {
      const text = await response.text(); // all statuses, including 401/403/429/500
      let body: T;
      try { body = (text ? JSON.parse(text) : null) as T; } catch { throw new Error(`H HTTP unreadable JSON (${response.status()})`); }
      return { status: response.status(), body, cacheControl: response.headers()['cache-control'] ?? '' };
    } finally { await response.dispose(); }
  }
  /** Public PostgREST only, service-role fixture boundary, with a fixed name allowlist. */
  async rpc<T>(name: string, data: Record<string, unknown>): Promise<T> {
    const names = ['mark_order_paid', 'place_reconciled_order_from_checkout_draft', 'mark_order_awaiting_payment', 'release_stock_for_unpaid_order',
      'get_checkout_discount_context', 'record_discount_search_fallback', 'begin_order_refund', 'record_order_refund_result', 'admin_refund_return', 'get_order_discount_breakdown', 'admin_set_discount_stopped'];
    if (!names.includes(name)) throw new Error('H RPC refused');
    const { url, key } = localEnv();
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
    const raw = await response.text().catch(async () => { await response.body?.cancel().catch(() => undefined); throw new Error('H RPC body unreadable'); });
    if (!response.ok) { let code = ''; try { code = String((JSON.parse(raw) as { code?: string }).code ?? ''); } catch { /* no JSON error body */ } throw new Error(`H fixture RPC ${name} refused (${response.status} ${code})`); }
    if (raw === '') return undefined as T; // void functions answer 204 with no body
    try { return JSON.parse(raw) as T; } catch { throw new Error('H RPC JSON unreadable'); }
  }
  trackDiscount(id: string): void { this.discounts.add(id); }
  async createDiscount(input: DiscountCreateInput): Promise<string> {
    const reply = await this.api<{ data: { discountId: string } }>('admin', '/api/admin/discounts', 'POST', { input, requestKey: randomUUID() });
    if (reply.status !== 201 || !reply.body.data?.discountId) throw new Error(`H create refused (${reply.status})`);
    this.trackDiscount(reply.body.data.discountId); return reply.body.data.discountId;
  }
  async detail(id: string): Promise<AdminDiscountDetail> {
    const reply = await this.api<{ data: AdminDiscountDetail }>('admin', `/api/admin/discounts/${id}`);
    if (reply.status !== 200) throw new Error(`H detail refused (${reply.status})`);
    return reply.body.data;
  }
  async update(id: string, patch: DiscountPatch, who: Who = 'admin') {
    return this.api(who, `/api/admin/discounts/${id}`, 'PATCH', { patch, expectedVersion: (await this.detail(id)).discount.version, requestKey: randomUUID() });
  }
  async stop(id: string): Promise<void> {
    const detail = await this.detail(id);
    if (detail.discount.stopped) return;
    const reply = await this.api('admin', `/api/admin/discounts/${id}/stop`, 'POST', { expectedVersion: detail.discount.version, requestKey: randomUUID() });
    if (reply.status !== 200) throw new Error(`H stop refused (${reply.status})`);
  }
  async stopAll(): Promise<void> { for (const id of this.discounts) await this.stop(id); }
  async item(price: number): Promise<Catalog> {
    const item = await createCatalogFixture(this.db, { stock: 100 });
    await this.db.query('update public.items set price=$1 where id=$2', [price, item.itemId]);
    this.catalogIds.add(item.itemId); return item;
  }
  async variant(item: Catalog): Promise<Catalog> {
    const row = (await this.db.query("insert into public.item_sizes(item_id,label,position) values($1,'L',1) returning id", [item.itemId])).rows[0];
    const color = (await this.db.query('select color_id from public.item_variants where id=$1', [item.variantId])).rows[0];
    const variant = (await this.db.query('insert into public.item_variants(item_id,color_id,size_id,is_active) values($1,$2,$3,true) returning id', [item.itemId, color.color_id, row.id])).rows[0];
    await insertRestockMovement(this.db, Number(variant.id), 100);
    return { ...item, variantId: Number(variant.id), sizeLabel: 'L' };
  }
  /** Own cart only; one cart per member. HTTP readers and all discount calculations remain real. */
  async cart(who: Buyer, lines: readonly CartLine[]): Promise<void> {
    const userId = this.resolve(who)?.userId ?? null;
    const guestHash = userId ? null : hash(this.guestToken);
    await this.db.query('begin');
    try {
      let id = (await this.db.query('select id from public.carts where user_id=$1 or ($1::uuid is null and guest_token_hash=$2)', [userId, guestHash])).rows[0]?.id;
      if (!id) id = (await this.db.query('insert into public.carts(user_id,guest_token_hash) values($1,$2) returning id', [userId, guestHash])).rows[0].id;
      await this.db.query('delete from public.cart_lines where cart_id=$1', [id]);
      for (const line of lines) await this.db.query('insert into public.cart_lines(cart_id,variant_id,quantity) values($1,$2,$3)', [id, line.variantId, line.quantity]);
      await this.db.query('commit');
    } catch { await this.db.query('rollback'); throw new Error('H cart fixture failed'); }
    // A fresh purchase starts a fresh checkout browser session, while keeping the member's single cart.
    // Otherwise a fixture-paid previous order is correctly returned as order_already_placed by create-session.
    const identity = this.identity(who), client = this.clients.get(identity);
    if (client) await client.dispose();
    this.clients.delete(identity); this.cartSessions.set(identity, randomUUID());
  }
  async cartView(buyer: Buyer): Promise<CartJson> {
    const reply = await this.api<CartJson>(buyer, '/api/cart');
    if (reply.status !== 200) throw new Error(`H cart read refused (${reply.status})`);
    return reply.body;
  }
  preview(codes: readonly string[], buyer: Buyer, guestEmail?: string) {
    return this.api(buyer, '/api/checkout/promotion-code', 'POST', { codes, ...(guestEmail ? { guestEmail } : {}) });
  }
  async confirm(codes: readonly string[], buyer: Buyer) {
    const cart = await this.cartView(buyer);
    const email = buyer === 'guest' ? this.guestEmail : this.resolve(buyer)!.email;
    const reply = await this.api(buyer, '/api/checkout/create-session', 'POST', { promotionCodes: codes, uiMode: 'custom', paymentMethod: 'stripe_card',
      displayedAmounts: { subtotalAmount: cart.items_subtotal_price, taxAmount: 0, shippingAmount: 0, totalAmount: cart.items_subtotal_price },
      shipping: { email, fullName: '山田花子', kanaName: 'ヤマダハナコ', postalCode: '1500001', prefecture: '東京都', city: '渋谷区', address: '神宮前1-2-3', phone: '0312345678' } });
    if (reply.status === 200 && reply.body.confirmation) await this.findDraft(reply.body.confirmation.checkoutSessionId);
    return reply;
  }
  async createDraft(codes: readonly string[], buyer: 'member' | 'guest'): Promise<{ draftId: string; sessionId: string }>;
  async createDraft(codes: readonly string[], buyer: Buyer): Promise<DiscountDraft>;
  async createDraft(codes: readonly string[], buyer: Buyer): Promise<DiscountDraft> {
    const reply = await this.confirm(codes, buyer);
    if (reply.status !== 200 || !reply.body.confirmation) throw new Error(`H confirm refused (${reply.status})`);
    return this.findDraft(reply.body.confirmation.checkoutSessionId);
  }
  async findDraft(sessionId: string): Promise<DiscountDraft> {
    const row = (await this.db.query('select id,session_id from public.checkout_drafts where checkout_session_id=$1', [sessionId])).rows[0];
    if (!row) throw new Error('H draft missing');
    this.drafts.add(row.id as string);
    return { draftId: row.id as string, sessionId, cartSessionId: row.session_id as string };
  }
  async latestDraft(buyer: Buyer): Promise<DiscountDraft> {
    const row = (await this.db.query('select checkout_session_id from public.checkout_drafts where session_id=$1 and checkout_session_id is not null order by created_at desc limit 1', [this.cartSession(buyer)])).rows[0];
    if (!row) throw new Error('H latest draft missing');
    return this.findDraft(row.checkout_session_id as string);
  }
  async forkDraft(codes: readonly string[], buyer: Buyer): Promise<DiscountDraft> {
    const id = this.identity(buyer);
    const old = this.clients.get(id); if (old) await old.dispose(); this.clients.delete(id);
    this.cartSessions.set(id, randomUUID());
    return this.createDraft(codes, buyer);
  }
  async frozen(id: string): Promise<Frozen> {
    const row = (await this.db.query('select discount_result,discount_facts,total_amount,checkout_session_id,session_id,items_snapshot from public.checkout_drafts where id=$1', [id])).rows[0];
    if (!row) throw new Error('H frozen draft missing'); return row as Frozen;
  }
  async place(draft: { draftId: string; sessionId: string }, buyer: Buyer): Promise<Reply<ApiBody>> {
    const row = await this.frozen(draft.draftId);
    const headers = { cookie: (await this.cookies(buyer, row.session_id)).map(c => `${c.name}=${c.value}`).join('; '),
      'x-csrf-token': this.csrf.get(this.identity(buyer)) ?? '', connection: 'close' };
    const response = await (await this.client(buyer)).post('/api/checkout/place-order', { headers, data: { checkoutSessionId: draft.sessionId, inStockVariantIds: await this.inStockIds(draft.draftId) } });
    try {
      const body = await response.json() as ApiBody;
      if (body.orderId) this.rememberOrder(body.orderId);
      return { status: response.status(), body, cacheControl: response.headers()['cache-control'] ?? '' };
    } finally { await response.dispose(); }
  }
  async inStockIds(draftId: string): Promise<number[]> {
    const rows = await this.db.query(`select v.id from public.checkout_drafts d cross join lateral jsonb_to_recordset(d.items_snapshot) i(item_id bigint,color text,size text)
      join public.item_colors c on c.item_id=i.item_id and c.name is not distinct from i.color
      join public.item_sizes s on s.item_id=i.item_id and s.label is not distinct from i.size
      join public.item_variants v on v.item_id=i.item_id and v.color_id=c.id and v.size_id=s.id where d.id=$1`, [draftId]);
    return rows.rows.map(r => Number(r.id));
  }
  async placeFromPage(page: Page, draft: { draftId: string; sessionId: string }) {
    const ids = await this.inStockIds(draft.draftId);
    const reply = await page.evaluate(async ({ sessionId, ids }) => {
      const csrf = document.cookie.split('; ').find(c => c.startsWith('sb-csrf-token='))?.split('=').slice(1).join('=');
      const response = await fetch('/api/checkout/place-order', { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
        body: JSON.stringify({ checkoutSessionId: sessionId, inStockVariantIds: ids }) });
      const body = await response.json(); return { status: response.status, body };
    }, { sessionId: draft.sessionId, ids }) as { status: number; body: ApiBody };
    if (reply.body.orderId) this.rememberOrder(reply.body.orderId); return reply;
  }
  async accept(draft: { draftId: string; sessionId: string }, buyer: Buyer): Promise<string> {
    const reply = await this.place(draft, buyer);
    if (reply.status !== 200 || !reply.body.orderId) throw new Error(`H acceptance refused (${reply.status})`);
    return reply.body.orderId;
  }
  /** Local DB payment fixture, unique PI for each order; never claims a Stripe charge happened. */
  async recordPaid(orderId: string): Promise<void> {
    this.rememberOrder(orderId);
    const row = (await this.db.query('select status,total_amount,payment_intent_id from public.orders where id=$1', [orderId])).rows[0];
    if (row.status === 'paid' || row.status === 'shipped') return;
    const result = await this.rpc<Array<{ updated: boolean }>>('mark_order_paid', { _order_id: orderId, _expected_status: row.status,
      _payment_intent_id: row.payment_intent_id ?? `pi_h11_${randomUUID().replaceAll('-', '')}`, _paid_amount: row.total_amount,
      _paid_currency: 'jpy', _notify_customer: true, _paid_email_variant: row.status === 'failed' ? 'payment_received_after_expiry' : 'payment_received' });
    if (!result[0]?.updated) throw new Error('H payment fixture refused');
  }
  async release(orderId: string): Promise<void> {
    const row = (await this.db.query('select status from public.orders where id=$1', [orderId])).rows[0];
    if (!row || !['pending', 'payment_in_progress'].includes(row.status as string)) return;
    await this.rpc('release_stock_for_unpaid_order', { _order_id: orderId, _expected_status: row.status, _next_status: 'failed', _change_reason: 'stripe_voucher_expired' });
  }
  async reconcile(draft: { draftId: string; sessionId: string }, state: 'paid' | 'awaiting_payment'): Promise<string> {
    const frozen = await this.frozen(draft.draftId);
    const rows = await this.rpc<Array<{ order_id: string | null; rejection: string | null }>>('place_reconciled_order_from_checkout_draft', {
      _draft_id: draft.draftId, _checkout_session_id: draft.sessionId, _cart_session_id: frozen.session_id,
      _stripe_amount_total: frozen.discount_result.totalAmount, _stripe_amount_discount: frozen.discount_result.discountAmount, _stripe_currency: 'jpy',
      _checkout_session_created_at: new Date().toISOString(), _payment_intent_id: `pi_h11_${draft.draftId.replaceAll('-', '')}`, _stripe_payment_state: state });
    if (!rows[0]?.order_id || rows[0].rejection) throw new Error(`H reconciliation fixture refused (${rows[0]?.rejection ?? 'no order'})`);
    const id = rows[0].order_id; this.rememberOrder(id);
    if (state === 'awaiting_payment') await this.rpc('mark_order_awaiting_payment', { _order_id: id, _payment_intent_id: `pi_h11_${draft.draftId.replaceAll('-', '')}` });
    else await this.recordPaid(id);
    return id;
  }
  async redemptionStates(orderId: string): Promise<string[]> {
    return (await this.db.query('select state from public.discount_redemptions where order_id=$1 order by discount_id', [orderId])).rows.map(r => r.state as string);
  }
  async orderDetail(orderId: string): Promise<AdminOrderDetail> {
    const reply = await this.api<{ data: AdminOrderDetail }>('admin', `/api/admin/orders/${orderId}`);
    if (reply.status !== 200) throw new Error(`H order read refused (${reply.status})`); return reply.body.data;
  }
  async stripeTotal(sessionId: string): Promise<number | null> {
    try { return (await stripeClient().checkout.sessions.retrieve(sessionId)).amount_total; }
    catch { throw new Error('H Stripe session amount unreadable'); }
  }
  async ship(orderId: string): Promise<void> {
    const lines = (await this.db.query('select id,quantity from public.order_items where order_id=$1 order by id', [orderId])).rows;
    await shipFixtureOrder(this.db, { orderId, actorId: this.admin.userId, trackingNumber: `H11-${randomUUID().slice(0, 8)}`,
      lines: lines.map(r => ({ order_item_id: r.id as string, quantity: Number(r.quantity) })) });
    // 会計の発送の事実（出荷済みの着の印）。値段の計画（FREQ-642）は、出荷済みの着の中からだけ発送後の返品の着を選ぶ
    await withGroupG1Material(this.db, async () => {
      for (const r of lines) await seedFactSlip(this.db, { orderItemId: r.id as string, quantity: Number(r.quantity) });
    });
  }
  async repeatOrder(withOtherLine = false) {
    const item = await this.item(20_000);
    const id = await this.createDiscount(discountInput({ method: 'automatic', code: null, kind: 'repeat', targetMode: 'include', itemIds: [item.itemId],
      repeatInOrder: true, value: { type: 'amount', value: 3_000 }, minimum: { type: 'amount', value: 40_000 } }));
    // withOtherLine adds a second line outside the discount target, so "no refund on the other line" can actually fail.
    const other = withOtherLine ? await this.item(5_000) : null;
    await this.cart('member', [{ ...item, quantity: 2 }, ...(other ? [{ ...other, quantity: 1 }] : [])]);
    const orderId = await this.accept(await this.createDraft([], 'member'), 'member'); await this.recordPaid(orderId);
    const lines = (await this.db.query('select id,item_id from public.order_items where order_id=$1', [orderId])).rows;
    const target = lines.find(r => Number(r.item_id) === item.itemId), otherLine = other ? lines.find(r => Number(r.item_id) === other.itemId) : undefined;
    if (lines.length !== (other ? 2 : 1) || !target || (other && !otherLine)) throw new Error('H repeat order lines unexpected');
    await this.stop(id); return { orderId, orderItemId: target.id as string, otherOrderItemId: (otherLine?.id as string | undefined) ?? null };
  }
  async setOrder() {
    const j = await this.item(20_000), p = await this.item(10_000);
    const input = discountInput({ kind: 'set', targetMode: 'include', itemIds: [j.itemId, p.itemId],
      value: { type: 'amount', value: 3_000 }, minimum: { type: 'amount', value: 3_001 } });
    await this.createDiscount(input); await this.cart('member', [{ ...j, quantity: 1 }, { ...p, quantity: 1 }]);
    const orderId = await this.accept(await this.createDraft([input.code!], 'member'), 'member'); await this.recordPaid(orderId);
    const rows = (await this.db.query('select u.order_item_id,u.paid_amount from public.order_line_unit_amounts u join public.order_items i on i.id=u.order_item_id where u.order_id=$1 order by i.item_id', [orderId])).rows;
    return { orderId, orderItemIds: rows.map(r => r.order_item_id as string), unitAmounts: rows.map(r => Number(r.paid_amount)) };
  }
  async refund(orderId: string, orderItemId: string, quantity: number, amount: number) {
    const rows = await this.rpc<Array<{ refund_id: string; amount: number }>>('begin_order_refund', { _order_id: orderId, _source: 'admin', _request_key: randomUUID(),
      _lines: [{ order_item_id: orderItemId, before_shipment: true, quantity }], _restock: false, _shipping_amount: 0, _amount: amount,
      _note: null, _stripe_reason: 'requested_by_customer', _cancel_reason: null, _notify_customer: false, _actor_id: this.admin.userId,
      // 注文の時の写しのある注文の発送前の取り消しは、サーバーが作る値段の計画が要る（FREQ-642。写しの無い注文は null）
      _pricing: await cancelPlanFor(this.db, orderId, orderItemId, quantity) });
    await this.refundResult(rows[0].refund_id); return { refundId: rows[0].refund_id, amount: rows[0].amount };
  }
  private async refundResult(id: string): Promise<void> {
    await this.rpc('record_order_refund_result', { _refund_id: id, _stripe_refund_id: `re_h11${id.replaceAll('-', '')}`, _stripe_status: 'succeeded',
      _stripe_pending_reason: null, _stripe_failure_reason: null, _customer_action_expires_at: null, _payment_method_type: 'card', _reference_number: null, _reference_type: null });
  }
  async refundableAmounts(orderId: string, itemId: string): Promise<number[]> {
    const reply = await this.api<RefundMaterials>('admin', `/api/admin/orders/${orderId}/refund`);
    if (reply.status !== 200) throw new Error(`H refund materials refused (${reply.status})`);
    const line = reply.body.lines.find(l => l.orderItemId === itemId);
    if (!line) throw new Error('H refund line missing');
    if (line.availableUnitAmounts !== null) return [...line.availableUnitAmounts];
    const remaining = line.quantity - line.refundedUnits;
    return Array.from({ length: remaining }, (_, index) => refundLineAmount(line, index + 1) - refundLineAmount(line, index));
  }
  async legacyOrder(split = true) {
    const legacy = await withGroupG1Material(this.db, () => seedGroupG4MixedOrder(this.db, { email: this.guestEmail, quantity: split ? 3 : 2, itemPrice: split ? 34 : 20_000, discountAmount: split ? 2 : 3_000,
      shipped: split ? 1 : 0, ready: split ? 1 : 2 }));
    this.rememberOrder(legacy.orderId);
    return { orderId: legacy.orderId, orderItemId: legacy.orderItemId };
  }
  async breakdown(orderId: string): Promise<{ rows: AdminOrderDetail['discounts']; legacy: boolean }> {
    return this.rpc('get_order_discount_breakdown', { _order_id: orderId });
  }
  async compose(orderId: string): Promise<string> {
    const { url, key } = localEnv();
    const material = await loadOrderEmailMaterial(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), orderId);
    if (!material) throw new Error('H email material missing');
    const composed = composeOrderEmail({ ...material, orderStatusUrl: 'http://localhost:3000/e2e-order-status' }, { kind: 'paid', variant: null, paymentExpiredSent: false });
    if (!composed) throw new Error('H email composition refused'); return composed.text;
  }
  async guestPreviewFacts(itemId: number): Promise<DiscountFacts> {
    const context = await this.rpc<Context>('get_checkout_discount_context', { _buyer_user_id: null, _guest_email: null, _codes: [], _item_ids: [itemId], _at: new Date().toISOString(), _phase: 'preview' });
    return context.facts;
  }
  async forceFallback(codes: readonly string[], buyer: Buyer): Promise<DiscountResult> {
    const cart = await this.cartView(buyer);
    const context = await this.rpc<Context>('get_checkout_discount_context', { _buyer_user_id: this.resolve(buyer)?.userId ?? null, _guest_email: null,
      _codes: codes, _item_ids: cart.items.map(l => l.product_id), _at: new Date().toISOString(), _phase: 'preview' });
    const result = searchBestDiscountPlan({ lines: cart.items.map(l => ({ lineKey: l.key, itemId: l.product_id, unitPrice: l.price, quantity: l.quantity, lineKind: 'order' })), codes,
      discounts: context.discounts, facts: context.facts }, { maxProductPlans: 0, maxCombinations: 0 });
    await this.rpc('record_discount_search_fallback', { _discount_ids: context.discounts.map(d => d.id) });
    return result;
  }
  async showFallbackCart(page: Page, result: DiscountResult): Promise<void> {
    await page.route('**/api/cart', async route => {
      const response = await route.fetch();
      try {
        const cart = await response.json() as CartJson;
        if (!response.ok()) { await route.fulfill({ response, json: cart }); return; }
        await route.fulfill({ response, json: { ...cart, discounts: result.applied.map(({ name, amount }) => ({ name, amount })),
          total_price: result.totalAmount, total_discount: result.discountAmount, discount_provisional: result.provisional } });
      } finally { await response.dispose(); }
    });
  }
  async supporterPermissions(codes: PermissionCode[]): Promise<void> {
    const state = await readRolePermissionState(this.db, 'supporter');
    const kept = state.permissionCodes.filter(c => !c.startsWith('admin.discounts.'));
    const reply = await saveRolePermissionsInDb(this.db, this.admin.userId, { roleCode: 'supporter', permissionCodes: [...kept, ...codes], expectedVersion: state.version, requestKey: randomUUID() });
    if (reply.status !== 200) throw new Error('H permission change refused');
  }
  async permissionProbe(actorId: string, id: string): Promise<string | null> {
    try { await this.db.query('select public.get_admin_discount($1,20,0,$2)', [id, actorId]); return null; }
    catch (e) { return (e as { code?: string }).code ?? 'unknown'; }
  }
  async returnOne(orderId: string, orderItemId: string) {
    const available = await this.refundableAmounts(orderId, orderItemId);
    const materials = await this.api<{ data: CustomerReturnRequestMaterials }>('member', `/api/orders/${orderId}/return-request`);
    if (materials.status !== 200) throw new Error(`H return materials refused (${materials.status})`);
    const shipment = materials.body.data.shipments.find(f => f.lines.some(l => l.orderItemId === orderItemId))!;
    const reason = materials.body.data.reasons.find(r => r.photo !== 'required' && r.resolutions !== 'exchange_only');
    if (!reason) throw new Error('Controller must prepare a photo-optional refund reason');
    const created = await this.api<{ data: { returnId: string } }>('member', `/api/orders/${orderId}/return-request`, 'POST', {
      requestKey: randomUUID(), lines: [{ fulfillmentId: shipment.fulfillmentId, orderItemId, quantity: 1, reason: reason.reason,
        customerNote: 'サイズを確認しました', requestedResolution: 'refund', requestedExchangeVariantId: null, photoUploadIds: [] }] });
    if (created.status !== 201 && created.status !== 200) throw new Error(`H return request refused (${created.status})`);
    const returnId = created.body.data.returnId;
    const line = (await this.db.query('select id from public.order_return_lines where return_id=$1', [returnId])).rows[0];
    const approved = await this.api('admin', `/api/admin/returns/${returnId}/approve`, 'POST', { lines: [{ returnLineId: line.id, resolution: 'refund', exchangeVariantId: null, exchangeMethod: null }],
      returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0, shopNote: null, notifyCustomer: false });
    if (approved.status !== 200) throw new Error(`H return approval refused (${approved.status})`);
    const before = await this.returns(orderId);
    const row = before.find(r => r.id === returnId)!.lines[0];
    expect(row.refundAmountsByCount).toEqual([17_000]);
    const received = await this.api('admin', `/api/admin/returns/${returnId}/receive`, 'POST', { requestKey: randomUUID(),
      units: [{ returnLineId: line.id, disposition: 'not_restocked', quantity: 1 }], exchangeOverrides: [], refundChoice: 'consult',
      refundAmount: null, refundShippingAmount: 0, note: null, notifyCustomer: false });
    if (received.status !== 200) throw new Error(`H return receipt refused (${received.status} ${JSON.stringify((received.body as { code?: string } | null)?.code ?? null)})`);
    const after = (await this.returns(orderId)).find(r => r.id === returnId)!.lines[0];
    return { returnId, amounts: available.map((_, i) => available.slice(0, i + 1).reduce((sum, n) => sum + n, 0)), waitingAmount: after.refundWaitingAmount };
  }
  private async returns(orderId: string): Promise<OrderReturnDetail[]> {
    const reply = await this.api<{ data: { returns: OrderReturnDetail[] } }>('admin', `/api/admin/orders/${orderId}/returns`);
    if (reply.status !== 200) throw new Error('H returns read refused'); return reply.body.data.returns;
  }
  async refundReturn(returnId: string, amount: number): Promise<void> {
    const rows = await this.rpc<Array<{ refund_id: string }>>('admin_refund_return', { _return_id: returnId, _actor_id: this.admin.userId, _request_key: randomUUID(),
      _amount: amount, _shipping_amount: 0, _note: null, _notify_customer: false });
    await this.refundResult(rows[0].refund_id);
  }
  async attach(page: Page, who: Who, cartSessionId?: string): Promise<void> {
    this.pages.add(page);
    await page.context().clearCookies();
    await page.context().addCookies(await this.cookies(who, cartSessionId));
    await page.context().setExtraHTTPHeaders({ 'x-real-ip': this.ip });
    await page.route('**/api/checkout/promotion-code', async route => { await this.pace(who, '/api/checkout/promotion-code'); await route.continue(); });
  }
  private async amountDigest(): Promise<string> {
    const row = (await this.db.query(`select md5(jsonb_build_object(
      'orders',(select jsonb_agg(jsonb_build_array(id,subtotal_amount,discount_amount,total_amount) order by id) from public.orders where id=any($1::uuid[])),
      'units',(select jsonb_agg(to_jsonb(u) order by u.order_id,u.order_item_id,u.unit_index) from public.order_line_unit_amounts u where u.order_id=any($1::uuid[])),
      'allocations',(select jsonb_agg(to_jsonb(a) order by a.order_id,a.order_item_id,a.discount_id) from public.order_line_discount_allocations a where a.order_id=any($1::uuid[])),
      'discounts',(select jsonb_agg(jsonb_build_array(id,name,kind,method,value_type,value) order by id) from public.discounts where id=any($2::uuid[])))::text) digest`,
    [[...this.orders], [...this.discounts]])).rows[0];
    return row.digest as string;
  }
  /** Preserve immutable H facts; remove only our Auth users/app sessions, and stop our catalog entries. */
  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const page of this.pages) if (!page.isClosed()) {
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
    }
    for (const id of this.discounts) {
      const row = (await this.db.query('select version,stopped from public.discounts where id=$1', [id])).rows[0];
      if (row && !row.stopped) await this.rpc('admin_set_discount_stopped', { _discount_id: id, _stopped: true, _expected_version: String(row.version), _request_key: randomUUID(), _actor_id: this.admin.userId });
    }
    for (const id of this.orders) await this.release(id);
    const ids = this.actors.map(a => a.userId);
    const before = await this.db.query(`select md5(coalesce(jsonb_agg(jsonb_build_array(id,discount_id,order_id,state,amount,name_snapshot,code_snapshot) order by id)::text,'')) digest
      from public.discount_redemptions where order_id=any($1::uuid[])`, [[...this.orders]]);
    const amountsBefore = await this.amountDigest();
    for (const client of this.clients.values()) await client.dispose();
    // These are test-mode Session resources created by this scenario, never arbitrary account sessions.
    if (this.drafts.size) {
      const stripe = stripeClient();
      for (const draftId of this.drafts) {
        const frozen = await this.frozen(draftId);
        try {
          const session = await stripe.checkout.sessions.retrieve(frozen.checkout_session_id);
          if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
        } catch { throw new Error('H own Stripe Session cleanup failed'); }
      }
    }
    const { url, key } = localEnv();
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    await this.db.query('delete from public.sessions where user_id=any($1::uuid[])', [ids]);
    // Preserve drafts and immutable order facts while satisfying the cart owner CHECK on Auth deletion.
    for (const id of ids) await this.db.query('update public.carts set user_id=null,guest_token_hash=$2 where user_id=$1', [id, hash(randomUUID())]);
    for (const id of ids) {
      const removed = await admin.auth.admin.deleteUser(id);
      if (removed.error) throw new Error('H own user cleanup refused');
    }
    const after = await this.db.query(`select md5(coalesce(jsonb_agg(jsonb_build_array(id,discount_id,order_id,state,amount,name_snapshot,code_snapshot) order by id)::text,'')) digest
      from public.discount_redemptions where order_id=any($1::uuid[])`, [[...this.orders]]);
    expect(after.rows[0].digest === before.rows[0].digest).toBe(true);
    expect(await this.amountDigest() === amountsBefore).toBe(true);
    expect((await this.db.query('select count(*)::int n from public.discount_redemptions where order_id=any($1::uuid[]) and user_id=any($2::uuid[])', [[...this.orders], ids])).rows[0].n).toBe(0);
    expect((await this.db.query('select count(*)::int n from public.discount_assignments where discount_id=any($1::uuid[]) and user_id=any($2::uuid[])', [[...this.discounts], ids])).rows[0].n).toBe(0);
    expect((await this.db.query('select count(*)::int n from public.discount_codes where discount_id=any($1::uuid[]) and assigned_user_id=any($2::uuid[])', [[...this.discounts], ids])).rows[0].n).toBe(0);
    expect((await this.db.query('select count(*)::int n from public.discounts where id=any($1::uuid[]) and (created_by=any($2::uuid[]) or updated_by=any($2::uuid[]))', [[...this.discounts], ids])).rows[0].n).toBe(0);
    if (this.catalogIds.size) await this.db.query("update public.items set status='private' where id=any($1::bigint[])", [[...this.catalogIds]]);
  }
}

async function runScenario<T>(db: PgClient, run: (scenario: DiscountScenario) => Promise<T>, trackOrder?: (id: string) => void): Promise<T> {
  localEnv();
  // H fixtures serialize their automatic catalog without changing the existing shared permission lock.
  await db.query('select pg_advisory_lock(190526,11)');
  let s: DiscountScenario | undefined, result: T | undefined;
  const failures: unknown[] = [];
  try {
    const admin = await createAdminSessionActor(db, 'admin', 'aal2');
    const member = await createAdminSessionActor(db, 'user', 'aal1');
    const other = await createAdminSessionActor(db, 'user', 'aal1');
    s = new DiscountScenario(db, admin, member, other, trackOrder); result = await run(s);
  } catch (error) { failures.push(error); }
  // A cleanup or unlock failure must never hide the failure of the test body: keep both.
  try { if (s) await s.cleanup(); } catch (error) { failures.push(error); }
  try { await db.query('select pg_advisory_unlock(190526,11)'); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'H scenario failed and cleanup also failed');
  return result as T;
}
export async function withDiscountScenario<T>(name: string, run: (scenario: DiscountScenario) => Promise<T>, options: { returnSettings?: boolean } = {}): Promise<T> {
  if (!name) throw new Error('H scenario name required');
  let result!: T;
  await withOrderAdminScenario(async ctx => {
    const saved = options.returnSettings ? (await ctx.client.query('select to_jsonb(s) value from public.shop_return_settings s where id=1')).rows[0]?.value : null;
    try {
      if (saved) await ctx.client.query(`update public.shop_return_settings set requests_enabled=true,request_types='returns_only',window_days=null,
        return_address_name='H11 fixture',return_address_postal_code='1500001',return_address_line='Fixture',return_address_phone='0312345678' where id=1`);
      result = await runScenario(ctx.client, run, ctx.trackOrder);
    } finally {
      if (saved) await ctx.client.query(`update public.shop_return_settings s set requests_enabled=r.requests_enabled,request_types=r.request_types,window_days=r.window_days,
        return_address_name=r.return_address_name,return_address_postal_code=r.return_address_postal_code,return_address_line=r.return_address_line,return_address_phone=r.return_address_phone
        from jsonb_populate_record(null::public.shop_return_settings,$1::jsonb) r where s.id=1`, [JSON.stringify(saved)]);
    }
  }, options);
  return result;
}
export async function withDiscountPermissionScenario<T>(run: (scenario: DiscountScenario) => Promise<T>): Promise<T> {
  let result!: T;
  await withPermissionScenario(async db => { result = await runScenario(db, run); }); return result;
}

/** Display/a11y only. This fixture never proves discount eligibility or reservations. */
export async function mockOwnDiscountPreview(page: Page, result: DiscountResult): Promise<void> {
  await page.route('**/api/checkout/promotion-code', route => route.fulfill({ json: { result }, headers: { 'Cache-Control': 'no-store' } }));
}
/**
 * Auth cookies are real aal2/live app sessions for admin. Business routes are not replaced.
 * Browser Stripe confirmation is stopped at the provider boundary; fixtures explicitly record paid/results.
 * Session/coupon creation and retrieval remain real test-mode Stripe calls on the production server.
 */
export async function installDiscountDbBridge(page: Page, scenario: DiscountScenario, who: Who = 'admin', cartSessionId?: string): Promise<void> {
  await scenario.attach(page, who, cartSessionId);
  await page.route(/^https:\/\/api\.stripe\.com\/v1\/payment_intents\/[^/]+\/confirm(?:\?.*)?$/, route => route.fulfill({ status: 200,
    json: { id: new URL(route.request().url()).pathname.split('/')[3], object: 'payment_intent', status: 'succeeded' } }));
}
