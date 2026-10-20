import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { ORDER_STATUSES, type OrderStatus } from '@/lib/orders/order-payment-types';
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import { derivePaymentStatus, PAYMENT_STATUS_LABELS } from '@/lib/orders/payment-status';
import { listOrderLineFulfillment, type OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
import { listOrderRefundSummaries, type OrderRefundSummary } from '@/lib/orders/refund/refund-store';
import {
  countOrdersWithOpenCancelRequest,
  findOrderIdsWithOpenCancelRequest,
  listOrderIdsWithOpenCancelRequest,
} from '@/lib/orders/returns/cancel-request-reads';
import { countReturnAttention, listOrderReturnSummaries } from '@/lib/orders/returns/return-store';
import { RETURN_DISPLAY_STATUSES, type OrderReturnSummary, type ReturnDisplayStatus } from '@/lib/orders/returns/return-types';
import { findMissingShippingFields } from '@/features/checkout/services/checkout-draft.service';

type OrderRow = {
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

const searchTextSchema = z.string().trim().min(1).max(200).optional();
const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    amountMin: z.coerce.number().int().nonnegative().optional(),
    amountMax: z.coerce.number().int().nonnegative().optional(),
    counterparty: searchTextSchema,
    reference: searchTextSchema,
    status: z.enum(ORDER_STATUSES).optional(),
    review: z.enum(['only']).optional(),
    // 返品の絞り込み（画面の返品の状態。DB の状態の絞り込み status とは別。グループ E-3 設計書 8-1）
    return: z.enum(RETURN_DISPLAY_STATUSES).optional(),
    // キャンセルの申し込みの絞り込み（開いている申し込みのある注文だけ。グループ E-3 段2）
    cancelRequest: z.enum(['open']).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'from must be before or equal to to',
    path: ['from'],
  })
  .refine(
    (value) =>
      value.amountMin === undefined ||
      value.amountMax === undefined ||
      value.amountMin <= value.amountMax,
    { message: 'amountMin must be less than or equal to amountMax', path: ['amountMin'] },
  );

function escapePostgrestFilterValue(value: string): string {
  return value.replace(/[\\%_,()]/g, (character) => `\\${character}`);
}

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

    console.warn('[admin.orders] Failed to retrieve payment intent:', result.reason);
  }

  return map;
}

const SHIP_BLOCKED_REASON = '支払額の確認が必要です（要対応）';

/** 支払額の違いの要対応が開いている注文（発送の RPC も同じ条件で断る。設計書 4-1） */
async function fetchShipBlockedOrderIds(orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) {
    return new Set();
  }

  const serviceRoleSupabase = await createServiceRoleClient();
  const { data, error } = await serviceRoleSupabase
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
async function fetchLineCounts(orderRows: OrderRow[]): Promise<Map<string, OrderLineFulfillmentRow[]>> {
  const orderIds = orderRows
    .filter((order) => order.status === 'paid' || order.status === 'shipped')
    .map((order) => order.id);
  if (orderIds.length === 0) {
    return new Map();
  }

  return listOrderLineFulfillment(await createServiceRoleClient(), orderIds);
}

/**
 * 注文ごとの返金の要約（受け取った額・返せる額・返事待ちか保留の返金・開いている返金の失敗の要対応）。1ページ分を1回で読む。
 * 「支払い」の列と返金・キャンセルのボタンは、Stripe の支払いではなくこの要約で決める（本計画 P13）。
 * 要約は service_role で読む（新しい表は利用者の JWT からは読めない。受け取った額も店内だけの列）
 */
async function fetchRefundSummaries(orderRows: OrderRow[]): Promise<Map<string, OrderRefundSummary>> {
  return listOrderRefundSummaries(await createServiceRoleClient(), orderRows.map((order) => order.id));
}

/**
 * 注文ごとの返品の要約（画面の返品の状態・小さな印・次にすること・返品できる品の有無。グループ E-3 設計書 8-1）。1ページ分を1回で読む。
 * 数え方と状態の決まりは DB の1か所にある。service_role で読む（新しい表は利用者の JWT からは読めない）
 */
async function fetchReturnSummaries(orderRows: OrderRow[]): Promise<Map<string, OrderReturnSummary>> {
  return listOrderReturnSummaries(await createServiceRoleClient(), orderRows.map((order) => order.id));
}

