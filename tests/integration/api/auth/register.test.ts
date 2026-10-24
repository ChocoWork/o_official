export {};
jest.mock('server-only', () => ({}), { virtual: true });

// 会員登録の窓口（API-AUTH-005）。公開の登録の順番・失敗の分岐と、管理の見出しの経路を確かめる。
// 登録済みかどうかで応答を変えないこと（ARC-AUTH-006）は register-enumeration.test.ts が担当する。

process.env.ADMIN_API_KEY = 'test-admin-key';

const afterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: { set: jest.fn() },
    }),
  },
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockVerifyTurnstile = jest.fn();
jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => mockVerifyTurnstile(...args),
}));

// 漏洩パスワードの照合は外部 API を叩く。テストからネットワークへ出さない。
const mockCheckPwnedPassword = jest.fn();
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: (...args: unknown[]) => mockCheckPwnedPassword(...args),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));

const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/ops/site-url-alert', () => ({ notifySiteUrlInvalid: jest.fn().mockResolvedValue(undefined) }), { virtual: true });

const mockPersistSessionAndCookies = jest.fn();
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => mockPersistSessionAndCookies(...args),
}));

const mockSignUp = jest.fn();
const mockRpc = jest.fn();
const mockCreateUser = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: (...a: unknown[]) => mockSignUp(...a) } }),
  createServiceRoleClient: async () => ({
    rpc: (...a: unknown[]) => mockRpc(...a),
    auth: { admin: { createUser: (...a: unknown[]) => mockCreateUser(...a) } },
  }),
}));

const PASSWORD = 'Passw0rd!23456789';

function publicRequest(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'New@Example.com', password: PASSWORD, turnstileToken: 't', ...body }),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function auditCalls(outcome: string) {
  return mockLogAudit.mock.calls.map(([arg]) => arg).filter((arg) => arg.outcome === outcome);
}

