import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  checkoutShippingSchema,
  getDraftIdFromStripeMetadata,
  isZeroAmountCheckoutSession,
  ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
} from '@/features/checkout/services/checkout-draft.service';
import { resolvePaymentMethodFromSession } from '@/features/checkout/services/payment-method.service';
import { logAudit } from '@/lib/audit';
import { isTransientStripeError } from '@/lib/stripe/checkout-payment-reader';
import { reconcileCheckoutPayment, ReconcileTransientError } from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { describeUnexpectedError } from '@/features/checkout/services/checkout-error.service';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  // 後方互換のためフィールドは残すが、クライアント申告は採用しない（resolvePaymentMethodFromSession 参照）。
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
});

/** 注文完了として画面へ返してよい状態。失敗・放棄・取消の注文は完了として返さない */
const COMPLETED_ORDER_STATUSES = new Set(['paid', 'pending', 'shipped']);

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

// PUBLIC: ゲスト購入を許可する公開 Route。守りはカートの Cookie・回数の制限・決済の画面とカートの一致・下書きとカートの一致。
// ログインは確かめない。持ち主は「注文する」の受け付けで書き、完了は照合だけを行う（グループ C 設計書 4-5）。
export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const userAgent = req.headers.get('user-agent');

  try {
    const sessionId = req.cookies.get('session_id')?.value;
    if (!sessionId) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Session not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Session not found' }, { status: 400 });
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:complete',
      limit: 30,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'checkout:complete',
      limit: 15,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const parsed = completeCheckoutSchema.safeParse(
      await req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const stripe = getStripeServerClient();
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(
        parsed.data.checkoutSessionId,
        {
          expand: [
            'payment_intent',
            'payment_intent.payment_method',
            'payment_intent.latest_charge',
          ],
        }
      );
    } catch (error) {
      // 通信・5xx・回数制限は一時的な失敗。照合の一時的な失敗と同じく 503 にして、時間をおいた再試行へ回す。
      // 存在しない Session・認証の失敗・コードの不具合は、これまでどおり外側の catch で 500 にする。
      if (isTransientStripeError(error)) {
        await logAudit({
          action: 'checkout.complete',
          outcome: 'error',
          detail: 'Stripe checkout session retrieval is temporarily unavailable',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            session_id: sessionId,
            checkout_session_id: parsed.data.checkoutSessionId,
            reason: 'stripe_unavailable',
          },
        });
        return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
      }
      throw error;
    }

    // 実際に使われた支払方法をサーバ側で確定する（クライアント申告は採用しない）。
    const resolvedPaymentMethod = resolvePaymentMethodFromSession(session);

    if (session.metadata?.session_id && session.metadata.session_id !== sessionId) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Checkout session does not belong to current session',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
        },
      });
      return NextResponse.json(
        { error: 'Checkout session does not belong to current session' },
        { status: 403 }
      );
    }

    if (session.mode !== 'payment') {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Invalid checkout session mode',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          mode: session.mode,
        },
      });
      return NextResponse.json(
        { error: 'Invalid checkout session mode' },
        { status: 400 }
      );
    }

    const draftId = getDraftIdFromStripeMetadata(session.metadata);
    if (!draftId) {
      return NextResponse.json(
        { error: 'Checkout session draft is missing' },
        { status: 400 }
      );
    }

    // 合計が 0 の Checkout セッションは注文にしない（FREQ-389）。照合関数も記録のみにするが、
    // ここで理由を明示して断る。
    if (isZeroAmountCheckoutSession(session)) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: ZERO_AMOUNT_CHECKOUT_AUDIT_DETAIL,
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          amount_discount: session.total_details?.amount_discount ?? 0,
        },
      });
      return NextResponse.json(
        { error: 'Zero-amount checkout is not supported' },
        { status: 400 }
      );
    }

    const isSessionComplete =
      session.payment_status === 'paid' || session.status === 'complete';
    if (!isSessionComplete) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Payment is not completed yet',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          payment_status: session.payment_status,
          checkout_status: session.status,
        },
      });
      return NextResponse.json(
        { error: 'Payment is not completed yet' },
        { status: 400 }
      );
    }

    const { data: draftData, error: draftError } = await supabase
      .from('checkout_drafts')
      .select('id, session_id')
      .eq('id', draftId)
      .maybeSingle<{ id: string; session_id: string }>();

    if (draftError || !draftData) {
      return NextResponse.json(
        { error: 'Checkout draft not found' },
        { status: 400 }
      );
    }

    if (draftData.session_id !== sessionId) {
      return NextResponse.json(
        { error: 'Checkout draft does not belong to current session' },
        { status: 403 }
      );
    }

    // 注文の作成・状態の変更・在庫・メールは照合関数に任せる。Stripe の注文処理の手引きどおり、
    // Webhook と戻り先のページから同じ関数を呼ぶ（設計書 2-2）。
    let result;
    try {
      result = await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), {
        checkoutSessionId: session.id,
      });
    } catch (error) {
      if (error instanceof ReconcileTransientError) {
        await logAudit({
          action: 'checkout.complete',
          outcome: 'error',
          detail: 'Checkout payment reconciliation is temporarily unavailable',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            session_id: sessionId,
            checkout_session_id: session.id,
            reason: error.code,
          },
        });
        return NextResponse.json({ error: 'Temporarily unavailable' }, { status: 503 });
      }
      throw error;
    }

    // 照合が書いた注文のメール（入金済み・入金待ち）を、返事の後に送る（グループ D 設計書 4-7）
    scheduleOrderEmailDelivery();

    if (!result.orderId || !result.orderStatus || !COMPLETED_ORDER_STATUSES.has(result.orderStatus)) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Order could not be registered',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: session.id,
          draft_id: draftId,
          result_kind: result.kind,
          exception_reason: result.kind === 'needs_action' ? result.reason : null,
          order_status: result.orderStatus,
        },
      });
      return NextResponse.json({ error: 'Order could not be registered' }, { status: 409 });
    }

    await logAudit({
      action: 'checkout.complete',
      outcome: 'success',
      detail: 'Order reconciled from checkout session',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        checkout_session_id: session.id,
        draft_id: draftId,
        order_id: result.orderId,
        order_status: result.orderStatus,
        result_kind: result.kind,
      },
    });

    return NextResponse.json({
      orderId: result.orderId,
      status: result.orderStatus,
      paymentMethod: resolvedPaymentMethod,
    });
  } catch (error) {
    console.error('Complete checkout error:', error);
    await logAudit({
      action: 'checkout.complete',
      outcome: 'error',
      detail: 'Complete checkout handler error',
      ip: clientIp,
      user_agent: userAgent,
      metadata: describeUnexpectedError(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
