/**
 * 交換の印と手元に残る服の正しい値段（FREQ-642）の E2E の道具。
 *
 * - 注文の時の写し（order_discount_snapshots・order_unit_slots・1着ごとの払った額）のある注文を、本物の割引の計算（buildOrder）で組み立てて
 *   手元の DB に作る（seedSnapshotOrder）。H の受け付けと同じ中身を、Stripe に頼らず作る。発送・会計の発送の事実も付ける。
 * - 受け取り・発送前の返金は、画面（本番ビルド）が呼ぶ窓口のうち「Stripe に頼む所」だけをこの道具が受ける。値段の計画の作成・DB の関数は
 *   窓口と同じ入口（receiveReturnAndRefund・submitAdminRefund）をそのまま通し、Stripe だけを「すぐ成功する」偽物に差し替える。
 *   見込みの窓口（receive-estimate・refund-estimate・return-request/estimate）は本物の窓口を通す。
 */
import { randomUUID } from 'node:crypto';
import Module from 'node:module';
import { createClient } from '@supabase/supabase-js';
import type { Page, Route } from '@playwright/test';
import type Stripe from 'stripe';
import type { DiscountDefinition } from '@/lib/discounts/discount-types';
import type { RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import type { CreateRefundRequest } from '@/lib/orders/refund/refund-types';
import { buildOrder } from '../tests/unit/lib/orders/unit-pricing/fixtures';
import { seedFactSlip } from '../tests/integration/db/helpers/accounting-orders-fixtures';
import { hDiscount, seedHDiscount, seedHUnitSlots } from '../tests/integration/db/helpers/group-h-fixtures';
import { createCatalogFixture, insertOrderWithLines } from '../tests/integration/db/helpers/order-fixtures';
import type { PgClient } from '../tests/integration/db/helpers/local-db';
import { lockE2eInventory, seedE2eRestock, withGroupG1Material } from './group-g1-test-utils';
import { createFulfillment } from './order-email-test-utils';
import { fulfillJson } from './order-fulfillment-test-utils';

// ---- 窓口と同じ入口の読み込み ----

/**
 * 返金・受け取りの入口（return-service・refund-service）は、サーバー専用の印（server-only）を読み込む。Playwright の Node には
 * その部品が無いので、読み込む間だけ空の部品として答える。本番ビルドには関係しない（試験の中の読み込みだけ）。
 */
async function loadServices() {
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown; ubServerOnlyAllowed?: boolean };
  if (!loader.ubServerOnlyAllowed) {
    const original = loader._load;
    loader._load = function patched(this: unknown, request: string, ...rest: unknown[]) {
      return request === 'server-only' ? {} : original.call(this, request, ...rest);
    };
    loader.ubServerOnlyAllowed = true;
  }
  // Playwright が TypeScript を CommonJS に変えて読むので require を使う（動的な import は素の ESM になり TypeScript を読めない）
  const { receiveReturnAndRefund } = require('@/lib/orders/returns/return-service') as typeof import('@/lib/orders/returns/return-service');
  const { submitAdminRefund } = require('@/lib/orders/refund/refund-service') as typeof import('@/lib/orders/refund/refund-service');
  return { receiveReturnAndRefund, submitAdminRefund };
}

// ---- 注文の材料 ----

export type UbCatalog = { itemId: number; variantId: number };
export type UbLineSpec = { price: number; quantity: number; catalog?: UbCatalog };
export type UbOrder = {
  orderId: string;
  orderItemIds: string[];
  catalogs: UbCatalog[];
  /** 着ごとの払った額（行の順・unit_index の順） */
  paid: number[][];
  email: string;
  fulfillmentId: string | null;
  total: number;
};

/**
 * 写しのある注文を作る。定義は商品の番号が決まってから作れるよう、関数で渡す。
 * shipped を付ければ全部の行を1回で発送し、会計の発送の事実（出荷済みの着の印）も付ける。
 */
