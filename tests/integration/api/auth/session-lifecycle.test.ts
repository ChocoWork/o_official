export {};

/**
 * me・refresh・logout の本物の窓口を、同じ Cookie の入れ物と同じセッションの表に続けてつなぎ、
 * ログインの状態が「答える・延ばす・切る」の通りに動くことを確かめる。
 * 外の依存（Supabase のトークン交換と RPC・DB・JWT の検証・回数制限・監査）だけを手元の表で差し替える。
 */

// CSRF の確かめは断る時に Response を返し、logout はそれを instanceof Response で見分ける。
// 差し替えた NextResponse も本物の Response にして、その見分けが実際の通りに働くようにする。
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
      res.cookies = {
        _cookies: [] as any[],
        set(c: any) { this._cookies.push(c); },
        get(name: string) { return this._cookies.find((c: any) => c.name === name); },
      };
      return res;
    },
  },
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  verifyAccessToken: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const { cookies, headers } = require('next/headers');
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { authenticateRequest, verifyAccessToken } = require('@/lib/auth/authenticate');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { logAudit } = require('@/lib/audit');

type SessionRow = {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  csrf_token_hash: string;
  revoked_at: string | null;
  /** 結び付いた GoTrue の session_id（DD-AUTH-039）。旗が有効な間、refresh は結び付いた行の続きにだけ通る。 */
  auth_session_id: string | null;
};

type AuthSession = { userId: string; refreshToken: string; alive: boolean };

/** ブラウザの Cookie と、サーバー側（自前の sessions 表・Supabase Auth のセッション）をまとめた手元の世界。 */
const world = {
  jar: new Map<string, string>(),
  rows: [] as SessionRow[],
  authSessions: new Map<string, AuthSession>(),
  accessToSession: new Map<string, string>(),
  counter: 0,
  tokenCalls: 0,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
};

const resetWorld = () => {
  world.jar.clear();
  world.rows = [];
  world.authSessions.clear();
  world.accessToSession.clear();
  world.counter = 0;
  world.tokenCalls = 0;
  world.rpcCalls = [];
};

const nextId = (prefix: string) => `${prefix}-${++world.counter}`;

const hash = async (value: string) => (await import('@/lib/hash')).tokenHashSha256(value);

/** Supabase Auth に新しい access token を発行させ、対応を覚える。 */
const issueAccessToken = (sessionId: string) => {
  const accessToken = nextId('access');
  world.accessToSession.set(accessToken, sessionId);
  return accessToken;
};

/** 窓口が返した Cookie の指示（値の差し替えと maxAge 0 の削除）をブラウザの入れ物に反映する。 */
const applyResponseCookies = (res: any) => {
  for (const cookie of res.cookies._cookies) {
    if (cookie.maxAge === 0 || cookie.value === '') {
      world.jar.delete(cookie.name);
    } else {
      world.jar.set(cookie.name, cookie.value);
    }
  }
};

/** ログイン直後のブラウザ（access・refresh・CSRF の Cookie）と、対応するサーバー側のセッションを用意する。 */
const signIn = async (userId = 'user-1') => {
  const authSessionId = nextId('auth-session');
  const refreshToken = nextId('refresh');
  const csrfToken = nextId('csrf');
  world.authSessions.set(authSessionId, { userId, refreshToken, alive: true });
  world.rows.push({
    id: nextId('row'),
    user_id: userId,
    refresh_token_hash: await hash(refreshToken),
    csrf_token_hash: await hash(csrfToken),
    revoked_at: null,
    auth_session_id: authSessionId,
  });
  world.jar.set('sb-access-token', issueAccessToken(authSessionId));
  world.jar.set('sb-refresh-token', refreshToken);
  world.jar.set('sb-csrf-token', csrfToken);
  return { authSessionId, refreshToken, csrfToken };
};

