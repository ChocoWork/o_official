import { OpsStoreError, readHeartbeats } from '@/lib/ops/ops-store';
import { sendOnce, type OpsCheckDeps } from '@/lib/ops/ops-checks';
import {
  passkeyNotificationDeadMail,
  passkeyNotificationStaleMail,
  type DeadPasskeyNotificationSummary,
} from '@/lib/ops/ops-alert-mail';

/**
 * パスキーの知らせの点検（段3b。DD-AUTH-089）。毎分の worker の終わりに呼ぶ。
 * - 死んだ知らせ: まだ店に知らせていない `dead` の行を、まとめて1通（50件まで）。送れた時だけ印を付ける
 * - worker の停止: 心拍の最後の成功から30分（一度も成功していなければ対象にしない）
 * 種類ごとに1時間に1回まで（sendOnce の冷却）。一方が失敗しても、もう一方は続ける。メールにアドレス・本文は入れない。
 */
export const PASSKEY_NOTIFICATION_OPS_LIMITS = {
  digestLimit: 50,
  staleAfterSeconds: 30 * 60,
} as const;

export type PasskeyNotificationOpsResult = {
  deadNotified: number;
  staleAlerted: boolean;
  failedChecks: Array<'dead' | 'stale'>;
};

function logFailure(check: string, error: unknown): void {
  console.error(
    `[passkey-notification-ops] ${check} check failed`,
    error instanceof OpsStoreError ? error.message : error instanceof Error ? error.name : 'UnknownError',
  );
}

type DeadRow = DeadPasskeyNotificationSummary & { id: string };

async function listUnnotifiedDead(deps: OpsCheckDeps, limit: number): Promise<{ rows: DeadRow[]; total: number }> {
  const { data, error } = await deps.store.rpc('list_unnotified_dead_passkey_notifications', { _limit: limit });
  if (error) throw new OpsStoreError('list_unnotified_dead_passkey_notifications');
  const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return {
    total: list.length > 0 ? Number(list[0].total) : 0,
    rows: list.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
      finishedAt: typeof row.finished_at === 'string' ? new Date(row.finished_at) : null,
    })),
  };
}

async function markDeadNotified(deps: OpsCheckDeps, ids: string[]): Promise<number> {
  const { data, error } = await deps.store.rpc('mark_passkey_notification_dead_notified', { _ids: ids });
  if (error) throw new OpsStoreError('mark_passkey_notification_dead_notified');
  return typeof data === 'number' ? data : 0;
}

/**
 * @impl IMPL-AUTH-413
 * @design DD-AUTH-089
 */
export async function runPasskeyNotificationOpsChecks(deps: OpsCheckDeps): Promise<PasskeyNotificationOpsResult> {
  const result: PasskeyNotificationOpsResult = { deadNotified: 0, staleAlerted: false, failedChecks: [] };

  try {
    const { rows, total } = await listUnnotifiedDead(deps, PASSKEY_NOTIFICATION_OPS_LIMITS.digestLimit);
    if (rows.length > 0 && (await sendOnce(deps, 'passkey_notification_dead', passkeyNotificationDeadMail(rows, total)))) {
      // 印付けに失敗したら、1時間後の点検で同じ分を知らせ直す（知らせを失うより再送を選ぶ。at-least-once）
      result.deadNotified = await markDeadNotified(deps, rows.map((row) => row.id));
    }
  } catch (error) {
    result.failedChecks.push('dead');
    logFailure('dead', error);
  }

  try {
    const lastSucceededAt = (await readHeartbeats(deps.store)).passkey_notification_worker?.lastSucceededAt ?? null;
    if (lastSucceededAt && deps.now().getTime() - lastSucceededAt.getTime() >= PASSKEY_NOTIFICATION_OPS_LIMITS.staleAfterSeconds * 1000) {
      result.staleAlerted = await sendOnce(deps, 'job_stale_passkey_notification_worker', passkeyNotificationStaleMail(lastSucceededAt));
    }
  } catch (error) {
    result.failedChecks.push('stale');
    logFailure('stale', error);
  }

  return result;
}