export async function seedSnapshotOrder(
  db: PgClient,
  o: {
    lines: UbLineSpec[];
    definitions: (itemIds: number[]) => DiscountDefinition[];
    actorId: string;
    buyerUserId?: string | null;
    email?: string;
    shipping?: number;
    priorUnitsByItem?: (itemIds: number[]) => Record<string, number>;
    createdAt?: string;
    shipped?: boolean;
  },
): Promise<UbOrder> {
  const email = o.email ?? `ub-${randomUUID()}@example.invalid`;
  return withGroupG1Material(db, async () => {
    const catalogs: UbCatalog[] = [];
    for (const line of o.lines) {
      if (line.catalog) { catalogs.push(line.catalog); continue; }
      const catalog = await createCatalogFixture(db, { stock: 0, itemStatus: 'private' });
      catalogs.push({ itemId: catalog.itemId, variantId: catalog.variantId });
    }
    // 1つの注文の行ごとに商品は別（同じ商品を別の注文で使う時は catalog を渡す）。毎回、行の数だけ入荷する
    for (const [index, line] of o.lines.entries()) {
      const catalog = catalogs[index];
      await seedE2eRestock(db, { itemId: catalog.itemId, variantId: catalog.variantId, quantity: line.quantity });
    }
    await lockE2eInventory(db, { variantIds: [...new Set(catalogs.map((c) => c.variantId))] });
    const itemIds = catalogs.map((c) => c.itemId);
    const definitions = o.definitions(itemIds);
    const priorUnitsByItem = o.priorUnitsByItem?.(itemIds);
    const lineSpecs = (ids: string[]) => o.lines.map((line, index) => ({
      orderItemId: ids[index], itemId: itemIds[index], unitPrice: line.price, quantity: line.quantity,
    }));
    const priced = buildOrder({ orderId: 'pre', lines: lineSpecs(o.lines.map((_, i) => `oi-${i}`)), definitions, priorUnitsByItem });
    const paid = o.lines.map((_, i) => priced.slots.filter((s) => s.orderItemId === `oi-${i}`).map((s) => s.paidAmount));
    const discount = o.lines.reduce((sum, line, i) => sum + line.price * line.quantity - paid[i].reduce((a, b) => a + b, 0), 0);
    const shipping = o.shipping ?? 0;
    const total = o.lines.reduce((sum, line) => sum + line.price * line.quantity, 0) - discount + shipping;
    const order = await insertOrderWithLines(db, {
      status: 'paid', shippingEmail: email, shippingAmount: shipping, discountAmount: discount, paidAmount: total,
      paymentIntentId: `pi_e2e642_${randomUUID().replaceAll('-', '')}`, createdAt: o.createdAt,
      lines: o.lines.map((line, i) => ({
        itemId: catalogs[i].itemId, variantId: catalogs[i].variantId, quantity: line.quantity, itemPrice: line.price, fulfillmentType: 'stock' as const,
      })),
    });
    if (o.buyerUserId) await db.query('update public.orders set user_id=$1 where id=$2', [o.buyerUserId, order.orderId]);
    if (discount > 0) {
      // 止めた割引（どの注文にも新しく当たらない）。割り振りの最低額は割引より大きくする
      const discountId = await seedHDiscount(db, hDiscount({
        value: { type: 'amount', value: discount }, minimum: { type: 'amount', value: total + discount + 1 }, stopped: true,
      }));
      for (const [i, line] of o.lines.entries()) {
        const allocated = line.price * line.quantity - paid[i].reduce((a, b) => a + b, 0);
        if (allocated > 0) {
          await db.query('insert into public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount) values($1,$2,$3,$4)',
            [order.orderId, order.orderItemIds[i], discountId, allocated]);
        }
      }
    }
    for (const [i, amounts] of paid.entries()) {
      for (const [unitIndex, amount] of amounts.entries()) {
        await db.query('insert into public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount) values($1,$2,$3,$4)',
          [order.orderId, order.orderItemIds[i], unitIndex, amount]);
      }
    }
    const built = buildOrder({ orderId: order.orderId, lines: lineSpecs(order.orderItemIds), definitions, priorUnitsByItem });
    const facts = Object.fromEntries(Object.entries(built.snapshot.facts).filter(([key]) => key !== 'phase'));
    if (o.buyerUserId) facts.buyer = { kind: 'member', userId: o.buyerUserId };
    await seedHUnitSlots(db, { orderId: order.orderId, snapshot: {
      engineVersion: 1, definitions: built.snapshot.definitions, codes: built.snapshot.codes, facts, lines: built.snapshot.lines,
    } });
    let fulfillmentId: string | null = null;
    if (o.shipped !== false) {
      const shipment = await createFulfillment(db, order.orderId, o.actorId, {
        trackingNumber: `E2E-642-${randomUUID().slice(0, 8)}`, notify: false,
        lines: order.orderItemIds.map((orderItemId, i) => ({ orderItemId, quantity: o.lines[i].quantity })),
      });
      fulfillmentId = shipment.fulfillmentId;
      for (const [i, orderItemId] of order.orderItemIds.entries()) await seedFactSlip(db, { orderItemId, quantity: o.lines[i].quantity });
    }
    return { orderId: order.orderId, orderItemIds: order.orderItemIds, catalogs, paid, email, fulfillmentId, total };
  });
}

