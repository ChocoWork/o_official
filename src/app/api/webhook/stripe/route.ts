import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  mapFinalizeOrderRpcError,
  parseFinalizeOrderRpcResult,
} from '@/features/cart/services/cart-stock';
import { getDraftIdFromStripeMetadata } from '@/features/checkout/services/checkout-draft.service';
import { logAudit } from '@/lib/audit';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type CheckoutDraftAuditSnapshot = {
  subtotalAmount: number | null;
  shippingAmount: number | null;
  totalAmount: number | null;
  currency: string | null;
  lineItemsCount: number;
  totalQuantity: number;
  lineTotalSum: number;
};

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

async function logWebhookAudit(
  request: NextRequest,
  action: string,
  outcome: 'success' | 'failure' | 'error' | 'conflict',
  detail: string,
  metadata?: Record<string, unknown>
) {
  await logAudit({
    action,
    resource: 'stripe_webhook',
    outcome,
    detail,
    ip: getClientIp(request),
    user_agent: request.headers.get('user-agent'),
    metadata,
  });
}

async function getCheckoutDraftAuditSnapshot(
  draftId: string
): Promise<CheckoutDraftAuditSnapshot | null> {
  const { data: draftData, error: draftError } = await supabase
    .from('checkout_drafts')
    .select('subtotal_amount, shipping_amount, total_amount, currency')
    .eq('id', draftId)
    .maybeSingle<{
      subtotal_amount: number;
      shipping_amount: number;
      total_amount: number;
      currency: string;
    }>();

  if (draftError || !draftData) {
    return null;
  }

  const { data: draftItemsData } = await supabase
    .from('checkout_draft_items')
    .select('quantity, line_total')
    .eq('draft_id', draftId);

  const lineItemsCount = draftItemsData?.length ?? 0;
  const totalQuantity = (draftItemsData ?? []).reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const lineTotalSum = (draftItemsData ?? []).reduce((sum, item) => sum + (item.line_total ?? 0), 0);

  return {
    subtotalAmount: draftData.subtotal_amount,
    shippingAmount: draftData.shipping_amount,
    totalAmount: draftData.total_amount,
    currency: draftData.currency,
    lineItemsCount,
    totalQuantity,
    lineTotalSum,
  };
}

async function createOrderFromDraft(
  request: NextRequest,
  draftId: string,
  paymentIntentId: string,
  expectedTotalAmount: number,
  currency: string,
  status: 'paid' | 'pending',
  checkoutSessionId?: string
): Promise<void> {
  const draftSnapshot = await getCheckoutDraftAuditSnapshot(draftId);

  const { data, error } = await supabase.rpc(
    'finalize_order_from_checkout_draft',
    {
      _draft_id: draftId,
      _payment_intent_id: paymentIntentId,
      _checkout_session_id: checkoutSessionId ?? null,
      _order_status: status,
      _expected_total_amount: expectedTotalAmount,
      _currency: currency,
    }
  );

  if (error) {
    const mappedError = mapFinalizeOrderRpcError(error.message ?? '');
    console.error('[webhook] finalize_order_from_checkout_draft failed', error);
    await logWebhookAudit(
      request,
      'checkout.webhook.order_finalize',
      'error',
      'Failed to finalize order from checkout draft',
      {
        draft_id: draftId,
        payment_intent_id: paymentIntentId,
        checkout_session_id: checkoutSessionId ?? null,
        error_message: error.message ?? null,
        draft_subtotal_amount: draftSnapshot?.subtotalAmount ?? null,
        draft_shipping_amount: draftSnapshot?.shippingAmount ?? null,
        draft_total_amount: draftSnapshot?.totalAmount ?? null,
        draft_currency: draftSnapshot?.currency ?? null,
        draft_line_items_count: draftSnapshot?.lineItemsCount ?? 0,
        draft_total_quantity: draftSnapshot?.totalQuantity ?? 0,
        draft_line_total_sum: draftSnapshot?.lineTotalSum ?? 0,
        expected_total_amount: expectedTotalAmount,
        expected_currency: currency,
      }
    );
    throw new Error(mappedError?.body.message ?? 'Failed to create order');
  }

  const finalizedOrder = parseFinalizeOrderRpcResult(data);
  if (!finalizedOrder) {
    console.error('[webhook] unexpected finalize_order_from_checkout_draft payload', data);
    await logWebhookAudit(
      request,
      'checkout.webhook.order_finalize',
      'error',
      'Unexpected finalize_order_from_checkout_draft payload',
      {
        draft_id: draftId,
        payment_intent_id: paymentIntentId,
        checkout_session_id: checkoutSessionId ?? null,
        draft_subtotal_amount: draftSnapshot?.subtotalAmount ?? null,
        draft_shipping_amount: draftSnapshot?.shippingAmount ?? null,
        draft_total_amount: draftSnapshot?.totalAmount ?? null,
        draft_currency: draftSnapshot?.currency ?? null,
        draft_line_items_count: draftSnapshot?.lineItemsCount ?? 0,
        draft_total_quantity: draftSnapshot?.totalQuantity ?? 0,
        draft_line_total_sum: draftSnapshot?.lineTotalSum ?? 0,
        expected_total_amount: expectedTotalAmount,
        expected_currency: currency,
      }
    );
    throw new Error('Failed to create order');
  }

  await logWebhookAudit(
    request,
    'checkout.webhook.order_finalize',
    'success',
    'Order finalized from checkout draft',
    {
      draft_id: draftId,
      payment_intent_id: paymentIntentId,
      checkout_session_id: checkoutSessionId ?? null,
      order_status: status,
      expected_total_amount: expectedTotalAmount,
      currency,
      draft_subtotal_amount: draftSnapshot?.subtotalAmount ?? null,
      draft_shipping_amount: draftSnapshot?.shippingAmount ?? null,
      draft_total_amount: draftSnapshot?.totalAmount ?? null,
      draft_currency: draftSnapshot?.currency ?? null,
      draft_line_items_count: draftSnapshot?.lineItemsCount ?? 0,
      draft_total_quantity: draftSnapshot?.totalQuantity ?? 0,
      draft_line_total_sum: draftSnapshot?.lineTotalSum ?? 0,
      expected_vs_draft_total_delta:
        draftSnapshot?.totalAmount != null
          ? expectedTotalAmount - draftSnapshot.totalAmount
          : null,
    }
  );
}

