import {
  claimOrderEmail,
  failOrderEmail,
  getOrderEmailSendState,
  listOrderEmailHistory,
  OrderEmailStoreError,
  requestOrderEmailResend,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

function storeReturning(data: unknown, error: { message?: string; code?: string } | null = null) {
  const rpc = jest.fn(async () => ({ data, error }));
  return { store: { rpc } as unknown as OrderEmailStore, rpc };
}

const claimRow = {
  email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
  lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null,
};

const historyRow = {
  variant: null, origin: 'auto', requested_by_email: null, status: 'sent', attempts: 1, last_error_code: null,
  delivery_status: null, delivery_event_at: null, created_at: '2026-10-10T01:00:00.000Z', sent_at: '2026-10-10T01:00:05.000Z',
  finished_at: '2026-10-10T01:00:05.000Z', has_body: true, body_erased: false,
};

describe('order-email-store', () => {
  it('取り出した行を名前を変えて返す。無ければ null', async () => {
    const { store, rpc } = storeReturning([claimRow]);

    await expect(claimOrderEmail(store, 300)).resolves.toEqual({
      id: 'email-1', orderId: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
      leaseToken: 'lease-1', subject: null, bodyText: null, paymentExpiredSent: false, fulfillmentId: null,
    });
    expect(rpc).toHaveBeenCalledWith('claim_order_email', { _lease_seconds: 300 });
    await expect(claimOrderEmail(storeReturning([]).store, 300)).resolves.toBeNull();
  });

  it('発送のメールの行は、どの発送のメールかを発送の番号で返す', async () => {
    const { store } = storeReturning([{ ...claimRow, email_id: 'email-2', kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' }]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({ id: 'email-2', kind: 'shipped', fulfillmentId: 'fulfillment-1' });
  });

  it('失敗の記録に分け方・原因・待つ時間を渡す', async () => {
    const { store, rpc } = storeReturning('retry_wait');
    const claim = { id: 'email-1', leaseToken: 'lease-1' };

    await expect(failOrderEmail(store, claim, { category: 'transient', code: 'rate_limited', retryAfterSeconds: 3 })).resolves.toBe('retry_wait');
    expect(rpc).toHaveBeenCalledWith('fail_order_email', {
      _email_id: 'email-1', _lease_token: 'lease-1', _error_code: 'rate_limited', _category: 'transient', _retry_after_seconds: 3,
    });
  });

  it('一時停止の状態を日付に直す', async () => {
    const { store } = storeReturning([{ paused: true, reason: 'quota_daily', paused_at: '2026-10-09T01:00:00Z', next_probe_at: '2026-10-10T00:00:00Z' }]);

    await expect(getOrderEmailSendState(store)).resolves.toEqual({
      paused: true, reason: 'quota_daily', pausedAt: new Date('2026-10-09T01:00:00Z'), nextProbeAt: new Date('2026-10-10T00:00:00Z'),
    });
  });

  it('DB の失敗は OrderEmailStoreError にし、記号だけ持つ', async () => {
    const { store } = storeReturning(null, { message: 'connection refused', code: '08006' });

    await expect(claimOrderEmail(store, 300)).rejects.toMatchObject({ name: 'OrderEmailStoreError', operation: 'claim_order_email', code: '08006' });
    await expect(claimOrderEmail(store, 300)).rejects.toBeInstanceOf(OrderEmailStoreError);
  });

  it('履歴の行に発送の番号と何回目の発送かを足して返す。発送のメールでない行は両方 null', async () => {
    const { store, rpc } = storeReturning([
      { ...historyRow, email_id: 'email-2', kind: 'shipped', fulfillment_id: 'fulfillment-2', fulfillment_number: 2 },
      { ...historyRow, email_id: 'email-1', kind: 'paid', fulfillment_id: null, fulfillment_number: null },
    ]);

    const rows = await listOrderEmailHistory(store, 'order-1');

    expect(rpc).toHaveBeenCalledWith('list_order_email_history', { _order_id: 'order-1' });
    expect(rows.map((row) => [row.id, row.kind, row.fulfillmentId, row.fulfillmentNumber])).toEqual([
      ['email-2', 'shipped', 'fulfillment-2', 2],
      ['email-1', 'paid', null, null],
    ]);
  });
});

describe('requestOrderEmailResend', () => {
  const request = { orderId: 'order-1', kind: 'shipped', actorId: 'admin-1' } as const;

  it('発送の番号を DB の関数に渡す。渡さなければ null を渡す', async () => {
    const { store, rpc } = storeReturning('email-9');

    await expect(requestOrderEmailResend(store, { ...request, fulfillmentId: 'fulfillment-2' })).resolves.toBe('email-9');
    expect(rpc).toHaveBeenLastCalledWith('request_order_email_resend', {
      _order_id: 'order-1', _kind: 'shipped', _actor_id: 'admin-1', _fulfillment_id: 'fulfillment-2',
    });

    await requestOrderEmailResend(store, { orderId: 'order-1', kind: 'paid', actorId: 'admin-1' });
    expect(rpc).toHaveBeenLastCalledWith('request_order_email_resend', {
      _order_id: 'order-1', _kind: 'paid', _actor_id: 'admin-1', _fulfillment_id: null,
    });
  });

  it.each([
    ['RESEND_ALREADY_QUEUED', '23505', 'already_queued'],
    ['RESEND_NOT_ALLOWED', '22023', 'not_allowed'],
    ['RESEND_FULFILLMENT_REQUIRED', '22023', 'not_allowed'],
    ['ORDER_NOT_FOUND', 'P0002', 'order_not_found'],
  ])('DB が %s（%s）で断ったら OrderEmailResendError(%s) にする', async (message, code, reason) => {
    const { store } = storeReturning(null, { message, code });

    await expect(requestOrderEmailResend(store, request)).rejects.toMatchObject({ name: 'OrderEmailResendError', reason });
  });

  it('思いがけない DB の失敗は OrderEmailStoreError のまま返す', async () => {
    const { store } = storeReturning(null, { message: 'connection refused', code: '08006' });

    const failure = requestOrderEmailResend(store, request);
    await expect(failure).rejects.toBeInstanceOf(OrderEmailStoreError);
    await expect(failure).rejects.toMatchObject({ operation: 'request_order_email_resend', code: '08006' });
  });
});
