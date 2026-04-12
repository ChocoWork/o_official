jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/items/public', () => ({
  getPublishedItemsPage: jest.fn(),
}));

const route = require('@/app/api/items/route');
const { getPublishedItemsPage } = require('@/lib/items/public');

describe('GET /api/items', () => {
  beforeEach(() => {
    getPublishedItemsPage.mockReset();
  });

  test('フィルタ/ソート/ページング結果を返す', async () => {
    getPublishedItemsPage.mockResolvedValue({
      items: [
        {
          id: 1,
          name: 'Mock Item',
          category: 'TOPS',
          price: 12000,
          image_url: '/mock.png',
          product_details: { collection: 'SPRING' },
          colors: [{ name: 'BLACK', hex: '#000000' }],
          sizes: ['M'],
        },
      ],
      page: 1,
      pageSize: 12,
      total: 1,
      hasMore: false,
    });

    const req = new Request('http://localhost/api/items?category=TOPS&sort=price_asc&page=1&pageSize=12');
    const res = await route.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(12);
    expect(body.sort).toBe('price_asc');
    expect(getPublishedItemsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'TOPS',
        sort: 'price_asc',
        page: 1,
        pageSize: 12,
      }),
    );
  });
});
