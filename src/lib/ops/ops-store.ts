/**
 * 知らせと定期処理の記録を DB の関数で読み書きする（設計書 2026-10-05 グループ B の 4-6・5-2・6）。
 * 表は service_role からも直接は触れない（関数だけ）。失敗は OpsStoreError にして投げる（DB の中身は残さない）。
 */
type QueryError = { message?: string; code?: string } | null;

export type OpsRpcName =
  | 'get_ops_heartbeats'
  | 'record_ops_heartbeat'
  | 'bump_ops_signal'
  | 'claim_ops_alert'
  | 'release_ops_alert'
  | 'get_stripe_webhook_backlog'
  | 'list_unnotified_dead_stripe_webhook_events'
  | 'mark_stripe_webhook_dead_notified'
  | 'mark_order_recovered_from_payment';

export type OpsStore = {
  rpc(name: OpsRpcName, params?: Record<string, unknown>): Promise<{ data: unknown; error: QueryError }>;
};

export type OpsJob = 'webhook_worker' | 'order_sweep' | 'stripe_reconcile' | 'order_email_worker' | 'order_email_delivery_check';

export type OpsAlertKey =
  | 'webhook_backlog'
  | 'webhook_dead'
  | 'webhook_signature_invalid'
  | 'webhook_mode_mismatch'
  | 'job_stale_order_sweep'
  | 'job_stale_stripe_reconcile'
  | 'order_email_paused'
  | 'order_email_backlog'
  | 'order_email_dead'
  | 'order_email_delivery_problem'
  | 'job_stale_order_email_worker';

export type Heartbeat = { lastSucceededAt: Date | null; lastFailedAt: Date | null; lastErrorCode: string | null };

export type AlertClaim = { key: OpsAlertKey; claimedAt: string; previousSentAt: string | null };

export type BacklogRow = {
  status: 'queued' | 'processing' | 'failed';
  count: number;
  oldestReceivedAt: Date;
  lastErrors: string[];
};

export type DeadEvent = {
  eventId: string;
  eventType: string;
  cause: string | null;
  receivedAt: Date;
  attemptCount: number;
  deadAt: Date;
};

export type RecoveredReviewReason = 'recovered_from_payment' | 'stock_not_reserved';

export class OpsStoreError extends Error {
  constructor(operation: OpsRpcName) {
    super(`ops store failed: ${operation}`);
    this.name = 'OpsStoreError';
  }
}

async function call(store: OpsStore, name: OpsRpcName, params?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await store.rpc(name, params);
  if (error) throw new OpsStoreError(name);
  return data;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function dateOrNull(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

export async function readHeartbeats(store: OpsStore): Promise<Partial<Record<OpsJob, Heartbeat>>> {
  const result: Partial<Record<OpsJob, Heartbeat>> = {};
  for (const row of rowsOf(await call(store, 'get_ops_heartbeats'))) {
    result[row.job as OpsJob] = {
      lastSucceededAt: dateOrNull(row.last_succeeded_at),
      lastFailedAt: dateOrNull(row.last_failed_at),
      lastErrorCode: typeof row.last_error_code === 'string' ? row.last_error_code : null,
    };
  }
  return result;
}

export async function recordHeartbeat(
  store: OpsStore,
  job: OpsJob,
  succeeded: boolean,
  errorCode: string | null = null,
): Promise<void> {
  await call(store, 'record_ops_heartbeat', { _job: job, _succeeded: succeeded, _error_code: errorCode });
}

export async function bumpSignal(store: OpsStore, key: OpsAlertKey, windowSeconds: number): Promise<number> {
  const data = await call(store, 'bump_ops_signal', { _alert_key: key, _window_seconds: windowSeconds });
  if (typeof data !== 'number') throw new OpsStoreError('bump_ops_signal');
  return data;
}

export async function claimAlert(store: OpsStore, key: OpsAlertKey, cooldownSeconds: number): Promise<AlertClaim | null> {
  const row = rowsOf(await call(store, 'claim_ops_alert', { _alert_key: key, _cooldown_seconds: cooldownSeconds }))[0];
  if (!row || row.claimed !== true || typeof row.claimed_at !== 'string') return null;
  return {
    key,
    claimedAt: row.claimed_at,
    previousSentAt: typeof row.previous_sent_at === 'string' ? row.previous_sent_at : null,
  };
}

export async function releaseAlert(store: OpsStore, claim: AlertClaim): Promise<void> {
  await call(store, 'release_ops_alert', {
    _alert_key: claim.key,
    _claimed_at: claim.claimedAt,
    _previous_sent_at: claim.previousSentAt,
  });
}

export async function readWebhookBacklog(store: OpsStore, olderThanSeconds: number): Promise<BacklogRow[]> {
  const data = await call(store, 'get_stripe_webhook_backlog', { _older_than_seconds: olderThanSeconds });
  return rowsOf(data).map((row) => ({
    status: row.processing_status as BacklogRow['status'],
    count: Number(row.event_count),
    oldestReceivedAt: new Date(String(row.oldest_received_at)),
    lastErrors: Array.isArray(row.last_errors)
      ? (row.last_errors as unknown[]).filter((value): value is string => typeof value === 'string')
      : [],
  }));
}

export async function listUnnotifiedDeadEvents(
  store: OpsStore,
  limit: number,
): Promise<{ events: DeadEvent[]; total: number }> {
  const list = rowsOf(await call(store, 'list_unnotified_dead_stripe_webhook_events', { _limit: limit }));
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    events: list.map((row) => ({
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      cause: typeof row.last_error === 'string' ? row.last_error : null,
      receivedAt: new Date(String(row.received_at)),
      attemptCount: Number(row.attempt_count),
      deadAt: new Date(String(row.dead_at)),
    })),
  };
}

export async function markDeadEventsNotified(store: OpsStore, eventIds: string[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  const data = await call(store, 'mark_stripe_webhook_dead_notified', { _event_ids: eventIds });
  return typeof data === 'number' ? data : 0;
}

export async function markOrderRecoveredFromPayment(store: OpsStore, orderId: string): Promise<RecoveredReviewReason> {
  const data = await call(store, 'mark_order_recovered_from_payment', { _order_id: orderId });
  if (data !== 'recovered_from_payment' && data !== 'stock_not_reserved') {
    throw new OpsStoreError('mark_order_recovered_from_payment');
  }
  return data;
}
