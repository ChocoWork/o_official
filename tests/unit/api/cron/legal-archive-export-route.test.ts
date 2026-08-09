const createServiceRoleClientMock = jest.fn();
const fetchPageMock = jest.fn();

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      body,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => createServiceRoleClientMock(),
}));
jest.mock('@/lib/legal-archive/export-query', () => ({
  fetchLegalArchivePage: (...args: unknown[]) => fetchPageMock(...args),
}));

describe('GET /api/cron/legal-archive/export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LEGAL_ARCHIVE_CRON_SECRET = 'archive-secret';
    createServiceRoleClientMock.mockResolvedValue({ from: jest.fn() });
    fetchPageMock.mockResolvedValue({
      orders: [], orderItems: [], revisions: [], nextCursor: null,
      totals: { grossAmount: 0, refundedAmount: 0, netAmount: 0 },
    });
  });

  afterAll(() => delete process.env.LEGAL_ARCHIVE_CRON_SECRET);

  it.each([null, 'Bearer wrong'])('rejects authorization %p', async (authorization) => {
    const { GET } = await import('@/app/api/cron/legal-archive/export/route');
    const response = await GET(new Request('http://localhost/api/cron/legal-archive/export?year=2026', {
      headers: authorization ? { authorization } : undefined,
    }));
    expect(response.status).toBe(401);
  });

  it.each(['year=abc', 'year=1999', 'year=2026&pageSize=501'])(
    'rejects invalid query %s',
    async (query) => {
      const { GET } = await import('@/app/api/cron/legal-archive/export/route');
      const response = await GET(new Request(`http://localhost/api/cron/legal-archive/export?${query}`, {
        headers: { authorization: 'Bearer archive-secret' },
      }));
      expect(response.status).toBe(400);
    },
  );

  it('returns a protected no-store page', async () => {
    const { GET } = await import('@/app/api/cron/legal-archive/export/route');
    const response = await GET(new Request('http://localhost/api/cron/legal-archive/export?year=2026', {
      headers: { authorization: 'Bearer archive-secret' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchPageMock).toHaveBeenCalledWith(expect.objectContaining({ year: 2026, pageSize: 500 }));
  });

  it('returns a generic gateway error', async () => {
    fetchPageMock.mockRejectedValue(new Error('database details'));
    const { GET } = await import('@/app/api/cron/legal-archive/export/route');
    const response = await GET(new Request('http://localhost/api/cron/legal-archive/export?year=2026', {
      headers: { authorization: 'Bearer archive-secret' },
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Archive export unavailable' });
  });
});
