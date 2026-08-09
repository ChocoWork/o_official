import {
  beginWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';

function createStore(existing: { processing_status: string; attempt_count: number } | null = null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: existing, error: null });
  const eqForSelect = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq: eqForSelect });
  const upsert = jest.fn().mockResolvedValue({ error: null });
  const eqForUpdate = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn().mockReturnValue({ eq: eqForUpdate });
  const from = jest.fn().mockReturnValue({ select, upsert, update });

  return {
    store: { from } as unknown as WebhookEventStore,
    upsert,
    update,
    eqForUpdate,
  };
}

const event = {
  id: 'evt_1',
  type: 'payment_intent.succeeded',
  payload: { id: 'evt_1' },
};

describe('Stripe webhook event lifecycle', () => {
  it('skips only a completed event', async () => {
    const { store, upsert } = createStore({ processing_status: 'completed', attempt_count: 1 });

    await expect(beginWebhookEvent(store, event)).resolves.toBe('duplicate');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('retries a failed event and increments its attempt count', async () => {
    const { store, upsert } = createStore({ processing_status: 'failed', attempt_count: 2 });

    await expect(beginWebhookEvent(store, event)).resolves.toBe('process');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ processing_status: 'processing', attempt_count: 3 }),
      { onConflict: 'id' },
    );
  });

  it('marks successful processing as completed', async () => {
    const { store, update, eqForUpdate } = createStore();

    await completeWebhookEvent(store, 'evt_1');

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      processing_status: 'completed',
      last_error: null,
    }));
    expect(eqForUpdate).toHaveBeenCalledWith('id', 'evt_1');
  });

  it('marks failed processing with a bounded error', async () => {
    const { store, update } = createStore();

    await failWebhookEvent(store, 'evt_1', new Error('x'.repeat(2_000)));

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      processing_status: 'failed',
      last_error: 'x'.repeat(1_000),
    }));
  });
});
