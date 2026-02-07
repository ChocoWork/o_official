jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map(),
        cookies: {
          _cookies: [] as any[],
          set(c: any) { this._cookies.push(c); },
          get(name: string) { return this._cookies.find((c: any) => c.name === name); },
        },
      };
      return res;
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

let revokeHandler: any;
const { logAudit } = require('@/lib/audit');

describe('Admin revoke-user-sessions API (mocked supabase & audit)', () => {
  beforeAll(() => {
    revokeHandler = require('@/app/api/admin/revoke-user-sessions/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.ADMIN_API_KEY;
  });

  test('unauthorized without admin token returns 401 and logs audit', async () => {
    const req = new Request('http://localhost/api/admin/revoke-user-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 'u1' }) });
    const res: any = await revokeHandler(req);
    expect(res.status).toBe(401);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_revoke_user_sessions', outcome: 'unauthorized' }));
  });

  test('authorized revokes sessions and logs success', async () => {
    process.env.ADMIN_API_KEY = 'adm';
    const eqMock = jest.fn().mockResolvedValue({});
    const updateMock = jest.fn().mockReturnValue({ eq: eqMock });
    const fromMock = jest.fn((table: string) => ({ update: updateMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const req = new Request('http://localhost/api/admin/revoke-user-sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'adm' }, body: JSON.stringify({ user_id: 'u1' }) });

    const res: any = await revokeHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ revoked_at: expect.any(String) }));
    expect(eqMock).toHaveBeenCalledWith('user_id', 'u1');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_revoke_user_sessions', outcome: 'success', resource_id: 'u1' }));
  });

  test('DB error returns 500 and logs error', async () => {
    process.env.ADMIN_API_KEY = 'adm';
    const updateMock = jest.fn(() => { throw new Error('db fail'); });
    const fromMock = jest.fn((table: string) => ({ update: updateMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const req = new Request('http://localhost/api/admin/revoke-user-sessions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'adm' }, body: JSON.stringify({ user_id: 'u2' }) });

    const res: any = await revokeHandler(req);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_revoke_user_sessions', outcome: 'error' }));
  });
});