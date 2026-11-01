import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  cookies: {
    jar: Map<string, unknown>;
    set: (nameOrCookie: string | { name: string; value: string }, value?: string, options?: unknown) => void;
  };
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
const mockSignOut = jest.fn();
const mockPersist = jest.fn();
const mockLinkGuestOrders = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
const mockSendMail = jest.fn().mockResolvedValue(undefined);
const mockCreateReturnIntent = jest.fn();
const mockConsumeReturnIntent = jest.fn();

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
        // 戻り先の控えの Cookie は { name, value, ...属性 } の形で渡される
        set: (nameOrCookie, value, options) => {
          if (typeof nameOrCookie === 'object') {
            jar.set(nameOrCookie.name, { value: nameOrCookie.value, options: nameOrCookie });
          } else {
            jar.set(nameOrCookie, { value, options });
          }
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
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: async () => ({ auth: { signUp: (...args: unknown[]) => mockSignUp(...args) } }),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({
    rpc: async () => ({ data: mockState.lookup, error: null }),
  }),
  createPublicClient: async () => {
    if (mockState.createPublicClientThrows) throw new Error('client unavailable');
    return {
      auth: {
        verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
        signOut: (...args: unknown[]) => mockSignOut(...args),
      },
    };
  },
}));
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => mockPersist(...args),
}));
// 戻り先の控えの保存だけを差し替える（確かめと Cookie の動作、出口の解決は本物）
jest.mock('@/features/auth/return-intent/return-intent-store', () => ({
  ...jest.requireActual('@/features/auth/return-intent/return-intent-store'),
  createReturnIntent: (...args: unknown[]) => mockCreateReturnIntent(...args),
  consumeReturnIntent: (...args: unknown[]) => mockConsumeReturnIntent(...args),
}));
jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: (...args: unknown[]) => mockLinkGuestOrders(...args),
}));