// ---- 返品の材料 ----

export type UbReturnGroup = {
  orderItemId: string;
  quantity: number;
  reason?: string;
  /** 交換にする時の交換の品の色・サイズ（番号）と送り方。省くと返金 */
  exchangeVariantId?: number;
  exchangeMethod?: 'make' | 'stock';
};
export type UbReturn = { returnId: string; lineIds: string[]; number: number };

/**
 * 返品を1件作って承認する（お客様の申し込みの返品として）。返送先は試験が整える。
 * 返送料・交換の手数料・交換の送料・返品の手数料（%）を決められる（定額の返送料はお店の送り状の返品にして料金を決める）。
 */
export async function createApprovedReturn(
  db: PgClient,
  o: { orderId: string; fulfillmentId: string; actorId: string; groups: UbReturnGroup[];
    returnShippingFee?: number; restockingPercent?: number; exchangeFee?: number; exchangeShippingFee?: number },
): Promise<UbReturn> {
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222',restocking_fee_enabled=true,exchange_fees_enabled=true where id=1`);
  const number = Number((await db.query('select coalesce(max(number),0)+1 as n from public.order_returns where order_id=$1', [o.orderId])).rows[0].n);
  const returnId = (await db.query(`insert into public.order_returns
    (order_id,number,source,status,request_key,request_fingerprint,requested_at,requested_by,return_method,return_shipping_payer,notify_customer)
    values($1,$2,'customer_request','requested',$3,'ub-e2e',now(),$4,'customer_ships','customer',false) returning id`,
  [o.orderId, number, randomUUID(), o.actorId])).rows[0].id as string;
  const lineIds = o.groups.map(() => randomUUID()).sort();
  for (const [i, g] of o.groups.entries()) {
    const exchange = g.exchangeVariantId !== undefined;
    await db.query(`insert into public.order_return_lines
      (id,return_id,fulfillment_id,order_item_id,quantity,reason,requested_resolution,requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,$9)`,
    [lineIds[i], returnId, o.fulfillmentId, g.orderItemId, g.quantity, g.reason ?? 'other',
      exchange ? 'exchange' : 'refund', exchange ? g.exchangeVariantId : null, exchange ? g.exchangeMethod ?? 'make' : null]);
  }
  const approval = o.groups.map((g, i) => ({ return_line_id: lineIds[i], resolution: g.exchangeVariantId !== undefined ? 'exchange' : 'refund',
    exchange_variant_id: g.exchangeVariantId ?? null, exchange_method: g.exchangeVariantId !== undefined ? g.exchangeMethod ?? 'make' : null }));
  const shopLabel = (o.returnShippingFee ?? 0) > 0;
  await db.query("select * from public.admin_approve_return($1,$2,$3::jsonb,$4,'customer',null,null,$5,$6,$7,$8,null,false)",
    [returnId, o.actorId, JSON.stringify(approval), shopLabel ? 'shop_label' : 'customer_ships', o.returnShippingFee ?? 0,
      o.restockingPercent ?? 0, o.exchangeFee ?? 0, o.exchangeShippingFee ?? 0]);
  return { returnId, lineIds, number };
}

/** お客様の申し込みの返品を、申し込みどおり（返金は返金、交換は交換・作って送る）で承認する。返品の行の番号を返す */
export async function approveRequested(db: PgClient, returnId: string, actorId: string): Promise<string[]> {
  const lines = (await db.query(`select id, requested_resolution, requested_exchange_variant_id from public.order_return_lines
    where return_id=$1 order by id`, [returnId])).rows;
  const approval = lines.map((l) => ({ return_line_id: l.id, resolution: l.requested_resolution,
    exchange_variant_id: l.requested_resolution === 'exchange' ? l.requested_exchange_variant_id : null,
    exchange_method: l.requested_resolution === 'exchange' ? 'make' : null }));
  // 承認には返送先が要る。DB を作り直した直後の単独の実行でも通るように、createApprovedReturn と同じ返送先を入れる（手数料の設定は触らない）
  await db.query(`update public.shop_return_settings set return_address_name='Fixture',return_address_postal_code='1000001',
    return_address_line='Fixture',return_address_phone='0311112222' where id=1 and return_address_name is null`);
  await db.query("select * from public.admin_approve_return($1,$2,$3::jsonb,'customer_ships','customer',null,null,0,0,0,0,null,false)",
    [returnId, actorId, JSON.stringify(approval)]);
  return lines.map((l) => l.id as string);
}

