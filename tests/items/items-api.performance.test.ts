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

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

describe('GET /api/items performance target', () => {
  test('P95 < 200ms', async () => {
    getPublishedItemsPage.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 12,
      total: 0,
      hasMore: false,
    });

    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const start = Date.now();
      const req = new Request('http://localhost/api/items?page=1&pageSize=12&sort=newest');
      await route.GET(req);
      samples.push(Date.now() - start);
    }

    expect(p95(samples)).toBeLessThan(200);
  });
});
