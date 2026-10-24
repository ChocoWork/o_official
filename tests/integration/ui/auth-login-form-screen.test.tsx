import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthTabs from '@/components/AuthTabs';
import { LoginProvider } from '@/contexts/LoginContext';
import { navigateBrowser } from '@/lib/browser-location';

// 画面は AuthTabs → LoginModal → LoginProvider → useTurnstileWidget を本物のまま通す。
// 外との境目だけ偽物にする: ルーター・Script（読み込み後の onReady を呼ぶ）・通信・Supabase の client・ブラウザの移動・window.turnstile。
const routerReplaceMock = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => routerReplaceMock(...args) }),
}));

jest.mock('next/script', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    __esModule: true,
    default: function MockTurnstileScript({ onReady, src }: { onReady?: () => void; src?: string }) {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return <span data-testid="turnstile-script" data-src={src} />;
    },
  };
});

jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { signOut: jest.fn() } },
}));

jest.mock('@/lib/browser-location', () => ({
  navigateBrowser: jest.fn(),
}));

const fetchMock = jest.fn();
const turnstileRenderMock = jest.fn();
const turnstileResetMock = jest.fn();
const turnstileRemoveMock = jest.fn();
let turnstileCallback: ((token: string) => void) | undefined;

const VALID_EMAIL = 'user@example.com';
const VALID_PASSWORD = 'password123456789';

type LoginReply = { ok: boolean; status: number; body: unknown };
let loginReply: LoginReply | 'network-error' | 'pending';
let resolvePending: ((reply: LoginReply) => void) | undefined;

function loginCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/auth/login');
}

async function renderLoginScreen() {
  await act(async () => {
    render(
      <LoginProvider>
        <AuthTabs initialTab="login" />
      </LoginProvider>,
    );
  });
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), VALID_EMAIL);
  await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'ログイン' }));
}

