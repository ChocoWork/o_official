/**
 * Password Reset API Integration Tests
 * タスク: [AUTH-01-09]
 * 対応 REQ: REQ-AUTH-004 / FREQ-319
 * 対応 ARCH-ID: ARCH-AUTH-04
 */

// 漏洩パスワード検査は外部 API（HaveIBeenPwned）を叩く。テストからネットワークへ出さない。
// 検査そのものの挙動は tests/unit/lib/pwned-password.test.ts が担当する。
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: 'ok' }),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));

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

jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn((token: string) => `hashed_${token}`),
}));

// Mock Supabase client with dynamic configuration
let mockFromImplementation: any;
let mockUpdateUserByIdImplementation: any;
let mockRpcImplementation: any;

/** PostgREST 風のチェーン。await でも .maybeSingle() でも解決できる */
function makeChain(result: { data: any; error: any }) {
  const chain: any = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'gte', 'lt', 'order', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));
  chain.single = chain.maybeSingle;
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

/**
 * 本番と同じく「メソッドは this を参照する」形にしておく。
 * 素のオブジェクトリテラルにすると、プロダクション側がメソッドをレシーバから
 * 引き剥がして呼んでいても検出できない（それが F1 を本番でだけ落とした原因）。
 */
class FakeServiceClient {
  private readonly marker = 'service-role';

  auth = {
    admin: {
      updateUserById: jest.fn((...args: any[]) => {
        if (mockUpdateUserByIdImplementation) {
          return mockUpdateUserByIdImplementation(...args);
        }
        return Promise.resolve({ data: { user: { id: 'user-123' } }, error: null });
      }),
    },
  };

  from(table: string) {
    if (this.marker !== 'service-role') throw new Error('detached receiver');
    if (mockFromImplementation) {
      return mockFromImplementation(table);
    }
    return makeChain({ data: null, error: null });
  }

  rpc(name: string, params: unknown) {
    if (this.marker !== 'service-role') throw new Error('detached receiver');
    if (mockRpcImplementation) {
      return mockRpcImplementation(name, params);
    }
    if (name === 'find_auth_user_id_by_email') {
      return Promise.resolve({ data: 'user-123', error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => new FakeServiceClient()),
}));

// after() のコールバックを溜めて、テスト側から明示的に流す
const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  after: (fn: () => unknown) => {
    mockAfterCallbacks.push(fn);
  },
  NextResponse: {
    json: (body: any, init?: any) => {
      const headers = new Headers(init?.headers);
      const cookieCalls: any[] = [];
      return {
        status: init?.status ?? 200,
        headers,
        cookies: {
          set: jest.fn((value: any) => {
            cookieCalls.push(value);
          }),
        },
        _body: body,
        _cookies: cookieCalls,
        json: async () => body,
      };
    },
    redirect: (url: URL | string, init?: any) => {
      const headers = new Headers(init?.headers);
      headers.set('location', String(url));
      const cookieCalls: any[] = [];
      return {
        status: init?.status ?? 303,
        headers,
        cookies: {
          set: jest.fn((value: any) => {
            cookieCalls.push(value);
          }),
        },
        _body: null,
        _cookies: cookieCalls,
        json: async () => null,
      };
    },
  },
}));

async function flushAfter() {
  const callbacks = mockAfterCallbacks.splice(0);
  for (const callback of callbacks) {
    await callback();
  }
}

const { logAudit } = require('@/lib/audit');
const sendMail = require('@/lib/mail');
let requestHandler: any;
let confirmHandler: any;
let linkGetHandler: any;
let linkPostHandler: any;
let sessionHandler: any;

