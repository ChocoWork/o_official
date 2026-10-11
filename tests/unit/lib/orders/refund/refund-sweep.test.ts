const mockListAwaiting = jest.fn();
const mockRecordResult = jest.fn();
const mockMarkError = jest.fn();
jest.mock('@/lib/orders/refund/refund-store', () => ({
  listAwaitingOrderRefunds: (...args: unknown[]) => mockListAwaiting(...args),
  recordOrderRefundResult: (...args: unknown[]) => mockRecordResult(...args),
  markOrderRefundError: (...args: unknown[]) => mockMarkError(...args),
}));

const mockListRefunds = jest.fn();
const mockReadPaymentMethodType = jest.fn();
jest.mock('@/lib/orders/refund/refund-stripe', () => ({
  listPaymentIntentRefunds: (...args: unknown[]) => mockListRefunds(...args),
  readPaymentMethodType: (...args: unknown[]) => mockReadPaymentMethodType(...args),
}));

// 結果を書いた後の始末（メールの予定・店への知らせ）の中身は refund-service.test.ts が確かめる。ここでは呼ばれ方だけを見る
const mockApplySideEffects = jest.fn();
jest.mock('@/lib/orders/refund/refund-service', () => ({
  applyRefundSideEffects: (...args: unknown[]) => mockApplySideEffects(...args),
}));

