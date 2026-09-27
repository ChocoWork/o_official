import { NextRequest } from 'next/server';

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRetrieveCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    checkout: {
      sessions: {
        retrieve: mockRetrieveCheckoutSession,
      },
    },
  }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockSendOrderConfirmationEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/orders/order-confirmation-email', () => ({
  sendOrderConfirmationEmailForOrderId: (...args: unknown[]) =>
    mockSendOrderConfirmationEmail(...args),
}));

import { POST } from '@/app/api/checkout/complete/route';

function makeRequest(body: Record<string, unknown>, sessionId = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/checkout/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' ? { value: sessionId } : undefined) },
  });

  return req;
}


// 注文に必要な項目が揃っている配送先（FREQ-365 の検証で「欠けていない」側の基準）。
const COMPLETE_SHIPPING = {
  email: 'buyer@example.com',
  fullName: '山田太郎',
  postalCode: '1000001',
  prefecture: '東京都',
  city: '千代田区',
  address: '丸の内1-1-1',
  building: null,
  phone: '0312345678',
};

function setupBaseSupabase(
  existingOrder: { id: string; status: string } | null = null,
  draftOverrides: Record<string, unknown> = {}
) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'checkout_drafts') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'draft-123',
                session_id: 'sess-abc',
                total_amount: 5500,
                currency: 'jpy',
                shipping_snapshot: COMPLETE_SHIPPING,
                ...draftOverrides,
              },
              error: null,
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
      };
    }

    if (table === 'orders') {
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: existingOrder, error: null }),
      };
    }

    return {};
  });
}

let checkoutDraftsUpdateMock: jest.Mock;

function setupSession(options: {
  payment_status: string;
  status: string;
  metadata: Record<string, string>;
  payment_intent: {
    id: string;
    payment_method_types: string[];
    latest_charge: { payment_method_details: { type: string } } | null;
  };
  existingOrder?: { id: string; user_id: string | null; status: string } | null;
}) {
  checkoutDraftsUpdateMock = jest.fn().mockReturnValue({
    eq: jest.fn().mockResolvedValue({ data: null, error: null }),
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'checkout_drafts') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'draft-1',
                session_id: 'sess-abc',
                total_amount: 5500,
                currency: 'jpy',
              },
              error: null,
            }),
          }),
        }),
        update: checkoutDraftsUpdateMock,
      };
    }

    if (table === 'orders') {
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: options.existingOrder ?? null, error: null }),
      };
    }

    return {};
  });

  mockRetrieveCheckoutSession.mockResolvedValue({
    id: 'cs_test',
    mode: 'payment',
    payment_status: options.payment_status,
    status: options.status,
    currency: 'jpy',
    amount_total: 5500,
    metadata: options.metadata,
    payment_intent: options.payment_intent,
  });

  mockRpc.mockResolvedValue({ data: [{ order_id: 'order-1', order_status: 'paid' }], error: null });
}

// checkout_drafts への update 呼び出し引数から payment_method を拾う。
function insertedOrderPaymentMethod(): unknown {
  const call = checkoutDraftsUpdateMock.mock.calls.find(
    (args) => args[0] && typeof args[0] === 'object' && 'payment_method' in args[0]
  );
  return (call?.[0] as { payment_method?: unknown } | undefined)?.payment_method;
}