// ---- Stripe を「すぐ成功する」偽物にした入口 ----

/** 返金を頼まれたらすぐ成功を返す Stripe の偽物（作った返金の番号と額を控える） */
export function stubStripe(): Stripe {
  const refunds = {
    create: async (params: { amount: number; payment_intent: string; reason?: string; metadata?: Record<string, string> }) => ({
      id: `re_${randomUUID().replaceAll('-', '')}`, object: 'refund', amount: params.amount, currency: 'jpy', status: 'succeeded',
      created: Math.floor(Date.now() / 1000), payment_intent: params.payment_intent, reason: params.reason ?? null, failure_reason: null,
      pending_reason: null, metadata: params.metadata ?? {}, destination_details: { type: 'card', card: { reference: null, reference_type: null } },
      next_action: null,
    }),
    list: () => ({ async *[Symbol.asyncIterator]() { /* 見回りは使わない */ } }),
  };
  // 支払いの種類（カード）を答える。種類が読めないと入口は Stripe に頼まず「分からない」にする
  const paymentIntents = { retrieve: async (id: string) => ({ id, latest_charge: { payment_method_details: { type: 'card' } } }) };
  return { refunds, paymentIntents } as unknown as Stripe;
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) throw new Error('手元の Supabase だけを使う');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function stubDeps(): RefundServiceDeps {
  return {
    store: serviceClient() as unknown as RefundServiceDeps['store'],
    stripe: stubStripe(),
    now: () => new Date(),
    notifyShopOfRefundFailure: async () => false,
    scheduleOrderEmailDelivery: () => undefined,
  };
}

export type UbReceiveBody = {
  requestKey?: string;
  units: Array<{ returnLineId: string; disposition: 'restocked' | 'not_restocked' | 'pending_inspection' | 'sent_back'; quantity: number; refundChoice?: 'now' | 'consult' }>;
  exchangeOverrides?: Array<{ returnLineId: string; action: 'make' | 'refund' }>;
  refundChoice: 'now' | 'consult' | 'mixed' | 'none';
  refundAmount?: number | null;
  refundShippingAmount?: number;
  restockingFeeWaived?: boolean;
  note?: string | null;
  notifyCustomer?: boolean;
  treatments?: Array<{ returnLineId: string; treatment: 'shop' | 'customer' }>;
};

function receiveInput(returnId: string, actorId: string, body: UbReceiveBody) {
  return {
    returnId, actorId, actorCanRefund: true,
    requestKey: body.requestKey ?? randomUUID(), units: body.units, exchangeOverrides: body.exchangeOverrides ?? [],
    refundChoice: body.refundChoice, refundAmount: body.refundAmount ?? null, refundShippingAmount: body.refundShippingAmount ?? 0,
    restockingFeeWaived: body.restockingFeeWaived ?? false,
    note: body.note ?? null, notifyCustomer: body.notifyCustomer ?? false,
    sentBackMessage: null, sentBackCarrier: null, sentBackTrackingNumber: null, treatments: body.treatments,
  };
}

/** 受け取りを窓口と同じ入口（値段の計画を作って DB に渡す）で行う。Stripe だけ偽物。画面を使わない準備の受け取りに使う */
export async function receiveViaService(returnId: string, actorId: string, body: UbReceiveBody) {
  const { receiveReturnAndRefund } = await loadServices();
  const result = await receiveReturnAndRefund(stubDeps(), receiveInput(returnId, actorId, body));
  if (result.kind !== 'received') throw new Error(`受け取りが通らなかった: ${JSON.stringify(result)}`);
  return result;
}

/** 画面の「受け取る」が呼ぶ窓口（POST /api/admin/returns/{id}/receive）を、上の入口に差し替える。届いた本文を控える */
export async function installReceiveBridge(page: Page, actorId: string): Promise<{ posts: Array<{ returnId: string; body: UbReceiveBody }>; results: unknown[] }> {
  const state = { posts: [] as Array<{ returnId: string; body: UbReceiveBody }>, results: [] as unknown[] };
  await page.route(/\/api\/admin\/returns\/[^/]+\/receive$/, async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const returnId = new URL(route.request().url()).pathname.split('/')[4];
    const body = route.request().postDataJSON() as UbReceiveBody;
    state.posts.push({ returnId, body });
    let result;
    try {
      const { receiveReturnAndRefund } = await loadServices();
      result = await receiveReturnAndRefund(stubDeps(), receiveInput(returnId, actorId, body));
    } catch (error) {
      // 入口が投げても窓口は必ず答える（答えないと待つ側が原因の分からない時間切れになる）
      state.results.push(error);
      await fulfillJson(route, { error: String((error as Error)?.message ?? error), code: 'bridge_error' }, 500);
      return;
    }
    state.results.push(result);
    if (result.kind !== 'received') {
      await fulfillJson(route, { error: '受け取りを記録できませんでした。', code: 'refused' }, 409);
      return;
    }
    await fulfillJson(route, { data: {
      receiptId: result.receiptId, returnStatus: result.returnStatus, refundId: result.refund?.refundId ?? null,
      refundAmount: result.refund?.amount ?? null, refundStatus: result.refund?.status ?? null,
      feeDueAmount: result.feeDueAmount, replayed: result.replayed,
    } });
  });
  return state;
}