describe('API-AUTH-005 POST /api/auth/register 公開の登録', () => {
  let handler: (request: Request) => Promise<any>;
  const errorSpy = jest.spyOn(console, 'error');

  beforeAll(async () => {
    handler = (await import('@/app/api/auth/register/route')).POST as typeof handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy.mockImplementation(() => undefined);
    afterCallbacks.length = 0;
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockVerifyTurnstile.mockResolvedValue({ ok: true });
    mockCheckPwnedPassword.mockResolvedValue({ status: 'ok' });
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockSignUp.mockResolvedValue({ data: { session: null, user: { id: 'new-1' } }, error: null });
    mockPersistSessionAndCookies.mockResolvedValue({ ok: true });
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterAll(() => errorSpy.mockRestore());

  test('API-AUTH-005 IP の制限に当たったらその応答を返し、Turnstile も登録も呼ばない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    mockEnforceRateLimit.mockResolvedValue(limited);

    const res = await handler(publicRequest());

    expect(res).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:register', limit: 20, windowSeconds: 3600 }),
    );
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  test('API-AUTH-005 制限の部品が落ちても登録の処理は止めない', async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error('rate limit down'));

    const res = await handler(publicRequest());

    expect(res.status).toBe(202);
    expect(mockSignUp).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['メールの形が不正', { email: 'not-an-email' }],
    ['16 文字未満のパスワード', { password: 'short-pass-15ch' }],
    ['パスワードが 128 文字超', { password: 'a'.repeat(129) }],
  ])('API-AUTH-005 形が不正（%s）なら 400 で、Turnstile も照会も呼ばない', async (_label, override) => {
    const res = await handler(publicRequest(override));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'validation_error' });
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  test('API-AUTH-005 本文が JSON でなければ 500 の汎用の応答で、内部の理由を出さない', async () => {
    const req = new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });

    const res = await handler(req);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-AUTH-005 Turnstile に落ちたら 403 で、照会も signUp も漏洩の照合も呼ばず監査に残す', async () => {
    mockVerifyTurnstile.mockResolvedValue({ ok: false, error: 'timeout-or-duplicate' });

    const res = await handler(publicRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Bot detection failed' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockCheckPwnedPassword).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'failure', detail: 'timeout-or-duplicate', actor_email: 'new@example.com' }),
    );
  });

  test('API-AUTH-005 Turnstile へ x-forwarded-for の先頭の IP と token を渡す', async () => {
    await handler(publicRequest({ turnstileToken: 'tok-1' }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));

    expect(mockVerifyTurnstile).toHaveBeenCalledWith('tok-1', '203.0.113.9');
  });

  test('API-AUTH-005 漏洩済みのパスワードは 400 で弾き、照会も signUp も呼ばず監査に残す', async () => {
    mockCheckPwnedPassword.mockResolvedValue({ status: 'pwned' });

    const res = await handler(publicRequest());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'failure', detail: 'pwned_password' }),
    );
  });

  test('API-AUTH-005 漏洩の照合先が落ちていても登録は進め、止めた理由ではなく検査が効かなかった事実を監査に残す', async () => {
    mockCheckPwnedPassword.mockResolvedValue({ status: 'unavailable', reason: 'timeout' });

    const res = await handler(publicRequest());

    expect(res.status).toBe(202);
    expect(mockSignUp).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'error', detail: 'pwned_check_unavailable:timeout' }),
    );
  });

  test('API-AUTH-005 新規は 202 の固定の本文を返し、確認のリンクに送り先を載せて signUp する', async () => {
    const res = await handler(publicRequest({ display_name: '花子', redirect_to: '/account/orders' }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: PASSWORD,
      options: {
        data: { display_name: '花子' },
        emailRedirectTo: 'http://localhost:3000/api/auth/confirm?redirect_to=%2Faccount%2Forders',
      },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'created_needs_confirmation', actor_email: 'new@example.com' }),
    );
  });

  test('API-AUTH-005 表示名が無ければ user_metadata を付けない', async () => {
    await handler(publicRequest());

    expect(mockSignUp.mock.calls[0][0].options.data).toBeUndefined();
  });

  test.each([
    ['外部の住所', { redirect_to: 'https://evil.example.net/' }],
    ['プロトコル相対', { redirect_to: '//evil.example.net/' }],
    ['バックスラッシュ入り', { redirect_to: '/\\evil.example.net' }],
    ['指定なし', {}],
  ])('API-AUTH-005 送り先が内部の道でなければ既定の /auth/verified に直す（%s）', async (_label, override) => {
    await handler(publicRequest(override));

    const url = new URL(mockSignUp.mock.calls[0][0].options.emailRedirectTo);
    expect(url.pathname).toBe('/api/auth/confirm');
    expect(url.searchParams.get('redirect_to')).toBe('/auth/verified');
  });

  test('API-AUTH-005 redirect_to が無ければ emailRedirectTo を送り先に使う', async () => {
    await handler(publicRequest({ emailRedirectTo: '/account' }));

    const url = new URL(mockSignUp.mock.calls[0][0].options.emailRedirectTo);
    expect(url.searchParams.get('redirect_to')).toBe('/account');
  });

  test('API-AUTH-005 重複と見なせない signUp の失敗は 500 で、本文に内部の理由を出さず監査に残す', async () => {
    mockSignUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'smtp exploded' } });

    const res = await handler(publicRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create user' });
    expect(afterCallbacks).toHaveLength(0);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'error', detail: 'smtp exploded' }),
    );
  });

  describe('確認のメールが要らない設定（Confirm email が OFF）', () => {
    const session = { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1_900_000_000 };
    const user = { id: 'u1', email: 'new@example.com' };

    beforeEach(() => {
      mockSignUp.mockResolvedValue({ data: { session, user }, error: null });
    });

    test('API-AUTH-005 201 で access token と会員を返し、Cookie とゲストの印を引き継いで保存する', async () => {
      const res = await handler(publicRequest({}, { cookie: 'unrelated=1' }));

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ access_token: 'access-1', user });
      expect(mockPersistSessionAndCookies).toHaveBeenCalledWith(
        res,
        session,
        user,
        { cartToken: null, wishlistToken: null },
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'register', outcome: 'success', resource_id: 'u1' }),
      );
    });

    test('API-AUTH-005 保存に失敗したら認証の Cookie を 3 つとも空にして 500 を返し、理由は監査だけに残す', async () => {
      mockPersistSessionAndCookies.mockResolvedValue({ ok: false, error: 'db insert failed' });

      const res = await handler(publicRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      // 空にする対象は、保存を頼んだ 201 用の応答。返ってくる 500 の応答とは別の物
      const pending = mockPersistSessionAndCookies.mock.calls[0][0];
      const cleared = (pending.cookies.set as jest.Mock).mock.calls.map(([arg]) => arg);
      expect(cleared.map((c) => c.name).sort()).toEqual(['sb-access-token', 'sb-csrf-token', 'sb-refresh-token']);
      expect(cleared.every((c) => c.value === '')).toBe(true);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: db insert failed', resource_id: 'u1' }),
      );
    });

    test('API-AUTH-005 保存が例外で落ちても Cookie を空にして 500 を返す', async () => {
      mockPersistSessionAndCookies.mockRejectedValue(new Error('boom'));

      const res = await handler(publicRequest());

      expect(res.status).toBe(500);
      const pending = mockPersistSessionAndCookies.mock.calls[0][0];
      expect((pending.cookies.set as jest.Mock).mock.calls).toHaveLength(3);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'Error: boom' }),
      );
    });

    test('API-AUTH-005 session があるのに会員が無ければ 500 で、Cookie を保存しない', async () => {
      mockSignUp.mockResolvedValue({ data: { session, user: null }, error: null });

      const res = await handler(publicRequest());

      expect(res.status).toBe(500);
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'missing_user_after_signup' }),
      );
    });
  });
});

