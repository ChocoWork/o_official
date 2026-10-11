import { NextRequest } from 'next/server';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

// ── NextResponse モック ─────────────────────────────────────────
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 })),
    },
  };
});

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockConstructEvent = jest.fn();
const mockOrdersUpdate = jest.fn();
const mockSyncPaymentIntentAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });
const mockSyncRefundAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });
const mockSyncPayoutAccounting = jest.fn().mockResolvedValue({ reconciliationStatus: 'matched' });
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
  }),
}));

jest.mock('@/lib/stripe/accounting-sync', () => ({
  syncPaymentIntentAccounting: (...args: unknown[]) => mockSyncPaymentIntentAccounting(...args),
  syncRefundAccounting: (...args: unknown[]) => mockSyncRefundAccounting(...args),
  syncPayoutAccounting: (...args: unknown[]) => mockSyncPayoutAccounting(...args),
}));

jest.mock('@/lib/stripe/supabase-accounting-database', () => ({
  createStripeAccountingDatabase: jest.fn().mockReturnValue({}),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

// 決済系のイベントは照合関数へ ID を渡すだけ。照合の中身は checkout-payment-reconciler.test.ts が確かめる。
const mockReconcile = jest.fn();
const mockReconcilerDeps = { name: 'reconciler-deps' };
jest.mock('@/lib/stripe/checkout-payment-reconciler', () => ({
  reconcileCheckoutPayment: (...args: unknown[]) => mockReconcile(...args),
}));
jest.mock('@/lib/stripe/checkout-payment-reconciler-deps', () => ({
  createDefaultReconcilerDeps: async () => mockReconcilerDeps,
}));

// 注文が無い支払いの返金が失敗・取消になったときの要対応。記録と通知の中身は refund-failure-exception.test.ts が確かめる。
const mockRaiseRefundFailure = jest.fn();
jest.mock('@/lib/stripe/refund-failure-exception', () => ({
  raiseRefundFailureWithoutOrder: (...args: unknown[]) => mockRaiseRefundFailure(...args),
}));

// 返金の取り込み。中身は order-refund-sync.test.ts が確かめる。ここでは、知らせから支払いの番号を取り出して渡すことと、
// 取り込みの答え（注文が無い・未入金の注文）に応じた監査と完了を確かめる。
const mockSyncPaymentIntentRefunds = jest.fn();
jest.mock('@/lib/stripe/order-refund-sync', () => {
  class OrderNotFoundForPaymentIntentError extends Error {}
  return {
    OrderNotFoundForPaymentIntentError,
    syncPaymentIntentRefunds: (...args: unknown[]) => mockSyncPaymentIntentRefunds(...args),
  };
});
const mockRefundDeps = { name: 'refund-service-deps' };
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: async () => mockRefundDeps,
}));

import { OrderNotFoundForPaymentIntentError } from '@/lib/stripe/order-refund-sync';
import { processStripeWebhookEvent } from '@/lib/stripe/webhook-processor';

async function processForTest(req: NextRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const event = await req.json() as Parameters<typeof processStripeWebhookEvent>[0];
  try {
    await processStripeWebhookEvent(event, req);
    return { status: 200, body: { processed: true } };
  } catch {
    return { status: 500, body: { error: 'Processing failed' } };
  }
}

function makeRequest(payload: unknown, signature = 'stripe-signature'): NextRequest {
  const req = new NextRequest('http://localhost/api/webhook/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(payload),
  });
  return req;
}

