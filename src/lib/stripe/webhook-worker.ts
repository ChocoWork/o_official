import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { processStripeWebhookEvent } from '@/lib/stripe/webhook-processor';
import type { WebhookEventStore } from '@/lib/stripe/webhook-events';
import { drainWebhookQueue, type DrainResult } from '@/lib/stripe/webhook-drain';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { runOpsChecks, type OpsCheckResult } from '@/lib/ops/ops-checks';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';
import {
  ORDER_EMAIL_WORKER_BUDGET_MS,
  runOrderEmailWorker,
  type OrderEmailWorkerResult,
} from '@/lib/orders/email/order-email-worker';
import { runOrderEmailDeliveryCheckIfDue } from '@/lib/orders/email/order-email-delivery';
import { runOrderEmailOpsChecks, type OrderEmailOpsResult } from '@/lib/orders/email/order-email-ops';
import type { OrderEmailStore } from '@/lib/orders/email/order-email-store';
import {
  DELIVERY_TRACKING_BUDGET_MS, DELIVERY_TRACKING_MIN_BUDGET_MS,
  runDeliveryTrackingWorker, type DeliveryWorkerResult,
} from '@/lib/orders/tracking/delivery-worker';

/**
 * 1回の起動で Stripe の知らせを続けて処理する時間（設計書 2026-10-05 グループ B の 3-1）。
 * 続けて注文のメールに10秒を使い（グループ D 設計書 4-7）、残り時間のうち最大8秒を配送の追跡に使う。
 * 点検と配達の見回り（最大約13秒）のために15秒を残す。
 * 入口の maxDuration 60秒を超えて打ち切られても、重複防止キーで二重送信は防ぐ。
 * 店への知らせの送信中に打ち切られると、送る権利の記録が戻らず、既存の知らせは最大1時間、配送の知らせは最大1日出ない。
 */
export const WORKER_TIME_BUDGET_MS = 35_000;

export type WorkerRunResult = DrainResult & {
  checks: OpsCheckResult;
  /** 注文のメールの worker が投げたときは null（点検は続ける） */
  emails: OrderEmailWorkerResult | null;
  emailChecks: OrderEmailOpsResult;
  deliveryTracking?: DeliveryWorkerResult | null;
};

/**
 * worker の1回の起動。毎分の定期処理と、受け取り口の after() の両方から呼ぶ。
 * 順番は、Stripe の知らせ → 注文のメール → 配送の追跡 → 点検 → 配達の見回り（1時間に1回、最後）。
 * Stripe の知らせを先に、注文のメールを後に処理し、最後の成功を記録し、点検して店へ知らせる（設計書 4-6）。
 * 見回りは Resend の返事に左右されて長引きうるので、点検より後に置く。
 */
export async function runWebhookWorker(options: { requestUrl: string; budgetMs?: number }): Promise<WorkerRunResult> {
  const startedAt = Date.now();
  const store = (await createServiceRoleClient()) as unknown as WebhookEventStore & OpsStore & OrderEmailStore;
  // 監査の IP・User-Agent を定期処理のものと誤らないよう、空のヘッダーの要求で処理する（今までどおり）
  const auditRequest = new NextRequest(new URL('/api/webhook/stripe', options.requestUrl));

  const drain = await drainWebhookQueue({
    store,
    process: (event) => processStripeWebhookEvent(event, auditRequest),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? WORKER_TIME_BUDGET_MS,
  });

  const claimFailed = drain.stoppedBy === 'claim_error';
  try {
    await recordHeartbeat(store, 'webhook_worker', !claimFailed, claimFailed ? 'db_unavailable' : null);
  } catch (error) {
    console.error('[stripe-webhook-worker] Failed to record heartbeat', error instanceof Error ? error.name : 'UnknownError');
  }

  // Stripe の知らせが書いた注文のメールの行を、同じ起動の中で送る。投げても、点検は続ける
  let emails: OrderEmailWorkerResult | null = null;
  try {
    emails = await runOrderEmailWorker({ budgetMs: ORDER_EMAIL_WORKER_BUDGET_MS });
  } catch (error) {
    console.error('[stripe-webhook-worker] Order email worker failed', error instanceof Error ? error.name : 'UnknownError');
  }

  let deliveryTracking: DeliveryWorkerResult | null = null;
  const remaining = Math.max(0, 60_000 - (Date.now() - startedAt) - 15_000);
  const trackingBudget = Math.min(DELIVERY_TRACKING_BUDGET_MS, remaining);
  try {
    if (trackingBudget >= DELIVERY_TRACKING_MIN_BUDGET_MS) {
      deliveryTracking = await runDeliveryTrackingWorker({ budgetMs: trackingBudget });
    } else {
      // 予算によるskipは正常。成功のerror_codeはDBが保持しないためnullを渡す。
      await recordHeartbeat(store, 'delivery_tracking', true, null);
    }
  } catch (error) {
    console.error('[stripe-webhook-worker] Delivery tracking worker failed', error instanceof Error ? error.name : 'UnknownError');
    try { await recordHeartbeat(store, 'delivery_tracking', false, 'delivery_tracking_error'); }
    catch (heartbeatError) {
      console.error('[stripe-webhook-worker] Failed to record delivery heartbeat', heartbeatError instanceof Error ? heartbeatError.name : 'UnknownError');
    }
  }

  const checks = await runOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
  const emailChecks = await runOrderEmailOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });

  // 配達の状態の見回りは最後。Resend の返事が遅くても、店への知らせの点検は先に済んでいる。
  // 見回りで見つけた不達は、次の分の点検で知らせる。1時間に1回だけ動く（前回の時刻は見回りの中で見る）。投げても、結果は返す
  try {
    await runOrderEmailDeliveryCheckIfDue(store);
  } catch (error) {
    console.error('[stripe-webhook-worker] Delivery check failed', error instanceof Error ? error.name : 'UnknownError');
  }

  return { ...drain, checks, emails, emailChecks, deliveryTracking };
}
