import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { processStripeWebhookEvent } from '@/lib/stripe/webhook-processor';
import type { WebhookEventStore } from '@/lib/stripe/webhook-events';
import { drainWebhookQueue, type DrainResult } from '@/lib/stripe/webhook-drain';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { runOpsChecks, type OpsCheckResult } from '@/lib/ops/ops-checks';
import { sendOpsAlertMail } from '@/lib/ops/ops-alert-mail';

/** 1回の起動で続けて処理する時間（設計書 2026-10-05 グループ B の 3-1。入口の maxDuration 60 秒に余裕を持たせる） */
export const WORKER_TIME_BUDGET_MS = 45_000;

export type WorkerRunResult = DrainResult & { checks: OpsCheckResult };

/**
 * worker の1回の起動。毎分の定期処理と、受け取り口の after() の両方から呼ぶ。
 * 取り出して処理し、最後の成功を記録し、点検して店へ知らせる（設計書 4-6）。
 */
export async function runWebhookWorker(options: { requestUrl: string; budgetMs?: number }): Promise<WorkerRunResult> {
  const store = (await createServiceRoleClient()) as unknown as WebhookEventStore & OpsStore;
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

  const checks = await runOpsChecks({ store, send: sendOpsAlertMail, now: () => new Date() });
  return { ...drain, checks };
}
