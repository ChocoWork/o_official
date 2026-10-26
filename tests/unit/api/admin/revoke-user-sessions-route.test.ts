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

jest.mock('@/lib/auth/revoke-user-sessions', () => ({
  revokeAllSessionsForUser: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

import { POST } from '@/app/api/admin/revoke-user-sessions/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { revokeAllSessionsForUser } = require('@/lib/auth/revoke-user-sessions');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { incrementCounter } = require('@/features/auth/ratelimit');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
// 英字を含む id（数字だけだと toUpperCase() で同じ文字になり、小文字にそろえる処理を確かめられない）
const MIXED_ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const MIXED_TARGET_ID = 'fedcba98-7654-4321-8abc-def012345678';

const getUserById = jest.fn();

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/revoke-user-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const actor = {
  action: 'admin_revoke_user_sessions',
  actor_id: ACTOR_ID,
  actor_email: 'admin@example.com',
  resource: 'sessions',
};

describe('POST /api/admin/revoke-user-sessions', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    authorizeAdminPermission.mockResolvedValue({
      ok: true,
      userId: ACTOR_ID,
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
    enforceRateLimit.mockResolvedValue(undefined);
    incrementCounter.mockResolvedValue(1);
    getUserById.mockResolvedValue({ data: { user: { id: TARGET_ID } }, error: null });
    createServiceRoleClient.mockResolvedValue({ auth: { admin: { getUserById } } });
    revokeAllSessionsForUser.mockResolvedValue({ authSessionsDeleted: 2 });
    logAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('認可に失敗した時の監査（全体で10分に20行まで）', () => {
    const response = { status: 401, json: async () => ({ error: 'Unauthorized' }) };

    beforeEach(() => {
      authorizeAdminPermission.mockResolvedValue({ ok: false, response });
    });

    it('DD-ADMIN-003 count が 20 以下の時は、操作した人を空にして unauthorized を IP とブラウザの情報付きで書き、認可の応答を返す', async () => {
      incrementCounter.mockResolvedValue(20);

      const res = await POST(
        makeRequest({ user_id: TARGET_ID }, { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1', 'user-agent': 'jest-agent' }),
      );

      expect(res).toBe(response);
      expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', expect.any(Request));
      expect(incrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'admin_revoke_unauthorized_audit', subject: 'all' }),
      );
      const bucket = incrementCounter.mock.calls[0][0].bucket;
      expect(new Date(bucket).getTime() % 600000).toBe(0);
      expect(logAudit).toHaveBeenCalledTimes(1);
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
      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 count が 21 の時は unauthorized_burst の1行だけを書き、unauthorized は書かない', async () => {
      incrementCounter.mockResolvedValue(21);

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res).toBe(response);
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'unauthorized_burst',
          detail: 'further attempts suppressed for this window',
          actor_id: null,
        }),
      );
      expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unauthorized' }));
    });

    it('DD-ADMIN-003 count が 22 以上の時は監査を書かず、応答は同じ', async () => {
      incrementCounter.mockResolvedValue(22);

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res).toBe(response);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 数える部品が throw した時は監査を書かず（fail-open）、応答は同じ 401', async () => {
      incrementCounter.mockRejectedValue(new Error('counter down'));

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res).toBe(response);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 認可の部品の 503 も同じ記録になる', async () => {
      const unavailable = { status: 503, json: async () => ({ error: 'Service unavailable' }) };
      authorizeAdminPermission.mockResolvedValue({ ok: false, response: unavailable });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(503);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unauthorized', actor_id: null }));
    });

    it('DD-ADMIN-003 x-forwarded-for と user-agent が無い時は IP とブラウザの情報を空で書く', async () => {
      await POST(makeRequest({ user_id: TARGET_ID }));

      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: null, user_agent: null }));
    });
  });

  describe('回数の制限', () => {
    it('DD-ADMIN-003 認可の後に、管理者の ID を subject にして 20 回 / 600 秒で数える', async () => {
      const req = makeRequest({ user_id: TARGET_ID });

      await POST(req);

      expect(enforceRateLimit).toHaveBeenCalledWith({
        request: req,
        endpoint: 'admin:users:revoke-sessions',
        limit: 20,
        windowSeconds: 600,
        subject: ACTOR_ID,
      });
    });

    it('DD-ADMIN-003 入力の user_id を subject に使わない', async () => {
      await POST(makeRequest({ user_id: TARGET_ID }));

      expect(enforceRateLimit.mock.calls[0][0].subject).not.toBe(TARGET_ID);
    });

    it('DD-ADMIN-003 429 の時は本文を読まず、対象を引かず、失効しない', async () => {
      const tooMany = { status: 429, _body: { error: 'Too many requests' } };
      enforceRateLimit.mockResolvedValue(tooMany);
      const req = makeRequest({ user_id: TARGET_ID });
      const readBody = jest.spyOn(req, 'json');

      const res = await POST(req);

      expect(res).toBe(tooMany);
      expect(readBody).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 限度器が 503 を返した時も握りつぶさず返す', async () => {
      const unavailable = { status: 503, _body: { error: 'Rate limiter unavailable' } };
      enforceRateLimit.mockResolvedValue(unavailable);

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res).toBe(unavailable);
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });
  });

  describe('入力の検査', () => {
    it('DD-ADMIN-003 本文が JSON でない時は 400 で、500 にならず、failure を書く', async () => {
      const res = await POST(makeRequest('{not json'));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid request' });
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ ...actor, outcome: 'failure', detail: 'Invalid request body' }));
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });

    it.each([
      ['空の文字', { user_id: '' }],
      ['UUID でない文字', { user_id: 'u-1' }],
      ['数', { user_id: 12345 }],
      ['無い', {}],
    ])('DD-ADMIN-003 user_id が %s の時は 400 で、失効に進まない', async (_label, body) => {
      const res = await POST(makeRequest(body, { 'x-forwarded-for': '198.51.100.2', 'user-agent': 'jest-agent' }));

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
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 自分自身の user_id は 400 Cannot revoke your own sessions で、失効せず failure を書く', async () => {
      const res = await POST(makeRequest({ user_id: ACTOR_ID }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Cannot revoke your own sessions' });
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ ...actor, outcome: 'failure', detail: 'self_revocation_rejected', resource_id: ACTOR_ID }),
      );
    });

    it('DD-ADMIN-003 自分自身の user_id を大文字で送っても 400 で、小文字にそろえて断り、getUserById も失効も呼ばない', async () => {
      authorizeAdminPermission.mockResolvedValue({
        ok: true,
        userId: MIXED_ACTOR_ID,
        role: 'admin',
        actorEmail: 'admin@example.com',
      });
      const upper = MIXED_ACTOR_ID.toUpperCase();
      expect(upper).not.toBe(MIXED_ACTOR_ID);

      const res = await POST(makeRequest({ user_id: upper }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Cannot revoke your own sessions' });
      expect(getUserById).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'self_revocation_rejected', resource_id: MIXED_ACTOR_ID }),
      );
    });
  });

  describe('対象の確認', () => {
    it('DD-ADMIN-003 getUserById が 404 の誤りを返した時は 404 で、success を書かず失効しない', async () => {
      getUserById.mockResolvedValue({ error: { status: 404, code: 'user_not_found' }, data: { user: null } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(404);
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'target_not_found', resource_id: TARGET_ID }),
      );
      expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });

    it('DD-ADMIN-003 code だけが user_not_found でも 404', async () => {
      getUserById.mockResolvedValue({ error: { code: 'user_not_found' }, data: { user: null } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(404);
    });

    it('DD-ADMIN-003 誤りが無いのに利用者が空の時も 404', async () => {
      getUserById.mockResolvedValue({ error: null, data: { user: null } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(404);
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 誤りが無く data も空の時も 404', async () => {
      getUserById.mockResolvedValue({ error: null, data: null });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(404);
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-003 getUserById の誤りが物でない（文字だけ）時は見つからない扱いにせず 500 で、target_lookup_failed を error で書く', async () => {
      getUserById.mockResolvedValue({ error: 'auth down', data: { user: null } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'target_lookup_failed', resource_id: TARGET_ID }),
      );
    });

    it('DD-ADMIN-003 getUserById が別の誤り（500）を返した時は 500 で、target_lookup_failed を error で書く', async () => {
      getUserById.mockResolvedValue({ error: { status: 500, message: 'auth down user@example.com' }, data: { user: null } });

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to revoke sessions' });
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'target_lookup_failed', resource_id: TARGET_ID }),
      );
      expect(JSON.stringify(logAudit.mock.calls)).not.toContain('user@example.com');
    });
  });

  describe('失効', () => {
    it('DD-ADMIN-003 成功した時は部品で失効し、success と消した数を書いて 200 { ok: true }', async () => {
      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET_ID);
      expect(logAudit).toHaveBeenCalledTimes(1);
      expect(logAudit).toHaveBeenCalledWith({
        ...actor,
        resource_id: TARGET_ID,
        outcome: 'success',
        metadata: { auth_sessions_deleted: 2 },
      });
    });

    it('DD-ADMIN-003 対象の user_id が大文字でも、小文字にそろえて引き・失効し、監査の resource_id も小文字', async () => {
      getUserById.mockResolvedValue({ data: { user: { id: MIXED_TARGET_ID } }, error: null });
      const upper = MIXED_TARGET_ID.toUpperCase();
      expect(upper).not.toBe(MIXED_TARGET_ID);

      const res = await POST(makeRequest({ user_id: upper }));

      expect(res.status).toBe(200);
      expect(getUserById).toHaveBeenCalledWith(MIXED_TARGET_ID);
      expect(revokeAllSessionsForUser).toHaveBeenCalledWith(MIXED_TARGET_ID);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', resource_id: MIXED_TARGET_ID }));
    });

    it('DD-ADMIN-003 失効の部品が throw した時は 500 Failed to revoke sessions で、revoke_failed を error で書き、throw の文はどこにも出さない', async () => {
      revokeAllSessionsForUser.mockRejectedValue(new Error('auth_session_revocation_failed secret-detail'));

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to revoke sessions' });
      expect(logAudit).toHaveBeenCalledWith({
        ...actor,
        resource_id: TARGET_ID,
        outcome: 'error',
        detail: 'revoke_failed',
      });
      expect(JSON.stringify(logAudit.mock.calls)).not.toContain('secret-detail');
      expect(JSON.stringify(await res.json())).not.toContain('secret-detail');
    });

    it('DD-ADMIN-003 DB の client の作成で例外が出た時も 500 で revoke_failed を書く', async () => {
      createServiceRoleClient.mockRejectedValue(new Error('no service role'));

      const res = await POST(makeRequest({ user_id: TARGET_ID }));

      expect(res.status).toBe(500);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'revoke_failed' }));
      expect(JSON.stringify(logAudit.mock.calls)).not.toContain('no service role');
    });
  });

  it('DD-ADMIN-003 認可の部品が例外を投げた時は 500 Internal server error', async () => {
    authorizeAdminPermission.mockRejectedValue(new Error('rbac down'));

    const res = await POST(makeRequest({ user_id: TARGET_ID }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logAudit).not.toHaveBeenCalled();
  });
});
