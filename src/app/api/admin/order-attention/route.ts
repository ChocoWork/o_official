import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { toOrderNumber } from '@/lib/orders/order-number';
import { ORDER_EMAIL_ERROR_LABELS } from '@/lib/orders/email/order-email-types';
import { getOrderEmailSendState, OrderEmailStoreError, type OrderEmailStore } from '@/lib/orders/email/order-email-store';
import { refundFailureReasonLabel } from '@/lib/orders/refund/refund-messages';
import { listOrderRefundSummaries, type RefundStore } from '@/lib/orders/refund/refund-store';
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
 * お客様の個人情報は返さない(注文番号と Stripe の支払い ID のほか、返金の失敗の行には返金の額と商品の名前・数だけ。設計書 9-4)。
 */
const MAX_ITEMS = 100;

const REVIEW_REASON_LABELS: Record<string, string> = {
  stock_not_reserved: '在庫を確保できなかった注文',
  // 毎時の見回りが、注文の無い支払いから作った注文（設計書 2026-10-05 グループ B の 3-6。FREQ-415）
  recovered_from_payment: '支払いから作った注文：お客様へ確認してください',
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

/**
 * ログに残すのは、例外の名前と DB の断りの記号（SQLSTATE などの短い記号）だけにする。
 * 例外の文・details・hint には、行の値（支払い ID など）が混ざりうる。
 */
function safeErrorFields(error: unknown): string[] {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return [error instanceof Error ? error.name : 'UnknownError', ...(typeof code === 'string' && code ? [code] : [])];
}

/**
 * 「もう一度返金する」を出せる注文の番号。返金の失敗の要対応に付いた注文のうち、まだ返せる額が残っている物。
 * 返せる額が読めなくても、店が注文に対応できるよう要対応の欄は返す（送信状態の読み込みと同じ扱い）。その間はボタンを出さない
 */
async function fetchRetryableRefundOrderIds(store: RefundStore, rows: ExceptionRow[]): Promise<Set<string>> {
  const orderIds = [...new Set(rows.flatMap((row) => (row.reason === 'refund_failed' && row.order_id ? [row.order_id] : [])))];
  if (orderIds.length === 0) {
    return new Set();
  }

  try {
    const summaries = await listOrderRefundSummaries(store, orderIds);
    return new Set(orderIds.filter((orderId) => (summaries.get(orderId)?.refundableAmount ?? 0) > 0));
  } catch (error) {
    console.warn('[admin.order-attention] Failed to fetch refundable amounts', ...safeErrorFields(error));
    return new Set();
  }
}

// 返金の失敗の要対応の支払いの番号は、Stripe の返金の番号（小文字2〜4字の種類と _ と英数字。カードの re_・カード以外の pyr_ など。
// DB の stripe_refund_id の CHECK と同じ形。本計画 P29）か、Stripe の返事が来る前に失敗した返金の記録の番号（uuid）。
// 形で見分けて、探す列を決める（形の合わない番号は DB に渡さない）
const STRIPE_REFUND_REF_PATTERN = /^[a-z]{2,4}_[A-Za-z0-9]+$/;
const REFUND_RECORD_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 返金の記録（返品の返金なら、返品の番号 return_id も）と、その商品の行（確保し直せなかった数）と商品の名前。お客様の氏名・連絡先・住所は読まない
const REFUND_RECORD_SELECT =
  'id, stripe_refund_id, amount, return_id, order_refund_lines (rereserve_shortage, order_items (item_name, color, size))';

type RefundRecordRow = {
  id: string;
  stripe_refund_id: string | null;
  amount: number;
  return_id: string | null;
  order_refund_lines: Array<{
    rereserve_shortage: number;
    order_items: { item_name: string; color: string | null; size: string | null };
  }> | null;
};
type RefundFailureRecord = { amount: number; returnId: string | null; shortages: Array<{ name: string; quantity: number }> };

/** 確保し直せなかった商品（rereserve_shortage が1以上の行）と数。名前はメールの明細と同じ「商品名（色 / サイズ）」 */
function toRefundFailureRecord(row: RefundRecordRow): RefundFailureRecord {
  return {
    amount: row.amount,
    returnId: row.return_id ?? null,
    shortages: (row.order_refund_lines ?? [])
      .filter((line) => line.rereserve_shortage > 0)
      .map((line) => {
        const { item_name: itemName, color, size } = line.order_items;
        const variant = [color, size].filter(Boolean).join(' / ');
        return { name: variant ? `${itemName}（${variant}）` : itemName, quantity: line.rereserve_shortage };
      }),
  };
}

/**
 * 返金の失敗の要対応が指す返金の記録（額と、確保し直せなかった商品と数）。支払いの番号が Stripe の返金の番号なら stripe_refund_id で、
 * 記録の番号なら id で探し、見つけた記録を支払いの番号ごとに返す。読めなかった時は、記録が無い物として扱う
 * （要対応の欄そのものは返す。ログは名前と code だけ。送信状態の読み込みと同じ扱い）
 */
async function fetchRefundFailureRecords(supabase: SupabaseClient, rows: ExceptionRow[]): Promise<Map<string, RefundFailureRecord>> {
  const refs = [...new Set(rows.flatMap((row) => (row.reason === 'refund_failed' ? [row.payment_ref] : [])))];
  const stripeRefs = refs.filter((ref) => STRIPE_REFUND_REF_PATTERN.test(ref));
  const recordRefs = refs.filter((ref) => REFUND_RECORD_REF_PATTERN.test(ref));
  if (stripeRefs.length === 0 && recordRefs.length === 0) {
    return new Map();
  }

  try {
    const [byStripeId, byRecordId] = await Promise.all([
      stripeRefs.length > 0 ? supabase.from('order_refunds').select(REFUND_RECORD_SELECT).in('stripe_refund_id', stripeRefs) : null,
      recordRefs.length > 0 ? supabase.from('order_refunds').select(REFUND_RECORD_SELECT).in('id', recordRefs) : null,
    ]);
    const queryError = byStripeId?.error ?? byRecordId?.error;
    if (queryError) {
      throw queryError;
    }

    const records = new Map<string, RefundFailureRecord>();
    for (const row of (byStripeId?.data ?? []) as unknown as RefundRecordRow[]) {
      if (row.stripe_refund_id) {
        records.set(row.stripe_refund_id, toRefundFailureRecord(row));
      }
    }
    for (const row of (byRecordId?.data ?? []) as unknown as RefundRecordRow[]) {
      records.set(row.id, toRefundFailureRecord(row));
    }
    return records;
  } catch (error) {
    console.warn('[admin.order-attention] Failed to fetch refund records', ...safeErrorFields(error));
    return new Map();
  }
}

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
      console.error('[admin.order-attention] Failed to fetch', ...safeErrorFields(exceptionsResult.error ?? reviewsResult.error));
      return NextResponse.json({ error: 'Failed to fetch order attention' }, { status: 500 });
    }

    const exceptionRows = (exceptionsResult.data ?? []) as unknown as ExceptionRow[];
    const [retryableRefundOrderIds, refundFailureRecords] = await Promise.all([
      fetchRetryableRefundOrderIds(supabase, exceptionRows),
      fetchRefundFailureRecords(supabase, exceptionRows),
    ]);
    const exceptions: AttentionException[] = exceptionRows.map((row) => {
      const orderStatus = row.orders?.status ?? null;
      const refundRecord = refundFailureRecords.get(row.payment_ref);
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
        canRetryRefund: row.reason === 'refund_failed' && row.order_id !== null && retryableRefundOrderIds.has(row.order_id),
        // 返金の失敗の行だけ。記録が見つからない時は額0・商品なし・返品なし（失敗の理由の言葉は要対応の detail から出る）。
        // 返品の返金の失敗なら返品の番号を返す（画面は「もう一度返金する」で注文の返品の画面を開く。本計画 P21）
        refundFailure:
          row.reason === 'refund_failed'
            ? {
                amount: refundRecord?.amount ?? 0,
                failureReasonLabel: refundFailureReasonLabel(row.detail),
                shortages: refundRecord?.shortages ?? [],
                returnId: refundRecord?.returnId ?? null,
              }
            : null,
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

    // 送信元の設定が原因で止まると店への知らせも届かないので、この窓口でも毎回状態を返す。
    // 状態だけが読めない時も、店が注文に対応できるよう要対応の欄は返す。
    const emailSending = await getOrderEmailSendState(supabase as unknown as OrderEmailStore)
      .then((state) => ({
        paused: state.paused,
        reasonLabel: state.paused ? ORDER_EMAIL_ERROR_LABELS[state.reason ?? 'config_provider'] : null,
      }))
      .catch((error: unknown) => {
        console.warn(
          '[admin.order-attention] Failed to fetch email sending state',
          error instanceof Error ? error.name : 'UnknownError',
          ...(error instanceof OrderEmailStoreError && error.code ? [error.code] : []),
        );
        return null;
      });

    const data: OrderAttention & { emailSending: { paused: boolean; reasonLabel: string | null } | null } = {
      exceptions,
      reviews,
      emailSending,
      counts: {
        exceptions: exceptionsResult.count ?? exceptions.length,
        reviews: reviewsResult.count ?? reviews.length,
      },
    };
    return NextResponse.json({ data });
  } catch (error) {
    console.error('GET /api/admin/order-attention error:', ...safeErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
