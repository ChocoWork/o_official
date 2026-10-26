import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import { derivePaymentStatus, PAYMENT_STATUS_LABELS } from '@/lib/orders/payment-status';
import { listOrderLineFulfillment, type OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
import { listOrderRefundSummaries, type OrderRefundSummary } from '@/lib/orders/refund/refund-store';
import { findOrderIdsWithOpenCancelRequest } from '@/lib/orders/returns/cancel-request-reads';
import { listOrderReturnSummaries } from '@/lib/orders/returns/return-store';
import type { OrderReturnSummary } from '@/lib/orders/returns/return-types';
import { findMissingShippingFields } from '@/features/checkout/services/checkout-draft.service';
import { listOrderDeliverySummaries } from '@/lib/orders/tracking/delivery-store';
import type { AdminOrderSummary } from './admin-order-types';

export type AdminOrderSummaryInput = {
  id: string;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  status: OrderStatus;
  review_reason: string | null;
  reviewed_at: string | null;
  total_amount: number;
  /** 成功した返金の合計（利用者の JWT でも読める列）。受け取った額は店内だけの列なので、要約の RPC から受け取る */
  refunded_amount: number;
  currency: string;
  shipping_full_name: string | null;
  shipping_email: string | null;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_phone: string | null;
  created_at: string;
  shipped_at: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  order_items: Array<{
    id: string;
    item_name: string;
    color: string | null;
    size: string | null;
    quantity: number;
    fulfillment_type: 'stock' | 'backorder';
    /** 交換の品の行（返品の交換で足した行）は exchange。商品数に数えず、購入商品に印を付ける */
    line_kind: 'order' | 'exchange';
  }> | null;
};

type PaymentIntentCacheItem = {
  expiresAt: number;
  value: Stripe.PaymentIntent;
};

const PAYMENT_INTENT_CACHE_TTL_MS = 5 * 60 * 1000;
const paymentIntentCache = new Map<string, PaymentIntentCacheItem>();

function toJstDate(dateText: string): string {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toCurrencyLabel(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `¥${amount.toLocaleString('ja-JP')}`;
  }
}

function mapPaymentMethodLabel(paymentIntent: Stripe.PaymentIntent | null): string {
  const method = paymentIntent?.payment_method_types?.[0] ?? null;

  if (method === 'card') {
    return 'カード';
  }

  if (method === 'konbini') {
    return 'コンビニ';
  }

  if (method === 'paypay') {
    return 'PayPay';
  }

  return '不明';
}

/** PaymentIntentの個人情報を持ちうる元の例外から、診断用の記号2つだけを写す。 */
function stripeErrorForLog(error: unknown): Error & { type: string | null; code: string | null } {
  const fields = error !== null && typeof error === 'object' && !Array.isArray(error)
    ? error as { type?: unknown; code?: unknown } : {};
  const symbol = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value) ? value : null;
  return Object.assign(new Error('PAYMENT_INTENT_READ_FAILED'), { type: symbol(fields.type), code: symbol(fields.code) });
}

async function fetchPaymentIntentMap(paymentIntentIds: string[]): Promise<Map<string, Stripe.PaymentIntent>> {
  if (paymentIntentIds.length === 0) {
    return new Map<string, Stripe.PaymentIntent>();
  }

  const stripe = getStripeServerClient();
  const now = Date.now();
  const map = new Map<string, Stripe.PaymentIntent>();
  const missingIds: string[] = [];

  for (const paymentIntentId of paymentIntentIds) {
    const cached = paymentIntentCache.get(paymentIntentId);
    if (cached && cached.expiresAt > now) {
      map.set(paymentIntentId, cached.value);
      continue;
    }

    missingIds.push(paymentIntentId);
  }

  if (missingIds.length === 0) {
    return map;
  }

  const results = await Promise.allSettled(
    missingIds.map(async (paymentIntentId) => {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return { paymentIntentId, paymentIntent };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      map.set(result.value.paymentIntentId, result.value.paymentIntent);
      paymentIntentCache.set(result.value.paymentIntentId, {
        expiresAt: now + PAYMENT_INTENT_CACHE_TTL_MS,
        value: result.value.paymentIntent,
      });
      continue;
    }

    // 旧い診断のError型は保ち、外部例外の本文・付随データ・causeを持ち込まない。
    console.warn('[admin.orders] Failed to retrieve payment intent:', stripeErrorForLog(result.reason));
  }

  return map;
}

const SHIP_BLOCKED_REASON = '支払額の確認が必要です（要対応）';

/** 支払額の違いの要対応が開いている注文（発送の RPC も同じ条件で断る。設計書 4-1） */
async function fetchShipBlockedOrderIds(supabase: SupabaseClient, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) {
    return new Set();
  }

  const { data, error } = await supabase
    .from('payment_exceptions')
    .select('order_id')
    .in('order_id', orderIds)
    .eq('reason', 'paid_amount_mismatch')
    .is('resolved_at', null);

  if (error) {
    throw error;
  }

  return new Set((data ?? []).map((row: { order_id: string }) => row.order_id));
}

