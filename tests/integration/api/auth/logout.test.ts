export {};

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
  verifyAccessToken: jest.fn(),
}));

// ログアウトは期限切れトークンからも session_id を読む必要があるため
// authenticateRequest ではなく verifyAccessToken を直接使う。
jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// 通常は本物の CSRF の確かめを通し、断られた時の動きだけ差し替える。
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const { cookies, headers } = require('next/headers');
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyAccessToken } = require('@/lib/auth/authenticate');
const { logAudit } = require('@/lib/audit');
const { requireCsrfOrDeny } = require('@/lib/csrfMiddleware');
let logoutHandler: any;

const CSRF_TOKEN = 'valid-csrf-token';

const ALWAYS_CLEARED_COOKIES = [
  'session_id',
  'sb-refresh-token',
  'sb-access-token',
  'sb-csrf-token',
  'sb-login-2fa-session',
  'sb-password-reset-session',
  'sb-return-intent',
  'cart',
  'wishlist',
];

const expectCleared = (res: any, names: string[]) => {
  for (const name of names) {
    const cookie = res.cookies.get(name);
    expect(cookie).toBeDefined();
    expect(cookie.maxAge).toBe(0);
    expect(cookie.value).toBe('');
  }
};

/** 画面側が持つ refresh の Cookie と、それに対応する CSRF の二重送信を用意する。 */
const loginWithRefreshCookie = async (extra: Array<{ name: string; value: string }> = []) => {
  const { tokenHashSha256 } = await import('@/lib/hash');
  const csrfHash = await tokenHashSha256(CSRF_TOKEN);
  cookies.mockReturnValue({
    get: jest.fn((name: string) =>
      name === 'sb-access-token' ? { value: 'old-access' } : { value: 'old-refresh' },
    ),
    getAll: jest.fn().mockReturnValue(extra),
  });
  headers.mockReturnValue({ get: jest.fn().mockReturnValue(CSRF_TOKEN) });
  return csrfHash;
};

type ServiceOptions = {
  csrfHash: string;
  revokedRows?: Array<{ user_id: string }> | null;
  rpcImpl?: jest.Mock;
};

const installService = ({ csrfHash, revokedRows = [{ user_id: 'user-1' }], rpcImpl }: ServiceOptions) => {
  const select = jest.fn().mockResolvedValue({ data: revokedRows, error: null });
  const eq = jest.fn().mockReturnValue({ select });
  const update = jest.fn().mockReturnValue({ eq });
  const maybeSingle = jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } });
  const selectCsrf = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) });
  const from = jest.fn(() => ({ update, select: selectCsrf }));
  const rpc = rpcImpl ?? jest.fn().mockResolvedValue({ data: 1, error: null });
  createServiceRoleClient.mockReturnValue({ from, rpc });
  return { from, update, eq, rpc };
};

