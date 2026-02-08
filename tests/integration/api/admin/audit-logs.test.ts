jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({ status: init?.status ?? 200, _body: body, json: async () => body }),
  },
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const handler = require('@/app/api/admin/audit-logs/route');

describe('Admin audit logs endpoint', () => {
  beforeEach(() => jest.resetAllMocks());

  test('returns 401 when no admin token', async () => {
    process.env.ADMIN_API_KEY = 'adm';
    const req = new Request('http://localhost/api/admin/audit-logs', { method: 'GET' });
    const res: any = await handler.GET(req);
    expect(res.status).toBe(401);
  });

  test('returns 200 with audit logs when authorized', async () => {
    process.env.ADMIN_API_KEY = 'adm';
    const fakeData = [{ id: '1', action: 'login' }];
    const fromMock = jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue({ data: fakeData, error: null }) });
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const req = new Request('http://localhost/api/admin/audit-logs', { method: 'GET', headers: { 'x-admin-token': 'adm' } } as any);
    const res: any = await handler.GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual(fakeData);
  });
});