export {};

// 本物の認可（admin-rbac）と本物の監査（audit）を通し、外側の境界（トークンの検証・セッションの生存確認・
// service role の DB・Auth の管理の機能）だけを差し替える。窓口 → 認可 → 対象の確認 → 2要素の削除 → 監査の鎖を一緒に確かめる。
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
const { POST } = require('@/app/api/admin/users/mfa/reset/route');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const REASON = 'Lost the authenticator device';
const validBody = { userId: TARGET_ID, reason: REASON, confirm: 'RESET_MFA' };
const clientHeaders = { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'user-agent': 'jest-agent' };

let auditRows: any[];
let aclCodes: string[];
let getUserById: jest.Mock;
let listFactors: jest.Mock;
let deleteFactor: jest.Mock;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

function targetUser(appMetadata: unknown, extra: Record<string, unknown> = { email: 'target@example.com' }) {
  return { data: { user: { id: TARGET_ID, ...extra, app_metadata: appMetadata } }, error: null };
}

function installServiceClient() {
  const client = {
    auth: { admin: { getUserById, mfa: { listFactors, deleteFactor } } },
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
      throw new Error(`unexpected table ${table}`);
    },
  };
  createServiceRoleClient.mockResolvedValue(client);
  return client;
}

function signIn(claims: Record<string, unknown> = {}) {
  verifyAccessToken.mockResolvedValue({
    ok: true,
    claims: { sub: ACTOR_ID, email: 'admin@example.com', aal: 'aal2', session_id: 's1', app_metadata: { role: 'admin' }, ...claims },
  });
}