const ORIGIN = 'http://localhost:3000';
const EMAIL = 'new-member@example.com';
const PASSWORD = 'Passw0rd!23456789';
const INTENT_TOKEN = 'S'.repeat(43);
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
    mockSignOut.mockResolvedValue({ error: null });
    // 1 回で使い切る控えの表の写し（番号は固定）。作った道筋を、用途と結び付けたメール（大文字小文字・前後の空白は無視）が
    // 合う最初の 1 回だけ返す。
    const normalize = (email?: string) => (email === undefined ? undefined : email.trim().toLowerCase());
    const intents = new Map<string, { returnPath: string; purpose: string; bindTo?: string; used: boolean }>();
    mockCreateReturnIntent.mockImplementation(
      async ({ returnPath, purpose, bindTo }: { returnPath: string; purpose: string; bindTo?: string }) => {
        intents.set(INTENT_TOKEN, { returnPath, purpose, bindTo: normalize(bindTo), used: false });
        return { token: INTENT_TOKEN, maxAgeSeconds: 3600 };
      },
    );
    mockConsumeReturnIntent.mockImplementation(
      async ({ token, purpose, bindTo }: { token: string; purpose: string; bindTo?: string }) => {
        const intent = intents.get(token);
        if (!intent || intent.used || intent.purpose !== purpose || intent.bindTo !== normalize(bindTo)) return null;
        intent.used = true;
        return intent.returnPath;
      },
    );
    env.TRUST_PROXY_HEADERS = 'false';
    installFetch();
  });

  afterEach(() => {
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

    test('FLOW-AUTH-003 送ると確認のリンクには戻り先を載せず /api/auth/confirm だけにして、戻り先が無ければ本文は email と password だけで登録の窓口を呼ぶ', async () => {
      await openRegisterTab();
      fillRegisterForm();

      submitRegister();

      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');
      const [, init] = (global.fetch as jest.Mock).mock.calls.find((call) => call[0] === '/api/auth/register');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ email: EMAIL, password: PASSWORD });
      const redirectTo = new URL(mockSignUp.mock.calls[0][0].options.emailRedirectTo);
      expect(redirectTo.origin + redirectTo.pathname).toBe(`${ORIGIN}/api/auth/confirm`);
      expect(redirectTo.search).toBe('');
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
    // 登録の窓口を直に呼び、返った控えの Cookie を確認のリンクの要求に付けられる形にする（登録を始めたブラウザの写し）。
    async function registerWithNext(next?: unknown, email = EMAIL) {
      const res = (await registerPost(
        new Request(`${ORIGIN}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: PASSWORD, ...(next === undefined ? {} : { next }) }),
        }),
      )) as unknown as FakeResponse;
      expect(res.status).toBe(202);
      const intent = res.cookies.jar.get('sb-return-intent') as { value: string } | undefined;
      return { res, cookie: intent && intent.value !== '' ? `sb-return-intent=${intent.value}` : undefined };
    }

    test('FLOW-AUTH-003 登録を始めたブラウザ（控えの Cookie あり）で確認のリンクを開くとログインさせ、/ へ 303 で送る', async () => {
      await openRegisterTab();
      fillRegisterForm();
      submitRegister();
      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');
      // 戻り先が無い登録でも、控えの Cookie は必ず付く
      const intent = lastRegisterReply?.cookies.jar.get('sb-return-intent') as { value: string };
      expect(intent.value).toBe(INTENT_TOKEN);

      const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }), {
        cookie: `guest-cart=abc; sb-return-intent=${intent.value}`,
      });

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'signup' });
      expect(mockPersist).toHaveBeenCalledWith(res, SESSION, USER, expect.anything());
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'success', resource_id: 'user-1' }),
      );
    });

    test('FLOW-AUTH-003 別のブラウザ（控えの Cookie が無い）で開くと、メールの確認だけ済ませ、session を作らず /login?registered=1 へ送り、その画面に案内が出る', async () => {
      await openRegisterTab();
      fillRegisterForm();
      submitRegister();
      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');

      const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }), { cookie: 'guest-cart=abc' });

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/login?registered=1');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
      expect(mockPersist).not.toHaveBeenCalled();
      expect(mockLinkGuestOrders).not.toHaveBeenCalled();
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(res.cookies.jar.size).toBe(0);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.confirm', outcome: 'success', detail: 'confirmed_without_session' }),
      );

      // 行き先の画面は、案内を role="status" で出す（タブを替えても残る）
      cleanup();
      await openLoginPage({ registered: '1' });
      expect(screen.getByRole('status')).toHaveTextContent('会員登録が完了しました。ログインしてください。');
      fireEvent.click(screen.getByRole('tab', { name: '会員登録' }));
      expect(screen.getByRole('status')).toHaveTextContent('会員登録が完了しました。ログインしてください。');
    });

    test('FLOW-AUTH-003 ログインした時にゲストで買った注文を会員へ引き継ぐ', async () => {
      await openRegisterTab();
      fillRegisterForm();
      submitRegister();
      await screen.findByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。');
      const intent = lastRegisterReply?.cookies.jar.get('sb-return-intent') as { value: string };

      await confirm(confirmUrl({ token_hash: 'hash-1' }), { cookie: `sb-return-intent=${intent.value}` });

      expect(mockLinkGuestOrders).toHaveBeenCalledWith({
        userId: 'user-1',
        email: EMAIL,
        emailConfirmedAt: '2026-10-24T00:00:00Z',
      });
    });

    test('FLOW-AUTH-003 確認の印が偽り・期限切れでも理由を出さず、固定の /login へ送る', async () => {
      mockState.verifyOtpResult = { data: { session: null, user: null }, error: { message: 'Token has expired' } };

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=bad`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/login');
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

      await confirm(`${ORIGIN}/api/auth/confirm?token_hash=bad`);

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', metadata: { reason } }),
      );
    });

    test('FLOW-AUTH-003 session も user も返らない応答は失敗として固定の /login へ送る', async () => {
      mockState.verifyOtpResult = { data: { session: null, user: null }, error: null };

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=bad`);

      expect(locationOf(res)).toBe('/login');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', detail: 'missing_session_or_user' }),
      );
    });

    test('FLOW-AUTH-003 印が無いリンクは Supabase を呼ばず固定の /login へ送る', async () => {
      const res = await confirm(`${ORIGIN}/api/auth/confirm`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/login');
      expect(mockVerifyOtp).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-003 token の名前で渡された印も受ける', async () => {
      await confirm(`${ORIGIN}/api/auth/confirm?token=legacy`);

      expect(mockVerifyOtp).toHaveBeenCalledWith({ token_hash: 'legacy', type: 'signup' });
    });

    test.each(['email', 'magiclink', 'recovery', 'admin'])('FLOW-AUTH-003 印の種類 %s は登録の確認ではないので、確かめず（印を消費せず）ログインさせずに固定の /login へ送る', async (type) => {
      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h&type=${type}`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/login');
      expect(mockVerifyOtp).not.toHaveBeenCalled();
      expect(mockPersist).not.toHaveBeenCalled();
    });

    test.each([
      ['外の住所', 'https://evil.example/steal'],
      ['2本のスラッシュ', '//evil.example'],
      ['内部の道', '/account'],
      ['指定なし', ''],
    ])('FLOW-AUTH-003 URL の redirect_to（%s）は読まず、登録を始めたブラウザでも / へ送る', async (_label, redirectTo) => {
      const { cookie } = await registerWithNext();
      const query = redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : '';

      const res = await confirm(`${confirmUrl({ token_hash: 'h' })}${query}`, { cookie: cookie as string });

      expect(new URL(res.headers.get('location') as string).origin).toBe(ORIGIN);
      expect(locationOf(res)).toBe('/');
    });

    describe('登録で控えた戻り先', () => {
      test('FLOW-AUTH-003 登録で控えた道へ、session を作る前に signup の用途とメールで使い切って 303 で送り、控えの Cookie を消す', async () => {
        const { cookie } = await registerWithNext('/item/3?color=red');
        expect(cookie).toBe(`sb-return-intent=${INTENT_TOKEN}`);
        expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/item/3?color=red', purpose: 'signup', bindTo: EMAIL });

        const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }), { cookie: cookie as string });

        expect(res.status).toBe(303);
        expect(locationOf(res)).toBe('/item/3?color=red');
        expect(mockConsumeReturnIntent).toHaveBeenCalledWith({
          token: INTENT_TOKEN,
          purpose: 'signup',
          userId: 'user-1',
          bindTo: EMAIL,
        });
        expect(mockConsumeReturnIntent.mock.invocationCallOrder[0]).toBeLessThan(mockPersist.mock.invocationCallOrder[0]);
        expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({
          value: '',
          options: expect.objectContaining({ maxAge: 0 }),
        });
      });

      test('FLOW-AUTH-003 同じリンクをもう一度開くと控えは使えず、session を作らず /login?registered=1 になる', async () => {
        const { cookie } = await registerWithNext('/item/3');
        const url = confirmUrl({ token_hash: 'hash-1', type: 'signup' });

        const first = await confirm(url, { cookie: cookie as string });
        const second = await confirm(url, { cookie: cookie as string });

        expect(locationOf(first)).toBe('/item/3');
        expect(locationOf(second)).toBe('/login?registered=1');
        expect(mockPersist).toHaveBeenCalledTimes(1);
      });

      test('FLOW-AUTH-003 戻り先つきの登録でも、登録を始めていないブラウザ（控えの Cookie が無い）で開いたら戻り先を使わず /login?registered=1 へ送る', async () => {
        await registerWithNext('/item/3');

        const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }));

        expect(locationOf(res)).toBe('/login?registered=1');
        expect(mockConsumeReturnIntent).not.toHaveBeenCalled();
        expect(mockPersist).not.toHaveBeenCalled();
        expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
      });

      test('FLOW-AUTH-003 登録を始めたブラウザでも、別のメールの印（攻撃者のリンク）では session を作らず、控えの Cookie も消さない', async () => {
        // 被害者のブラウザ: 被害者の登録の控えの Cookie が有効
        const { cookie } = await registerWithNext('/item/3');
        // 攻撃者のメールの確認リンクを、同じブラウザで開く
        mockVerifyOtp.mockResolvedValueOnce({
          data: { session: SESSION, user: { ...USER, id: 'attacker-1', email: 'attacker@example.com' } },
          error: null,
        });

        const res = await confirm(confirmUrl({ token_hash: 'attacker-hash', type: 'signup' }), { cookie: cookie as string });

        expect(locationOf(res)).toBe('/login?registered=1');
        expect(mockPersist).not.toHaveBeenCalled();
        expect(mockLinkGuestOrders).not.toHaveBeenCalled();
        expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(res.cookies.jar.size).toBe(0);

        // 被害者自身のリンクは、そのあと同じ Cookie で通る（控えは壊されていない）
        const victim = await confirm(confirmUrl({ token_hash: 'victim-hash', type: 'signup' }), { cookie: cookie as string });
        expect(locationOf(victim)).toBe('/item/3');
      });

      test('FLOW-AUTH-003 印の種類が signup 以外なら確かめず、登録の控えを使い切らず /login へ送る', async () => {
        const { cookie } = await registerWithNext('/item/3');

        const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'magiclink' }), { cookie: cookie as string });

        expect(locationOf(res)).toBe('/login');
        expect(mockVerifyOtp).not.toHaveBeenCalled();
        expect(mockConsumeReturnIntent).not.toHaveBeenCalled();
      });

      test('FLOW-AUTH-003 保存に失敗しても控えは既に使い切り済み。既定の / のまま返し、控えの Cookie は消す', async () => {
        const { cookie } = await registerWithNext('/item/3');
        mockState.persistResult = { ok: false, error: 'db down' };

        const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }), { cookie: cookie as string });

        expect(locationOf(res)).toBe('/');
        expect(mockConsumeReturnIntent).toHaveBeenCalledTimes(1);
        expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({
          value: '',
          options: expect.objectContaining({ maxAge: 0 }),
        });
      });

      test.each([
        ['外の住所', 'https://evil.example/steal'],
        ['ログイン画面', '/login'],
      ])('FLOW-AUTH-003 入口で外れる戻り先（%s）は既定の / で控え、登録を始めたブラウザではリンクの後は / へ送る', async (_label, next) => {
        const { cookie } = await registerWithNext(next);

        expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/', purpose: 'signup', bindTo: EMAIL });
        expect(cookie).toBe(`sb-return-intent=${INTENT_TOKEN}`);
        const res = await confirm(confirmUrl({ token_hash: 'hash-1', type: 'signup' }), { cookie: cookie as string });
        expect(locationOf(res)).toBe('/');
        expect(mockPersist).toHaveBeenCalledTimes(1);
      });
    });

    test('FLOW-AUTH-003 保存に失敗しても 303 のまま返し、注文の引き継ぎはしない', async () => {
      const { cookie } = await registerWithNext();
      mockState.persistResult = { ok: false, error: 'db down' };

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h`, { cookie: cookie as string });

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/');
      expect(mockLinkGuestOrders).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed' }),
      );
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('db down');
    });

    test('FLOW-AUTH-003 保存が理由を返さない失敗も固定の session_persist_failed を残す', async () => {
      const { cookie } = await registerWithNext();
      mockState.persistResult = undefined;

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h`, { cookie: cookie as string });

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'session_persist_failed' }),
      );
    });

    test('FLOW-AUTH-003 予期しない例外も理由を出さず固定の /login へ送る', async () => {
      mockState.createPublicClientThrows = true;

      const res = await confirm(`${ORIGIN}/api/auth/confirm?token_hash=h`);

      expect(res.status).toBe(303);
      expect(locationOf(res)).toBe('/login');
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