/**
 * 商品ごとの数（発送した・受注生産中・発送準備中）。支払い済みと発送済みの注文だけ数える。
 * 未入金などの注文は、まだ作る・送る段階に入っていないので数に意味が無い。
 * 数は service_role で読む（新しい表は利用者の JWT からは読めない。設計書 3-4）
 */
async function fetchLineCounts(supabase: SupabaseClient, orderRows: AdminOrderSummaryInput[]): Promise<Map<string, OrderLineFulfillmentRow[]>> {
  const orderIds = orderRows
    .filter((order) => order.status === 'paid' || order.status === 'shipped')
    .map((order) => order.id);
  if (orderIds.length === 0) {
    return new Map();
  }

  return listOrderLineFulfillment(supabase, orderIds);
}

/**
 * 注文ごとの返金の要約（受け取った額・返せる額・返事待ちか保留の返金・開いている返金の失敗の要対応）。1ページ分を1回で読む。
 * 「支払い」の列と返金・キャンセルのボタンは、Stripe の支払いではなくこの要約で決める（本計画 P13）。
 * 要約は service_role で読む（新しい表は利用者の JWT からは読めない。受け取った額も店内だけの列）
 */
async function fetchRefundSummaries(supabase: SupabaseClient, orderRows: AdminOrderSummaryInput[]): Promise<Map<string, OrderRefundSummary>> {
  return listOrderRefundSummaries(supabase, orderRows.map((order) => order.id));
}

/**
 * 注文ごとの返品の要約（画面の返品の状態・小さな印・次にすること・返品できる品の有無。グループ E-3 設計書 8-1）。1ページ分を1回で読む。
 * 数え方と状態の決まりは DB の1か所にある。service_role で読む（新しい表は利用者の JWT からは読めない）
 */
async function fetchReturnSummaries(supabase: SupabaseClient, orderRows: AdminOrderSummaryInput[]): Promise<Map<string, OrderReturnSummary>> {
  return listOrderReturnSummaries(supabase, orderRows.map((order) => order.id));
}

/** 返品を持たない注文の要約。DB が行を返さなかった時（来ないはずだが型の上ではありうる）にも使う */
function emptyReturnSummary(orderId: string): OrderReturnSummary {
  return { orderId, displayStatus: null, marks: [], nextAction: 'none', hasReturnable: false, refundWaitingReturns: 0, requestedReturns: 0 };
}

/** 1ページ分の注文のうち、開いているキャンセルの申し込みのある物の番号（各行の印 cancelRequestOpen） */
async function fetchCancelRequestMarks(supabase: SupabaseClient, orderRows: AdminOrderSummaryInput[]): Promise<Set<string>> {
  return findOrderIdsWithOpenCancelRequest(supabase, orderRows.map((order) => order.id));
}

