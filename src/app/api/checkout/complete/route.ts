import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  mapFinalizeOrderRpcError,
  parseFinalizeOrderRpcResult,
} from '@/features/cart/services/cart-stock';
import {
  checkoutShippingSchema,
  getDraftIdFromStripeMetadata,
  isStripeCheckoutPaymentMethod,
  mapStripePaymentMethodType,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
  type CheckoutDraftRow,
  type StripeCheckoutPaymentMethod,
} from '@/features/checkout/services/checkout-draft.service';
import { logAudit } from '@/lib/audit';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const completeCheckoutSchema = z.object({
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  checkoutSessionId: z.string().trim().min(1),
  shipping: checkoutShippingSchema,
});

type OrderRow = {
  id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
};

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

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
    const session = await stripe.checkout.sessions.retrieve(
      parsed.data.checkoutSessionId,
      {
        expand: ['payment_intent'],
      }
    );

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

    const resolvedPaymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
    if (!resolvedPaymentIntentId) {
      return NextResponse.json(
        { error: 'Stripe payment intent is missing' },
        { status: 400 }
      );
    }

    const resolvedCurrency = session.currency?.toLowerCase() ?? null;
    const resolvedAmount = session.amount_total ?? null;
    if (!resolvedCurrency || !resolvedAmount) {
      return NextResponse.json(
        { error: 'Checkout session amount is missing' },
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
      .select('id, session_id, total_amount, currency')
      .eq('id', draftId)
      .maybeSingle<CheckoutDraftRow>();

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

    if (draftData.total_amount !== resolvedAmount) {
      return NextResponse.json(
        { error: 'Checkout session amount does not match draft total' },
        { status: 400 }
      );
    }

    if (draftData.currency.toLowerCase() !== resolvedCurrency) {
      return NextResponse.json(
        { error: 'Unsupported currency' },
        { status: 400 }
      );
    }

    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id, status')
      .eq('checkout_session_id', parsed.data.checkoutSessionId)
      .maybeSingle<OrderRow>();

    if (existingOrder) {
      await logAudit({
        action: 'checkout.complete',
        outcome: 'conflict',
        detail: 'Order already finalized',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          order_id: existingOrder.id,
          order_status: existingOrder.status,
        },
      });
      return NextResponse.json({
        orderId: existingOrder.id,
        status: existingOrder.status,
        paymentMethod: resolvePaymentMethod(parsed.data.paymentMethod, session),
      });
    }

    const { data: finalizedOrderData, error: finalizeOrderError } = await supabase.rpc(
      'finalize_order_from_checkout_draft',
      {
        _draft_id: draftId,
        _payment_intent_id: resolvedPaymentIntentId,
        _checkout_session_id: parsed.data.checkoutSessionId,
        _order_status: session.payment_status === 'paid' ? 'paid' : 'pending',
        _expected_total_amount: resolvedAmount,
        _currency: resolvedCurrency,
      }
    );

    if (finalizeOrderError) {
      console.error('Failed to finalize order in complete checkout:', finalizeOrderError);
      await logAudit({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Failed to finalize order via RPC',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          draft_id: draftId,
          payment_intent_id: resolvedPaymentIntentId,
          error_message: finalizeOrderError.message ?? null,
        },
      });
      const mappedError = mapFinalizeOrderRpcError(finalizeOrderError.message ?? '');
      if (mappedError) {
        return NextResponse.json(mappedError.body, { status: mappedError.status });
      }

      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    const finalizedOrder = parseFinalizeOrderRpcResult(finalizedOrderData);
    if (!finalizedOrder) {
      console.error('Unexpected finalize_order_from_checkout_draft payload:', finalizedOrderData);
      await logAudit({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Unexpected finalize_order_from_checkout_draft payload',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          checkout_session_id: parsed.data.checkoutSessionId,
          draft_id: draftId,
          payment_intent_id: resolvedPaymentIntentId,
        },
      });
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    await logAudit({
      action: 'checkout.complete',
      outcome: 'success',
      detail: 'Order finalized from checkout session',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        checkout_session_id: parsed.data.checkoutSessionId,
        draft_id: draftId,
        payment_intent_id: resolvedPaymentIntentId,
        order_id: finalizedOrder.order_id,
        order_status: finalizedOrder.order_status,
      },
    });

    return NextResponse.json({
      orderId: finalizedOrder.order_id,
      status: finalizedOrder.order_status,
      paymentMethod: resolvePaymentMethod(parsed.data.paymentMethod, session),
    });
  } catch (error) {
    console.error('Complete checkout error:', error);
    await logAudit({
      action: 'checkout.complete',
      outcome: 'error',
      detail: 'Complete checkout handler error',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        error_message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function resolvePaymentMethod(
  requestedPaymentMethod: StripeCheckoutPaymentMethod | undefined,
  session: Awaited<ReturnType<ReturnType<typeof getStripeServerClient>['checkout']['sessions']['retrieve']>>
): StripeCheckoutPaymentMethod {
  const selectedPaymentMethod = session.metadata?.selected_payment_method;
  if (isStripeCheckoutPaymentMethod(selectedPaymentMethod)) {
    return requestedPaymentMethod ?? selectedPaymentMethod;
  }

  if (requestedPaymentMethod) {
    return requestedPaymentMethod;
  }

  if (typeof session.payment_intent !== 'string') {
    return mapStripePaymentMethodType(
      session.payment_intent?.payment_method_types?.[0]
    );
  }

  return 'stripe_card';
}