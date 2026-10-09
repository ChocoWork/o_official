import type {
  OrderEmailDeliveryStatus,
  OrderEmailErrorCode,
  OrderEmailFailureCategory,
  OrderEmailKind,
  OrderEmailPauseReason,
  OrderEmailSkipReason,
  OrderEmailStatus,
  OrderEmailVariant,
} from '@/lib/orders/email/order-email-types';
import { isOrderEmailErrorCode } from '@/lib/orders/email/order-email-types';
import type {
  OrderEmailContentResponse,
  OrderEmailHistoryRow,
  OrderStatusHistoryRow,
} from '@/lib/orders/email/order-history';

/**
 * 注文のメールの表を DB の関数で読み書きする（グループ D 設計書 7-2）。
 * 表は service_role からも直接は触れない（関数だけ）。失敗は OrderEmailStoreError にし、DB の文は残さない。
 */
type QueryError = { message?: string; code?: string } | null;

export type OrderEmailRpcName =
  | 'claim_order_email'
  | 'save_order_email_content'
  | 'complete_order_email'
  | 'fail_order_email'
  | 'skip_order_email'
  | 'pause_order_email_sending'
  | 'get_order_email_send_state'
  | 'get_order_email_backlog'
  | 'list_unnotified_dead_order_emails'
  | 'mark_order_emails_dead_notified'
  | 'list_unnotified_order_email_delivery_problems'
  | 'mark_order_email_delivery_problems_notified'
  | 'record_order_email_delivery'
  | 'list_order_emails_awaiting_delivery'
  | 'request_order_email_resend'
  | 'list_order_email_history'
  | 'list_order_status_history'
  | 'get_order_email_content';

export type OrderEmailStore = {
  rpc(name: OrderEmailRpcName, params?: Record<string, unknown>): PromiseLike<{ data: unknown; error: QueryError }>;
};

export class OrderEmailStoreError extends Error {
  readonly code: string | null;

  constructor(
    readonly operation: OrderEmailRpcName,
    error: QueryError,
  ) {
    super(`order email store failed: ${operation}`);
    this.name = 'OrderEmailStoreError';
    this.code = error?.code ?? null;
  }
}

export type ClaimedOrderEmail = {
  id: string;
  orderId: string;
  kind: OrderEmailKind;
  variant: OrderEmailVariant | null;
  origin: 'auto' | 'manual';
  attempts: number;
  leaseToken: string;
  subject: string | null;
  bodyText: string | null;
  paymentExpiredSent: boolean;
};

export type OrderEmailLease = Pick<ClaimedOrderEmail, 'id' | 'leaseToken'>;

export type OrderEmailSendState = {
  paused: boolean;
  reason: OrderEmailErrorCode | null;
  pausedAt: Date | null;
  nextProbeAt: Date | null;
};

export async function callOrderEmailRpc(
  store: OrderEmailStore,
  name: OrderEmailRpcName,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await store.rpc(name, params);
  if (error) throw new OrderEmailStoreError(name, error);
  return data;
}

export function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data && typeof data === 'object' ? [data as Record<string, unknown>] : [];
}

export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function dateOrNull(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

export async function claimOrderEmail(store: OrderEmailStore, leaseSeconds: number): Promise<ClaimedOrderEmail | null> {
  const row = rowsOf(await callOrderEmailRpc(store, 'claim_order_email', { _lease_seconds: leaseSeconds }))[0];
  if (!row) return null;
  return {
    id: String(row.email_id),
    orderId: String(row.order_id),
    kind: row.kind as OrderEmailKind,
    variant: textOrNull(row.variant) as OrderEmailVariant | null,
    origin: row.origin === 'manual' ? 'manual' : 'auto',
    attempts: Number(row.attempts),
    leaseToken: String(row.lease_token),
    subject: textOrNull(row.subject),
    bodyText: textOrNull(row.body_text),
    paymentExpiredSent: row.payment_expired_sent === true,
  };
}

export async function saveOrderEmailContent(
  store: OrderEmailStore,
  lease: OrderEmailLease,
  content: { subject: string; text: string },
): Promise<boolean> {
  const data = await callOrderEmailRpc(store, 'save_order_email_content', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _subject: content.subject,
    _body_text: content.text,
  });
  return data === true;
}

export async function completeOrderEmail(
  store: OrderEmailStore,
  lease: OrderEmailLease,
  providerMessageId: string | null,
): Promise<boolean> {
  const data = await callOrderEmailRpc(store, 'complete_order_email', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _provider_message_id: providerMessageId,
  });
  return data === true;
}

export async function failOrderEmail(
  store: OrderEmailStore,
  lease: OrderEmailLease,
  failure: { category: OrderEmailFailureCategory; code: OrderEmailErrorCode; retryAfterSeconds: number | null },
): Promise<OrderEmailStatus | null> {
  const data = await callOrderEmailRpc(store, 'fail_order_email', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _error_code: failure.code,
    _category: failure.category,
    _retry_after_seconds: failure.retryAfterSeconds,
  });
  return textOrNull(data) as OrderEmailStatus | null;
}

