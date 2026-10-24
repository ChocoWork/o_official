jest.mock('server-only', () => ({}), { virtual: true });

/**
 * ARC-AUTH-004 パスワードの再設定は自前の使い捨ての印で行い、印の消費をパスワードを変える時まで遅らせる。
 * 申請・リンク・Cookie の確認・完了の4つの窓口を、印の表を実際に読み書きする作り物の DB につないで通しで確かめる。
 * 窓口・スキーマ・印のハッシュ・再設定の Cookie の署名は本物を使い、DB・Supabase Auth・メール・Turnstile・回数の制限・監査だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: jest.fn(),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));

jest.mock('@/lib/mail', () => jest.fn().mockResolvedValue(undefined));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/ops/site-url-alert', () => ({
  notifySiteUrlInvalid: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn(async (token: string) =>
    require('crypto').createHash('sha256').update(token).digest('hex')
  ),
}));

type Row = Record<string, any>;
type Filter = { kind: 'eq' | 'gte'; column: string; value: any };

/** password_reset_tokens の表。ほかの表は何も起きない。 */
let tokenRows: Row[];
let rowSeq: number;
let rpcCalls: Array<{ name: string; params: any }>;
let updateUserCalls: any[][];

function matches(row: Row, filters: Filter[]) {
  return filters.every((f) => (f.kind === 'eq' ? row[f.column] === f.value : String(row[f.column]) >= String(f.value)));
}

function makeChain(table: string): any {
  let op: 'select' | 'insert' | 'update' | 'delete' | null = null;
  let patch: Row = {};
  let inserted: Row[] = [];
  const filters: Filter[] = [];
  const chain: any = {};

  const run = () => {
    if (table !== 'password_reset_tokens') return { data: null, error: null };
    if (op === 'insert') {
      for (const row of inserted) tokenRows.push({ id: `row-${++rowSeq}`, ...row });
      return { data: null, error: null };
    }
    const hits = tokenRows.filter((row) => matches(row, filters));
    if (op === 'update') {
      hits.forEach((row) => Object.assign(row, patch));
      return { data: hits[0] ? { id: hits[0].id } : null, error: null };
    }
    if (op === 'delete') {
      tokenRows = tokenRows.filter((row) => !hits.includes(row));
      return { data: null, error: null };
    }
    return { data: hits[0] ?? null, error: null };
  };

  chain.select = jest.fn(() => {
    op = op ?? 'select';
    return chain;
  });
  chain.insert = jest.fn((rows: Row[]) => {
    op = 'insert';
    inserted = rows;
    return chain;
  });
  chain.update = jest.fn((value: Row) => {
    op = 'update';
    patch = value;
    return chain;
  });
  chain.delete = jest.fn(() => {
    op = 'delete';
    return chain;
  });
  chain.eq = jest.fn((column: string, value: any) => {
    filters.push({ kind: 'eq', column, value });
    return chain;
  });
  chain.gte = jest.fn((column: string, value: any) => {
    filters.push({ kind: 'gte', column, value });
    return chain;
  });
  chain.maybeSingle = jest.fn(() => Promise.resolve(run()));
  chain.then = (ok: any, ng: any) => Promise.resolve(run()).then(ok, ng);
  return chain;
}

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    from: (table: string) => makeChain(table),
    rpc: (name: string, params: any) => {
      rpcCalls.push({ name, params });
      return Promise.resolve({ data: name === 'find_auth_user_id_by_email' ? 'user-1' : null, error: null });
    },
    auth: {
      admin: {
        updateUserById: (...args: any[]) => {
          updateUserCalls.push(args);
          return Promise.resolve({ data: { user: { id: args[0] } }, error: null });
        },
      },
    },
  })),
}));

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => {
  const build = (body: unknown, status: number, headers?: Record<string, string>) => {
    const cookieCalls: any[] = [];
    return {
      status,
      headers: new Headers(headers),
      cookies: { set: jest.fn((value: any) => cookieCalls.push(value)) },
      _cookies: cookieCalls,
      json: async () => body,
    };
  };
  return {
    after: (fn: () => unknown) => {
      mockAfterCallbacks.push(fn);
    },
    NextResponse: {
      json: (body: unknown, init?: any) => build(body, init?.status ?? 200),
      redirect: (url: URL | string, init?: any) => build(null, init?.status ?? 307, { location: String(url) }),
    },
  };
});

