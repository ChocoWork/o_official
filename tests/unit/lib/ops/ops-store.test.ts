import {
  OpsStoreError,
  bumpSignal,
  claimAlert,
  listUnnotifiedDeadEvents,
  markDeadEventsNotified,
  markOrderRecoveredFromPayment,
  readHeartbeats,
  readWebhookBacklog,
  recordHeartbeat,
  releaseAlert,
  type OpsStore,
} from '@/lib/ops/ops-store';

function storeReturning(data: unknown, error: { message?: string } | null = null) {
  const rpc = jest.fn().mockResolvedValue({ data, error });
  return { store: { rpc } as unknown as OpsStore, rpc };
}

describe('ops-store（知らせと定期処理の記録の関数の呼び出し）', () => {
  it('最後の成功を読み、定期処理ごとにまとめる', async () => {
    const { store, rpc } = storeReturning([
      { job: 'order_sweep', last_succeeded_at: '2026-10-05T00:00:00Z', last_failed_at: null, last_error_code: null },
      { job: 'stripe_reconcile', last_succeeded_at: null, last_failed_at: '2026-10-05T01:00:00Z', last_error_code: 'stripe_unavailable' },
    ]);
    const heartbeats = await readHeartbeats(store);
    expect(rpc).toHaveBeenCalledWith('get_ops_heartbeats', undefined);
    expect(heartbeats.order_sweep).toEqual({
      lastSucceededAt: new Date('2026-10-05T00:00:00Z'), lastFailedAt: null, lastErrorCode: null,
    });
    expect(heartbeats.stripe_reconcile?.lastErrorCode).toBe('stripe_unavailable');
    expect(heartbeats.webhook_worker).toBeUndefined();
  });

  it('成功・失敗の記録に、名前と原因の記号を渡す', async () => {
    const { store, rpc } = storeReturning(null);
    await recordHeartbeat(store, 'webhook_worker', true);
    await recordHeartbeat(store, 'order_sweep', false, 'db_unavailable');
    expect(rpc).toHaveBeenNthCalledWith(1, 'record_ops_heartbeat', { _job: 'webhook_worker', _succeeded: true, _error_code: null });
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_ops_heartbeat', { _job: 'order_sweep', _succeeded: false, _error_code: 'db_unavailable' });
  });

  it('件数を数え、今の窓の件数を返す', async () => {
    const { store, rpc } = storeReturning(3);
    await expect(bumpSignal(store, 'webhook_signature_invalid', 600)).resolves.toBe(3);
    expect(rpc).toHaveBeenCalledWith('bump_ops_signal', { _alert_key: 'webhook_signature_invalid', _window_seconds: 600 });
  });

  it('送る権利が取れたら claim を返し、取れなければ null', async () => {
    const taken = storeReturning([{ claimed: true, claimed_at: '2026-10-05T02:00:00Z', previous_sent_at: null }]);
    await expect(claimAlert(taken.store, 'webhook_backlog', 3600)).resolves.toEqual({
      key: 'webhook_backlog', claimedAt: '2026-10-05T02:00:00Z', previousSentAt: null,
    });
    expect(taken.rpc).toHaveBeenCalledWith('claim_ops_alert', { _alert_key: 'webhook_backlog', _cooldown_seconds: 3600 });

    const busy = storeReturning([{ claimed: false, claimed_at: null, previous_sent_at: '2026-10-05T01:30:00Z' }]);
    await expect(claimAlert(busy.store, 'webhook_backlog', 3600)).resolves.toBeNull();
  });

  it('権利を返すときは、取った時刻と前の時刻を渡す', async () => {
    const { store, rpc } = storeReturning(true);
    await releaseAlert(store, { key: 'webhook_dead', claimedAt: '2026-10-05T02:00:00Z', previousSentAt: '2026-10-04T23:00:00Z' });
    expect(rpc).toHaveBeenCalledWith('release_ops_alert', {
      _alert_key: 'webhook_dead', _claimed_at: '2026-10-05T02:00:00Z', _previous_sent_at: '2026-10-04T23:00:00Z',
    });
  });

  it('溜まりを読む', async () => {
    const { store, rpc } = storeReturning([
      { processing_status: 'failed', event_count: 2, oldest_received_at: '2026-10-05T00:00:00Z', last_errors: ['stripe_unavailable'] },
    ]);
    await expect(readWebhookBacklog(store, 900)).resolves.toEqual([
      { status: 'failed', count: 2, oldestReceivedAt: new Date('2026-10-05T00:00:00Z'), lastErrors: ['stripe_unavailable'] },
    ]);
    expect(rpc).toHaveBeenCalledWith('get_stripe_webhook_backlog', { _older_than_seconds: 900 });
  });

  it('まだ知らせていない退避を読み、全件の数を返す。無ければ0件', async () => {
    const { store, rpc } = storeReturning([
      {
        event_id: 'evt_1', event_type: 'refund.updated', last_error: 'unexpected_error',
        received_at: '2026-10-05T00:00:00Z', attempt_count: 9, dead_at: '2026-10-05T04:15:00Z', total_count: 60,
      },
    ]);
    await expect(listUnnotifiedDeadEvents(store, 50)).resolves.toEqual({
      total: 60,
      events: [{
        eventId: 'evt_1', eventType: 'refund.updated', cause: 'unexpected_error',
        receivedAt: new Date('2026-10-05T00:00:00Z'), attemptCount: 9, deadAt: new Date('2026-10-05T04:15:00Z'),
      }],
    });
    expect(rpc).toHaveBeenCalledWith('list_unnotified_dead_stripe_webhook_events', { _limit: 50 });
    await expect(listUnnotifiedDeadEvents(storeReturning([]).store, 50)).resolves.toEqual({ total: 0, events: [] });
  });

  it('退避を知らせた印を付ける。空なら呼ばない', async () => {
    const { store, rpc } = storeReturning(2);
    await expect(markDeadEventsNotified(store, ['evt_1', 'evt_2'])).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith('mark_stripe_webhook_dead_notified', { _event_ids: ['evt_1', 'evt_2'] });
    const empty = storeReturning(0);
    await expect(markDeadEventsNotified(empty.store, [])).resolves.toBe(0);
    expect(empty.rpc).not.toHaveBeenCalled();
  });

  it('支払いから作った注文の印を付け、付けた後の理由を返す。知らない値は失敗にする', async () => {
    const { store, rpc } = storeReturning('stock_not_reserved');
    await expect(markOrderRecoveredFromPayment(store, 'order-1')).resolves.toBe('stock_not_reserved');
    expect(rpc).toHaveBeenCalledWith('mark_order_recovered_from_payment', { _order_id: 'order-1' });
    await expect(markOrderRecoveredFromPayment(storeReturning(null).store, 'order-2')).rejects.toBeInstanceOf(OpsStoreError);
  });

  it('DB の失敗は OpsStoreError にし、中身を出さない', async () => {
    const { store } = storeReturning(null, { message: 'buyer@example.com' });
    const error = await recordHeartbeat(store, 'webhook_worker', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsStoreError);
    expect((error as Error).message).toBe('ops store failed: record_ops_heartbeat');
  });
});