export async function skipOrderEmail(store: OrderEmailStore, lease: OrderEmailLease, reason: OrderEmailSkipReason): Promise<boolean> {
  const data = await callOrderEmailRpc(store, 'skip_order_email', {
    _email_id: lease.id,
    _lease_token: lease.leaseToken,
    _reason: reason,
  });
  return data === true;
}

export async function pauseOrderEmailSending(store: OrderEmailStore, reason: OrderEmailPauseReason): Promise<boolean> {
  return (await callOrderEmailRpc(store, 'pause_order_email_sending', { _reason: reason })) === true;
}

export async function getOrderEmailSendState(store: OrderEmailStore): Promise<OrderEmailSendState> {
  const row = rowsOf(await callOrderEmailRpc(store, 'get_order_email_send_state'))[0];
  return {
    paused: row?.paused === true,
    reason: isOrderEmailErrorCode(row?.reason) ? row.reason : null,
    pausedAt: dateOrNull(row?.paused_at),
    nextProbeAt: dateOrNull(row?.next_probe_at),
  };
}

/** 点検用: 書いてから一定時間たっても送れていない行の状態ごとのまとめ（設計書 4-6・4-8）。中身は含めない */
export type OrderEmailBacklogRow = {
  status: 'pending' | 'sending' | 'retry_wait';
  count: number;
  oldestCreatedAt: Date;
  lastErrors: string[];
};

export type DeadOrderEmail = {
  id: string;
  orderId: string;
  kind: OrderEmailKind;
  lastErrorCode: string | null;
  attempts: number;
  finishedAt: Date | null;
};

export type DeliveryProblemEmail = {
  id: string;
  orderId: string;
  kind: OrderEmailKind;
  deliveryStatus: OrderEmailDeliveryStatus;
  deliveryEventAt: Date | null;
};

export async function readOrderEmailBacklog(store: OrderEmailStore, olderThanSeconds: number): Promise<OrderEmailBacklogRow[]> {
  const data = await callOrderEmailRpc(store, 'get_order_email_backlog', { _older_than_seconds: olderThanSeconds });
  return rowsOf(data).map((row) => ({
    status: row.status as OrderEmailBacklogRow['status'],
    count: Number(row.email_count),
    oldestCreatedAt: new Date(String(row.oldest_created_at)),
    lastErrors: Array.isArray(row.last_errors)
      ? (row.last_errors as unknown[]).filter((value): value is string => typeof value === 'string')
      : [],
  }));
}

/** まだ店へ知らせていない「送れなかった」行。total は上限で切る前の件数 */
export async function listUnnotifiedDeadOrderEmails(
  store: OrderEmailStore,
  limit: number,
): Promise<{ emails: DeadOrderEmail[]; total: number }> {
  const list = rowsOf(await callOrderEmailRpc(store, 'list_unnotified_dead_order_emails', { _limit: limit }));
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    emails: list.map((row) => ({
      id: String(row.email_id),
      orderId: String(row.order_id),
      kind: row.kind as OrderEmailKind,
      lastErrorCode: textOrNull(row.last_error_code),
      attempts: Number(row.attempts),
      finishedAt: dateOrNull(row.finished_at),
    })),
  };
}

export async function markDeadOrderEmailsNotified(store: OrderEmailStore, emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  const data = await callOrderEmailRpc(store, 'mark_order_emails_dead_notified', { _email_ids: emailIds });
  return typeof data === 'number' ? data : 0;
}

/** まだ店へ知らせていない「届かなかった」行。total は上限で切る前の件数 */
export async function listUnnotifiedDeliveryProblems(
  store: OrderEmailStore,
  limit: number,
): Promise<{ emails: DeliveryProblemEmail[]; total: number }> {
  const list = rowsOf(await callOrderEmailRpc(store, 'list_unnotified_order_email_delivery_problems', { _limit: limit }));
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    emails: list.map((row) => ({
      id: String(row.email_id),
      orderId: String(row.order_id),
      kind: row.kind as OrderEmailKind,
      deliveryStatus: row.delivery_status as OrderEmailDeliveryStatus,
      deliveryEventAt: dateOrNull(row.delivery_event_at),
    })),
  };
}

export async function markDeliveryProblemsNotified(store: OrderEmailStore, emailIds: string[]): Promise<number> {
  if (emailIds.length === 0) return 0;
  const data = await callOrderEmailRpc(store, 'mark_order_email_delivery_problems_notified', { _email_ids: emailIds });
  return typeof data === 'number' ? data : 0;
}

export type OrderEmailDeliveryRecordResult = 'updated' | 'stale' | 'duplicate' | 'unknown_email';

