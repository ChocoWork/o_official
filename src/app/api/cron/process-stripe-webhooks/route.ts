import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { authorizeCronBearer } from '@/lib/legal-archive/cron-auth';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  webhookErrorCategory,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';
import { processStripeWebhookEvent } from '@/lib/stripe/webhook-processor';

export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorizeCronBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const store = await createServiceRoleClient() as unknown as WebhookEventStore;
  let claim: Awaited<ReturnType<typeof claimWebhookEvent>>;
  try {
    claim = await claimWebhookEvent(store);
  } catch (error) {
    console.error('[stripe-webhook-worker] Claim failed', webhookErrorCategory(error));
    return NextResponse.json({ error: 'Webhook claim failed' }, { status: 502 });
  }

  if (!claim) {
    return NextResponse.json({ processed: 0 });
  }

  try {
    const payload = claim.rawPayload;
    if (
      payload.id !== claim.eventId ||
      payload.type !== claim.eventType ||
      !payload.data ||
      typeof payload.data !== 'object' ||
      !('object' in payload.data)
    ) {
      throw new Error('Persisted Stripe event is invalid');
    }

    // 監査のIP・User-AgentをCronのものと誤認しないよう、空ヘッダーで処理する。
    const auditRequest = new NextRequest(new URL('/api/webhook/stripe', request.url));
    await processStripeWebhookEvent(payload as unknown as Stripe.Event, auditRequest);
    await completeWebhookEvent(store, claim.eventId, claim.claimToken);
    return NextResponse.json({ processed: 1 });
  } catch (error) {
    console.error('[stripe-webhook-worker] Event processing failed', claim.eventId, webhookErrorCategory(error));
    try {
      await failWebhookEvent(store, claim.eventId, claim.claimToken, error);
    } catch (stateError) {
      console.error('[stripe-webhook-worker] Failed to persist event failure', claim.eventId, webhookErrorCategory(stateError));
    }
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 502 });
  }
}