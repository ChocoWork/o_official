export {};
jest.mock('server-only', () => ({}), { virtual: true });

// 会員登録の窓口（API-AUTH-005）。公開の登録の順番・失敗の分岐・宛先単位の枠と、管理の見出しが効かないことを確かめる。
// 登録済みかどうかで応答を変えないこと（ARC-AUTH-006）は register-enumeration.test.ts が担当する。

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
jest.mock('@/lib/audit', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockLogAudit(...args),
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

// 戻り先の控えの保存だけを差し替える（確かめと Cookie の動作は本物）
const mockCreateReturnIntent = jest.fn();
jest.mock('@/features/auth/return-intent/return-intent-store', () => ({
  ...jest.requireActual('@/features/auth/return-intent/return-intent-store'),
  createReturnIntent: (...args: unknown[]) => mockCreateReturnIntent(...args),
}));

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
    mockCreateReturnIntent.mockResolvedValue({ token: 'R'.repeat(43), maxAgeSeconds: 3600 });
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

  test('API-AUTH-005 制限の部品が落ちたら 500 で止まり、登録の処理へ進まない（SEC-AUTH-013-AC-02）', async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error('rate limit down'));

    const res = await handler(publicRequest());

    expect(res.status).toBe(500);
    expect(mockVerifyTurnstile).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
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

  test('API-AUTH-005 Turnstile へ x-real-ip の IP と token を渡す', async () => {
    await handler(publicRequest({ turnstileToken: 'tok-1' }, { 'x-real-ip': '203.0.113.9' }));

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

  test('API-AUTH-005 新規は 202 の固定の本文を返し、確認のリンクはクエリの無い /api/auth/confirm で signUp する', async () => {
    const res = await handler(publicRequest({ display_name: '花子', next: '/account/orders' }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: PASSWORD,
      options: {
        data: { display_name: '花子' },
        emailRedirectTo: 'http://localhost:3000/api/auth/confirm',
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

  test('API-AUTH-005 next が通ると signup の用途で控え、控えの Cookie（HttpOnly・Lax・Max-Age 3600）を付ける。番号は本文に出ない', async () => {
    const res = await handler(publicRequest({ next: '/account/orders' }));

    expect(mockCreateReturnIntent).toHaveBeenCalledWith({
      returnPath: '/account/orders',
      purpose: 'signup',
      bindTo: 'new@example.com',
    });
    expect(res.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sb-return-intent',
        value: 'R'.repeat(43),
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 3600,
      }),
    );
    expect(JSON.stringify(await res.json())).not.toContain('R'.repeat(43));
  });

  test.each([
    ['外部の住所', { next: 'https://evil.example.net/' }],
    ['プロトコル相対', { next: '//evil.example.net/' }],
    ['バックスラッシュ入り', { next: '/\\evil.example.net' }],
    ['タブ入り', { next: '/\t/evil.example.net' }],
    ['解釈で外へ向く', { next: '/.//evil.example.net' }],
    ['数値', { next: 123 }],
    ['指定なし', {}],
  ])('API-AUTH-005 戻り先が内部の道でなければ、登録は 202 のまま戻り先を既定の / にして控えを作り、控えの Cookie を付ける（%s）', async (_label, override) => {
    const res = await handler(publicRequest(override));

    expect(res.status).toBe(202);
    expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/', purpose: 'signup', bindTo: 'new@example.com' });
    expect(res.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sb-return-intent', value: 'R'.repeat(43), maxAge: 3600 }),
    );
    expect(new URL(mockSignUp.mock.calls[0][0].options.emailRedirectTo).search).toBe('');
  });

  test.each([
    ['redirect_to', { redirect_to: '/account' }],
    ['emailRedirectTo', { emailRedirectTo: '/account' }],
  ])('API-AUTH-005 古いクライアントが送る %s は戻り先として読まれず（既定の / のまま）、確認のリンクにも載らない', async (_label, override) => {
    const res = await handler(publicRequest(override));

    expect(res.status).toBe(202);
    expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/', purpose: 'signup', bindTo: 'new@example.com' });
    expect(mockSignUp.mock.calls[0][0].options.emailRedirectTo).toBe('http://localhost:3000/api/auth/confirm');
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

    test('API-AUTH-005 201 で { user: { id, email } } だけを返し（access_token・利用者の記録は載せない）、Cookie とゲストの印を引き継いで保存する', async () => {
      const res = await handler(publicRequest({}, { cookie: 'unrelated=1' }));

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ user: { id: 'u1', email: 'new@example.com' } });
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

describe('API-AUTH-005 POST /api/auth/register 管理の見出しと宛先単位の枠', () => {
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
    mockCreateReturnIntent.mockResolvedValue({ token: 'R'.repeat(43), maxAgeSeconds: 3600 });
  });

  afterAll(() => errorSpy.mockRestore());

  test.each([
    ['x-admin-token', { 'x-admin-token': 'test-admin-key' }],
    ['Authorization: Bearer', { authorization: 'Bearer test-admin-key' }],
    ['違う x-admin-token', { 'x-admin-token': 'wrong' }],
  ])('API-AUTH-005 管理の見出し（%s）を付けても公開の登録として扱い、createUser を呼ばず Turnstile を通す', async (_label, headers) => {
    process.env.ADMIN_API_KEY = 'test-admin-key';
    try {
      const res = await handler(publicRequest({}, headers));

      expect(res.status).toBe(202);
      expect(mockCreateUser).not.toHaveBeenCalled();
      expect(mockVerifyTurnstile).toHaveBeenCalledTimes(1);
      expect(mockCheckPwnedPassword).toHaveBeenCalledTimes(1);
      expect(mockSignUp).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unauthorized' }));
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });

  test('API-AUTH-005 管理の見出しを付けて Turnstile が通らなければ 403 で、アカウントを作らない', async () => {
    mockVerifyTurnstile.mockResolvedValue({ ok: false });

    const res = await handler(publicRequest({}, { 'x-admin-token': 'anything' }));

    expect(res.status).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  test('API-AUTH-005 鍵が未設定でも管理の見出しで 500 にならず、公開の登録として 202 を返す', async () => {
    delete process.env.ADMIN_API_KEY;

    const res = await handler(publicRequest({}, { 'x-admin-token': 'anything' }));

    expect(res.status).toBe(202);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  test('API-AUTH-005 宛先単位の枠は、小文字にしたメールを subject に 5 回／3600 秒で数える（IP の枠とは別に 2 回）', async () => {
    await handler(publicRequest());

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ endpoint: 'auth:register', limit: 20, windowSeconds: 3600 }),
    );
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ endpoint: 'auth:register', limit: 5, windowSeconds: 3600, subject: 'new@example.com' }),
    );
  });

  test('API-AUTH-005 宛先の枠が 429 を返したら、控えも照会も signUp も呼ばずその応答を返す', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    mockEnforceRateLimit.mockImplementation(async (arg: { subject?: string }) => (arg.subject ? limited : undefined));

    const res = await handler(publicRequest({ next: '/look' }));

    expect(res).toBe(limited);
    expect(mockVerifyTurnstile).toHaveBeenCalledTimes(1);
    expect(mockCheckPwnedPassword).toHaveBeenCalledTimes(1);
    expect(mockCreateReturnIntent).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  test('API-AUTH-005 Turnstile・漏洩の確かめを通らなかった要求は宛先の枠を数えない（他人の枠を潰させない）', async () => {
    mockVerifyTurnstile.mockResolvedValueOnce({ ok: false });
    await handler(publicRequest());
    mockCheckPwnedPassword.mockResolvedValueOnce({ status: 'pwned' });
    await handler(publicRequest());

    const subjects = mockEnforceRateLimit.mock.calls.map(([arg]) => arg.subject).filter(Boolean);
    expect(subjects).toEqual([]);
  });
});