function makeRequest(body: unknown, headers: Record<string, string> = clientHeaders) {
  return new Request('http://localhost/api/admin/users/mfa/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  auditRows = [];
  aclCodes = ['admin.users.manage'];
  getUserById = jest.fn().mockResolvedValue(targetUser({ role: 'admin' }));
  listFactors = jest.fn().mockResolvedValue({ data: { factors: [{ id: 'f1' }, { id: 'f2' }] }, error: null });
  deleteFactor = jest.fn().mockResolvedValue({ error: null });
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

describe('POST /api/admin/users/mfa/reset', () => {
  describe('認可', () => {
    test('API-ADMIN-004 トークンが通らなければ 401 を返し、対象を引かず監査も書かない', async () => {
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'invalid' });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(401);
      expect(getUserById).not.toHaveBeenCalled();
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });

    test('API-ADMIN-004 セッションが失効していれば 401、確認できなければ 503 を返し、どちらも消さない', async () => {
      checkAuthSessionLiveness.mockResolvedValue('revoked');
      const revoked = await POST(makeRequest(validBody));

      checkAuthSessionLiveness.mockResolvedValue('unavailable');
      const unavailable = await POST(makeRequest(validBody));

      expect(revoked.status).toBe(401);
      expect(unavailable.status).toBe(503);
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });

    test('API-ADMIN-004 admin.users.manage を持たない人は 403 を返し、消さず監査も書かない', async () => {
      aclCodes = ['admin.users.read', 'admin.contact.manage'];

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ error: 'Forbidden', permission: 'admin.users.manage' }));
      expect(getUserById).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });

    test('API-ADMIN-004 権限があっても aal2 でなければ 403（MFA required）を返し、消さない', async () => {
      signIn({ aal: 'aal1' });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ reason: 'MFA required' }));
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });
  });

  describe('入力の検証', () => {
    test.each([
      ['userId が UUID でない', { ...validBody, userId: 'not-a-uuid' }, 'not-a-uuid'],
      ['userId が欠けている', { reason: REASON, confirm: 'RESET_MFA' }, null],
      ['理由が 9 文字', { ...validBody, reason: '123456789' }, TARGET_ID],
      ['理由が前後の空白を除くと 9 文字', { ...validBody, reason: '   123456789   ' }, TARGET_ID],
      ['理由が 501 文字', { ...validBody, reason: 'a'.repeat(501) }, TARGET_ID],
      ['理由が欠けている', { userId: TARGET_ID, confirm: 'RESET_MFA' }, TARGET_ID],
      ['確認の語が違う', { ...validBody, confirm: 'reset_mfa' }, TARGET_ID],
      ['確認の語が欠けている', { userId: TARGET_ID, reason: REASON }, TARGET_ID],
    ])('API-ADMIN-004 %s時は 400 を details 付きで返し、消さずに failure を IP とブラウザの情報付きで監査へ残す', async (_label, body, requested) => {
      const res = await POST(makeRequest(body));

      expect(res.status).toBe(400);
      expect(res._body.error).toBe('Invalid request');
      expect(res._body.details).toBeDefined();
      expect(getUserById).not.toHaveBeenCalled();
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          action: 'admin.users.mfa.reset',
          actor_id: ACTOR_ID,
          actor_email: 'admin@example.com',
          resource: 'users',
          resource_id: requested,
          outcome: 'failure',
          detail: 'Invalid request body',
          ip: '203.0.113.5',
          user_agent: 'jest-agent',
          metadata: { requested_user_id: requested },
        }),
      );
    });

    test.each([
      ['本文が JSON でない', 'not-json'],
      ['本文が null の JSON', 'null'],
      ['本文が配列', '[]'],
    ])('API-ADMIN-004 %s時も空の物として 400 を返し、failure を監査へ残す', async (_label, raw) => {
      const res = await POST(makeRequest(raw));

      expect(res.status).toBe(400);
      expect(res._body.error).toBe('Invalid request');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { requested_user_id: null } }),
      );
      expect(deleteFactor).not.toHaveBeenCalled();
    });

    test('API-ADMIN-004 理由は前後の空白を除いた 10 文字ちょうどと 500 文字ちょうどを受け付ける', async () => {
      const ten = await POST(makeRequest({ ...validBody, reason: '  1234567890  ' }));
      const max = await POST(makeRequest({ ...validBody, reason: 'a'.repeat(500) }));

      expect(ten.status).toBe(200);
      expect(max.status).toBe(200);
      expect(auditRows[0].metadata.reason).toBe('1234567890');
      expect(auditRows[1].metadata.reason).toHaveLength(500);
    });

    test('API-ADMIN-004 IP は x-forwarded-for の先頭だけを残し、ヘッダが無ければ空で監査へ残す', async () => {
      await POST(makeRequest({ ...validBody, confirm: 'x' }, { 'x-forwarded-for': '  198.51.100.7 , 10.0.0.9 ' }));
      await POST(makeRequest({ ...validBody, confirm: 'x' }, {}));

      expect(auditRows[0].ip).toBe('198.51.100.7');
      expect(auditRows[0].user_agent ?? null).toBeNull();
      expect(auditRows[1].ip ?? null).toBeNull();
      expect(auditRows[1].user_agent ?? null).toBeNull();
    });
  });

  describe('対象の確認', () => {
    test('API-ADMIN-004 自分自身は 400 で断り、対象を引かず failure を監査へ残す', async () => {
      const res = await POST(makeRequest({ ...validBody, userId: ACTOR_ID }));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'Self-reset is not allowed' });
      expect(getUserById).not.toHaveBeenCalled();
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          outcome: 'failure',
          detail: 'Self-reset is not allowed',
          resource_id: ACTOR_ID,
          ip: '203.0.113.5',
          user_agent: 'jest-agent',
        }),
      );
    });

    test.each([
      ['Auth が誤りを返す', { data: { user: null }, error: { message: 'User not found' } }],
      ['対象の利用者が空', { data: { user: null }, error: null }],
    ])('API-ADMIN-004 %s時は 404 を返し、消さずに failure を理由付きで監査へ残す', async (_label, result) => {
      getUserById.mockResolvedValue(result);

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(404);
      expect(res._body).toEqual({ error: 'User not found' });
      expect(getUserById).toHaveBeenCalledWith(TARGET_ID);
      expect(listFactors).not.toHaveBeenCalled();
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          outcome: 'failure',
          detail: 'Target user not found',
          resource_id: TARGET_ID,
          metadata: { reason: REASON },
        }),
      );
    });

    test.each([
      ['役割が user', { role: 'user' }, 'user'],
      ['役割が知らない値', { role: 'owner' }, 'user'],
      ['付帯の情報が空', null, 'user'],
      ['付帯の情報が文字列', 'admin', 'user'],
      ['役割が文字列でない', { role: 7 }, 'user'],
    ])('API-ADMIN-004 対象の%sなら 400 で断り、消さずに対象の役割付きで failure を監査へ残す', async (_label, appMetadata, role) => {
      getUserById.mockResolvedValue(targetUser(appMetadata));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'MFA reset is available only for privileged users' });
      expect(listFactors).not.toHaveBeenCalled();
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          outcome: 'failure',
          detail: 'Target user is not privileged',
          metadata: { reason: REASON, target_role: role },
        }),
      );
    });

    test('API-ADMIN-004 対象の役割は Auth の付帯の情報で決め、実行した人のトークンの役割では決めない', async () => {
      signIn({ app_metadata: { role: 'user' } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(deleteFactor).toHaveBeenCalledTimes(2);
    });
  });

  describe('2要素の削除', () => {
    test('API-ADMIN-004 店長の 2要素を 1 つずつ消して 200 を返す', async () => {
      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(res._body).toEqual({
        success: true,
        deletedFactorCount: 2,
        message: 'MFA factors were reset. The user must sign in again and enroll MFA.',
      });
      expect(listFactors).toHaveBeenCalledWith({ userId: TARGET_ID });
      expect(deleteFactor).toHaveBeenCalledTimes(2);
      expect(deleteFactor).toHaveBeenNthCalledWith(1, { userId: TARGET_ID, id: 'f1' });
      expect(deleteFactor).toHaveBeenNthCalledWith(2, { userId: TARGET_ID, id: 'f2' });
    });

    test('API-ADMIN-004 success を理由・対象の役割・対象のメール・消した数と IP・ブラウザの情報付きで監査へ残す', async () => {
      await POST(makeRequest(validBody));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
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
        }),
      );
    });

    test('API-ADMIN-004 サポート担当の 2要素も消せ、対象にメールが無ければ監査のメールは空になる', async () => {
      getUserById.mockResolvedValue(targetUser({ role: 'supporter' }, {}));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(auditRows[0].metadata).toEqual({
        reason: REASON,
        target_role: 'supporter',
        target_email: null,
        deleted_factor_count: 2,
      });
    });

    test('API-ADMIN-004 登録が 0 件なら何も消さずに 200 deletedFactorCount 0 を返し、success を監査へ残す', async () => {
      listFactors.mockResolvedValue({ data: { factors: [] }, error: null });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(res._body).toEqual(expect.objectContaining({ success: true, deletedFactorCount: 0 }));
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'success' }));
      expect(auditRows[0].metadata.deleted_factor_count).toBe(0);
    });

    test.each([
      ['一覧が配列でない', { factors: 'oops' }],
      ['一覧が無い', {}],
      ['要素が物でない', { factors: [{ id: 'f1' }, 'bad'] }],
      ['id が空の要素がある', { factors: [{ id: 'f1' }, { id: '' }] }],
    ])('API-ADMIN-004 現状は%s時に一覧を丸ごと空とみなし、何も消さずに 200 deletedFactorCount 0 を返す', async (_label, data) => {
      listFactors.mockResolvedValue({ data, error: null });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(200);
      expect(res._body).toEqual(expect.objectContaining({ deletedFactorCount: 0 }));
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'success' }));
    });

    test('API-ADMIN-004 一覧の取得が誤りなら 500 を返し、消さずに誤りの文付きで error を監査へ残す', async () => {
      listFactors.mockResolvedValue({ data: null, error: { message: 'list failed' } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to list target MFA factors' });
      expect(deleteFactor).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          outcome: 'error',
          detail: 'Failed to list target MFA factors',
          metadata: { reason: REASON, error_message: 'list failed' },
        }),
      );
    });

    test('API-ADMIN-004 1 つ消せなくても残りは消そうとし、500 を返して失敗した登録を監査へ残す', async () => {
      listFactors.mockResolvedValue({ data: { factors: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] }, error: null });
      deleteFactor.mockImplementation(async ({ id }: { id: string }) => (id === 'f2' ? { error: { message: 'boom' } } : { error: null }));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to delete one or more MFA factors' });
      expect(deleteFactor).toHaveBeenCalledTimes(3);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          outcome: 'error',
          detail: 'Failed to delete one or more factors',
          metadata: { reason: REASON, total_factors: 3, delete_errors: [{ factorId: 'f2', message: 'boom' }] },
        }),
      );
      expect(auditRows.some((row) => row.outcome === 'success')).toBe(false);
    });

    test('API-ADMIN-004 消す誤りに文が無ければ failed_to_delete_factor を監査へ残す', async () => {
      listFactors.mockResolvedValue({ data: { factors: [{ id: 'f1' }] }, error: null });
      deleteFactor.mockResolvedValue({ error: {} });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(auditRows[0].metadata.delete_errors).toEqual([{ factorId: 'f1', message: 'failed_to_delete_factor' }]);
    });

    test('API-ADMIN-004 全部の登録が消せなかった時も 500 を返し、失敗を 1 件ずつ監査へ残す', async () => {
      deleteFactor.mockResolvedValue({ error: { message: 'nope' } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(auditRows[0].metadata.delete_errors).toEqual([
        { factorId: 'f1', message: 'nope' },
        { factorId: 'f2', message: 'nope' },
      ]);
    });
  });

  describe('例外', () => {
    test('API-ADMIN-004 対象を引く呼び出しが例外を投げたら 500 を返し、消さない', async () => {
      getUserById.mockRejectedValue(new Error('network'));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(deleteFactor).not.toHaveBeenCalled();
    });

    test('API-ADMIN-004 消す呼び出しが例外を投げたら 500 を返し、success を監査へ残さない', async () => {
      deleteFactor.mockRejectedValue(new Error('network'));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(auditRows.some((row) => row.outcome === 'success')).toBe(false);
    });

    test('API-ADMIN-004 認可の後で service role を作れなければ 500 を返し、消さない', async () => {
      const base = installServiceClient();
      let n = 0;
      // 1 回目は認可の ACL の照会、2 回目が窓口自身の分
      createServiceRoleClient.mockImplementation(async () => {
        n += 1;
        if (n === 2) throw new Error('no client');
        return base;
      });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(deleteFactor).not.toHaveBeenCalled();
    });
  });
});
