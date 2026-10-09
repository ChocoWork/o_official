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

/**
 * 1回の起動で Stripe の知らせを続けて処理する時間（設計書 2026-10-05 グループ B の 3-1）。
 * 続けて注文のメールに10秒を使い（グループ D 設計書 4-7）、合わせて入口の maxDuration 60 秒に余裕を持たせる。
 */
export const WORKER_TIME_BUDGET_MS = 35_000;

export type WorkerRunResult = DrainResult & {
  checks: OpsCheckResult;
  /** 注文のメールの worker が投げたときは null（点検は続ける） */
  emails: OrderEmailWorkerResult | null;
  emailChecks: OrderEmailOpsResult;
};

/**
 * worker の1回の起動。毎分の定期処理と、受け取り口の after() の両方から呼ぶ。
 * 順番は、Stripe の知らせ → 注文のメール → 点検 → 配達の見回り（1時間に1回、最後）。
 * Stripe の知らせを先に、注文のメールを後に処理し、最後の成功を記録し、点検して店へ知らせる（設計書 4-6）。
 * 見回りは Resend の返事に左右されて長引きうるので、点検より後に置く。
 */
export async function runWebhookWorker(options: { requestUrl: string; budgetMs?: number }): Promise<WorkerRunResult> {
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

  const checks = await runOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
  const emailChecks = await runOrderEmailOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });

  // 配達の状態の見回りは最後。Resend の返事が遅くても、店への知らせの点検は先に済んでいる。
  // 見回りで見つけた不達は、次の分の点検で知らせる。1時間に1回だけ動く（前回の時刻は見回りの中で見る）。投げても、結果は返す
  try {
    await runOrderEmailDeliveryCheckIfDue(store);
  } catch (error) {
    console.error('[stripe-webhook-worker] Delivery check failed', error instanceof Error ? error.name : 'UnknownError');
  }

  return { ...drain, checks, emails, emailChecks };
}
