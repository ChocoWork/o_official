export {};

// 確認のメールのリンクの窓口（API-AUTH-006）。印の確かめ・送り先の絞り込み・失敗の握りつぶし方を確かめる。

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const headers = new Map<string, string>();
      return {
        status: init?.status ?? 200,
        json: async () => body,
        headers: { set: (k: string, v: string) => headers.set(k.toLowerCase(), v), get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      };
    },
    redirect: (url: any, init?: any) => {
      const headers = {
        _map: new Map<string, string>(),
        set(key: string, value: string) {
          this._map.set(key.toLowerCase(), value);
        },
        get(key: string) {
          return this._map.get(key.toLowerCase()) || null;
        },
      };
      headers.set('Location', url.toString());
      return {
        status: init?.status ?? 302,
        headers,
        cookies: {
          set: jest.fn(),
        },
      };
    },
  },
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockPersistSessionAndCookies = jest.fn();
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => mockPersistSessionAndCookies(...args),
}));

const mockLinkGuestOrdersByEmail = jest.fn();
jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: (...args: unknown[]) => mockLinkGuestOrdersByEmail(...args),
}));

const SESSION = { access_token: 'a', refresh_token: 'r', expires_in: 3600 };
const USER = { id: 'u1', email: 'user@example.com', email_confirmed_at: '2026-08-10T00:00:00Z' };

