// 戻り先の控えの流れ（ARC-AUTH-010、STATE-AUTH-006）。入口で確かめて控え、出口で使い切り、出口でも確かめ直す。
// 入口（issueReturnIntent）・出口（resolveReturnDestination、POST /api/auth/post-login）・確かめ（return-path）は本物を通し、
// 認証の確かめと、控えの表を触る 2 本の rpc だけを DB の関数の写し（ハッシュ・用途・期限・1 回の使い切り）に差し替える。
// 本物の DB の関数は tests/integration/db/auth_return_intents.integration.test.ts が確かめる。

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => {
      const headers = new Map<string, string>(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return {
        status: init?.status ?? 200,
        json: async () => body,
        headers: {
          set: (k: string, v: string) => headers.set(k.toLowerCase(), v),
          get: (k: string) => headers.get(k.toLowerCase()) ?? null,
        },
        cookies: { set: jest.fn() },
      };
    },
  },
}));

jest.mock('@/lib/audit', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

const mockAuthenticateRequest = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  authFailureResponse: () => {
    const { NextResponse } = jest.requireMock('next/server');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  },
}));

import {
  issueReturnIntent,
  resolveReturnDestination,
  type ReturnIntentCookieAction,
} from '@/features/auth/return-intent/return-intent-service';

const LOGIN_TTL_SECONDS = 900;
const SIGNUP_TTL_SECONDS = 3600;

type Row = { path: string; purpose: string; expiresAtMs: number; consumedBy: string | null };

/** 表と 2 本の関数の写し。ハッシュで引き、用途が合い、期限内で、未使用の時だけ 1 回で使い切る。 */
class FakeIntentTable {
  rows = new Map<string, Row>();
  nowMs = 1_000_000;

  install() {
    mockRpc.mockImplementation(async (name: string, args: Record<string, string>) => {
      if (name === 'create_auth_return_intent') {
        const ttl = args._purpose === 'signup' ? SIGNUP_TTL_SECONDS : LOGIN_TTL_SECONDS;
        this.rows.set(args._token_hash, {
          path: args._return_path,
          purpose: args._purpose,
          expiresAtMs: this.nowMs + ttl * 1000,
          consumedBy: null,
        });
        return { data: ttl, error: null };
      }
      if (name === 'consume_auth_return_intent') {
        const row = this.rows.get(args._token_hash);
        if (!row || row.consumedBy || row.purpose !== args._purpose || row.expiresAtMs <= this.nowMs) {
          return { data: null, error: null };
        }
        row.consumedBy = args._user_id;
        return { data: row.path, error: null };
      }
      return { data: null, error: { code: 'unexpected' } };
    });
  }

  advanceSeconds(seconds: number) {
    this.nowMs += seconds * 1000;
  }

  get consumedCount() {
    return [...this.rows.values()].filter((row) => row.consumedBy !== null).length;
  }
}

const cookieHeaderOf = (action: ReturnIntentCookieAction) => (action.kind === 'set' ? `sb-return-intent=${action.token}` : '');

const user = (id = 'user-1') => ({ id, role: 'user' as const, aal: 'aal1' });
const admin = (aal: string) => ({ id: 'admin-1', role: 'admin' as const, aal });

