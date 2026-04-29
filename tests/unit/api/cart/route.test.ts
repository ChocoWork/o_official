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
const mockEnforceRateLimit = jest.fn();
const mockLogAudit = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom }),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { POST } from '@/app/api/cart/route';

function makeRequest(body: Record<string, unknown>, sessionId = 'sess-abc'): NextRequest {
  const req = new NextRequest('http://localhost/api/cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' ? { value: sessionId } : undefined) },
  });

  return req;
}

describe('POST /api/cart', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
  });

  test('同一商品の合計数量が在庫を超える場合は 409 を返す', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'items') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: 1, name: 'テスト商品', stock_quantity: 3, status: 'published' },
            error: null,
          }),
        };
      }

      if (table === 'carts') {
        const chain = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockImplementation((column: string) => {
            if (column === 'session_id') {
              return chain;
            }

            return Promise.resolve({
              data: [
                { id: 'cart-1', quantity: 2, color: 'BLACK', size: 'M' },
              ],
              error: null,
            });
          }),
        };

        return chain;
      }

      return {};
    });

    const res = await POST(makeRequest({ item_id: 1, quantity: 2, color: 'BLACK', size: 'L' }));

    expect((res as { status: number }).status).toBe(409);
    expect((res as { body: { error: string } }).body.error).toBe('insufficient_stock');
  });

  test('数量上限を超える場合は 400 を返す', async () => {
    const res = await POST(makeRequest({ item_id: 1, quantity: 999, color: 'BLACK', size: 'L' }));

    expect((res as { status: number }).status).toBe(400);
    expect((res as { body: { error: string } }).body.error).toBe('Invalid request body');
  });

  test('許容外文字を含む color/size は 400 を返す', async () => {
    const res = await POST(makeRequest({ item_id: 1, quantity: 1, color: '<script>', size: 'M' }));

    expect((res as { status: number }).status).toBe(400);
    expect((res as { body: { error: string } }).body.error).toBe('Invalid request body');
    expect(mockLogAudit).toHaveBeenCalled();
  });
});