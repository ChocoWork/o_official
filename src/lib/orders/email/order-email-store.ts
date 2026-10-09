import type {
  OrderEmailErrorCode,
  OrderEmailFailureCategory,
  OrderEmailKind,
  OrderEmailPauseReason,
  OrderEmailSkipReason,
  OrderEmailStatus,
  OrderEmailVariant,
} from '@/lib/orders/email/order-email-types';
import { isOrderEmailErrorCode } from '@/lib/orders/email/order-email-types';

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
  | 'get_order_email_send_state';

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
