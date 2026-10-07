import { NextRequest } from 'next/server';

jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 })),
    },
  };
});

const mockRpc = jest.fn();
const mockFrom = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({ from: (...args: unknown[]) => mockFrom(...args), rpc: (...args: unknown[]) => mockRpc(...args) }),
}));
jest.mock('@/lib/storage/item-images', () => ({ signItemImageUrl: async (_c: unknown, raw: string) => raw }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));

import { GET } from '@/app/api/cart/route';

function makeRequest(): NextRequest {
  const req = new NextRequest('http://localhost/api/cart');
  Object.defineProperty(req, 'cookies', {
    value: { get: (name: string) => (name === 'session_id' ? { value: 'sess-abc' } : undefined) },
  });
  return req;
}

const CART_ROWS = [
  { id: 'cart-1', item_id: 1, quantity: 1, color: 'BLACK', size: 'M', added_at: '2026-10-08T00:00:00Z' },
  { id: 'cart-2', item_id: 2, quantity: 3, color: 'NAVY', size: 'L', added_at: '2026-10-07T00:00:00Z' },
];
const ITEMS = [
  { id: 1, name: 'シャツ', price: 5000, image_url: 'a.png', category: 'TOPS', status: 'published' },
  { id: 2, name: 'パンツ', price: 8000, image_url: 'b.png', category: 'BOTTOMS', status: 'published' },
];

describe('GET /api/cart のお届けの目安（設計書 5-2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'carts') {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: CART_ROWS, error: null }) }) }) };
      }
      return { select: () => ({ in: () => ({ eq: () => Promise.resolve({ data: ITEMS, error: null }) }) }) };
    });
  });

  test('明細ごとに在庫あり・受注生産を付ける', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { line_no: 1, item_id: 1, color: 'BLACK', size: 'M', quantity: 1, variant_id: 11, fulfillment: 'stock' },
        { line_no: 2, item_id: 2, color: 'NAVY', size: 'L', quantity: 3, variant_id: 22, fulfillment: 'backorder' },
      ],
      error: null,
    });

    const res = (await GET(makeRequest())) as unknown as { body: Array<Record<string, unknown>> };

    expect(mockRpc).toHaveBeenCalledWith('preview_checkout_fulfillment', {
      _items_snapshot: [
        { item_id: 1, color: 'BLACK', size: 'M', quantity: 1 },
        { item_id: 2, color: 'NAVY', size: 'L', quantity: 3 },
      ],
    });
    expect(res.body.map((row) => [row.id, row.fulfillment])).toEqual([
      ['cart-1', 'stock'],
      ['cart-2', 'backorder'],
    ]);
  });

  test('目安を読めなくてもカートは返す（目安は null）', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = (await GET(makeRequest())) as unknown as { status: number; body: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(res.body.map((row) => row.fulfillment)).toEqual([null, null]);
  });
});