async function handleCheckoutSessionCompleted(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const draftId = getDraftIdFromStripeMetadata(session.metadata);
  if (!draftId) {
    console.error('[webhook] checkout.session.completed missing draft_id metadata', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing draft_id metadata', {
      event_type: 'checkout.session.completed',
      checkout_session_id: session.id,
    });
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.error('[webhook] checkout.session.completed missing payment_intent', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing payment_intent', {
      event_type: 'checkout.session.completed',
      checkout_session_id: session.id,
      draft_id: draftId,
    });
    return;
  }

  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('checkout_session_id', session.id)
    .maybeSingle();

  if (existingOrder) {
    console.info('[webhook] order already exists for checkout session', session.id, 'skipping');
    await logWebhookAudit(request, 'checkout.webhook.duplicate_skip', 'conflict', 'Order already exists for checkout session', {
      event_type: 'checkout.session.completed',
      checkout_session_id: session.id,
      draft_id: draftId,
      payment_intent_id: paymentIntentId,
      order_id: existingOrder.id,
    });
    return;
  }

  await createOrderFromDraft(
    request,
    draftId,
    paymentIntentId,
    session.amount_total ?? 0,
    session.currency ?? 'jpy',
    session.payment_status === 'paid' ? 'paid' : 'pending',
    session.id
  );
}

async function handleCheckoutSessionAsyncPaymentSucceeded(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    console.error('[webhook] checkout.session.async_payment_succeeded missing payment_intent', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing payment_intent', {
      event_type: 'checkout.session.async_payment_succeeded',
      checkout_session_id: session.id,
    });
    return;
  }

  const { error } = await supabase
    .from('orders')
    .update({ status: 'paid' })
    .eq('payment_intent_id', paymentIntentId)
    .eq('status', 'pending');

  if (error) {
    console.error('[webhook] failed to update order status to paid', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to mark order as paid', {
      event_type: 'checkout.session.async_payment_succeeded',
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    return;
  }

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Marked pending order as paid', {
    event_type: 'checkout.session.async_payment_succeeded',
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
  });
}

async function handleCheckoutSessionAsyncPaymentFailed(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    console.error('[webhook] checkout.session.async_payment_failed missing payment_intent', session.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing payment_intent', {
      event_type: 'checkout.session.async_payment_failed',
      checkout_session_id: session.id,
    });
    return;
  }

  const { error } = await supabase
    .from('orders')
    .update({ status: 'failed' })
    .eq('payment_intent_id', paymentIntentId)
    .eq('status', 'pending');

  if (error) {
    console.error('[webhook] failed to update order status to failed', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to mark order as failed', {
      event_type: 'checkout.session.async_payment_failed',
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    return;
  }

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Marked pending order as failed', {
    event_type: 'checkout.session.async_payment_failed',
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
  });
}

async function handleCheckoutSessionExpired(
  request: NextRequest,
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  if (!paymentIntentId) {
    console.info('[webhook] checkout.session.expired without payment_intent, skipping', session.id);
    await logWebhookAudit(request, 'checkout.webhook.duplicate_skip', 'conflict', 'checkout.session.expired without payment_intent', {
      event_type: 'checkout.session.expired',
      checkout_session_id: session.id,
    });
    return;
  }

  const { error } = await supabase
    .from('orders')
    .update({ status: 'failed' })
    .or(`checkout_session_id.eq.${session.id},payment_intent_id.eq.${paymentIntentId}`)
    .eq('status', 'pending');

  if (error) {
    console.error('[webhook] failed to mark expired checkout session order as failed', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to mark expired checkout as failed', {
      event_type: 'checkout.session.expired',
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId,
      error_message: error.message ?? null,
    });
    return;
  }

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Marked expired checkout as failed', {
    event_type: 'checkout.session.expired',
    checkout_session_id: session.id,
    payment_intent_id: paymentIntentId,
  });
}