describe('API-AUTH-006 GET /api/auth/confirm', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_ALLOWED = env.APP_ALLOWED_ORIGINS;
  const ORIGINAL_TRUST = env.TRUST_PROXY_HEADERS;
  const verifyOtp = jest.fn();
  const errorSpy = jest.spyOn(console, 'error');

  // 既定は許可リストに無い http://localhost。x-forwarded-host を付けた時だけ、その origin が選ばれる
  function confirmRequest(query = '', headers: Record<string, string> = {}) {
    return new Request(`http://localhost/api/auth/confirm${query}`, { headers });
  }

  async function callGet(request: Request): Promise<any> {
    const route = await import('@/app/api/auth/confirm/route');
    return route.GET(request);
  }

  function auditCalls(outcome: string) {
    return mockLogAudit.mock.calls.map(([arg]) => arg).filter((arg) => arg.outcome === outcome);
  }

  afterAll(() => {
    env.APP_ALLOWED_ORIGINS = ORIGINAL_ALLOWED;
    env.TRUST_PROXY_HEADERS = ORIGINAL_TRUST;
    errorSpy.mockRestore();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy.mockImplementation(() => undefined);
    // x-forwarded-host は二段の条件を満たしたときだけ採用される。
    // 1) 信頼できる proxy 配下であること（TRUST_PROXY_HEADERS / VERCEL）
    // 2) その origin が許可リストに載っていること
    // どちらも Host ヘッダー注入によるオープンリダイレクト対策。
    env.TRUST_PROXY_HEADERS = 'true';
    env.APP_ALLOWED_ORIGINS = 'http://example.com';
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockPersistSessionAndCookies.mockResolvedValue({ ok: true });
    mockLinkGuestOrdersByEmail.mockResolvedValue(0);
    verifyOtp.mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    const { createPublicClient } = require('@/lib/supabase/server');
    createPublicClient.mockResolvedValue({ auth: { verifyOtp } });
  });

  describe('入口', () => {
    test('API-AUTH-006 IP の制限に当たったらその応答を返し、印の確かめも保存もしない', async () => {
      const limited = Object.assign(new Response('{}', { status: 429 }), { marker: 'rl' });
      mockEnforceRateLimit.mockResolvedValue(limited);

      const res = await callGet(confirmRequest('?token_hash=t'));

      expect(res).toBe(limited);
      expect(mockEnforceRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:confirm', limit: 50, windowSeconds: 600 }),
      );
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
    });

    test('API-AUTH-006 制限が Response 以外を返しても 429 と Retry-After で止める', async () => {
      mockEnforceRateLimit.mockResolvedValue({ limited: true });

      const res = await callGet(confirmRequest('?token_hash=t'));

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(verifyOtp).not.toHaveBeenCalled();
    });

    test('API-AUTH-006 制限の部品が落ちても確認の処理は止めない', async () => {
      mockEnforceRateLimit.mockRejectedValue(new Error('rate limit down'));

      const res = await callGet(confirmRequest('?token_hash=t&type=signup'));

      expect(res.status).toBe(303);
      expect(verifyOtp).toHaveBeenCalledTimes(1);
    });

    test('API-AUTH-006 印が無ければ確かめず、既定の送り先へ 303 で移して監査に残す', async () => {
      const res = await callGet(
        confirmRequest('', { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'http' }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://example.com/account');
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'failure', detail: 'missing_token_hash' }),
      );
    });
  });

  describe('印の確かめと保存', () => {
    test('API-AUTH-006 印が正しければ redirect_to へ 303 で移し、セッションを保存する', async () => {
      const res = await callGet(
        confirmRequest('?token_hash=hash&type=signup&redirect_to=%2Fauth%2Fverified', {
          'x-forwarded-host': 'example.com',
          'x-forwarded-proto': 'http',
        }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://example.com/auth/verified');
      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash', type: 'signup' });
      expect(mockPersistSessionAndCookies).toHaveBeenCalledWith(
        res,
        SESSION,
        USER,
        { cartToken: null, wishlistToken: null },
      );
    });

    test('API-AUTH-006 成功の応答は no-store と no-referrer で、監査に success を残す', async () => {
      const res = await callGet(confirmRequest('?token_hash=hash'));

      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'success', actor_email: 'user@example.com', resource_id: 'u1' }),
      );
    });

    test('API-AUTH-006 token_hash が無ければ token を印として使う', async () => {
      await callGet(confirmRequest('?token=legacy-token'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'legacy-token', type: 'signup' });
    });

    test.each(['signup', 'email', 'magiclink', 'recovery'])('API-AUTH-006 受ける type（%s）はそのまま Supabase へ渡す', async (type) => {
      await callGet(confirmRequest(`?token_hash=hash&type=${type}`));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash', type });
    });

    test('API-AUTH-006 受けない type は signup に直し、type の指定が無い時も signup', async () => {
      await callGet(confirmRequest('?token_hash=hash&type=invite'));
      await callGet(confirmRequest('?token_hash=hash'));

      expect(verifyOtp).toHaveBeenNthCalledWith(1, { token_hash: 'hash', type: 'signup' });
      expect(verifyOtp).toHaveBeenNthCalledWith(2, { token_hash: 'hash', type: 'signup' });
    });

    test('API-AUTH-006 ゲストのカートとお気に入りの Cookie の印を、保存へ引き継ぐ', async () => {
      const cart = 'c'.repeat(43);
      const wishlist = 'w'.repeat(43);

      await callGet(confirmRequest('?token_hash=hash', { cookie: `cart=${cart}; wishlist=${wishlist}; other=1` }));

      expect(mockPersistSessionAndCookies.mock.calls[0][3]).toEqual({ cartToken: cart, wishlistToken: wishlist });
    });

    test('API-AUTH-006 形の壊れたゲストの印は無いものとして渡す', async () => {
      await callGet(confirmRequest('?token_hash=hash', { cookie: 'cart=too-short; wishlist=' }));

      expect(mockPersistSessionAndCookies.mock.calls[0][3]).toEqual({ cartToken: null, wishlistToken: null });
    });

    test('API-AUTH-006 メール確認に成功したらゲスト注文の紐付けを呼ぶ', async () => {
      await callGet(confirmRequest('?token_hash=t&type=email'));

      expect(mockLinkGuestOrdersByEmail).toHaveBeenCalledWith({
        userId: 'u1',
        email: 'user@example.com',
        emailConfirmedAt: '2026-08-10T00:00:00Z',
      });
    });

    test('API-AUTH-006 会員にメールも確認日時も無い時は、空のメールと null で紐付けを呼ぶ', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'u2' } }, error: null });

      await callGet(confirmRequest('?token_hash=t'));

      expect(mockLinkGuestOrdersByEmail).toHaveBeenCalledWith({ userId: 'u2', email: '', emailConfirmedAt: null });
    });
  });

  describe('送り先', () => {
    test.each([
      ['外部の住所', '?token_hash=t&redirect_to=https%3A%2F%2Fevil.example.net%2F'],
      ['プロトコル相対', '?token_hash=t&redirect_to=%2F%2Fevil.example.net'],
      ['バックスラッシュ入り', '?token_hash=t&redirect_to=%2F%5Cevil.example.net'],
    ])('API-AUTH-006 内部の道でない redirect_to（%s）は既定の /account に直す', async (_label, query) => {
      const res = await callGet(confirmRequest(query));
      verifyOtp.mockResolvedValue({ data: null, error: { message: 'Token has expired' } });
      const failing = await callGet(confirmRequest(query));

      // 成功の時も失敗の時も同じ絞り込みを通る
      for (const response of [res, failing]) {
        expect(new URL(response.headers.get('Location')).pathname).toBe('/account');
        expect(response.headers.get('Location')).not.toContain('evil.example.net');
      }
    });

    test('API-AUTH-006 許可リストに無い x-forwarded-host は採用しない', async () => {
      const res = await callGet(
        confirmRequest('', { 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'http' }),
      );

      // 攻撃者が指定したホストへは飛ばさず、既定のオリジンへ戻す。
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).not.toContain('evil.example.net');
    });

    test('API-AUTH-006 信頼できる proxy 配下でなければ x-forwarded-host を見ない', async () => {
      env.TRUST_PROXY_HEADERS = 'false';

      const res = await callGet(
        confirmRequest('', { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'http' }),
      );

      // 許可リストに載っている origin でも、proxy を信頼しない設定では採用しない。
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/account');
    });
  });

  describe('失敗', () => {
    test.each([
      ['Email link is invalid or has expired', 'expired'],
      ['Token is invalid', 'invalid'],
      ['Token already used', 'reused'],
      ['Token was reused', 'reused'],
      ['something else', 'unknown'],
    ])('API-AUTH-006 確かめの失敗（%s）も成功と同じ 303 で、理由（%s）は監査だけに残して保存しない', async (message, reason) => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message } });

      const res = await callGet(confirmRequest('?token_hash=bad&redirect_to=%2Fauth%2Fverified'));

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('Location')).pathname).toBe('/auth/verified');
      expect(res.headers.get('Location')).not.toContain(reason);
      expect(res.headers.get('Location')).not.toContain('bad');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
      expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'failure', detail: message, metadata: { reason } }),
      );
    });

    test('API-AUTH-006 エラーが無くても session か会員が欠けていれば失敗として扱う', async () => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: USER }, error: null });

      const res = await callGet(confirmRequest('?token_hash=t'));

      expect(res.status).toBe(303);
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'missing_session_or_user', metadata: { reason: 'unknown' } }),
      );
    });

    test('API-AUTH-006 保存に失敗しても 303 を返し、紐付けは呼ばず理由を監査に残す', async () => {
      mockPersistSessionAndCookies.mockResolvedValue({ ok: false, error: 'db insert failed' });

      const res = await callGet(confirmRequest('?token_hash=t'));

      expect(res.status).toBe(303);
      expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
      expect(auditCalls('success')).toHaveLength(0);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: db insert failed', resource_id: 'u1' }),
      );
    });

    test('API-AUTH-006 保存が結果を返さなくても unknown として監査に残す', async () => {
      mockPersistSessionAndCookies.mockResolvedValue(undefined);

      const res = await callGet(confirmRequest('?token_hash=t'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: unknown' }),
      );
    });

    test('API-AUTH-006 想定外の例外も 303 で受け、内部の理由は監査だけに残す', async () => {
      verifyOtp.mockRejectedValue(new Error('network down'));

      const res = await callGet(confirmRequest('?token_hash=t&redirect_to=%2Faccount%2Forders'));

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('Location')).pathname).toBe('/account/orders');
      expect(res.headers.get('Location')).not.toContain('network');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'error', detail: 'Error: network down', metadata: { reason: 'unexpected' } }),
      );
    });
  });
});