describe('API-AUTH-005 POST /api/auth/register 管理の見出し', () => {
  let handler: (request: Request) => Promise<any>;
  const errorSpy = jest.spyOn(console, 'error');

  beforeAll(async () => {
    handler = (await import('@/app/api/auth/register/route')).POST as typeof handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy.mockImplementation(() => undefined);
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockCreateUser.mockResolvedValue({ data: { user: { id: 'admin-user-1', email: 'new@example.com' } }, error: null });
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterAll(() => errorSpy.mockRestore());

  test('API-AUTH-005 x-admin-token が合えば Turnstile・漏洩の照合・照会を通らず service role で作り 201 を返す', async () => {
    const res = await handler(publicRequest({ display_name: '管理' }, { 'x-admin-token': 'test-admin-key' }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'admin-user-1', email: 'new@example.com' });
    expect(mockCreateUser).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: PASSWORD,
      user_metadata: { display_name: '管理' },
    });
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
    expect(mockCheckPwnedPassword).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'success', resource_id: 'admin-user-1' }),
    );
  });

  test('API-AUTH-005 Authorization の Bearer でも同じ管理の経路に入る', async () => {
    const res = await handler(publicRequest({}, { authorization: 'Bearer test-admin-key' }));

    expect(res.status).toBe(201);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-005 鍵が違えば 401 で、アカウントを作らず監査に残す', async () => {
    const res = await handler(publicRequest({}, { 'x-admin-token': 'wrong' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'unauthorized' }),
    );
  });

  test('API-AUTH-005 鍵が未設定なのに見出しが付いたら 500 で、アカウントを作らない', async () => {
    delete process.env.ADMIN_API_KEY;

    const res = await handler(publicRequest({}, { 'x-admin-token': 'anything' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Server misconfiguration' });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  test('API-AUTH-005 登録済みの作成の失敗は 409 で、監査に conflict を残す', async () => {
    mockCreateUser.mockResolvedValue({ data: { user: null }, error: { message: 'User already registered' } });

    const res = await handler(publicRequest({}, { 'x-admin-token': 'test-admin-key' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Email already registered' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'conflict' }),
    );
  });

  test('API-AUTH-005 登録済み以外の作成の失敗は 500 で、本文に理由を出さない', async () => {
    mockCreateUser.mockResolvedValue({ data: { user: null }, error: { message: 'db down' } });

    const res = await handler(publicRequest({}, { 'x-admin-token': 'test-admin-key' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create user' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'register', outcome: 'error', detail: 'db down' }),
    );
  });
});