const installFakeServer = () => {
  cookies.mockImplementation(async () => ({
    get: (name: string) => (world.jar.has(name) ? { name, value: world.jar.get(name) } : undefined),
    getAll: () => Array.from(world.jar, ([name, value]) => ({ name, value })),
  }));
  headers.mockImplementation(async () => ({
    get: (name: string) => (name === 'x-csrf-token' ? world.jar.get('sb-csrf-token') ?? null : null),
  }));

  const claimsFor = (accessToken: string | undefined) => {
    const authSessionId = accessToken ? world.accessToSession.get(accessToken) : undefined;
    const session = authSessionId ? world.authSessions.get(authSessionId) : undefined;
    return authSessionId && session
      ? {
          authSessionId,
          session,
          claims: {
            sub: session.userId,
            email: `${session.userId}@example.com`,
            aal: 'aal1',
            app_metadata: { role: 'user' },
            session_id: authSessionId,
          },
        }
      : null;
  };

  // me は失効まで確かめる。logout は期限切れでも署名だけ確かめて session_id を読む。
  authenticateRequest.mockImplementation(async () => {
    const found = claimsFor(world.jar.get('sb-access-token'));
    if (!found) return { ok: false, reason: 'missing' };
    if (!found.session.alive) return { ok: false, reason: 'revoked' };
    return { ok: true, claims: found.claims };
  });
  verifyAccessToken.mockImplementation(async () => {
    const found = claimsFor(world.jar.get('sb-access-token'));
    return found ? { ok: true, claims: found.claims } : { ok: false, reason: 'missing' };
  });

  createServiceRoleClient.mockImplementation(async () => ({
    from: (table: string) => {
      if (table !== 'sessions') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (column: keyof SessionRow, value: string) => ({
            maybeSingle: async () => ({
              data: world.rows.find((row) => row[column] === value) ?? null,
              error: null,
            }),
          }),
        }),
        insert: async (inserted: Array<Omit<SessionRow, 'id' | 'revoked_at'>>) => {
          for (const row of inserted) {
            world.rows.push({ id: nextId('row'), revoked_at: null, ...row });
          }
          return { error: null };
        },
        update: (patch: Partial<SessionRow>) => ({
          eq: (column: keyof SessionRow, value: string) => {
            const matched = world.rows.filter((row) => row[column] === value);
            matched.forEach((row) => Object.assign(row, { revoked_at: patch.revoked_at ?? row.revoked_at }));
            const result: any = Promise.resolve({ error: null });
            result.select = async () => ({ data: matched.map((row) => ({ user_id: row.user_id })), error: null });
            return result;
          },
        }),
      };
    },
    rpc: async (name: string, args: any) => {
      world.rpcCalls.push({ name, args });
      if (name === 'revoke_auth_session') {
        const session = world.authSessions.get(args.p_session_id);
        if (session) session.alive = false;
      }
      if (name === 'revoke_auth_sessions_for_user') {
        world.authSessions.forEach((session) => {
          if (session.userId === args.p_user_id) session.alive = false;
        });
      }
      return { data: 1, error: null };
    },
  }));

  // Supabase Auth のトークン交換。生きたセッションの今の refresh token だけを受け付け、使うたびに替える。
  if (!(global as any).fetch) {
    (global as any).fetch = jest.fn();
  }
  jest.spyOn(global, 'fetch').mockImplementation((async (_url: any, init: any) => {
    world.tokenCalls += 1;
    const { refresh_token: presented } = JSON.parse(init.body);
    const entry = Array.from(world.authSessions.entries()).find(
      ([, session]) => session.alive && session.refreshToken === presented,
    );
    if (!entry) {
      return { ok: false, status: 400, text: async () => 'invalid refresh token' } as any;
    }
    const [authSessionId, session] = entry;
    session.refreshToken = nextId('refresh');
    return {
      ok: true,
      json: async () => ({
        access_token: issueAccessToken(authSessionId),
        refresh_token: session.refreshToken,
        user: { id: session.userId, email: `${session.userId}@example.com` },
      }),
    } as any;
  }) as any);
};

const request = (path: string, method: string) => new Request(`http://localhost:3000${path}`, { method });

const callMe = async () => {
  const { GET } = await import('@/app/api/auth/me/route');
  const res: any = await GET(request('/api/auth/me', 'GET'));
  applyResponseCookies(res);
  return res;
};

const callRefresh = async () => {
  const { POST } = await import('@/app/api/auth/refresh/route');
  const res: any = await POST(request('/api/auth/refresh', 'POST'));
  applyResponseCookies(res);
  return res;
};

const callLogout = async () => {
  const { POST } = await import('@/app/api/auth/logout/route');
  const res: any = await POST();
  applyResponseCookies(res);
  return res;
};

