jest.mock('server-only', () => ({}), { virtual: true });

/**
 * ARC-AUTH-007 新しいパスワードは 16 文字以上で漏洩していない物だけを受け、メールのリンクは許可した住所で作る。
 * パスワードの決まり（スキーマ）と、当てる窓口（会員登録・再設定の完了）と、メールのリンクの住所の見張り（再設定の申請）を通して確かめる。
 * 窓口・スキーマ・住所の見張りは本物を使い、漏洩の照合先・DB・Supabase Auth・メール・Turnstile・回数の制限・監査・運用への知らせだけを差し替える。
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

let tokenLookup: { data: any; error: any };
let rpcResult: { data: any; error: any };
let updateUserCalls: any[][];
let signUpCalls: any[][];
let writes: string[];

function makeChain(table: string): any {
  let op: string | null = null;
  const chain: any = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq']) {
    chain[method] = jest.fn(() => {
      if (method !== 'eq' && !op) {
        op = method;
        if (method !== 'select') writes.push(`${table}.${method}`);
      }
      return chain;
    });
  }
  const resolve = () => (table === 'password_reset_tokens' && op === 'select' ? tokenLookup : { data: { id: 'token-123' }, error: null });
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolve()));
  chain.then = (ok: any, ng: any) => Promise.resolve(resolve()).then(ok, ng);
  return chain;
}

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    from: (table: string) => makeChain(table),
    rpc: () => Promise.resolve(rpcResult),
    auth: {
      admin: {
        updateUserById: (...args: any[]) => {
          updateUserCalls.push(args);
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  })),
  createClient: jest.fn(async () => ({
    auth: {
      signUp: (...args: any[]) => {
        signUpCalls.push(args);
        return Promise.resolve({ data: { session: null, user: { id: 'new-user' } }, error: null });
      },
    },
  })),
}));

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  after: (fn: () => unknown) => {
    mockAfterCallbacks.push(fn);
  },
  NextResponse: {
    json: (body: unknown, init?: any) => ({
      status: init?.status ?? 200,
      headers: new Headers(),
      cookies: { set: jest.fn() },
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
const { verifyTurnstile } = require('@/lib/turnstile');
const { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } = require('@/lib/pwned-password');
const { notifySiteUrlInvalid } = require('@/lib/ops/site-url-alert');
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { passwordSchema } = require('@/features/auth/schemas/common');
const { createPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');

let registerPost: any;
let requestPost: any;
let confirmPost: any;

const GOOD_PASSWORD = 'CorrectHorseBattery42';
const envBackup = { ...process.env };

function json(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function register(password: string, url = 'http://localhost/api/auth/register') {
  return registerPost(json(url, { email: 'new@example.com', password, turnstileToken: 't' }));
}

function resetCookie() {
  const token = createPasswordResetSessionToken({ userId: 'user-123', email: 'test@example.com', tokenId: 'token-123' });
  return `sb-password-reset-session=${encodeURIComponent(token)}`;
}

function confirm(password: string) {
  return confirmPost(json('http://localhost/api/auth/password-reset/confirm', { new_password: password }, { cookie: resetCookie() }));
}

function requestReset(url = 'http://localhost/api/auth/password-reset/request') {
  return requestPost(json(url, { email: 'test@example.com', turnstileToken: 't' }));
}

describe('ARC-AUTH-007 新しいパスワードは 16 文字以上で漏洩していない物だけを受け、メールのリンクは許可した住所で作る', () => {
  beforeAll(async () => {
    registerPost = (await import('@/app/api/auth/register/route')).POST;
    requestPost = (await import('@/app/api/auth/password-reset/request/route')).POST;
    confirmPost = (await import('@/app/api/auth/password-reset/confirm/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    checkPwnedPassword.mockResolvedValue({ status: 'ok' });
    verifyTurnstile.mockResolvedValue({ ok: true });
    tokenLookup = { data: { id: 'token-123' }, error: null };
    rpcResult = { data: null, error: null };
    updateUserCalls = [];
    signUpCalls = [];
    writes = [];
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

  describe('パスワードの決まり', () => {
    test.each([
      ['15 文字', 'a'.repeat(15), 'パスワードは16文字以上で入力してください'],
      ['129 文字', 'a'.repeat(129), 'パスワードは128文字以内で入力してください'],
      ['空文字', '', 'パスワードは16文字以上で入力してください'],
    ])('ARC-AUTH-007 パスワードが「%s」なら受けない', (_label, value, message) => {
      const result = passwordSchema.safeParse(value);

      expect(result.success).toBe(false);
      expect(result.error.issues[0].message).toBe(message);
    });

    test.each([
      ['16 文字ちょうど', 'a1b2c3d4e5f6g7h8'],
      ['128 文字ちょうど', 'x'.repeat(128)],
    ])('ARC-AUTH-007 パスワードが「%s」なら受ける', (_label, value) => {
      expect(passwordSchema.safeParse(value).success).toBe(true);
    });

    test.each([
      ['小文字だけ', 'abcdefghijklmnop'],
      ['数字だけ', '1234567890123456'],
      ['同じ文字の繰り返し', 'zzzzzzzzzzzzzzzz'],
      ['空白と日本語を含む長い文', 'これは 長い あいことば の 例 です'],
    ])('ARC-AUTH-007 文字の種類の決まりは課さない（%s）', (_label, value) => {
      expect(passwordSchema.safeParse(value).success).toBe(true);
    });

    test('ARC-AUTH-007 文字列でない値は受けない', () => {
      expect(passwordSchema.safeParse(1234567890123456).success).toBe(false);
      expect(passwordSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe('再設定の完了', () => {
    test('ARC-AUTH-007 漏洩していない 16 文字以上のパスワードは通る', async () => {
      const res = await confirm(GOOD_PASSWORD);

      expect(res.status).toBe(200);
      expect(checkPwnedPassword).toHaveBeenCalledTimes(1);
      expect(checkPwnedPassword).toHaveBeenCalledWith(GOOD_PASSWORD);
      expect(updateUserCalls).toEqual([['user-123', { password: GOOD_PASSWORD }]]);
    });

    test('ARC-AUTH-007 漏洩していれば固定の文言で断り、件数は出さず、パスワードも変えない', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'pwned', count: 987654 });

      const res = await confirm(GOOD_PASSWORD);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body).toEqual({ error: PWNED_PASSWORD_MESSAGE });
      expect(JSON.stringify(body)).not.toContain('987654');
      expect(updateUserCalls).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'pwned_password' }));
    });

    test('ARC-AUTH-007 照合先が落ちていれば止めずに通し、監査に error を残す', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'unavailable', reason: 'hibp_status_503' });

      const res = await confirm(GOOD_PASSWORD);

      expect(res.status).toBe(200);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'pwned_check_unavailable:hibp_status_503' })
      );
    });

    test('ARC-AUTH-007 16 文字に満たなければ照合先を呼ばずに 400', async () => {
      const res = await confirm('a'.repeat(15));

      expect(res.status).toBe(400);
      expect(checkPwnedPassword).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-007 照合は印の確かめの後で、偽の印では外の照合先を呼ばない', async () => {
      tokenLookup = { data: null, error: null };

      const res = await confirm(GOOD_PASSWORD);

      expect(res.status).toBe(400);
      expect(checkPwnedPassword).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-007 照合は印の消費・パスワードの更新より前で、漏洩していれば何も書かない', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'pwned', count: 1 });

      await confirm(GOOD_PASSWORD);

      expect(writes).toEqual([]);
    });
  });

  describe('会員登録', () => {
    test('ARC-AUTH-007 漏洩していない 16 文字以上のパスワードなら登録に進む', async () => {
      const res = await register(GOOD_PASSWORD);

      expect(res.status).toBe(202);
      expect(checkPwnedPassword).toHaveBeenCalledWith(GOOD_PASSWORD);
      expect(signUpCalls).toHaveLength(1);
      expect(signUpCalls[0][0]).toEqual(expect.objectContaining({ email: 'new@example.com', password: GOOD_PASSWORD }));
    });

    test('ARC-AUTH-007 漏洩していれば 400 で断り、アカウントの照会も作成もしない', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'pwned', count: 42 });

      const res = await register(GOOD_PASSWORD);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: PWNED_PASSWORD_MESSAGE });
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(signUpCalls).toEqual([]);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'register', outcome: 'failure', detail: 'pwned_password' })
      );
    });

    test('ARC-AUTH-007 照合先が落ちていれば止めずに登録を進め、監査に error を残す', async () => {
      checkPwnedPassword.mockResolvedValue({ status: 'unavailable', reason: 'TimeoutError' });

      const res = await register(GOOD_PASSWORD);

      expect(res.status).toBe(202);
      expect(signUpCalls).toHaveLength(1);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'register', outcome: 'error', detail: 'pwned_check_unavailable:TimeoutError' })
      );
    });

    test('ARC-AUTH-007 16 文字に満たなければ照合先を呼ばずに 400', async () => {
      const res = await register('short-pass-15ch');

      expect(res.status).toBe(400);
      expect(checkPwnedPassword).not.toHaveBeenCalled();
      expect(signUpCalls).toEqual([]);
    });

    test('ARC-AUTH-007 Turnstile が通らなければ照合先を呼ばない', async () => {
      verifyTurnstile.mockResolvedValueOnce({ ok: false, error: 'bad' });

      const res = await register(GOOD_PASSWORD);

      expect(res.status).toBe(403);
      expect(checkPwnedPassword).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-007 許可していない住所なら 503 で止め、照合先も登録も呼ばず運用へ知らせる', async () => {
      process.env.VERCEL_ENV = 'production';

      const res = await register(GOOD_PASSWORD);
      await flushAfter();

      expect(res.status).toBe(503);
      expect(checkPwnedPassword).not.toHaveBeenCalled();
      expect(signUpCalls).toEqual([]);
      expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
    });

    test('ARC-AUTH-007 本番で許可した住所なら、確認のリンクはその住所で作る', async () => {
      process.env.VERCEL_ENV = 'production';
      process.env.NEXT_PUBLIC_BASE_URL = 'https://shop.example.com';

      const res = await register(GOOD_PASSWORD, 'https://shop.example.com/api/auth/register');

      expect(res.status).toBe(202);
      expect(signUpCalls[0][0].options.emailRedirectTo).toMatch(/^https:\/\/shop\.example\.com\/api\/auth\/confirm/);
      expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
    });
  });

  describe('再設定の申請', () => {
    beforeEach(() => {
      rpcResult = { data: 'user-123', error: null };
    });

    test('ARC-AUTH-007 許可していない住所では同じ 200 を返し、印もメールも作らず運用へ知らせる', async () => {
      process.env.VERCEL_ENV = 'production';

      const res = await requestReset();
      await flushAfter();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(writes).toEqual([]);
      expect(sendMail).not.toHaveBeenCalled();
      expect(notifySiteUrlInvalid).toHaveBeenCalledTimes(1);
    });

    test('ARC-AUTH-007 本番で許可した住所なら、リンクはその住所で作る', async () => {
      process.env.VERCEL_ENV = 'production';
      process.env.NEXT_PUBLIC_BASE_URL = 'https://shop.example.com';

      const res = await requestReset('https://shop.example.com/api/auth/password-reset/request');
      await flushAfter();

      expect(res.status).toBe(200);
      expect(sendMail.mock.calls[0][0].text).toContain('https://shop.example.com/auth/password-reset/verify?token=');
      expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-007 偽の Host で届いてもリンクは許可した住所で作り、偽の住所を載せない', async () => {
      process.env.VERCEL_ENV = 'production';
      process.env.NEXT_PUBLIC_BASE_URL = 'https://shop.example.com';

      const forged = requestPost(
        json('https://evil.example.org/api/auth/password-reset/request', { email: 'test@example.com', turnstileToken: 't' }, { host: 'evil.example.org' })
      );
      await forged;
      await flushAfter();

      const text: string = sendMail.mock.calls[0][0].text;
      expect(text).toContain('https://shop.example.com/auth/password-reset/verify?token=');
      expect(text).not.toContain('evil.example.org');
    });

    test('ARC-AUTH-007 手元・確認用の環境では localhost の住所でもリンクを作る', async () => {
      const res = await requestReset();
      await flushAfter();

      expect(res.status).toBe(200);
      expect(sendMail.mock.calls[0][0].text).toContain('http://localhost:3000/auth/password-reset/verify?token=');
      expect(notifySiteUrlInvalid).not.toHaveBeenCalled();
    });
  });
});

export {};