describe('POST /api/checkout/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    setupBaseSupabase();
  });

  test('session_id Cookie がない場合は 400 を返す', async () => {
    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test' }, ''));
    expect((res as { status: number }).status).toBe(400);
  });

  test('bank 決済は公開 complete API で拒否する', async () => {
    const res = await POST(makeRequest({ paymentMethod: 'bank', checkoutSessionId: 'cs_test' }));

    expect((res as { status: number }).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('Stripe checkout session 完了時は draft ベース RPC で paid 注文を作成する', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_test',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_test', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-paid', order_status: 'paid' }], error: null });

    const res = await POST(makeRequest({ paymentMethod: 'stripe_card', checkoutSessionId: 'cs_test' }));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('finalize_order_from_checkout_draft', expect.objectContaining({
      _draft_id: 'draft-123',
      _payment_intent_id: 'pi_test',
      _checkout_session_id: 'cs_test',
      _order_status: 'paid',
    }));
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'checkout:complete' })
    );
  });

  test('配送先が欠けている draft でも注文は作り、欠けた項目を監査ログに残す（FREQ-365）', async () => {
    setupBaseSupabase(null, {
      shipping_snapshot: { ...COMPLETE_SHIPPING, address: '   ', phone: null },
    });
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_test',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_test', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-paid', order_status: 'paid' }], error: null });

    const res = await POST(makeRequest({ paymentMethod: 'stripe_card', checkoutSessionId: 'cs_test' }));

    // 支払いは成立しているので注文は作る（客に失敗を見せない）。
    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalled();
    // 出荷前に気づけるよう、欠けた項目を監査ログに残す。
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Checkout draft shipping snapshot is incomplete',
        metadata: expect.objectContaining({
          draft_id: 'draft-123',
          payment_intent_id: 'pi_test',
          missing_shipping_fields: ['address', 'phone'],
        }),
      })
    );
  });

  test('配送先が揃っていれば、欠損の監査ログは出ない（FREQ-365）', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_test',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_test', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-paid', order_status: 'paid' }], error: null });

    await POST(makeRequest({ paymentMethod: 'stripe_card', checkoutSessionId: 'cs_test' }));

    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'Checkout draft shipping snapshot is incomplete' })
    );
  });

  test('既存注文がある場合は RPC を呼ばず既存注文を返す', async () => {
    setupBaseSupabase({ id: 'existing-order', status: 'paid' });
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_existing',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-existing' },
      payment_intent: { id: 'pi_existing', payment_method_types: ['card'] },
    });

    const res = await POST(makeRequest({ paymentMethod: 'stripe_card', checkoutSessionId: 'cs_existing' }));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
    expect((res as unknown as { body: { orderId: string } }).body.orderId).toBe('existing-order');
  });

  test('checkout session に draft_id が無い場合は 400 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_missing_draft',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: { id: 'pi_missing_draft', payment_method_types: ['card'] },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_missing_draft' }));

    expect((res as { status: number }).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('finalize_order_from_checkout_draft が在庫不足を返した場合は 409 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_test',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_test', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INSUFFICIENT_STOCK:1:2:1' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test' }));

    expect((res as { status: number }).status).toBe(409);
    expect((res as unknown as { body: { error: string } }).body.error).toBe('out_of_stock');
  });

  test('finalize_order_from_checkout_draft が ITEM_NOT_PUBLISHED を返した場合は 409 を返す', async () => {
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_test',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_test', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'ITEM_NOT_PUBLISHED:1' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_test' }));

    expect((res as { status: number }).status).toBe(409);
    expect((res as unknown as { body: { error: string } }).body.error).toBe('item_not_published');
  });

  test('shipping.postalCode が不正な形式の場合は 400 を返す', async () => {
    const res = await POST(
      makeRequest({
        checkoutSessionId: 'cs_invalid_shipping',
        shipping: {
          postalCode: 'abc-1234',
        },
      })
    );

    expect((res as { status: number }).status).toBe(400);
    expect((res as unknown as { body: { error: string } }).body.error).toBe('Invalid request body');
    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled();
  });

  test('注文が新規に確定したとき確認メールを1通送る', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'checkout_drafts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  id: 'draft-123',
                  session_id: 'sess-abc',
                  total_amount: 5500,
                  currency: 'jpy',
                  shipping_snapshot: {
                    email: 'hanako@example.com',
                    fullName: '山田 花子',
                    postalCode: '150-0001',
                    prefecture: '東京都',
                    city: '渋谷区',
                    address: '神宮前1-2-3',
                    building: null,
                    phone: '090-1234-5678',
                  },
                  items_snapshot: [],
                },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }

      if (table === 'orders') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }

      return {};
    });

    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_test',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_test', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-paid', order_status: 'paid' }], error: null });

    await POST(makeRequest({ paymentMethod: 'stripe_card', checkoutSessionId: 'cs_test' }));

    // 本文の組み立ては共有の入口（注文行から引く）に任せる。complete が独自に組み立てると、
    // webhook / 掃除ジョブとの間で客に届く内容がずれる（FREQ-396）。
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-paid',
        // Stripe 側で支払い済みのセッションなので paymentState は 'paid'
        paymentState: 'paid',
        logLabel: '[checkout]',
      }),
    );
  });

  test('未入金セッション（konbini/銀行振込）は paymentState を awaiting_payment にする', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'checkout_drafts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  id: 'draft-123',
                  session_id: 'sess-abc',
                  total_amount: 5500,
                  currency: 'jpy',
                  shipping_snapshot: {
                    email: 'hanako@example.com',
                    fullName: '山田 花子',
                    postalCode: '150-0001',
                    prefecture: '東京都',
                    city: '渋谷区',
                    address: '神宮前1-2-3',
                    building: null,
                    phone: '090-1234-5678',
                  },
                  items_snapshot: [],
                },
                error: null,
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }

      if (table === 'orders') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }

      return {};
    });

    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_konbini',
      mode: 'payment',
      payment_status: 'unpaid',
      status: 'complete',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_konbini', draft_id: 'draft-123' },
      payment_intent: { id: 'pi_konbini', payment_method_types: ['konbini'], latest_charge: null },
    });
    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-konbini', order_status: 'pending' }], error: null });

    await POST(makeRequest({ checkoutSessionId: 'cs_konbini' }));

    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-konbini', paymentState: 'awaiting_payment' }),
    );
  });

  test('既存注文が見つかったときは確認メールを送らない', async () => {
    setupBaseSupabase({ id: 'existing-order', status: 'paid' });
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_existing',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-existing' },
      payment_intent: { id: 'pi_existing', payment_method_types: ['card'] },
    });

    await POST(makeRequest({ paymentMethod: 'stripe_card', checkoutSessionId: 'cs_existing' }));

    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it('実際に使われた支払方法を charge から取る', async () => {
    setupSession({
      payment_status: 'paid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: {
        id: 'pi_1',
        payment_method_types: ['paypay'],
        latest_charge: { payment_method_details: { type: 'paypay' } },
      },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_1', paymentMethod: 'stripe_card' }));

    expect(insertedOrderPaymentMethod()).toBe('stripe_paypay');
  });

  it('charge 前（未入金）は payment_method_types から取る', async () => {
    setupSession({
      payment_status: 'unpaid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: { id: 'pi_2', payment_method_types: ['konbini'], latest_charge: null },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_2' }));

    expect(insertedOrderPaymentMethod()).toBe('stripe_konbini');
  });

  it('クライアント申告は採用しない', async () => {
    setupSession({
      payment_status: 'paid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'auto' },
      payment_intent: {
        id: 'pi_3',
        payment_method_types: ['card'],
        latest_charge: { payment_method_details: { type: 'card' } },
      },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_3', paymentMethod: 'stripe_konbini' }));

    expect(insertedOrderPaymentMethod()).toBe('stripe_card');
  });

  it('既存注文の early return でも payment_method を書き戻す（Webhook との競合対策）', async () => {
    setupSession({
      payment_status: 'paid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: {
        id: 'pi_race',
        payment_method_types: ['card'],
        latest_charge: { payment_method_details: { type: 'paypay' } },
      },
      existingOrder: { id: 'order-race', user_id: null, status: 'paid' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_race' }));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
    expect((res as unknown as { body: { orderId: string } }).body.orderId).toBe('order-race');
    expect(insertedOrderPaymentMethod()).toBe('stripe_paypay');
  });

  it('draft の payment_method 書き戻しが失敗しても200を返し監査ログに error を残す', async () => {
    setupSession({
      payment_status: 'paid',
      status: 'complete',
      metadata: { draft_id: 'draft-1', session_id: 'sess-abc', selected_payment_method: 'stripe_card' },
      payment_intent: {
        id: 'pi_err',
        payment_method_types: ['card'],
        latest_charge: { payment_method_details: { type: 'card' } },
      },
    });

    checkoutDraftsUpdateMock.mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: { message: 'db write failed' } }),
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_err' }));

    expect((res as { status: number }).status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        detail: 'Failed to update checkout draft after order finalization',
        metadata: expect.objectContaining({ draft_id: 'draft-1' }),
      })
    );
  });

  /**
   * 旧スキーマ向けのフォールバックは廃止した（FREQ-398）。
   *
   * orders.checkout_session_id は既に本番にあり、この分岐は到達しない。一方で注文作成の
   * 二つ目の経路として残ると、注文確定 RPC に入れた変種の引き当て（variant_id /
   * fulfillment_type / 在庫台帳）を書かない注文ができる。読んでから書く在庫の減算も
   * 抱えていたため、経路ごと畳んで RPC 1本にする。
   */
  it('旧スキーマのエラーでも注文は作らず、監査ログを残して 500 を返す', async () => {
    setupBaseSupabase();
    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_legacy',
      mode: 'payment',
      payment_status: 'paid',
      currency: 'jpy',
      amount_total: 5500,
      metadata: { session_id: 'sess-abc', selected_payment_method: 'stripe_card', draft_id: 'draft-legacy' },
      payment_intent: { id: 'pi_legacy', payment_method_types: ['card'] },
    });
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'column checkout_drafts.checkout_session_id does not exist' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_legacy' }));

    expect((res as { status: number }).status).toBe(500);
    expect(mockSendOrderConfirmationEmail).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'error',
        detail: 'Failed to finalize order via RPC',
      })
    );
  });
});

