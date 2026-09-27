type QueryError = { message?: string } | null;

export type WebhookEventStore = {
  rpc(
    name:
      | 'enqueue_stripe_webhook_event'
      | 'claim_stripe_webhook_event'
      | 'complete_stripe_webhook_event'
      | 'fail_stripe_webhook_event',
    params?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: QueryError }>;
};

export type WebhookEventInput = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

export type ClaimedWebhookEvent = {
  eventId: string;
  eventType: string;
  rawPayload: Record<string, unknown>;
  claimToken: string;
};

function unwrapRpc(
  result: { data: unknown; error: QueryError },
  context: string,
): unknown {
  if (result.error) {
    throw new Error(context);
  }
  return result.data;
}

export async function enqueueWebhookEvent(
  store: WebhookEventStore,
  event: WebhookEventInput,
): Promise<boolean> {
  const data = unwrapRpc(
    await store.rpc('enqueue_stripe_webhook_event', {
      _event_id: event.id,
      _event_type: event.type,
      _payload: event.payload,
    }),
    'Failed to persist webhook event',
  );
  if (typeof data !== 'boolean') {
    throw new Error('Invalid webhook enqueue result');
  }
  return data;
}

export async function claimWebhookEvent(
  store: WebhookEventStore,
): Promise<ClaimedWebhookEvent | null> {
  const data = unwrapRpc(
    await store.rpc('claim_stripe_webhook_event'),
    'Failed to claim webhook event',
  );
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null) return null;
  if (
    typeof row !== 'object' ||
    typeof row.event_id !== 'string' ||
    typeof row.event_type !== 'string' ||
    typeof row.claim_token !== 'string' ||
    !row.raw_payload ||
    typeof row.raw_payload !== 'object' ||
    Array.isArray(row.raw_payload)
  ) {
    throw new Error('Invalid webhook claim result');
  }
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    rawPayload: row.raw_payload as Record<string, unknown>,
    claimToken: row.claim_token,
  };
}

export async function completeWebhookEvent(
  store: WebhookEventStore,
  eventId: string,
  claimToken: string,
): Promise<void> {
  const data = unwrapRpc(
    await store.rpc('complete_stripe_webhook_event', {
      _event_id: eventId,
      _claim_token: claimToken,
    }),
    'Failed to complete webhook event',
  );
  if (data !== true) {
    throw new Error('Webhook event claim was lost before completion');
  }
}

export function webhookErrorCategory(error: unknown): string {
  const candidateName = error instanceof Error ? error.name : 'UnknownError';
  const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidateName)
    ? candidateName
    : 'Error';
  const candidateCode = error && typeof error === 'object' && 'code' in error
    ? error.code
    : null;
  const code = typeof candidateCode === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(candidateCode)
    ? candidateCode
    : null;
  return code ? `${name}:${code}` : name;
}
export async function failWebhookEvent(
  store: WebhookEventStore,
  eventId: string,
  claimToken: string,
  error: unknown,
): Promise<void> {
  const message = webhookErrorCategory(error);
  const data = unwrapRpc(
    await store.rpc('fail_stripe_webhook_event', {
      _event_id: eventId,
      _claim_token: claimToken,
      _error: message,
    }),
    'Failed to persist webhook event failure',
  );
  if (data !== true) {
    throw new Error('Webhook event claim was lost before failure recording');
  }
}