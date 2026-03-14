import { NextRequest } from 'next/server';

// ── NextResponse モック ─────────────────────────────────────────
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn(
        (body: unknown, init?: { status?: number }) => ({
          body,
          status: init?.status ?? 200,
        })
      ),
    },
  };
});

// ── Supabase モック ─────────────────────────────────────────────
const mockSupabaseChain = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  in: jest.fn().mockReturnThis(),
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue(mockSupabaseChain),
  }),
}));

// ── Stripe サーバークライアント モック ──────────────────────────
const mockCreate = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    paymentIntents: { create: mockCreate },
  }),
}));

// ── ルートのインポート（モック登録後） ──────────────────────────
import { POST } from '@/app/api/checkout/payment-intent/route';

// ── ヘルパー: NextRequest を生成 ────────────────────────────────
function makeRequest(body: Record<string, unknown>, sessionId = 'test-session'): NextRequest {
  const req = new NextRequest('http://localhost/api/checkout/payment-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, 'cookies', {
    value: {
      get: (name: string) =>
        name === 'session_id' ? { value: sessionId } : undefined,
    },
  });
  return req;
}

// ── カート・商品データのデフォルトセット ────────────────────────
const defaultCartData = [{ item_id: 1, quantity: 2 }];
const defaultItemsData = [{ id: 1, price: 3000 }];
// subtotal = 6000, shipping = 500, total = 6500

function setupSupabaseMock(
  cartData: unknown = defaultCartData,
  itemsData: unknown = defaultItemsData
) {
  let callCount = 0;
  mockSupabaseChain.eq.mockImplementation(function (this: unknown) {
    callCount++;
    if (callCount === 1) {
      // carts.select().eq() → cart rows
      return Promise.resolve({ data: cartData, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  mockSupabaseChain.in.mockResolvedValueOnce({ data: itemsData, error: null });
}

// ── テスト ──────────────────────────────────────────────────────
describe('POST /api/checkout/payment-intent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({
      id: 'pi_test',
      client_secret: 'pi_test_secret',
      status: 'requires_payment_method',
    });
  });

  describe('セッション検証', () => {
    it('session_id Cookie がない場合は 400 を返す', async () => {
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_card' }, '');
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });
  });

  describe('カード決済（クレジットカード・Mastercard / VISA / JCB / AMEX）', () => {
    it('stripe_card → payment_method_types: [card] で PaymentIntent を作成', async () => {
      setupSupabaseMock();
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_card' });
      const res = await POST(req);

      expect((res as { status: number }).status).toBe(200);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 6500,
          currency: 'jpy',
          payment_method_types: ['card'],
        }),
        expect.anything()
      );
    });
  });

  describe('ウォレット - PayPay', () => {
    it('stripe_paypay → payment_method_types: [paypay] で PaymentIntent を作成', async () => {
      setupSupabaseMock();
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_paypay' });
      const res = await POST(req);

      expect((res as { status: number }).status).toBe(200);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_method_types: ['paypay'],
        }),
        expect.anything()
      );
    });
  });

  describe('コンビニ決済', () => {
    it('stripe_konbini → payment_method_types: [konbini] で PaymentIntent を作成', async () => {
      setupSupabaseMock();
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_konbini' });
      const res = await POST(req);

      expect((res as { status: number }).status).toBe(200);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_method_types: ['konbini'],
        }),
        expect.anything()
      );
    });
  });

  describe('削除済み決済方式', () => {
    it('stripe_apple_pay は 400 を返す', async () => {
      setupSupabaseMock();
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_apple_pay' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });

    it('stripe_google_pay は 400 を返す', async () => {
      setupSupabaseMock();
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_google_pay' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });

    it('stripe_other は 400 を返す', async () => {
      setupSupabaseMock();
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_other' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });
  });

  describe('idempotency key', () => {
    it('同じ決済方法では同一キー → 方式が変わったらキーが変わる', async () => {
      // 1回目: stripe_card
      setupSupabaseMock();
      await POST(makeRequest({ currency: 'jpy', paymentMethod: 'stripe_card' }));
      const key1 = (mockCreate.mock.calls[0] as [unknown, { idempotencyKey: string }])[1]
        .idempotencyKey;

      // 2回目: stripe_paypay
      setupSupabaseMock();
      await POST(makeRequest({ currency: 'jpy', paymentMethod: 'stripe_paypay' }));
      const key2 = (mockCreate.mock.calls[1] as [unknown, { idempotencyKey: string }])[1]
        .idempotencyKey;

      expect(key1).not.toBe(key2);
      expect(key1).toContain('stripe_card');
      expect(key2).toContain('stripe_paypay');
    });
  });

  describe('カートが空の場合', () => {
    it('400 を返す', async () => {
      setupSupabaseMock([], defaultItemsData);
      const req = makeRequest({ currency: 'jpy', paymentMethod: 'stripe_card' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });
  });
});