describe('ログインの状態の流れ（me・refresh・logout を続けて呼ぶ）', () => {
  beforeEach(() => {
    resetWorld();
    delete process.env.AUTH_REQUIRE_APP_SESSION;
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    logAudit.mockClear();
    enforceRateLimit.mockClear();
    installFakeServer();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ARC-AUTH-009 ログイン中は me が authenticated=true と利用者を返し、Cookie が無ければ未ログインと答える', async () => {
    await signIn('user-1');

    const loggedIn = await callMe();
    expect(loggedIn.status).toBe(200);
    // メールの住所は読み手が使わないので返さない（id・役割・MFA の状態だけ）
    expect(await loggedIn.json()).toEqual({
      authenticated: true,
      user: { id: 'user-1', role: 'user', mfaVerified: false },
    });

    world.jar.clear();
    const anonymous = await callMe();
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toEqual({ authenticated: false });
  });

  test('ARC-AUTH-009 refresh で新しいトークンの対に替わり、替えた後も me はログイン中と答える', async () => {
    const { refreshToken: oldRefresh } = await signIn();
    const oldAccess = world.jar.get('sb-access-token');

    const refreshed = await callRefresh();

    expect(refreshed.status).toBe(200);
    expect(world.tokenCalls).toBe(1);
    expect(world.jar.get('sb-refresh-token')).not.toBe(oldRefresh);
    expect(world.jar.get('sb-access-token')).not.toBe(oldAccess);
    expect(world.jar.get('sb-csrf-token')).toEqual(expect.any(String));
    // 古い行には失効の印が付き、新しい行が足される
    expect(world.rows).toHaveLength(2);
    expect(world.rows[0].revoked_at).toEqual(expect.any(String));
    expect(world.rows[1].revoked_at).toBeNull();
    // 新しい行は前の行の続きとして結び付く（refresh で session_id は変わらない）
    expect(world.rows[1].auth_session_id).toBe(world.rows[0].auth_session_id);
    expect(world.rows[1].auth_session_id).not.toBeNull();

    const me = await callMe();
    expect((await me.json()).authenticated).toBe(true);
  });

  test('ARC-AUTH-009 refresh を続けて何度か呼んでも、そのたびに最新のトークンで続けられる', async () => {
    await signIn();

    for (let i = 0; i < 3; i += 1) {
      const res = await callRefresh();
      expect(res.status).toBe(200);
    }

    expect(world.tokenCalls).toBe(3);
    expect((await (await callMe()).json()).authenticated).toBe(true);
  });

  test('ARC-AUTH-009 logout は 200 で Cookie を消し、me は未ログインになって、サーバーのセッションも切れている', async () => {
    const { authSessionId } = await signIn();

    const out = await callLogout();

    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });
    expect(world.jar.has('sb-access-token')).toBe(false);
    expect(world.jar.has('sb-refresh-token')).toBe(false);
    expect(world.jar.has('sb-csrf-token')).toBe(false);
    expect(world.rpcCalls).toEqual([{ name: 'revoke_auth_session', args: { p_session_id: authSessionId } }]);
    expect(world.authSessions.get(authSessionId)?.alive).toBe(false);
    expect(world.rows[0].revoked_at).toEqual(expect.any(String));

    const me = await callMe();
    expect(await me.json()).toEqual({ authenticated: false });
  });

  test('ARC-AUTH-009 logout の後に盗まれた refresh token を出しても、Supabase へ行く前に 401 で断られる', async () => {
    const { refreshToken: stolen } = await signIn();
    await callLogout();
    world.jar.set('sb-refresh-token', stolen);

    const replay = await callRefresh();

    expect(replay.status).toBe(401);
    expect(world.tokenCalls).toBe(0);
    expect(world.jar.has('sb-refresh-token')).toBe(false);
  });

  test('ARC-AUTH-009 自前の行が無い refresh token は、Supabase へ行く前に 401 で断られて Cookie が消える', async () => {
    const { refreshToken: stolen } = await signIn();
    world.rows.length = 0;
    world.jar.set('sb-refresh-token', stolen);

    const replay = await callRefresh();

    expect(replay.status).toBe(401);
    expect(world.tokenCalls).toBe(0);
    expect(world.jar.has('sb-refresh-token')).toBe(false);
    expect(world.jar.has('sb-access-token')).toBe(false);
  });

  test('ARC-AUTH-009 旗が無効で自前の行が無くても、logout で切ったサーバーのセッションの refresh token は Supabase に断られて Cookie が消える', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    const { refreshToken: stolen } = await signIn();
    await callLogout();
    world.rows.length = 0;
    world.jar.set('sb-refresh-token', stolen);

    const replay = await callRefresh();

    expect(replay.status).toBe(401);
    expect(world.tokenCalls).toBe(1);
    expect(world.jar.has('sb-refresh-token')).toBe(false);
    expect(world.jar.has('sb-access-token')).toBe(false);
  });

  test('ARC-AUTH-009 refresh が失敗したら Cookie が消え、me は未ログインと答える', async () => {
    await signIn();
    world.jar.set('sb-refresh-token', 'refresh-from-another-world');

    const res = await callRefresh();

    expect(res.status).toBe(401);
    expect(world.jar.size).toBe(0);
    expect(await (await callMe()).json()).toEqual({ authenticated: false });
  });

  test('ARC-AUTH-009 CSRF の印が合わない logout も 200 で Cookie を消し、サーバーのセッションは残る', async () => {
    const { authSessionId } = await signIn();
    // 二重送信の片方（ヘッダーに載る Cookie の値）を、保存した印と食い違わせる
    world.jar.set('sb-csrf-token', 'forged-csrf');

    const out = await callLogout();

    expect(out.status).toBe(200);
    expect(world.jar.size).toBe(0);
    expect(world.rpcCalls).toEqual([]);
    expect(world.authSessions.get(authSessionId)?.alive).toBe(true);
  });

  test('ARC-AUTH-009 失効を確かめられない時は me が 503 を返し、Cookie は消さずに前の状態を保つ', async () => {
    await signIn();
    const before = new Map(world.jar);
    authenticateRequest.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });

    const me = await callMe();

    expect(me.status).toBe(503);
    expect(await me.json()).toEqual({ authenticated: false, reason: 'unavailable' });
    expect(world.jar).toEqual(before);
    // 復旧したら元のログイン中に戻る
    expect((await (await callMe()).json()).authenticated).toBe(true);
  });
});