/** 返品を持たない注文の要約。DB が行を返さなかった時（来ないはずだが型の上ではありうる）にも使う */
function emptyReturnSummary(orderId: string): OrderReturnSummary {
  return { orderId, displayStatus: null, marks: [], nextAction: 'none', hasReturnable: false, refundWaitingReturns: 0, requestedReturns: 0 };
}

/** 一覧の上の一行の数（返品の申し込み・返金待ちの件数。DB が数える） */
async function fetchReturnAttention(): Promise<{ requested: number; refundWaiting: number }> {
  const { requested, refundWaiting } = await countReturnAttention(await createServiceRoleClient());
  return { requested, refundWaiting };
}

/**
 * 返品の絞り込み（return=）に当たる注文の番号。新しい注文から500件まで（DB の関数が切る）。service_role の RPC。
 * 返品の store の一覧に無い関数なので、ここで直に呼ぶ。読めなかった時は投げる（窓口が 500 にする）
 */
async function fetchOrderIdsByReturnStatus(displayStatus: ReturnDisplayStatus): Promise<string[]> {
  const { data, error } = await (await createServiceRoleClient()).rpc('list_order_ids_by_return_status', {
    _display_status: displayStatus,
  });
  if (error) {
    throw error;
  }
  return ((data ?? []) as Array<{ order_id: string }>).map((row) => row.order_id);
}

// 返品の絞り込みで、注文の番号を1回の問い合わせの URL に載せる数。番号は1件で39字（uuid と区切りの %2C）になる。
// 手元の Kong（nginx の8KB）は、この一覧の読む列と既定の絞り込みで、約196件から 414 を返した（2026-10-12 に実測。500件だと約20KB）。
// 検索の文字（日本語は1字で9字に増える）が長くても収まるよう、今の1ページ分の in（最大100件）と同じ数にする
const ORDER_IDS_PER_REQUEST = 100;

/** 一覧の上の一行の数（開いているキャンセルの申し込みのある注文の数。表を直に読む。グループ E-3 段2、決め事 P11） */
async function fetchCancelRequestAttention(): Promise<number> {
  return countOrdersWithOpenCancelRequest(await createServiceRoleClient());
}

/** 1ページ分の注文のうち、開いているキャンセルの申し込みのある物の番号（各行の印 cancelRequestOpen） */
async function fetchCancelRequestMarks(orderRows: OrderRow[]): Promise<Set<string>> {
  return findOrderIdsWithOpenCancelRequest(await createServiceRoleClient(), orderRows.map((order) => order.id));
}

/** 絞り込み cancelRequest=open に当たる注文の番号（申し込みの新しい順に500件まで）。読めなかった時は投げる（窓口が 500 にする） */
async function fetchOrderIdsWithOpenCancelRequest(): Promise<string[]> {
  return listOrderIdsWithOpenCancelRequest(await createServiceRoleClient());
}

/**
 * 返品の絞り込み（return=）とキャンセルの申し込みの絞り込み（cancelRequest=open）の、注文の番号をまとめる。
 * 付いていない側は絞らない（null）。両方付いた時は、両方に当たる注文だけ（return= 側の並びのまま）
 */
function narrowOrderIds(returnIds: string[] | null, cancelRequestIds: string[] | null): string[] | null {
  if (returnIds === null) {
    return cancelRequestIds;
  }
  if (cancelRequestIds === null) {
    return returnIds;
  }
  const wanted = new Set(cancelRequestIds);
  return returnIds.filter((id) => wanted.has(id));
}

/**
 * ログに出す例外の項目。名前と、あれば code・operation だけにする（発送の窓口と同じ決まり）。
 * ・Supabase の誤りは、Error ではない素のオブジェクトで、message・details・hint を直下に持つ（だから名前は UnknownError になる）
 * ・FulfillmentStoreError は、DB の生の誤り（details・hint 込み）を cause に持ち、Node は [cause] まで出す
 * どちらも、誤りそのものはログに渡さない
 */
