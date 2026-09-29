import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  PAYMENT_EXCEPTION_REASON_LABELS,
  type AttentionException,
  type AttentionReview,
  type OrderAttention,
  type OrderStatus,
  type PaymentExceptionReason,
} from '@/lib/orders/order-payment-types';

/**
 * 管理画面の「要対応・要確認」欄(設計書 5-2)。店長も対応担当も見られる ORDER タブで使う。
 * お客様の個人情報は返さない(注文番号と Stripe の支払い ID だけ)。
 */
const MAX_ITEMS = 100;

const REVIEW_REASON_LABELS: Record<string, string> = {
  stock_not_reserved: '在庫を確保できなかった注文',
};

type ExceptionRow = {
  id: string;
  reason: PaymentExceptionReason;
  detail: string | null;
  order_id: string | null;
  payment_ref: string;
  first_detected_at: string;
  last_detected_at: string;
  detection_count: number;
  orders: { status: OrderStatus } | null;
};

type ReviewRow = {
  id: string;
  status: OrderStatus;
  review_reason: string;
  review_marked_at: string | null;
};

export async function GET(request: Request) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  try {
    const supabase = await createServiceRoleClient();
    const [exceptionsResult, reviewsResult] = await Promise.all([
      supabase
        .from('payment_exceptions')
        .select(
          'id, reason, detail, order_id, payment_ref, first_detected_at, last_detected_at, detection_count, orders(status)',
          { count: 'exact' },
        )
        .is('resolved_at', null)
        .order('first_detected_at', { ascending: true })
        .limit(MAX_ITEMS),
      supabase
        .from('orders')
        .select('id, status, review_reason, review_marked_at', { count: 'exact' })
        .not('review_reason', 'is', null)
        .is('reviewed_at', null)
        .order('review_marked_at', { ascending: true })
        .limit(MAX_ITEMS),
    ]);

    if (exceptionsResult.error || reviewsResult.error) {
      console.error('[admin.order-attention] Failed to fetch', exceptionsResult.error ?? reviewsResult.error);
      return NextResponse.json({ error: 'Failed to fetch order attention' }, { status: 500 });
    }

    const exceptions: AttentionException[] = ((exceptionsResult.data ?? []) as unknown as ExceptionRow[]).map((row) => {
      const orderStatus = row.orders?.status ?? null;
      return {
        id: row.id,
        reason: row.reason,
        reasonLabel: PAYMENT_EXCEPTION_REASON_LABELS[row.reason] ?? row.reason,
        detail: row.detail,
        orderId: row.order_id,
        orderNumber: row.order_id ? toOrderNumber(row.order_id) : null,
        orderStatus,
        paymentRef: row.payment_ref,
        firstDetectedAt: row.first_detected_at,
        lastDetectedAt: row.last_detected_at,
        detectionCount: row.detection_count,
        canCancelOrder: orderStatus === 'payment_in_progress' || orderStatus === 'pending',
      };
    });

    const reviews: AttentionReview[] = ((reviewsResult.data ?? []) as ReviewRow[]).map((row) => ({
      orderId: row.id,
      orderNumber: toOrderNumber(row.id),
      orderStatus: row.status,
      reviewReason: row.review_reason,
      reviewReasonLabel: REVIEW_REASON_LABELS[row.review_reason] ?? row.review_reason,
      reviewMarkedAt: row.review_marked_at,
    }));

    const data: OrderAttention = {
      exceptions,
      reviews,
      counts: {
        exceptions: exceptionsResult.count ?? exceptions.length,
        reviews: reviewsResult.count ?? reviews.length,
      },
    };
    return NextResponse.json({ data });
  } catch (error) {
    console.error('GET /api/admin/order-attention error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