async function handlePaymentIntentSucceeded(
  request: NextRequest,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const draftId = getDraftIdFromStripeMetadata(paymentIntent.metadata);
  if (!draftId) {
    console.error('[webhook] payment_intent.succeeded missing draft_id metadata', paymentIntent.id);
    await logWebhookAudit(request, 'checkout.webhook.event_invalid', 'failure', 'Missing draft_id metadata', {
      event_type: 'payment_intent.succeeded',
      payment_intent_id: paymentIntent.id,
    });
    return;
  }

  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('payment_intent_id', paymentIntent.id)
    .maybeSingle();

  if (existingOrder) {
    console.info('[webhook] order already exists for payment_intent', paymentIntent.id, 'skipping');
    await logWebhookAudit(request, 'checkout.webhook.duplicate_skip', 'conflict', 'Order already exists for payment_intent', {
      event_type: 'payment_intent.succeeded',
      payment_intent_id: paymentIntent.id,
      draft_id: draftId,
      order_id: existingOrder.id,
    });
    return;
  }

  await createOrderFromDraft(
    request,
    draftId,
    paymentIntent.id,
    paymentIntent.amount ?? 0,
    paymentIntent.currency ?? 'jpy',
    'paid'
  );
}

async function handlePaymentIntentFailed(
  request: NextRequest,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ status: 'failed' })
    .eq('payment_intent_id', paymentIntent.id)
    .eq('status', 'pending');

  if (error) {
    console.error('[webhook] failed to update order status to failed', error);
    await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'error', 'Failed to mark order as failed', {
      event_type: 'payment_intent.payment_failed',
      payment_intent_id: paymentIntent.id,
      error_message: error.message ?? null,
    });
    return;
  }

  await logWebhookAudit(request, 'checkout.webhook.order_status_update', 'success', 'Marked order as failed', {
    event_type: 'payment_intent.payment_failed',
    payment_intent_id: paymentIntent.id,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    await logWebhookAudit(req, 'checkout.webhook.signature_invalid', 'error', 'Webhook secret not configured');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    await logWebhookAudit(req, 'checkout.webhook.signature_invalid', 'failure', 'Missing stripe-signature header');
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = Buffer.from(await req.arrayBuffer());

  const stripe = getStripeServerClient();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[webhook] Signature verification failed:', message);
    await logWebhookAudit(req, 'checkout.webhook.signature_invalid', 'failure', 'Webhook signature verification failed', {
      error_message: message,
    });
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 }
    );
  }

  const { data: existingEvent, error: existingEventError } = await supabase
    .from('stripe_webhook_events')
    .select('id')
    .eq('id', event.id)
    .maybeSingle();

  if (existingEventError) {
    console.error('[webhook] Failed to check existing event', event.id, existingEventError);
    await logWebhookAudit(req, 'checkout.webhook.event_persist', 'error', 'Failed to check existing webhook event', {
      event_id: event.id,
      event_type: event.type,
      error_message: existingEventError.message ?? null,
    });
  }

  if (existingEvent?.id) {
    await logWebhookAudit(req, 'checkout.webhook.duplicate_skip', 'conflict', 'Duplicate webhook event skipped', {
      event_id: event.id,
      event_type: event.type,
    });
    return NextResponse.json({ received: true, duplicate: true });
  }

  const { error: persistError } = await supabase.from('stripe_webhook_events').insert({
    id: event.id,
    event_type: event.type,
    raw_payload: event as unknown as Record<string, unknown>,
  });

  if (persistError) {
    console.error('[webhook] Failed to persist event', event.id, persistError);
    await logWebhookAudit(req, 'checkout.webhook.event_persist', 'error', 'Failed to persist webhook event', {
      event_id: event.id,
      event_type: event.type,
      error_message: persistError.message ?? null,
    });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(req, event.data.object as Stripe.Checkout.Session);
        break;
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutSessionAsyncPaymentSucceeded(req, event.data.object as Stripe.Checkout.Session);
        break;
      case 'checkout.session.async_payment_failed':
        await handleCheckoutSessionAsyncPaymentFailed(req, event.data.object as Stripe.Checkout.Session);
        break;
      case 'checkout.session.expired':
        await handleCheckoutSessionExpired(req, event.data.object as Stripe.Checkout.Session);
        break;
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(req, event.data.object as Stripe.PaymentIntent);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(req, event.data.object as Stripe.PaymentIntent);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('[webhook] Error processing event', event.id, event.type, err);
    await logWebhookAudit(req, 'checkout.webhook.event_processing', 'error', 'Webhook event processing failed', {
      event_id: event.id,
      event_type: event.type,
      error_message: err instanceof Error ? err.message : 'Unknown error',
    });
    return NextResponse.json(
      { error: 'Internal server error during event processing' },
      { status: 500 }
    );
  }

  await logWebhookAudit(req, 'checkout.webhook.event_processing', 'success', 'Webhook event processed', {
    event_id: event.id,
    event_type: event.type,
  });

  return NextResponse.json({ received: true });
}