describe('SCR-AUTH-002 ログインのフォームはメール・パスワード・ボットの確かめと、再設定と Google の入口を持つ', () => {
  const originalSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  beforeAll(() => {
    // Turnstile の幅合わせが使う。jsdom には無い。
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    loginReply = { ok: true, status: 200, body: { message: 'コードを送りました' } };
    resolvePending = undefined;
    turnstileCallback = undefined;
    turnstileRenderMock.mockImplementation((_el: HTMLElement, options: { callback: (token: string) => void }) => {
      turnstileCallback = options.callback;
      return 'widget-1';
    });
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: turnstileRenderMock,
      reset: turnstileResetMock,
      remove: turnstileRemoveMock,
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url !== '/api/auth/login') {
        return { ok: false, status: 401, json: async () => ({ authenticated: false }) };
      }
      if (loginReply === 'network-error') throw new TypeError('network down');
      if (loginReply === 'pending') {
        return new Promise((resolve) => {
          resolvePending = (reply) => resolve({ ok: reply.ok, status: reply.status, json: async () => reply.body });
        });
      }
      const reply = loginReply;
      return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });

  afterAll(() => {
    if (originalSiteKey === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey;
  });

  it('SCR-AUTH-002 メールとパスワードの欄、再設定へのリンク、ログインのボタン、Google のボタンを出す', async () => {
    await renderLoginScreen();

    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: 'パスワードをお忘れの方はこちら' })).toHaveAttribute(
      'href',
      '/auth/password-reset',
    );
    expect(screen.getByRole('button', { name: 'ログイン' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: /Googleでサインイン/ })).toBeInTheDocument();
  });

  it('SCR-AUTH-002 並びはフォーム → OR → Google で、再設定の入口はパスワードの欄の後ろにある', async () => {
    await renderLoginScreen();
    const password = screen.getByLabelText('Password');
    const forgot = screen.getByRole('link', { name: 'パスワードをお忘れの方はこちら' });
    const submit = screen.getByRole('button', { name: 'ログイン' });
    const or = screen.getByText('OR');
    const google = screen.getByRole('button', { name: /Googleでサインイン/ });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(follows(password, forgot)).toBe(true);
    expect(follows(forgot, submit)).toBe(true);
    expect(follows(submit, or)).toBe(true);
    expect(follows(or, google)).toBe(true);
    expect(forgot.closest('[data-auth-support-row]')).toHaveClass('text-right');
    expect(google.closest('[data-auth-alternate]')).toHaveAttribute('aria-label', 'その他のログイン方法');
  });

  it('SCR-AUTH-002 メールかパスワードが空の間はログインのボタンを押せない', async () => {
    const user = userEvent.setup();
    await renderLoginScreen();
    const submit = screen.getByRole('button', { name: 'ログイン' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Email'), VALID_EMAIL);
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    expect(submit).toBeEnabled();

    await user.clear(screen.getByLabelText('Email'));
    expect(submit).toBeDisabled();
  });

  it('SCR-AUTH-002 パスワードの表示切替で欄の種類とボタンの名前が入れ替わる', async () => {
    const user = userEvent.setup();
    await renderLoginScreen();

    await user.click(screen.getByRole('button', { name: 'パスワードを表示' }));

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: 'パスワードを非表示' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');

    await user.click(hide);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('SCR-AUTH-002 成功したら /api/auth/login へ送り、認証コードの画面へ置き換えて移る', async () => {
    const user = userEvent.setup();
    await renderLoginScreen();

    await fillAndSubmit(user);

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/login/verify'));
    expect(routerReplaceMock).toHaveBeenCalledTimes(1);
    expect(loginCalls()).toHaveLength(1);
    const [, init] = loginCalls()[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: VALID_EMAIL, password: VALID_PASSWORD });
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('SCR-AUTH-002 送信中は「処理中...」を出して二重に送れない', async () => {
    const user = userEvent.setup();
    loginReply = 'pending';
    await renderLoginScreen();

    await fillAndSubmit(user);

    const busy = await screen.findByRole('button', { name: '処理中...' });
    expect(busy).toBeDisabled();
    expect(loginCalls()).toHaveLength(1);

    await act(async () => {
      resolvePending?.({ ok: true, status: 200, body: {} });
    });
    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/login/verify'));
  });

  it('SCR-AUTH-002 サーバーが断ったらその文を出し、認証コードの画面へは移らない', async () => {
    const user = userEvent.setup();
    loginReply = { ok: false, status: 401, body: { error: 'メールアドレスまたはパスワードが正しくありません' } };
    await renderLoginScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('メールアドレスまたはパスワードが正しくありません');
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'ログイン' })).toBeEnabled();
  });

  it('SCR-AUTH-002 断りの文が無ければ既定の失敗の文を出す', async () => {
    const user = userEvent.setup();
    loginReply = { ok: false, status: 500, body: null };
    await renderLoginScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('ログインに失敗しました');
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-002 通信が切れた時は内部エラーの文を出し、移らない', async () => {
    const user = userEvent.setup();
    loginReply = 'network-error';
    await renderLoginScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('内部エラーが発生しました');
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-002 入力の形が誤りなら送らずにその文を出す', async () => {
    await renderLoginScreen();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });

    fireEvent.submit(screen.getByLabelText('Email').closest('form') as HTMLFormElement);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('メールアドレスの形式が正しくありません');
    expect(alert).toHaveTextContent('パスワードは16文字以上で入力してください');
    expect(loginCalls()).toHaveLength(0);
  });

  it('SCR-AUTH-002 Google のボタンは窓口の入口へブラウザを移す', async () => {
    const user = userEvent.setup();
    await renderLoginScreen();

    await user.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

    expect(navigateBrowser).toHaveBeenCalledWith(
      '/api/auth/oauth/start?provider=google&redirect_to=%2Fauth%2Fverified',
    );
    expect(loginCalls()).toHaveLength(0);
  });

  it('SCR-AUTH-002 サイトキーが無ければ Turnstile を描かず、トークン無しで送る', async () => {
    const user = userEvent.setup();
    await renderLoginScreen();

    expect(screen.queryByTestId('turnstile-script')).toBeNull();
    expect(turnstileRenderMock).not.toHaveBeenCalled();

    await fillAndSubmit(user);

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalled());
    expect(JSON.parse(loginCalls()[0][1].body)).not.toHaveProperty('turnstileToken');
  });

  describe('サイトキーがある時', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
    });

    it('SCR-AUTH-002 Turnstile の Script を読み、読み込み後にウィジェットを描く', async () => {
      await renderLoginScreen();

      expect(screen.getByTestId('turnstile-script')).toHaveAttribute(
        'data-src',
        'https://challenges.cloudflare.com/turnstile/v0/api.js',
      );
      // 付け直しで描き直されても、生きているウィジェットは1つだけ
      expect(turnstileRenderMock.mock.calls.length - turnstileRemoveMock.mock.calls.length).toBe(1);
      expect(turnstileRenderMock.mock.calls[0][1]).toMatchObject({ sitekey: 'site-key-1', size: 'flexible' });
    });

    it('SCR-AUTH-002 ボットの確かめが済んでいなければ送らずに文を出す', async () => {
      const user = userEvent.setup();
      await renderLoginScreen();

      await fillAndSubmit(user);

      expect(await screen.findByRole('alert')).toHaveTextContent('ボット検証を完了してください');
      expect(loginCalls()).toHaveLength(0);
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it('SCR-AUTH-002 確かめのトークンを付けて送り、送った後はウィジェットを引き直す', async () => {
      const user = userEvent.setup();
      await renderLoginScreen();
      act(() => turnstileCallback?.('token-abc'));

      await fillAndSubmit(user);

      await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/login/verify'));
      expect(JSON.parse(loginCalls()[0][1].body)).toMatchObject({ turnstileToken: 'token-abc' });
      expect(turnstileResetMock).toHaveBeenCalledWith('widget-1');
    });

    it('SCR-AUTH-002 断られた後も引き直し、使い終わったトークンでは再送できない', async () => {
      const user = userEvent.setup();
      loginReply = { ok: false, status: 403, body: { error: 'ボット検証に失敗しました' } };
      await renderLoginScreen();
      act(() => turnstileCallback?.('token-used'));

      await fillAndSubmit(user);

      expect(await screen.findByRole('alert')).toHaveTextContent('ボット検証に失敗しました');
      expect(turnstileResetMock).toHaveBeenCalledWith('widget-1');

      await user.click(screen.getByRole('button', { name: 'ログイン' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('ボット検証を完了してください');
      expect(loginCalls()).toHaveLength(1);
    });
  });
});
