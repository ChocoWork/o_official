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
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

const route = require('@/app/api/items/[id]/route');
const { createClient } = require('@/lib/supabase/server');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

describe('GET /api/items/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
  });

  test('公開レスポンスで stockStatus のみ返し、stock_quantity は返さない', async () => {
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
        stock_quantity: 2,
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
    expect(body.stockStatus).toBe('low_stock');
    expect(body.stock_quantity).toBeUndefined();
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
    });

    const request = new Request('http://localhost/api/items/101');
    const response = await route.GET(request, {
      params: Promise.resolve({ id: '101' }),
    });

    expect(response.status).toBe(429);
    expect(createClient).not.toHaveBeenCalled();
  });
});