async function flushAfter() {
  for (const callback of mockAfterCallbacks.splice(0)) {
    await callback();
  }
}

const crypto = require('crypto');
const sendMail = require('@/lib/mail');
const { checkPwnedPassword } = require('@/lib/pwned-password');

let requestPost: any;
let linkGet: any;
let linkPost: any;
let sessionGet: any;
let confirmPost: any;

const BASE = 'http://localhost/api/auth/password-reset';
const EMAIL = 'test@example.com';
const GOOD_PASSWORD = 'CorrectHorseBattery42';

function json(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** 申請してメールに載った印（生）を返す。 */
async function requestReset(email = EMAIL) {
  sendMail.mockClear();
  const res = await requestPost(json(`${BASE}/request`, { email, turnstileToken: 't' }));
  expect(res.status).toBe(200);
  await flushAfter();
  const text: string = sendMail.mock.calls[0][0].text;
  return text.match(/verify\?token=([0-9a-f]+)/)![1];
}

/** リンクの確認の POST を踏んで再設定の Cookie を受け取る。 */
async function openLink(token: string) {
  const res = await linkPost(json(`${BASE}/link`, { token }));
  const cookie = res._cookies[0];
  return { res, cookie: cookie ? `${cookie.name}=${encodeURIComponent(cookie.value)}` : null };
}

function confirm(cookie: string | null, password = GOOD_PASSWORD) {
  return confirmPost(json(`${BASE}/confirm`, { new_password: password }, cookie ? { cookie } : {}));
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const envBackup = { ...process.env };

describe('ARC-AUTH-004 パスワードの再設定は自前の使い捨ての印で行い、印の消費をパスワードを変える時まで遅らせる', () => {
  beforeAll(async () => {
    requestPost = (await import('@/app/api/auth/password-reset/request/route')).POST;
    const link = await import('@/app/api/auth/password-reset/link/route');
    linkGet = link.GET;
    linkPost = link.POST;
    sessionGet = (await import('@/app/api/auth/password-reset/session/route')).GET;
    confirmPost = (await import('@/app/api/auth/password-reset/confirm/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    checkPwnedPassword.mockResolvedValue({ status: 'ok' });
    tokenRows = [];
    rowSeq = 0;
    rpcCalls = [];
    updateUserCalls = [];
    mockAfterCallbacks.length = 0;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
    delete process.env.PASSWORD_RESET_SESSION_SECRET;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  test('ARC-AUTH-004 申請から完了まで通しで進み、service role でパスワードを変える', async () => {
    const token = await requestReset();
    const { res: linkRes, cookie } = await openLink(token);
    expect(linkRes.status).toBe(200);

    const session = await sessionGet(new Request(`${BASE}/session`, { headers: { cookie: cookie! } }));
    expect(await session.json()).toEqual({ ready: true, email: EMAIL });

    const done = await confirm(cookie);

    expect(done.status).toBe(200);
    expect(updateUserCalls).toEqual([['user-1', { password: GOOD_PASSWORD }]]);
  });

  test('ARC-AUTH-004 印は 32 バイトの乱数の 16 進で、DB には SHA-256 のハッシュだけを置く', async () => {
    const token = await requestReset();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toEqual(
      expect.objectContaining({ user_id: 'user-1', email: EMAIL, token_hash: sha256(token), used: false })
    );
    expect(JSON.stringify(tokenRows)).not.toContain(token);
  });

  test('ARC-AUTH-004 リンクを開いても（GET・POST を何度でも）印は消費されず、その後で完了できる', async () => {
    const token = await requestReset();

    await linkGet(new Request(`${BASE}/link?token=${token}`));
    await linkGet(new Request(`${BASE}/link?token=${token}`));
    const scanner = await openLink(token);
    await openLink(token);
    const user = await openLink(token);

    expect(scanner.res.status).toBe(200);
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0].used).toBe(false);

    const done = await confirm(user.cookie);
    expect(done.status).toBe(200);
  });

  test('ARC-AUTH-004 印を消費するのは完了の時で、その時に行も消え、同じリンクはもう通らない', async () => {
    const token = await requestReset();
    const { cookie } = await openLink(token);
    expect(tokenRows[0].used).toBe(false);

    const done = await confirm(cookie);

    expect(done.status).toBe(200);
    expect(tokenRows).toEqual([]);

    const replayLink = await openLink(token);
    expect(replayLink.res.status).toBe(400);
    expect(await replayLink.res.json()).toEqual({ error: 'link_expired' });
    expect(replayLink.cookie).toBeNull();

    const replayConfirm = await confirm(cookie);
    expect(replayConfirm.status).toBe(400);
    expect(updateUserCalls).toHaveLength(1);
  });

  test('ARC-AUTH-004 同じリンクから Cookie が 2 つ出ても、パスワードを変えられるのは 1 つだけ', async () => {
    const token = await requestReset();
    const first = await openLink(token);
    const second = await openLink(token);
    expect(first.cookie).not.toBeNull();
    expect(second.cookie).not.toBeNull();

    const results = await Promise.all([confirm(first.cookie), confirm(second.cookie, 'AnotherStrongPassw0rd')]);

    expect(results.map((r: any) => r.status).sort()).toEqual([200, 400]);
    expect(updateUserCalls).toHaveLength(1);
  });

  test('ARC-AUTH-004 漏洩済みで断られても印は焼かず、別のパスワードで同じリンクから続けられる', async () => {
    const token = await requestReset();
    const { cookie } = await openLink(token);
    checkPwnedPassword.mockResolvedValueOnce({ status: 'pwned', count: 10 });

    const rejected = await confirm(cookie, 'password1234567890');

    expect(rejected.status).toBe(400);
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0].used).toBe(false);
    expect(updateUserCalls).toEqual([]);

    const retry = await confirm(cookie);
    expect(retry.status).toBe(200);
    expect(updateUserCalls).toHaveLength(1);
  });

  test('ARC-AUTH-004 期限の 10 分を過ぎた印では再設定の Cookie を出さない', async () => {
    const token = await requestReset();
    tokenRows[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const { res, cookie } = await openLink(token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'link_expired' });
    expect(cookie).toBeNull();
  });

  test('ARC-AUTH-004 申請の印の期限は 10 分で、再設定の Cookie の寿命も 10 分', async () => {
    const before = Date.now();
    const token = await requestReset();
    const ttl = new Date(tokenRows[0].expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

    const { res, cookie } = await openLink(token);
    expect(res._cookies[0]).toEqual(expect.objectContaining({ maxAge: 600 }));

    // Cookie の寿命が過ぎたら、行が残っていても完了できない（時間の境界は Cookie が持つ）。
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 601 * 1000);
    const session = await sessionGet(new Request(`${BASE}/session`, { headers: { cookie: cookie! } }));
    expect(await session.json()).toEqual({ ready: false, email: null });
    const late = await confirm(cookie);
    expect(late.status).toBe(400);
    expect(tokenRows).toHaveLength(1);
    expect(updateUserCalls).toEqual([]);
  });

  test('ARC-AUTH-004 新しいリンクを出すと前の印は使用済みになり、新しい印だけが通る', async () => {
    const oldToken = await requestReset();
    const newToken = await requestReset();

    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.map((row) => row.used)).toEqual([true, false]);

    const old = await openLink(oldToken);
    expect(old.res.status).toBe(400);

    const fresh = await openLink(newToken);
    expect(fresh.res.status).toBe(200);
  });

  test('ARC-AUTH-004 変えた後は全部のセッションを失効させ、本人に通知のメールを送る', async () => {
    const token = await requestReset();
    const { cookie } = await openLink(token);
    sendMail.mockClear();

    await confirm(cookie);
    await flushAfter();

    expect(rpcCalls).toContainEqual({ name: 'revoke_auth_sessions_for_user', params: { p_user_id: 'user-1' } });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toEqual(expect.objectContaining({ to: EMAIL, subject: 'パスワードを変更しました' }));
  });

  test('ARC-AUTH-004 アカウントの無い宛先には印の行を作らず、リンクも開けない', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const original = createServiceRoleClient.getMockImplementation();
    createServiceRoleClient.mockImplementationOnce(async () => {
      const client = await original();
      return { ...client, rpc: () => Promise.resolve({ data: null, error: null }) };
    });

    const res = await requestPost(json(`${BASE}/request`, { email: 'nobody@example.com', turnstileToken: 't' }));
    await flushAfter();

    expect(res.status).toBe(200);
    expect(tokenRows).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();

    const probe = await openLink(sha256('guess'));
    expect(probe.res.status).toBe(400);
  });
});

export {};
