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
const mockSingle = jest.fn();
const mockMaybeSingle = jest.fn();
const mockInsert = jest.fn().mockReturnThis();
const mockSelect = jest.fn().mockReturnThis();
const mockEq = jest.fn().mockReturnThis();
const mockIn = jest.fn().mockReturnThis();
const mockDelete = jest.fn().mockReturnThis();

const mockFrom = jest.fn().mockReturnValue({
  select: mockSelect,
  insert: mockInsert,
  delete: mockDelete,
  eq: mockEq,
  in: mockIn,
  single: mockSingle,
  maybeSingle: mockMaybeSingle,
});

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom }),
}));

// ── Stripe サーバークライアント モック ──────────────────────────
const mockRetrieve = jest.fn();
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    paymentIntents: { retrieve: mockRetrieve },
  }),
}));

import { POST } from '@/app/api/checkout/complete/route';

// ── ヘルパー ────────────────────────────────────────────────────
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
const itemsData = [{ id: 1, name: 'テストシャツ', price: 5000, image_url: null }];
const createdOrder = { id: 'order-uuid', status: 'paid' };

function setupSuccessSupabase() {
  // carts.select().eq() → cart rows
  // items.select().in() → item rows
  // orders.select().eq().maybeSingle() → null (no existing order)
  // orders.insert().select().single() → createdOrder
  // order_items.insert() → success
  // carts.delete().eq() → success
  mockFrom.mockImplementation((table: string) => {
    const chain: Record<string, jest.Mock> = {
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn(),
      single: jest.fn(),
      maybeSingle: jest.fn(),
    };

    if (table === 'carts') {
      // carts.select().eq() → returns wrapped promise
      chain.eq.mockImplementation(() =>
        chain.delete.mock.calls.length > 0
          ? Promise.resolve({ data: null, error: null })  // delete path
          : Promise.resolve({ data: cartData, error: null })
      );
      // For delete().eq()
      chain.delete.mockImplementation(() => ({
        eq: jest.fn().mockResolvedValue({ data: null, error: null }),
      }));
      chain.select.mockReturnValue(chain);
    }

    if (table === 'items') {
      chain.in.mockResolvedValue({ data: itemsData, error: null });
      chain.select.mockReturnValue(chain);
    }

    if (table === 'orders') {
      chain.maybeSingle.mockResolvedValue({ data: null, error: null });
      chain.single.mockResolvedValue({ data: createdOrder, error: null });
      chain.select.mockReturnThis();
      chain.eq.mockReturnThis();
      chain.insert.mockReturnThis();
    }

    if (table === 'order_items') {
      chain.insert.mockResolvedValue({ data: null, error: null });
    }

    return chain;
  });
}

// ── テスト ──────────────────────────────────────────────────────
describe('POST /api/checkout/complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('セッション検証', () => {
    it('session_id Cookie がない場合 400 を返す', async () => {
      const req = makeRequest({ paymentMethod: 'bank' }, '');
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });
  });

  describe('リクエストボディ検証', () => {
    it('不正な paymentMethod は 400 を返す', async () => {
      const req = makeRequest({ paymentMethod: 'invalid_method' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });

    it('Stripe系で paymentIntentId なしは 400 を返す', async () => {
      const req = makeRequest({ paymentMethod: 'stripe_card' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });
  });

  describe('銀行振り込み', () => {
    it('bank → pending ステータスで注文を作成できる（paymentIntentId 不要）', async () => {
      setupSuccessSupabase();
      // carts 取得パスを単純化のためにモック
      mockFrom.mockImplementation((table: string) => {
        if (table === 'carts') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: cartData, error: null }),
            }),
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        if (table === 'items') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockResolvedValue({ data: itemsData, error: null }),
            }),
          };
        }
        if (table === 'orders') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({ data: { id: 'order-bank', status: 'pending' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'order_items') {
          return {
            insert: jest.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      });

      const req = makeRequest({ paymentMethod: 'bank', shipping: { email: 'test@example.com' } });
      const res = await POST(req);

      expect((res as { status: number }).status).toBe(200);
      expect((res as unknown as { body: { paymentMethod: string } }).body.paymentMethod).toBe('bank');
    });
  });

  describe('代金引換', () => {
    it('cod → pending ステータスで注文を作成できる', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'carts') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: cartData, error: null }),
            }),
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        if (table === 'items') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockResolvedValue({ data: itemsData, error: null }),
            }),
          };
        }
        if (table === 'orders') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({ data: { id: 'order-cod', status: 'pending' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'order_items') {
          return { insert: jest.fn().mockResolvedValue({ data: null, error: null }) };
        }
        return {};
      });

      const res = await POST(makeRequest({ paymentMethod: 'cod' }));
      expect((res as { status: number }).status).toBe(200);
      expect((res as unknown as { body: { paymentMethod: string } }).body.paymentMethod).toBe('cod');
    });
  });

  describe.each([
    ['stripe_card', 'クレジットカード（VISA/Mastercard/JCB/AMEX）'],
    ['stripe_paypay', 'PayPay'],
    ['stripe_konbini', 'コンビニ決済'],
  ])('Stripe オンライン決済 - %s (%s)', (method) => {
    it(`${method} → Stripe PaymentIntent を照合して paid で注文を作成する`, async () => {
      mockRetrieve.mockResolvedValueOnce({
        id: 'pi_stripe',
        status: 'succeeded',
        metadata: { session_id: 'sess-abc' },
      });

      mockFrom.mockImplementation((table: string) => {
        if (table === 'orders') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: { id: 'order-stripe', status: 'paid' },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'carts') {
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: cartData, error: null }),
            }),
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        if (table === 'items') {
          return {
            select: jest.fn().mockReturnValue({
              in: jest.fn().mockResolvedValue({ data: itemsData, error: null }),
            }),
          };
        }
        if (table === 'order_items') {
          return { insert: jest.fn().mockResolvedValue({ data: null, error: null }) };
        }
        return {};
      });

      const res = await POST(
        makeRequest({ paymentMethod: method, paymentIntentId: 'pi_stripe' })
      );

      expect((res as { status: number }).status).toBe(200);
      expect((res as unknown as { body: { paymentMethod: string } }).body.paymentMethod).toBe(method);
    });
  });

  describe('二重注文防止（idempotency）', () => {
    it('同一 paymentIntentId の注文が既存の場合は既存注文を返す', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'orders') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'existing-order', status: 'paid' },
              error: null,
            }),
          };
        }
        return {};
      });

      const res = await POST(
        makeRequest({ paymentMethod: 'stripe_card', paymentIntentId: 'pi_existing' })
      );
      expect((res as { status: number }).status).toBe(200);
      expect((res as unknown as { body: { orderId: string } }).body.orderId).toBe('existing-order');
    });
  });

  describe('削除済み決済方式', () => {
    it('stripe_apple_pay は 400 を返す', async () => {
      const req = makeRequest({ paymentMethod: 'stripe_apple_pay', paymentIntentId: 'pi_removed' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });

    it('stripe_google_pay は 400 を返す', async () => {
      const req = makeRequest({ paymentMethod: 'stripe_google_pay', paymentIntentId: 'pi_removed' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });

    it('stripe_other は 400 を返す', async () => {
      const req = makeRequest({ paymentMethod: 'stripe_other', paymentIntentId: 'pi_removed' });
      const res = await POST(req);
      expect((res as { status: number }).status).toBe(400);
    });
  });
});
