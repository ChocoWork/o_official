import { NextResponse } from 'next/server';
import { z } from 'zod';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import {
  readCheckoutPayment,
  isTransientStripeError,
  ReconcileTransientError,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';
import { logAudit } from '@/lib/audit';
import { sendOrderCanceledEmail } from '@/lib/orders/order-lifecycle-emails';
import { ADMIN_NOTE_MAX_LENGTH, CANCEL_REASONS, type OrderStatus } from '@/lib/orders/order-payment-types';

const resolveSchema = z.object({
  note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
  cancelOrder: z.boolean().default(false),
  cancelReason: z.enum(CANCEL_REASONS).optional(),
  notifyCustomer: z.boolean().default(true),
});

type ResolveRow = {
  resolved: boolean;
  order_id: string | null;
  cancelled_from: 'payment_in_progress' | 'pending' | null;
};

type AttachedOrder = {
  id: string;
  status: OrderStatus;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
};

type AuditFn = (outcome: 'success' | 'conflict' | 'error', detail: string, metadata?: Record<string, unknown>) => Promise<void>;

// 文言は管理画面の取消（orders/[id]/status）と同じ
const VOUCHER_VALID_MESSAGE = '払込票が有効な間は取り消せません。払込期限を過ぎると自動で期限切れになります。';
const STRIPE_UNAVAILABLE_MESSAGE = 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。';
const CANCEL_FAILED_MESSAGE = '未入金の注文を取り消せませんでした。';
const CHECKOUT_PROGRESSED_MESSAGE =
  '決済が進んだ可能性があるため、注文を取り消せません。時間をおいて状態を確かめてください。';

/** 支払い手続き中の注文。開いている決済画面を失効させる。開いていなければ（決済が進んだ可能性がある）断る */
async function refuseIfCheckoutProgressed(
  stripe: Stripe,
  order: AttachedOrder,
  audit: AuditFn,
): Promise<Response | null> {
  if (!order.checkout_session_id) {
    return null;
  }

  // 失効させた・Stripe に無い場合は進めてよい
  const outcome = await expireOpenCheckoutSession(stripe, order.checkout_session_id);
  if (outcome !== 'not_open') {
    return null;
  }

  await audit('conflict', 'Cannot cancel: checkout session is no longer open', { order_id: order.id });
  return NextResponse.json({ error: CHECKOUT_PROGRESSED_MESSAGE }, { status: 409 });
}

/** 入金待ちの注文。払込票が有効な間は断る（Stripe が期限切れを確定するまで取り消せない。設計書 5-2） */
async function refuseIfVoucherValid(
  stripe: Stripe,
  order: AttachedOrder,
  audit: AuditFn,
): Promise<Response | null> {
  const snapshot = await readCheckoutPayment(stripe as unknown as CheckoutPaymentStripeClient, {
    checkoutSessionId: order.checkout_session_id,
    paymentIntentId: order.payment_intent_id,
  });

  // 払込期限がまだ先なら、状態を分類できなくても有効とみなす。Stripe に無い場合は進めてよい
  const expiresAt = snapshot.voucherExpiresAt;
  const voucherValid =
    snapshot.state.kind === 'awaiting_payment' || (expiresAt !== null && expiresAt.getTime() > Date.now());
  if (!voucherValid) {
    return null;
  }

  const cancelBlockedUntil = expiresAt?.toISOString() ?? null;
  await audit('conflict', 'Cannot cancel: payment voucher is still valid', {
    order_id: order.id,
    voucher_expires_at: cancelBlockedUntil,
  });
  return NextResponse.json({ error: VOUCHER_VALID_MESSAGE, cancelBlockedUntil }, { status: 409 });
}

/**
 * 「注文を取り消して解決」の前に、Stripe の決済がまだ動くかを確かめる（管理画面の取消と同じ規則。設計書 5-2）。
 * 取り消した注文に、払える決済画面や有効な払込票を残さないため。断る・確かめられないときはその応答を返し、
 * 進めてよければ null を返す。付いている注文が無い、または未入金でなければ何もしない（RPC が断る）。
 */
async function checkStripeBeforeCancel(
  supabase: SupabaseClient,
  exceptionId: string,
  audit: AuditFn,
): Promise<Response | null> {
  const { data, error } = await supabase
    .from('payment_exceptions')
    .select('orders(id, status, checkout_session_id, payment_intent_id)')
    .eq('id', exceptionId)
    .maybeSingle<{ orders: AttachedOrder | null }>();

  if (error) {
    console.error('[admin.payment-exceptions.resolve] Failed to read the attached order:', error);
    await audit('error', 'Failed to read the attached order');
    return NextResponse.json({ error: CANCEL_FAILED_MESSAGE }, { status: 500 });
  }

  const order = data?.orders ?? null;
  if (!order || (order.status !== 'payment_in_progress' && order.status !== 'pending')) {
    return null;
  }

  const step = order.status === 'payment_in_progress' ? 'expire' : 'read';
  try {
    const stripe = getStripeServerClient();
    return order.status === 'payment_in_progress'
      ? await refuseIfCheckoutProgressed(stripe, order, audit)
      : await refuseIfVoucherValid(stripe, order, audit);
  } catch (error) {
    if (error instanceof ReconcileTransientError || isTransientStripeError(error)) {
      await audit('error', 'Cannot cancel: Stripe is temporarily unavailable', { order_id: order.id, step });
      return NextResponse.json({ error: STRIPE_UNAVAILABLE_MESSAGE }, { status: 503 });
    }

    // Stripe 以外(設定など)の失敗もここに来る。原因を Stripe と決めつけない中立な文言にし、段階は監査にだけ残す
    console.error('[admin.payment-exceptions.resolve] Failed to check Stripe before cancelling:', error);
    await audit('error', 'Failed to check Stripe before cancelling', { order_id: order.id, step });
    return NextResponse.json({ error: CANCEL_FAILED_MESSAGE }, { status: 500 });
  }
}

/**
 * 要対応を解決済みにする(設計書 5-2)。未入金の注文が付いていれば、取り消して解決もできる(メモ必須)。
 * 取り消すときは、先に Stripe の決済を確かめる(checkStripeBeforeCancel)。
 * 取り消した場合は確保した分だけ在庫を戻し、注文履歴に実行者と理由を残す(RPC の中)。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  // 解決は開き直せないので、壊れた本文は既定値で補わずスキーマで断る
  const parsedBody = resolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsedId.success || !parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const { note, cancelOrder, cancelReason, notifyCustomer } = parsedBody.data;
  if (cancelOrder && (!note || !cancelReason)) {
    return NextResponse.json(
      { error: '注文を取り消して解決するときは、取消の理由とメモを入力してください。' },
      { status: 400 },
    );
  }

  const audit: AuditFn = (outcome, detail, metadata) =>
    logAudit({
      action: 'admin.payment_exceptions.resolve',
      actor_id: authz.userId,
      resource: 'payment_exceptions',
      resource_id: parsedId.data,
      outcome,
      detail,
      metadata: metadata ?? null,
    });

  try {
    const supabase = await createServiceRoleClient();

    if (cancelOrder) {
      const refusal = await checkStripeBeforeCancel(supabase, parsedId.data, audit);
      if (refusal) {
        return refusal;
      }
    }

    const { data, error } = await supabase.rpc('resolve_payment_exception', {
      _exception_id: parsedId.data,
      _actor_id: authz.userId,
      _note: note || null,
      _cancel_order: cancelOrder,
      _cancel_reason: cancelOrder ? cancelReason : null,
      _notify_customer: cancelOrder ? notifyCustomer : null,
    });

    if (error) {
      if (error.message?.includes('ORDER_NOT_CANCELLABLE')) {
        return NextResponse.json({ error: '未入金の注文だけ取り消せます。' }, { status: 409 });
      }
      console.error('[admin.payment-exceptions.resolve] Failed to resolve:', error);
      return NextResponse.json({ error: 'Failed to resolve' }, { status: 500 });
    }

    const row = (Array.isArray(data) ? data[0] : data) as ResolveRow | null;
    if (!row?.resolved) {
      await audit('conflict', 'Payment exception was already resolved or changed');
      return NextResponse.json(
        { error: '既に解決済みか、状態が変わりました。一覧を更新してください。' },
        { status: 409 },
      );
    }

    if (row.cancelled_from && row.order_id && notifyCustomer) {
      await sendOrderCanceledEmail({
        store: supabase,
        orderId: row.order_id,
        previousStatus: row.cancelled_from,
        logLabel: '[admin]',
      });
    }

    await audit(
      'success',
      row.cancelled_from ? 'Payment exception resolved with order cancellation' : 'Payment exception resolved',
      {
        order_id: row.order_id,
        cancel_order: Boolean(row.cancelled_from),
        cancel_reason: row.cancelled_from ? cancelReason : null,
      },
    );

    return NextResponse.json({ success: true, orderCancelled: Boolean(row.cancelled_from) });
  } catch (error) {
    console.error('POST /api/admin/payment-exceptions/:id/resolve error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
