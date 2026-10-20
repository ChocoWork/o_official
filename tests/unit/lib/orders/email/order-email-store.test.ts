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
  lease_token: 'lease-1', subject: null, body_text: null, payment_expired_sent: false, fulfillment_id: null, refund_id: null,
  return_id: null, return_receipt_id: null, cancel_request_id: null,
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
      leaseToken: 'lease-1', subject: null, bodyText: null, paymentExpiredSent: false, fulfillmentId: null, refundId: null,
      returnId: null, returnReceiptId: null, cancelRequestId: null,
    });
    expect(rpc).toHaveBeenCalledWith('claim_order_email', { _lease_seconds: 300 });
    await expect(claimOrderEmail(storeReturning([]).store, 300)).resolves.toBeNull();
  });

  it('発送のメールの行は、どの発送のメールかを発送の番号で返す', async () => {
    const { store } = storeReturning([{ ...claimRow, email_id: 'email-2', kind: 'shipped', variant: null, fulfillment_id: 'fulfillment-1' }]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({ id: 'email-2', kind: 'shipped', fulfillmentId: 'fulfillment-1', refundId: null });
  });

  it.each([
    ['返金のお知らせ', 'refund', 'standard'],
    ['支払い済みのキャンセルのお知らせ', 'canceled', 'paid'],
  ])('%s の行は、どの返金のお知らせかを返金の番号で返す', async (_label, kind, variant) => {
    const { store } = storeReturning([{ ...claimRow, email_id: 'email-3', kind, variant, refund_id: 'refund-1' }]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({
      id: 'email-3', kind, variant, fulfillmentId: null, refundId: 'refund-1',
    });
  });

  it.each([
    ['返品の受付のお知らせ', 'return_accepted', null, 'return-1', null],
    ['返品の受け取りのお知らせ', 'return_received', null, 'return-1', 'receipt-1'],
    ['品物のお返しのお知らせ', 'return_sent_back', null, 'return-1', 'receipt-1'],
    ['店への知らせ（返金待ち）', 'return_refund_pending_shop', null, 'return-1', 'receipt-1'],
    ['受け取りと一緒の返金のお知らせ', 'refund', 'return', 'return-1', 'receipt-1'],
    ['額を決めて後で返した返金のお知らせ', 'refund', 'return', 'return-1', null],
  ])('%s の行は、どの返品・どの受け取りのメールかを返品の番号・受け取りの番号で返す', async (_label, kind, variant, returnId, returnReceiptId) => {
    const refundId = kind === 'refund' ? 'refund-1' : null;
    const { store } = storeReturning([
      { ...claimRow, email_id: 'email-5', kind, variant, refund_id: refundId, return_id: returnId, return_receipt_id: returnReceiptId },
    ]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({
      id: 'email-5', kind, variant, fulfillmentId: null, refundId, returnId, returnReceiptId,
    });
  });

  it('取り出した行に返品の列が無くても（古い形の答え）、返品の番号・受け取りの番号は null', async () => {
    const legacyRow = Object.fromEntries(Object.entries(claimRow).filter(([column]) => !column.startsWith('return_')));
    const { store } = storeReturning([legacyRow]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({ returnId: null, returnReceiptId: null });
  });

  it.each([
    ['返品のお申し込みの受付のお知らせ', 'return_requested', 'return-1', null],
    ['返品のお申し込みについてのお知らせ', 'return_declined', 'return-1', null],
    ['店への知らせ（返品の申し込み）', 'return_request_shop', 'return-1', null],
    ['キャンセルのお申し込みの受付のお知らせ', 'cancel_request_received', null, 'cancel-1'],
    ['キャンセルのお申し込みについてのお知らせ', 'cancel_request_declined', null, 'cancel-1'],
    ['店への知らせ（キャンセルの申し込み）', 'cancel_request_shop', null, 'cancel-1'],
  ])('%s の行は、どの返品・どのキャンセルの申し込みのメールかを、返品の番号・キャンセルの申し込みの番号で返す（受け取りの番号は持たない）', async (_label, kind, returnId, cancelRequestId) => {
    const { store } = storeReturning([
      { ...claimRow, email_id: 'email-7', kind, variant: null, return_id: returnId, return_receipt_id: null, cancel_request_id: cancelRequestId },
    ]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({
      id: 'email-7', kind, variant: null, fulfillmentId: null, refundId: null, returnId, returnReceiptId: null, cancelRequestId,
    });
  });

  it('取り出した行に cancel_request_id の列が無くても（古い形の答え）、キャンセルの申し込みの番号は null', async () => {
    const legacyRow = Object.fromEntries(Object.entries(claimRow).filter(([column]) => column !== 'cancel_request_id'));
    const { store } = storeReturning([legacyRow]);

    await expect(claimOrderEmail(store, 300)).resolves.toMatchObject({ cancelRequestId: null });
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

  it('履歴の行に返金の番号を足して返す。返金に結び付かない行は null（列が無い行も null）', async () => {
    const { store } = storeReturning([
      { ...historyRow, email_id: 'email-4', kind: 'refund', fulfillment_id: null, fulfillment_number: null, refund_id: 'refund-1' },
      { ...historyRow, email_id: 'email-3', kind: 'canceled', fulfillment_id: null, fulfillment_number: null, refund_id: 'refund-2' },
      { ...historyRow, email_id: 'email-2', kind: 'shipped', fulfillment_id: 'fulfillment-2', fulfillment_number: 2, refund_id: null },
      { ...historyRow, email_id: 'email-1', kind: 'paid', fulfillment_id: null, fulfillment_number: null },
    ]);

    const rows = await listOrderEmailHistory(store, 'order-1');

    expect(rows.map((row) => [row.id, row.kind, row.refundId])).toEqual([
      ['email-4', 'refund', 'refund-1'],
      ['email-3', 'canceled', 'refund-2'],
      ['email-2', 'shipped', null],
      ['email-1', 'paid', null],
    ]);
  });

  it('履歴の行に返品の番号と受け取りの番号を足して返す。返品に結び付かない行は両方 null（列が無い行も null）', async () => {
    const { store } = storeReturning([
      { ...historyRow, email_id: 'email-6', kind: 'return_received', fulfillment_id: null, fulfillment_number: null, refund_id: null, return_id: 'return-1', return_receipt_id: 'receipt-1' },
      { ...historyRow, email_id: 'email-5', kind: 'return_accepted', fulfillment_id: null, fulfillment_number: null, refund_id: null, return_id: 'return-1', return_receipt_id: null },
      { ...historyRow, email_id: 'email-4', kind: 'refund', fulfillment_id: null, fulfillment_number: null, refund_id: 'refund-1', return_id: null, return_receipt_id: null },
      { ...historyRow, email_id: 'email-1', kind: 'paid', fulfillment_id: null, fulfillment_number: null },
    ]);

    const rows = await listOrderEmailHistory(store, 'order-1');

    expect(rows.map((row) => [row.id, row.kind, row.returnId, row.returnReceiptId])).toEqual([
      ['email-6', 'return_received', 'return-1', 'receipt-1'],
      ['email-5', 'return_accepted', 'return-1', null],
      ['email-4', 'refund', null, null],
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
