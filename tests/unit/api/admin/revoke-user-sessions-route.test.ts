export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
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

import { POST } from '@/app/api/admin/revoke-user-sessions/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');

const eq = jest.fn();
const update = jest.fn();
const from = jest.fn();
const rpc = jest.fn();

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/revoke-user-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const actor = {
  action: 'admin_revoke_user_sessions',
  actor_id: 'admin-1',
  actor_email: 'admin@example.com',
  resource: 'sessions',
};

describe('POST /api/admin/revoke-user-sessions', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    authorizeAdminPermission.mockReset();
    rpc.mockReset();
    eq.mockReset().mockResolvedValue({ error: null });
    update.mockReset().mockReturnValue({ eq });
    from.mockReset().mockReturnValue({ update });
    createServiceRoleClient.mockResolvedValue({ from, rpc });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    authorizeAdminPermission.mockResolvedValue({
      ok: true,
      userId: 'admin-1',
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
    rpc.mockResolvedValue({ data: 2, error: null });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-003 認可に失敗した時は、操作した人を空にして unauthorized を IP とブラウザの情報付きで監査に書き、認可の応答を返す', async () => {
    const response = { status: 401, json: async () => ({ error: 'Unauthorized' }) };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response });

    const res = await POST(
      makeRequest({ user_id: 'u-1' }, { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1', 'user-agent': 'jest-agent' }),
    );

    expect(res).toBe(response);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', expect.any(Request));
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin_revoke_user_sessions',
      actor_id: null,
      actor_email: null,
      resource: 'sessions',
      outcome: 'unauthorized',
      detail: 'Unauthorized access to revoke user sessions',
      ip: '203.0.113.7',
      user_agent: 'jest-agent',
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-003 認可の部品の 503 も同じ記録になる', async () => {
    const response = { status: 503, json: async () => ({ error: 'Service unavailable' }) };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response });

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(503);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unauthorized', actor_id: null }));
  });

  it('DD-ADMIN-003 x-forwarded-for と user-agent が無い時は IP とブラウザの情報を空で監査に書く', async () => {
    const response = { status: 401, json: async () => ({}) };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response });

    await POST(makeRequest({ user_id: 'u-1' }));

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: null, user_agent: null }));
  });

  it('DD-ADMIN-003 本文が JSON でない時は 500 Internal server error で、監査を書かない', async () => {
    const res = await POST(makeRequest('{not json'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-003 user_id が空の時は 400 で、failure を IP とブラウザの情報付きで監査に書く', async () => {
    const res = await POST(
      makeRequest({ user_id: '' }, { 'x-forwarded-for': '198.51.100.2', 'user-agent': 'jest-agent' }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(logAudit).toHaveBeenCalledWith({
      ...actor,
      outcome: 'failure',
      detail: 'Invalid request body',
      ip: '198.51.100.2',
      user_agent: 'jest-agent',
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-003 user_id が無い時は 400', async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-003 成功した時は sessions に失効の時刻を入れ、関数で Auth の session を消し、success と消した数を監査に書いて 200', async () => {
    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith('sessions');
    const patch = update.mock.calls[0][0];
    expect(Number.isNaN(Date.parse(patch.revoked_at))).toBe(false);
    expect(eq).toHaveBeenCalledWith('user_id', 'u-1');
    expect(rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'u-1' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      ...actor,
      resource_id: 'u-1',
      outcome: 'success',
      metadata: { auth_sessions_deleted: 2 },
    });
  });

  it('DD-ADMIN-003 関数の返りが空なら消した数を 0 として監査に書く', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', metadata: { auth_sessions_deleted: 0 } }),
    );
  });

  it('DD-ADMIN-003 自前の表の更新が誤りを返しても見ずに進み、Auth の側が消せれば 200', async () => {
    eq.mockResolvedValue({ error: { message: 'update failed' } });

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('DD-ADMIN-003 関数が誤りを返した時は error と auth_session_revocation_failed を監査に書き、500 Failed to revoke sessions', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } });

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to revoke sessions' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      ...actor,
      resource_id: 'u-1',
      outcome: 'error',
      detail: 'auth_session_revocation_failed',
    });
  });

  it('DD-ADMIN-003 DB の client の作成で例外が出た時は error と例外の文を監査に書き、500 Failed to revoke sessions', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no service role'));

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to revoke sessions' });
    expect(logAudit).toHaveBeenCalledWith({
      ...actor,
      resource_id: 'u-1',
      outcome: 'error',
      detail: 'Error: no service role',
    });
  });

  it('DD-ADMIN-003 sessions の更新で例外が出た時は error と例外の文を監査に書き、500 Failed to revoke sessions', async () => {
    eq.mockRejectedValue(new Error('update threw'));

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'Error: update threw', resource_id: 'u-1' }),
    );
  });

  it('DD-ADMIN-003 関数の呼び出しで例外が出た時は error と例外の文を監査に書き、500 Failed to revoke sessions', async () => {
    rpc.mockRejectedValue(new Error('rpc threw'));

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to revoke sessions' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'Error: rpc threw' }),
    );
  });

  it('DD-ADMIN-003 認可の部品が例外を投げた時は 500 Internal server error', async () => {
    authorizeAdminPermission.mockRejectedValue(new Error('rbac down'));

    const res = await POST(makeRequest({ user_id: 'u-1' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-003 自分自身や存在しない利用者でも断らず、関数が 0 を返せば 200', async () => {
    rpc.mockResolvedValue({ data: 0, error: null });

    const res = await POST(makeRequest({ user_id: 'admin-1' }));

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', metadata: { auth_sessions_deleted: 0 } }),
    );
  });
});