/** 旧一覧の組立てを保ち、一覧と詳細で同じsummaryを返す。 */
export async function buildAdminOrderSummaries(supabase: SupabaseClient, orderRows: AdminOrderSummaryInput[]): Promise<AdminOrderSummary[]> {
  const paymentIntentIds = orderRows
    .map((order) => order.payment_intent_id)
    .filter((paymentIntentId): paymentIntentId is string => Boolean(paymentIntentId?.startsWith('pi_')));

  const [
    paymentIntentMap,
    shipBlockedOrderIds,
    lineCountsByOrder,
    refundSummaries,
    returnSummaries,
    cancelRequestOrderIds,
    deliverySummaries,
  ] =
    await Promise.all([
      fetchPaymentIntentMap(paymentIntentIds),
      fetchShipBlockedOrderIds(supabase, orderRows.map((order) => order.id)),
      fetchLineCounts(supabase, orderRows),
      fetchRefundSummaries(supabase, orderRows),
      fetchReturnSummaries(supabase, orderRows),
      fetchCancelRequestMarks(supabase, orderRows),
      listOrderDeliverySummaries(supabase, orderRows.map((order) => order.id)),
    ]);

  const responseData = orderRows.map((order): AdminOrderSummary => {
    const lineCounts = lineCountsByOrder.get(order.id) ?? [];
    const countsByItem = new Map(lineCounts.map((row) => [row.orderItemId, row]));
    const items = (order.order_items ?? []).map((item) => {
      const counts = countsByItem.get(item.id);
      return {
        id: item.id,
        name: item.item_name,
        color: item.color,
        size: item.size,
        quantity: item.quantity,
        fulfillmentType: item.fulfillment_type,
        // 交換の品の行は購入商品に残して印を付ける。読めなかった行（古い見本）は order
        lineKind: item.line_kind === 'exchange' ? ('exchange' as const) : ('order' as const),
        shipped: counts?.shipped ?? 0,
        inProduction: counts?.inProduction ?? 0,
        readyUnshipped: counts?.readyUnshipped ?? 0,
      };
    });

    // 商品数は交換の品の行を外す（本計画 P9）
    const totalQuantity = items.filter((item) => item.lineKind !== 'exchange').reduce((sum, item) => sum + item.quantity, 0);
    // 要約が無い注文（来ないはずだが型の上ではありうる）は、受け取った額が無く、手続き中の返金も無い物として扱う
    const refundSummary = refundSummaries.get(order.id);
    const hasOpenRefund = refundSummary?.hasOpenRefund ?? false;
    const refundableAmount = refundSummary?.refundableAmount ?? 0;
    const progress = deriveOrderProgress(order.status, lineCounts, { hasOpenRefund, delivery: deliverySummaries.get(order.id) });
    const paymentStatusKey = derivePaymentStatus({
      status: order.status,
      paidAmount: refundSummary?.paidAmount ?? null,
      refundedAmount: order.refunded_amount,
    });
    const paymentIntent = order.payment_intent_id ? paymentIntentMap.get(order.payment_intent_id) ?? null : null;
    const missingShippingFields = findMissingShippingFields({
      email: order.shipping_email,
      fullName: order.shipping_full_name,
      kanaName: null,
      postalCode: order.shipping_postal_code,
      prefecture: order.shipping_prefecture,
      city: order.shipping_city,
      address: order.shipping_address,
      building: null,
      phone: order.shipping_phone,
    });

    const shipBlockedReason = shipBlockedOrderIds.has(order.id) ? SHIP_BLOCKED_REASON : null;

    // 入金待ち（pending）の取消は取消 API（status/route.ts）と同じ判定にする（設計書 4-1）。PaymentIntent が
    // requires_action か processing の間は、払込票の期限を過ぎても Stripe が期限切れを確定するまで 409 になる。
    // だからサーバーの時計とは比べない。期限（cancelBlockedUntil）は Stripe が返したときだけ入れる
    const awaitingPayment = paymentIntent?.status === 'requires_action' || paymentIntent?.status === 'processing';
    const voucherExpiresAt = paymentIntent?.next_action?.konbini_display_details?.expires_at ?? null;
    const cancelBlockedUntil =
      order.status === 'pending' && awaitingPayment && voucherExpiresAt
        ? new Date(voucherExpiresAt * 1000).toISOString()
        : null;

    // 取消の種類。未入金の注文の取消（unpaid）は今のまま Stripe の支払いで決める。支払い済みの注文のキャンセル（paid）は、
    // 1つも発送していなくて、返せる額が残っている時だけ（発送した品がある注文は、返金の画面を使う）
    const unpaidCancellable =
      order.status === 'payment_in_progress'
      || order.status === 'failed'
      // Stripe を読めなかった入金待ち（paymentIntent が null）は、取り消せない側に倒す
      || (order.status === 'pending' && paymentIntent !== null && !awaitingPayment);
    const shippedTotal = items.reduce((sum, item) => sum + item.shipped, 0);
    const paidCancellable = order.status === 'paid' && shippedTotal === 0 && refundableAmount > 0;
    const cancelKind: 'unpaid' | 'paid' | null = unpaidCancellable ? 'unpaid' : paidCancellable ? 'paid' : null;

    return {
      id: order.id,
      customerName: order.shipping_full_name?.trim() || 'ゲスト',
      customerEmail: order.shipping_email?.trim() || '-',
      orderDate: toJstDate(order.created_at),
      itemCount: `${totalQuantity}点`,
      items,
      totalAmount: toCurrencyLabel(order.total_amount, order.currency),
      // 言葉（status）は表示のため。件数・絞り込み・CSV の判断には DB の状態（orderStatus）を使う
      status: progress.label,
      orderStatus: order.status,
      progressKey: progress.key,
      partiallyShipped: progress.partiallyShipped,
      paymentMethod: mapPaymentMethodLabel(paymentIntent),
      paymentReference: order.payment_intent_id ?? order.checkout_session_id ?? '-',
      stripePaymentStatus: paymentIntent?.status ?? null,
      // 「支払い」の列と小さな印。受け取った額と返金の記録で決め、Stripe は読まない（本計画 P13）
      paymentStatusKey,
      paymentStatus: PAYMENT_STATUS_LABELS[paymentStatusKey],
      refundPending: hasOpenRefund,
      refundFailed: refundSummary?.hasUnresolvedRefundFailure ?? false,
      refundedAmountLabel: order.refunded_amount > 0 ? toCurrencyLabel(order.refunded_amount, order.currency) : '-',
      // 返品の列・小さな印・ボタンの名前・「返品できる品」の有無。DB の要約をそのまま写す（返品の無い注文は displayStatus が null）
      returnSummary: returnSummaries.get(order.id) ?? emptyReturnSummary(order.id),
      // 開いているキャンセルの申し込みがあるか。画面は「キャンセルの申し込み」のボタンを出す（グループ E-3 段2、決め事 P11）
      cancelRequestOpen: cancelRequestOrderIds.has(order.id),
      shippedAt: order.shipped_at,
      shippingCarrier: order.shipping_carrier,
      trackingNumber: order.tracking_number,
      // G-1 Task 14: 旧の発送と手動の仕上がりは止めた（G-3 の新しい発送票へ移る）。入力にかかわらず false
      canShip: false,
      canRecordCompletion: false,
      missingShippingFields,
      shipBlockedReason,
      needsReview: order.review_reason !== null && order.reviewed_at === null,
      canCancel: cancelKind !== null,
      cancelKind,
      cancelBlockedUntil,
      // 返金のボタンは Stripe を読まずに決める（本計画 P13）。受け取った額があり、返せる額が残っている注文。返せる額は返事待ち・保留・成功を
      // 引いた残りなので、返事待ち・保留の返金があっても残りがあれば出す（返事待ちがある時は返金の画面が「確かめ中の返金があります」を出す）。
      // 取り消した注文に入金が届いた時（受け取った額が書かれた cancelled）も、同じ条件で出る
      canRefund: (refundSummary?.paidAmount ?? 0) > 0 && refundableAmount > 0,
    };
  });

  return responseData;
}

export async function buildAdminOrderSummary(supabase: SupabaseClient, orderRow: AdminOrderSummaryInput): Promise<AdminOrderSummary> {
  return (await buildAdminOrderSummaries(supabase, [orderRow]))[0];
}
