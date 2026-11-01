export {};

// 本物の認可（admin-rbac）と本物の監査（audit）を通し、外側の境界（トークンの検証・セッションの生存確認・
// service role の DB・Auth の管理の機能）だけを差し替える。窓口 → 認可 → 監査の鎖を一緒に確かめる。
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
// 回数の制限は DB に触り、漏洩の照合は外部の API を呼ぶので差し替える（呼ばれ方は窓口の単体試験で確かめる）
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: jest.fn(),
  PWNED_PASSWORD_MESSAGE: 'pwned-message',
}));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken, checkAuthSessionLiveness } = require('@/lib/auth/authenticate');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { checkPwnedPassword } = require('@/lib/pwned-password');
const { POST } = require('@/app/api/admin/create-user/route');

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const NEW_USER_ID = '33333333-3333-4333-8333-333333333333';
const validBody = { email: 'new@example.com', password: 'password-1234-ok', display_name: '新人' };

let auditRows: any[];
let createUser: jest.Mock;
let aclCodes: string[];
let aclError: unknown;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

/** user_roles の ACL の照会と audit_logs の挿入を持つ service role の代役。 */
function installServiceClient() {
  createServiceRoleClient.mockResolvedValue({
    auth: { admin: { createUser } },
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
          or: async () =>
            aclError
              ? { data: null, error: aclError }
              : { data: [{ roles: { role_permissions: aclCodes.map((code) => ({ permissions: { code } })) } }], error: null },
        };
        return chain;
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

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/admin/create-user', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  auditRows = [];
  aclCodes = ['admin.users.manage'];
  aclError = null;
  createUser = jest.fn().mockResolvedValue({ data: { user: { id: NEW_USER_ID, email: validBody.email } }, error: null });
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  installServiceClient();
  checkAuthSessionLiveness.mockResolvedValue('active');
  enforceRateLimit.mockResolvedValue(undefined);
  checkPwnedPassword.mockResolvedValue({ status: 'ok' });
  signIn();
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('POST /api/admin/create-user', () => {
  describe('認可', () => {
    test('API-ADMIN-001 トークンが通らなければ 401 を返し、利用者を作らず監査も書かない', async () => {
      verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(401);
      expect(res._body).toEqual({ error: 'Unauthorized' });
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });

    test('API-ADMIN-001 セッションが失効していれば 401、確認できなければ 503 を返し、どちらも作らない', async () => {
      checkAuthSessionLiveness.mockResolvedValue('revoked');
      const revoked = await POST(makeRequest(validBody));

      checkAuthSessionLiveness.mockResolvedValue('unavailable');
      const unavailable = await POST(makeRequest(validBody));

      expect(revoked.status).toBe(401);
      expect(unavailable.status).toBe(503);
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });

    test('API-ADMIN-001 admin.users.manage を持たない人は 403 で、作らず監査も書かない', async () => {
      aclCodes = ['admin.users.read', 'admin.contact.manage'];

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ error: 'Forbidden', permission: 'admin.users.manage' }));
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });

    test('API-ADMIN-001 トークンの役割が admin でも ACL に権限が無ければ 403（権限は ACL で決まる）', async () => {
      aclCodes = [];

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(403);
      expect(createUser).not.toHaveBeenCalled();
    });

    test('API-ADMIN-001 トークンの役割が user でも ACL に権限があれば作れる', async () => {
      signIn({ app_metadata: { role: 'user' } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(201);
      expect(createUser).toHaveBeenCalledTimes(1);
    });

    test('API-ADMIN-001 ACL の照会が失敗したら権限なしとして 403 を返す', async () => {
      aclError = { message: 'db down' };

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(403);
      expect(createUser).not.toHaveBeenCalled();
    });

    test('API-ADMIN-001 権限があっても aal2 でなければ 403（MFA required）で、作らない', async () => {
      signIn({ aal: 'aal1' });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(403);
      expect(res._body).toEqual(expect.objectContaining({ reason: 'MFA required', permission: 'admin.users.manage' }));
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });
  });

  describe('入力の検証', () => {
    test.each([
      ['メールの形でない', { ...validBody, email: 'not-an-email' }],
      ['メールが欠けている', { password: 'password-1234-ok' }],
      ['パスワードが 15 文字しか無い', { ...validBody, password: 'a'.repeat(15) }],
      ['パスワードが 129 文字ある', { ...validBody, password: 'a'.repeat(129) }],
      ['display_name が 101 文字ある', { ...validBody, display_name: 'あ'.repeat(101) }],
      ['パスワードが欠けている', { email: 'new@example.com' }],
      ['display_name が文字列でない', { ...validBody, display_name: 123 }],
      ['本文が配列である', []],
    ])('API-ADMIN-001 %s時は 400 を返し、作らずに failure を監査へ残す', async (_label, body) => {
      const res = await POST(makeRequest(body));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'Invalid request' });
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          action: 'admin_create_user',
          actor_id: ACTOR_ID,
          actor_email: 'admin@example.com',
          resource: 'users',
          outcome: 'failure',
          detail: 'Invalid request body',
        }),
      );
    });

    test('API-ADMIN-001 パスワードがちょうど 16 文字なら受け付ける', async () => {
      const password = 'a'.repeat(16);
      const res = await POST(makeRequest({ ...validBody, password }));

      expect(res.status).toBe(201);
      expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ password }));
    });

    test('API-ADMIN-001 本文の JSON が壊れていれば 400 を返し、作らず failure を監査へ残す', async () => {
      const res = await POST(makeRequest('{not json'));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'Invalid request' });
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'failure', detail: 'Invalid request body' }));
    });

    test('API-ADMIN-001 漏洩済みのパスワードは 400 で作らず、pwned_password を監査へ残してパスワードは残さない', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'pwned', count: 5 });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(400);
      expect(res._body).toEqual({ error: 'pwned-message' });
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'failure', detail: 'pwned_password' }));
      expect(JSON.stringify(auditRows)).not.toContain(validBody.password);
    });

    test('API-ADMIN-001 漏洩の照合が使えなくても作成は通り、pwned_check_unavailable を監査へ残す', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'unavailable', reason: 'timeout' });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(201);
      expect(auditRows.map((row) => [row.outcome, row.detail ?? null])).toEqual([
        ['error', 'pwned_check_unavailable:timeout'],
        ['success', null],
      ]);
    });

    test('API-ADMIN-001 回数の枠を超えたら 429 を返し、作らず監査も書かない', async () => {
      enforceRateLimit.mockResolvedValue({ status: 429, _body: { error: 'Too many requests' } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(429);
      expect(enforceRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'admin:users:create', limit: 20, windowSeconds: 600, subject: ACTOR_ID }),
      );
      expect(createUser).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);
    });
  });

  describe('作成', () => {
    test('API-ADMIN-001 作れたら 201 で id とメールだけを返し、success を作られた id 付きで監査へ残す', async () => {
      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(201);
      expect(res._body).toEqual({ id: NEW_USER_ID, email: validBody.email });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({
          action: 'admin_create_user',
          actor_id: ACTOR_ID,
          actor_email: 'admin@example.com',
          resource: 'users',
          resource_id: NEW_USER_ID,
          outcome: 'success',
        }),
      );
    });

    test('API-ADMIN-001 表示名を付帯の情報へ入れ、確認済みの印（email_confirm: true）を付けて作り、役割は渡さない', async () => {
      await POST(makeRequest(validBody));

      expect(createUser).toHaveBeenCalledTimes(1);
      const arg = createUser.mock.calls[0][0];
      expect(arg).toEqual({
        email: validBody.email,
        password: validBody.password,
        email_confirm: true,
        user_metadata: { display_name: '新人' },
      });
      expect(arg).not.toHaveProperty('app_metadata');
    });

    test('API-ADMIN-001 display_name が無くても作れる', async () => {
      const res = await POST(makeRequest({ email: validBody.email, password: validBody.password }));

      expect(res.status).toBe(201);
      expect(createUser.mock.calls[0][0].user_metadata.display_name).toBeUndefined();
    });

    test('API-ADMIN-001 監査にパスワードを残さない', async () => {
      await POST(makeRequest(validBody));

      expect(JSON.stringify(auditRows)).not.toContain(validBody.password);
    });

    test.each([
      ['already を含む', 'User already registered'],
      ['duplicate を含む（大文字小文字を問わない）', 'Duplicate key value violates unique constraint'],
    ])('API-ADMIN-001 Auth の誤りの文が %s時は 409 を返し、conflict を固定の符号で監査へ残す', async (_label, message) => {
      createUser.mockResolvedValue({ data: { user: null }, error: { message } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(409);
      expect(res._body).toEqual({ error: 'Email already registered' });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(
        expect.objectContaining({ outcome: 'conflict', detail: 'email_already_registered', resource: 'users' }),
      );
      expect(JSON.stringify(auditRows)).not.toContain(message);
      expect(auditRows[0].resource_id ?? null).toBeNull();
    });

    test('API-ADMIN-001 ほかの Auth の誤りは 500 で、内部の文を返さず error を固定の符号で監査へ残す', async () => {
      createUser.mockResolvedValue({ data: { user: null }, error: { message: 'Database error saving new user' } });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Failed to create user' });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'error', detail: 'create_user_failed' }));
      expect(JSON.stringify(auditRows)).not.toContain('Database error saving new user');
    });

    test('API-ADMIN-001 誤りに文が無くても 500 を返す', async () => {
      createUser.mockResolvedValue({ data: { user: null }, error: {} });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(auditRows[0]).toEqual(expect.objectContaining({ outcome: 'error' }));
    });

    test('API-ADMIN-001 Auth の呼び出しが例外を投げたら 500 を返し、成功を監査へ残さない', async () => {
      createUser.mockRejectedValue(new Error('network'));

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(500);
      expect(res._body).toEqual({ error: 'Internal server error' });
      expect(auditRows.some((row) => row.outcome === 'success')).toBe(false);
    });

    test('API-ADMIN-001 監査の書き込みが失敗しても作成の結果は 201 のまま返る', async () => {
      createServiceRoleClient.mockResolvedValue({
        auth: { admin: { createUser } },
        from: (table: string) =>
          table === 'audit_logs'
            ? { insert: async () => ({ error: { message: 'insert failed' } }) }
            : {
                select() { return this; },
                eq() { return this; },
                or: async () => ({ data: [{ roles: { role_permissions: [{ permissions: { code: 'admin.users.manage' } }] } }], error: null }),
              },
      });

      const res = await POST(makeRequest(validBody));

      expect(res.status).toBe(201);
      expect(res._body).toEqual({ id: NEW_USER_ID, email: validBody.email });
    });
  });
});