describe('Password Reset API - Integration Tests', () => {
  beforeAll(async () => {
    requestHandler = (await import('@/app/api/auth/password-reset/request/route')).POST;
    confirmHandler = (await import('@/app/api/auth/password-reset/confirm/route')).POST;
    const linkRoute = await import('@/app/api/auth/password-reset/link/route');
    linkGetHandler = linkRoute.GET;
    linkPostHandler = linkRoute.POST;
    sessionHandler = (await import('@/app/api/auth/password-reset/session/route')).GET;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFromImplementation = null;
    mockUpdateUserByIdImplementation = null;
    mockRpcImplementation = null;
    mockAfterCallbacks.length = 0;
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
  });

  describe('POST /api/auth/password-reset/request', () => {
    describe('正常系', () => {
      test('[SUCCESS] メール送信リクエストで 200 OK', async () => {
        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'valid-token' }),
        });

        const res: any = await requestHandler(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);

        // メール送信は after() に移したので、応答時点ではまだ呼ばれていない
        expect(sendMail).not.toHaveBeenCalled();
        await flushAfter();

        expect(sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'test@example.com',
            subject: 'Password reset',
            text: expect.stringContaining('/auth/password-reset/verify?token='),
          })
        );
        expect(sendMail.mock.calls[0][0].text).not.toContain('email=');

        expect(logAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'password_reset_request',
            actor_email: 'test@example.com',
            outcome: 'success',
            resource_id: 'user-123',
          })
        );
      });

      test('[SECURITY] 存在しないメールでは 200 を返すがメールは送らない', async () => {
        mockRpcImplementation = jest.fn().mockResolvedValue({ data: null, error: null });

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nonexistent@example.com', turnstileToken: 'valid-token' }),
        });

        const res: any = await requestHandler(req);
        const body = await res.json();

        // 列挙対策として応答は存在する場合と同一
        expect(res.status).toBe(200);
        expect(body).toEqual({ ok: true });

        // 未登録アドレスへ当社ドメインからメールを出さない（メールリレー悪用の防止）
        await flushAfter();
        expect(sendMail).not.toHaveBeenCalled();
      });

      test('[SUCCESS] トークンがハッシュ化されて保存される', async () => {
        const chain = makeChain({ data: null, error: null });
        mockFromImplementation = () => chain;

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'valid-token' }),
        });

        await requestHandler(req);

        expect(chain.insert).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              email: 'test@example.com',
              used: false,
              token_hash: expect.stringContaining('hashed_'),
              expires_at: expect.any(String),
            }),
          ])
        );
      });

      test('[SECURITY] リンクの有効期限は 10 分で、メール本文にも明記する', async () => {
        // 消費を confirm へ移したので TTL がそのまま漏洩窓になる。
        // OWASP ASVS v4.0.3 V2.7.2 の 10 分に合わせる。
        const chain = makeChain({ data: null, error: null });
        mockFromImplementation = () => chain;
        const before = Date.now();

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'valid-token' }),
        });

        await requestHandler(req);

        const inserted = chain.insert.mock.calls[0][0][0];
        const ttlMs = new Date(inserted.expires_at).getTime() - before;
        expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
        expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);

        await flushAfter();
        const mail = sendMail.mock.calls[0][0];
        expect(mail.text).toContain('10分間有効');
        expect(mail.html).toContain('10分間有効');
      });

      test('[SECURITY] 新規発行前に同じ宛先の未使用トークンを無効化する', async () => {
        const chain = makeChain({ data: null, error: null });
        mockFromImplementation = () => chain;

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'valid-token' }),
        });

        await requestHandler(req);

        expect(chain.update).toHaveBeenCalledWith({ used: true });
        expect(chain.eq).toHaveBeenCalledWith('email', 'test@example.com');
        expect(chain.eq).toHaveBeenCalledWith('used', false);
      });
    });

    describe('異常系', () => {
      test('[ERROR] トークン保存に失敗したらメールを送らず 500', async () => {
        mockFromImplementation = () => makeChain({ data: null, error: { message: 'insert failed' } });

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'valid-token' }),
        });

        const res: any = await requestHandler(req);

        expect(res.status).toBe(500);
        await flushAfter();
        expect(sendMail).not.toHaveBeenCalled();
      });

      test('[ERROR] Turnstile 検証失敗で 403 Forbidden', async () => {
        const { verifyTurnstile } = require('@/lib/turnstile');
        verifyTurnstile.mockResolvedValue({ ok: false, error: 'Invalid token' });

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'invalid-token' }),
        });

        const res: any = await requestHandler(req);

        expect(res.status).toBe(403);
        await flushAfter();
        expect(sendMail).not.toHaveBeenCalled();

        verifyTurnstile.mockResolvedValue({ ok: true });
      });

      test('[VALIDATION] 不正なメールフォーマットで 400 Bad Request', async () => {
        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'invalid-email', turnstileToken: 'valid-token' }),
        });

        const res: any = await requestHandler(req);
        expect(res.status).toBe(400);
      });
    });

    describe('セキュリティ', () => {
      test('[SECURITY] レート制限チェックが実行されている', async () => {
        const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', turnstileToken: 'valid-token' }),
        });

        await requestHandler(req);
        expect(enforceRateLimit).toHaveBeenCalled();
      });
    });
  });

  describe('GET /api/auth/password-reset/link', () => {
    test('[SECURITY] トークンを消費せず確認ページへ 303 リダイレクトする', async () => {
      const chain = makeChain({ data: null, error: null });
      mockFromImplementation = () => chain;

      const req = new Request('http://localhost/api/auth/password-reset/link?token=valid-token', {
        method: 'GET',
      });

      const res: any = await linkGetHandler(req);

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/auth/password-reset/verify?token=valid-token'
      );
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

      // メールスキャナの GET でトークンが潰れないこと
      expect(chain.update).not.toHaveBeenCalled();
    });

    test('[ERROR] token がなければ理由付きでリダイレクトする', async () => {
      const req = new Request('http://localhost/api/auth/password-reset/link', { method: 'GET' });
      const res: any = await linkGetHandler(req);

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('error=link_invalid');
    });
  });

  describe('POST /api/auth/password-reset/link', () => {
    test('[SUCCESS] トークンを消費せず検証だけ行い reset-session cookie を張る', async () => {
      const chain = makeChain({
        data: { id: 'token-123', user_id: 'user-123', email: 'test@example.com' },
        error: null,
      });
      mockFromImplementation = () => chain;

      const req = new Request('http://localhost/api/auth/password-reset/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'valid-token' }),
      });

      const res: any = await linkPostHandler(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);

      // FREQ-319-REQ-03: リンク到達時に副作用を持たせない。ここで消費すると、
      // JS を実行して展開するリンクスキャナに踏まれた時点でトークンが潰れる。
      expect(chain.update).not.toHaveBeenCalled();
      expect(chain.select).toHaveBeenCalledWith('id, user_id, email');
      expect(chain.eq).toHaveBeenCalledWith('used', false);
      expect(chain.eq).toHaveBeenCalledWith('token_hash', expect.any(String));

      // 再設定 Cookie の寿命はリンクと同じ 10 分。confirm では expires_at を
      // 再検査しないので、この Max-Age が時間の境界そのものになる。
      expect(res._cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'sb-password-reset-session', maxAge: 600 }),
        ])
      );
    });

    test('[ERROR] 使用済み・期限切れなら 400 link_expired', async () => {
      mockFromImplementation = () => makeChain({ data: null, error: null });

      const req = new Request('http://localhost/api/auth/password-reset/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'used-token' }),
      });

      const res: any = await linkPostHandler(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('link_expired');
      expect(res._cookies).toEqual([]);
    });
  });

  describe('POST /api/auth/password-reset/confirm', () => {
    async function buildSessionCookie() {
      const { createPasswordResetSessionToken } = await import(
        '@/features/auth/services/password-reset-session'
      );
      return createPasswordResetSessionToken({
        userId: 'user-123',
        email: 'test@example.com',
        tokenId: 'token-123',
      });
    }

    test('[SUCCESS] reset-session cookie でパスワード更新 200 OK', async () => {
      mockFromImplementation = () => makeChain({ data: { id: 'token-123' }, error: null });
      const sessionToken = await buildSessionCookie();

      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      const res: any = await confirmHandler(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'password_reset_confirm',
          actor_email: 'test@example.com',
          outcome: 'success',
          resource_id: 'user-123',
        })
      );

      // 再設定 Cookie と認証 Cookie の両方を落とす
      const cookieNames = res._cookies.map((c: any) => c.name);
      expect(cookieNames).toEqual(
        expect.arrayContaining([
          'sb-password-reset-session',
          'sb-access-token',
          'sb-refresh-token',
          'sb-csrf-token',
        ])
      );
    });

    test('[SECURITY] 消費はここで初めて行う（used=false を条件に確保する）', async () => {
      const chains: any[] = [];
      mockFromImplementation = () => {
        const chain = makeChain({ data: { id: 'token-123' }, error: null });
        chains.push(chain);
        return chain;
      };
      const sessionToken = await buildSessionCookie();

      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      const res: any = await confirmHandler(req);
      expect(res.status).toBe(200);

      const claim = chains.find((chain) =>
        chain.update.mock.calls.some((call: any[]) => call[0]?.used === true)
      );
      expect(claim).toBeDefined();
      expect(claim.eq).toHaveBeenCalledWith('used', false);
    });

    test('[SECURITY] 確保に負けたら 400 で、パスワードを更新しない', async () => {
      // 1 回目は事前確認（増幅対策）、2 回目が確保。0 行なら他が先に取っている。
      let call = 0;
      mockFromImplementation = () => {
        call += 1;
        return makeChain({ data: call === 1 ? { id: 'token-123' } : null, error: null });
      };
      const updateCalls: any[] = [];
      mockUpdateUserByIdImplementation = jest.fn(async (...args: any[]) => {
        updateCalls.push(args);
        return { data: {}, error: null };
      });
      const sessionToken = await buildSessionCookie();

      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      const res: any = await confirmHandler(req);

      expect(res.status).toBe(400);
      expect(updateCalls).toHaveLength(0);
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'password_reset_confirm',
          outcome: 'failure',
          detail: 'token_already_consumed',
        })
      );
    });

    test('[SECURITY] 更新後に全セッションを失効させる', async () => {
      const rpcCalls: Array<{ name: string; params: any }> = [];
      mockFromImplementation = () => makeChain({ data: { id: 'token-123' }, error: null });
      mockRpcImplementation = (name: string, params: any) => {
        rpcCalls.push({ name, params });
        return Promise.resolve({ data: null, error: null });
      };

      const sessionToken = await buildSessionCookie();
      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      await confirmHandler(req);

      expect(rpcCalls).toEqual(
        expect.arrayContaining([
          { name: 'revoke_auth_sessions_for_user', params: { p_user_id: 'user-123' } },
        ])
      );
    });

    test('[SECURITY] updateUserById が error を返したら 500（成功として返さない）', async () => {
      mockFromImplementation = () => makeChain({ data: { id: 'token-123' }, error: null });
      mockUpdateUserByIdImplementation = jest.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Password should contain at least one character of each' },
      });

      const sessionToken = await buildSessionCookie();
      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      const res: any = await confirmHandler(req);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Failed to update password');
    });

    test('[SECURITY] 消費済みトークン行が無ければ 400', async () => {
      mockFromImplementation = () => makeChain({ data: null, error: null });

      const sessionToken = await buildSessionCookie();
      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      const res: any = await confirmHandler(req);
      expect(res.status).toBe(400);
    });

    test('[ERROR] reset-session cookie が無ければ 400', async () => {
      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ new_password: 'NewPassword123456!' }),
      });

      const res: any = await confirmHandler(req);
      expect(res.status).toBe(400);
    });

    test('[VALIDATION] パスワードが短すぎる場合 400 Bad Request', async () => {
      mockFromImplementation = () => makeChain({ data: { id: 'token-123' }, error: null });
      const sessionToken = await buildSessionCookie();

      const req = new Request('http://localhost/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}`,
        },
        body: JSON.stringify({ new_password: 'short' }),
      });

      const res: any = await confirmHandler(req);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/auth/password-reset/session', () => {
    test('[SUCCESS] 有効な reset-session を返す', async () => {
      const { createPasswordResetSessionToken } = await import(
        '@/features/auth/services/password-reset-session'
      );
      const sessionToken = createPasswordResetSessionToken({
        userId: 'user-123',
        email: 'test@example.com',
        tokenId: 'token-123',
      });

      const req = new Request('http://localhost/api/auth/password-reset/session', {
        method: 'GET',
        headers: { cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}` },
      });

      const res: any = await sessionHandler(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ready: true, email: 'test@example.com' });
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });
});

export {};
