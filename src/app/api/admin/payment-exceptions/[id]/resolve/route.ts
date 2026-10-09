import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import {
  readCheckoutPayment,
  isTransientStripeError,
  ReconcileTransientError,
  type CheckoutPaymentSnapshot,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { logAudit } from '@/lib/audit';
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

// 払込票の文言は管理画面の取消（orders/[id]/status）と同じ
const VOUCHER_VALID_MESSAGE = '払込票が有効な間は取り消せません。払込期限を過ぎると自動で期限切れになります。';
const PAID_MESSAGE = '支払い済みのため、注文を取り消せません。';
const IN_PROGRESS_MESSAGE = '決済が進行中のため、注文を取り消せません。時間をおいて状態を確かめてください。';
const STRIPE_UNAVAILABLE_MESSAGE = 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。';
const CANCEL_FAILED_MESSAGE = '未入金の注文を取り消せませんでした。';

/**
 * Stripe がまだお金を受け取れる（すでに受け取った）状態なら、取り消さない応答を返す。取り消してよければ null。
 * 払込票が有効な間は、Stripe が期限切れを確定する（払込期限が過ぎる）まで取り消せない（設計書 3-2・5-2）。
 */
async function refuseIfStripeMayTakeMoney(
  snapshot: CheckoutPaymentSnapshot,
  orderId: string,
  audit: AuditFn,
): Promise<Response | null> {
  const { state, voucherExpiresAt } = snapshot;

  if (state.kind === 'paid') {
    await audit('conflict', 'Cannot cancel: payment is already completed', { order_id: orderId });
    return NextResponse.json({ error: PAID_MESSAGE }, { status: 409 });
  }

  if (state.kind === 'in_progress') {
    await audit('conflict', 'Cannot cancel: checkout is still in progress', { order_id: orderId });
    return NextResponse.json({ error: IN_PROGRESS_MESSAGE }, { status: 409 });
  }

  // 払込期限がまだ先なら、状態を分類できなくても有効とみなす
  if (state.kind === 'awaiting_payment' || (voucherExpiresAt !== null && voucherExpiresAt.getTime() > Date.now())) {
    const cancelBlockedUntil = voucherExpiresAt?.toISOString() ?? null;
    await audit('conflict', 'Cannot cancel: payment voucher is still valid', {
      order_id: orderId,
      voucher_expires_at: cancelBlockedUntil,
    });
    return NextResponse.json({ error: VOUCHER_VALID_MESSAGE, cancelBlockedUntil }, { status: 409 });
  }

  return null;
}

/**
 * 「注文を取り消して解決」の前に、Stripe がもうお金を受け取れないことを確かめる（設計書 5-2。取り消した注文に、
 * 払える決済画面や有効な払込票、入金済みの支払いを残さない）。断る・確かめられないときはその応答を返し、
 * 進めてよければ null を返す。
 * 1. 解決済み、注文が付いていない、注文が未入金でない: Stripe には触れない（RPC が断る）。
 * 2. 決済画面の ID があれば、状態を問わず先に失効を試みる（開いていなければ何もしない）。
 * 3. Stripe を読み直し、支払い済み・進行中・払込票が有効なら断る。それ以外（0円完了・放棄・期限切れ・
 *    Stripe に無い・想定外）は取り消してよい。Stripe を引く ID が無い注文は読まずに RPC へ進める。
 */
async function checkStripeBeforeCancel(
  supabase: SupabaseClient,
  exceptionId: string,
  audit: AuditFn,
): Promise<Response | null> {
  const { data, error } = await supabase
    .from('payment_exceptions')
    .select('resolved_at, orders(id, status, checkout_session_id, payment_intent_id)')
    .eq('id', exceptionId)
    .maybeSingle<{ resolved_at: string | null; orders: AttachedOrder | null }>();

  if (error) {
    console.error('[admin.payment-exceptions.resolve] Failed to read the attached order:', error);
    await audit('error', 'Failed to read the attached order');
    return NextResponse.json({ error: CANCEL_FAILED_MESSAGE }, { status: 500 });
  }

  // 解決済みなら Stripe には触れない。開いている決済画面を失効させても取り消せず、RPC が「既に解決済み」で断るだけになる
  const order = data && !data.resolved_at ? data.orders : null;
  if (!order || (order.status !== 'payment_in_progress' && order.status !== 'pending')) {
    return null;
  }

  let step: 'expire' | 'read' = 'expire';
  try {
    const stripe = getStripeServerClient();

    if (order.checkout_session_id) {
      // 開いていれば失効させる。開いていない・Stripe に無い場合は何もしないので、結果は問わず読み直しで決める
      await expireOpenCheckoutSession(stripe, order.checkout_session_id);
    }

    if (!order.checkout_session_id && !order.payment_intent_id) {
      return null;
    }

    step = 'read';
    const snapshot = await readCheckoutPayment(stripe as unknown as CheckoutPaymentStripeClient, {
      checkoutSessionId: order.checkout_session_id,
      paymentIntentId: order.payment_intent_id,
    });
    return await refuseIfStripeMayTakeMoney(snapshot, order.id, audit);
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
 * 取り消すときは、先に Stripe がもうお金を受け取れないことを確かめる(checkStripeBeforeCancel)。
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

    if (row.cancelled_from) {
      // 取消のメールは在庫を戻す関数が同じ取引で行を書いた（知らせる時だけ）。返事の後に送る
      scheduleOrderEmailDelivery();
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
