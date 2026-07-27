export {};

// 認可は ADMIN_API_KEY ヘッダーから DB の ACL（authorizeAdminPermission）へ移行済み。
// このテストは RBAC をモックし、権限の可否ごとの振る舞いと監査ログを検証する。

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

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

let revokeHandler: any;
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/admin/revoke-user-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function allowAdmin() {
  authorizeAdminPermission.mockResolvedValue({
    ok: true,
    userId: 'admin-1',
    role: 'admin',
    actorEmail: 'admin@example.com',
  });
}

function denyAdmin() {
  // 実装は authResult.response をそのまま返すので、モック側で 401 を用意する。
  authorizeAdminPermission.mockResolvedValue({
    ok: false,
    response: { status: 401, json: async () => ({ error: 'Unauthorized' }) },
  });
}

describe('Admin revoke-user-sessions API (mocked supabase & audit)', () => {
  beforeAll(() => {
    revokeHandler = require('@/app/api/admin/revoke-user-sessions/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('権限が無ければ認可側のレスポンスを返し unauthorized を監査へ残す', async () => {
    denyAdmin();

    const res: any = await revokeHandler(makeRequest({ user_id: 'u1' }));

    expect(res.status).toBe(401);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', expect.any(Request));
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_revoke_user_sessions', outcome: 'unauthorized' }),
    );
  });

  test('権限があればセッションを失効させ success を監査へ残す', async () => {
    allowAdmin();

    const eqMock = jest.fn().mockResolvedValue({});
    const updateMock = jest.fn().mockReturnValue({ eq: eqMock });
    const fromMock = jest.fn(() => ({ update: updateMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockResolvedValue({ from: fromMock });

    const res: any = await revokeHandler(makeRequest({ user_id: 'u1' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(fromMock).toHaveBeenCalledWith('sessions');
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: expect.any(String) }),
    );
    expect(eqMock).toHaveBeenCalledWith('user_id', 'u1');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_revoke_user_sessions',
        outcome: 'success',
        resource_id: 'u1',
        actor_id: 'admin-1',
      }),
    );
  });

  test('リクエストボディが不正なら400を返す', async () => {
    allowAdmin();

    const res: any = await revokeHandler(makeRequest({}));

    expect(res.status).toBe(400);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_revoke_user_sessions', outcome: 'failure' }),
    );
  });

  test('DB エラーなら500を返し error を監査へ残す', async () => {
    allowAdmin();

    const updateMock = jest.fn(() => { throw new Error('db fail'); });
    const fromMock = jest.fn(() => ({ update: updateMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockResolvedValue({ from: fromMock });

    const res: any = await revokeHandler(makeRequest({ user_id: 'u2' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBeDefined();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_revoke_user_sessions', outcome: 'error' }),
    );
  });
});
