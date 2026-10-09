import {
  claimOrderEmail,
  failOrderEmail,
  getOrderEmailSendState,
  OrderEmailStoreError,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

function storeReturning(data: unknown, error: { message?: string; code?: string } | null = null) {
  const rpc = jest.fn(async () => ({ data, error }));
  return { store: { rpc } as unknown as OrderEmailStore, rpc };
}

describe('order-email-store', () => {
  it('取り出した行を名前を変えて返す。無ければ null', async () => {
    const { store, rpc } = storeReturning([{
      email_id: 'email-1', order_id: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
      lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false,
    }]);

    await expect(claimOrderEmail(store, 300)).resolves.toEqual({
      id: 'email-1', orderId: 'order-1', kind: 'paid', variant: 'order_confirmed', origin: 'auto', attempts: 1,
      leaseToken: 'lease-1', subject: null, bodyText: null, paymentExpiredSent: false,
    });
    expect(rpc).toHaveBeenCalledWith('claim_order_email', { _lease_seconds: 300 });
    await expect(claimOrderEmail(storeReturning([]).store, 300)).resolves.toBeNull();
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
});
