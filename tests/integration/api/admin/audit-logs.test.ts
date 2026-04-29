jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({ status: init?.status ?? 200, _body: body, json: async () => body }),
  },
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const handler = require('@/app/api/admin/audit-logs/route');

describe('Admin audit logs endpoint', () => {
  beforeEach(() => jest.resetAllMocks());

  test('returns 401 when authorization fails', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: { status: 401, _body: { error: 'Unauthorized' } } });

    const req = new Request('http://localhost/api/admin/audit-logs', { method: 'GET' });
    const res: any = await handler.GET(req);

    expect(res.status).toBe(401);
    expect(res._body.error).toBe('Unauthorized');
  });

  test('returns 200 with audit logs when authorized', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'admin-user', role: 'admin', actorEmail: null });
    const fakeData = [{ id: '1', action: 'login' }];
    const fromMock = jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue({ data: fakeData, error: null }) });
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const req = new Request('http://localhost/api/admin/audit-logs', { method: 'GET' });
    const res: any = await handler.GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(fakeData);
  });
});