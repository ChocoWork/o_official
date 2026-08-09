export {};
const authorizeMock = jest.fn();
const createClientMock = jest.fn();
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
  status: init?.status ?? 200, headers: new Map(Object.entries(init?.headers ?? {})), json: async () => body,
}) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: (...args: unknown[]) => authorizeMock(...args) }));
jest.mock('@/lib/supabase/server', () => ({ createClient: (...args: unknown[]) => createClientMock(...args) }));

it('returns latest daily and restore health without sensitive paths', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-10T00:00:00.000Z'));
  authorizeMock.mockResolvedValue({ ok: true });
  const daily = query({ completed_at: '2026-08-09T12:00:00.000Z', storage_targets: ['supabase'] });
  const restore = query({ completed_at: '2026-08-01T12:00:00.000Z' });
  createClientMock.mockResolvedValue({ from: jest.fn().mockReturnValueOnce(daily).mockReturnValueOnce(restore) });
  const { GET } = await import('@/app/api/admin/legal-archive/status/route');
  const response = await GET(new Request('http://localhost/api/admin/legal-archive/status?year=2026'));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(body.data).toEqual(expect.objectContaining({ fiscalYear: 2026, delayed: false, externalStorageConfigured: false }));
  expect(JSON.stringify(body)).not.toMatch(/manifest|sha256|error_code/);
  expect(authorizeMock).toHaveBeenCalledWith('admin.finance.read', expect.any(Request));
  jest.useRealTimers();
});

function query(data: unknown) {
  return {
    select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
  };
}
