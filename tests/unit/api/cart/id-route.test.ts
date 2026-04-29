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

const mockRpc = jest.fn();
const mockEnforceRateLimit = jest.fn();
const mockLogAudit = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn().mockResolvedValue({ rpc: mockRpc }),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { DELETE, PATCH } from '@/app/api/cart/[id]/route';

function makeRequest(body: Record<string, unknown>, sessionId = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/cart/cart-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' ? { value: sessionId } : undefined) },
  });

  return req;
}

describe('PATCH /api/cart/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
  });

  test('同一商品の合計数量が在庫を超える場合は 409 を返す', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INSUFFICIENT_STOCK:1:3:2' },
    });

    const res = await PATCH(makeRequest({ quantity: 3 }), {
      params: Promise.resolve({ id: 'cart-1' }),
    });

    expect((res as { status: number }).status).toBe(409);
    expect((res as { body: { error: string } }).body.error).toBe('insufficient_stock');
    expect(mockRpc).toHaveBeenCalledWith('update_cart_item_quantity_secure', {
      _cart_id: 'cart-1',
      _session_id: 'sess-abc',
      _quantity: 3,
    });
  });

  test('対象の cart が見つからない場合は 404 を返す', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'CART_ITEM_NOT_FOUND' },
    });

    const res = await PATCH(makeRequest({ quantity: 1 }), {
      params: Promise.resolve({ id: 'missing-id' }),
    });

    expect((res as { status: number }).status).toBe(404);
    expect((res as { body: { error: string } }).body.error).toBe('Cart item not found');
  });

  test('permission denied は 403 を返す', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for table carts' },
    });

    const res = await PATCH(makeRequest({ quantity: 1 }), {
      params: Promise.resolve({ id: 'cart-1' }),
    });

    expect((res as { status: number }).status).toBe(403);
    expect((res as { body: { error: string } }).body.error).toBe('Forbidden');
  });
});

describe('DELETE /api/cart/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
  });

  test('対象の cart が見つからない場合は 404 を返す', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'CART_ITEM_NOT_FOUND' },
    });

    const req = new NextRequest('http://localhost/api/cart/cart-1', {
      method: 'DELETE',
    });
    Object.defineProperty(req, 'cookies', {
      value: { get: (name: string) => (name === 'session_id' ? { value: 'sess-abc' } : undefined) },
    });

    const res = await DELETE(req, {
      params: Promise.resolve({ id: 'missing-id' }),
    });

    expect((res as { status: number }).status).toBe(404);
    expect(mockRpc).toHaveBeenCalledWith('delete_cart_item_secure', {
      _cart_id: 'missing-id',
      _session_id: 'sess-abc',
    });
  });
});