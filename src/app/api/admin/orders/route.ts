import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createClient } from '@/lib/supabase/server';

type OrderRow = {
  id: string;
  payment_intent_id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  total_amount: number;
  currency: string;
  shipping_full_name: string | null;
  shipping_email: string | null;
  created_at: string;
  order_items: Array<{
    item_name: string;
    quantity: number;
  }> | null;
};

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

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

function mapOrderStatusToLabel(status: OrderRow['status']): '未決済' | '決済完了' | '決済失敗' | 'キャンセル' {
  if (status === 'paid') {
    return '決済完了';
  }

  if (status === 'failed') {
    return '決済失敗';
  }

  if (status === 'cancelled') {
    return 'キャンセル';
  }

  return '未決済';
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
        status,
        total_amount,
        currency,
        shipping_full_name,
        shipping_email,
        created_at,
        order_items (
          item_name,
          quantity
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

    const { data, count, error } = await query;

    if (error) {
      console.error('[admin.orders] Failed to fetch orders:', error);
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }

    const orderRows = (data ?? []) as OrderRow[];
    const paymentIntentIds = orderRows
      .map((order) => order.payment_intent_id)
      .filter((paymentIntentId) => paymentIntentId.startsWith('pi_'));

    const paymentIntentMap = await fetchPaymentIntentMap(paymentIntentIds);

    const responseData = orderRows.map((order) => {
      const items = (order.order_items ?? []).map((item) => ({
        name: item.item_name,
        quantity: item.quantity,
      }));

      const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const paymentIntent = paymentIntentMap.get(order.payment_intent_id) ?? null;

      return {
        id: order.id,
        customerName: order.shipping_full_name?.trim() || 'ゲスト',
        customerEmail: order.shipping_email?.trim() || '-',
        orderDate: toJstDate(order.created_at),
        itemCount: `${totalQuantity}点`,
        items,
        totalAmount: toCurrencyLabel(order.total_amount, order.currency),
        status: mapOrderStatusToLabel(order.status),
        paymentMethod: mapPaymentMethodLabel(paymentIntent),
        paymentReference: order.payment_intent_id,
        stripePaymentStatus: paymentIntent?.status ?? null,
        canRefund:
          order.status === 'paid' &&
          paymentIntent?.status === 'succeeded' &&
          order.payment_intent_id.startsWith('pi_'),
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
