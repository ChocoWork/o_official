export {};

const createClientMock = jest.fn();
jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200, json: async () => body,
  }) },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: () => createClientMock() }));

describe('legal archive status route', () => {
  beforeEach(() => { process.env.LEGAL_ARCHIVE_CRON_SECRET = 'secret'; });
  afterAll(() => delete process.env.LEGAL_ARCHIVE_CRON_SECRET);

  it('rejects unauthenticated updates', async () => {
    const { POST } = await import('@/app/api/cron/legal-archive/status/route');
    const response = await POST(new Request('http://localhost', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401);
  });

  it('records a new running attempt', async () => {
    const read = {
      select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const write = { insert: jest.fn().mockResolvedValue({ error: null }) };
    createClientMock.mockResolvedValue({
      from: jest.fn().mockReturnValueOnce(read).mockReturnValueOnce(write),
    });
    const { POST } = await import('@/app/api/cron/legal-archive/status/route');
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        archiveDate: '2026-08-10', fiscalYear: 2026, runKind: 'daily',
        status: 'running', storageTargets: ['supabase'],
      }),
    }));
    expect(response.status).toBe(200);
    expect(write.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  });
});
