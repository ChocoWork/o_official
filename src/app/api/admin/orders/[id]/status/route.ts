import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import {
  readCheckoutPayment,
  isTransientStripeError,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';
import {
  reconcileCheckoutPayment,
  ReconcileTransientError,
  type ReconcileResult,
} from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  ADMIN_NOTE_MAX_LENGTH,
  CANCEL_REASONS,
  PAYMENT_EXCEPTION_REASON_LABELS,
  type CancelReason,
  type OrderStatus,
} from '@/lib/orders/order-payment-types';
import { INVALID_REQUEST_BODY, refundFailureBody } from '@/lib/orders/refund/refund-messages';
import { refundErrorLogFields, toRefundReply } from '@/lib/orders/refund/refund-route-support';
import { createDefaultRefundServiceDeps, submitPaidOrderCancel } from '@/lib/orders/refund/refund-service';

const orderIdSchema = z.string().uuid();

// 発送は /api/admin/orders/[id]/fulfillments に移した（グループ E-1）。この窓口は注文の取消だけ
// （未入金・失敗は今のまま、支払い済みは返金とセットで取り消す。グループ E-2）
const updateStatusSchema = z.object({
  status: z.literal('cancelled'),
  reason: z.enum(CANCEL_REASONS),
  note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
  notifyCustomer: z.boolean().default(true),
});

// 支払い済みの取消だけが読む中身。二重防止の番号は必須。在庫に戻すの既定は戻す（設計書 5-3）
const paidCancelSchema = z.object({
  requestKey: z.string().uuid(),
  restock: z.boolean().default(true),
});

const PAID_CANCEL_RATE_LIMIT = { endpoint: 'admin:orders:paid-cancel', limit: 30, windowSeconds: 600 } as const;

type CancelRequest = { reason: CancelReason; note?: string; notifyCustomer: boolean };

