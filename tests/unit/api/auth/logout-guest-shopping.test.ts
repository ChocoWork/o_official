// ログアウトは、この端末のゲストのカート・お気に入りの印（cart・wishlist の Cookie）も消す（設計書 4-3）。
// 会員の分はサーバーに残り、次のログインで戻るため、DB の会員の分には触れない。

import { POST } from '@/app/api/auth/logout/route';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyAccessToken } from '@/lib/auth/authenticate';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { logAudit } from '@/lib/audit';
import { cookies, headers } from 'next/headers';
import { createHash } from 'crypto';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const res = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map<string, string>(),
        cookies: {
          _cookies: [] as Array<Record<string, unknown>>,
          set(cookie: Record<string, unknown>) {
            this._cookies.push(cookie);
          },
          get(name: string) {
            return this._cookies.find((cookie) => cookie.name === name);
          },
        },
      };
      return res;
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
}));

// CSRF の確かめはここで見たいことではないため、素通り（undefined）か拒否の応答を返す。
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const mockedCookies = cookies as unknown as jest.Mock;
const mockedHeaders = headers as unknown as jest.Mock;
const mockedCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockedVerifyAccessToken = verifyAccessToken as jest.Mock;
const mockedRequireCsrfOrDeny = requireCsrfOrDeny as jest.Mock;
const mockedLogAudit = logAudit as jest.Mock;

/** 消えた Cookie は、値が空で有効期限が0秒（ブラウザに捨てさせる指示）になっている */
const CLEARED = { value: '', maxAge: 0, path: '/', httpOnly: true };

describe('POST /api/auth/logout: ゲストのカート・お気に入りの印', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedCookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
    mockedHeaders.mockReturnValue({ get: jest.fn().mockReturnValue(null) });
    mockedRequireCsrfOrDeny.mockResolvedValue(undefined);
    mockedVerifyAccessToken.mockResolvedValue({ ok: true, claims: { session_id: 'session-1' } });
  });

  afterEach(() => jest.restoreAllMocks());

  test('DD-AUTH-028 未ログイン（refresh Cookie なし）でも、cart と wishlist の Cookie を消す', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
  });

  test('DD-AUTH-028 ログイン中のログアウトでも、cart と wishlist の Cookie を消し、会員の分の DB には触れない', async () => {
    mockedCookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    const select = jest.fn().mockResolvedValue({ data: [{ user_id: 'user-1' }], error: null });
    const update = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ select }) });
    const from = jest.fn<{ update: jest.Mock }, [string]>(() => ({ update }));
    const rpc = jest.fn().mockResolvedValue({ data: 1, error: null });
    mockedCreateServiceRoleClient.mockResolvedValue({ from, rpc });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
    // 触れる表はセッションだけ。カート・お気に入りの表（会員の分）は消さない。
    expect(from.mock.calls.map(([table]) => table)).toEqual(['sessions']);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['revoke_auth_session']);
  });

  test('DD-AUTH-028 セッションを失効させる DB が落ちても、cart と wishlist の Cookie は消す', async () => {
    mockedCookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    mockedCreateServiceRoleClient.mockResolvedValue({
      from: jest.fn(() => ({
        update: jest.fn(() => {
          throw new Error('db fail');
        }),
      })),
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
  });

  // requireCsrfOrDeny は本物の Response（403 か DB の失敗の500）を返す（R-22）。
  // ログアウトは拒否でも200と Cookie の消去を返し、サーバー側のログインの取り消しだけをしない。
  test.each([
    { label: '403（なりすまし）', status: 403, body: { error: 'Forbidden', reason: 'CSRF validation failed' } },
    { label: '500（照合の DB の失敗）', status: 500, body: { error: 'Internal server error' } },
  ])('DD-AUTH-028 CSRF が拒否されても（$label）200 で Cookie は消し、サーバー側のログインは取り消さない', async ({ status, body }) => {
    mockedCookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    const from = jest.fn();
    const rpc = jest.fn();
    mockedCreateServiceRoleClient.mockResolvedValue({ from, rpc });
    // 試験の環境の Response（node-fetch）には静的な json が無いので、本物の NextResponse を直接作る
    const { NextResponse: RealNextResponse } = jest.requireActual('next/server');
    mockedRequireCsrfOrDeny.mockResolvedValue(
      new RealNextResponse(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );

    const res = await POST();

    expect(res.status).toBe(200);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockedVerifyAccessToken).not.toHaveBeenCalled();
    for (const name of ['sb-refresh-token', 'sb-access-token', 'session_id', 'cart', 'wishlist']) {
      expect(res.cookies.get(name)).toMatchObject({ name, ...CLEARED });
    }
  });
});