describe('Stripe webhook business processor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcile.mockResolvedValue({ kind: 'ok', action: { type: 'none' }, orderId: null, orderStatus: null });
    mockRaiseRefundFailure.mockResolvedValue({ exceptionId: 'exception-1', isNew: true });
    mockSyncPaymentIntentRefunds.mockReset();
    mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'synced', orderId: 'order-1', orderStatus: 'paid', results: [] });
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });
    mockFrom.mockReturnValue({ update: mockOrdersUpdate });
  });

  it('refund.updated は、その支払いの返金を読み直して返金の記録に合わせ、会計も同期する', async () => {
    const event = {
      id: 'evt_refund',
      type: 'refund.updated',
      data: { object: { id: 're_1', payment_intent: 'pi_refund' } },
    };

    const response = await processForTest(makeRequest(event));

    expect(response.status).toBe(200);
    // 知らせの中身（返金の状態・額）は使わない。支払いの番号だけを渡し、返金の読み直しは取り込みの中で行う
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledTimes(1);
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_refund');
    expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_1' }));
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_payment_intent' }));
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_on_unpaid_order' }));
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'checkout.webhook.event_processing',
      outcome: 'success',
    }));
  });

  it('refund.failed も同じ。注文のある支払いは取り込みに任せ、注文なしの要対応を記録しない', async () => {
    const event = {
      id: 'evt_refund_failed',
      type: 'refund.failed',
      data: { object: { id: 're_failed', payment_intent: 'pi_refund', status: 'failed' } },
    };

    const response = await processForTest(makeRequest(event));

    expect(response.status).toBe(200);
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_refund');
    expect(mockRaiseRefundFailure).not.toHaveBeenCalled();
    expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_failed' }));
  });

  it.each([
    ['PaymentIntent の ID', 'pi_charge'],
    ['展開された PaymentIntent', { id: 'pi_charge' }],
  ])('charge.refunded（payment_intent が%s）も取り込む。会計の同期は refund.* だけ', async (_name, paymentIntent) => {
    const event = { id: 'evt_charge', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: paymentIntent } } };

    const response = await processForTest(makeRequest(event));

    expect(response.status).toBe(200);
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_charge');
    expect(mockSyncRefundAccounting).not.toHaveBeenCalled();
  });

  it('返金の取り込みが失敗したら処理を失敗にし、workerの再試行対象にする（会計の同期も完了の監査も進めない）', async () => {
    mockSyncPaymentIntentRefunds.mockRejectedValue(new Error('Stripe refunds kept changing while they were synced to the order'));
    const event = {
      id: 'evt_refund_conflict',
      type: 'refund.updated',
      data: { object: { id: 're_conflict', payment_intent: 'pi_refund' } },
    };

    const response = await processForTest(makeRequest(event));

    expect(response.status).toBe(500);
    expect(mockSyncRefundAccounting).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.event_processing' }));
  });

  describe('失敗を繰り返さない返金の知らせ（R-06）', () => {
    it.each([
      ['refund.created', { id: 're_1', payment_intent: null }, { refund_id: 're_1', charge_id: null }],
      ['refund.updated', { id: 're_1', payment_intent: null }, { refund_id: 're_1', charge_id: null }],
      ['refund.failed', { id: 're_1', payment_intent: null, status: 'failed' }, { refund_id: 're_1', charge_id: null }],
      ['charge.refunded', { id: 'ch_1', payment_intent: null }, { refund_id: null, charge_id: 'ch_1' }],
    ])(
      '%s に PaymentIntent が無くても、失敗にせず、監査に残して完了にする。読み直す相手が無いので、取り込みも会計の同期も呼ばない',
      async (type, object, ids) => {
        const event = { id: `evt_no_pi_${type}`, type, data: { object } };

        const response = await processForTest(makeRequest(event));

        expect(response.status).toBe(200);
        expect(mockSyncPaymentIntentRefunds).not.toHaveBeenCalled();
        expect(mockRaiseRefundFailure).not.toHaveBeenCalled();
        expect(mockSyncRefundAccounting).not.toHaveBeenCalled();
        // 監査に入れるのは ID だけ（カード・個人情報は入れない）
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          action: 'checkout.webhook.refund_without_payment_intent',
          resource: 'stripe_webhook',
          outcome: 'success',
          metadata: {
            event_id: `evt_no_pi_${type}`,
            event_type: type,
            payment_intent_id: null,
            ...ids,
          },
        }));
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          action: 'checkout.webhook.event_processing',
          outcome: 'success',
        }));
      },
    );

    it('入金が決まる前の注文（skipped_unpaid）の返金は、失敗にせず、監査に残して完了にする。会計の同期は続ける', async () => {
      mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'skipped_unpaid', orderId: 'order-1', orderStatus: 'pending' });
      const event = { id: 'evt_unpaid', type: 'refund.created', data: { object: { id: 're_1', payment_intent: 'pi_unpaid' } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_unpaid');
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.webhook.refund_on_unpaid_order',
        resource: 'stripe_webhook',
        outcome: 'success',
        metadata: {
          event_id: 'evt_unpaid',
          event_type: 'refund.created',
          payment_intent_id: 'pi_unpaid',
          refund_id: 're_1',
          charge_id: null,
          order_id: 'order-1',
          order_status: 'pending',
        },
      }));
      expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_1' }));
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.webhook.event_processing',
        outcome: 'success',
      }));
    });
  });

  describe('注文に結び付いていない支払いの返金イベント', () => {
    // 注文を作れなかった支払い（要対応 order_not_creatable）は、店が Stripe で返金する。注文は現れないので、
    // 再試行しても直らない。イベントを失敗にして永久に再試行させず、監査に残して会計の同期へ進む。
    // ただし返金が失敗・取消になったときは、支払いだけが残り、照合もこの支払いを二度と見ないので、要対応にして店へ知らせる。
    const REFUND_EVENT_TYPES = ['refund.created', 'refund.updated', 'refund.failed'] as const;

    beforeEach(() => {
      // 取り込みが「この支払いに注文が無い」と答える
      mockSyncPaymentIntentRefunds.mockRejectedValue(new OrderNotFoundForPaymentIntentError());
    });

    // 返金の状態が成功・保留（失敗でも取消でもない）のイベント。これまでどおり、要対応にせず飛ばす
    const orphanEvents: Array<[string, Record<string, unknown>, Record<string, string | null>]> = [
      [
        'refund.created',
        { id: 're_orphan', payment_intent: 'pi_orphan', status: 'pending' },
        { refund_id: 're_orphan', charge_id: null },
      ],
      [
        'refund.updated',
        { id: 're_orphan', payment_intent: 'pi_orphan', status: 'succeeded' },
        { refund_id: 're_orphan', charge_id: null },
      ],
      ['charge.refunded', { id: 'ch_orphan', payment_intent: 'pi_orphan' }, { refund_id: null, charge_id: 'ch_orphan' }],
    ];

    it.each(orphanEvents)('%s（成功・保留）は注文が無くても失敗にせず、要対応にせず、監査に残して完了にする', async (type, object, ids) => {
      const event = { id: `evt_orphan_${type}`, type, data: { object } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      // 注文が無いかどうかは取り込みが決める。知らせからは支払いの番号だけを渡す
      expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_orphan');
      expect(mockRaiseRefundFailure).not.toHaveBeenCalled();
      // 監査に入れるのは ID だけ（カード・個人情報は入れない）
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.webhook.refund_without_order',
        resource: 'stripe_webhook',
        outcome: 'success',
        metadata: {
          event_id: `evt_orphan_${type}`,
          event_type: type,
          payment_intent_id: 'pi_orphan',
          ...ids,
        },
      }));
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'checkout.webhook.event_processing',
        outcome: 'success',
      }));
    });

    it.each(['pending', 'requires_action', 'succeeded', null])(
      '返金の状態が %p の refund.updated は、注文が無くても要対応にしない',
      async (status) => {
        const event = {
          id: 'evt_orphan_status',
          type: 'refund.updated',
          data: { object: { id: 're_orphan', payment_intent: 'pi_orphan', status } },
        };

        const response = await processForTest(makeRequest(event));

        expect(response.status).toBe(200);
        expect(mockRaiseRefundFailure).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['refund.failed', 'failed', 'failed'],
      ['refund.updated', 'failed', 'failed'],
      ['refund.updated', 'canceled', 'canceled'],
      ['refund.created', 'failed', 'failed'],
    ])(
      '%s（返金の状態 %s）は注文が無ければ、要対応を記録して店へ知らせ、完了にする（返金の状態は %s として扱う）',
      async (type, status, expectedStatus) => {
        const event = {
          id: `evt_orphan_${type}_${status}`,
          type,
          data: { object: { id: 're_orphan', payment_intent: 'pi_orphan', status } },
        };

        const response = await processForTest(makeRequest(event));

        expect(response.status).toBe(200);
        expect(mockRaiseRefundFailure).toHaveBeenCalledTimes(1);
        expect(mockRaiseRefundFailure).toHaveBeenCalledWith(mockReconcilerDeps, {
          paymentIntentId: 'pi_orphan',
          refundId: 're_orphan',
          refundStatus: expectedStatus,
        });
        // 会計の同期は続ける
        expect(mockSyncRefundAccounting).toHaveBeenCalledTimes(1);
        expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_orphan' }));
        // 飛ばした（成功）ではなく、要対応にした（error）と監査に残す。入れるのは ID と状態だけ
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          action: 'checkout.webhook.refund_without_order',
          resource: 'stripe_webhook',
          outcome: 'error',
          metadata: {
            event_id: `evt_orphan_${type}_${status}`,
            event_type: type,
            payment_intent_id: 'pi_orphan',
            refund_id: 're_orphan',
            charge_id: null,
            refund_status: expectedStatus,
            exception_id: 'exception-1',
          },
        }));
        expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({
          action: 'checkout.webhook.refund_without_order',
          outcome: 'success',
        }));
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
          action: 'checkout.webhook.event_processing',
          outcome: 'success',
        }));
      },
    );

    it('refund.failed は、返金のオブジェクトに状態が無くても、失敗として要対応にする', async () => {
      const event = { id: 'evt_orphan_no_status', type: 'refund.failed', data: { object: { id: 're_orphan', payment_intent: 'pi_orphan' } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockRaiseRefundFailure).toHaveBeenCalledWith(mockReconcilerDeps, expect.objectContaining({ refundStatus: 'failed' }));
    });

    it('要対応を記録できなければ（一時的な失敗でも）、握りつぶさずイベントを失敗にして再試行させる', async () => {
      mockRaiseRefundFailure.mockRejectedValue(Object.assign(new Error('db unavailable'), { code: 'db_unavailable' }));
      const event = {
        id: 'evt_orphan_record_failed',
        type: 'refund.failed',
        data: { object: { id: 're_orphan', payment_intent: 'pi_orphan', status: 'failed' } },
      };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(500);
      expect(mockSyncRefundAccounting).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.event_processing' }));
    });

    it.each(REFUND_EVENT_TYPES)('%s は注文が無くても会計の同期まで進む', async (type) => {
      const status = type === 'refund.failed' ? 'failed' : 'succeeded';
      const event = { id: `evt_orphan_${type}`, type, data: { object: { id: 're_orphan', payment_intent: 'pi_orphan', status } } };

      await processForTest(makeRequest(event));

      expect(mockSyncRefundAccounting).toHaveBeenCalledTimes(1);
      expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_orphan' }));
    });

    it('注文のある支払いの失敗した返金は、取り込みに任せ、注文なしの要対応を記録しない', async () => {
      mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'synced', orderId: 'order-1', orderStatus: 'paid', results: [] });
      const event = {
        id: 'evt_failed_with_order',
        type: 'refund.failed',
        data: { object: { id: 're_1', payment_intent: 'pi_refund', status: 'failed' } },
      };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_refund');
      expect(mockRaiseRefundFailure).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
    });

    it('注文のある支払いの返金イベントは、取り込みに任せ、注文なしの監査を残さない', async () => {
      mockSyncPaymentIntentRefunds.mockResolvedValue({ kind: 'synced', orderId: 'order-1', orderStatus: 'paid', results: [] });
      const event = { id: 'evt_with_order', type: 'refund.created', data: { object: { id: 're_1', payment_intent: 'pi_refund' } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_1' }));
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
    });

    it('注文の読み取り自体が失敗した返金イベントは、注文が無いのと区別して失敗にし、再試行させる', async () => {
      mockSyncPaymentIntentRefunds.mockRejectedValue(
        new Error('Failed to read order refund state: connection lost', { cause: { message: 'connection lost' } }),
      );
      const event = { id: 'evt_read_failed', type: 'refund.updated', data: { object: { id: 're_1', payment_intent: 'pi_refund' } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(500);
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
      expect(mockSyncRefundAccounting).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['payment_intent.succeeded', { id: 'pi_1', metadata: {} }, mockSyncPaymentIntentAccounting],
    ['payout.reconciliation_completed', { id: 'po_1' }, mockSyncPayoutAccounting],
    ['payout.paid', { id: 'po_1' }, mockSyncPayoutAccounting],
    ['payout.failed', { id: 'po_1' }, mockSyncPayoutAccounting],
  ])('%sを会計同期へ1回だけ渡す', async (type, object, synchronizer) => {
    const event = { id: `evt_${type}`, type, data: { object } };
    mockConstructEvent.mockReturnValue(event);

    const response = await processForTest(makeRequest(event));

    expect((response as { status: number }).status).toBe(200);
    expect(synchronizer).toHaveBeenCalledTimes(1);
  });

  it.each([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
  ])('%s は Session ID とイベント ID を照合関数へ渡すだけで、注文を直接書かない', async (type) => {
    const event = { id: `evt_${type}`, type, data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 5000 } } };

    const response = await processForTest(makeRequest(event));

    expect(response.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { checkoutSessionId: 'cs_1', sourceEventId: `evt_${type}` });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockOrdersUpdate).not.toHaveBeenCalled();
  });

  it.each(['payment_intent.succeeded', 'payment_intent.payment_failed'])(
    '%s は PaymentIntent ID を照合関数へ渡すだけで、失敗イベントだけでは在庫を戻さない（R-02）',
    async (type) => {
      const event = { id: `evt_${type}`, type, data: { object: { id: 'pi_1', status: 'requires_payment_method', metadata: {} } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockReconcile).toHaveBeenCalledWith(mockReconcilerDeps, { paymentIntentId: 'pi_1', sourceEventId: `evt_${type}` });
      expect(mockRpc).not.toHaveBeenCalledWith('release_stock_for_unpaid_order', expect.anything());
    },
  );

  it('同じ支払いのイベントが順不同・重複で届いても、照合関数へは同じ Session を渡す（R-01）', async () => {
    const succeeded = { id: 'evt_1', type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_1' } } };
    const completed = { id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };

    await processForTest(makeRequest(succeeded));
    await processForTest(makeRequest(completed));
    await processForTest(makeRequest(succeeded));

    expect(mockReconcile.mock.calls.map(([, input]) => input.checkoutSessionId)).toEqual(['cs_1', 'cs_1', 'cs_1']);
  });

  it('要対応になった支払いもイベントは完了にする（永久に再試行しない）', async () => {
    mockReconcile.mockResolvedValue({
      kind: 'needs_action',
      exceptionId: 'exception-1',
      reason: 'order_not_creatable',
      orderId: null,
      orderStatus: null,
    });
    const event = { id: 'evt_completed', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };

    expect((await processForTest(makeRequest(event))).status).toBe(200);
  });

  it('照合の一時的な失敗はイベントを失敗にし、worker に再試行させる', async () => {
    mockReconcile.mockRejectedValue(Object.assign(new Error('temporarily unavailable'), { code: 'stripe_unavailable' }));
    const event = { id: 'evt_completed', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } };

    expect((await processForTest(makeRequest(event))).status).toBe(500);
  });
});
