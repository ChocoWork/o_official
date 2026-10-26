export {};

// 確認のメールのリンクの窓口（API-AUTH-006）。印の確かめ・登録の控えの結び付けと送り先・失敗の握りつぶし方を確かめる。
// 結び付け（return-intent-service・store）は本物を通し、控えの表を触る rpc だけを差し替える。
// rpc の写しは、番号とメールを一緒にハッシュした印が用途の合う未使用の行に当たる時だけ道筋を返す（ADR-0413）。
const { createHash } = require('crypto');


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
  __esModule: true,
  default: (...args: unknown[]) => mockLogAudit(...args),
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
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
const INTENT_TOKEN = 'B'.repeat(43);
const INTENT_COOKIE = `sb-return-intent=${INTENT_TOKEN}`;

describe('API-AUTH-006 GET /api/auth/confirm', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_ALLOWED = env.APP_ALLOWED_ORIGINS;
  const ORIGINAL_TRUST = env.TRUST_PROXY_HEADERS;
  const verifyOtp = jest.fn();
  const signOut = jest.fn();
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

  /**
   * DB の関数の写し。番号とメール（既定は確認した利用者のメール）を一緒にハッシュした印が、用途の合う未使用の行に当たる時だけ
   * 道筋を返し、1 回で使い切る。bindEmail は「その行を作った時の登録のメール」。
   */
  function fakeConsume(returnPath: string | null, opts: { storedPurpose?: string; bindEmail?: string } = {}) {
    const storedPurpose = opts.storedPurpose ?? 'signup';
    const rowHash = createHash('sha256').update(`${INTENT_TOKEN}\n${opts.bindEmail ?? USER.email}`).digest('hex');
    let used = false;
    mockRpc.mockImplementation(async (name: string, args: { _purpose?: string; _token_hash?: string }) => {
      if (name !== 'consume_auth_return_intent' || used || args._purpose !== storedPurpose || args._token_hash !== rowHash) {
        return { data: null, error: null };
      }
      used = true;
      return { data: returnPath, error: null };
    });
  }

  /** 登録を始めたブラウザからの確認のリンク（控えの Cookie を付ける）。 */
  function boundRequest(query: string, headers: Record<string, string> = {}) {
    const { cookie, ...rest } = headers;
    return confirmRequest(query, { ...rest, cookie: cookie ? `${cookie}; ${INTENT_COOKIE}` : INTENT_COOKIE });
  }

  function intentCookieCalls(res: any) {
    return (res.cookies.set as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg && typeof arg === 'object' && arg.name === 'sb-return-intent');
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
    mockRpc.mockResolvedValue({ data: null, error: null });
    verifyOtp.mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    const { createPublicClient } = require('@/lib/supabase/server');
    signOut.mockResolvedValue({ error: null });
    createPublicClient.mockResolvedValue({ auth: { verifyOtp, signOut } });
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

    test('API-AUTH-006 印が無ければ確かめず、固定の /login へ 303 で移して監査に残す', async () => {
      const res = await callGet(
        confirmRequest('', { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'http' }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://example.com/login');
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'failure', detail: 'missing_token_hash' }),
      );
    });
  });

  describe('印の確かめと保存（登録を始めたブラウザ）', () => {
    test('API-AUTH-006 印が正しく控えが結び付けば、先に控えを使い切ってからセッションを保存し、戻り先 / へ 303 で移す（redirect_to は読まない）', async () => {
      fakeConsume('/');

      const res = await callGet(
        boundRequest('?token_hash=hash&type=signup&redirect_to=%2Flook', {
          'x-forwarded-host': 'example.com',
          'x-forwarded-proto': 'http',
        }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://example.com/');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash', type: 'signup' });
      expect(mockPersistSessionAndCookies).toHaveBeenCalledWith(
        res,
        SESSION,
        USER,
        { cartToken: null, wishlistToken: null },
      );
    });

    test('API-AUTH-006 控えは番号とメールを一緒にハッシュした印で signup の用途で使い切り、保存の前に行い、戻り先へ移して控えの Cookie を消す', async () => {
      fakeConsume('/item/3?color=red');

      const res = await callGet(
        boundRequest('?token_hash=hash&type=signup', {
          'x-forwarded-host': 'example.com',
          'x-forwarded-proto': 'http',
        }),
      );

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://example.com/item/3?color=red');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('consume_auth_return_intent', {
        _token_hash: createHash('sha256').update(`${INTENT_TOKEN}\nuser@example.com`).digest('hex'),
        _purpose: 'signup',
        _user_id: 'u1',
      });
      expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(INTENT_TOKEN);
      expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockPersistSessionAndCookies.mock.invocationCallOrder[0]);
      expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0, path: '/' })]);
      expect(signOut).not.toHaveBeenCalled();
    });

    test('API-AUTH-006 メールの大文字小文字が違っても（登録は小文字、確認した利用者は大文字混じり）結び付く', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { ...USER, email: 'User@Example.com' } }, error: null });
      fakeConsume('/item/3');

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expect(res.headers.get('Location')).toBe('http://localhost:3000/item/3');
      expect(mockPersistSessionAndCookies).toHaveBeenCalledTimes(1);
    });

    test('API-AUTH-006 控えの用途が login（登録の用途と違う）なら結び付かず、session を作らず /login?registered=1 へ移す', async () => {
      fakeConsume('/item/3', { storedPurpose: 'login' });

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
    });

    test.each(['email', 'magiclink', 'recovery', 'unknown', 'invite', 'SIGNUP'])(
      'API-AUTH-006 印の型が %s なら verifyOtp を呼ばず（印を消費せず）、セッションも控えも触らず /login へ 303 で移して invalid_type を監査に残す',
      async (type) => {
        fakeConsume('/item/3');

        const res = await callGet(boundRequest(`?token_hash=hash&type=${type}`));

        expect(res.status).toBe(303);
        expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
        expect(verifyOtp).not.toHaveBeenCalled();
        expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
        expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
        expect(mockRpc).not.toHaveBeenCalled();
        expect(signOut).not.toHaveBeenCalled();
        expect(intentCookieCalls(res)).toEqual([]);
        expect(res.cookies.set).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith({
          action: 'auth.confirm',
          outcome: 'failure',
          detail: 'invalid_type',
          metadata: { reason: 'invalid_type' },
        });
      },
    );

    test('API-AUTH-006 控えが /admin を指していても一般の会員は / へ移す（出口で役割を確かめ直す）', async () => {
      fakeConsume('/admin');

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expect(res.headers.get('Location')).toBe('http://localhost:3000/');
    });

    test.each(['admin', 'supporter'])('API-AUTH-006 役割が %s なら使い切った戻り先を捨てて /auth/verified へ移す（session は作る）', async (role) => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { ...USER, app_metadata: { role } } }, error: null });
      fakeConsume('/admin');

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expect(res.headers.get('Location')).toBe('http://localhost:3000/auth/verified');
      expect(mockPersistSessionAndCookies).toHaveBeenCalledTimes(1);
      expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
    });

    test('API-AUTH-006 保存に失敗しても控えは既に使い切り済み。応答は既定の / のままで、控えの Cookie は消し、session は失効させる', async () => {
      mockPersistSessionAndCookies.mockResolvedValue({ ok: false, error: 'db insert failed' });
      fakeConsume('/item/3');

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expect(res.headers.get('Location')).toBe('http://localhost:3000/');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
      expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    test('API-AUTH-006 成功の応答は no-store と no-referrer で、監査に success を残す', async () => {
      fakeConsume('/');

      const res = await callGet(boundRequest('?token_hash=hash'));

      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'success', actor_email: 'user@example.com', resource_id: 'u1' }),
      );
    });

    test('API-AUTH-006 token_hash が無ければ token を印として使う', async () => {
      await callGet(confirmRequest('?token=legacy-token&type=signup'));

      expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'legacy-token', type: 'signup' });
    });

    test('API-AUTH-006 type=signup はそのまま、type の指定が無い時・空の時も signup として Supabase へ渡す', async () => {
      await callGet(confirmRequest('?token_hash=hash&type=signup'));
      await callGet(confirmRequest('?token_hash=hash'));
      await callGet(confirmRequest('?token_hash=hash&type='));

      expect(verifyOtp).toHaveBeenCalledTimes(3);
      for (const n of [1, 2, 3]) expect(verifyOtp).toHaveBeenNthCalledWith(n, { token_hash: 'hash', type: 'signup' });
    });

    test('API-AUTH-006 ゲストのカートとお気に入りの Cookie の印を、保存へ引き継ぐ', async () => {
      fakeConsume('/');
      const cart = 'c'.repeat(43);
      const wishlist = 'w'.repeat(43);

      await callGet(boundRequest('?token_hash=hash', { cookie: `cart=${cart}; wishlist=${wishlist}; other=1` }));

      expect(mockPersistSessionAndCookies.mock.calls[0][3]).toEqual({ cartToken: cart, wishlistToken: wishlist });
    });

    test('API-AUTH-006 形の壊れたゲストの印は無いものとして渡す', async () => {
      fakeConsume('/');

      await callGet(boundRequest('?token_hash=hash', { cookie: 'cart=too-short; wishlist=' }));

      expect(mockPersistSessionAndCookies.mock.calls[0][3]).toEqual({ cartToken: null, wishlistToken: null });
    });

    test('API-AUTH-006 メール確認に成功し結び付けば、ゲスト注文の紐付けを呼ぶ', async () => {
      fakeConsume('/');

      await callGet(boundRequest('?token_hash=t&type=signup'));

      expect(mockLinkGuestOrdersByEmail).toHaveBeenCalledWith({
        userId: 'u1',
        email: 'user@example.com',
        emailConfirmedAt: '2026-08-10T00:00:00Z',
      });
    });

    test('API-AUTH-006 確認日時が無い時は、null で紐付けを呼ぶ', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'u2', email: 'user@example.com' } }, error: null });
      fakeConsume('/');

      await callGet(boundRequest('?token_hash=t'));

      expect(mockLinkGuestOrdersByEmail).toHaveBeenCalledWith({ userId: 'u2', email: 'user@example.com', emailConfirmedAt: null });
    });
  });

  describe('結び付かない（登録を始めたブラウザではない。SEC-AUTH-007）', () => {
    function expectNoSession(res: any) {
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
      expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
      // session の Cookie も控えの Cookie も、書かない・消さない。
      expect(res.cookies.set).not.toHaveBeenCalled();
    }

    test('API-AUTH-006 別のブラウザ（控えの Cookie が無い）で開いたら、メールの確認だけ済ませ、session を作らず /login?registered=1 へ移し、GoTrue 側の session を local で失効させる', async () => {
      fakeConsume('/item/3');

      const res = await callGet(confirmRequest('?token_hash=hash&type=signup'));

      expectNoSession(res);
      expect(verifyOtp).toHaveBeenCalledTimes(1);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'auth.confirm',
        actor_email: 'user@example.com',
        outcome: 'success',
        detail: 'confirmed_without_session',
        resource_id: 'u1',
        metadata: { reason: 'no_binding' },
      });
    });

    test('API-AUTH-006 控えの番号は合うが別のメールの印（被害者の有効な Cookie と攻撃者の確認リンク）なら、session を作らず Cookie も消さない', async () => {
      // 被害者のブラウザの控えは「被害者のメール」に結ばれた行。攻撃者のメールの確認リンクを開くと、ハッシュが外れる。
      fakeConsume('/item/3', { bindEmail: 'victim@example.com' });

      const res = await callGet(boundRequest('?token_hash=attacker-hash&type=signup'));

      expectNoSession(res);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(intentCookieCalls(res)).toEqual([]);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    test('API-AUTH-006 控えの Cookie の番号が行に無い（使用済み・期限切れ・存在しない）時も同じ', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null });

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expectNoSession(res);
      expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    test('API-AUTH-006 控えの番号が 2 つ（名前の重複）なら DB を呼ばず結び付かない', async () => {
      const res = await callGet(confirmRequest('?token_hash=hash', { cookie: `${INTENT_COOKIE}; ${INTENT_COOKIE}` }));

      expectNoSession(res);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    test('API-AUTH-006 同じリンクをもう一度開くと控えは使えず結び付かない', async () => {
      fakeConsume('/item/3');

      const first = await callGet(boundRequest('?token_hash=hash&type=signup'));
      const second = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expect(first.headers.get('Location')).toBe('http://localhost:3000/item/3');
      expect(second.headers.get('Location')).toBe('http://localhost:3000/login?registered=1');
      expect(mockPersistSessionAndCookies).toHaveBeenCalledTimes(1);
    });

    test('API-AUTH-006 利用者のメールが無ければ結び付かない（DB を呼ばない）', async () => {
      verifyOtp.mockResolvedValue({ data: { session: SESSION, user: { id: 'u2' } }, error: null });

      const res = await callGet(boundRequest('?token_hash=hash&type=signup'));

      expectNoSession(res);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    test('API-AUTH-006 signOut が { error } を返しても（本来の失敗の形）応答は変わらず、ログには符号だけを残す', async () => {
      signOut.mockResolvedValue({ error: { code: 'unexpected_failure', status: 500, message: 'secret failure text' } });

      const res = await callGet(confirmRequest('?token_hash=hash&type=signup'));

      expectNoSession(res);
      expect(errorSpy).toHaveBeenCalledWith('confirm signOut(local) failed', { code: 'unexpected_failure' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret failure text');
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('secret failure text');
    });

    test('API-AUTH-006 signOut が投げられても応答は変わらず、ログには符号だけを残す', async () => {
      signOut.mockRejectedValue(Object.assign(new Error('secret failure text'), { code: 'signout_failed' }));

      const res = await callGet(confirmRequest('?token_hash=hash&type=signup'));

      expectNoSession(res);
      expect(errorSpy).toHaveBeenCalledWith('confirm signOut(local) failed', { code: 'signout_failed' });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret failure text');
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('secret failure text');
    });
  });

  describe('送り先', () => {
    test.each([
      ['外部の住所', '?token_hash=t&redirect_to=https%3A%2F%2Fevil.example.net%2F'],
      ['プロトコル相対', '?token_hash=t&redirect_to=%2F%2Fevil.example.net'],
      ['バックスラッシュ入り', '?token_hash=t&redirect_to=%2F%5Cevil.example.net'],
      ['タブ入り', '?token_hash=t&redirect_to=%2F%09%2Fevil.example.net'],
      ['解釈で外へ向く', '?token_hash=t&redirect_to=%2F.%2F%2Fevil.example.net'],
      ['途中の画面 /auth/verified', '?token_hash=t&redirect_to=%2Fauth%2Fverified'],
      ['内部の道 /look', '?token_hash=t&redirect_to=%2Flook'],
    ])('API-AUTH-006 redirect_to（%s）は読まない。成功は / へ、失敗は固定の /login へ移す', async (_label, query) => {
      fakeConsume('/');
      const res = await callGet(boundRequest(query));
      verifyOtp.mockResolvedValue({ data: null, error: { message: 'Token has expired' } });
      const failing = await callGet(confirmRequest(query));

      expect(new URL(res.headers.get('Location')).pathname).toBe('/');
      expect(new URL(failing.headers.get('Location')).pathname).toBe('/login');
      for (const response of [res, failing]) {
        expect(response.headers.get('Location')).not.toContain('evil.example.net');
        expect(new URL(response.headers.get('Location')).search).toBe('');
      }
    });

    test('API-AUTH-006 トークンが無い失敗の枝でも、タブ入りの redirect_to で外へ 303 しない（固定の /login）', async () => {
      const res = await callGet(confirmRequest('?redirect_to=%2F%09%2Fevil.example.net'));

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('Location')).origin).toBe('http://localhost:3000');
      expect(new URL(res.headers.get('Location')).pathname).toBe('/login');
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
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
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
    });
  });

  describe('失敗', () => {
    test.each([
      ['Email link is invalid or has expired', 'expired'],
      ['Token is invalid', 'invalid'],
      ['Token already used', 'reused'],
      ['Token was reused', 'reused'],
      ['something else', 'unknown'],
    ])('API-AUTH-006 確かめの失敗（%s）も成功と同じ 303 で固定の /login へ移し、理由（%s）は監査だけに残して保存しない', async (message, reason) => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message } });
      fakeConsume('/item/3');

      const res = await callGet(boundRequest('?token_hash=bad&redirect_to=%2Flook'));

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('Location')).pathname).toBe('/login');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(intentCookieCalls(res)).toEqual([]);
      expect(res.headers.get('Location')).not.toContain(reason);
      expect(res.headers.get('Location')).not.toContain('bad');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
      expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(message);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'failure', detail: 'verify_failed', metadata: { reason } }),
      );
    });

    test('API-AUTH-006 エラーが無くても session か会員が欠けていれば失敗として扱う', async () => {
      verifyOtp.mockResolvedValue({ data: { session: null, user: USER }, error: null });

      const res = await callGet(confirmRequest('?token_hash=t'));

      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('http://localhost:3000/login');
      expect(mockPersistSessionAndCookies).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'missing_session_or_user', metadata: { reason: 'unknown' } }),
      );
    });

    test('API-AUTH-006 保存に失敗しても 303 を返し、紐付けは呼ばず固定の符号だけを監査に残す（保存の誤りの文は残さない）', async () => {
      mockPersistSessionAndCookies.mockResolvedValue({ ok: false, error: 'db insert failed' });
      fakeConsume('/');

      const res = await callGet(boundRequest('?token_hash=t'));

      expect(res.status).toBe(303);
      expect(mockLinkGuestOrdersByEmail).not.toHaveBeenCalled();
      expect(auditCalls('success')).toHaveLength(0);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed', resource_id: 'u1' }),
      );
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('db insert failed');
    });

    test('API-AUTH-006 保存が結果を返さなくても同じ固定の符号を監査に残す', async () => {
      mockPersistSessionAndCookies.mockResolvedValue(undefined);
      fakeConsume('/');

      const res = await callGet(boundRequest('?token_hash=t'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed' }),
      );
    });

    test('API-AUTH-006 想定外の例外も 303 で固定の /login へ移し、内部の理由は監査だけに残す', async () => {
      verifyOtp.mockRejectedValue(new Error('network down'));

      const res = await callGet(confirmRequest('?token_hash=t&redirect_to=%2Faccount%2Forders'));

      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('Location')).pathname).toBe('/login');
      expect(res.headers.get('Location')).not.toContain('network');
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('network down');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'error', detail: 'unexpected', metadata: { reason: 'unexpected' } }),
      );
    });
  });
});