// ここから先は、窓口が下す分岐（サーバー側のログインの取り消しの手順、消す Cookie の一覧）を見る（DD-AUTH-028）。
type LogoutResponse = {
  status: number;
  json: () => Promise<unknown>;
  cookies: { _cookies: Array<Record<string, unknown>>; get: (name: string) => unknown };
};

const OLD_REFRESH_HASH = createHash('sha256').update('old-refresh').digest('hex');

/** 「更新した行」の答えと rpc の答えを決めて、service role の client の代わりを作る */
const buildService = ({
  rows = [{ user_id: 'user-1' }] as Array<Record<string, unknown>> | null,
  rpcResults = {} as Record<string, { error: unknown }>,
} = {}) => {
  const select = jest.fn().mockResolvedValue({ data: rows, error: null });
  const eq = jest.fn().mockReturnValue({ select });
  const update = jest.fn().mockReturnValue({ eq });
  const from = jest.fn(() => ({ update }));
  const rpc = jest.fn(async (name: string) => rpcResults[name] ?? { data: 1, error: null });
  return { service: { from, rpc }, from, update, eq, select, rpc };
};

const loggedIn = (cookieList: Array<{ name: string }> = []) => {
  mockedCookies.mockReturnValue({
    get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
    getAll: jest.fn().mockReturnValue(cookieList),
  });
};

const callLogout = async () => (await POST()) as unknown as LogoutResponse;

