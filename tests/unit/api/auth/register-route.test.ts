/**
 * DD-AUTH-018 会員登録の窓口（src/app/api/auth/register/route.ts）の単体テスト。
 * 回数の制限・Turnstile・漏洩の照合・Supabase・メール・監査は差し替え、窓口の分岐だけを確かめる。
 * 本文の形（RegisterRequestSchema）と送り先の絞り込み（sanitizeRedirectPath）は本物を通す。
 */

const mockAfterCallbacks: Array<() => unknown> = [];

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: { set: jest.fn() },
    }),
  },
  // after() は要求の外では投げるので、呼び出しを溜めるだけのスタブにする。
  after: (cb: () => unknown) => {
    mockAfterCallbacks.push(cb);
  },
}));

jest.mock('@/lib/mail', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: jest.fn(),
  PWNED_PASSWORD_MESSAGE: 'pwned-message',
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
  createClient: jest.fn(),
}));
jest.mock('@/lib/redirect', () => ({
  ...jest.requireActual('@/lib/redirect'),
  getRequestOrigin: () => 'http://localhost:3000',
}));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/site-url-guard', () => ({ isEmailOriginAllowed: jest.fn() }));
jest.mock('@/lib/ops/site-url-alert', () => ({ notifySiteUrlInvalid: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
jest.mock('@/lib/turnstile', () => ({ verifyTurnstile: jest.fn() }));
jest.mock('@/features/auth/services/auth-admin-user', () => ({ findAuthUserIdByEmail: jest.fn() }));
jest.mock('@/features/auth/services/register', () => ({ persistSessionAndCookies: jest.fn() }));
jest.mock('@/features/cart/services/guest-shopping-token', () => ({ readGuestShoppingTokens: jest.fn() }));
jest.mock('@/lib/cookie', () => ({
  accessCookieName: 'access-cookie',
  refreshCookieName: 'refresh-cookie',
  csrfCookieName: 'csrf-cookie',
  cookieOptionsForAccess: jest.fn((age: number) => ({ maxAge: age, kind: 'access' })),
  cookieOptionsForRefresh: jest.fn((age: number) => ({ maxAge: age, kind: 'refresh' })),
  cookieOptionsForCsrf: jest.fn((age: number) => ({ maxAge: age, kind: 'csrf' })),
}));

import sendMail from '@/lib/mail';
import { checkPwnedPassword } from '@/lib/pwned-password';
import { createServiceRoleClient, createClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { isEmailOriginAllowed } from '@/lib/site-url-guard';
import { notifySiteUrlInvalid } from '@/lib/ops/site-url-alert';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { verifyTurnstile } from '@/lib/turnstile';
import { findAuthUserIdByEmail } from '@/features/auth/services/auth-admin-user';
import { persistSessionAndCookies } from '@/features/auth/services/register';
import { readGuestShoppingTokens } from '@/features/cart/services/guest-shopping-token';
import { cookieOptionsForAccess, cookieOptionsForRefresh, cookieOptionsForCsrf } from '@/lib/cookie';
import { POST } from '@/app/api/auth/register/route';

const mockSendMail = sendMail as jest.Mock;
const mockPwned = checkPwnedPassword as jest.Mock;
const mockCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockCreateClient = createClient as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;
const mockOriginAllowed = isEmailOriginAllowed as jest.Mock;
const mockNotifySiteUrlInvalid = notifySiteUrlInvalid as jest.Mock;
const mockRateLimit = enforceRateLimit as jest.Mock;
const mockTurnstile = verifyTurnstile as jest.Mock;
const mockFindUser = findAuthUserIdByEmail as jest.Mock;
const mockPersist = persistSessionAndCookies as jest.Mock;
const mockReadTokens = readGuestShoppingTokens as jest.Mock;
const mockAccessOptions = cookieOptionsForAccess as jest.Mock;

const PASSWORD = 'Passw0rd!23456789';
const ADMIN_KEY = 'admin-secret';
const TOKENS = { cartToken: 'cart-t', wishlistToken: 'wish-t' };
const SESSION = { access_token: 'access-1', refresh_token: 'refresh-1' };
const NEW_USER = { id: 'user-1', email: 'new@example.com' };

let signUp: jest.Mock;
let createUser: jest.Mock;
const originalAdminKey = process.env.ADMIN_API_KEY;

function registerRequest(
  body: Record<string, unknown> | string = { email: 'new@example.com', password: PASSWORD, turnstileToken: 't' },
  headers: Record<string, string> = {},
) {
  return new Request('http://localhost:3000/api/auth/register', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function runAfterCallbacks() {
  for (const cb of mockAfterCallbacks) await cb();
}

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAfterCallbacks.length = 0;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    signUp = jest.fn().mockResolvedValue({ data: { session: null, user: NEW_USER }, error: null });
    createUser = jest.fn().mockResolvedValue({ data: { user: { id: 'admin-1', email: 'new@example.com' } }, error: null });
    mockCreateClient.mockResolvedValue({ auth: { signUp } });
    mockCreateServiceRoleClient.mockResolvedValue({ auth: { admin: { createUser } } });
    mockRateLimit.mockResolvedValue(undefined);
    mockTurnstile.mockResolvedValue({ ok: true });
    mockOriginAllowed.mockReturnValue(true);
    mockPwned.mockResolvedValue({ status: 'ok' });
    mockFindUser.mockResolvedValue({ status: 'not_found' });
    mockPersist.mockResolvedValue({ ok: true });
    mockReadTokens.mockReturnValue(TOKENS);
    mockLogAudit.mockResolvedValue(undefined);
    mockSendMail.mockResolvedValue(undefined);
    mockAccessOptions.mockImplementation((age: number) => ({ maxAge: age, kind: 'access' }));
    (cookieOptionsForRefresh as jest.Mock).mockImplementation((age: number) => ({ maxAge: age, kind: 'refresh' }));
    (cookieOptionsForCsrf as jest.Mock).mockImplementation((age: number) => ({ maxAge: age, kind: 'csrf' }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = originalAdminKey;
  });

  describe('IP の制限', () => {
    it('DD-AUTH-018 制限が応答を返したらそのまま返し、本文を読まない', async () => {
      const limited = { status: 429 };
      mockRateLimit.mockResolvedValue(limited);

      const res = await POST(registerRequest());

      expect(res).toBe(limited);
      expect(mockRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:register', limit: 20, windowSeconds: 3600 }),
      );
      expect(mockTurnstile).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 制限の呼び出しが投げたら記録して先へ進む', async () => {
      mockRateLimit.mockRejectedValue(new Error('rate down'));

      const res: any = await POST(registerRequest());

      expect(console.error).toHaveBeenCalledWith('Rate limit middleware error (register):', expect.any(Error));
      expect(res.status).toBe(202);
    });
  });

  describe('管理の経路の鍵', () => {
    it('DD-AUTH-018 管理の見出しがあり鍵の設定が無ければ 500 Server misconfiguration', async () => {
      delete process.env.ADMIN_API_KEY;

      const res: any = await POST(registerRequest(undefined, { 'x-admin-token': 'anything' }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server misconfiguration' });
      expect(createUser).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 x-admin-token が鍵と違えば unauthorized を残して 401', async () => {
      const res: any = await POST(registerRequest(undefined, { 'x-admin-token': 'wrong' }));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: null,
        outcome: 'unauthorized',
        detail: 'Missing or invalid admin token',
      });
      expect(createUser).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 Bearer の値が鍵と違っても 401', async () => {
      const res: any = await POST(registerRequest(undefined, { authorization: 'Bearer wrong' }));

      expect(res.status).toBe(401);
    });

    it('DD-AUTH-018 x-admin-token が鍵と合えば service role の createUser で作って 201 { id, email }', async () => {
      const res: any = await POST(
        registerRequest(
          { email: 'New@Example.com', password: PASSWORD, display_name: 'Hanako' },
          { 'x-admin-token': ADMIN_KEY },
        ),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: 'admin-1', email: 'new@example.com' });
      expect(createUser).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: PASSWORD,
        user_metadata: { display_name: 'Hanako' },
      });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'success',
        resource_id: 'admin-1',
      });
      // 管理の経路は Turnstile・漏洩・列挙の対策を通らない
      expect(mockTurnstile).not.toHaveBeenCalled();
      expect(mockPwned).not.toHaveBeenCalled();
      expect(mockFindUser).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 Bearer の値が鍵と合っても同じく管理の経路で作る', async () => {
      const res: any = await POST(registerRequest(undefined, { authorization: `Bearer ${ADMIN_KEY}` }));

      expect(res.status).toBe(201);
      expect(createUser).toHaveBeenCalledTimes(1);
    });

    it('DD-AUTH-018 管理の作成で user が返らなければ id と email は未定義の 201', async () => {
      createUser.mockResolvedValue({ data: { user: null }, error: null });

      const res: any = await POST(registerRequest(undefined, { 'x-admin-token': ADMIN_KEY }));

      expect(res.status).toBe(201);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', resource_id: undefined }),
      );
    });

    it.each(['User already registered', 'Duplicate key value'])(
      'DD-AUTH-018 管理の作成の誤りの文 "%s" は conflict を残して 409',
      async (message) => {
        createUser.mockResolvedValue({ data: null, error: { message } });

        const res: any = await POST(registerRequest(undefined, { 'x-admin-token': ADMIN_KEY }));

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'Email already registered' });
        expect(mockLogAudit).toHaveBeenCalledWith({
          action: 'register',
          actor_email: 'new@example.com',
          outcome: 'conflict',
          detail: message,
        });
      },
    );

    it('DD-AUTH-018 管理の作成がほかの誤りなら error を残して 500', async () => {
      createUser.mockResolvedValue({ data: null, error: { message: 'db exploded' } });

      const res: any = await POST(registerRequest(undefined, { 'x-admin-token': ADMIN_KEY }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to create user' });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'db exploded' }),
      );
    });

    it('DD-AUTH-018 管理の作成の誤りに文が無ければ error として 500', async () => {
      createUser.mockResolvedValue({ data: null, error: {} });

      const res: any = await POST(registerRequest(undefined, { 'x-admin-token': ADMIN_KEY }));

      expect(res.status).toBe(500);
    });
  });

  describe('本文の形と送り先', () => {
    it('DD-AUTH-018 形が合わなければ 400 で検証の誤りを返す', async () => {
      const res: any = await POST(registerRequest({ email: 'not-an-email', password: 'short' }));

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('validation_error');
      expect(body.detail.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password']));
      expect(mockTurnstile).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 本文が JSON でなければ 500', async () => {
      const res: any = await POST(registerRequest('not json'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(console.error).toHaveBeenCalledWith('Register handler error:', expect.anything());
    });

    it('DD-AUTH-018 redirect_to を確認のリンクの送り先にする', async () => {
      await POST(registerRequest({ email: 'new@example.com', password: PASSWORD, redirect_to: '/look' }));

      const url = new URL(signUp.mock.calls[0][0].options.emailRedirectTo);
      expect(url.origin).toBe('http://localhost:3000');
      expect(url.pathname).toBe('/api/auth/confirm');
      expect(url.searchParams.get('redirect_to')).toBe('/look');
    });

    it('DD-AUTH-018 redirect_to が無ければ emailRedirectTo を使う', async () => {
      await POST(registerRequest({ email: 'new@example.com', password: PASSWORD, emailRedirectTo: '/news' }));

      const url = new URL(signUp.mock.calls[0][0].options.emailRedirectTo);
      expect(url.searchParams.get('redirect_to')).toBe('/news');
    });

    it('DD-AUTH-018 どちらも無ければ既定の /auth/verified にする', async () => {
      await POST(registerRequest());

      const url = new URL(signUp.mock.calls[0][0].options.emailRedirectTo);
      expect(url.searchParams.get('redirect_to')).toBe('/auth/verified');
    });

    it('DD-AUTH-018 外部への送り先（//evil.example）は既定の /auth/verified に直す', async () => {
      await POST(registerRequest({ email: 'new@example.com', password: PASSWORD, redirect_to: '//evil.example' }));

      const url = new URL(signUp.mock.calls[0][0].options.emailRedirectTo);
      expect(url.searchParams.get('redirect_to')).toBe('/auth/verified');
    });
  });

  describe('Turnstile', () => {
    it('DD-AUTH-018 通らなければ failure（誤りの文）を残して 403。登録には進まない', async () => {
      mockTurnstile.mockResolvedValue({ ok: false, error: 'invalid-input-response' });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Bot detection failed' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'failure',
        detail: 'invalid-input-response',
      });
      expect(mockFindUser).not.toHaveBeenCalled();
      expect(signUp).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 通らず誤りの文も無ければ turnstile_failed と書く', async () => {
      mockTurnstile.mockResolvedValue({ ok: false });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(403);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'turnstile_failed' }));
    });

    it('DD-AUTH-018 x-forwarded-for の先頭を前後の空白を除いて Turnstile へ渡す', async () => {
      await POST(
        registerRequest(
          { email: 'new@example.com', password: PASSWORD, turnstileToken: 'tok' },
          { 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' },
        ),
      );

      expect(mockTurnstile).toHaveBeenCalledWith('tok', '203.0.113.7');
    });

    it('DD-AUTH-018 x-forwarded-for が無ければ Turnstile へ null を渡す', async () => {
      await POST(registerRequest());

      expect(mockTurnstile).toHaveBeenCalledWith('t', null);
    });

    it('DD-AUTH-018 Turnstile は重複の確認と登録より前に呼ぶ', async () => {
      const order: string[] = [];
      mockTurnstile.mockImplementation(async () => {
        order.push('turnstile');
        return { ok: true };
      });
      mockFindUser.mockImplementation(async () => {
        order.push('lookup');
        return { status: 'not_found' };
      });
      signUp.mockImplementation(async () => {
        order.push('signUp');
        return { data: { session: null, user: NEW_USER }, error: null };
      });

      await POST(registerRequest());

      expect(order).toEqual(['turnstile', 'lookup', 'signUp']);
    });
  });

  describe('住所の見張り', () => {
    it('DD-AUTH-018 住所が許可の一覧に無ければ応答の外で運用へ知らせ、503 を返す', async () => {
      mockOriginAllowed.mockReturnValue(false);

      const res: any = await POST(registerRequest());

      expect(mockOriginAllowed).toHaveBeenCalledWith('http://localhost:3000');
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain('会員登録を受け付けられません');
      expect(mockNotifySiteUrlInvalid).not.toHaveBeenCalled();
      await runAfterCallbacks();
      expect(mockNotifySiteUrlInvalid).toHaveBeenCalledTimes(1);
      expect(mockPwned).not.toHaveBeenCalled();
      expect(signUp).not.toHaveBeenCalled();
    });
  });

  describe('漏洩したパスワード', () => {
    it('DD-AUTH-018 漏洩に当たれば failure（pwned_password）を残して 400。登録には進まない', async () => {
      mockPwned.mockResolvedValue({ status: 'pwned' });

      const res: any = await POST(registerRequest());

      expect(mockPwned).toHaveBeenCalledWith(PASSWORD);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'pwned-message' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'failure',
        detail: 'pwned_password',
      });
      expect(mockFindUser).not.toHaveBeenCalled();
      expect(signUp).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 照合先が使えなくても止めず、error（pwned_check_unavailable）を残して登録へ続ける', async () => {
      mockPwned.mockResolvedValue({ status: 'unavailable', reason: 'timeout' });

      const res: any = await POST(registerRequest());

      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'error',
        detail: 'pwned_check_unavailable:timeout',
      });
      expect(res.status).toBe(202);
      expect(signUp).toHaveBeenCalledTimes(1);
    });
  });

  describe('登録済みの確認', () => {
    it('DD-AUTH-018 照会が失敗したら error（user_lookup_failed）を残して 503。登録へ進まない', async () => {
      mockFindUser.mockResolvedValue({ status: 'error' });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'error',
        detail: 'user_lookup_failed',
      });
      expect(signUp).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 登録済みなら conflict を残し、新規と同じ 202 を返して signUp を呼ばない', async () => {
      mockFindUser.mockResolvedValue({ status: 'found', userId: 'existing-1' });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'conflict',
        detail: 'already_registered_notified',
      });
      expect(signUp).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 登録済みなら応答の外で本人に /login のリンクのメールを送り、パスワードは載せない', async () => {
      mockFindUser.mockResolvedValue({ status: 'found', userId: 'existing-1' });

      await POST(registerRequest());

      expect(mockSendMail).not.toHaveBeenCalled();
      expect(mockAfterCallbacks).toHaveLength(1);
      await runAfterCallbacks();
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const mail = mockSendMail.mock.calls[0][0];
      expect(mail.to).toBe('new@example.com');
      expect(mail.html).toContain('http://localhost:3000/login');
      expect(mail.text).toContain('http://localhost:3000/login');
      expect(JSON.stringify(mail)).not.toContain(PASSWORD);
    });

    it('DD-AUTH-018 通知の送信が失敗しても記録だけにして例外を出さない', async () => {
      mockFindUser.mockResolvedValue({ status: 'found', userId: 'existing-1' });
      mockSendMail.mockRejectedValue(new Error('smtp down'));

      await POST(registerRequest());

      await expect(runAfterCallbacks()).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith('Failed to send already-registered notice:', expect.any(Error));
    });

    it('DD-AUTH-018 service role の client で引いた結果をメールとともに渡す', async () => {
      const service = { auth: { admin: { createUser } } };
      mockCreateServiceRoleClient.mockResolvedValue(service);

      await POST(registerRequest());

      expect(mockFindUser).toHaveBeenCalledWith(service, 'new@example.com');
    });
  });

  describe('登録', () => {
    it('DD-AUTH-018 display_name があれば登録の data に付ける', async () => {
      await POST(registerRequest({ email: 'new@example.com', password: PASSWORD, display_name: 'Hanako' }));

      expect(signUp.mock.calls[0][0]).toMatchObject({
        email: 'new@example.com',
        password: PASSWORD,
        options: { data: { display_name: 'Hanako' } },
      });
    });

    it('DD-AUTH-018 display_name が無ければ登録の data を付けない', async () => {
      await POST(registerRequest());

      expect(signUp.mock.calls[0][0].options.data).toBeUndefined();
    });

    it('DD-AUTH-018 session が無ければ created_needs_confirmation を残して 202 { message }', async () => {
      const res: any = await POST(registerRequest());

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'created_needs_confirmation',
      });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it.each(['User already registered', 'duplicate key'])(
      'DD-AUTH-018 登録の誤りの文 "%s"（除外の宛先）は conflict を残し、通知と同じ 202 にする',
      async (message) => {
        signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message } });

        const res: any = await POST(registerRequest());

        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ message: 'Confirmation email sent' });
        expect(mockLogAudit).toHaveBeenCalledWith({
          action: 'register',
          actor_email: 'new@example.com',
          outcome: 'conflict',
          detail: message,
        });
        await runAfterCallbacks();
        expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
      },
    );

    it('DD-AUTH-018 登録がほかの誤りなら error を残して 500', async () => {
      signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'rate limited' } });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to create user' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'error',
        detail: 'rate limited',
      });
    });

    it('DD-AUTH-018 登録の誤りに文が無ければ error として 500', async () => {
      signUp.mockResolvedValue({ data: { session: null, user: null }, error: {} });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
    });
  });

  describe('session が返った時（Confirm email が OFF）', () => {
    beforeEach(() => {
      signUp.mockResolvedValue({ data: { session: SESSION, user: NEW_USER }, error: null });
    });

    it('DD-AUTH-018 session があり user が無ければ error（missing_user_after_signup）を残して 500', async () => {
      signUp.mockResolvedValue({ data: { session: SESSION, user: null }, error: null });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'error',
        detail: 'missing_user_after_signup',
      });
      expect(mockPersist).not.toHaveBeenCalled();
    });

    it('DD-AUTH-018 保存が成功したら success を残し、access token と user を 201 で返す', async () => {
      const res: any = await POST(
        registerRequest(undefined, { cookie: 'guest=1' }),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ access_token: 'access-1', user: NEW_USER });
      expect(mockReadTokens).toHaveBeenCalledWith('guest=1');
      expect(mockPersist).toHaveBeenCalledWith(res, SESSION, NEW_USER, TOKENS);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'success',
        resource_id: 'user-1',
      });
    });

    it('DD-AUTH-018 cookie ヘッダが無ければ null をゲストの印の読み取りへ渡す', async () => {
      await POST(registerRequest());

      expect(mockReadTokens).toHaveBeenCalledWith(null);
    });

    it('DD-AUTH-018 保存が失敗（ok が偽）なら access・refresh・CSRF の Cookie を消し、error を残して 500', async () => {
      let responseCookies: jest.Mock | undefined;
      mockPersist.mockImplementation(async (res: any) => {
        responseCookies = res.cookies.set;
        return { ok: false, error: 'db down' };
      });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(responseCookies).toBeDefined();
      expect(responseCookies).toHaveBeenCalledWith({ name: 'access-cookie', value: '', maxAge: 0, kind: 'access' });
      expect(responseCookies).toHaveBeenCalledWith({ name: 'refresh-cookie', value: '', maxAge: 0, kind: 'refresh' });
      expect(responseCookies).toHaveBeenCalledWith({ name: 'csrf-cookie', value: '', maxAge: 0, kind: 'csrf' });
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'error',
        detail: 'session_persist_failed: db down',
        resource_id: 'user-1',
      });
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });

    it('DD-AUTH-018 保存が失敗し、Cookie の消去が投げても記録だけで error と 500 を返す', async () => {
      mockPersist.mockResolvedValue({ ok: false, error: 'db down' });
      mockAccessOptions.mockImplementation(() => {
        throw new Error('cookie boom');
      });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(console.error).toHaveBeenCalledWith(
        'Failed to clear cookies after persistence failure:',
        expect.any(Error),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: db down' }),
      );
    });

    it('DD-AUTH-018 保存が投げたら Cookie を消し、error を残して 500', async () => {
      let responseCookies: jest.Mock | undefined;
      mockPersist.mockImplementation(async (res: any) => {
        responseCookies = res.cookies.set;
        throw new Error('persist boom');
      });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(responseCookies).toHaveBeenCalledTimes(3);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'register',
        actor_email: 'new@example.com',
        outcome: 'error',
        detail: 'Error: persist boom',
        resource_id: 'user-1',
      });
    });

    it('DD-AUTH-018 保存が投げ、Cookie の消去も投げても記録だけで error と 500 を返す', async () => {
      mockPersist.mockRejectedValue(new Error('persist boom'));
      mockAccessOptions.mockImplementation(() => {
        throw new Error('cookie boom');
      });

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(console.error).toHaveBeenCalledWith(
        'Failed to clear cookies after persistence unexpected error:',
        expect.any(Error),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'Error: persist boom' }),
      );
    });

    it('DD-AUTH-018 保存の結果が空なら例外として Cookie を消し 500', async () => {
      mockPersist.mockResolvedValue(undefined);

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
    });
  });

  describe('公開の経路の中の例外', () => {
    it('DD-AUTH-018 公開の経路の中で投げたら 500 を返す', async () => {
      mockFindUser.mockRejectedValue(new Error('lookup boom'));

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(console.error).toHaveBeenCalledWith('Public register flow error:', expect.any(Error));
    });

    it('DD-AUTH-018 Turnstile が投げても 500 を返す', async () => {
      mockTurnstile.mockRejectedValue(new Error('turnstile boom'));

      const res: any = await POST(registerRequest());

      expect(res.status).toBe(500);
    });
  });
});