type CurrentOrder = {
  id: string;
  status: OrderStatus;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type AuditOutcome = 'success' | 'failure' | 'error' | 'conflict';
type AuditFn = (outcome: AuditOutcome, detail: string, metadata?: Record<string, unknown>) => Promise<void>;

const VOUCHER_VALID_MESSAGE = '払込票が有効な間は取り消せません。払込期限を過ぎると自動で期限切れになります。';
const STATE_CHANGED_MESSAGE = '注文の状態が変わったためキャンセルできませんでした。';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  return NextResponse.json(
    {
      endpoint: `/api/admin/orders/${id}/status`,
      method: 'POST',
      description: 'Order status update endpoint (cancel)',
      requiredBody: { status: 'cancelled', reason: CANCEL_REASONS },
    },
    { status: 200 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;
    const audit: AuditFn = (outcome, detail, metadata) =>
      logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: id,
        outcome,
        detail,
        ip: clientIp,
        user_agent: userAgent,
        metadata: metadata ?? null,
      });

    const parsedOrderId = orderIdSchema.safeParse(id);
    if (!parsedOrderId.success) {
      await audit('failure', 'Invalid order id');
      return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
    }

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsedBody = updateStatusSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      await audit('failure', 'Invalid request body');
      return NextResponse.json(
        { error: 'Invalid request body', details: parsedBody.error.flatten() },
        { status: 400 },
      );
    }

    const cancel: CancelRequest = {
      reason: parsedBody.data.reason,
      note: parsedBody.data.note || undefined,
      notifyCustomer: parsedBody.data.notifyCustomer,
    };
    if (cancel.reason === 'other' && !cancel.note) {
      return NextResponse.json({ error: '「その他」を選んだときはメモを入力してください。' }, { status: 400 });
    }

    const supabase = await createClient(request);
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, status, payment_intent_id, checkout_session_id')
      .eq('id', parsedOrderId.data)
      .maybeSingle<CurrentOrder>();

    if (currentOrderError) {
      console.error('[admin.orders.status] Failed to fetch order:', currentOrderError);
      return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
    }

    if (!currentOrder) {
      await audit('failure', 'Order not found');
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 支払い済みのキャンセルの送り直し（二重防止の番号つき）は、返金が成功して注文がもう取消になっていても返金の流れに回す。
    // DB は同じ番号の前の記録を返す（replayed）ので、通信が切れた後の「もう一度確かめる」も返金の窓口と同じ答えになる
    // 番号・在庫の検証は cancelPaidOrder の中で、返金の認可と回数の制限の後に1回だけ行う
    if (
      currentOrder.status === 'cancelled'
      && typeof rawBody === 'object'
      && rawBody !== null
      && 'requestKey' in rawBody
      && rawBody.requestKey != null
    ) {
      return cancelPaidOrder(request, currentOrder, rawBody, cancel, audit);
    }

    if (currentOrder.status === 'cancelled') {
      await audit('conflict', 'Order already cancelled');
      return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
    }

    if (currentOrder.status === 'shipped') {
      await audit('conflict', 'Order already shipped');
      return NextResponse.json({ error: '発送済みの注文はキャンセルできません。' }, { status: 409 });
    }

    if (currentOrder.status === 'paid') {
      return cancelPaidOrder(request, currentOrder, rawBody, cancel, audit);
    }

    if (currentOrder.status === 'abandoned') {
      await audit('conflict', 'Cannot cancel: order is abandoned');
      return NextResponse.json({ error: '放棄された注文は取り消せません。' }, { status: 409 });
    }

    if (currentOrder.status === 'failed') {
      return cancelFailedOrder(currentOrder, cancel, authz.userId, audit);
    }

    return cancelUnpaidOrder(currentOrder, cancel, authz.userId, audit);
  } catch (error) {
    console.error('POST /api/admin/orders/:id/status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * 支払い済み → 取消（グループ E-2 設計書 5-3・5-4）。残りの商品全部と送料の全額を1件の返金で返し、
 * 返金が成功した時に注文が取消になる。お金を返す操作なので、返金の権限も要る（未入金の取消はサポートの人もできる）。
 * 答えは返金の窓口と同じ形（HTTP の対応は toRefundReply の1か所）。メールの worker は返金の流れが動かす。
 */
async function cancelPaidOrder(
  request: Request,
  order: CurrentOrder,
  rawBody: unknown,
  cancel: CancelRequest,
  audit: AuditFn,
): Promise<Response> {
  const refundAuthz = await authorizeAdminPermission('admin.orders.refund', request);
  if (!refundAuthz.ok) {
    return refundAuthz.response;
  }

  const ipLimited = await enforceRateLimit({ request, ...PAID_CANCEL_RATE_LIMIT });
  if (ipLimited) {
    return ipLimited;
  }
  const actorLimited = await enforceRateLimit({ request, ...PAID_CANCEL_RATE_LIMIT, subject: refundAuthz.userId });
  if (actorLimited) {
    return actorLimited;
  }

  const parsedPaid = paidCancelSchema.safeParse(rawBody);
  if (!parsedPaid.success) {
    // 入力値や検証の詳細はメモなどを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await submitPaidOrderCancel(deps, {
      orderId: order.id,
      actorId: refundAuthz.userId,
      request: {
        requestKey: parsedPaid.data.requestKey,
        reason: cancel.reason,
        note: cancel.note ?? null,
        restock: parsedPaid.data.restock,
        notifyCustomer: cancel.notifyCustomer,
      },
    });
    const reply = toRefundReply(result);
    await audit(reply.audit.outcome, reply.audit.detail, { ...reply.audit.metadata, source: 'order_cancel' });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    console.error('[admin.orders.status] Failed to cancel paid order', ...refundErrorLogFields(error));
    await audit('error', 'Failed to cancel paid order');
    return NextResponse.json(refundFailureBody('cancel'), { status: 500 });
  }
}

/** 失敗 → 取消。在庫は戻し済み。お客様には送らない（期限切れで知らせ済み） */
async function cancelFailedOrder(
  order: CurrentOrder,
  cancel: CancelRequest,
  actorId: string,
  audit: AuditFn,
): Promise<Response> {
  const serviceRoleSupabase = await createServiceRoleClient();
  const { data, error } = await serviceRoleSupabase.rpc('admin_cancel_failed_order', {
    _order_id: order.id,
    _actor_id: actorId,
    _cancel_reason: cancel.reason,
    _note: cancel.note ?? null,
  });

  if (error) {
    console.error('[admin.orders.status] Failed to cancel failed order:', error);
    await audit('error', 'Failed to update order status');
    return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
  }

  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) {
    await audit('conflict', 'Order state changed before failed-order cancellation could be applied');
    return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
  }

  await audit('success', 'Status changed to cancelled', { from: 'failed', to: 'cancelled', cancel_reason: cancel.reason });
  return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
}

/**
 * 支払い手続き中・入金待ち → 取消（設計書 3-2・5-2、R-18）。
 * 支払い手続き中は開いている決済を先に失効させる（Checkout の PaymentIntent は直接 cancel できない）。
 * 入金待ちは払込票が有効な間は取り消さない。どちらも最後は照合関数が Stripe の現在値で決める。
 */
