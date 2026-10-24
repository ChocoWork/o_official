export {};

// 本物の認可（admin-rbac）と本物の監査（audit）を通し、外側の境界（トークンの検証・セッションの生存確認・
// service role の DB）だけを差し替える。窓口 → 認可 → 自前の表と Auth 側の失効 → 監査の鎖を一緒に確かめる。
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
  checkAuthSessionLiveness: jest.fn(),
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { POST } = require('@/app/api/admin/revoke-user-sessions/route');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '44444444-4444-4444-8444-444444444444';

let auditRows: any[];
let aclCodes: string[];
let sessionsUpdate: jest.Mock;
let sessionsEq: jest.Mock;
let rpc: jest.Mock;
let calls: string[];
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

function installServiceClient() {
  createServiceRoleClient.mockResolvedValue({
    rpc,
    from: (table: string) => {
      if (table === 'audit_logs') {
        return {
          insert: async (rows: any[]) => {
            auditRows.push(...rows);
            return { error: null };
          },
        };
      }
      if (table === 'user_roles') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          or: async () => ({
            data: [{ roles: { role_permissions: aclCodes.map((code) => ({ permissions: { code } })) } }],
            error: null,
          }),
        };
        return chain;
      }
      if (table === 'sessions') {
        return { update: sessionsUpdate };
      }
      throw new Error(`unexpected table ${table}`);
    },
  });
}

function signIn(claims: Record<string, unknown> = {}) {
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: ACTOR_ID, email: 'admin@example.com', aal: 'aal2', session_id: 's1', app_metadata: { role: 'admin' }, ...claims },
  });
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/revoke-user-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const clientHeaders = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'jest-agent' };

