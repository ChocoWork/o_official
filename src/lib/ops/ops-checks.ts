import {
  claimAlert,
  listUnnotifiedDeadEvents,
  markDeadEventsNotified,
  readHeartbeats,
  readWebhookBacklog,
  releaseAlert,
  type OpsAlertKey,
  type OpsStore,
} from '@/lib/ops/ops-store';
import {
  backlogAlertMail,
  deadDigestMail,
  staleJobMail,
  type OpsAlertMail,
} from '@/lib/ops/ops-alert-mail';

/**
 * 点検（設計書 2026-10-05 グループ B の 4-6）。worker と見回りの終わりに同じ点検を行う。
 * - 溜まり: 受け取ってから15分以上たって完了していない知らせ
 * - 退避: まだ知らせていない退避（まとめて1通、50件まで）
 * - 遅れ: 見回りは最後の成功から2時間、照合は25時間（一度も成功していない処理は対象にしない）
 * 種類ごとに1時間に1回まで。送れなければ送る権利を返す。点検の1つが失敗しても、残りは続ける。
 * アプリや DB ごと止まったときは知らせが出ない（外からの見張りは入れないと決めた）。
 */
export const OPS_CHECK_LIMITS = {
  backlogAgeSeconds: 15 * 60,
  alertCooldownSeconds: 60 * 60,
  deadDigestLimit: 50,
  staleAfterSeconds: { order_sweep: 2 * 60 * 60, stripe_reconcile: 25 * 60 * 60 },
} as const;

export type OpsCheckDeps = {
  store: OpsStore;
  send: (mail: OpsAlertMail) => Promise<boolean>;
  now: () => Date;
};

export type OpsCheckResult = {
  backlogAlerted: boolean;
  deadNotified: number;
  staleAlerted: Array<'order_sweep' | 'stripe_reconcile'>;
  failedChecks: Array<'backlog' | 'dead' | 'stale'>;
};

const STALE_JOBS = ['order_sweep', 'stripe_reconcile'] as const;

async function sendOnce(deps: OpsCheckDeps, key: OpsAlertKey, mail: () => OpsAlertMail): Promise<boolean> {
  const claim = await claimAlert(deps.store, key, OPS_CHECK_LIMITS.alertCooldownSeconds);
  if (!claim) return false;
  if (await deps.send(mail())) return true;
  await releaseAlert(deps.store, claim);
  return false;
}

function logFailure(check: string, error: unknown): void {
  console.error(`[ops-checks] ${check} check failed`, error instanceof Error ? error.name : 'UnknownError');
}

export async function runOpsChecks(deps: OpsCheckDeps): Promise<OpsCheckResult> {
  const result: OpsCheckResult = { backlogAlerted: false, deadNotified: 0, staleAlerted: [], failedChecks: [] };

  try {
    const backlog = await readWebhookBacklog(deps.store, OPS_CHECK_LIMITS.backlogAgeSeconds);
    if (backlog.length > 0) {
      result.backlogAlerted = await sendOnce(deps, 'webhook_backlog', () => backlogAlertMail(backlog));
    }
  } catch (error) {
    result.failedChecks.push('backlog');
    logFailure('backlog', error);
  }

  try {
    const { events, total } = await listUnnotifiedDeadEvents(deps.store, OPS_CHECK_LIMITS.deadDigestLimit);
    if (events.length > 0) {
      const claim = await claimAlert(deps.store, 'webhook_dead', OPS_CHECK_LIMITS.alertCooldownSeconds);
      if (claim) {
        if (await deps.send(deadDigestMail(events, total))) {
          result.deadNotified = await markDeadEventsNotified(deps.store, events.map((event) => event.eventId));
        } else {
          await releaseAlert(deps.store, claim);
        }
      }
    }
  } catch (error) {
    result.failedChecks.push('dead');
    logFailure('dead', error);
  }

  try {
    const heartbeats = await readHeartbeats(deps.store);
    for (const job of STALE_JOBS) {
      const lastSucceededAt = heartbeats[job]?.lastSucceededAt;
      if (!lastSucceededAt) continue;
      const elapsedMs = deps.now().getTime() - lastSucceededAt.getTime();
      if (elapsedMs < OPS_CHECK_LIMITS.staleAfterSeconds[job] * 1000) continue;
      if (await sendOnce(deps, `job_stale_${job}`, () => staleJobMail(job, lastSucceededAt))) {
        result.staleAlerted.push(job);
      }
    }
  } catch (error) {
    result.failedChecks.push('stale');
    logFailure('stale', error);
  }

  return result;
}