describe('Logout API integration (mocked supabase & headers)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    logoutHandler = require('@/app/api/auth/logout/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logAudit.mockResolvedValue(undefined);
    // default: no cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(null) });
    verifyAccessToken.mockResolvedValue({ ok: true, claims: { session_id: 'session-1' } });
    requireCsrfOrDeny.mockImplementation(jest.requireActual('@/lib/csrfMiddleware').requireCsrfOrDeny);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('API-AUTH-015 refresh の Cookie が無くても 200 を返し、認証・ゲストの Cookie を全部消す', async () => {
    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test('API-AUTH-015 戻り先の控えの Cookie は空の値と Max-Age 0 で消し、次の人に前の人の戻り先を持ち越さない', async () => {
    const res: any = await logoutHandler();

    expect(res.cookies.get('sb-return-intent')).toEqual(
      expect.objectContaining({ name: 'sb-return-intent', value: '', maxAge: 0, path: '/' }),
    );
  });

  test('API-AUTH-015 refresh の Cookie が無い時は、サーバーのセッションを切らずに Cookie だけ消す', async () => {
    await logoutHandler();

    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('API-AUTH-015 CSRF が通れば自前の行に revoked_at を付け、JWT の session_id でサーバーのセッションを切る', async () => {
    const csrfHash = await loginWithRefreshCookie();
    const service = installService({ csrfHash });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(service.from).toHaveBeenCalledWith('sessions');
    expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ revoked_at: expect.any(String) }));
    const { tokenHashSha256 } = await import('@/lib/hash');
    expect(service.eq).toHaveBeenCalledWith('refresh_token_hash', await tokenHashSha256('old-refresh'));
    // access token の有効性に依存しないよう、期限切れでも署名を確かめた session_id で切る
    expect(verifyAccessToken).toHaveBeenCalledWith(undefined, { allowExpired: true });
    expect(service.rpc).toHaveBeenCalledTimes(1);
    expect(service.rpc).toHaveBeenCalledWith('revoke_auth_session', { p_session_id: 'session-1' });
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test('API-AUTH-015 session_id で切れた時は利用者の全部のセッションを切らず、監査も残さない', async () => {
    const csrfHash = await loginWithRefreshCookie();
    const service = installService({ csrfHash });

    await logoutHandler();

    expect(service.rpc).not.toHaveBeenCalledWith('revoke_auth_sessions_for_user', expect.anything());
    expect(logAudit).not.toHaveBeenCalled();
  });

  test.each([
    ['403（なりすまし）', 403],
    ['500（照合の DB の失敗）', 500],
  ])('API-AUTH-015 CSRF が %s で断られても 200 を返し、Cookie は消すがサーバーのセッションは切らない', async (_label, status) => {
    const csrfHash = await loginWithRefreshCookie();
    const service = installService({ csrfHash });
    requireCsrfOrDeny.mockResolvedValue(new Response('{}', { status }));

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(service.update).not.toHaveBeenCalled();
    expect(service.rpc).not.toHaveBeenCalled();
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test('API-AUTH-015 session_id で切れなければ、自前の行の利用者の全部のセッションを切って success を監査に残す', async () => {
    const csrfHash = await loginWithRefreshCookie();
    const service = installService({ csrfHash });
    // access Cookie が無い／期限切れで session_id が取り出せない状況
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(service.rpc).toHaveBeenCalledTimes(1);
    expect(service.rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'user-1' });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'logout',
      actor_id: 'user-1',
      outcome: 'success',
      detail: 'revoked_all_sessions_session_id_unavailable',
    });
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test('API-AUTH-015 JWT が通っても session_id の claim が無ければ全部のセッションを切る道へ落ちる', async () => {
    const csrfHash = await loginWithRefreshCookie();
    const service = installService({ csrfHash });
    verifyAccessToken.mockResolvedValue({ ok: true, claims: {} });

    await logoutHandler();

    expect(service.rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'user-1' });
  });

  test('API-AUTH-015 revoke_auth_session が失敗したら、利用者の全部のセッションを切る道に切り替える', async () => {
    const csrfHash = await loginWithRefreshCookie();
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } })
      .mockResolvedValueOnce({ data: 2, error: null });
    installService({ csrfHash, rpcImpl: rpc });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenNthCalledWith(1, 'revoke_auth_session', { p_session_id: 'session-1' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'revoke_auth_sessions_for_user', { p_user_id: 'user-1' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('API-AUTH-015 全部のセッションを切る道も失敗したら error を監査に残し、それでも 200 で Cookie を消す', async () => {
    const csrfHash = await loginWithRefreshCookie();
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'expired' });
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'rpc failed' } });
    installService({ csrfHash, rpcImpl: rpc });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'logout',
      actor_id: 'user-1',
      outcome: 'error',
      detail: 'auth_session_revocation_failed',
    });
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test.each([
    ['行が1件も無い', [] as Array<{ user_id: string }>],
    ['更新の結果が null', null],
  ])('API-AUTH-015 session_id も利用者も分からない時（%s）は切らずに error を監査に残し、200 で Cookie を消す', async (_label, rows) => {
    const csrfHash = await loginWithRefreshCookie();
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });
    const service = installService({ csrfHash, revokedRows: rows });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(service.rpc).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'logout',
      outcome: 'error',
      detail: 'auth_session_not_identified',
    });
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test('API-AUTH-015 自前の行の更新が例外を投げても 200 を返し、認証の Cookie を消す', async () => {
    const csrfHash = await loginWithRefreshCookie();
    const service = installService({ csrfHash });
    service.update.mockImplementation(() => {
      throw new Error('db fail');
    });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(service.rpc).not.toHaveBeenCalled();
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
  });

  test('API-AUTH-015 service role のクライアントを作れなくても 200 を返し、Cookie を消す', async () => {
    await loginWithRefreshCookie();
    createServiceRoleClient.mockRejectedValue(new Error('no service client'));

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expectCleared(res, ALWAYS_CLEARED_COOKIES);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('API-AUTH-015 OAuth のログインでライブラリが書いた sb-<ref>-auth-token の Cookie も消し、無関係な Cookie は触らない', async () => {
    cookies.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      getAll: jest.fn().mockReturnValue([
        { name: 'sb-abcdefgh-auth-token', value: 'x' },
        { name: 'sb-abcdefgh-auth-token.0', value: 'y' },
        { name: 'sb-abcdefgh-auth-token.12', value: 'y' },
        { name: 'sb-abcdefgh-auth-token-code-verifier', value: 'v' },
        { name: 'unrelated-cookie', value: 'z' },
      ]),
    });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    expectCleared(res, ['sb-abcdefgh-auth-token', 'sb-abcdefgh-auth-token.0', 'sb-abcdefgh-auth-token.12']);
    expect(res.cookies.get('sb-abcdefgh-auth-token-code-verifier')).toBeUndefined();
    expect(res.cookies.get('unrelated-cookie')).toBeUndefined();
  });

  test('API-AUTH-015 Cookie を読む段階で例外が出た時だけ 500 を返す', async () => {
    cookies.mockRejectedValue(new Error('cookie store broken'));

    const res: any = await logoutHandler();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