async function cancelUnpaidOrder(
  order: CurrentOrder,
  cancel: CancelRequest,
  actorId: string,
  audit: AuditFn,
): Promise<Response> {
  const stripe = getStripeServerClient();
  let step: 'expire' | 'read' | 'reconcile' = 'expire';

  try {
    if (order.status === 'payment_in_progress') {
      if (order.checkout_session_id) {
        try {
          await expireOpenCheckoutSession(stripe, order.checkout_session_id);
        } catch (error) {
          // expireOpenCheckoutSession は生の Stripe のエラーをそのまま投げる。一時的な失敗
          // (通信・5xx・回数制限)だけ ReconcileTransientError にして下の 503 の分岐に合わせる。
          if (isTransientStripeError(error)) {
            throw new ReconcileTransientError('stripe_unavailable', { cause: error });
          }
          throw error;
        }
      }
    } else {
      step = 'read';
      const snapshot = await readCheckoutPayment(stripe as unknown as CheckoutPaymentStripeClient, {
        checkoutSessionId: order.checkout_session_id,
        paymentIntentId: order.payment_intent_id,
      });
      if (snapshot.state.kind === 'awaiting_payment') {
        const cancelBlockedUntil = snapshot.voucherExpiresAt?.toISOString() ?? null;
        await audit('conflict', 'Cannot cancel: payment voucher is still valid', { voucher_expires_at: cancelBlockedUntil });
        return NextResponse.json({ error: VOUCHER_VALID_MESSAGE, cancelBlockedUntil }, { status: 409 });
      }
    }

    step = 'reconcile';
    const result = await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), {
      checkoutSessionId: order.checkout_session_id,
      paymentIntentId: order.payment_intent_id,
      adminCancel: { actorId, reason: cancel.reason, note: cancel.note, notifyCustomer: cancel.notifyCustomer },
    });
    return respondToCancelResult(result, order, cancel, audit);
  } catch (error) {
    if (error instanceof ReconcileTransientError) {
      await audit('error', 'Cannot cancel: Stripe or database is temporarily unavailable', { reason: error.code });
      return NextResponse.json(
        { error: 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。' },
        { status: 503 },
      );
    }

    // Stripe 以外(DB など)の失敗もここに来る。原因を Stripe と決めつけない中立な文言にし、
    // どの段階で失敗したかは監査のメタデータにだけ残す(お客様の支払いに関わる操作のため)。
    console.error('[admin.orders.status] Failed to cancel unpaid order:', error);
    await audit('error', 'Failed to cancel unpaid order', { step });
    return NextResponse.json({ error: '未入金の注文を取り消せませんでした。' }, { status: 500 });
  }
}

async function respondToCancelResult(
  result: ReconcileResult,
  order: CurrentOrder,
  cancel: CancelRequest,
  audit: AuditFn,
): Promise<Response> {
  if (result.kind === 'needs_action') {
    await audit('conflict', 'Cannot cancel: payment needs action', { exception_reason: result.reason });
    return NextResponse.json(
      {
        error: `要対応として記録しました（${PAYMENT_EXCEPTION_REASON_LABELS[result.reason]}）。ORDER タブの要対応から対応してください。`,
      },
      { status: 409 },
    );
  }

  if (result.orderStatus === 'cancelled') {
    await audit('success', 'Status changed to cancelled', {
      from: order.status,
      to: 'cancelled',
      cancel_reason: cancel.reason,
      notify_customer: cancel.notifyCustomer,
    });
    // 取消のメール（知らせる時だけ）の行は在庫を戻す関数が同じ取引で書いた。返事の後に送る
    scheduleOrderEmailDelivery();
    return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
  }

  if (result.orderStatus === 'paid' || result.orderStatus === 'shipped') {
    await audit('conflict', 'Cannot cancel: payment completed', { order_status: result.orderStatus });
    return NextResponse.json(
      { error: '支払いが完了したためキャンセルできません。返金は別の操作で行ってください。' },
      { status: 409 },
    );
  }

  if (result.orderStatus === 'pending') {
    await audit('conflict', 'Cannot cancel: payment voucher was issued');
    return NextResponse.json({ error: VOUCHER_VALID_MESSAGE }, { status: 409 });
  }

  await audit('conflict', 'Order state changed before cancellation could be applied', { order_status: result.orderStatus });
  return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
}
