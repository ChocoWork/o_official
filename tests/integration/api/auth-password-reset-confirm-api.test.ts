jest.mock('server-only', () => ({}), { virtual: true });

/**
 * API-AUTH-012 POST /api/auth/password-reset/confirm の結合テスト。
 * 窓口・スキーマ・再設定の Cookie の署名は本物を使い、DB・Supabase Auth・漏洩の照合・メール・回数の制限・監査だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: jest.fn(),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));

jest.mock('@/lib/mail', () => jest.fn().mockResolvedValue(undefined));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

type Op = 'select' | 'insert' | 'update' | 'delete';
type Result = { data: any; error: any };
type Recorded = { table: string; op: Op | null; calls: Array<[string, any[]]> };

let dbResults: Record<string, Partial<Record<Op, Result>>>;
let dbLog: Recorded[];
let rpcResult: Result;
let rpcCalls: Array<{ name: string; params: any }>;
let updateUserResult: { data: any; error: any };
let updateUserCalls: any[][];

function makeChain(table: string): any {
  const rec: Recorded = { table, op: null, calls: [] };
  dbLog.push(rec);
  const chain: any = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'gte', 'lt']) {
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
    auth: {
      admin: {
        updateUserById: (...args: any[]) => {
          updateUserCalls.push(args);
          return Promise.resolve(updateUserResult);
        },
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
    json: (body: unknown, init?: any) => {
      const cookieCalls: any[] = [];
      return {
        status: init?.status ?? 200,
        headers: new Headers(),
        cookies: { set: jest.fn((value: any) => cookieCalls.push(value)) },
        _cookies: cookieCalls,
        json: async () => body,
      };
    },
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
const { checkPwnedPassword, PWNED_PASSWORD_MESSAGE } = require('@/lib/pwned-password');
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { createPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');

let handler: any;

const GOOD_PASSWORD = 'CorrectHorseBattery42';
const TOKENS = 'password_reset_tokens';

function sessionCookie(overrides: { expiresInSeconds?: number } = {}) {
  const token = createPasswordResetSessionToken({
    userId: 'user-123',
    email: 'test@example.com',
    tokenId: 'token-123',
    ...overrides,
  });
  return `sb-password-reset-session=${encodeURIComponent(token)}`;
}

function build(body: unknown, cookie: string | null = sessionCookie()) {
  return new Request('http://localhost/api/auth/password-reset/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function tokenWrites(op: Op) {
  return dbLog.filter((rec) => rec.table === TOKENS && rec.op === op);
}

function hasCall(rec: Recorded, name: string, args?: any[]) {
  return rec.calls.some(([n, a]) => n === name && (!args || JSON.stringify(a) === JSON.stringify(args)));
}

const envBackup = { ...process.env };

describe('API-AUTH-012 POST /api/auth/password-reset/confirm - Integration Tests', () => {
  beforeAll(async () => {
    handler = (await import('@/app/api/auth/password-reset/confirm/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    checkPwnedPassword.mockResolvedValue({ status: 'ok' });
    dbResults = {
      [TOKENS]: {
        select: { data: { id: 'token-123' }, error: null },
        update: { data: { id: 'token-123' }, error: null },
        delete: { data: null, error: null },
      },
      sessions: { update: { data: null, error: null } },
    };
    dbLog = [];
    rpcCalls = [];
    rpcResult = { data: null, error: null };
    updateUserResult = { data: { user: { id: 'user-123' } }, error: null };
    updateUserCalls = [];
    mockAfterCallbacks.length = 0;
    process.env.JWT_SECRET = 'test-jwt-secret';
    delete process.env.PASSWORD_RESET_SESSION_SECRET;
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  test('API-AUTH-012 成功したら新しいパスワードに変えて 200 を返し、監査に success を残す', async () => {
    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateUserCalls).toEqual([['user-123', { password: GOOD_PASSWORD }]]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'success',
      resource_id: 'user-123',
    });
  });

  test('API-AUTH-012 印は Cookie の行 id で引き、未使用かだけを見て期限は見ない', async () => {
    await handler(build({ new_password: GOOD_PASSWORD }));

    const lookup = tokenWrites('select')[0];
    expect(hasCall(lookup, 'select', ['id'])).toBe(true);
    expect(hasCall(lookup, 'eq', ['id', 'token-123'])).toBe(true);
    expect(hasCall(lookup, 'eq', ['used', false])).toBe(true);
    expect(hasCall(lookup, 'gte')).toBe(false);
    expect(hasCall(lookup, 'lt')).toBe(false);
  });

  test('API-AUTH-012 順番は 印の確かめ → 漏洩の照合 → 印の消費 → パスワードの更新 → 行の削除 → セッションの失効', async () => {
    const order: string[] = [];
    checkPwnedPassword.mockImplementation(async () => {
      order.push('pwned');
      return { status: 'ok' };
    });
    const { createServiceRoleClient: factory } = require('@/lib/supabase/server');
    factory.mockImplementationOnce(async () => ({
      from: (table: string) => {
        const chain = makeChain(table);
        let seen = false;
        const record = (name: string) => {
          const original = chain[name];
          chain[name] = jest.fn((...args: any[]) => {
            if (!seen) {
              seen = true;
              order.push(`${table}.${name}`);
            }
            return original(...args);
          });
        };
        ['select', 'update', 'delete'].forEach(record);
        return chain;
      },
      rpc: (name: string, params: any) => {
        order.push(`rpc.${name}`);
        rpcCalls.push({ name, params });
        return Promise.resolve(rpcResult);
      },
      auth: {
        admin: {
          updateUserById: (...args: any[]) => {
            order.push('updateUserById');
            updateUserCalls.push(args);
            return Promise.resolve(updateUserResult);
          },
        },
      },
    }));

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(200);
    expect(order).toEqual([
      `${TOKENS}.select`,
      'pwned',
      `${TOKENS}.update`,
      'updateUserById',
      `${TOKENS}.delete`,
      'sessions.update',
      'rpc.revoke_auth_sessions_for_user',
    ]);
  });

  test('API-AUTH-012 印の消費は未使用を条件に used を true にして行を取り返す', async () => {
    await handler(build({ new_password: GOOD_PASSWORD }));

    const claim = tokenWrites('update')[0];
    expect(hasCall(claim, 'update', [{ used: true }])).toBe(true);
    expect(hasCall(claim, 'eq', ['id', 'token-123'])).toBe(true);
    expect(hasCall(claim, 'eq', ['used', false])).toBe(true);
    expect(hasCall(claim, 'select', ['id'])).toBe(true);
  });

  test('API-AUTH-012 消費に負けたら 400 にして、パスワードを変えず監査に failure を残す', async () => {
    dbResults[TOKENS].update = { data: null, error: null };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired reset session' });
    expect(updateUserCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'failure',
      detail: 'token_already_consumed',
    });
  });

  test('API-AUTH-012 消費が失敗したら 500 にして、パスワードを変えず監査に error を残す', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    dbResults[TOKENS].update = { data: null, error: { message: 'claim failed' } };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(updateUserCalls).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'error',
      detail: 'token_claim_failed',
    });
  });

  test('API-AUTH-012 印が無いか使用済みなら 400 にして、漏洩の照合も消費もしない', async () => {
    dbResults[TOKENS].select = { data: null, error: null };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired reset session' });
    expect(checkPwnedPassword).not.toHaveBeenCalled();
    expect(tokenWrites('update')).toEqual([]);
    expect(updateUserCalls).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'failure',
      detail: 'invalid_or_consumed_token',
    });
  });

  test('API-AUTH-012 印の照会が失敗したら 500 にして、漏洩の照合もしない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    dbResults[TOKENS].select = { data: null, error: { message: 'db down' } };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(checkPwnedPassword).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'error',
      detail: 'token_lookup_failed',
    });
  });

  test('API-AUTH-012 漏洩済みのパスワードは 400 と固定の文言で断り、印は消費しない', async () => {
    checkPwnedPassword.mockResolvedValue({ status: 'pwned', count: 123456 });

    const res = await handler(build({ new_password: GOOD_PASSWORD }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: PWNED_PASSWORD_MESSAGE });
    expect(JSON.stringify(body)).not.toContain('123456');
    expect(checkPwnedPassword).toHaveBeenCalledWith(GOOD_PASSWORD);
    expect(tokenWrites('update')).toEqual([]);
    expect(updateUserCalls).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'failure',
      detail: 'pwned_password',
    });
  });

  test('API-AUTH-012 漏洩の照合先が落ちていても再設定は通し、監査に error を残す', async () => {
    checkPwnedPassword.mockResolvedValue({ status: 'unavailable', reason: 'TimeoutError' });

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(200);
    expect(updateUserCalls).toHaveLength(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'error',
      detail: 'pwned_check_unavailable:TimeoutError',
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  test('API-AUTH-012 パスワードの更新が失敗したら 500 にして、行の削除も失効もしない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    updateUserResult = { data: { user: null }, error: { message: 'Password should be stronger' } };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to update password' });
    expect(tokenWrites('delete')).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(res._cookies).toEqual([]);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      actor_email: 'test@example.com',
      outcome: 'error',
      detail: 'Password should be stronger',
    });
    await flushAfter();
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('API-AUTH-012 使い終わった印の行を id で削除する', async () => {
    await handler(build({ new_password: GOOD_PASSWORD }));

    const [del] = tokenWrites('delete');
    expect(hasCall(del, 'eq', ['id', 'token-123'])).toBe(true);
  });

  test('API-AUTH-012 行の削除が失敗しても記録だけで 200 のまま', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    dbResults[TOKENS].delete = { data: null, error: { message: 'delete failed' } };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith('Failed to delete consumed password reset token:', { message: 'delete failed' });
  });

  test('API-AUTH-012 自前のセッションと Supabase のセッションを利用者単位で全部失効させる', async () => {
    await handler(build({ new_password: GOOD_PASSWORD }));

    const sessions = dbLog.find((rec) => rec.table === 'sessions')!;
    expect(sessions.op).toBe('update');
    const [, [patch]] = sessions.calls.find(([name]) => name === 'update')!;
    expect(patch).toEqual({ revoked_at: expect.any(String) });
    expect(Number.isNaN(Date.parse(patch.revoked_at))).toBe(false);
    expect(hasCall(sessions, 'eq', ['user_id', 'user-123'])).toBe(true);
    expect(rpcCalls).toEqual([{ name: 'revoke_auth_sessions_for_user', params: { p_user_id: 'user-123' } }]);
  });

  test('API-AUTH-012 失効が失敗しても記録だけで 200 を返し、失敗の監査は残さない', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    dbResults.sessions.update = { data: null, error: { message: 'sessions down' } };
    rpcResult = { data: null, error: { message: 'rpc down' } };

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith('[password-reset.confirm] failed to revoke app sessions:', { message: 'sessions down' });
    expect(errorSpy).toHaveBeenCalledWith('[password-reset.confirm] failed to revoke auth sessions:', { message: 'rpc down' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  test('API-AUTH-012 再設定・access・refresh・CSRF の Cookie を空にして消す', async () => {
    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res._cookies.map((c: any) => c.name).sort()).toEqual(
      ['sb-access-token', 'sb-csrf-token', 'sb-password-reset-session', 'sb-refresh-token']
    );
    for (const cookie of res._cookies) {
      expect(cookie).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    }
  });

  test('API-AUTH-012 本人への通知のメールを応答の外で送り、本文にパスワードを入れない', async () => {
    await handler(build({ new_password: GOOD_PASSWORD }));
    expect(sendMail).not.toHaveBeenCalled();

    await flushAfter();

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('test@example.com');
    expect(mail.subject).toBe('パスワードを変更しました');
    expect(mail.html).not.toContain(GOOD_PASSWORD);
    expect(mail.text).not.toContain(GOOD_PASSWORD);
  });

  test('API-AUTH-012 通知のメールが失敗しても応答は 200 のままで、例外を外へ出さない', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    sendMail.mockRejectedValueOnce(new Error('smtp down'));

    const res = await handler(build({ new_password: GOOD_PASSWORD }));
    await expect(flushAfter()).resolves.toBeUndefined();

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith('Failed to send password change notification:', expect.any(Error));
  });

  test('API-AUTH-012 Cookie が無ければ 400 にして、DB も漏洩の照合も見ない', async () => {
    const res = await handler(build({ new_password: GOOD_PASSWORD }, null));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired reset session' });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(checkPwnedPassword).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'password_reset_confirm',
      outcome: 'failure',
      detail: 'missing_reset_session',
    });
  });

  test('API-AUTH-012 署名が違う Cookie・期限が切れた Cookie も Cookie が無いのと同じに 400', async () => {
    const forged = 'sb-password-reset-session=' + encodeURIComponent(`${Buffer.from('{}').toString('base64url')}.${'A'.repeat(43)}`);
    const expired = sessionCookie({ expiresInSeconds: -1 });

    for (const cookie of [forged, expired]) {
      const res = await handler(build({ new_password: GOOD_PASSWORD }, cookie));
      expect(res.status).toBe(400);
    }
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(updateUserCalls).toEqual([]);
  });

  test.each([
    ['15 文字', 'a'.repeat(15)],
    ['129 文字', 'a'.repeat(129)],
    ['73 バイト（GoTrue は 72 バイトまで）', 'a'.repeat(73)],
    ['日本語 25 文字（75 バイト）', 'あ'.repeat(25)],
    ['new_password が無い', undefined],
    ['new_password が文字列でない', 12345678901234567],
  ])('API-AUTH-012 新しいパスワードが「%s」のときは 400 で、DB も漏洩の照合も見ない', async (_label, value) => {
    const res = await handler(build(value === undefined ? {} : { new_password: value }));

    expect(res.status).toBe(400);
    expect(checkPwnedPassword).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(updateUserCalls).toEqual([]);
  });

  test('API-AUTH-012 16 文字ちょうど・72 バイトちょうどは受ける', async () => {
    const short = await handler(build({ new_password: 'a1b2c3d4e5f6g7h8' }));
    const long = await handler(build({ new_password: 'x'.repeat(72) }));

    expect(short.status).toBe(200);
    expect(long.status).toBe(200);
    expect(updateUserCalls.map((call) => call[1].password.length)).toEqual([16, 72]);
  });

  test('API-AUTH-012 確認の欄の値（confirm_password）は受けず、渡されても更新に使わない', async () => {
    const res = await handler(build({ new_password: GOOD_PASSWORD, confirm_password: 'something-else-entirely' }));

    expect(res.status).toBe(200);
    expect(updateUserCalls).toEqual([['user-123', { password: GOOD_PASSWORD }]]);
  });

  test('API-AUTH-012 回数の制限に掛かればその応答を返して Cookie も DB も見ない', async () => {
    const limited = { status: 429, marker: 'limited' };
    enforceRateLimit.mockResolvedValueOnce(limited);

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:password_reset_confirm', limit: 10, windowSeconds: 3600 })
    );
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test('API-AUTH-012 回数の制限の部品が落ちたら 500 で止まり、パスワードを変えない（SEC-AUTH-013-AC-02）', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    enforceRateLimit.mockRejectedValueOnce(new Error('limiter down'));

    const res = await handler(build({ new_password: GOOD_PASSWORD }));

    expect(res.status).toBe(500);
    expect(errorSpy).not.toHaveBeenCalledWith('Rate limit middleware error (password-reset-confirm):', expect.anything());
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test('API-AUTH-012 本文が JSON でなければ 500 にして中身を出さない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(build('{not json'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(updateUserCalls).toEqual([]);
  });
});

export {};
