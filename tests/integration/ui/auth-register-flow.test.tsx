import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/app/login/page';
import { LoginProvider } from '@/contexts/LoginContext';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as confirmGet } from '@/app/api/auth/confirm/route';

/**
 * 会員登録の道（FLOW-AUTH-003）。/login の会員登録のタブ、登録の窓口、確認のメールのリンクの窓口を本物でつなぐ。
 * 差し替えるのは、Next のルーターと Cookie、Next の応答、Supabase のクライアント、メール、監査、回数制限、
 * Bot 検証、漏洩検査、セッションの保存、ゲスト注文の引き継ぎだけ。
 * 窓口への fetch は登録の窓口の本物へつなぎ、確認のリンクはその窓口が Supabase に渡した住所から作る。
 */

type FakeResponse = {
  status: number;
  body?: unknown;
  headers: { get: (name: string) => string | null; set: (name: string, value: string) => void };
  cookies: { jar: Map<string, unknown>; set: (name: string, value: string, options?: unknown) => void };
  json: () => Promise<unknown>;
};

const mockState = {
  turnstileOk: true,
  pwned: 'ok' as 'ok' | 'pwned',
  lookup: null as string | null,
  signUpError: null as { message: string } | null,
  signUpSession: false,
  rateLimited: false as false | 'response' | 'object',
  verifyOtpResult: null as null | { data: unknown; error: { message: string } | null },
  createPublicClientThrows: false,
  persistResult: { ok: true } as { ok: boolean; error?: string } | undefined,
  afterCallbacks: [] as Array<() => unknown>,
};

const mockReplace = jest.fn();
const mockSignUp = jest.fn();
const mockVerifyOtp = jest.fn();
const mockPersist = jest.fn();
const mockLinkGuestOrders = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
const mockSendMail = jest.fn().mockResolvedValue(undefined);

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => {
  const build = (status: number, body?: unknown): FakeResponse => {
    const headers = new Map<string, string>();
    const jar = new Map<string, unknown>();
    return {
      status,
      body,
      headers: {
        get: (name) => headers.get(name.toLowerCase()) ?? null,
        set: (name, value) => {
          headers.set(name.toLowerCase(), value);
        },
      },
      cookies: {
        jar,
        set: (name, value, options) => {
          jar.set(name, { value, options });
        },
      },
      json: async () => body,
    };
  };
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => build(init?.status ?? 200, body),
      redirect: (url: URL, init?: { status?: number }) => {
        const res = build(init?.status ?? 302);
        res.headers.set('location', url.toString());
        return res;
      },
    },
    // after は要求の外では投げるので、呼び出しを溜めるだけの代役にする。
    after: (callback: () => unknown) => {
      mockState.afterCallbacks.push(callback);
    },
  };
});
jest.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));
jest.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
  useRouter: () => ({ replace: (...args: unknown[]) => mockReplace(...args) }),
}));
jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});
jest.mock('@/features/auth/services/login-2fa-session', () => ({
  verifyLoginTwoFactorSessionToken: () => null,
}));
jest.mock('@/lib/supabase/client', () => ({ supabase: { auth: { signOut: jest.fn() } } }));
jest.mock('@/lib/browser-location', () => ({ navigateBrowser: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: async () => {
    if (mockState.rateLimited === 'response') return new Response(null, { status: 429 });
    if (mockState.rateLimited === 'object') return { limited: true };
    return undefined;
  },
}));
jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: async () =>
    mockState.turnstileOk ? { ok: true } : { ok: false, error: 'turnstile_failed' },
}));
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: mockState.pwned }),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));
jest.mock('@/lib/site-url-guard', () => ({ isEmailOriginAllowed: () => true }));
jest.mock('@/lib/ops/site-url-alert', () => ({ notifySiteUrlInvalid: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
jest.mock('@/lib/mail', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSendMail(...args),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: (...args: unknown[]) => mockSignUp(...args) } }),
  createServiceRoleClient: async () => ({
    rpc: async () => ({ data: mockState.lookup, error: null }),
  }),
  createPublicClient: async () => {
    if (mockState.createPublicClientThrows) throw new Error('client unavailable');
    return { auth: { verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args) } };
  },
}));
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => mockPersist(...args),
}));
jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: (...args: unknown[]) => mockLinkGuestOrders(...args),
}));

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'new-member@example.com';
const PASSWORD = 'Passw0rd!23456789';
const SESSION = { access_token: 'access-1', refresh_token: 'refresh-1' };
const USER = {
  id: 'user-1',
  email: EMAIL,
  email_confirmed_at: '2026-10-24T00:00:00Z',
};

