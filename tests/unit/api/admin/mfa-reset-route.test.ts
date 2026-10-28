export {};

import { createHash } from 'node:crypto';

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/auth/revoke-user-sessions', () => ({ revokeAllSessionsForUser: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, _body: body }),
  },
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');
const { logAudit } = require('@/lib/audit');
const { revokeAllSessionsForUser } = require('@/lib/auth/revoke-user-sessions');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { POST } = require('@/app/api/admin/users/mfa/reset/route');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
// 英字を含む id（数字だけだと toUpperCase() で同じ文字になり、小文字にそろえる処理を確かめられない）
const MIXED_ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const MIXED_TARGET_ID = 'fedcba98-7654-4321-8abc-def012345678';
const REASON = 'Lost the authenticator device';
const TARGET_EMAIL = 'target@example.com';

type ServiceOptions = {
  getUserById?: jest.Mock;
  listFactors?: jest.Mock;
  deleteFactor?: jest.Mock;
  roleResult?: { data: unknown; error: unknown };
};

function roleRows(...codes: string[]) {
  return codes.map((code) => ({ roles: { code } }));
}

function buildService(options: ServiceOptions = {}) {
  const getUserById =
    options.getUserById ??
    jest.fn().mockResolvedValue({
      data: { user: { id: TARGET_ID, email: TARGET_EMAIL, app_metadata: {} } },
      error: null,
    });
  const listFactors =
    options.listFactors ??
    jest.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }, { id: 'f2' }] }, error: null });
  const deleteFactor = options.deleteFactor ?? jest.fn().mockResolvedValue({ error: null });

  const or = jest.fn().mockResolvedValue(options.roleResult ?? { data: roleRows('admin'), error: null });
  const eqActive = jest.fn().mockReturnValue({ or });
  const eqUser = jest.fn().mockReturnValue({ eq: eqActive });
  const select = jest.fn().mockReturnValue({ eq: eqUser });
  const from = jest.fn().mockReturnValue({ select });

  const service = { from, auth: { admin: { getUserById, mfa: { listFactors, deleteFactor } } } };
  createServiceRoleClient.mockResolvedValue(service);
  return { getUserById, listFactors, deleteFactor, from, select, eqUser, eqActive, or };
}

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'x-real-ip': '203.0.113.5', 'user-agent': 'jest-agent' },
) {
  return new Request('http://localhost/api/admin/users/mfa/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { userId: TARGET_ID, reason: REASON, confirm: 'RESET_MFA' };

function auditedText(): string {
  return JSON.stringify(logAudit.mock.calls);
}

describe('POST /api/admin/users/mfa/reset', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: ACTOR_ID, role: 'admin', actorEmail: 'admin@example.com' });
    enforceRateLimit.mockResolvedValue(undefined);
    revokeAllSessionsForUser.mockResolvedValue({ authSessionsDeleted: 1 });
    logAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-005 認可が ok:false の時は認可の応答を返し、回数も数えず、監査を書かず DB も作らない', async () => {
    const denied = { status: 403, _body: { error: 'Forbidden' } };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });
    const req = makeRequest(validBody);

    const res = await POST(req);

    expect(res).toBe(denied);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', req);
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  describe('回数の制限', () => {
    it('DD-ADMIN-005 認可の後に、管理者の ID を subject にして 10 回 / 600 秒で数える', async () => {
      buildService();
      const req = makeRequest(validBody);

      await POST(req);

      expect(enforceRateLimit).toHaveBeenCalledWith({
        request: req,
        endpoint: 'admin:users:mfa-reset',
        limit: 10,
        windowSeconds: 600,
        subject: ACTOR_ID,
      });
    });

    it('DD-ADMIN-005 429 の時は本文を読まず、DB も触らない', async () => {
      const tooMany = { status: 429, _body: { error: 'Too many requests' } };
      enforceRateLimit.mockResolvedValue(tooMany);
      const req = makeRequest(validBody);
      const readBody = jest.spyOn(req, 'json');

      const res = await POST(req);

      expect(res).toBe(tooMany);
      expect(readBody).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });
  });

  it('DD-ADMIN-005 本文が JSON でない時は空の物として 400 を返し、監査に failure と空の userId を書く', async () => {
    const res = await POST(makeRequest('not-json'));

    expect(res.status).toBe(400);
    expect(res._body.error).toBe('Invalid request');
    expect(res._body.details).toBeDefined();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.users.mfa.reset',
        actor_id: ACTOR_ID,
        actor_email: 'admin@example.com',
        resource: 'users',
        resource_id: null,
        outcome: 'failure',
        detail: 'Invalid request body',
        metadata: { requested_user_id: null },
      }),
    );
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 本文が null の JSON の時も 400 を返し、監査の userId は空', async () => {
    const res = await POST(makeRequest('null'));

    expect(res.status).toBe(400);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { requested_user_id: null } }),
    );
  });

  it('DD-ADMIN-005 confirm が違う時は 400 で details を返し、UUID の形の userId だけを監査に控える', async () => {
    const res = await POST(makeRequest({ ...validBody, confirm: 'NOPE' }));

    expect(res.status).toBe(400);
    expect(res._body.details.fieldErrors).toHaveProperty('confirm');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        resource_id: TARGET_ID,
        metadata: { requested_user_id: TARGET_ID },
      }),
    );
    expect(auditedText()).not.toContain(REASON);
  });

  it('DD-ADMIN-005 理由が空白を除いて 9 字の時は 400 を返す', async () => {
    const res = await POST(makeRequest({ ...validBody, reason: '  123456789  ' }));

    expect(res.status).toBe(400);
    expect(res._body.details.fieldErrors).toHaveProperty('reason');
  });

  it('DD-ADMIN-005 理由が 501 字の時は 400 を返す', async () => {
    const res = await POST(makeRequest({ ...validBody, reason: 'a'.repeat(501) }));

    expect(res.status).toBe(400);
    expect(res._body.details.fieldErrors).toHaveProperty('reason');
  });

  it('DD-ADMIN-005 userId が UUID でない文字の時は 400 を返し、その文字を監査に入れず空にする', async () => {
    const res = await POST(makeRequest({ ...validBody, userId: 'not-a-uuid' }));

    expect(res.status).toBe(400);
    expect(res._body.details.fieldErrors).toHaveProperty('userId');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: null, metadata: { requested_user_id: null } }),
    );
    expect(auditedText()).not.toContain('not-a-uuid');
  });

  it('DD-ADMIN-005 userId が数の時は 400 を返し、監査の userId は空', async () => {
    const res = await POST(makeRequest({ ...validBody, userId: 12345 }));

    expect(res.status).toBe(400);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: null, metadata: { requested_user_id: null } }),
    );
  });

  it('DD-ADMIN-005 x-real-ip は前後の空白を除いて、user-agent はそのまま監査に書く', async () => {
    await POST(makeRequest('not-json', { 'x-real-ip': '  198.51.100.7 ', 'user-agent': 'UA/1.0' }));

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: '198.51.100.7', user_agent: 'UA/1.0' }));
  });

  it('DD-ADMIN-005 x-forwarded-for は読まず、x-real-ip の値だけを監査の IP に書く', async () => {
    await POST(makeRequest('not-json', { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.7' }));
    expect(logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ ip: '198.51.100.7' }));

    await POST(makeRequest('not-json', { 'x-forwarded-for': '203.0.113.9' }));
    expect(logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ ip: null }));
  });

  it('DD-ADMIN-005 x-real-ip と user-agent が無い時は監査の IP とブラウザの情報が空', async () => {
    await POST(makeRequest('not-json', {}));

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: null, user_agent: null }));
  });

  it('DD-ADMIN-005 userId が認可の利用者と同じ時は 400 Self-reset is not allowed で、対象を引かない', async () => {
    const res = await POST(makeRequest({ ...validBody, userId: ACTOR_ID }));

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'Self-reset is not allowed' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: ACTOR_ID,
        outcome: 'failure',
        detail: 'Self-reset is not allowed',
        ip: '203.0.113.5',
        user_agent: 'jest-agent',
      }),
    );
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 userId を自分の ID の大文字で送っても 400 Self-reset is not allowed で、対象を引かず消さず失効もしない', async () => {
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: MIXED_ACTOR_ID, role: 'admin', actorEmail: 'admin@example.com' });
    const { getUserById, deleteFactor } = buildService();
    const upper = MIXED_ACTOR_ID.toUpperCase();
    expect(upper).not.toBe(MIXED_ACTOR_ID);

    const res = await POST(makeRequest({ ...validBody, userId: upper }));

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'Self-reset is not allowed' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: MIXED_ACTOR_ID, outcome: 'failure', detail: 'Self-reset is not allowed' }),
    );
    expect(getUserById).not.toHaveBeenCalled();
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 対象の userId が大文字でも、小文字にそろえて引き・消し・失効し、監査の resource_id も小文字', async () => {
    const { getUserById, deleteFactor } = buildService({
      getUserById: jest.fn().mockResolvedValue({
        data: { user: { id: MIXED_TARGET_ID, email: TARGET_EMAIL, app_metadata: {} } },
        error: null,
      }),
    });
    const upper = MIXED_TARGET_ID.toUpperCase();
    expect(upper).not.toBe(MIXED_TARGET_ID);

    const res = await POST(makeRequest({ ...validBody, userId: upper }));

    expect(res.status).toBe(200);
    expect(getUserById).toHaveBeenCalledWith(MIXED_TARGET_ID);
    expect(deleteFactor).toHaveBeenNthCalledWith(1, { userId: MIXED_TARGET_ID, id: 'f1' });
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(MIXED_TARGET_ID);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', resource_id: MIXED_TARGET_ID }));
  });

  it('DD-ADMIN-005 getUserById が誤りを返した時は 404 User not found で、役割も引かず失効もしない', async () => {
    const { from } = buildService({
      getUserById: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'boom' } }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(404);
    expect(res._body).toEqual({ error: 'User not found' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'Target user not found', resource_id: TARGET_ID }),
    );
    expect(from).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 getUserById の利用者が空の時も 404 を返す', async () => {
    const getUserById = jest.fn().mockResolvedValue({ data: { user: null }, error: null });
    const { listFactors } = buildService({ getUserById });

    const res = await POST(makeRequest(validBody));

    expect(getUserById).toHaveBeenCalledWith(TARGET_ID);
    expect(res.status).toBe(404);
    expect(listFactors).not.toHaveBeenCalled();
  });

  describe('対象の役割は user_roles（DB の ACL）で決める', () => {
    it('DD-ADMIN-005 app_metadata が supporter でも user_roles が空なら 400 で、消さず失効もせず target_not_privileged を書く', async () => {
      const { listFactors, deleteFactor } = buildService({
        getUserById: jest.fn().mockResolvedValue({
          data: { user: { id: TARGET_ID, email: TARGET_EMAIL, app_metadata: { role: 'supporter' } } },
          error: null,
        }),
        roleResult: { data: [], error: null },
      });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'MFA reset is available only for privileged users' });
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'target_not_privileged', resource_id: TARGET_ID }),
      );
      expect(listFactors).not.toHaveBeenCalled();
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-005 app_metadata が無くても user_roles に admin があれば通る', async () => {
      const { listFactors } = buildService({
        getUserById: jest.fn().mockResolvedValue({ data: { user: { id: TARGET_ID, email: TARGET_EMAIL } }, error: null }),
        roleResult: { data: roleRows('admin'), error: null },
      });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(listFactors).toHaveBeenCalledWith({ userId: TARGET_ID });
    });

    it.each([
      ['customer だけ', ['customer']],
      ['知らない役割だけ', ['owner']],
      ['空', []],
    ])('DD-ADMIN-005 user_roles が %s の時は特権でないとして 400', async (_label, codes) => {
      const { deleteFactor } = buildService({ roleResult: { data: roleRows(...codes), error: null } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(400);
      expect(deleteFactor).not.toHaveBeenCalled();
    });

    it('DD-ADMIN-005 user_roles が null の時も特権でないとして 400', async () => {
      buildService({ roleResult: { data: null, error: null } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(400);
    });

    it('DD-ADMIN-005 user_roles の行が欠けた形（行が null・roles が null・code が文字でない）は読み飛ばし、roles が配列の行は先頭の code で決める', async () => {
      buildService({
        roleResult: {
          data: [null, { roles: null }, { roles: { code: 7 } }, { roles: [{ code: 'supporter' }] }],
          error: null,
        },
      });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', metadata: expect.objectContaining({ target_role: 'supporter' }) }),
      );
    });

    it('DD-ADMIN-005 supporter だけの時は通り、監査の target_role は supporter', async () => {
      buildService({ roleResult: { data: roleRows('supporter'), error: null } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', metadata: expect.objectContaining({ target_role: 'supporter' }) }),
      );
    });

    it('DD-ADMIN-005 user_roles を active かつ期限内で問い合わせる', async () => {
      const { from, select, eqUser, eqActive, or } = buildService();

      await POST(makeRequest(validBody));

      expect(from).toHaveBeenCalledWith('user_roles');
      expect(select).toHaveBeenCalledWith('roles!inner(code)');
      expect(eqUser).toHaveBeenCalledWith('user_id', TARGET_ID);
      expect(eqActive).toHaveBeenCalledWith('active', true);
      expect(or).toHaveBeenCalledWith(expect.stringMatching(/^expires_at\.is\.null,expires_at\.gt\./));
    });

    it('DD-ADMIN-005 user_roles の問い合わせが誤りを返した時は 500 で、role_lookup_failed を書き、消さない', async () => {
      const { deleteFactor } = buildService({
        roleResult: { data: null, error: { message: 'db down user@example.com', code: '08006' } },
      });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'role_lookup_failed', resource_id: TARGET_ID }),
      );
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
      expect(auditedText()).not.toContain('db down');
    });
  });

  it('DD-ADMIN-005 一覧が誤りを返した時は 500 Failed to list target MFA factors で、誤りの文を監査に書かず、失効もしない', async () => {
    const { deleteFactor } = buildService({
      listFactors: jest.fn().mockResolvedValue({ data: null, error: { message: 'list failed' } }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to list target MFA factors' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'Failed to list target MFA factors' }),
    );
    expect(auditedText()).not.toContain('list failed');
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 一覧が2件で両方消せた時は 200 で消した数 2、失効まで進み、監査は理由の長さとハッシュだけを持つ', async () => {
    const { deleteFactor } = buildService();

    const res = await POST(makeRequest(validBody));

    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(deleteFactor).toHaveBeenNthCalledWith(1, { userId: TARGET_ID, id: 'f1' });
    expect(deleteFactor).toHaveBeenNthCalledWith(2, { userId: TARGET_ID, id: 'f2' });
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET_ID);
    expect(res.status).toBe(200);
    expect(res._body).toEqual({
      success: true,
      deletedFactorCount: 2,
      message: 'MFA factors were reset. The user must sign in again and enroll MFA.',
    });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin.users.mfa.reset',
      actor_id: ACTOR_ID,
      actor_email: 'admin@example.com',
      resource: 'users',
      resource_id: TARGET_ID,
      outcome: 'success',
      detail: 'Admin reset user MFA factors',
      ip: '203.0.113.5',
      user_agent: 'jest-agent',
      metadata: {
        reason_length: REASON.length,
        reason_sha256: createHash('sha256').update(REASON).digest('hex'),
        target_role: 'admin',
        deleted_factor_count: 2,
      },
    });
  });

  it('DD-ADMIN-005 理由は前後の空白を除いた長さとハッシュを監査に書く', async () => {
    buildService();

    await POST(makeRequest({ ...validBody, reason: `   ${REASON}   ` }));

    const metadata = logAudit.mock.calls[0][0].metadata;
    expect(metadata.reason_length).toBe(REASON.length);
    expect(metadata.reason_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.reason_sha256).toBe(createHash('sha256').update(REASON).digest('hex'));
  });

  it('DD-ADMIN-005 一覧が空の配列の時は消さずに 200 で消した数 0、それでも失効はする', async () => {
    const { deleteFactor } = buildService({
      listFactors: jest.fn().mockResolvedValue({ data: { factors: [] }, error: null }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(res._body).toMatchObject({ success: true, deletedFactorCount: 0 });
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(TARGET_ID);
  });

  it.each([
    ['一覧が配列でない時', { factors: 'nope' }],
    ['一覧の data が空の時', null],
    ['一覧の要素が物でない時', { factors: ['f1'] }],
    ['一覧の要素が空の時', { factors: [null] }],
    ['一覧の要素に id が無い時', { factors: [{ factor_type: 'totp' }] }],
    ['一覧の要素の id が空の文字の時', { factors: [{ id: '' }] }],
    ['一覧の要素の id が文字でない時', { factors: [{ id: 7 }] }],
    ['一覧の一部の要素だけが不正な時', { factors: [{ id: 'f1' }, { id: '' }] }],
  ])('DD-ADMIN-005 %s は消さずに 200 で消した数 0', async (_label, data) => {
    const { deleteFactor } = buildService({
      listFactors: jest.fn().mockResolvedValue({ data, error: null }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(res._body).toMatchObject({ success: true, deletedFactorCount: 0 });
    expect(deleteFactor).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        metadata: expect.objectContaining({ deleted_factor_count: 0 }),
      }),
    );
  });

  it('DD-ADMIN-005 1件の削除が失敗した時は 500 で、消せた分を戻さず、失敗した要素の ID だけを監査に書き、失効しない', async () => {
    const deleteFactor = jest
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'cannot delete user@example.com' } });
    buildService({ deleteFactor });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to delete one or more MFA factors' });
    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        detail: 'Failed to delete one or more factors',
        metadata: expect.objectContaining({ total_factors: 2, delete_error_factor_ids: ['f2'] }),
      }),
    );
    expect(auditedText()).not.toContain('cannot delete');
  });

  it('DD-ADMIN-005 削除の誤りに文が無い時も要素の ID だけを控えて 500', async () => {
    const deleteFactor = jest.fn().mockResolvedValue({ error: {} });
    buildService({
      listFactors: jest.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }] }, error: null }),
      deleteFactor,
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({ delete_error_factor_ids: ['f1'] }),
      }),
    );
  });

  it('DD-ADMIN-005 失効の部品が throw した時は 500 で session_revocation_failed を書き、消した数は残し、throw の文は出さない', async () => {
    buildService();
    revokeAllSessionsForUser.mockRejectedValue(new Error('auth_session_revocation_failed secret-detail'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to revoke target sessions' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        detail: 'session_revocation_failed',
        metadata: expect.objectContaining({ deleted_factor_count: 2 }),
      }),
    );
    expect(auditedText()).not.toContain('secret-detail');
    expect(JSON.stringify(res._body)).not.toContain('secret-detail');
  });

  describe('全部の分岐の監査に、理由の文・対象のメール・誤りの文を残さない', () => {
    const SECRET_REASON = 'secret-reason-text-for-audit';
    const body = { ...validBody, reason: SECRET_REASON };

    const branches: Array<[string, () => Promise<unknown>]> = [
      ['検証の失敗', async () => POST(makeRequest({ ...body, confirm: 'NOPE' }))],
      ['自分自身', async () => POST(makeRequest({ ...body, userId: ACTOR_ID }))],
      [
        '対象なし',
        async () => {
          buildService({ getUserById: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'secret-error-text' } }) });
          return POST(makeRequest(body));
        },
      ],
      [
        '特権でない',
        async () => {
          buildService({ roleResult: { data: roleRows('customer'), error: null } });
          return POST(makeRequest(body));
        },
      ],
      [
        '要素の一覧の失敗',
        async () => {
          buildService({ listFactors: jest.fn().mockResolvedValue({ data: null, error: { message: 'secret-error-text' } }) });
          return POST(makeRequest(body));
        },
      ],
      [
        '削除の失敗',
        async () => {
          buildService({ deleteFactor: jest.fn().mockResolvedValue({ error: { message: 'secret-error-text' } }) });
          return POST(makeRequest(body));
        },
      ],
      [
        '成功',
        async () => {
          buildService();
          return POST(makeRequest(body));
        },
      ],
    ];

    it.each(branches)('DD-ADMIN-005 %s の分岐', async (_label, run) => {
      await run();

      expect(logAudit).toHaveBeenCalled();
      const text = auditedText();
      expect(text).not.toContain(SECRET_REASON);
      expect(text).not.toContain(TARGET_EMAIL);
      expect(text).not.toContain('secret-error-text');
      for (const [event] of logAudit.mock.calls) {
        for (const key of ['reason', 'target_email', 'error_message', 'delete_errors']) {
          expect(event.metadata ?? {}).not.toHaveProperty(key);
        }
      }
    });
  });

  it('DD-ADMIN-005 createServiceRoleClient が例外を投げた時は 500 Internal server error を返す', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no key'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalledWith('POST /api/admin/users/mfa/reset error:', expect.any(Error));
  });
});