function describeErrorForLog(error: unknown): [name: string, code: unknown, operation: unknown] {
  const { code = null, operation = null } = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    operation?: unknown;
  };
  return [error instanceof Error ? error.name : 'UnknownError', code, operation];
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const requestUrl = new URL(request.url);
    const parsedQuery = querySchema.safeParse({
      page: requestUrl.searchParams.get('page') ?? undefined,
      pageSize: requestUrl.searchParams.get('pageSize') ?? undefined,
      from: requestUrl.searchParams.get('from') ?? undefined,
      to: requestUrl.searchParams.get('to') ?? undefined,
      amountMin: requestUrl.searchParams.get('amountMin') ?? undefined,
      amountMax: requestUrl.searchParams.get('amountMax') ?? undefined,
      counterparty: requestUrl.searchParams.get('counterparty') ?? undefined,
      reference: requestUrl.searchParams.get('reference') ?? undefined,
      status: requestUrl.searchParams.get('status') ?? undefined,
      review: requestUrl.searchParams.get('review') ?? undefined,
      return: requestUrl.searchParams.get('return') ?? undefined,
      cancelRequest: requestUrl.searchParams.get('cancelRequest') ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          error: 'Invalid query',
          details: parsedQuery.error.flatten(),
        },
        { status: 400 },
      );
    }

    const supabase = await createClient(request);
    const fromIso = parsedQuery.data.from ? `${parsedQuery.data.from}T00:00:00.000Z` : null;
    const toIso = parsedQuery.data.to ? `${parsedQuery.data.to}T23:59:59.999Z` : null;
    const page = parsedQuery.data.page;
    const pageSize = parsedQuery.data.pageSize;
    const offset = (page - 1) * pageSize;

    // 返品の絞り込み（return=）とキャンセルの申し込みの絞り込み（cancelRequest=open）。返品は DB の関数、申し込みは表が、当たる注文の番号（どちらも新しい物から500件まで）を返すので、その番号で注文を絞る。
    // 当たる注文が無ければ、注文を読まずに空の一覧を返す（in の中身が空の問い合わせを投げない）
    const returnIds = parsedQuery.data.return ? await fetchOrderIdsByReturnStatus(parsedQuery.data.return) : null;
    const cancelRequestIds = parsedQuery.data.cancelRequest ? await fetchOrderIdsWithOpenCancelRequest() : null;
    const listFilterOrderIds = narrowOrderIds(returnIds, cancelRequestIds);
    if (listFilterOrderIds !== null && listFilterOrderIds.length === 0) {
      return NextResponse.json(
        {
          data: [],
          pagination: { page, pageSize, total: 0, totalPages: 1 },
          returnAttention: await fetchReturnAttention(),
          cancelRequestAttention: await fetchCancelRequestAttention(),
        },
        { status: 200 },
      );
    }

    // 一覧の問い合わせ（読む列・絞り込み・並び）。問い合わせの入れ物は、絞り込みを足すと中身が変わって使い回せないので、
    // 返品の絞り込みで注文の番号を分けて何回か投げる時のために、呼ぶたびに作る
    const buildOrdersQuery = () => {
      let query = supabase
        .from('orders')
        .select(`
          id,
          payment_intent_id,
          checkout_session_id,
          review_reason,
          reviewed_at,
          status,
          total_amount,
          refunded_amount,
          currency,
          shipping_full_name,
          shipping_email,
          shipping_postal_code,
          shipping_prefecture,
          shipping_city,
          shipping_address,
          shipping_phone,
          created_at,
          shipped_at,
          shipping_carrier,
          tracking_number,
          order_items (
            id,
            item_name,
            color,
            size,
            quantity,
            fulfillment_type,
            line_kind
          )
        `, { count: 'exact' })
        .order('created_at', { ascending: false });

      if (fromIso) {
        query = query.gte('created_at', fromIso);
      }

      if (toIso) {
        query = query.lte('created_at', toIso);
      }

      if (parsedQuery.data.amountMin !== undefined) {
        query = query.gte('total_amount', parsedQuery.data.amountMin);
      }

      if (parsedQuery.data.amountMax !== undefined) {
        query = query.lte('total_amount', parsedQuery.data.amountMax);
      }

      if (parsedQuery.data.status) {
        query = query.eq('status', parsedQuery.data.status);
      } else {
        // 放棄（決済画面を開いたまま離れた注文）は既定の一覧に出さない。絞り込みで選べる（設計書 5-2）
        query = query.neq('status', 'abandoned');
      }

      if (parsedQuery.data.review === 'only') {
        query = query.not('review_reason', 'is', null).is('reviewed_at', null);
      }

      if (parsedQuery.data.counterparty) {
        const counterparty = escapePostgrestFilterValue(parsedQuery.data.counterparty);
        query = query.or(
          `shipping_full_name.ilike.%${counterparty}%,shipping_email.ilike.%${counterparty}%`,
        );
      }

      if (parsedQuery.data.reference) {
        const reference = escapePostgrestFilterValue(parsedQuery.data.reference);
        query = query.or(`id.ilike.%${reference}%,payment_intent_id.ilike.%${reference}%`);
      }

      return query;
    };

    let orderRows: OrderRow[];
    let total: number;
    if (listFilterOrderIds === null) {
      const { data, count, error } = await buildOrdersQuery().range(offset, offset + pageSize - 1);

      if (error) {
        console.error('[admin.orders] Failed to fetch orders:', ...describeErrorForLog(error));
        return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
      }

      orderRows = (data ?? []) as OrderRow[];
      total = count ?? 0;
    } else {
      // 当たる注文の番号を1回の URL に全部載せると、500件で約20KB になり 414 で断られる（手元の Kong は約196件から）。
      // 100件ずつ、ほかの絞り込みを重ねて読み（多くて5回・500件。DB の関数が新しい注文から500件で切る）、
      // 新しい順に並べ直してから、このページの分を切り出す。総数は当たった数
      const matched: OrderRow[] = [];
      for (let start = 0; start < listFilterOrderIds.length; start += ORDER_IDS_PER_REQUEST) {
        const { data, error } = await buildOrdersQuery().in('id', listFilterOrderIds.slice(start, start + ORDER_IDS_PER_REQUEST));

        if (error) {
          console.error('[admin.orders] Failed to fetch orders:', ...describeErrorForLog(error));
          return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
        }

        matched.push(...((data ?? []) as OrderRow[]));
      }
      matched.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      orderRows = matched.slice(offset, offset + pageSize);
      total = matched.length;
    }
    const paymentIntentIds = orderRows
      .map((order) => order.payment_intent_id)
      .filter((paymentIntentId): paymentIntentId is string => Boolean(paymentIntentId?.startsWith('pi_')));

    const [
      paymentIntentMap,
      shipBlockedOrderIds,
      lineCountsByOrder,
      refundSummaries,
      returnSummaries,
      returnAttention,
      cancelRequestOrderIds,
      cancelRequestAttention,
    ] =
      await Promise.all([
        fetchPaymentIntentMap(paymentIntentIds),
        fetchShipBlockedOrderIds(orderRows.map((order) => order.id)),
        fetchLineCounts(orderRows),
        fetchRefundSummaries(orderRows),
        fetchReturnSummaries(orderRows),
        fetchReturnAttention(),
        fetchCancelRequestMarks(orderRows),
        fetchCancelRequestAttention(),
      ]);

    const responseData = orderRows.map((order) => {
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

      // 商品数は交換の品の行を外す。発送・受注生産の数（下の inProductionTotal・readyTotal）には交換の品も入る（本計画 P9）
      const totalQuantity = items.filter((item) => item.lineKind !== 'exchange').reduce((sum, item) => sum + item.quantity, 0);
      const inProductionTotal = items.reduce((sum, item) => sum + item.inProduction, 0);
      const readyTotal = items.reduce((sum, item) => sum + item.readyUnshipped, 0);
      // 要約が無い注文（来ないはずだが型の上ではありうる）は、受け取った額が無く、手続き中の返金も無い物として扱う
      const refundSummary = refundSummaries.get(order.id);
      const hasOpenRefund = refundSummary?.hasOpenRefund ?? false;
      const refundableAmount = refundSummary?.refundableAmount ?? 0;
      const progress = deriveOrderProgress(order.status, lineCounts, { hasOpenRefund });
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
        // 発送準備中か受注生産中の数があれば発送の画面を開ける（受注生産中の品は、画面の中で仕上がりを記録してから送る）
        canShip:
          order.status === 'paid'
          && readyTotal + inProductionTotal > 0
          && missingShippingFields.length === 0
          && !shipBlockedReason,
        canRecordCompletion: order.status === 'paid' && inProductionTotal > 0,
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

    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);

    return NextResponse.json(
      {
        data: responseData,
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
        },
        returnAttention,
        cancelRequestAttention,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/orders error:', ...describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
