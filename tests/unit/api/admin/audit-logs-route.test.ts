export {};

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, _body: body }),
  },
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { logAudit } = require('@/lib/audit');
const { GET } = require('@/app/api/admin/audit-logs/route');

const SAFE_COLUMNS = 'id,created_at,action,actor_id,resource,resource_id,outcome,detail';

function buildClient(result: { data: unknown; error: unknown }) {
  const limit = jest.fn().mockResolvedValue(result);
  const order = jest.fn().mockReturnValue({ limit });
  const select = jest.fn().mockReturnValue({ order });
  const from = jest.fn().mockReturnValue({ select });
  return { client: { from }, from, select, order, limit };
}

describe('GET /api/admin/audit-logs', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-004 認可が ok:false の時は認可の応答をそのまま返し、service role の client を作らない', async () => {
    const denied = { status: 403, _body: { error: 'Forbidden' } };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });
    const req = new Request('http://localhost/api/admin/audit-logs');

    const res = await GET(req);

    expect(res).toBe(denied);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.audit.read', req);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-004 成功の時は8列だけを選び、作成時刻の降順で100件まで読み 200 で data を返す', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'u1', role: 'admin', actorEmail: null });
    const rows = [{ id: '1', action: 'login' }, { id: '2', action: 'logout' }];
    const { client, from, select, order, limit } = buildClient({ data: rows, error: null });
    createServiceRoleClient.mockResolvedValue(client);

    const res = await GET(new Request('http://localhost/api/admin/audit-logs'));

    expect(from).toHaveBeenCalledWith('audit_logs');
    expect(select).toHaveBeenCalledWith(SAFE_COLUMNS);
    expect(select.mock.calls[0][0]).not.toMatch(/actor_email|ip|user_agent|metadata/);
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(limit).toHaveBeenCalledWith(100);
    expect(res.status).toBe(200);
    expect(res._body).toEqual({ data: rows });
  });

  it('DD-ADMIN-004 読みが誤りを返した時は記録して 500 Failed to fetch audit logs を返す', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'u1', role: 'admin', actorEmail: null });
    const dbError = { message: 'db down' };
    const { client } = buildClient({ data: null, error: dbError });
    createServiceRoleClient.mockResolvedValue(client);

    const res = await GET(new Request('http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to fetch audit logs' });
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch audit logs:', dbError);
  });

  it('DD-ADMIN-004 service role の client の作成が例外を投げた時は 500 Internal server error を返す', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'u1', role: 'admin', actorEmail: null });
    createServiceRoleClient.mockRejectedValue(new Error('no key'));

    const res = await GET(new Request('http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalledWith('Audit logs GET error:', expect.any(Error));
  });

  it('DD-ADMIN-004 200 の後に監査ログを読んだ記録を1行残し、ログの中身を入れず、読んだ人の IP とブラウザの名乗りを入れる（SEC-ADMIN-023-AC-02）', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'u1', role: 'admin', actorEmail: 'owner@example.com' });
    const { client } = buildClient({ data: [{ id: '1', action: 'secret-action' }], error: null });
    createServiceRoleClient.mockResolvedValue(client);

    const res = await GET(
      new Request('http://localhost/api/admin/audit-logs', {
        headers: { 'x-real-ip': '198.51.100.7', 'user-agent': 'jest-agent' },
      }),
    );

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.audit_logs.read',
      actor_id: 'u1',
      actor_email: 'owner@example.com',
      resource: 'audit_logs',
      outcome: 'success',
      ip: '198.51.100.7',
      user_agent: 'jest-agent',
    });
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('secret-action');
  });

  it('DD-ADMIN-004 認可で断った時と読みが誤りの時は、読んだ記録を書かない', async () => {
    authorizeAdminPermission.mockResolvedValueOnce({ ok: false, response: { status: 403, _body: {} } });
    await GET(new Request('http://localhost/api/admin/audit-logs'));
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'u1', role: 'admin', actorEmail: null });
    createServiceRoleClient.mockResolvedValue(buildClient({ data: null, error: { message: 'db down' } }).client);
    await GET(new Request('http://localhost/api/admin/audit-logs'));

    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-004 監査の記録が例外を投げても 200 で返す（読み出しを止めない）', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: 'u1', role: 'admin', actorEmail: null });
    const rows = [{ id: '1', action: 'login' }];
    createServiceRoleClient.mockResolvedValue(buildClient({ data: rows, error: null }).client);
    logAudit.mockRejectedValue(new Error('audit down'));

    const res = await GET(new Request('http://localhost/api/admin/audit-logs'));

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ data: rows });
    expect(errorSpy).toHaveBeenCalledWith('Failed to write audit log read audit');
  });
});
