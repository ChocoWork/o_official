const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

// 結果を書いた後の始末（メールの予定・店への知らせ）の中身は refund-service.test.ts が確かめる。ここでは呼ばれ方だけを見る
const mockApplySideEffects = jest.fn();
jest.mock('@/lib/orders/refund/refund-service', () => ({
  applyRefundSideEffects: (...args: unknown[]) => mockApplySideEffects(...args),
}));

// DB の関数の呼び出しの中身は refund-store.test.ts が、Stripe の読み方は refund-stripe.test.ts が確かめる
const mockGetOrderRefund = jest.fn();
const mockRecordResult = jest.fn();
const mockRecordExternal = jest.fn();
jest.mock('@/lib/orders/refund/refund-store', () => ({
  getOrderRefund: (...args: unknown[]) => mockGetOrderRefund(...args),
  recordOrderRefundResult: (...args: unknown[]) => mockRecordResult(...args),
  recordExternalOrderRefund: (...args: unknown[]) => mockRecordExternal(...args),
}));

const mockListRefunds = jest.fn();
const mockReadPaymentMethodType = jest.fn();
jest.mock('@/lib/orders/refund/refund-stripe', () => ({
  listPaymentIntentRefunds: (...args: unknown[]) => mockListRefunds(...args),
  readPaymentMethodType: (...args: unknown[]) => mockReadPaymentMethodType(...args),
}));

