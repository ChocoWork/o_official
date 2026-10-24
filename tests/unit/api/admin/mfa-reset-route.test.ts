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
const { POST } = require('@/app/api/admin/users/mfa/reset/route');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const REASON = 'Lost the authenticator device';

type ServiceOptions = {
  getUserById?: jest.Mock;
  listFactors?: jest.Mock;
  deleteFactor?: jest.Mock;
};

function buildService(options: ServiceOptions = {}) {
  const getUserById =
    options.getUserById ??
    jest.fn().mockResolvedValue({
      data: { user: { id: TARGET_ID, email: 'target@example.com', app_metadata: { role: 'admin' } } },
      error: null,
    });
  const listFactors =
    options.listFactors ??
    jest.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }, { id: 'f2' }] }, error: null });
  const deleteFactor = options.deleteFactor ?? jest.fn().mockResolvedValue({ error: null });
  const service = { auth: { admin: { getUserById, mfa: { listFactors, deleteFactor } } } };
  createServiceRoleClient.mockResolvedValue(service);
  return { getUserById, listFactors, deleteFactor };
}

function userWith(appMetadata: unknown, extra: Record<string, unknown> = { email: 'target@example.com' }) {
  return jest.fn().mockResolvedValue({
    data: { user: { id: TARGET_ID, ...extra, app_metadata: appMetadata } },
    error: null,
  });
}

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'user-agent': 'jest-agent' },
) {
  return new Request('http://localhost/api/admin/users/mfa/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { userId: TARGET_ID, reason: REASON, confirm: 'RESET_MFA' };

describe('POST /api/admin/users/mfa/reset', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    authorizeAdminPermission.mockResolvedValue({ ok: true, userId: ACTOR_ID, role: 'admin', actorEmail: 'admin@example.com' });
    logAudit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-005 認可が ok:false の時は認可の応答を返し、監査を書かず DB も作らない', async () => {
    const denied = { status: 403, _body: { error: 'Forbidden' } };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response: denied });
    const req = makeRequest(validBody);

    const res = await POST(req);

    expect(res).toBe(denied);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', req);
    expect(logAudit).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
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

  it('DD-ADMIN-005 confirm が違う時は 400 で details を返し、文字の userId を監査に控える', async () => {
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

  it('DD-ADMIN-005 userId が UUID でない文字の時は 400 を返し、その文字を監査に控える', async () => {
    const res = await POST(makeRequest({ ...validBody, userId: 'not-a-uuid' }));

    expect(res.status).toBe(400);
    expect(res._body.details.fieldErrors).toHaveProperty('userId');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'not-a-uuid',
        metadata: { requested_user_id: 'not-a-uuid' },
      }),
    );
  });

  it('DD-ADMIN-005 userId が数の時は 400 を返し、監査の userId は空', async () => {
    const res = await POST(makeRequest({ ...validBody, userId: 12345 }));

    expect(res.status).toBe(400);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: null, metadata: { requested_user_id: null } }),
    );
  });

  it('DD-ADMIN-005 x-forwarded-for は左端を前後の空白を除いて、user-agent はそのまま監査に書く', async () => {
    await POST(makeRequest('not-json', { 'x-forwarded-for': '  198.51.100.7 , 10.0.0.1', 'user-agent': 'UA/1.0' }));

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ ip: '198.51.100.7', user_agent: 'UA/1.0' }));
  });

  it('DD-ADMIN-005 x-forwarded-for と user-agent が無い時は監査の IP とブラウザの情報が空', async () => {
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
    expect(logAudit.mock.calls[0][0]).not.toHaveProperty('metadata');
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 getUserById が誤りを返した時は 404 User not found で、監査に理由を書く', async () => {
    buildService({
      getUserById: jest.fn().mockResolvedValue({ data: { user: null }, error: { message: 'boom' } }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(404);
    expect(res._body).toEqual({ error: 'User not found' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        detail: 'Target user not found',
        resource_id: TARGET_ID,
        metadata: { reason: REASON },
      }),
    );
  });

  it('DD-ADMIN-005 getUserById の利用者が空の時も 404 を返す', async () => {
    const getUserById = jest.fn().mockResolvedValue({ data: { user: null }, error: null });
    const { listFactors } = buildService({ getUserById });

    const res = await POST(makeRequest(validBody));

    expect(getUserById).toHaveBeenCalledWith(TARGET_ID);
    expect(res.status).toBe(404);
    expect(listFactors).not.toHaveBeenCalled();
  });

  it.each([
    ['app_metadata が空の時', null, 'user'],
    ['app_metadata が物でない時', 'admin', 'user'],
    ['役割が user の時', { role: 'user' }, 'user'],
    ['役割が知らない値の時', { role: 'owner' }, 'user'],
    ['役割が無い時', {}, 'user'],
  ])('DD-ADMIN-005 %s は特権でないとして 400 を返し、消さずに対象の役割を監査に書く', async (_label, appMetadata, expectedRole) => {
    const { listFactors, deleteFactor } = buildService({ getUserById: userWith(appMetadata) });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(400);
    expect(res._body).toEqual({ error: 'MFA reset is available only for privileged users' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        detail: 'Target user is not privileged',
        metadata: { reason: REASON, target_role: expectedRole },
      }),
    );
    expect(listFactors).not.toHaveBeenCalled();
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it.each(['admin', 'supporter'])('DD-ADMIN-005 役割が %s の時は一覧を引く', async (role) => {
    const { listFactors } = buildService({ getUserById: userWith({ role }) });

    const res = await POST(makeRequest(validBody));

    expect(listFactors).toHaveBeenCalledWith({ userId: TARGET_ID });
    expect(res.status).toBe(200);
  });

  it('DD-ADMIN-005 一覧が誤りを返した時は 500 Failed to list target MFA factors で、監査に誤りの文を書く', async () => {
    const { deleteFactor } = buildService({
      listFactors: jest.fn().mockResolvedValue({ data: null, error: { message: 'list failed' } }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to list target MFA factors' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        detail: 'Failed to list target MFA factors',
        metadata: { reason: REASON, error_message: 'list failed' },
      }),
    );
    expect(deleteFactor).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-005 一覧が2件で両方消せた時は 200 で消した数 2、監査に対象のメールと役割を書く', async () => {
    const { deleteFactor } = buildService();

    const res = await POST(makeRequest(validBody));

    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(deleteFactor).toHaveBeenNthCalledWith(1, { userId: TARGET_ID, id: 'f1' });
    expect(deleteFactor).toHaveBeenNthCalledWith(2, { userId: TARGET_ID, id: 'f2' });
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
        reason: REASON,
        target_role: 'admin',
        target_email: 'target@example.com',
        deleted_factor_count: 2,
      },
    });
  });

  it('DD-ADMIN-005 対象のメールが無い時は監査の対象のメールが空', async () => {
    buildService({ getUserById: userWith({ role: 'supporter' }, {}) });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'success',
        metadata: expect.objectContaining({ target_role: 'supporter', target_email: null }),
      }),
    );
  });

  it('DD-ADMIN-005 理由は前後の空白を除いて監査に書く', async () => {
    buildService();

    await POST(makeRequest({ ...validBody, reason: `   ${REASON}   ` }));

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', metadata: expect.objectContaining({ reason: REASON }) }),
    );
  });

  it('DD-ADMIN-005 一覧が空の配列の時は消さずに 200 で消した数 0', async () => {
    const { deleteFactor } = buildService({
      listFactors: jest.fn().mockResolvedValue({ data: { factors: [] }, error: null }),
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(200);
    expect(res._body).toMatchObject({ success: true, deletedFactorCount: 0 });
    expect(deleteFactor).not.toHaveBeenCalled();
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

  it('DD-ADMIN-005 1件の削除が誤りの文付きで失敗した時は 500 で、消せた分を戻さず誤りの一覧を監査に書く', async () => {
    const deleteFactor = jest
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'cannot delete' } });
    buildService({ deleteFactor });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to delete one or more MFA factors' });
    expect(deleteFactor).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        detail: 'Failed to delete one or more factors',
        metadata: {
          reason: REASON,
          total_factors: 2,
          delete_errors: [{ factorId: 'f2', message: 'cannot delete' }],
        },
      }),
    );
  });

  it('DD-ADMIN-005 削除の誤りに文が無い時は failed_to_delete_factor を控えて 500', async () => {
    const deleteFactor = jest.fn().mockResolvedValue({ error: {} });
    buildService({
      listFactors: jest.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }] }, error: null }),
      deleteFactor,
    });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Failed to delete one or more MFA factors' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        metadata: expect.objectContaining({
          delete_errors: [{ factorId: 'f1', message: 'failed_to_delete_factor' }],
        }),
      }),
    );
  });

  it('DD-ADMIN-005 createServiceRoleClient が例外を投げた時は 500 Internal server error を返す', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no key'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalledWith('POST /api/admin/users/mfa/reset error:', expect.any(Error));
  });
});