describe('POST /api/auth/logout: サーバー側のログインの取り消しと Cookie の消去', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedCookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
    mockedHeaders.mockReturnValue({ get: jest.fn().mockReturnValue(null) });
    mockedRequireCsrfOrDeny.mockResolvedValue(undefined);
    mockedVerifyAccessToken.mockResolvedValue({ ok: true, claims: { session_id: 'session-1' } });
    mockedLogAudit.mockResolvedValue(undefined);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => consoleError.mockRestore());

  test('DD-AUTH-028 refresh の Cookie が無ければサーバーのセッションに触れず、200 { ok: true } を返す', async () => {
    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockedRequireCsrfOrDeny).not.toHaveBeenCalled();
    expect(mockedVerifyAccessToken).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  test('DD-AUTH-028 CSRF が通り session_id が取れれば、行に revoked_at を付け、その1本だけを切って監査は残さない', async () => {
    loggedIn();
    const { service, update, eq, select, rpc } = buildService();
    mockedCreateServiceRoleClient.mockResolvedValue(service);

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({ revoked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) });
    expect(eq).toHaveBeenCalledWith('refresh_token_hash', OLD_REFRESH_HASH);
    expect(select).toHaveBeenCalledWith('user_id');
    expect(mockedVerifyAccessToken).toHaveBeenCalledWith(undefined, { allowExpired: true });
    expect(rpc.mock.calls).toEqual([['revoke_auth_session', { p_session_id: 'session-1' }]]);
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  test('DD-AUTH-028 revoke_auth_session が誤りなら記録して、行の利用者の全部を切る道へ進み、success を残す', async () => {
    loggedIn();
    const rpcError = { message: 'rpc failed' };
    const { service, rpc } = buildService({ rpcResults: { revoke_auth_session: { error: rpcError } } });
    mockedCreateServiceRoleClient.mockResolvedValue(service);

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith('[auth.logout] revoke_auth_session failed:', rpcError);
    expect(rpc.mock.calls).toEqual([
      ['revoke_auth_session', { p_session_id: 'session-1' }],
      ['revoke_auth_sessions_for_user', { p_user_id: 'user-1' }],
    ]);
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'logout',
      actor_id: 'user-1',
      outcome: 'success',
      detail: 'revoked_all_sessions_session_id_unavailable',
    });
  });

  test.each([
    { label: 'JWT が確かめられない', verified: { ok: false, reason: 'invalid' } },
    { label: 'JWT は確かめられたが session_id が無い', verified: { ok: true, claims: { sub: 'user-1' } } },
    { label: 'JWT は確かめられたが session_id が空', verified: { ok: true, claims: { session_id: '' } } },
  ])('DD-AUTH-028 $label なら session_id の失効は呼ばず、行の利用者の全部を切って success を残す', async ({ verified }) => {
    loggedIn();
    mockedVerifyAccessToken.mockResolvedValue(verified);
    const { service, rpc } = buildService();
    mockedCreateServiceRoleClient.mockResolvedValue(service);

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(rpc.mock.calls).toEqual([['revoke_auth_sessions_for_user', { p_user_id: 'user-1' }]]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'logout',
      actor_id: 'user-1',
      outcome: 'success',
      detail: 'revoked_all_sessions_session_id_unavailable',
    });
  });

  test.each([
    { label: '更新した行の答えが null', rows: null },
    { label: '更新した行が1つも無い', rows: [] },
    { label: '更新した行に利用者の id が無い', rows: [{ user_id: null }] },
  ])('DD-AUTH-028 session_id が取れず$labelなら、error（auth_session_not_identified）を残して全部を切る関数は呼ばない', async ({ rows }) => {
    loggedIn();
    mockedVerifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });
    const { service, rpc } = buildService({ rows });
    mockedCreateServiceRoleClient.mockResolvedValue(service);

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'logout',
      outcome: 'error',
      detail: 'auth_session_not_identified',
    });
  });

  test('DD-AUTH-028 session_id の失効が誤りで、行も無ければ、error（auth_session_not_identified）を残して Cookie は消す', async () => {
    loggedIn();
    const { service, rpc } = buildService({ rows: [], rpcResults: { revoke_auth_session: { error: { message: 'x' } } } });
    mockedCreateServiceRoleClient.mockResolvedValue(service);

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['revoke_auth_session']);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'logout',
      outcome: 'error',
      detail: 'auth_session_not_identified',
    });
    expect(res.cookies.get('sb-refresh-token')).toMatchObject({ name: 'sb-refresh-token', ...CLEARED });
  });

  test('DD-AUTH-028 revoke_auth_sessions_for_user が誤りなら、記録して error（auth_session_revocation_failed）を残し、200 で Cookie は消す', async () => {
    loggedIn();
    const fallbackError = { message: 'fallback failed' };
    mockedVerifyAccessToken.mockResolvedValue({ ok: false, reason: 'invalid' });
    const { service } = buildService({ rpcResults: { revoke_auth_sessions_for_user: { error: fallbackError } } });
    mockedCreateServiceRoleClient.mockResolvedValue(service);

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith('[auth.logout] revoke_auth_sessions_for_user failed:', fallbackError);
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'logout',
      actor_id: 'user-1',
      outcome: 'error',
      detail: 'auth_session_revocation_failed',
    });
    expect(res.cookies.get('sb-refresh-token')).toMatchObject({ name: 'sb-refresh-token', ...CLEARED });
  });

  test.each([
    { label: 'service role の client を作る所', setup: () => mockedCreateServiceRoleClient.mockRejectedValue(new Error('no client')) },
    { label: 'CSRF の確かめ', setup: () => {
      mockedCreateServiceRoleClient.mockResolvedValue(buildService().service);
      mockedRequireCsrfOrDeny.mockRejectedValue(new Error('csrf crashed'));
    } },
    { label: 'Supabase のセッションを切る所', setup: () => {
      mockedCreateServiceRoleClient.mockResolvedValue(buildService().service);
      mockedVerifyAccessToken.mockRejectedValue(new Error('verify crashed'));
    } },
  ])('DD-AUTH-028 $label が投げたら記録して、200 を返し Cookie は消す', async ({ setup }) => {
    loggedIn();
    setup();

    const res = await callLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(consoleError).toHaveBeenCalledWith('Failed to mark session revoked:', expect.any(Error));
    for (const name of ['sb-refresh-token', 'sb-access-token', 'sb-csrf-token']) {
      expect(res.cookies.get(name)).toMatchObject({ name, ...CLEARED });
    }
  });

  test('DD-AUTH-028 refresh の Cookie の有る無しに関わらず、8つの Cookie を消す', async () => {
    const res = await callLogout();

    const cleared = res.cookies._cookies.map((cookie) => cookie.name);
    expect(cleared).toEqual([
      'session_id',
      'sb-refresh-token',
      'sb-access-token',
      'sb-csrf-token',
      'sb-login-2fa-session',
      'sb-password-reset-session',
      'cart',
      'wishlist',
    ]);
    for (const cookie of res.cookies._cookies) {
      expect(cookie).toMatchObject({ value: '', maxAge: 0, path: '/', httpOnly: true });
    }
  });

  test('DD-AUTH-028 回転した CSRF の印が返れば CSRF の Cookie に置くが、直後の消去の一覧で上書きされる', async () => {
    loggedIn();
    mockedCreateServiceRoleClient.mockResolvedValue(buildService().service);
    mockedRequireCsrfOrDeny.mockResolvedValue({ rotatedCsrfToken: 'rotated-token' });

    const res = await callLogout();

    const csrfWrites = res.cookies._cookies.filter((cookie) => cookie.name === 'sb-csrf-token');
    expect(csrfWrites).toHaveLength(2);
    expect(csrfWrites[0]).toMatchObject({ value: 'rotated-token', maxAge: 0 });
    expect(csrfWrites[1]).toMatchObject(CLEARED);
    // 回転の印が返ったときも、CSRF が通った扱いでサーバー側のセッションを切る
    expect(mockedVerifyAccessToken).toHaveBeenCalledTimes(1);
  });

  test.each([
    { label: '何も返さない（undefined）', csrf: undefined },
    { label: 'null を返す', csrf: null },
    { label: '回転の印を持たない物を返す', csrf: { ok: true } },
  ])('DD-AUTH-028 CSRF の確かめが$labelなら、CSRF の Cookie に回転の印は置かない', async ({ csrf }) => {
    loggedIn();
    mockedCreateServiceRoleClient.mockResolvedValue(buildService().service);
    mockedRequireCsrfOrDeny.mockResolvedValue(csrf);

    const res = await callLogout();

    const csrfWrites = res.cookies._cookies.filter((cookie) => cookie.name === 'sb-csrf-token');
    expect(csrfWrites).toHaveLength(1);
    expect(csrfWrites[0]).toMatchObject(CLEARED);
  });

  test('DD-AUTH-028 名前が sb-…-auth-token の形のライブラリの Cookie（.数字つきも）は消し、形が違う物は残す', async () => {
    loggedIn([
      { name: 'sb-abcdef-auth-token' },
      { name: 'sb-abcdef-auth-token.0' },
      { name: 'sb-abcdef-auth-token.12' },
      { name: 'sb-abcdef-auth-token.x' },
      { name: 'sb-abcdef-auth-token-code-verifier' },
      { name: 'xsb-abcdef-auth-token' },
      { name: 'theme' },
    ]);
    mockedCreateServiceRoleClient.mockResolvedValue(buildService().service);

    const res = await callLogout();

    const names = res.cookies._cookies.map((cookie) => cookie.name);
    for (const name of ['sb-abcdef-auth-token', 'sb-abcdef-auth-token.0', 'sb-abcdef-auth-token.12']) {
      expect(res.cookies.get(name)).toMatchObject({ name, ...CLEARED });
    }
    for (const name of ['sb-abcdef-auth-token.x', 'sb-abcdef-auth-token-code-verifier', 'xsb-abcdef-auth-token', 'theme']) {
      expect(names).not.toContain(name);
    }
  });

  test('DD-AUTH-028 応答を作る所（Cookie の読み出し）で例外なら、500 Internal server error を返す', async () => {
    const error = new Error('no request scope');
    mockedCookies.mockRejectedValue(error);

    const res = await callLogout();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Logout handler error:', error);
  });
});
