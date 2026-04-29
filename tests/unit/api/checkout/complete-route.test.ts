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

const cartData = [{ item_id: 1, quantity: 1, color: 'BLACK', size: 'M' }];
const itemsData = [{ id: 1, name: 'テストシャツ', price: 5000, image_url: null, stock_quantity: 10, status: 'published' }];

function setupBaseSupabase(existingOrder: { id: string; status: string } | null = null) {
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
              },
              error: null,
            }),
          }),
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
    expect((res as { body: { orderId: string } }).body.orderId).toBe('existing-order');
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
    expect((res as { body: { error: string } }).body.error).toBe('out_of_stock');
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
    expect((res as { body: { error: string } }).body.error).toBe('item_not_published');
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
    expect((res as { body: { error: string } }).body.error).toBe('Invalid request body');
    expect(mockRetrieveCheckoutSession).not.toHaveBeenCalled();
  });
});
