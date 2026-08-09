type QueryError = { message?: string } | null;

type WebhookEventRow = {
  processing_status: string;
  attempt_count: number;
};

type WebhookEventTable = {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): Promise<{ data: WebhookEventRow | null; error: QueryError }>;
    };
  };
  upsert(
    values: Record<string, unknown>,
    options: { onConflict: string },
  ): Promise<{ error: QueryError }>;
  update(values: Record<string, unknown>): {
    eq(column: string, value: string): Promise<{ error: QueryError }>;
  };
};

export type WebhookEventStore = {
  from(table: 'stripe_webhook_events'): WebhookEventTable;
};

export type WebhookEventInput = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

function throwQueryError(error: QueryError, context: string): void {
  if (error) {
    throw new Error(`${context}: ${error.message ?? 'database error'}`);
  }
}

export async function beginWebhookEvent(
  store: WebhookEventStore,
  event: WebhookEventInput,
): Promise<'process' | 'duplicate'> {
  const table = store.from('stripe_webhook_events');
  const { data: existing, error: lookupError } = await table
    .select('processing_status, attempt_count')
    .eq('id', event.id)
    .maybeSingle();
  throwQueryError(lookupError, 'Failed to read webhook event state');

  if (existing?.processing_status === 'completed') {
    return 'duplicate';
  }

  const { error: upsertError } = await table.upsert(
    {
      id: event.id,
      event_type: event.type,
      raw_payload: event.payload,
      processing_status: 'processing',
      attempt_count: (existing?.attempt_count ?? 0) + 1,
      completed_at: null,
      last_error: null,
      processed_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  throwQueryError(upsertError, 'Failed to begin webhook event processing');

  return 'process';
}

export async function completeWebhookEvent(
  store: WebhookEventStore,
  eventId: string,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const { error } = await store
    .from('stripe_webhook_events')
    .update({
      processing_status: 'completed',
      completed_at: completedAt,
      last_error: null,
    })
    .eq('id', eventId);
  throwQueryError(error, 'Failed to complete webhook event processing');
}

export async function failWebhookEvent(
  store: WebhookEventStore,
  eventId: string,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  const { error: updateError } = await store
    .from('stripe_webhook_events')
    .update({
      processing_status: 'failed',
      completed_at: null,
      last_error: message,
    })
    .eq('id', eventId);
  throwQueryError(updateError, 'Failed to persist webhook event failure');
}
