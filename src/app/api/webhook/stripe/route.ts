import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { getStripeServerClient } from '@/lib/stripe/server';
import { logAudit } from '@/lib/audit';
import {
  enqueueWebhookEvent,
  webhookErrorCategory,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// PUBLIC: Stripe の署名を raw body で検証し、DBへの永続化に成功してから応答する。
export async function POST(req: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = Buffer.from(await req.arrayBuffer());
  let event: Stripe.Event;

  try {
    event = getStripeServerClient().webhooks.constructEvent(
      rawBody, signature, webhookSecret
    );
  } catch (error) {
    console.error('[webhook] Signature verification failed',
      error instanceof Error ? error.name : 'UnknownError');
    await logAudit({
      action: 'checkout.webhook.signature_invalid',
      resource: 'stripe_webhook',
      outcome: 'failure',
      detail: 'Webhook signature verification failed',
    });
    return NextResponse.json(
      { error: 'Webhook signature verification failed' },
      { status: 400 },
    );
  }

  try {
    const inserted = await enqueueWebhookEvent(
      supabase as unknown as WebhookEventStore,
      {
        id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      },
    );
    return NextResponse.json({ received: true, duplicate: !inserted });
  } catch (error) {
    console.error('[webhook] Failed to persist verified event', event.id, webhookErrorCategory(error));
    return NextResponse.json(
      { error: 'Failed to persist webhook event' },
      { status: 500 },
    );
  }
}