export {};

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
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.audit.read', req);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test('returns 403 without reading audit logs when the audit permission is denied', async () => {
    const deniedResponse = { status: 403, _body: { error: 'Forbidden', permission: 'admin.audit.read' } };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: deniedResponse });

    const req = new Request('http://localhost/api/admin/audit-logs', { method: 'GET' });
    const res = await handler.GET(req);

    expect(res).toBe(deniedResponse);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.audit.read', req);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
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
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.audit.read', req);
    expect(fromMock).toHaveBeenCalledWith('audit_logs');
  });
});
