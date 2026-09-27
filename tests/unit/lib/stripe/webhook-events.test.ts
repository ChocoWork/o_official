import {
  enqueueWebhookEvent,
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  webhookErrorCategory,
  type WebhookEventStore,
} from '@/lib/stripe/webhook-events';

const rpc = jest.fn();
const store = { rpc } as unknown as WebhookEventStore;

describe('Stripe webhook durable queue calls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('失敗理由は機微情報を捨て、検証した型とコードだけにする', () => {
    const error = Object.assign(new Error('buyer@example.com'), { code: '23505' });
    expect(webhookErrorCategory(error)).toBe('Error:23505');
    error.name = 'Error\nsecret';
    error.code = 'bad code with spaces';
    expect(webhookErrorCategory(error)).toBe('Error');
  });
  it('署名検証済みのeventだけを永続化RPCへ渡し、重複結果を返す', async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(enqueueWebhookEvent(store, {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      payload: { id: 'evt_1', type: 'payment_intent.succeeded' },
    })).resolves.toBe(false);

    expect(rpc).toHaveBeenCalledWith('enqueue_stripe_webhook_event', {
      _event_id: 'evt_1',
      _event_type: 'payment_intent.succeeded',
      _payload: { id: 'evt_1', type: 'payment_intent.succeeded' },
    });
  });

  it('保存失敗や不明な結果では成功扱いにしない', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } })
      .mockResolvedValueOnce({ data: null, error: null });

    await expect(enqueueWebhookEvent(store, {
      id: 'evt_1', type: 'refund.failed', payload: { id: 'evt_1' },
    })).rejects.toThrow('Failed to persist webhook event');
    await expect(enqueueWebhookEvent(store, {
      id: 'evt_1', type: 'refund.failed', payload: { id: 'evt_1' },
    })).rejects.toThrow('Invalid webhook enqueue result');
  });

  it('claimしたイベントとtokenを検証して返す', async () => {
    rpc.mockResolvedValue({
      data: [{
        event_id: 'evt_1',
        event_type: 'refund.failed',
        raw_payload: { id: 'evt_1' },
        claim_token: 'claim-1',
      }],
      error: null,
    });

    await expect(claimWebhookEvent(store)).resolves.toEqual({
      eventId: 'evt_1',
      eventType: 'refund.failed',
      rawPayload: { id: 'evt_1' },
      claimToken: 'claim-1',
    });
  });

  it('完了と失敗をclaim tokenで条件付き更新し、claim喪失を検知する', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    await expect(completeWebhookEvent(store, 'evt_1', 'claim-1')).resolves.toBeUndefined();
    await expect(failWebhookEvent(store, 'evt_2', 'claim-2', new Error('buyer@example.com sensitive message')))
      .resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('fail_stripe_webhook_event', {
      _event_id: 'evt_2',
      _claim_token: 'claim-2',
      _error: 'Error',
    });
    await expect(completeWebhookEvent(store, 'evt_3', 'lost'))
      .rejects.toThrow('claim was lost');
  });
});