import type { RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import type { ExternalRefundResultRow, RefundResultRow } from '@/lib/orders/refund/refund-store';
import type { StripeRefundSnapshot } from '@/lib/orders/refund/refund-stripe';
import {
  OrderNotFoundForPaymentIntentError,
  RefundSyncNotConvergedError,
  syncPaymentIntentRefunds,
} from '@/lib/stripe/order-refund-sync';

const PAYMENT_INTENT_ID = 'pi_sync_1';
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'f1b2c3d4-1111-4222-8333-444455559999';
const OWN_REFUND_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const OTHER_REFUND_ID = 'c1b2c3d4-1111-4222-8333-444455556666';

/** Stripe の返金の写し。既定は、この注文の返金の記録（OWN_REFUND_ID）の印が付いた成功の返金 */
function snapshot(overrides: Partial<StripeRefundSnapshot> = {}): StripeRefundSnapshot {
  return {
    stripeRefundId: 're_own1',
    stripeStatus: 'succeeded',
    pendingReason: null,
    failureReason: null,
    customerActionExpiresAt: null,
    paymentMethodType: null,
    referenceNumber: null,
    referenceType: null,
    amount: 5000,
    reason: 'requested_by_customer',
    created: '2026-10-12T01:00:00.000Z',
    paymentIntentId: PAYMENT_INTENT_ID,
    metadataRefundId: OWN_REFUND_ID,
    metadataOrderId: ORDER_ID,
    ...overrides,
  };
}

/** 印の無い返金（Stripe の画面からの返金など） */
function unmarked(overrides: Partial<StripeRefundSnapshot> = {}): StripeRefundSnapshot {
  return snapshot({ metadataRefundId: null, metadataOrderId: null, reason: null, ...overrides });
}

function resultRow(overrides: Partial<RefundResultRow> = {}): RefundResultRow {
  return {
    refundId: OWN_REFUND_ID,
    orderId: ORDER_ID,
    status: 'succeeded',
    newlyAccepted: true,
    newlyFailed: false,
    orderStatus: 'paid',
    refundedAmount: 5000,
    rereserveShortage: 0,
    emailEnqueued: false,
    exceptionId: null,
    ...overrides,
  };
}

function externalRow(overrides: Partial<ExternalRefundResultRow> = {}): ExternalRefundResultRow {
  return {
    ...resultRow({ refundId: 'd1b2c3d4-1111-4222-8333-444455556666' }),
    created: true,
    source: 'stripe_dashboard',
    ...overrides,
  };
}

function ownRecord(overrides: Record<string, unknown> = {}) {
  return {
    refundId: OWN_REFUND_ID,
    orderId: ORDER_ID,
    source: 'admin',
    status: 'pending',
    stripeRefundId: null,
    amount: 5000,
    paymentIntentId: PAYMENT_INTENT_ID,
    createdAt: '2026-10-12T00:59:00.000Z',
    ...overrides,
  };
}

type OrderRead = { data: { id: string; status: string } | null; error: { message: string; code?: string } | null };

function setup(order: OrderRead = { data: { id: ORDER_ID, status: 'paid' }, error: null }) {
  const maybeSingle = jest.fn().mockResolvedValue(order);
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  const deps = {
    store: { from, rpc: jest.fn() },
    stripe: { name: 'stripe' },
    now: () => new Date('2026-10-12T02:00:00.000Z'),
    notifyShopOfRefundFailure: jest.fn(),
    scheduleOrderEmailDelivery: jest.fn(),
  } as unknown as RefundServiceDeps;
  return { deps, from, select, eq };
}

describe('syncPaymentIntentRefunds', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockLogAudit.mockResolvedValue(undefined);
    mockApplySideEffects.mockResolvedValue(undefined);
    mockListRefunds.mockResolvedValue([]);
    mockReadPaymentMethodType.mockResolvedValue('card');
  });

  it('OrderNotFoundForPaymentIntentError の文は今のまま', () => {
    const error = new OrderNotFoundForPaymentIntentError();

    expect(error.message).toBe('Order not found for Stripe PaymentIntent');
    expect(error.name).toBe('OrderNotFoundForPaymentIntentError');
  });

  it('支払いの番号を持つ注文が無ければ OrderNotFoundForPaymentIntentError を投げ、Stripe を読まない', async () => {
    const { deps, from, select, eq } = setup({ data: null, error: null });

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).rejects.toBeInstanceOf(OrderNotFoundForPaymentIntentError);

    expect(from).toHaveBeenCalledWith('orders');
    expect(select).toHaveBeenCalledWith('id, status');
    expect(eq).toHaveBeenCalledWith('payment_intent_id', PAYMENT_INTENT_ID);
    expect(mockListRefunds).not.toHaveBeenCalled();
  });

  it('注文の読み取りが失敗したら、DB の誤りを cause に残した Error を投げる（呼ぶ側が一時的な失敗かを見分ける）', async () => {
    const dbError = { message: 'permission denied', code: '42501' };
    const { deps } = setup({ data: null, error: dbError });

    const error = await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(OrderNotFoundForPaymentIntentError);
    expect((error as Error).message).toBe('Failed to read order refund state: permission denied');
    expect((error as Error).cause).toBe(dbError);
    expect(mockListRefunds).not.toHaveBeenCalled();
  });

  it.each(['payment_in_progress', 'pending', 'failed', 'abandoned'] as const)(
    '入金が決まる前の注文（%s）は skipped_unpaid。Stripe を読まず、何も書かない（R-06）',
    async (status) => {
      const { deps } = setup({ data: { id: ORDER_ID, status }, error: null });

      await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).resolves.toEqual({
        kind: 'skipped_unpaid',
        orderId: ORDER_ID,
        orderStatus: status,
      });

      expect(mockListRefunds).not.toHaveBeenCalled();
      expect(mockRecordResult).not.toHaveBeenCalled();
      expect(mockRecordExternal).not.toHaveBeenCalled();
      expect(mockApplySideEffects).not.toHaveBeenCalled();
    },
  );

  it('取り消した注文（未入金で取り消した注文を含む）の返金は飛ばさずに記録する（設計書 6-1。前は飛ばしていた）', async () => {
    const { deps } = setup({ data: { id: ORDER_ID, status: 'cancelled' }, error: null });
    const row = externalRow({ orderStatus: 'cancelled', refundedAmount: 5000 });
    mockListRefunds.mockResolvedValue([unmarked({ stripeRefundId: 're_after_cancel' })]);
    mockRecordExternal.mockResolvedValue(row);

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).resolves.toEqual({
      kind: 'synced',
      orderId: ORDER_ID,
      orderStatus: 'cancelled',
      results: [row],
    });

    expect(mockRecordExternal).toHaveBeenCalledWith(
      deps.store,
      expect.objectContaining({ orderId: ORDER_ID, stripeRefundId: 're_after_cancel' }),
    );
    expect(mockApplySideEffects).toHaveBeenCalledWith(deps, row);
  });

  it('印 refund_id がこの注文の記録に当たる返金は、その記録に結果を書き、後の始末を呼ぶ', async () => {
    const { deps } = setup();
    const refund = snapshot();
    const row = resultRow();
    mockListRefunds.mockResolvedValue([refund]);
    mockGetOrderRefund.mockResolvedValue(ownRecord());
    mockRecordResult.mockResolvedValue(row);

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).resolves.toEqual({
      kind: 'synced',
      orderId: ORDER_ID,
      orderStatus: 'paid',
      results: [row],
    });

    expect(mockListRefunds).toHaveBeenCalledWith(deps.stripe, PAYMENT_INTENT_ID);
    expect(mockGetOrderRefund).toHaveBeenCalledWith(deps.store, OWN_REFUND_ID);
    expect(mockRecordResult).toHaveBeenCalledWith(deps.store, OWN_REFUND_ID, refund);
    expect(mockRecordExternal).not.toHaveBeenCalled();
    // 返事を書けた記録（保留）には、頼んだ時に読んだ支払いの種類が入っている。読み直さない
    expect(mockReadPaymentMethodType).not.toHaveBeenCalled();
    expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
    expect(mockApplySideEffects).toHaveBeenCalledWith(deps, row);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it.each(['awaiting_response', 'error'] as const)(
    '返事を書けていない記録（%s）に結果を書く時は、一覧の写しに支払いの種類が無ければ、Stripe から1回だけ読んで渡す',
    async (status) => {
      const { deps } = setup();
      const refund = snapshot();
      mockListRefunds.mockResolvedValue([refund]);
      mockGetOrderRefund.mockResolvedValue(ownRecord({ status }));
      mockRecordResult.mockResolvedValue(resultRow());
      mockReadPaymentMethodType.mockResolvedValue('konbini');

      await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

      expect(mockReadPaymentMethodType).toHaveBeenCalledTimes(1);
      expect(mockRecordResult).toHaveBeenCalledWith(deps.store, OWN_REFUND_ID, { ...refund, paymentMethodType: 'konbini' });
    },
  );

  it('返事を書けていない記録でも、一覧の写しが支払いの種類を持っていれば、読み直さずにその種類を渡す', async () => {
    const { deps } = setup();
    const refund = snapshot({ paymentMethodType: 'paypay' });
    mockListRefunds.mockResolvedValue([refund]);
    mockGetOrderRefund.mockResolvedValue(ownRecord({ status: 'awaiting_response' }));
    mockRecordResult.mockResolvedValue(resultRow());

    await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockReadPaymentMethodType).not.toHaveBeenCalled();
    expect(mockRecordResult).toHaveBeenCalledWith(deps.store, OWN_REFUND_ID, refund);
  });

  it('印の無い返金は外からの返金として、古い順に記録する。支払いの種類は Stripe から1回だけ読み、注文の状態は最後の結果の物', async () => {
    const { deps } = setup();
    const older = unmarked({ stripeRefundId: 're_ext_old', amount: 3000, created: '2026-10-12T01:00:00.000Z' });
    const newer = unmarked({
      stripeRefundId: 're_ext_new',
      amount: 2000,
      created: '2026-10-12T01:30:00.000Z',
      stripeStatus: 'pending',
      pendingReason: 'processing',
    });
    // Stripe は新しい順に返す
    mockListRefunds.mockResolvedValue([newer, older]);
    const firstRow = externalRow({ orderStatus: 'paid', refundedAmount: 3000 });
    const secondRow = externalRow({ refundId: 'e1b2c3d4-1111-4222-8333-444455556666', orderStatus: 'cancelled', refundedAmount: 5000 });
    mockRecordExternal.mockResolvedValueOnce(firstRow).mockResolvedValueOnce(secondRow);

    const result = await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockGetOrderRefund).not.toHaveBeenCalled();
    expect(mockReadPaymentMethodType).toHaveBeenCalledTimes(1);
    expect(mockReadPaymentMethodType).toHaveBeenCalledWith(deps.stripe, PAYMENT_INTENT_ID);
    expect(mockRecordExternal).toHaveBeenCalledTimes(2);
    expect(mockRecordExternal).toHaveBeenNthCalledWith(1, deps.store, {
      orderId: ORDER_ID,
      amount: 3000,
      stripeReason: null,
      stripeCreatedAt: '2026-10-12T01:00:00.000Z',
      stripeRefundId: 're_ext_old',
      stripeStatus: 'succeeded',
      pendingReason: null,
      failureReason: null,
      customerActionExpiresAt: null,
      paymentMethodType: 'card',
      referenceNumber: null,
      referenceType: null,
    });
    expect(mockRecordExternal).toHaveBeenNthCalledWith(
      2,
      deps.store,
      expect.objectContaining({
        amount: 2000,
        stripeRefundId: 're_ext_new',
        stripeStatus: 'pending',
        pendingReason: 'processing',
        paymentMethodType: 'card',
      }),
    );
    expect(result).toEqual({ kind: 'synced', orderId: ORDER_ID, orderStatus: 'cancelled', results: [firstRow, secondRow] });
    expect(mockApplySideEffects).toHaveBeenNthCalledWith(1, deps, firstRow);
    expect(mockApplySideEffects).toHaveBeenNthCalledWith(2, deps, secondRow);
  });

  it('外からの返金でも、一覧の写しが支払いの種類を持っていれば、読み直さずにその種類を渡す', async () => {
    const { deps } = setup();
    mockListRefunds.mockResolvedValue([unmarked({ stripeRefundId: 're_ext_paypay', paymentMethodType: 'paypay' })]);
    mockRecordExternal.mockResolvedValue(externalRow());

    await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockReadPaymentMethodType).not.toHaveBeenCalled();
    expect(mockRecordExternal).toHaveBeenCalledWith(deps.store, expect.objectContaining({ paymentMethodType: 'paypay' }));
  });

  it('他の注文の印の返金は、外からの返金として記録し、監査に残す（Stripe の返金の番号と印だけ）', async () => {
    const { deps } = setup();
    mockListRefunds.mockResolvedValue([snapshot({ stripeRefundId: 're_other', metadataRefundId: OTHER_REFUND_ID })]);
    mockGetOrderRefund.mockResolvedValue(ownRecord({ refundId: OTHER_REFUND_ID, orderId: OTHER_ORDER_ID }));
    mockRecordExternal.mockResolvedValue(externalRow());

    await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockGetOrderRefund).toHaveBeenCalledWith(deps.store, OTHER_REFUND_ID);
    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(mockRecordExternal).toHaveBeenCalledWith(deps.store, expect.objectContaining({ orderId: ORDER_ID, stripeRefundId: 're_other' }));
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stripe.refund.marker_unmatched',
        resource: 'orders',
        resource_id: ORDER_ID,
        outcome: 'conflict',
        metadata: { stripe_refund_id: 're_other', marker_refund_id: OTHER_REFUND_ID },
      }),
    );
  });

  it.each([
    ['記録が無い印', OTHER_REFUND_ID, 1],
    ['uuid の形でない印', 'not-a-uuid', 0],
  ])('%sの返金も外からの返金として記録し、監査に残す（uuid の形でない印では記録を探さない）', async (_name, marker, lookups) => {
    const { deps } = setup();
    mockListRefunds.mockResolvedValue([snapshot({ stripeRefundId: 're_marked', metadataRefundId: marker })]);
    mockGetOrderRefund.mockResolvedValue(null);
    mockRecordExternal.mockResolvedValue(externalRow());

    await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockGetOrderRefund).toHaveBeenCalledTimes(lookups);
    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(mockRecordExternal).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stripe.refund.marker_unmatched',
        metadata: { stripe_refund_id: 're_marked', marker_refund_id: marker },
      }),
    );
  });

  it('印の合わない返金でも、すでに記録してあった返金（created が false）を合わせ直す時は、監査を残さない（同じ支払いの同期は何度も走る）', async () => {
    const { deps } = setup();
    mockListRefunds.mockResolvedValue([snapshot({ stripeRefundId: 're_again', metadataRefundId: OTHER_REFUND_ID })]);
    mockGetOrderRefund.mockResolvedValue(null);
    mockRecordExternal.mockResolvedValue(externalRow({ created: false }));

    await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockRecordExternal).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('返金が1件も無ければ、何も書かず、注文の状態をそのまま返す', async () => {
    const { deps } = setup({ data: { id: ORDER_ID, status: 'shipped' }, error: null });

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).resolves.toEqual({
      kind: 'synced',
      orderId: ORDER_ID,
      orderStatus: 'shipped',
      results: [],
    });

    expect(mockRecordResult).not.toHaveBeenCalled();
    expect(mockRecordExternal).not.toHaveBeenCalled();
    expect(mockApplySideEffects).not.toHaveBeenCalled();
  });

  it('切り替えより前の返金（Review Focus 5）: 古さは DB の関数が決める。作った時刻をそのまま渡し、写し legacy の答えをそのまま返す', async () => {
    const { deps } = setup();
    mockListRefunds.mockResolvedValue([unmarked({ stripeRefundId: 're_old_test', created: '2026-10-01T00:00:00.000Z' })]);
    const legacy = externalRow({ source: 'legacy', newlyAccepted: false, emailEnqueued: false });
    mockRecordExternal.mockResolvedValue(legacy);

    const result = await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(mockRecordExternal).toHaveBeenCalledWith(deps.store, expect.objectContaining({ stripeCreatedAt: '2026-10-01T00:00:00.000Z' }));
    expect(result).toEqual({ kind: 'synced', orderId: ORDER_ID, orderStatus: 'paid', results: [legacy] });
    // 写しは在庫もメールも動かさない。後の始末には、動かさなかった答えがそのまま渡る
    expect(mockApplySideEffects).toHaveBeenCalledWith(deps, legacy);
  });

  it('一部を発送した注文の外からの全額の返金（Review Focus 4）: キャンセルとメールの予定の答えを、後の始末にそのまま渡す', async () => {
    const { deps } = setup({ data: { id: ORDER_ID, status: 'paid' }, error: null });
    mockListRefunds.mockResolvedValue([unmarked({ stripeRefundId: 're_full', amount: 10_000 })]);
    // DB の関数が、未発送の商品を全部この返金の発送前の行に入れて在庫に戻し、注文をキャンセルにした答え
    const cancelled = externalRow({
      created: true,
      source: 'stripe_dashboard',
      status: 'succeeded',
      newlyAccepted: true,
      orderStatus: 'cancelled',
      refundedAmount: 10_000,
      emailEnqueued: true,
    });
    mockRecordExternal.mockResolvedValue(cancelled);

    const result = await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    expect(result).toEqual({ kind: 'synced', orderId: ORDER_ID, orderStatus: 'cancelled', results: [cancelled] });
    expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
    expect(mockApplySideEffects).toHaveBeenCalledWith(deps, cancelled);
  });

  it('書いた後に返金の状態が変わっていたら、読み直した一覧で書き直す', async () => {
    const { deps } = setup();
    const pending = snapshot({ stripeStatus: 'pending', pendingReason: 'processing' });
    const succeeded = snapshot();
    mockListRefunds
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([succeeded])
      .mockResolvedValueOnce([succeeded]);
    mockGetOrderRefund.mockResolvedValue(ownRecord());
    mockRecordResult
      .mockResolvedValueOnce(resultRow({ status: 'pending' }))
      .mockResolvedValueOnce(resultRow({ status: 'succeeded' }));

    const result = await syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID);

    // 最初の一覧・書いた後の読み直し・書き直した後の読み直し
    expect(mockListRefunds).toHaveBeenCalledTimes(3);
    expect(mockRecordResult).toHaveBeenCalledTimes(2);
    expect(mockRecordResult).toHaveBeenNthCalledWith(1, deps.store, OWN_REFUND_ID, pending);
    expect(mockRecordResult).toHaveBeenNthCalledWith(2, deps.store, OWN_REFUND_ID, succeeded);
    expect(result).toMatchObject({ kind: 'synced', results: [expect.objectContaining({ status: 'succeeded' })] });
    expect(mockApplySideEffects).toHaveBeenCalledTimes(2);
  });

  it('3回書いても返金が変わり続けたら RefundSyncNotConvergedError。書くのは3回まで', async () => {
    const { deps } = setup();
    let reads = 0;
    mockListRefunds.mockImplementation(async () => {
      reads += 1;
      return [unmarked({ stripeRefundId: `re_loop${reads}` })];
    });
    mockRecordExternal.mockResolvedValue(externalRow());

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).rejects.toBeInstanceOf(RefundSyncNotConvergedError);

    // 最初の一覧 + 書くたびの読み直し3回
    expect(mockListRefunds).toHaveBeenCalledTimes(4);
    expect(mockRecordExternal).toHaveBeenCalledTimes(3);
  });

  it('結果を書く DB の呼び出しが失敗したら、そのまま投げる（知らせの再試行に任せる）。後の始末は呼ばない', async () => {
    const { deps } = setup();
    const failure = new Error('refund store failed: record_order_refund_result');
    mockListRefunds.mockResolvedValue([snapshot()]);
    mockGetOrderRefund.mockResolvedValue(ownRecord());
    mockRecordResult.mockRejectedValue(failure);

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).rejects.toBe(failure);

    expect(mockApplySideEffects).not.toHaveBeenCalled();
  });

  it('Stripe の読み取りの失敗はそのまま投げる（照合が一時的な失敗かを見分ける）', async () => {
    const { deps } = setup();
    const stripeError = { type: 'StripeConnectionError' };
    mockListRefunds.mockRejectedValue(stripeError);

    await expect(syncPaymentIntentRefunds(deps, PAYMENT_INTENT_ID)).rejects.toBe(stripeError);
  });
});