export async function recordOrderEmailDelivery(
  store: OrderEmailStore,
  event: { svixId: string | null; providerMessageId: string; status: OrderEmailDeliveryStatus; eventAt: Date },
): Promise<OrderEmailDeliveryRecordResult> {
  const data = await callOrderEmailRpc(store, 'record_order_email_delivery', {
    _svix_id: event.svixId,
    _provider_message_id: event.providerMessageId,
    _delivery_status: event.status,
    _event_at: event.eventAt.toISOString(),
  });
  if (data === 'updated' || data === 'stale' || data === 'duplicate' || data === 'unknown_email') return data;
  throw new OrderEmailStoreError('record_order_email_delivery', null);
}

export async function listOrderEmailsAwaitingDelivery(
  store: OrderEmailStore,
  limit: number,
): Promise<Array<{ id: string; providerMessageId: string }>> {
  const data = await callOrderEmailRpc(store, 'list_order_emails_awaiting_delivery', { _limit: limit });
  return rowsOf(data).flatMap((row) =>
    typeof row.provider_message_id === 'string' ? [{ id: String(row.email_id), providerMessageId: row.provider_message_id }] : [],
  );
}

export class OrderEmailResendError extends Error {
  constructor(readonly reason: 'not_allowed' | 'already_queued' | 'order_not_found') {
    super(`order email resend refused: ${reason}`);
    this.name = 'OrderEmailResendError';
  }
}

/** 管理画面の再送の行を足し、行の番号を返す（設計書 5-3）。DB の断りは OrderEmailResendError にする */
export async function requestOrderEmailResend(
  store: OrderEmailStore,
  request: { orderId: string; kind: OrderEmailKind; actorId: string },
): Promise<string> {
  const { data, error } = await store.rpc('request_order_email_resend', {
    _order_id: request.orderId,
    _kind: request.kind,
    _actor_id: request.actorId,
  });
  if (error) {
    const message = error.message ?? '';
    if (message.includes('RESEND_ALREADY_QUEUED')) throw new OrderEmailResendError('already_queued');
    if (message.includes('RESEND_NOT_ALLOWED')) throw new OrderEmailResendError('not_allowed');
    if (message.includes('ORDER_NOT_FOUND')) throw new OrderEmailResendError('order_not_found');
    throw new OrderEmailStoreError('request_order_email_resend', error);
  }
  if (typeof data !== 'string') throw new OrderEmailStoreError('request_order_email_resend', null);
  return data;
}

export async function listOrderEmailHistory(store: OrderEmailStore, orderId: string): Promise<OrderEmailHistoryRow[]> {
  const data = await callOrderEmailRpc(store, 'list_order_email_history', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    id: String(row.email_id),
    kind: row.kind as OrderEmailKind,
    origin: row.origin === 'manual' ? 'manual' : 'auto',
    requestedByEmail: textOrNull(row.requested_by_email),
    status: row.status as OrderEmailStatus,
    attempts: Number(row.attempts),
    lastErrorCode: textOrNull(row.last_error_code),
    deliveryStatus: textOrNull(row.delivery_status) as OrderEmailDeliveryStatus | null,
    deliveryEventAt: textOrNull(row.delivery_event_at),
    createdAt: String(row.created_at),
    sentAt: textOrNull(row.sent_at),
    finishedAt: textOrNull(row.finished_at),
    hasBody: row.has_body === true,
    bodyErased: row.body_erased === true,
  }));
}

export async function listOrderStatusHistory(store: OrderEmailStore, orderId: string): Promise<OrderStatusHistoryRow[]> {
  const data = await callOrderEmailRpc(store, 'list_order_status_history', { _order_id: orderId });
  return rowsOf(data).map((row) => ({
    changedAt: String(row.changed_at),
    fromStatus: textOrNull(row.from_status),
    toStatus: String(row.to_status),
    changeReason: textOrNull(row.change_reason),
    actorEmail: textOrNull(row.actor_email),
    shippingCarrier: textOrNull(row.shipping_carrier),
    trackingNumber: textOrNull(row.tracking_number),
    cancelReason: textOrNull(row.cancel_reason),
  }));
}

/** 窓口が返す形（画面と共有する OrderEmailContentResponse）と同じ。二重に定義して食い違わないよう別名にする */
export type OrderEmailContent = OrderEmailContentResponse;

/** 送信済みのメールの中身。無い・送信済みでなければ null */
export async function getOrderEmailContent(
  store: OrderEmailStore,
  orderId: string,
  emailId: string,
): Promise<OrderEmailContent | null> {
  const row = rowsOf(await callOrderEmailRpc(store, 'get_order_email_content', { _order_id: orderId, _email_id: emailId }))[0];
  if (!row) return null;
  const sentAt = textOrNull(row.sent_at);
  const subject = textOrNull(row.subject);
  const bodyText = textOrNull(row.body_text);
  if (row.body_erased === true || subject === null || bodyText === null) {
    return { status: 'erased', sentAt };
  }
  return { status: 'available', subject, bodyText, sentAt };
}