/** 画面の返金（POST /api/admin/orders/{id}/refund）を、窓口と同じ入口（発送前の品は値段の計画を作る）に差し替える */
export async function installRefundBridge(page: Page, actorId: string): Promise<{ posts: CreateRefundRequest[]; results: unknown[] }> {
  const state = { posts: [] as CreateRefundRequest[], results: [] as unknown[] };
  await page.route(/\/api\/admin\/orders\/[^/]+\/refund$/, async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const orderId = new URL(route.request().url()).pathname.split('/')[4];
    const request = route.request().postDataJSON() as CreateRefundRequest;
    state.posts.push(request);
    let result;
    try {
      const { submitAdminRefund } = await loadServices();
      result = await submitAdminRefund(stubDeps(), { orderId, actorId, request });
    } catch (error) {
      state.results.push(error);
      await fulfillJson(route, { error: String((error as Error)?.message ?? error), code: 'bridge_error' }, 500);
      return;
    }
    state.results.push(result);
    if (result.kind !== 'accepted') {
      await fulfillJson(route, { error: '返金を受け付けられませんでした。', code: result.kind === 'refused' ? result.code : 'failed' }, 409);
      return;
    }
    await fulfillJson(route, { refundId: result.refundId, status: result.status, amount: result.amount, replayed: result.replayed });
  });
  return state;
}

// ---- 手元の DB の読み出し ----

export async function eventsOf(db: PgClient, orderId: string) {
  return (await db.query(`select seq, kind, entitlement, standard_refund, now_refund, consult_refund, fee_amount, receipt_id, return_id, actor_id
    from public.order_unit_events where order_id=$1 order by seq`, [orderId])).rows.map((r) => ({
    ...r, seq: Number(r.seq), entitlement: Number(r.entitlement), standard_refund: Number(r.standard_refund), now_refund: Number(r.now_refund),
    consult_refund: Number(r.consult_refund), fee_amount: Number(r.fee_amount),
  }));
}

export async function refundsOf(db: PgClient, orderId: string) {
  return (await db.query(`select id, source, status, amount from public.order_refunds where order_id=$1 order by created_at, id`, [orderId]))
    .rows.map((r) => ({ id: r.id as string, source: r.source as string, status: r.status as string, amount: Number(r.amount) }));
}

export async function refundedTotal(db: PgClient, orderId: string): Promise<number> {
  return (await refundsOf(db, orderId)).filter((r) => r.status !== 'failed').reduce((sum, r) => sum + r.amount, 0);
}

export async function slotStates(db: PgClient, orderId: string) {
  return (await db.query(`select order_item_id, unit_index, state, current_price from public.order_unit_slots
    where order_id=$1 order by order_item_id, unit_index`, [orderId])).rows
    .map((r) => ({ orderItemId: r.order_item_id as string, unitIndex: Number(r.unit_index), state: r.state as string, currentPrice: Number(r.current_price) }));
}

export async function returnFeeRow(db: PgClient, returnId: string) {
  const r = (await db.query(`select return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee, fee_due_amount
    from public.order_returns where id=$1`, [returnId])).rows[0];
  return { returnShippingFee: Number(r.return_shipping_fee), restockingFeePercent: Number(r.restocking_fee_percent),
    exchangeFee: Number(r.exchange_fee), exchangeShippingFee: Number(r.exchange_shipping_fee), feeDueAmount: Number(r.fee_due_amount) };
}

/** 円の文字（￥17,000・−￥800 など）を数に読む */
export function yenOf(text: string | undefined): number {
  if (text === undefined) throw new Error('金額の文字が無い');
  const digits = text.replace(/[^0-9]/g, '');
  if (digits === '') throw new Error(`金額を読めない: ${text}`);
  return Number(digits);
}
