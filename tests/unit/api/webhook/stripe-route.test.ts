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
const mockRetrieveCheckoutSession = jest.fn();
const mockRetrievePaymentIntent = jest.fn();
const mockListCheckoutSessions = jest.fn();
const mockSyncPaymentIntentAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });
const mockSyncRefundAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });
const mockSyncPayoutAccounting = jest.fn().mockResolvedValue({ reconciliationStatus: 'matched' });
let orderLookupData: Record<string, unknown> | null = null;
// 入金待ち注文の確認メール用に order.id で引く行（レビュー指摘 I6a）。
// payment_intent_id で引く重複検知（orderLookupData）とは別の行を返す必要があるため分けてある。
let orderRowForEmail: Record<string, unknown> | null = null;
let ordersUpdateSelectResult: { data: Record<string, unknown>[] | null; error: { message: string } | null } = {
  data: [],
  error: null,
};
let orderItemsSelectResult: Record<string, unknown>[] = [];
let orderItemsSelectError: { message: string } | null = null;
let checkoutDraftsUpdateMock: jest.Mock;
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
    refunds: {
      list: mockRefundList,
    },
    checkout: {
      sessions: {
        retrieve: mockRetrieveCheckoutSession,
        list: mockListCheckoutSessions,
      },
    },
    paymentIntents: {
      retrieve: mockRetrievePaymentIntent,
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

// 注文行と明細の取得・本文の組み立てはメール側の共通処理が持つ（掃除ジョブと共通）。
// ここは「どの注文に、どの種類を送ろうとしたか」だけを見る。
// 明細が引けないときに空リストで送らないことは
// tests/unit/lib/orders/order-confirmation-email.test.ts が確かめる。
const mockSendOrderConfirmationEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/orders/order-confirmation-email', () => ({
  sendOrderConfirmationEmailForOrderId: (...args: unknown[]) =>
    mockSendOrderConfirmationEmail(...args),
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
// 注文に必要な項目が揃っている配送先。FREQ-365 の欠落検知テストだけ差し替える。
const COMPLETE_SHIPPING_SNAPSHOT = {
  email: 'buyer@example.com',
  fullName: '山田太郎',
  postalCode: '1000001',
  prefecture: '東京都',
  city: '千代田区',
  address: '丸の内1-1-1',
  building: null,
  phone: '0312345678',
};
let draftShippingSnapshot: Record<string, unknown> | null = COMPLETE_SHIPPING_SNAPSHOT;

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
    orderLookupData = null;
    orderRowForEmail = null;
    draftShippingSnapshot = COMPLETE_SHIPPING_SNAPSHOT;
    ordersUpdateSelectResult = { data: [], error: null };
    orderItemsSelectResult = [];
    orderItemsSelectError = null;
    mockRefundList.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
    });
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });
    // 支払方法解決用の expand 済みセッション取得。個別テストで上書きしない限り、
    // PaymentIntent 情報が無い＝既定値 (stripe_card) へ解決される想定。
    mockRetrieveCheckoutSession.mockResolvedValue({ payment_intent: null, metadata: {} });
    // 支払方法解決用の expand 済み PaymentIntent 取得。個別テストで上書きしない限り、
    // 手段情報が無い＝既定値 (stripe_card) へ解決される想定。
    mockRetrievePaymentIntent.mockResolvedValue({
      payment_method_types: [],
      payment_method: null,
      latest_charge: null,
    });
    // payment_intent.succeeded から割引を引くための Checkout Session 検索。
    // 個別テストで上書きしない限り、割引なし（該当セッション無し）の想定。
    mockListCheckoutSessions.mockResolvedValue({ data: [] });
    checkoutDraftsUpdateMock = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        const updateBuilder = {
          or: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          select: jest.fn().mockImplementation(() => Promise.resolve(ordersUpdateSelectResult)),
        };

        return {
          update: mockOrdersUpdate.mockReturnValue(updateBuilder),
          select: jest.fn().mockReturnValue({
            // 'payment_intent_id' で引くのは注文作成前の重複検知、'id' で引くのは
            // 入金待ち確認メール用の注文取得（レビュー指摘 I6a）。同じ orders テーブルの
            // select だが呼び分けが必要なので eq() の第一引数で分岐する。
            eq: jest.fn().mockImplementation((field: string) => ({
              maybeSingle: jest.fn().mockImplementation(() =>
                Promise.resolve({
                  data: field === 'id' ? orderRowForEmail : orderLookupData,
                  error: null,
                })
              ),
            })),
          }),
        };
      }

      if (table === 'order_items') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockImplementation(() =>
              Promise.resolve({ data: orderItemsSelectResult, error: orderItemsSelectError })
            ),
          }),
        };
      }

      if (table === 'checkout_drafts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockImplementation(() =>
                Promise.resolve({
                  data: {
                    subtotal_amount: 5000,
                    shipping_amount: 0,
                    total_amount: 5500,
                    currency: 'jpy',
                    shipping_snapshot: draftShippingSnapshot,
                    items_snapshot: [
                      { quantity: 1, line_total: 3000 },
                      { quantity: 1, line_total: 2000 },
                    ],
                  },
                  error: null,
                })
              ),
            }),
          }),
          update: checkoutDraftsUpdateMock,
        };
      }

      return {};
    });
  });

  it('checkout.session.expired を受け取ると 200 を返し監査ログを記録する', async () => {
    const event = {
      id: 'evt_expired',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_expired',
          payment_intent: 'pi_expired',
        },
      },
    };

    mockConstructEvent.mockReturnValue(event);

    const req = makeRequest(event);
    const res = await processForTest(req);

    expect((res as { status: number }).status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalled();
  });

  // 割引が付いたセッション（FREQ-389）。下書きは割引前の合計を持っているため、
  // そろえないまま注文確定を呼ぶと CHECKOUT_TOTAL_MISMATCH で落ち、workerが再試行し続ける。
  // ブラウザが戻らない経路（コンビニ・銀行振込、webhook 先行のカード）では complete が走らないので、
  // ここでもそろえる必要がある。
  it('割引が付いたセッションは、注文確定の前に下書きの合計と割引額をそろえる', async () => {
    const session = {
      id: 'cs_discount',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-123' },
      payment_intent: 'pi_discount',
      amount_total: 5000,
      total_details: { amount_discount: 500 },
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = { id: 'evt_discount', type: 'checkout.session.completed', data: { object: session } };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-1', order_status: 'paid' }], error: null });

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(checkoutDraftsUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ total_amount: 5000, discount_amount: 500 })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_order_from_checkout_draft',
      expect.objectContaining({ _expected_total_amount: 5000 })
    );
  });

  it('下書きをそろえられなければ注文を作らず、workerの再試行対象にする', async () => {
    const session = {
      id: 'cs_discount_fail',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-123' },
      payment_intent: 'pi_discount_fail',
      amount_total: 5000,
      total_details: { amount_discount: 500 },
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = { id: 'evt_discount_fail', type: 'checkout.session.completed', data: { object: session } };

    mockConstructEvent.mockReturnValue(event);
    checkoutDraftsUpdateMock.mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: { message: "column 'discount_amount' does not exist" } }),
    });

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalledWith(
      'finalize_order_from_checkout_draft',
      expect.anything()
    );
  });

  it('checkout.session.completed で注文作成 webhook が処理される', async () => {
    const session = {
      id: 'cs_complete',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-123' },
      payment_intent: 'pi_complete',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = {
      id: 'evt_completed',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-1', order_status: 'paid' }], error: null });

    const req = makeRequest(event);
    const res = await processForTest(req);

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('finalize_order_from_checkout_draft', expect.objectContaining({
      _draft_id: 'draft-123',
      _payment_intent_id: 'pi_complete',
      _checkout_session_id: 'cs_complete',
      _expected_total_amount: 5500,
    }));
    expect(mockLogAudit).toHaveBeenCalled();
  });

  it('checkout.session.completed が未入金のまま注文を作ると入金待ちメールを送る（レビュー指摘 I6a）', async () => {
    const session = {
      id: 'cs_pending',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-pending' },
      payment_intent: 'pi_pending',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'unpaid',
    };
    const event = {
      id: 'evt_completed_pending',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-pending-1', order_status: 'pending' }], error: null });
    orderRowForEmail = {
      id: 'order-pending-1',
      shipping_email: 'konbini@example.com',
      shipping_full_name: '鈴木 太郎',
      subtotal_amount: 5000,
      shipping_amount: 500,
      total_amount: 5500,
      currency: 'jpy',
      shipping_postal_code: '100-0001',
      shipping_prefecture: '東京都',
      shipping_city: '千代田区',
      shipping_address: '千代田1-1',
      shipping_building: null,
      shipping_phone: '090-0000-0000',
    };
    orderItemsSelectResult = [
      { item_name: 'コート', color: null, size: 'M', quantity: 1, line_total: 5000 },
    ];

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-pending-1',
        paymentState: 'awaiting_payment',
        logLabel: '[webhook]',
      })
    );
  });

  it('カード決済で webhook が先に注文を作ったときも入金確認メールを送る（FREQ-386）', async () => {
    // webhook が先着すると、あとから来た complete は「既存の注文」として何も送らずに返す。
    // webhook が pending のときしか送らないままだと、客に1通も届かない。
    const session = {
      id: 'cs_paid_webhook',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-paid' },
      payment_intent: 'pi_paid_webhook',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = {
      id: 'evt_completed_paid',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-paid-1', order_status: 'paid' }], error: null });
    orderRowForEmail = {
      id: 'order-paid-1',
      shipping_email: 'card@example.com',
      shipping_full_name: '山田 花子',
      subtotal_amount: 5000,
      shipping_amount: 500,
      total_amount: 5500,
      currency: 'jpy',
      shipping_postal_code: '150-0001',
      shipping_prefecture: '東京都',
      shipping_city: '渋谷区',
      shipping_address: '神宮前1-1-1',
      shipping_building: null,
      shipping_phone: '090-0000-0000',
    };
    orderItemsSelectResult = [
      { item_name: 'コート', color: null, size: 'M', quantity: 1, line_total: 5000 },
    ];

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-paid-1',
        paymentState: 'paid',
        logLabel: '[webhook]',
      })
    );
  });

  it('入金待ちメールを送れなくても注文は成功扱いにする（レビュー指摘 I6c）', async () => {
    const session = {
      id: 'cs_pending_2',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-pending-2' },
      payment_intent: 'pi_pending_2',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'unpaid',
    };
    const event = {
      id: 'evt_completed_pending_2',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-pending-2', order_status: 'pending' }], error: null });
    orderRowForEmail = { id: 'order-pending-2', shipping_email: 'konbini2@example.com' };
    // 明細が引けず、共通処理が「送らなかった」と返した場合
    mockSendOrderConfirmationEmail.mockResolvedValue(false);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);

    consoleErrorSpy.mockRestore();
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

  it('async_payment_failed は在庫復元 RPC を呼ぶ', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });

    const event = {
      id: 'evt_async_failed',
      type: 'checkout.session.async_payment_failed',
      data: {
        object: {
          id: 'cs_test_1',
          payment_intent: 'pi_test_1',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await processForTest(makeRequest(event));

    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', {
      _payment_intent_id: 'pi_test_1',
    });
    expect(mockOrdersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('async_payment_succeeded は pending 注文を paid にして確認メールを送る', async () => {
    ordersUpdateSelectResult = {
      data: [
        {
          id: 'order-async-1',
          shipping_email: 'hanako@example.com',
          shipping_full_name: '山田 花子',
          subtotal_amount: 5000,
          shipping_amount: 500,
          total_amount: 5500,
          currency: 'jpy',
          shipping_postal_code: '150-0001',
          shipping_prefecture: '東京都',
          shipping_city: '渋谷区',
          shipping_address: '神宮前1-2-3',
          shipping_building: null,
          shipping_phone: '090-1234-5678',
        },
      ],
      error: null,
    };
    orderItemsSelectResult = [
      { item_name: 'シルクブラウス', color: 'WHITE', size: 'M', quantity: 1, line_total: 5000 },
    ];

    const event = {
      id: 'evt_async_succeeded',
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: 'cs_async_1',
          payment_intent: 'pi_async_1',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-async-1',
        paymentState: 'paid',
        logLabel: '[webhook]',
      })
    );
  });

  it('async_payment_succeeded で確認メールを送れなくても 200 を返す（レビュー指摘 I6c）', async () => {
    ordersUpdateSelectResult = {
      data: [
        {
          id: 'order-async-err',
          shipping_email: 'hanako@example.com',
          shipping_full_name: '山田 花子',
          subtotal_amount: 5000,
          shipping_amount: 500,
          total_amount: 5500,
          currency: 'jpy',
          shipping_postal_code: '150-0001',
          shipping_prefecture: '東京都',
          shipping_city: '渋谷区',
          shipping_address: '神宮前1-2-3',
          shipping_building: null,
          shipping_phone: '090-1234-5678',
        },
      ],
      error: null,
    };
    // 明細が引けず、共通処理が「送らなかった」と返した場合
    mockSendOrderConfirmationEmail.mockResolvedValue(false);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const event = {
      id: 'evt_async_succeeded_items_error',
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: 'cs_async_err',
          payment_intent: 'pi_async_err',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);

    consoleErrorSpy.mockRestore();
  });

  it('async_payment_succeeded の再送（更新0件）では確認メールを送らない', async () => {
    ordersUpdateSelectResult = { data: [], error: null };

    const event = {
      id: 'evt_async_succeeded_redelivery',
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: 'cs_async_2',
          payment_intent: 'pi_async_2',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  // FREQ-369: supabase-js は失敗を例外にせず { error } で返す。ここで握りつぶして 200 を返すと
  // Stripe は再送せず、入金済みの注文が pending のまま残る（掃除ジョブが拾うのは作成5日後以降）。
  it('async_payment_succeeded で paid への更新が失敗したらworkerの再試行対象にする（FREQ-369）', async () => {
    ordersUpdateSelectResult = { data: null, error: { message: 'Connection terminated unexpectedly' } };

    const event = {
      id: 'evt_async_succeeded_db_error',
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: {
          id: 'cs_async_db_error',
          payment_intent: 'pi_async_db_error',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const res = await processForTest(makeRequest(event));

    // 業務処理の例外はworkerが永続キューへ失敗として記録し、次回再試行する
    expect((res as { status: number }).status).toBe(500);
    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it('checkout.session.expired も在庫復元 RPC を呼ぶ', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });

    const event = {
      id: 'evt_expired_2',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_test_2',
          payment_intent: 'pi_test_2',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await processForTest(makeRequest(event));

    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', {
      _payment_intent_id: 'pi_test_2',
    });
    expect(mockOrdersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('復元対象がなくても 200 を返す（再送イベント）', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: false, order_id: null }], error: null });

    const event = {
      id: 'evt_async_failed_3',
      type: 'checkout.session.async_payment_failed',
      data: {
        object: {
          id: 'cs_test_3',
          payment_intent: 'pi_test_3',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await processForTest(makeRequest(event));

    expect((response as { status: number }).status).toBe(200);
  });

  it('payment_intent.payment_failed も在庫復元 RPC を呼ぶ', async () => {
    mockRpc.mockResolvedValue({ data: [{ released: true, order_id: 'order-1' }], error: null });

    const event = {
      id: 'evt_pi_failed',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_test_4',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    await processForTest(makeRequest(event));

    expect(mockRpc).toHaveBeenCalledWith('release_stock_for_unpaid_order', {
      _payment_intent_id: 'pi_test_4',
    });
    expect(mockOrdersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('在庫復元 RPC がエラーを返すと処理に失敗し、workerの再試行対象にする', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db error' } });

    const event = {
      id: 'evt_release_rpc_error',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_test_5',
          payment_intent: 'pi_test_5',
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);

    const response = await processForTest(makeRequest(event));

    expect((response as { status: number }).status).toBe(500);
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

  it('checkout.session.completed は expand したセッションから支払方法を解決して draft へ書き戻す', async () => {
    const session = {
      id: 'cs_complete_pm',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-pm' },
      payment_intent: 'pi_complete_pm',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = {
      id: 'evt_completed_pm',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-pm', order_status: 'paid' }], error: null });
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_complete_pm',
      payment_intent: {
        id: 'pi_complete_pm',
        payment_method_types: ['card'],
        payment_method: null,
        latest_charge: { payment_method_details: { type: 'paypay' } },
      },
      metadata: {},
    });

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRetrieveCheckoutSession).toHaveBeenCalledWith(
      'cs_complete_pm',
      expect.objectContaining({
        expand: expect.arrayContaining([
          'payment_intent',
          'payment_intent.payment_method',
          'payment_intent.latest_charge',
        ]),
      })
    );

    const call = checkoutDraftsUpdateMock.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'payment_method' in args[0]
    );
    expect((call?.[0] as { payment_method?: unknown } | undefined)?.payment_method).toBe('stripe_paypay');
  });

  it('expand したセッションの取得に失敗しても注文作成は続行し payment_method は書き戻さない', async () => {
    const session = {
      id: 'cs_complete_fail',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-fail' },
      payment_intent: 'pi_complete_fail',
      amount_total: 5500,
      currency: 'jpy',
      payment_status: 'paid',
    };
    const event = {
      id: 'evt_completed_fail',
      type: 'checkout.session.completed',
      data: { object: session },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-fail', order_status: 'paid' }], error: null });
    mockRetrieveCheckoutSession.mockRejectedValue(new Error('stripe down'));

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    const call = checkoutDraftsUpdateMock.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'payment_method' in args[0]
    );
    expect(call).toBeUndefined();
  });

  it('配送先が欠けた draft から注文を作ったら、欠けた項目を監査ログに残す（FREQ-365）', async () => {
    // ブラウザが戻らず webhook だけで注文が作られる経路は、確定直前の同期が走っていないため
    // 配送先の欠落が起こりやすい。支払いは成立しているので注文は作り、出荷前に気づけるようにする。
    draftShippingSnapshot = { ...COMPLETE_SHIPPING_SNAPSHOT, address: '   ', phone: null };
    const paymentIntent = {
      id: 'pi_missing_shipping',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-missing-shipping' },
      amount: 5500,
      currency: 'jpy',
    };
    const event = {
      id: 'evt_missing_shipping',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({
      data: [{ order_id: 'order-missing-shipping', order_status: 'paid' }],
      error: null,
    });

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_order_from_checkout_draft',
      expect.objectContaining({ _draft_id: 'draft-missing-shipping' })
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.webhook.order_finalize',
        outcome: 'error',
        detail: 'Checkout draft shipping snapshot is incomplete',
        metadata: expect.objectContaining({
          draft_id: 'draft-missing-shipping',
          payment_intent_id: 'pi_missing_shipping',
          missing_shipping_fields: ['address', 'phone'],
        }),
      })
    );
  });

  it('payment_intent.succeeded は expand した PaymentIntent から支払方法を解決して draft へ書き戻す', async () => {
    const paymentIntent = {
      id: 'pi_succeeded_pm',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-pi-pm' },
      amount: 5500,
      currency: 'jpy',
    };
    const event = {
      id: 'evt_pi_succeeded_pm',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-pi-pm', order_status: 'paid' }], error: null });
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_succeeded_pm',
      payment_method_types: ['card'],
      payment_method: null,
      latest_charge: { payment_method_details: { type: 'paypay' } },
    });

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRetrievePaymentIntent).toHaveBeenCalledWith(
      'pi_succeeded_pm',
      expect.objectContaining({
        expand: expect.arrayContaining(['payment_method', 'latest_charge']),
      })
    );

    const call = checkoutDraftsUpdateMock.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'payment_method' in args[0]
    );
    expect((call?.[0] as { payment_method?: unknown } | undefined)?.payment_method).toBe('stripe_paypay');
  });

  it('expand した PaymentIntent の取得に失敗しても注文作成は続行し payment_method は書き戻さない', async () => {
    const paymentIntent = {
      id: 'pi_succeeded_fail',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-pi-fail' },
      amount: 5500,
      currency: 'jpy',
    };
    const event = {
      id: 'evt_pi_succeeded_fail',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-pi-fail', order_status: 'paid' }], error: null });
    mockRetrievePaymentIntent.mockRejectedValue(new Error('stripe down'));

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    const call = checkoutDraftsUpdateMock.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'payment_method' in args[0]
    );
    expect(call).toBeUndefined();
  });

  /**
   * 合計が 0 のセッションは、PaymentIntent が作られないので注文にできない（FREQ-389）。
   * webhook はそれを「payment_intent が無い」としか記録していなかった。確定（complete）は
   * 同じ原因を「合計 0 は受け付けない」と明示して断るため、同じ事象の記録が経路で食い違い、
   * 本番のログからは Stripe の不具合と区別がつかなかった（FREQ-397）。
   */
  it('合計が 0 のセッションは、理由を明示して記録する', async () => {
    const session = {
      id: 'cs_zero',
      metadata: { draft_id: 'draft-zero', session_id: 'sess-abc' },
      payment_intent: null,
      amount_total: 0,
      currency: 'jpy',
      payment_status: 'no_payment_required',
      total_details: { amount_discount: 5500 },
    };
    const event = { id: 'evt_zero', type: 'checkout.session.completed', data: { object: session } };

    mockConstructEvent.mockReturnValue(event);

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_order_from_checkout_draft', expect.anything());
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        detail: 'Zero-amount checkout session is not supported',
        metadata: expect.objectContaining({
          checkout_session_id: 'cs_zero',
          draft_id: 'draft-zero',
          amount_discount: 5500,
        }),
      })
    );
  });

  /**
   * Stripe はイベントの配信順を保証しない（FREQ-394）。割引が付いた注文で
   * payment_intent.succeeded が checkout.session.completed より先に届くと、下書きは
   * 割引前の合計のままなので、注文確定が CHECKOUT_TOTAL_MISMATCH で落ちて 500 を返し続ける。
   * この経路でも割引額を Stripe（Checkout Session）から引いてそろえる。
   */
  it('payment_intent.succeeded が先に届いても、割引をそろえてから注文確定を呼ぶ', async () => {
    const paymentIntent = {
      id: 'pi_discount_first',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-discount-first' },
      amount: 5000,
      currency: 'jpy',
    };
    const event = {
      id: 'evt_pi_discount_first',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({
      data: [{ order_id: 'order-discount-first', order_status: 'paid' }],
      error: null,
    });
    mockListCheckoutSessions.mockResolvedValue({
      data: [{ id: 'cs_discount_first', amount_total: 5000, total_details: { amount_discount: 500 } }],
    });

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    expect(mockListCheckoutSessions).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_discount_first' })
    );
    const discountSyncCall = checkoutDraftsUpdateMock.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'discount_amount' in args[0]
    );
    expect(discountSyncCall?.[0]).toEqual(
      expect.objectContaining({ total_amount: 5000, discount_amount: 500 })
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_order_from_checkout_draft',
      expect.objectContaining({ _expected_total_amount: 5000 })
    );
  });

  it('Checkout Session を引けなくても payment_intent.succeeded の注文作成は続ける', async () => {
    const paymentIntent = {
      id: 'pi_session_lookup_fail',
      metadata: { session_id: 'sess-abc', draft_id: 'draft-session-lookup-fail' },
      amount: 5500,
      currency: 'jpy',
    };
    const event = {
      id: 'evt_pi_session_lookup_fail',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
    };

    mockConstructEvent.mockReturnValue(event);
    mockRpc.mockResolvedValue({
      data: [{ order_id: 'order-session-lookup-fail', order_status: 'paid' }],
      error: null,
    });
    mockListCheckoutSessions.mockRejectedValue(new Error('stripe down'));

    const res = await processForTest(makeRequest(event));

    expect((res as { status: number }).status).toBe(200);
    const discountSyncCall = checkoutDraftsUpdateMock.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'discount_amount' in args[0]
    );
    expect(discountSyncCall).toBeUndefined();
  });
});
