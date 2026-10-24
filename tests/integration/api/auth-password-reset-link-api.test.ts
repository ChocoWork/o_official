jest.mock('server-only', () => ({}), { virtual: true });

/**
 * API-AUTH-010 GET・POST /api/auth/password-reset/link の結合テスト。
 * 窓口・再設定の Cookie の署名・住所の決め方は本物を使い、DB・回数の制限・監査だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

type Op = 'select' | 'insert' | 'update' | 'delete';
type Result = { data: any; error: any };
type Recorded = { table: string; op: Op | null; calls: Array<[string, any[]]> };

let dbResult: Result;
let dbLog: Recorded[];
let rpcResult: Result;
let rpcCalls: Array<{ name: string; params: any }>;

function makeChain(table: string): any {
  const rec: Recorded = { table, op: null, calls: [] };
  dbLog.push(rec);
  const chain: any = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'gte']) {
    chain[method] = jest.fn((...args: any[]) => {
      if (['select', 'insert', 'update', 'delete'].includes(method) && !rec.op) {
        rec.op = method as Op;
      }
      rec.calls.push([method, args]);
      return chain;
    });
  }
  chain.maybeSingle = jest.fn(() => Promise.resolve(dbResult));
  return chain;
}

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    from: (table: string) => makeChain(table),
    rpc: (name: string, params: any) => {
      rpcCalls.push({ name, params });
      return Promise.resolve(rpcResult);
    },
  })),
}));

jest.mock('next/server', () => {
  const build = (body: unknown, status: number, extraHeaders?: Record<string, string>) => {
    const cookieCalls: any[] = [];
    return {
      status,
      headers: new Headers(extraHeaders),
      cookies: { set: jest.fn((value: any) => cookieCalls.push(value)) },
      _cookies: cookieCalls,
      json: async () => body,
    };
  };
  return {
    NextResponse: {
      json: (body: unknown, init?: any) => build(body, init?.status ?? 200),
      redirect: (url: URL | string, init?: any) => build(null, init?.status ?? 307, { location: String(url) }),
    },
  };
});

const { logAudit } = require('@/lib/audit');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { verifyPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');

let getHandler: any;
let postHandler: any;

const URL_BASE = 'http://localhost/api/auth/password-reset/link';

function post(body: unknown) {
  return new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const ROW = { id: 'token-123', user_id: 'user-123', email: 'test@example.com' };

function updates() {
  return dbLog.filter((rec) => rec.op && rec.op !== 'select');
}

const envBackup = { ...process.env };

describe('API-AUTH-010 GET・POST /api/auth/password-reset/link - Integration Tests', () => {
  beforeAll(async () => {
    const route = await import('@/app/api/auth/password-reset/link/route');
    getHandler = route.GET;
    postHandler = route.POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    dbResult = { data: ROW, error: null };
    dbLog = [];
    rpcCalls = [];
    rpcResult = { data: 'user-from-email', error: null };
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  describe('GET', () => {
    test('API-AUTH-010 GET は印を見ずに確認の画面へ 303 で転送し、キャッシュと参照元を止める', async () => {
      const res = await getHandler(new Request(`${URL_BASE}?token=abc123`));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/password-reset/verify?token=abc123');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(dbLog).toEqual([]);
    });

    test('API-AUTH-010 GET は印の特殊な文字を符号化して転送先に載せる', async () => {
      const res = await getHandler(new Request(`${URL_BASE}?token=${encodeURIComponent('a b&c=d')}`));

      const location = new URL(res.headers.get('location'));
      expect(location.pathname).toBe('/auth/password-reset/verify');
      expect(location.searchParams.get('token')).toBe('a b&c=d');
      expect(location.searchParams.has('c')).toBe(false);
    });

    test('API-AUTH-010 GET は印が無ければ link_invalid の画面へ転送し、監査に failure を残す', async () => {
      const res = await getHandler(new Request(URL_BASE));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/password-reset?error=link_invalid');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(logAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'failure',
        detail: 'missing_token',
      });
    });

    test('API-AUTH-010 GET は偽の Host で届いても許可した住所へ転送する', async () => {
      const res = await getHandler(
        new Request('https://evil.example.org/api/auth/password-reset/link?token=abc', {
          headers: { host: 'evil.example.org' },
        })
      );

      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/password-reset/verify?token=abc');
    });
  });

  describe('POST', () => {
    test('API-AUTH-010 POST は未使用で期限の内の行をハッシュで引き、何も書き換えない', async () => {
      const before = Date.now();
      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(200);
      const [lookup] = dbLog;
      expect(lookup.table).toBe('password_reset_tokens');
      expect(lookup.op).toBe('select');
      expect(lookup.calls).toEqual(
        expect.arrayContaining([
          ['select', ['id, user_id, email']],
          ['eq', ['token_hash', require('crypto').createHash('sha256').update('raw-token').digest('hex')]],
          ['eq', ['used', false]],
        ])
      );
      const gte = lookup.calls.find(([name]) => name === 'gte')!;
      expect(gte[1][0]).toBe('expires_at');
      expect(Math.abs(new Date(gte[1][1]).getTime() - before)).toBeLessThan(5000);
      expect(updates()).toEqual([]);
    });

    test('API-AUTH-010 POST は通ったら再設定の Cookie（10 分・HttpOnly・Strict）と行き先を返す', async () => {
      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, redirectTo: '/auth/password-reset' });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

      expect(res._cookies).toHaveLength(1);
      const cookie = res._cookies[0];
      expect(cookie).toEqual(
        expect.objectContaining({
          name: 'sb-password-reset-session',
          maxAge: 600,
          httpOnly: true,
          sameSite: 'strict',
        })
      );
      expect(verifyPasswordResetSessionToken(cookie.value)).toEqual(
        expect.objectContaining({ userId: 'user-123', email: 'test@example.com', tokenId: 'token-123' })
      );
      expect(logAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        actor_email: 'test@example.com',
        outcome: 'success',
        resource_id: 'user-123',
      });
    });

    test('API-AUTH-010 POST を何度踏まれても印は消費せず、そのたびに Cookie を出す', async () => {
      const first = await postHandler(post({ token: 'raw-token' }));
      const second = await postHandler(post({ token: 'raw-token' }));
      const third = await postHandler(post({ token: 'raw-token' }));

      expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
      expect(updates()).toEqual([]);
      expect(dbLog).toHaveLength(3);
    });

    test('API-AUTH-010 POST は行に利用者の id が無ければ宛先から引いて Cookie に入れる', async () => {
      dbResult = { data: { ...ROW, user_id: null }, error: null };

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(200);
      expect(rpcCalls).toEqual([{ name: 'find_auth_user_id_by_email', params: { p_email: 'test@example.com' } }]);
      expect(verifyPasswordResetSessionToken(res._cookies[0].value)).toEqual(
        expect.objectContaining({ userId: 'user-from-email' })
      );
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', resource_id: 'user-from-email' })
      );
    });

    test('API-AUTH-010 POST は利用者を引けなかっただけなら 500 にして、期限切れとは言わない', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      dbResult = { data: { ...ROW, user_id: null }, error: null };
      rpcResult = { data: null, error: { message: 'rpc down' } };

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
      expect(res._cookies).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        actor_email: 'test@example.com',
        outcome: 'error',
        detail: 'user_lookup_failed',
      });
    });

    test('API-AUTH-010 POST は利用者がもう居なければ 400 link_expired にして監査に error を残す', async () => {
      dbResult = { data: { ...ROW, user_id: null }, error: null };
      rpcResult = { data: null, error: null };

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'link_expired' });
      expect(res._cookies).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        actor_email: 'test@example.com',
        outcome: 'error',
        detail: 'user_not_found',
      });
    });

    test('API-AUTH-010 POST は未使用で期限の内の行が無ければ 400 link_expired で Cookie を出さない', async () => {
      dbResult = { data: null, error: null };

      const res = await postHandler(post({ token: 'used-or-expired' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'link_expired' });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res._cookies).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'failure',
        detail: 'invalid_or_expired_token',
      });
    });

    test('API-AUTH-010 POST は行の照会が失敗したら 400 link_expired にして監査に error を残す', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      dbResult = { data: null, error: { message: 'db down' } };

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'link_expired' });
      expect(res._cookies).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith({ action: 'password_reset_link', outcome: 'error', detail: 'db down' });
    });

    test.each([
      ['本文が JSON でない', '{not json'],
      ['token が無い', {}],
      ['token が空文字', { token: '' }],
      ['token が文字列でない', { token: 12345 }],
    ])('API-AUTH-010 POST は「%s」のとき 400 link_invalid で DB を見ない', async (_label, body) => {
      const res = await postHandler(post(body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'link_invalid' });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(dbLog).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith({
        action: 'password_reset_link',
        outcome: 'failure',
        detail: 'missing_token',
      });
    });

    test('API-AUTH-010 POST は回数の制限に掛かればその応答を返して DB を見ない', async () => {
      const limited = { status: 429, marker: 'limited' };
      enforceRateLimit.mockResolvedValueOnce(limited);

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res).toBe(limited);
      expect(enforceRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:password_reset_link', limit: 20, windowSeconds: 600 })
      );
      expect(dbLog).toEqual([]);
    });

    test('API-AUTH-010 POST は回数の制限の部品が落ちても記録して処理を続ける', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      enforceRateLimit.mockRejectedValueOnce(new Error('limiter down'));

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith('Rate limit middleware error (password-reset-link):', expect.any(Error));
    });

    test('API-AUTH-010 POST は想定外の例外でも 400 link_expired にして内容を出さない', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      createServiceRoleClient.mockRejectedValueOnce(new Error('boom'));

      const res = await postHandler(post({ token: 'raw-token' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'link_expired' });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res._cookies).toEqual([]);
    });
  });
});

export {};