describe('ARC-AUTH-010 戻り先は入口で控え、出口で使い切り、出口でも確かめ直す', () => {
  let table: FakeIntentTable;

  beforeEach(() => {
    jest.clearAllMocks();
    table = new FakeIntentTable();
    table.install();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ARC-AUTH-010 入口で確かめて控えると、表にはハッシュだけが入り、出口で戻り先を受け取って Cookie が消える', async () => {
    const entry = await issueReturnIntent({ rawNext: '/item/3?color=red', purpose: 'login' });

    expect(entry.outcome).toBe('created');
    expect(entry.action).toEqual({ kind: 'set', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), maxAgeSeconds: LOGIN_TTL_SECONDS });
    const [hash] = [...table.rows.keys()];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...table.rows.keys()])).not.toContain((entry.action as { token: string }).token);

    const exit = await resolveReturnDestination({ cookieHeader: cookieHeaderOf(entry.action), purpose: 'login', viewer: user() });

    expect(exit).toEqual({ path: '/item/3?color=red', needsMfa: false, action: { kind: 'clear' } });
  });

  test('ARC-AUTH-010 入口で外の住所・不正な値は控えず、古い Cookie を消す動作を返し、表に行を作らない', async () => {
    for (const rawNext of ['//evil.example', '/\t/evil.example', '/login', 123, undefined]) {
      const entry = await issueReturnIntent({ rawNext, purpose: 'login' });
      expect(entry.action).toEqual({ kind: 'clear' });
    }
    expect(table.rows.size).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-010 出口でも確かめ直す: 表の値が改ざんされて外の住所になっていても既定の / を返す', async () => {
    const entry = await issueReturnIntent({ rawNext: '/stockist', purpose: 'login' });
    for (const row of table.rows.values()) row.path = '//evil.example';

    const exit = await resolveReturnDestination({ cookieHeader: cookieHeaderOf(entry.action), purpose: 'login', viewer: user() });

    expect(exit.path).toBe('/');
    expect(exit.action).toEqual({ kind: 'clear' });
  });

  test('ARC-AUTH-010 出口は用途を合わせる: 登録の控えはログインの出口で使えず、ログインの控えは確認のリンクで使えない', async () => {
    const signup = await issueReturnIntent({ rawNext: '/stockist', purpose: 'signup' });
    const login = await issueReturnIntent({ rawNext: '/about', purpose: 'login' });

    const loginExitWithSignupIntent = await resolveReturnDestination({ cookieHeader: cookieHeaderOf(signup.action), purpose: 'login', viewer: user() });
    const signupExitWithLoginIntent = await resolveReturnDestination({ cookieHeader: cookieHeaderOf(login.action), purpose: 'signup', viewer: user() });

    expect(loginExitWithSignupIntent.path).toBe('/');
    expect(signupExitWithLoginIntent.path).toBe('/');
    expect(table.consumedCount).toBe(0);
  });

  test('ARC-AUTH-010 管理者は確認コードの後（aal1）に使い切らず 2 段目へ送り、aal2 になってから戻り先を受け取る', async () => {
    const entry = await issueReturnIntent({ rawNext: '/item', purpose: 'login' });
    const cookieHeader = cookieHeaderOf(entry.action);

    const aal1 = await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: admin('aal1') });
    expect(aal1).toEqual({ path: '/auth/verified', needsMfa: true, action: { kind: 'keep' } });
    expect(table.consumedCount).toBe(0);

    const aal2 = await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: admin('aal2') });
    expect(aal2).toEqual({ path: '/item', needsMfa: false, action: { kind: 'clear' } });
    expect(table.consumedCount).toBe(1);
  });

  test('ARC-AUTH-010 出口 A（POST /api/auth/post-login）は 1 回目に戻り先を返し、2 回目は既定の / を返す', async () => {
    const entry = await issueReturnIntent({ rawNext: '/stockist?from=e2e', purpose: 'login' });
    mockAuthenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'user-1', aal: 'aal1', app_metadata: { role: 'user' } } });
    const route = await import('@/app/api/auth/post-login/route');
    const request = () =>
      new Request('http://localhost:3000/api/auth/post-login', { method: 'POST', headers: { cookie: cookieHeaderOf(entry.action) } });

    const first = (await route.POST(request())) as unknown as { json: () => Promise<{ redirectTo: string }> };
    const second = (await route.POST(request())) as unknown as { json: () => Promise<{ redirectTo: string }> };

    expect((await first.json()).redirectTo).toBe('/stockist?from=e2e');
    expect((await second.json()).redirectTo).toBe('/');
  });
});

describe('STATE-AUTH-006 戻り先の控えは、作られ、1 回使い切られるか期限で使えなくなる', () => {
  let table: FakeIntentTable;

  beforeEach(() => {
    jest.clearAllMocks();
    table = new FakeIntentTable();
    table.install();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('STATE-AUTH-006 作られた控えは、期限内の最初の 1 回で使い切られ、2 回目は使えない', async () => {
    const entry = await issueReturnIntent({ rawNext: '/about', purpose: 'login' });
    const cookieHeader = cookieHeaderOf(entry.action);
    expect(table.consumedCount).toBe(0);

    const first = await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: user() });
    const second = await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: user() });

    expect(first.path).toBe('/about');
    expect(second.path).toBe('/');
    expect(table.consumedCount).toBe(1);
  });

  test.each([
    ['login', LOGIN_TTL_SECONDS],
    ['signup', SIGNUP_TTL_SECONDS],
  ] as const)('STATE-AUTH-006 %s の控えは作った %i 秒後に期限切れになり、その直前までは使える', async (purpose, ttl) => {
    const beforeExpiry = await issueReturnIntent({ rawNext: '/about', purpose });
    table.advanceSeconds(ttl - 1);
    const usable = await resolveReturnDestination({ cookieHeader: cookieHeaderOf(beforeExpiry.action), purpose, viewer: user() });
    expect(usable.path).toBe('/about');

    const atExpiry = await issueReturnIntent({ rawNext: '/about', purpose });
    table.advanceSeconds(ttl);
    const expired = await resolveReturnDestination({ cookieHeader: cookieHeaderOf(atExpiry.action), purpose, viewer: user() });
    expect(expired.path).toBe('/');
    expect(expired.action).toEqual({ kind: 'clear' });
  });

  test('STATE-AUTH-006 Cookie の Max-Age は期限と同じ秒数（login は 900、signup は 3600）', async () => {
    const login = await issueReturnIntent({ rawNext: '/about', purpose: 'login' });
    const signup = await issueReturnIntent({ rawNext: '/about', purpose: 'signup' });

    expect(login.action).toEqual(expect.objectContaining({ kind: 'set', maxAgeSeconds: LOGIN_TTL_SECONDS }));
    expect(signup.action).toEqual(expect.objectContaining({ kind: 'set', maxAgeSeconds: SIGNUP_TTL_SECONDS }));
  });

  test('STATE-AUTH-006 管理者・サポーターが aal1 の間は作られたまま残り、使い切られない', async () => {
    const entry = await issueReturnIntent({ rawNext: '/item', purpose: 'login' });
    const cookieHeader = cookieHeaderOf(entry.action);

    await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: admin('aal1') });
    await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: { ...admin('aal1'), role: 'supporter' } });

    expect(table.consumedCount).toBe(0);
  });

  test('STATE-AUTH-006 用途が合わない出口では使い切られず、合う出口の最初の 1 回で使い切られる', async () => {
    const entry = await issueReturnIntent({ rawNext: '/about', purpose: 'signup' });
    const cookieHeader = cookieHeaderOf(entry.action);

    await resolveReturnDestination({ cookieHeader, purpose: 'login', viewer: user() });
    expect(table.consumedCount).toBe(0);

    const exit = await resolveReturnDestination({ cookieHeader, purpose: 'signup', viewer: user() });
    expect(exit.path).toBe('/about');
    expect(table.consumedCount).toBe(1);
  });
});