// 最初の me の取得が描画の後に返るので、act の中で待ち切ってから返す。
async function openLoginPage(searchParams: Record<string, string> = {}) {
  const page = await LoginPage({ searchParams: Promise.resolve(searchParams) });
  await act(async () => {
    render(<LoginProvider>{page}</LoginProvider>);
  });
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

let lastRegisterReply: FakeResponse | null = null;

function installFetch() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return reply(200, { authenticated: false });
    if (url === '/api/auth/register') {
      const res = (await registerPost(
        new Request(`${ORIGIN}${url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: init?.body as string,
        }),
      )) as unknown as FakeResponse;
      lastRegisterReply = res;
      return reply(res.status, res.body);
    }
    return reply(404, {});
  }) as unknown as typeof fetch;
}

function fillRegisterForm({ email = EMAIL, password = PASSWORD, confirm = PASSWORD } = {}) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: confirm } });
}

function submitRegister() {
  fireEvent.click(screen.getByRole('button', { name: '登録して確認メールを受け取る' }));
}

async function openRegisterTab() {
  await openLoginPage({ tab: 'register' });
}

function confirmUrl(params: Record<string, string>) {
  const emailRedirectTo = mockSignUp.mock.calls[0][0].options.emailRedirectTo as string;
  const url = new URL(emailRedirectTo);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

async function confirm(url: string, headers: Record<string, string> = {}) {
  return (await confirmGet(new Request(url, { headers }))) as unknown as FakeResponse;
}

function locationOf(res: FakeResponse) {
  const location = new URL(res.headers.get('location') as string);
  return location.pathname + location.search;
}

describe('会員登録の画面遷移', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { ...env };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockState, {
      turnstileOk: true,
      pwned: 'ok',
      lookup: null,
      signUpError: null,
      signUpSession: false,
      rateLimited: false,
      verifyOtpResult: null,
      createPublicClientThrows: false,
      persistResult: { ok: true },
      afterCallbacks: [],
    });
    lastRegisterReply = null;
    mockSignUp.mockImplementation(async () =>
      mockState.signUpError
        ? { data: { session: null, user: null }, error: mockState.signUpError }
        : { data: { session: mockState.signUpSession ? SESSION : null, user: USER }, error: null },
    );
    mockVerifyOtp.mockImplementation(async () =>
      mockState.verifyOtpResult ?? { data: { session: SESSION, user: USER }, error: null },
    );
    mockPersist.mockImplementation(async () => mockState.persistResult);
    mockLinkGuestOrders.mockResolvedValue(0);
    delete env.ADMIN_API_KEY;
    env.TRUST_PROXY_HEADERS = 'false';
    installFetch();
  });

  afterEach(() => {
    env.ADMIN_API_KEY = saved.ADMIN_API_KEY;
    env.TRUST_PROXY_HEADERS = saved.TRUST_PROXY_HEADERS;
  });

  describe('入口は /login のタブだけ', () => {
    test('FLOW-AUTH-003 ?tab=register と email を受けて会員登録のタブをメール入りで開く', async () => {
      await openLoginPage({ tab: 'register', email: 'guest@example.com' });

      expect(screen.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Email')).toHaveValue('guest@example.com');
      expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    });

    test('FLOW-AUTH-003 タブの指定が無ければログインのタブを開く', async () => {
      await openLoginPage();

      expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByLabelText('Confirm Password')).not.toBeInTheDocument();
    });

    test('FLOW-AUTH-003 タブを切り替えても住所は /login のままで、履歴を積まない', async () => {
      await openLoginPage();
      const historyLength = window.history.length;

      fireEvent.click(screen.getByRole('tab', { name: '会員登録' }));

      expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
      expect(window.location.pathname).toBe('/login');
      expect(window.history.length).toBe(historyLength);
    });
  });

  describe('登録の送信', () => {
    test('FLOW-AUTH-003 16 文字未満のパスワードは送らずに文を出す', async () => {
      await openRegisterTab();
      fillRegisterForm({ password: 'short-pass-1234', confirm: 'short-pass-1234' });

      submitRegister();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('パスワードは16文字以上で入力してください'),
      );
      expect(mockSignUp).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalledWith('/api/auth/register', expect.anything());
    });

    test('FLOW-AUTH-003 2つのパスワードが違えば送らずに文を出す', async () => {
      await openRegisterTab();
      fillRegisterForm({ confirm: `${PASSWORD}x` });

      submitRegister();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('パスワードが一致しません'));
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-003 送ると確認のリンクの戻り先を /auth/verified にして登録の窓口を呼ぶ', async () => {
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');
      const [, init] = (global.fetch as jest.Mock).mock.calls.find((call) => call[0] === '/api/auth/register');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ email: EMAIL, password: PASSWORD, redirect_to: '/auth/verified' });
      const redirectTo = new URL(mockSignUp.mock.calls[0][0].options.emailRedirectTo);
      expect(redirectTo.origin + redirectTo.pathname).toBe(`${ORIGIN}/api/auth/confirm`);
      expect(redirectTo.searchParams.get('redirect_to')).toBe('/auth/verified');
    });

    test('FLOW-AUTH-003 202 の後はフォームを消し、確認メールの案内と迷惑メールの案内を出して完了の文へフォーカスを移す', async () => {
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      const spamNote = await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');
      expect(lastRegisterReply?.status).toBe(202);
      const sent = (lastRegisterReply?.body as { message: string }).message;
      const completion = screen.getByText(sent);
      expect(completion).toHaveFocus();
      expect(spamNote).toBeInTheDocument();
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });

    test('FLOW-AUTH-003 登録済みの宛先にも同じ案内を出し、本人へはログインの案内のメールだけを送る', async () => {
      mockState.lookup = 'existing-user';
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');
      expect(lastRegisterReply?.status).toBe(202);
      expect(mockSignUp).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.all(mockState.afterCallbacks.map((callback) => callback()));
      });
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: EMAIL, subject: 'アカウントはすでに登録されています' }),
      );
    });

    test('FLOW-AUTH-003 窓口が理由を返さない成功の応答には、既定の確認メールの文を出す', async () => {
      mockState.signUpSession = true;
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      expect(
        await screen.findByText('確認メールを送信しました。メールのリンクから登録を完了してください。'),
      ).toBeInTheDocument();
      expect(lastRegisterReply?.status).toBe(201);
      expect(mockPersist).toHaveBeenCalledTimes(1);
    });

    test('FLOW-AUTH-003 完了の画面の「ログインページへ」でログインのタブへ戻る', async () => {
      await openRegisterTab();
      fillRegisterForm();
      submitRegister();
      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');

      fireEvent.click(screen.getByRole('button', { name: 'ログインページへ' }));

      expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.queryByLabelText('Confirm Password')).not.toBeInTheDocument();
      expect(window.location.pathname).toBe('/login');
    });

    test('FLOW-AUTH-003 漏洩したパスワードは窓口の文を出し、フォームに留まる', async () => {
      mockState.pwned = 'pwned';
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(
          'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
        ),
      );
      expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-003 Bot の確かめに落ちたら窓口の文を出し、メールの送信へ進まない', async () => {
      mockState.turnstileOk = false;
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Bot detection failed'));
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-003 登録に失敗したら窓口の文を出し、フォームに留まる', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockState.signUpError = { message: 'smtp down' };
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to create user'));
      expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
      errorSpy.mockRestore();
    });
  });

  describe('確認のメールのリンク', () => {
    test('FLOW-AUTH-003 リンクを開くとログインさせ、/auth/verified へ 303 で送る', async () => {
      await openRegisterTab();
      fillRegisterForm();
      submitRegister();
      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');

      const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }), { cookie: 'guest-cart=abc' });

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/auth/verified');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'signup' });
      expect(mockPersist).toHaveBeenCalledWith(res, SESSION, USER, expect.anything());
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'success', resource_id: 'user-1' }),
      );
    });

    test('FLOW-AUTH-003 ログインした時にゲストで買った注文を会員へ引き継ぐ', async () => {
      await openRegisterTab();
      fillRegisterForm();
      submitRegister();
      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');

      await confirm(confirmUrl({ token_hash: 'hash-1' }));

      expect(mockLinkGuestOrders).toHaveBeenCalledWith({
        userId: 'user-1',
        email: EMAIL,
        emailConfirmedAt: '2026-10-24T00:00:00Z',
      });
    });

    test('FLOW-AUTH-003 確認の印が偽り・期限切れでも理由を出さず、同じ送り先へ送る', async () => {
      mockState.verifyOtpResult = { data: { session: null, user: null }, error: { message: 'Token has expired' } };

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=bad&redirect_to=%2Fauth%2Fverified`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/auth/verified');
      expect(mockPersist).not.toHaveBeenCalled();
      expect(mockLinkGuestOrders).not.toHaveBeenCalled();
    });

    test.each([
      ['Token has expired', 'expired'],
      ['Token is invalid', 'invalid'],
      ['Token already used', 'reused'],
      ['something else', 'unknown'],
    ])('FLOW-AUTH-003 失敗の理由「%s」は監査に %s として残す', async (message, reason) => {
      mockState.verifyOtpResult = { data: { session: null, user: null }, error: { message } };

      await confirm(`${ORIGIN}/api/auth/confirm?token_hash=bad&redirect_to=%2Fauth%2Fverified`);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', metadata: { reason } }),
      );
    });

    test('FLOW-AUTH-003 session も user も返らない応答は失敗として同じ送り先へ送る', async () => {
      mockState.verifyOtpResult = { data: { session: null, user: null }, error: null };

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=bad&redirect_to=%2Fauth%2Fverified`);

      expect(locationOf(res)).toBe('/auth/verified');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'missing_session_or_user' }),
      );
    });

    test('FLOW-AUTH-003 印が無いリンクは Supabase を呼ばず同じ送り先へ送る', async () => {
      const res = await confirm(`${ORIGIN}/api/auth/confirm?redirect_to=%2Fauth%2Fverified`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/auth/verified');
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-003 token の名前で渡された印も受ける', async () => {
      await confirm(`${ORIGIN}/api/auth/confirm?token=legacy&redirect_to=%2Fauth%2Fverified`);

      expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'legacy', type: 'signup' });
    });

    test.each(['email', 'magiclink', 'recovery'])('FLOW-AUTH-003 印の種類 %s も登録の確認と同じにログインさせる', async (type) => {
      await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h&type=${type}&redirect_to=%2Fauth%2Fverified`);

      expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type });
      expect(mockPersist).toHaveBeenCalledTimes(1);
    });

    test('FLOW-AUTH-003 知らない種類は signup として扱う', async () => {
      await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h&type=admin&redirect_to=%2Fauth%2Fverified`);

      expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    });

    test.each([
      ['外の住所', 'https://evil.example/steal'],
      ['2本のスラッシュ', '//evil.example'],
      ['指定なし', ''],
    ])('FLOW-AUTH-003 送り先が%sなら受けず、既定の /account へ送る', async (_label, redirectTo) => {
      const query = redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : '';

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h${query}`);

      expect(new URL(res.headers.get('location') as string).origin).toBe(ORIGIN);
      expect(locationOf(res)).toBe('/account');
    });

    test('FLOW-AUTH-003 保存に失敗しても 303 のまま返し、注文の引き継ぎはしない', async () => {
      mockState.persistResult = { ok: false, error: 'db down' };

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h&redirect_to=%2Fauth%2Fverified`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/auth/verified');
      expect(mockLinkGuestOrders).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: db down' }),
      );
    });

    test('FLOW-AUTH-003 保存が理由を返さない失敗は unknown として残す', async () => {
      mockState.persistResult = undefined;

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h&redirect_to=%2Fauth%2Fverified`);

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'session_persist_failed: unknown' }),
      );
    });

    test('FLOW-AUTH-003 予期しない例外も理由を出さず同じ送り先へ送る', async () => {
      mockState.createPublicClientThrows = true;

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h&redirect_to=%2Fauth%2Fverified`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/auth/verified');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', metadata: { reason: 'unexpected' } }),
      );
    });

    test('FLOW-AUTH-003 回数制限の応答はそのまま返し、印を検査しない', async () => {
      mockState.rateLimited = 'response';

      const res = (await confirmGet(
        new Request(`${ORIGIN}/api/auth/confirm?token_hash=h`),
      )) as unknown as Response;

      expect(res.status).toBe(429);
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-003 回数制限が応答の形でなければ 429 と待ちの秒を自分で返す', async () => {
      mockState.rateLimited = 'object';

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h`);

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('600');
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    });
  });
});
