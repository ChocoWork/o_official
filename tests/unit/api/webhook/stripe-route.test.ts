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
const mockRefundList = jest.fn();
const mockOrdersUpdate = jest.fn();
const mockSyncPaymentIntentAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });
const mockSyncRefundAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });
const mockSyncPayoutAccounting = jest.fn().mockResolvedValue({ reconciliationStatus: 'matched' });
let orderLookupData: Record<string, unknown> | null = null;
let orderLookupError: { message: string } | null = null;
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
    refunds: {
      list: mockRefundList,
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
    orderLookupData = null;
    orderLookupError = null;
    mockRefundList.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
    });
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          update: mockOrdersUpdate,
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockImplementation(() =>
                Promise.resolve({ data: orderLookupData, error: orderLookupError })
              ),
            }),
          }),
        };
      }

      return {};
    });
  });

  it('refund.updatedで成功済み返金累計をCAS RPCへ同期する', async () => {
    orderLookupData = {
      id: 'order-1',
      status: 'paid',
      total_amount: 10_000,
      refunded_amount: 0,
      payment_status_updated_at: null,
      shipped_at: null,
    };
    mockRpc.mockImplementation((functionName: string) => Promise.resolve(
      functionName === 'apply_order_refund_projection'
        ? { data: [{ id: 'order-1', status: 'paid', refunded_amount: 2_500 }], error: null }
        : { data: [{ released: true, order_id: 'order-1' }], error: null },
    ));
    mockRefundList.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { status: 'succeeded', amount: 2_500, created: 1_786_000_000 };
      },
    });
    const event = {
      id: 'evt_refund',
      type: 'refund.updated',
      data: { object: { id: 're_1', payment_intent: 'pi_refund' } },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await processForTest(makeRequest(event));

    expect((response as { status: number }).status).toBe(200);
    expect(mockRefundList).toHaveBeenCalledWith({ payment_intent: 'pi_refund', limit: 100 });
    expect(mockRpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({
      _actor_id: null,
      _expected_payment_status_updated_at: null,
      _expected_refunded_amount: 0,
      _expected_status: 'paid',
      _refunded_amount: 2_500,
    }));
    expect(mockOrdersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ refunded_amount: 2_500 }));
    expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_1' }));
  });

  it('refund.failedでStripe現在値から返金投影と会計を再同期する', async () => {
    orderLookupData = {
      id: 'order-1',
      status: 'cancelled',
      total_amount: 10_000,
      refunded_amount: 10_000,
      payment_status_updated_at: null,
      shipped_at: null,
    };
    mockRpc.mockImplementation((functionName: string) => Promise.resolve(
      functionName === 'apply_order_refund_projection'
        ? { data: [{ id: 'order-1', status: 'paid', refunded_amount: 2_500 }], error: null }
        : { data: [{ released: true, order_id: 'order-1' }], error: null },
    ));
    mockRefundList.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { status: 'succeeded', amount: 2_500, created: 1_786_000_000 };
        yield { status: 'failed', amount: 7_500, created: 1_786_000_100 };
      },
    });
    const event = {
      id: 'evt_refund_failed',
      type: 'refund.failed',
      data: { object: { id: 're_failed', payment_intent: 'pi_refund' } },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await processForTest(makeRequest(event));

    expect((response as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({
      _expected_refunded_amount: 10_000,
      _expected_status: 'cancelled',
      _refunded_amount: 2_500,
    }));
    expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_failed' }));
  });

  it('返金投影が3回競合したら処理を失敗させ、workerの再試行対象にする', async () => {
    orderLookupData = {
      id: 'order-1',
      status: 'paid',
      total_amount: 10_000,
      refunded_amount: 0,
      payment_status_updated_at: null,
      shipped_at: null,
    };
    mockRpc.mockImplementation((functionName: string) => Promise.resolve(
      functionName === 'apply_order_refund_projection'
        ? { data: [], error: null }
        : { data: [{ released: true, order_id: 'order-1' }], error: null },
    ));
    const event = {
      id: 'evt_refund_conflict',
      type: 'refund.updated',
      data: { object: { id: 're_conflict', payment_intent: 'pi_refund' } },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await processForTest(makeRequest(event));

    expect((response as { status: number }).status).toBe(500);
    expect(mockRefundList).toHaveBeenCalledTimes(3);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'apply_order_refund_projection')).toHaveLength(3);
  });

  describe('注文に結び付いていない支払いの返金イベント', () => {
    // 注文を作れなかった支払い（要対応 order_not_creatable）は、店が Stripe で返金する。注文は現れないので、
    // 再試行しても直らない。イベントを失敗にして永久に再試行させず、監査に残して会計の同期へ進む。
    const REFUND_EVENT_TYPES = ['refund.created', 'refund.updated', 'refund.failed'] as const;

    const orphanEvents: Array<[string, Record<string, unknown>, Record<string, string | null>]> = [
      ...REFUND_EVENT_TYPES.map((type): [string, Record<string, unknown>, Record<string, string | null>] => [
        type,
        { id: 're_orphan', payment_intent: 'pi_orphan' },
        { refund_id: 're_orphan', charge_id: null },
      ]),
      ['charge.refunded', { id: 'ch_orphan', payment_intent: 'pi_orphan' }, { refund_id: null, charge_id: 'ch_orphan' }],
    ];

    it.each(orphanEvents)('%s は注文が無くても失敗にせず、監査に残して完了にする', async (type, object, ids) => {
      const event = { id: `evt_orphan_${type}`, type, data: { object } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      // 注文が無いので、Stripe の返金一覧も返金投影の RPC も使わない
      expect(mockRefundList).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalledWith('apply_order_refund_projection', expect.anything());
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

    it.each(REFUND_EVENT_TYPES)('%s は注文が無くても会計の同期まで進む', async (type) => {
      const event = { id: `evt_orphan_${type}`, type, data: { object: { id: 're_orphan', payment_intent: 'pi_orphan' } } };

      await processForTest(makeRequest(event));

      expect(mockSyncRefundAccounting).toHaveBeenCalledTimes(1);
      expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_orphan' }));
    });

    it('注文のある支払いの返金イベントは、これまでどおり返金を同期し、注文なしの監査を残さない', async () => {
      orderLookupData = {
        id: 'order-1',
        status: 'paid',
        total_amount: 10_000,
        refunded_amount: 0,
        payment_status_updated_at: null,
        shipped_at: null,
      };
      mockRpc.mockImplementation((functionName: string) => Promise.resolve(
        functionName === 'apply_order_refund_projection'
          ? { data: [{ id: 'order-1', status: 'paid', refunded_amount: 2_500 }], error: null }
          : { data: [{ released: true, order_id: 'order-1' }], error: null },
      ));
      mockRefundList.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { status: 'succeeded', amount: 2_500, created: 1_786_000_000 };
        },
      });
      const event = { id: 'evt_with_order', type: 'refund.created', data: { object: { id: 're_1', payment_intent: 'pi_refund' } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({ _refunded_amount: 2_500 }));
      expect(mockSyncRefundAccounting).toHaveBeenCalledWith(expect.objectContaining({ refundId: 're_1' }));
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
    });

    it('注文の読み取り自体が失敗した返金イベントは、注文が無いのと区別して失敗にし、再試行させる', async () => {
      orderLookupError = { message: 'connection lost' };
      const event = { id: 'evt_read_failed', type: 'refund.updated', data: { object: { id: 're_1', payment_intent: 'pi_refund' } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(500);
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
      expect(mockSyncRefundAccounting).not.toHaveBeenCalled();
    });

    it('PaymentIntent の無い返金イベントは、これまでどおり不正なイベントとして失敗にする', async () => {
      const event = { id: 'evt_no_pi', type: 'refund.created', data: { object: { id: 're_1', payment_intent: null } } };

      const response = await processForTest(makeRequest(event));

      expect(response.status).toBe(500);
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'checkout.webhook.refund_without_order' }));
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