beforeEach(() => {
  jest.resetAllMocks();
  auditRows = [];
  calls = [];
  aclCodes = ['admin.users.manage'];
  sessionsEq = jest.fn().mockImplementation(async () => {
    calls.push('sessions.update');
    return {};
  });
  sessionsUpdate = jest.fn().mockReturnValue({ eq: sessionsEq });
  rpc = jest.fn().mockImplementation(async () => {
    calls.push('rpc');
    return { data: 2, error: null };
  });
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  installServiceClient();
  checkAuthSessionLiveness.mockResolvedValue('active');
  signIn();
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('POST /api/admin/revoke-user-sessions', () => {
  describe('認可', () => {
    test('API-ADMIN-002 トークンが通らなければ 401 を返し、操作した人を空にして unauthorized を IP とブラウザの情報付きで監査へ残す', async () => {
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'invalid' });

      const res = await POST(makeRequest({ user_id: TARGET_ID }, clientHeaders));

      expect(res.status).toBe(401);
      expect(sessionsUpdate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          action: 'admin_revoke_user_sessions',
          actor_id: null,
          actor_email: null,
          resource: 'sessions',
          outcome: 'unauthorized',
          detail: 'Unauthorized access to revoke user sessions',
          ip: '203.0.113.9',
          user_agent: 'jest-agent',
        }),
      );
    });

    test('API-ADMIN-002 admin.users.manage を持たない人は 403 で、失効させず unauthorized を監査へ残す', async () => {
      aclCodes = ['admin.users.read'];

      const res = await POST(makeRequest({ user_id: TARGET_ID }, clientHeaders));

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ error: 'Forbidden', permission: 'admin.users.manage' }));
      expect(sessionsUpdate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'unauthorized', actor_id: null }));
    });

    test('API-ADMIN-002 aal2 でなければ 403（MFA required）で、失効させず unauthorized を監査へ残す', async () => {
      signIn({ aal: 'aal1' });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ reason: 'MFA required' }));
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'unauthorized' }));
    });

    test('API-ADMIN-002 セッションの確認ができなければ 503 を返し、失効させず unauthorized を監査へ残す', async () => {
      checkAuthSessionLiveness.mockResolvedValue('unavailable');

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(503);
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'unauthorized' }));
    });

    test('API-ADMIN-002 IP とブラウザの情報が無い試みでも unauthorized の監査は空の値で残る', async () => {
      aclCodes = [];

      await POST(makeRequest({ user_id: TARGET_ID }));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].ip ?? null).toBeNull();
      expect(auditRows[0].user_agent ?? null).toBeNull();
    });
  });

  describe('入力の検証', () => {
    test.each([
      ['user_id が欠けている', {}],
      ['user_id が空文字である', { user_id: '' }],
      ['user_id が文字列でない', { user_id: 42 }],
      ['本文が null である', null],
    ])('API-ADMIN-002 %s時は 400 を返し、失効させずに failure を監査へ残す', async (_label, body) => {
      const res = await POST(makeRequest(body, clientHeaders));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'Invalid request' });
      expect(sessionsUpdate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          action: 'admin_revoke_user_sessions',
          actor_id: ACTOR_ID,
          actor_email: 'admin@example.com',
          outcome: 'failure',
          detail: 'Invalid request body',
          ip: '203.0.113.9',
          user_agent: 'jest-agent',
        }),
      );
    });

    test('API-ADMIN-002 user_id は UUID の形を見ず、1 字以上の文字列なら受け付ける', async () => {
      const res = await POST(makeRequest({ user_id: 'x' }));

      expect(res.status).toBe(200);
      expect(sessionsEq).toHaveBeenCalledWith('user_id', 'x');
      expect(rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'x' });
    });

    test('API-ADMIN-002 本文の JSON が壊れていれば 500 を返し、失効させない', async () => {
      const res = await POST(makeRequest('{broken'));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(sessionsUpdate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('失効', () => {
    test('API-ADMIN-002 自前の sessions を先に失効させ、続けて Auth 側の session を消して 200 を返す', async () => {
      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(200);
      expect(res._body).toEqual({ ok: true });
      expect(sessionsUpdate).toHaveBeenCalledWith({ revoked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
      expect(sessionsEq).toHaveBeenCalledWith('user_id', TARGET_ID);
      expect(rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: TARGET_ID });
      expect(calls).toEqual(['sessions.update', 'rpc']);
    });

    test('API-ADMIN-002 success を対象の id と消した Auth の session の数付きで監査へ残す', async () => {
      await POST(makeRequest({ user_id: TARGET_ID }, clientHeaders));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          action: 'admin_revoke_user_sessions',
          actor_id: ACTOR_ID,
          actor_email: 'admin@example.com',
          resource: 'sessions',
          resource_id: TARGET_ID,
          outcome: 'success',
          metadata: { auth_sessions_deleted: 2 },
        }),
      );
    });

    test('API-ADMIN-002 DB の関数が件数を返さない時は消した数を 0 として監査へ残す', async () => {
      rpc.mockResolvedValue({ data: null, error: null });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(200);
      expect(auditRows[0].metadata).toEqual({ auth_sessions_deleted: 0 });
    });

    test('API-ADMIN-002 自分自身の session も断らず失効させる', async () => {
      const res = await POST(makeRequest({ user_id: ACTOR_ID }));

      expect(res.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: ACTOR_ID });
    });

    test('API-ADMIN-002 自前の表の更新が誤りを返しても見ず、Auth 側の失効が通れば 200 を返す', async () => {
      sessionsEq.mockResolvedValue({ error: { message: 'update failed' } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(200);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'success' }));
    });

    test('API-ADMIN-002 Auth 側の失効が誤りを返せば 500 を返し、error を auth_session_revocation_failed で監査へ残す', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to revoke sessions' });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          outcome: 'error',
          detail: 'auth_session_revocation_failed',
          resource_id: TARGET_ID,
          actor_id: ACTOR_ID,
        }),
      );
    });

    test('API-ADMIN-002 DB が例外を投げれば 500 を返し、例外の文を error として監査へ残す', async () => {
      sessionsUpdate.mockImplementation(() => {
        throw new Error('db fail');
      });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to revoke sessions' });
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'error', detail: 'Error: db fail', resource_id: TARGET_ID }));
    });

    test('API-ADMIN-002 認可の後で service role を作れなければ 500 を返し、例外の文を error として監査へ残す', async () => {
      installServiceClient();
      const base = await createServiceRoleClient();
      let n = 0;
      // 1 回目は認可の ACL の照会、2 回目が窓口自身の分
      createServiceRoleClient.mockImplementation(async () => {
        n += 1;
        if (n === 2) throw new Error('no client');
        return base;
      });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to revoke sessions' });
      expect(rpc).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'error', detail: 'Error: no client' }));
    });
  });
});
