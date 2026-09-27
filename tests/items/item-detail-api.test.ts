export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  // 画像URLの署名にサービスロールのクライアントを使う。
  createServiceRoleClient: jest.fn().mockResolvedValue({}),
}));

// 署名処理そのものはストレージ側の責務なので、ここでは素通しにする。
jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (_client: unknown, row: unknown) => row),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

// 在庫の単位は色 × サイズ（FREQ-400）。商品単位の在庫数は公開レスポンスに出さない。
const getItemAvailability = jest.fn();
jest.mock('@/lib/items/availability', () => ({
  getItemAvailability: (...args: unknown[]) => getItemAvailability(...args),
}));

const route = require('@/app/api/items/[id]/route');
const { createClient } = require('@/lib/supabase/server');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

describe('GET /api/items/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    getItemAvailability.mockResolvedValue({
      madeToOrder: false,
      combinations: [{ colorName: 'Black', sizeLabel: 'M', inStock: true }],
    });
  });

  test('公開レスポンスで色 × サイズの在庫を返し、商品単位の在庫数は返さない', async () => {
    const single = jest.fn().mockResolvedValue({
      data: {
        id: 101,
        name: 'Silk Blouse',
        description: 'desc',
        price: 12000,
        category: 'TOPS',
        image_url: '/images/1.jpg',
        image_urls: ['/images/1.jpg'],
        colors: [{ hex: '#000', name: 'Black' }],
        sizes: ['M'],
        product_details: ['Silk 100%'],
      },
      error: null,
    });

    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single,
    };

    createClient.mockResolvedValue({
      from: jest.fn().mockReturnValue(query),
    });

    const request = new Request('http://localhost/api/items/101');
    const response = await route.GET(request, {
      params: Promise.resolve({ id: '101' }),
    });

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stock_quantity).toBeUndefined();
    expect(body.madeToOrder).toBe(false);
    expect(body.variantAvailability).toEqual([
      { colorName: 'Black', sizeLabel: 'M', inStock: true },
    ]);
    expect(getItemAvailability).toHaveBeenCalledWith(101);
    expect(query.eq).toHaveBeenNthCalledWith(1, 'id', 101);
    expect(query.eq).toHaveBeenNthCalledWith(2, 'status', 'published');
  });

  test('不正な item id は 400 を返す', async () => {
    const request = new Request('http://localhost/api/items/invalid');
    const response = await route.GET(request, {
      params: Promise.resolve({ id: 'invalid' }),
    });

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid item id');
    expect(createClient).not.toHaveBeenCalled();
  });

  test('レート制限に到達した場合は 429 を返す', async () => {
    enforceRateLimit.mockResolvedValue({
      status: 429,
      json: async () => ({ error: 'Too many requests' }),
      // 実装は返す前に Cache-Control: no-store を付与する。
      headers: new Map<string, string>(),
    });

    const request = new Request('http://localhost/api/items/101');
    const response = await route.GET(request, {
      params: Promise.resolve({ id: '101' }),
    });

    expect(response.status).toBe(429);
    expect(createClient).not.toHaveBeenCalled();
  });
});
