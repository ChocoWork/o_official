jest.mock('server-only', () => ({}), { virtual: true });

/**
 * API-AUTH-009 POST /api/auth/password-reset/request の結合テスト。
 * 窓口・スキーマ・印のハッシュ・住所の見張りは本物を使い、DB・メール・Turnstile・回数の制限・監査・運用への知らせだけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('@/lib/mail', () => jest.fn().mockResolvedValue(undefined));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/ops/site-url-alert', () => ({
  notifySiteUrlInvalid: jest.fn().mockResolvedValue(undefined),
}));

// 本物は Web Crypto を使う。jsdom には無いので、同じ SHA-256 の 16 進を node の crypto で返す。
jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn(async (token: string) =>
    require('crypto').createHash('sha256').update(token).digest('hex')
  ),
}));

type Op = 'select' | 'insert' | 'update' | 'delete';
type Result = { data: any; error: any };
type Recorded = { table: string; op: Op | null; calls: Array<[string, any[]]> };

let dbResults: Record<string, Partial<Record<Op, Result>>>;
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
  const resolve = () => dbResults[table]?.[rec.op ?? 'select'] ?? { data: null, error: null };
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolve()));
  chain.then = (ok: any, ng: any) => Promise.resolve(resolve()).then(ok, ng);
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

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  after: (fn: () => unknown) => {
    mockAfterCallbacks.push(fn);
  },
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers),
      json: async () => body,
    }),
  },
}));

async function flushAfter() {
  for (const callback of mockAfterCallbacks.splice(0)) {
    await callback();
  }
}

const { logAudit } = require('@/lib/audit');
const sendMail = require('@/lib/mail');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { verifyTurnstile } = require('@/lib/turnstile');
const { notifySiteUrlInvalid } = require('@/lib/ops/site-url-alert');
const { createServiceRoleClient } = require('@/lib/supabase/server');

let handler: any;

function build(body: unknown, init: { url?: string; headers?: Record<string, string> } = {}) {
  return new Request(init.url ?? 'http://localhost/api/auth/password-reset/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { email: 'test@example.com', turnstileToken: 'valid-token' };

function writes(table = 'password_reset_tokens') {
  return dbLog.filter((rec) => rec.table === table && rec.op && rec.op !== 'select');
}

function tokenFromMail() {
  const text: string = sendMail.mock.calls[0][0].text;
  const match = text.match(/\/auth\/password-reset\/verify\?token=([0-9a-f]+)/);
  return match ? match[1] : null;
}

const envBackup = { ...process.env };

describe('API-AUTH-009 POST /api/auth/password-reset/request - Integration Tests', () => {
  beforeAll(async () => {
    handler = (await import('@/app/api/auth/password-reset/request/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    verifyTurnstile.mockResolvedValue({ ok: true });
    dbResults = {};
    dbLog = [];
    rpcCalls = [];
    rpcResult = { data: 'user-123', error: null };
    mockAfterCallbacks.length = 0;
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  test('API-AUTH-009 アカウントが有れば 200 を返し、前の印を使用済みにしてから新しい印を保存する', async () => {
    const res = await handler(build(VALID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [invalidate, insert] = writes();
    expect(invalidate.op).toBe('update');
    expect(invalidate.calls).toEqual(
      expect.arrayContaining([
        ['update', [{ used: true }]],
        ['eq', ['email', 'test@example.com']],
        ['eq', ['used', false]],
      ])
    );
    expect(insert.op).toBe('insert');
  });

  test('API-AUTH-009 保存するのは印の SHA-256 だけで、メールのリンクの印と対応する', async () => {
    await handler(build(VALID));
    await flushAfter();

    const rawToken = tokenFromMail();
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    const insert = writes().find((rec) => rec.op === 'insert')!;
    const [row] = insert.calls.find(([name]) => name === 'insert')![1][0];
    expect(row).toEqual({
      user_id: 'user-123',
      email: 'test@example.com',
      token_hash: require('crypto').createHash('sha256').update(rawToken!).digest('hex'),
      expires_at: expect.any(String),
      used: false,
    });
    expect(JSON.stringify(row)).not.toContain(rawToken);
  });

  test('API-AUTH-009 印の期限は 10 分で、メールにも書く', async () => {
    const before = Date.now();
    await handler(build(VALID));
    await flushAfter();

    const insert = writes().find((rec) => rec.op === 'insert')!;
    const [row] = insert.calls.find(([name]) => name === 'insert')![1][0];
    const ttl = new Date(row.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

    const mail = sendMail.mock.calls[0][0];
    expect(mail.text).toContain('10分間有効');
    expect(mail.html).toContain('10分間有効');
  });

  test('API-AUTH-009 メールは応答の外で送り、リンクは確認の画面を指して宛先を載せない', async () => {
    await handler(build(VALID));
    expect(sendMail).not.toHaveBeenCalled();

    await flushAfter();

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('test@example.com');
    expect(mail.subject).toBe('Password reset');
    expect(mail.text).toContain('http://localhost:3000/auth/password-reset/verify?token=');
    expect(mail.text).not.toContain('email=');
    expect(mail.html).toContain('http://localhost:3000/auth/password-reset/verify?token=');
  });

  test('API-AUTH-009 メールの宛先の大文字は小文字にして照会と保存に使う', async () => {
    await handler(build({ email: 'Test@Example.COM', turnstileToken: 'valid-token' }));
    await flushAfter();

    expect(rpcCalls).toEqual([{ name: 'find_auth_user_id_by_email', params: { p_email: 'test@example.com' } }]);
    expect(sendMail.mock.calls[0][0].to).toBe('test@example.com');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actor_email: 'test@example.com', outcome: 'success', detail: 'mail_queued' })
    );
  });

  test('API-AUTH-009 アカウントが無ければ同じ 200 を返し、印もメールも作らず監査にだけ残す', async () => {
    const found = await handler(build(VALID));
    const foundBody = await found.json();
    await flushAfter();
    sendMail.mockClear();
    dbLog = [];

    rpcResult = { data: null, error: null };
    const missing = await handler(build({ email: 'nobody@example.com', turnstileToken: 'valid-token' }));
    await flushAfter();

    expect(missing.status).toBe(found.status);
    expect(await missing.json()).toEqual(foundBody);
    expect(dbLog).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenLastCalledWith({
      action: 'password_reset_request',
      actor_email: 'nobody@example.com',
      outcome: 'success',
      resource_id: null,
      detail: 'no_account',
    });
  });

  test('API-AUTH-009 照会が引けなかった時は 500 にして、監査に error を残し、印を作らない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    rpcResult = { data: null, error: { message: 'rpc down' } };

    const res = await handler(build(VALID));
    await flushAfter();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(dbLog).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'test@example.com',
      outcome: 'error',
      detail: 'user_lookup_failed',
    });
  });

  test('API-AUTH-009 前の印を使用済みにできなくても、記録して新しい印を出す', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    dbResults = { password_reset_tokens: { update: { data: null, error: { message: 'update failed' } } } };

    const res = await handler(build(VALID));
    await flushAfter();

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to invalidate previous password reset tokens:',
      { message: 'update failed' }
    );
    expect(writes().map((rec) => rec.op)).toEqual(['update', 'insert']);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-009 印を保存できなければメールを送らず 500 にして監査に error を残す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    dbResults = { password_reset_tokens: { insert: { data: null, error: { message: 'insert failed' } } } };

    const res = await handler(build(VALID));
    await flushAfter();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'test@example.com',
      outcome: 'error',
      detail: 'token_persist_failed',
    });
  });

  test('API-AUTH-009 メールの送信が失敗しても応答は 200 のままで、例外を外へ出さない', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sendMail.mockRejectedValueOnce(new Error('smtp down'));

    const res = await handler(build(VALID));
    await expect(flushAfter()).resolves.toBeUndefined();

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith('Failed to send password reset mail:', expect.any(Error));
  });

  test('API-AUTH-009 形が合わない入力は 400 で、Turnstile も DB も見ない', async () => {
    const res = await handler(build({ email: 'not-an-email', turnstileToken: 'valid-token' }));

    expect(res.status).toBe(400);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(dbLog).toEqual([]);
  });

  test('API-AUTH-009 Turnstile の token が空文字の入力は 400', async () => {
    const res = await handler(build({ email: 'test@example.com', turnstileToken: '' }));

    expect(res.status).toBe(400);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  test('API-AUTH-009 Turnstile が通らなければ 403 にして監査に failure を残し、照会しない', async () => {
    verifyTurnstile.mockResolvedValueOnce({ ok: false, error: 'invalid-input-response' });

    const res = await handler(build(VALID));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Bot detection failed' });
    expect(rpcCalls).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_request',
      actor_email: 'test@example.com',
      outcome: 'failure',
      detail: 'invalid-input-response',
    });
  });

  test('API-AUTH-009 Turnstile の失敗に理由が無ければ turnstile_failed を監査に残す', async () => {
    verifyTurnstile.mockResolvedValueOnce({ ok: false });

    const res = await handler(build(VALID));

    expect(res.status).toBe(403);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'turnstile_failed' }));
  });

  test('API-AUTH-009 Turnstile には token と x-real-ip の IP を渡す', async () => {
    await handler(build(VALID, { headers: { 'x-real-ip': '203.0.113.9' } }));
    expect(verifyTurnstile).toHaveBeenLastCalledWith('valid-token', '203.0.113.9');

    await handler(build(VALID));
    expect(verifyTurnstile).toHaveBeenLastCalledWith('valid-token', null);
  });

  test('API-AUTH-009 IP の回数の制限に掛かれば、その応答をそのまま返して何も進めない', async () => {
    const limited = { status: 429, marker: 'limited' };
    enforceRateLimit.mockResolvedValueOnce(limited);

    const res = await handler(build(VALID));

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:password_reset_request', limit: 10, windowSeconds: 3600 })
    );
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  test('API-AUTH-009 メール単位の制限は Turnstile の後に数え、掛かれば 429 を返して照会しない', async () => {
    const limited = { status: 429, marker: 'account-limited' };
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const res = await handler(build(VALID));

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        endpoint: 'auth:password_reset_request',
        limit: 5,
        windowSeconds: 3600,
        subject: 'test@example.com',
      })
    );
    expect(verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(enforceRateLimit.mock.invocationCallOrder[1]);
    expect(rpcCalls).toEqual([]);
  });

  test('API-AUTH-009 回数の制限の部品が例外を投げたら、500 で止まりメールを送らない（SEC-AUTH-013-AC-02）', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    enforceRateLimit.mockRejectedValueOnce(new Error('ip limiter down'));

    const res = await handler(build(VALID));
    await flushAfter();

    expect(res.status).toBe(500);
    expect(errorSpy).not.toHaveBeenCalledWith('Rate limit middleware error (password-reset):', expect.anything());
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('API-AUTH-009 メール単位の回数の制限の部品が例外を投げたら、500 で止まりメールを送らない（SEC-AUTH-013-AC-02）', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    enforceRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('acct limiter down'));

    const res = await handler(build(VALID));
    await flushAfter();

    expect(res.status).toBe(500);
    expect(errorSpy).not.toHaveBeenCalledWith('Rate limit middleware error (password-reset-account):', expect.anything());
    expect(sendMail).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  test('API-AUTH-009 許可していない住所では同じ 200 を返し、印もメールも作らず運用へ知らせる', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';

    const res = await handler(build(VALID));
    await flushAfter();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-009 本番で許可した住所なら、その住所でリンクを作り運用へは知らせない', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shop.example.com';

    const res = await handler(build(VALID, { url: 'https://shop.example.com/api/auth/password-reset/request' }));
    await flushAfter();

    expect(res.status).toBe(200);
    expect(sendMail.mock.calls[0][0].text).toContain('https://shop.example.com/auth/password-reset/verify?token=');
    expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
  });

  test('API-AUTH-009 偽の住所で届いた要求でも、リンクは許可した住所で作る', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shop.example.com';

    await handler(build(VALID, { url: 'https://evil.example.org/api/auth/password-reset/request', headers: { host: 'evil.example.org' } }));
    await flushAfter();

    const text: string = sendMail.mock.calls[0][0].text;
    expect(text).toContain('https://shop.example.com/auth/password-reset/verify?token=');
    expect(text).not.toContain('evil.example.org');
  });

  test('API-AUTH-009 本文が JSON でなければ 500 にして中身を出さない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(build('{not json'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('API-AUTH-009 応答の本文に印も宛先の有無も出さない', async () => {
    const res = await handler(build(VALID));
    await flushAfter();

    const text = JSON.stringify(await res.json());
    expect(text).toBe('{"ok":true}');
    expect(text).not.toContain(tokenFromMail()!);
  });
});

export {};