import type { RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import type { RefundResultRow } from '@/lib/orders/refund/refund-store';
import type { StripeRefundSnapshot } from '@/lib/orders/refund/refund-stripe';
import { sweepAwaitingRefunds } from '@/lib/orders/refund/refund-sweep';

const NOW = new Date('2026-10-12T02:00:00.000Z');
const OPTIONS = { olderThan: new Date('2026-10-12T01:45:00.000Z'), limit: 20, deadline: NOW.getTime() + 45_000 };

function makeDeps(now: () => Date = () => NOW) {
  const notifyShopOfRefundFailure = jest.fn().mockResolvedValue(true);
  const deps = {
    store: { name: 'store' },
    stripe: { name: 'stripe' },
    now,
    notifyShopOfRefundFailure,
    scheduleOrderEmailDelivery: jest.fn(),
  } as unknown as RefundServiceDeps;
  return { deps, notifyShopOfRefundFailure };
}

function awaiting(index: number, overrides: { paymentIntentId?: string | null } = {}) {
  return {
    refundId: `0000000${index}-1111-4222-8333-444455556666`,
    orderId: `1000000${index}-1111-4222-8333-444455556666`,
    paymentIntentId: `pi_await_${index}` as string | null,
    createdAt: '2026-10-12T01:00:00.000Z',
    ...overrides,
  };
}
type AwaitingRecord = ReturnType<typeof awaiting>;

/** その記録の印が付いた、Stripe の返金の写し */
function markedRefund(record: AwaitingRecord, overrides: Partial<StripeRefundSnapshot> = {}): StripeRefundSnapshot {
  return {
    stripeRefundId: `re_${record.refundId.slice(0, 8)}`,
    stripeStatus: 'pending',
    pendingReason: 'processing',
    failureReason: null,
    customerActionExpiresAt: null,
    paymentMethodType: null,
    referenceNumber: null,
    referenceType: null,
    amount: 5000,
    reason: 'requested_by_customer',
    created: '2026-10-12T01:00:30.000Z',
    paymentIntentId: record.paymentIntentId,
    metadataRefundId: record.refundId,
    metadataOrderId: record.orderId,
    ...overrides,
  };
}

function resultRow(record: AwaitingRecord, overrides: Partial<RefundResultRow> = {}): RefundResultRow {
  return {
    refundId: record.refundId,
    orderId: record.orderId,
    status: 'pending',
    newlyAccepted: true,
    newlyFailed: false,
    orderStatus: 'paid',
    refundedAmount: 0,
    rereserveShortage: 0,
    emailEnqueued: true,
    exceptionId: null,
    ...overrides,
  };
}

describe('sweepAwaitingRefunds', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockListAwaiting.mockResolvedValue([]);
    mockListRefunds.mockResolvedValue([]);
    mockReadPaymentMethodType.mockResolvedValue('konbini');
    mockApplySideEffects.mockResolvedValue(undefined);
  });

  it('olderThan と limit をそのまま渡して、返事待ちの記録を読む。1件も無ければ何もしない', async () => {
    const { deps } = makeDeps();

    await expect(sweepAwaitingRefunds(deps, OPTIONS)).resolves.toEqual({
      checked: 0,
      synced: 0,
      errored: 0,
      failures: 0,
      timeBudgetExhausted: false,
    });

    expect(mockListAwaiting).toHaveBeenCalledWith(deps.store, OPTIONS.olderThan, 20);
    expect(mockListRefunds).not.toHaveBeenCalled();
    expect(mockMarkError).not.toHaveBeenCalled();
  });

  it('見つかる: 支払いの返金の一覧から印 refund_id で探し、支払いの種類を添えて結果を書き、後の始末を呼ぶ', async () => {
    const { deps } = makeDeps();
    const record = awaiting(1);
    const row = resultRow(record);
    mockListAwaiting.mockResolvedValue([record]);
    // ほかの記録の印が付いた返金は取り違えない
    mockListRefunds.mockResolvedValue([
      markedRefund(awaiting(2), { stripeRefundId: 're_other_mark' }),
      markedRefund(record, { stripeRefundId: 're_found' }),
    ]);
    mockRecordResult.mockResolvedValue(row);

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(mockListRefunds).toHaveBeenCalledWith(deps.stripe, 'pi_await_1');
    expect(mockReadPaymentMethodType).toHaveBeenCalledWith(deps.stripe, 'pi_await_1');
    expect(mockRecordResult).toHaveBeenCalledTimes(1);
    expect(mockRecordResult).toHaveBeenCalledWith(
      deps.store,
      record.refundId,
      expect.objectContaining({
        stripeRefundId: 're_found',
        stripeStatus: 'pending',
        pendingReason: 'processing',
        paymentMethodType: 'konbini',
      }),
    );
    expect(mockApplySideEffects).toHaveBeenCalledWith(deps, row);
    expect(mockMarkError).not.toHaveBeenCalled();
    expect(report).toEqual({ checked: 1, synced: 1, errored: 0, failures: 0, timeBudgetExhausted: false });
  });

  it('見つかった返金の写しが支払いの種類を持っていれば、読み直さずにその種類を渡す', async () => {
    const { deps } = makeDeps();
    const record = awaiting(1);
    mockListAwaiting.mockResolvedValue([record]);
    mockListRefunds.mockResolvedValue([markedRefund(record, { paymentMethodType: 'card' })]);
    mockRecordResult.mockResolvedValue(resultRow(record));

    await sweepAwaitingRefunds(deps, OPTIONS);

    expect(mockReadPaymentMethodType).not.toHaveBeenCalled();
    expect(mockRecordResult).toHaveBeenCalledWith(
      deps.store,
      record.refundId,
      expect.objectContaining({ paymentMethodType: 'card' }),
    );
  });

  it('見つからない: エラー（not_found_in_stripe）にして要対応を作り、店へ知らせる', async () => {
    const { deps, notifyShopOfRefundFailure } = makeDeps();
    const record = awaiting(1);
    mockListAwaiting.mockResolvedValue([record]);
    mockListRefunds.mockResolvedValue([markedRefund(awaiting(2))]);
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: record.orderId, exceptionId: 'exception-1' });

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(mockMarkError).toHaveBeenCalledWith(deps.store, record.refundId, 'not_found_in_stripe', true);
    expect(notifyShopOfRefundFailure).toHaveBeenCalledTimes(1);
    expect(notifyShopOfRefundFailure).toHaveBeenCalledWith('exception-1', {
      reason: 'refund_failed',
      detail: 'not_found_in_stripe',
      orderId: record.orderId,
      paymentRef: record.refundId,
      detectedAt: NOW,
      refundFailure: { failureReasonLabel: 'Stripe に届きませんでした', shortages: [], cancelEmailSent: false },
    });
    expect(report).toEqual({ checked: 1, synced: 0, errored: 1, failures: 0, timeBudgetExhausted: false });
  });

  it('支払いの番号が無い注文の記録は、Stripe を読まずに同じ理由でエラーにする', async () => {
    const { deps, notifyShopOfRefundFailure } = makeDeps();
    const record = awaiting(1, { paymentIntentId: null });
    mockListAwaiting.mockResolvedValue([record]);
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: record.orderId, exceptionId: 'exception-1' });

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(mockListRefunds).not.toHaveBeenCalled();
    expect(mockMarkError).toHaveBeenCalledWith(deps.store, record.refundId, 'not_found_in_stripe', true);
    expect(notifyShopOfRefundFailure).toHaveBeenCalledWith(
      'exception-1',
      expect.objectContaining({ reason: 'refund_failed', paymentRef: record.refundId }),
    );
    expect(report.errored).toBe(1);
  });

  it('Stripe がその支払いを知らない（resource_missing）記録は、見つからなかった記録と同じにエラーにし、失敗には数えない', async () => {
    const { deps, notifyShopOfRefundFailure } = makeDeps();
    const record = awaiting(1);
    mockListAwaiting.mockResolvedValue([record]);
    mockListRefunds.mockRejectedValue(
      Object.assign(new Error('No such payment_intent: pi_await_1'), { type: 'StripeInvalidRequestError', code: 'resource_missing' }),
    );
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: record.orderId, exceptionId: 'exception-1' });

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(mockMarkError).toHaveBeenCalledWith(deps.store, record.refundId, 'not_found_in_stripe', true);
    expect(notifyShopOfRefundFailure).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ checked: 1, synced: 0, errored: 1, failures: 0, timeBudgetExhausted: false });
  });

  it('要対応の番号が返らなければ（要対応を作らなかった）、エラーに数えるが、店へは知らせない', async () => {
    const { deps, notifyShopOfRefundFailure } = makeDeps();
    const record = awaiting(1);
    mockListAwaiting.mockResolvedValue([record]);
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: record.orderId, exceptionId: null });

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(report.errored).toBe(1);
    expect(notifyShopOfRefundFailure).not.toHaveBeenCalled();
  });

  it('見回りの間に別の経路が片付けた記録（not_awaiting）は、エラーに数えず、店へ知らせない', async () => {
    const { deps, notifyShopOfRefundFailure } = makeDeps();
    const record = awaiting(1);
    mockListAwaiting.mockResolvedValue([record]);
    mockMarkError.mockResolvedValue({ outcome: 'not_awaiting', orderId: record.orderId, exceptionId: null });

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(report).toEqual({ checked: 1, synced: 0, errored: 0, failures: 0, timeBudgetExhausted: false });
    expect(notifyShopOfRefundFailure).not.toHaveBeenCalled();
  });

  it('時間切れ: deadline に届いたら、残りを次の回に回す', async () => {
    const clock = [NOW, new Date(OPTIONS.deadline)];
    const { deps } = makeDeps(() => clock.shift() ?? new Date(OPTIONS.deadline));
    const first = awaiting(1);
    const second = awaiting(2);
    mockListAwaiting.mockResolvedValue([first, second]);
    mockListRefunds.mockResolvedValue([markedRefund(first)]);
    mockRecordResult.mockResolvedValue(resultRow(first));

    const report = await sweepAwaitingRefunds(deps, OPTIONS);

    expect(report).toEqual({ checked: 1, synced: 1, errored: 0, failures: 0, timeBudgetExhausted: true });
    expect(mockListRefunds).toHaveBeenCalledTimes(1);
    expect(mockMarkError).not.toHaveBeenCalled();
  });

  it('1件の失敗で残りを止めない。読めなかった記録はエラーにせず、失敗に数え、ログには原因の記号だけを出す', async () => {
    const { deps } = makeDeps();
    const first = awaiting(1);
    const second = awaiting(2);
    mockListAwaiting.mockResolvedValue([first, second]);
    mockListRefunds
      .mockRejectedValueOnce(Object.assign(new Error('Stripe is down for buyer@example.com'), { type: 'StripeConnectionError' }))
      .mockResolvedValueOnce([markedRefund(second)]);
    mockRecordResult.mockResolvedValue(resultRow(second));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const report = await sweepAwaitingRefunds(deps, OPTIONS);

      expect(report).toEqual({ checked: 2, synced: 1, errored: 0, failures: 1, timeBudgetExhausted: false });
      // Stripe を読めなかったのは「見つからなかった」ではない。エラーにしない
      expect(mockMarkError).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith('[refund-sweep] failed to settle an awaiting refund', first.refundId, 'stripe_unavailable');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('buyer@example.com');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('店への知らせが送れなくても、エラーにした記録はエラーに数える（失敗に数えない）。ログには原因の記号だけを出す', async () => {
    const { deps, notifyShopOfRefundFailure } = makeDeps();
    const record = awaiting(1);
    mockListAwaiting.mockResolvedValue([record]);
    mockMarkError.mockResolvedValue({ outcome: 'errored', orderId: record.orderId, exceptionId: 'exception-1' });
    notifyShopOfRefundFailure.mockRejectedValue(new Error('shop mail down for owner@example.com'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const report = await sweepAwaitingRefunds(deps, OPTIONS);

      expect(report).toEqual({ checked: 1, synced: 0, errored: 1, failures: 0, timeBudgetExhausted: false });
      expect(consoleError).toHaveBeenCalledWith('[refund-sweep] failed to notify the shop', 'unexpected_error');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('owner@example.com');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返事待ちの記録を読む DB の呼び出しが失敗したら、そのまま投げる（呼ぶ側が数える）', async () => {
    const { deps } = makeDeps();
    const failure = new Error('refund store failed: list_awaiting_order_refunds');
    mockListAwaiting.mockRejectedValue(failure);

    await expect(sweepAwaitingRefunds(deps, OPTIONS)).rejects.toBe(failure);
  });
});
