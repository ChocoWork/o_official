import { drainWebhookQueue, toStripeEvent } from '@/lib/stripe/webhook-drain';
import { InvalidWebhookPayloadError, type WebhookEventStore } from '@/lib/stripe/webhook-events';

function claimRow(id: string, payload?: Record<string, unknown>) {
  return {
    event_id: id,
    event_type: 'checkout.session.completed',
    raw_payload: payload ?? { id, type: 'checkout.session.completed', data: { object: { id: `cs_${id}` } } },
    claim_token: `token-${id}`,
  };
}

/** claim は順に返し、尽きたら空。complete・fail は成功を返す */
function fakeStore(claims: unknown[]) {
  const queue = [...claims];
  const rpc = jest.fn(async (name: string, params?: Record<string, unknown>) => {
    void params;
    if (name === 'claim_stripe_webhook_event') return { data: queue.length > 0 ? [queue.shift()] : [], error: null };
    return { data: true, error: null };
  });
  return { store: { rpc } as unknown as WebhookEventStore, rpc };
}

describe('drainWebhookQueue', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('取り出せる知らせが無くなるまで続けて処理し、1件ずつ完了にする', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1'), claimRow('evt_2')]);
    const process = jest.fn().mockResolvedValue(undefined);

    const result = await drainWebhookQueue({ store, process, now: () => 0, budgetMs: 45_000 });

    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'empty' });
    expect(process).toHaveBeenCalledTimes(2);
    expect(process).toHaveBeenNthCalledWith(1, claimRow('evt_1').raw_payload);
    expect(rpc).toHaveBeenCalledWith('complete_stripe_webhook_event', { _event_id: 'evt_1', _claim_token: 'token-evt_1' });
    expect(rpc).toHaveBeenCalledWith('complete_stripe_webhook_event', { _event_id: 'evt_2', _claim_token: 'token-evt_2' });
    const completeEvt1Index = rpc.mock.calls.findIndex(([name, params]) => (
      name === 'complete_stripe_webhook_event' && params?._event_id === 'evt_1'
    ));
    expect(process.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[completeEvt1Index]);
  });

  it('時間の予算を使い切ったら、新しく取り出さずに止める', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1'), claimRow('evt_2'), claimRow('evt_3')]);
    let clock = 0;
    const process = jest.fn(async () => {
      clock += 30_000;
    });

    const result = await drainWebhookQueue({ store, process, now: () => clock, budgetMs: 45_000 });

    expect(result).toEqual({ processed: 2, failed: 0, stoppedBy: 'budget' });
    expect(process).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.filter(([name]) => name === 'claim_stripe_webhook_event')).toHaveLength(2);
  });

  it('処理に失敗した知らせは失敗として記録し、次の知らせへ進む', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1'), claimRow('evt_2')]);
    const process = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'stripe_unavailable' }))
      .mockResolvedValueOnce(undefined);

    const result = await drainWebhookQueue({ store, process, now: () => 0, budgetMs: 45_000 });

    expect(result).toEqual({ processed: 1, failed: 1, stoppedBy: 'empty' });
    expect(rpc).toHaveBeenCalledWith('fail_stripe_webhook_event', {
      _event_id: 'evt_1', _claim_token: 'token-evt_1', _error: 'stripe_unavailable',
    });
    expect(rpc).not.toHaveBeenCalledWith('complete_stripe_webhook_event', { _event_id: 'evt_1', _claim_token: 'token-evt_1' });
    expect(rpc).toHaveBeenCalledWith('complete_stripe_webhook_event', { _event_id: 'evt_2', _claim_token: 'token-evt_2' });
    expect(console.error).toHaveBeenCalledWith(
      '[stripe-webhook-worker] Event processing failed', 'evt_1', 'stripe_unavailable', 'Error:stripe_unavailable',
    );
  });

  it('保存した中身が壊れていれば処理へ渡さず、invalid_payload で失敗にする', async () => {
    const { store, rpc } = fakeStore([claimRow('evt_1', { id: 'evt_other', type: 'checkout.session.completed', data: { object: {} } })]);
    const process = jest.fn();

    const result = await drainWebhookQueue({ store, process, now: () => 0, budgetMs: 45_000 });

    expect(process).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, failed: 1, stoppedBy: 'empty' });
    expect(rpc).toHaveBeenCalledWith('fail_stripe_webhook_event', {
      _event_id: 'evt_1', _claim_token: 'token-evt_1', _error: 'invalid_payload',
    });
    expect(rpc).not.toHaveBeenCalledWith('complete_stripe_webhook_event', expect.anything());
  });

  it('処理に成功しても完了の記録が失敗したら、db_unavailable で失敗にする', async () => {
    const queue = [claimRow('evt_1')];
    const rpc = jest.fn(async (name: string) => {
      if (name === 'claim_stripe_webhook_event') return { data: queue.length > 0 ? [queue.shift()] : [], error: null };
      if (name === 'complete_stripe_webhook_event') return { data: null, error: { message: 'db down' } };
      return { data: true, error: null };
    });
    const process = jest.fn().mockResolvedValue(undefined);

    const result = await drainWebhookQueue({
      store: { rpc } as unknown as WebhookEventStore, process, now: () => 0, budgetMs: 45_000,
    });

    expect(result).toEqual({ processed: 0, failed: 1, stoppedBy: 'empty' });
    expect(process).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fail_stripe_webhook_event', {
      _event_id: 'evt_1', _claim_token: 'token-evt_1', _error: 'db_unavailable',
    });
  });

  it('取り出しの DB の失敗では止め、claim_error を返す', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'db down' } });
    const result = await drainWebhookQueue({
      store: { rpc } as unknown as WebhookEventStore, process: jest.fn(), now: () => 0, budgetMs: 45_000,
    });
    expect(result).toEqual({ processed: 0, failed: 0, stoppedBy: 'claim_error' });
  });

  it('失敗の記録そのものが失敗しても、繰り返しは続ける', async () => {
    const queue = [claimRow('evt_1'), claimRow('evt_2')];
    const rpc = jest.fn(async (name: string) => {
      if (name === 'claim_stripe_webhook_event') return { data: queue.length > 0 ? [queue.shift()] : [], error: null };
      if (name === 'fail_stripe_webhook_event') return { data: null, error: { message: 'db down' } };
      return { data: true, error: null };
    });
    const process = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);

    const result = await drainWebhookQueue({
      store: { rpc } as unknown as WebhookEventStore, process, now: () => 0, budgetMs: 45_000,
    });

    expect(result).toEqual({ processed: 1, failed: 1, stoppedBy: 'empty' });
  });

  it('toStripeEvent は番号・種類・data.object がそろったときだけ返す', () => {
    const good = { eventId: 'evt_1', eventType: 'refund.updated', claimToken: 't', rawPayload: { id: 'evt_1', type: 'refund.updated', data: { object: { id: 're_1' } } } };
    expect(toStripeEvent(good)).toEqual(good.rawPayload);
    expect(() => toStripeEvent({ ...good, rawPayload: { ...good.rawPayload, type: 'other' } })).toThrow(InvalidWebhookPayloadError);
    expect(() => toStripeEvent({ ...good, rawPayload: { id: 'evt_1', type: 'refund.updated', data: {} } })).toThrow(InvalidWebhookPayloadError);
  });
});