describe('ARC-AUTH-010 登録の確認リンクは、登録を始めたブラウザ（番号と登録したメールが合う控え）でだけ使い切れる', () => {
  let table: FakeIntentTable;

  beforeEach(() => {
    jest.clearAllMocks();
    table = new FakeIntentTable();
    table.install();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function register(email: string, rawNext?: unknown) {
    return issueReturnIntent({ rawNext, purpose: 'signup', bindTo: email, alwaysCreate: true });
  }

  test('ARC-AUTH-010 戻り先が無い登録でも控えが作られ、同じブラウザ・同じメールの確認で既定の / を受け取って使い切られる', async () => {
    const entry = await register('new@example.com');
    expect(entry.outcome).toBe('created');
    expect(table.rows.size).toBe(1);

    const { consumeSignupBinding } = await import('@/features/auth/return-intent/return-intent-service');
    const result = await consumeSignupBinding({ cookieHeader: cookieHeaderOf(entry.action), email: 'New@Example.com', userId: 'user-1' });

    expect(result).toEqual({ bound: true, storedPath: '/' });
    expect(table.consumedCount).toBe(1);
  });

  test('ARC-AUTH-010 別のメールの印（番号は合う）では使い切れず、控えは残る。そのあと本人のメールで使い切れる', async () => {
    const entry = await register('victim@example.com', '/stockist');
    const { consumeSignupBinding } = await import('@/features/auth/return-intent/return-intent-service');
    const cookieHeader = cookieHeaderOf(entry.action);

    const attacker = await consumeSignupBinding({ cookieHeader, email: 'attacker@example.com', userId: 'attacker-1' });
    expect(attacker).toEqual({ bound: false });
    expect(table.consumedCount).toBe(0);

    const victim = await consumeSignupBinding({ cookieHeader, email: 'victim@example.com', userId: 'victim-1' });
    expect(victim).toEqual({ bound: true, storedPath: '/stockist' });
  });

  test('ARC-AUTH-010 Cookie が無いブラウザでは使い切れず、同じ印を 2 回目に開いても使えない', async () => {
    const entry = await register('new@example.com', '/stockist');
    const { consumeSignupBinding } = await import('@/features/auth/return-intent/return-intent-service');

    await expect(consumeSignupBinding({ cookieHeader: null, email: 'new@example.com', userId: 'user-1' })).resolves.toEqual({ bound: false });

    const cookieHeader = cookieHeaderOf(entry.action);
    await expect(consumeSignupBinding({ cookieHeader, email: 'new@example.com', userId: 'user-1' })).resolves.toEqual({
      bound: true,
      storedPath: '/stockist',
    });
    await expect(consumeSignupBinding({ cookieHeader, email: 'new@example.com', userId: 'user-1' })).resolves.toEqual({ bound: false });
  });

  test('ARC-AUTH-010 期限（1 時間）を過ぎた控えは使えない', async () => {
    const entry = await register('new@example.com');
    const { consumeSignupBinding } = await import('@/features/auth/return-intent/return-intent-service');
    table.advanceSeconds(SIGNUP_TTL_SECONDS + 1);

    await expect(
      consumeSignupBinding({ cookieHeader: cookieHeaderOf(entry.action), email: 'new@example.com', userId: 'user-1' }),
    ).resolves.toEqual({ bound: false });
  });
});
