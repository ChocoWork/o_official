import type Stripe from 'stripe';
import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  InvalidWebhookPayloadError,
  webhookErrorCategory,
  webhookFailureCause,
  type ClaimedWebhookEvent,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';

/**
 * キューから知らせを取り出して処理する繰り返し（設計書 2026-10-05 グループ B の 3-1・3-2）。
 * 取り出せる知らせが無くなるか、時間の予算を使い切るまで1件ずつ処理する（R-35）。
 * 1件の失敗は失敗として記録して次へ進む。同時に動いても、DB の取り出し（SKIP LOCKED と担当の印）で二重に取らない。
 */
export type DrainResult = { processed: number; failed: number; stoppedBy: 'empty' | 'budget' | 'claim_error' };

export type DrainDeps = {
  store: WebhookEventStore;
  process: (event: Stripe.Event) => Promise<void>;
  now: () => number;
  budgetMs: number;
};

export function toStripeEvent(claim: ClaimedWebhookEvent): Stripe.Event {
  const payload = claim.rawPayload;
  const data = payload.data;
  if (
    payload.id !== claim.eventId
    || payload.type !== claim.eventType
    || !data
    || typeof data !== 'object'
    || !('object' in data)
  ) {
    throw new InvalidWebhookPayloadError();
  }
  return payload as unknown as Stripe.Event;
}

export async function drainWebhookQueue(deps: DrainDeps): Promise<DrainResult> {
  const startedAt = deps.now();
  const result: DrainResult = { processed: 0, failed: 0, stoppedBy: 'budget' };

  while (deps.now() - startedAt < deps.budgetMs) {
    let claim: ClaimedWebhookEvent | null;
    try {
      claim = await claimWebhookEvent(deps.store);
    } catch (error) {
      console.error('[stripe-webhook-worker] Claim failed', webhookErrorCategory(error));
      return { ...result, stoppedBy: 'claim_error' };
    }
    if (!claim) return { ...result, stoppedBy: 'empty' };

    try {
      await deps.process(toStripeEvent(claim));
      await completeWebhookEvent(deps.store, claim.eventId, claim.claimToken);
      result.processed += 1;
    } catch (error) {
      result.failed += 1;
      console.error('[stripe-webhook-worker] Event processing failed', claim.eventId, webhookFailureCause(error));
      try {
        await failWebhookEvent(deps.store, claim.eventId, claim.claimToken, error);
      } catch (stateError) {
        console.error(
          '[stripe-webhook-worker] Failed to persist event failure',
          claim.eventId,
          webhookErrorCategory(stateError),
        );
      }
    }
  }
  return result;
}
