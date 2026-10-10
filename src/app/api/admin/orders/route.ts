import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { ORDER_STATUSES, type OrderStatus } from '@/lib/orders/order-payment-types';
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import { listOrderLineFulfillment, type OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
import { findMissingShippingFields } from '@/features/checkout/services/checkout-draft.service';

type OrderRow = {
  id: string;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  status: OrderStatus;
  review_reason: string | null;
  reviewed_at: string | null;
  total_amount: number;
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
          fulfillment_type
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

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

    const { data, count, error } = await query;

    if (error) {
      console.error('[admin.orders] Failed to fetch orders:', error);
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }

    const orderRows = (data ?? []) as OrderRow[];
    const paymentIntentIds = orderRows
      .map((order) => order.payment_intent_id)
      .filter((paymentIntentId): paymentIntentId is string => Boolean(paymentIntentId?.startsWith('pi_')));

    const [paymentIntentMap, shipBlockedOrderIds, lineCountsByOrder] = await Promise.all([
      fetchPaymentIntentMap(paymentIntentIds),
      fetchShipBlockedOrderIds(orderRows.map((order) => order.id)),
      fetchLineCounts(orderRows),
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
          shipped: counts?.shipped ?? 0,
          inProduction: counts?.inProduction ?? 0,
          readyUnshipped: counts?.readyUnshipped ?? 0,
        };
      });

      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const inProductionTotal = items.reduce((sum, item) => sum + item.inProduction, 0);
      const readyTotal = items.reduce((sum, item) => sum + item.readyUnshipped, 0);
      const progress = deriveOrderProgress(order.status, lineCounts);
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
        canCancel:
          order.status === 'payment_in_progress'
          || order.status === 'failed'
          // Stripe を読めなかった入金待ち（paymentIntent が null）は、取り消せない側に倒す
          || (order.status === 'pending' && paymentIntent !== null && !awaitingPayment),
        cancelBlockedUntil,
        canRefund:
          (order.status === 'paid' || order.status === 'shipped') &&
          paymentIntent?.status === 'succeeded' &&
          Boolean(order.payment_intent_id?.startsWith('pi_')),
      };
    });

    const total = count ?? 0;
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
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/orders error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
