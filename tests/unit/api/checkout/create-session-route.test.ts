import { NextRequest } from 'next/server';

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

const mockEq = jest.fn();
const mockIn = jest.fn();
const mockItemsStatusEq = jest.fn();
const mockSelect = jest.fn().mockReturnThis();
const mockDraftDeleteEq = jest.fn().mockResolvedValue({ data: null, error: null });
const mockDraftUpdateEq = jest.fn().mockResolvedValue({ data: null, error: null });
const mockDraftItemsInsert = jest.fn().mockResolvedValue({ data: null, error: null });
const mockDraftInsertSingle = jest.fn().mockResolvedValue({
  data: {
    id: 'draft-123',
    session_id: 'sess-abc',
    total_amount: 5500,
    currency: 'jpy',
  },
  error: null,
});
const mockFrom = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRequireCsrfOrDeny = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: () => mockRequireCsrfOrDeny(),
}));

const mockCreate = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    checkout: {
      sessions: {
        create: mockCreate,
      },
    },
  }),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { POST } from '@/app/api/checkout/create-session/route';

function makeRequest(body: Record<string, unknown>, sessionId = 'sess-abc'): NextRequest {
  const requestBody = {
    displayedAmounts: {
      subtotalAmount: 5000,
      taxAmount: 500,
      shippingAmount: 0,
      totalAmount: 5500,
    },
    ...body,
  };

  const req = new NextRequest('http://localhost/api/checkout/create-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' ? { value: sessionId } : undefined) },
  });
  return req;
}

describe('POST /api/checkout/create-session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRequireCsrfOrDeny.mockResolvedValue(undefined);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'carts') {
        return {
          select: jest.fn().mockReturnValue({
            eq: mockEq,
          }),
        };
      }

      if (table === 'items') {
        return {
          select: jest.fn().mockReturnValue({
            in: mockIn,
          }),
        };
      }

      if (table === 'checkout_drafts') {
        return {
          insert: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              single: mockDraftInsertSingle,
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: mockDraftUpdateEq,
          }),
          delete: jest.fn().mockReturnValue({
            eq: mockDraftDeleteEq,
          }),
        };
      }

      if (table === 'checkout_draft_items') {
        return {
          insert: mockDraftItemsInsert,
        };
      }

      return { select: mockSelect, eq: mockEq, in: mockIn };
    });

    mockEq.mockResolvedValue({ data: [{ item_id: 1, quantity: 1, color: 'BLACK', size: 'M' }], error: null });
    mockIn.mockReturnValue({ eq: mockItemsStatusEq });
    mockItemsStatusEq.mockResolvedValue({
      data: [{ id: 1, name: 'テスト商品', price: 5000, image_url: null, stock_quantity: 10, status: 'published' }],
      error: null,
    });
  });

  it('paymentMethod 未指定なら payment_method_types を送信しない', async () => {
    mockCreate.mockResolvedValue({ client_secret: 'secret', id: 'cs_test' });

    const req = makeRequest({ uiMode: 'custom' });
    const res = await POST(req);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect((mockCreate.mock.calls[0][0] as Record<string, unknown>)).not.toHaveProperty('payment_method_types');
    expect((mockCreate.mock.calls[0][0] as { metadata: { draft_id: string } }).metadata.draft_id).toBe('draft-123');
    expect((res as { status: number }).status).toBe(200);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'checkout:create-session' })
    );
  });

  it('stripe_card 指定時は card の payment_method_types を送信する', async () => {
    mockCreate.mockResolvedValue({ url: 'https://stripe.com/checkout' });

    const req = makeRequest({ paymentMethod: 'stripe_card', uiMode: 'hosted' });
    const res = await POST(req);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect((mockCreate.mock.calls[0][0] as Record<string, unknown>).payment_method_types).toEqual(['card']);
    expect(mockDraftItemsInsert).toHaveBeenCalled();
    expect((res as { status: number }).status).toBe(200);
  });

  it('在庫数量を超える場合は 409 を返す', async () => {
    mockEq.mockResolvedValue({ data: [{ item_id: 1, quantity: 2, color: 'BLACK', size: 'M' }], error: null });
    mockItemsStatusEq.mockResolvedValue({
      data: [{ id: 1, name: 'テスト商品', price: 5000, image_url: null, stock_quantity: 1, status: 'published' }],
      error: null,
    });

    const req = makeRequest({ paymentMethod: 'stripe_card', uiMode: 'custom' });
    const res = await POST(req);

    expect((res as { status: number }).status).toBe(409);
    expect((res as { body: { error: string } }).body.error).toBe('out_of_stock');
  });

  it('items 取得時に status=published を必須化する', async () => {
    mockCreate.mockResolvedValue({ client_secret: 'secret', id: 'cs_test' });

    const req = makeRequest({ uiMode: 'custom' });
    const res = await POST(req);

    expect(mockIn).toHaveBeenCalledWith('id', [1]);
    expect(mockItemsStatusEq).toHaveBeenCalledWith('status', 'published');
    expect((res as { status: number }).status).toBe(200);
  });

  it('shipping.phone が不正な形式の場合は 400 を返す', async () => {
    const req = makeRequest({
      uiMode: 'custom',
      shipping: {
        phone: 'abc###',
      },
    });

    const res = await POST(req);

    expect((res as { status: number }).status).toBe(400);
    expect((res as { body: { error: string } }).body.error).toBe('Invalid request body');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