/**
 * プロモーションコードで割引が付いた注文（FREQ-389）。
 *
 * 割引後の実請求額を checkout_drafts へ書き戻さないと、注文確定 RPC が割引前の合計と
 * 比べて CHECKOUT_TOTAL_MISMATCH で落ち、支払い済みの客に 409 を返す。書き戻しの失敗を
 * 握りつぶすと、その落ち方が本番の監査ログからは読み取れない。
 *
 * 合計が 0 になる 100%割引は、Stripe 公式に「支払いのない完了済みの Checkout セッションでは
 * PaymentIntent の関連付けが行われません」とあるとおり PaymentIntent が無く、注文の冪等キーを
 * 作れない。作れないものは理由を明示して断る。
 */
describe('POST /api/checkout/complete 割引', () => {
  let draftsUpdate: jest.Mock;

  function setupDiscountedSession(options: {
    amountTotal?: number;
    amountDiscount?: number;
    draftTotal?: number;
    draftDiscount?: number;
    existingOrder?: { id: string; user_id: string | null; status: string } | null;
    paymentIntent?: unknown;
    paymentStatus?: string;
    updateError?: { message: string } | null;
  } = {}) {
    const {
      amountTotal = 5000,
      amountDiscount = 500,
      draftTotal = 5500,
      draftDiscount = 0,
      existingOrder = null,
      paymentIntent = { id: 'pi_discount', payment_method_types: ['card'] },
      paymentStatus = 'paid',
      updateError = null,
    } = options;

    draftsUpdate = jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ data: null, error: updateError }),
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'checkout_drafts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              maybeSingle: jest.fn().mockResolvedValue({
                data: {
                  id: 'draft-discount',
                  session_id: 'sess-abc',
                  total_amount: draftTotal,
                  discount_amount: draftDiscount,
                  currency: 'jpy',
                  shipping_snapshot: COMPLETE_SHIPPING,
                  items_snapshot: [],
                },
                error: null,
              }),
            }),
          }),
          update: draftsUpdate,
        };
      }

      if (table === 'orders') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: existingOrder, error: null }),
        };
      }

      return {};
    });

    mockRetrieveCheckoutSession.mockResolvedValue({
      id: 'cs_discount',
      mode: 'payment',
      payment_status: paymentStatus,
      status: 'complete',
      currency: 'jpy',
      amount_total: amountTotal,
      total_details: { amount_discount: amountDiscount },
      metadata: { session_id: 'sess-abc', draft_id: 'draft-discount', selected_payment_method: 'stripe_card' },
      payment_intent: paymentIntent,
    });

    mockRpc.mockResolvedValue({ data: [{ order_id: 'order-discount', order_status: 'paid' }], error: null });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
  });

  test('割引後の実請求額と割引額を下書きへ書き戻す', async () => {
    setupDiscountedSession();

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect((res as { status: number }).status).toBe(200);
    expect(draftsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ total_amount: 5000, discount_amount: 500 })
    );
  });

  test('注文確定は割引後の額で呼ぶ', async () => {
    setupDiscountedSession();

    await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_order_from_checkout_draft',
      expect.objectContaining({ _expected_total_amount: 5000 })
    );
  });

  test('書き戻しに失敗したら注文を作らず 500 を返し、監査ログに残す', async () => {
    setupDiscountedSession({ updateError: { message: "column 'discount_amount' does not exist" } });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect((res as { status: number }).status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'error',
        detail: expect.stringContaining('discount'),
      })
    );
  });

  test('合計が 0 になる割引は、理由を明示して断る', async () => {
    setupDiscountedSession({
      amountTotal: 0,
      amountDiscount: 5500,
      paymentIntent: null,
      paymentStatus: 'no_payment_required',
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect((res as { status: number }).status).toBe(400);
    expect((res as unknown as { body: { error: string } }).body.error).toBe(
      'Zero-amount checkout is not supported'
    );
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.complete',
        outcome: 'failure',
        detail: 'Zero-amount checkout session is not supported',
      })
    );
  });

  /**
   * 同期は2回目以降も通らなければならない（FREQ-394）。
   *
   * 下書きの合計は同期で割引後へ書き換わるので、割引後の額を「割引前の合計」と比べる形にすると
   * 2回目が必ず外れる。webhook が先に注文を作った場合と、確定に失敗して客が再試行した場合の
   * 両方で起きる。比べるのは割引前どうし（下書きの合計＋割引額 と Stripe の請求額＋割引額）。
   */
  test('webhook が先に注文を作った後に呼ばれても、既存の注文を返す', async () => {
    setupDiscountedSession({
      draftTotal: 5000,
      draftDiscount: 500,
      existingOrder: { id: 'order-existing', user_id: null, status: 'paid' },
    });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect((res as { status: number }).status).toBe(200);
    expect((res as unknown as { body: { orderId: string } }).body.orderId).toBe('order-existing');
  });

  test('確定に失敗した後に再試行しても、割引後の額で注文確定を呼べる', async () => {
    setupDiscountedSession({ draftTotal: 5000, draftDiscount: 500 });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect((res as { status: number }).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_order_from_checkout_draft',
      expect.objectContaining({ _expected_total_amount: 5000 })
    );
  });

  test('下書きの合計が Stripe の請求額と食い違うときは注文を作らない', async () => {
    setupDiscountedSession({ draftTotal: 9000, draftDiscount: 0 });

    const res = await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    expect((res as { status: number }).status).toBe(400);
    expect((res as unknown as { body: { error: string } }).body.error).toBe(
      'Checkout session amount does not match draft total'
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('既存の注文が見つかったら、下書きの割引の書き戻しはしない', async () => {
    setupDiscountedSession({
      existingOrder: { id: 'order-existing', user_id: null, status: 'paid' },
    });

    await POST(makeRequest({ checkoutSessionId: 'cs_discount' }));

    const discountSyncCall = draftsUpdate.mock.calls.find(
      (args) => args[0] && typeof args[0] === 'object' && 'discount_amount' in args[0]
    );
    expect(discountSyncCall).toBeUndefined();
  });
});
