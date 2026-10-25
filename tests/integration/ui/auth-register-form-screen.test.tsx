import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthTabs from '@/components/AuthTabs';
import RegisterModal from '@/components/RegisterModal';
import { LoginProvider } from '@/contexts/LoginContext';
import { navigateBrowser } from '@/lib/browser-location';

// 画面は AuthTabs → RegisterModal → LoginProvider → useTurnstileWidget を本物のまま通す。
// 外との境目だけ偽物にする: Script（読み込み後の onReady を呼ぶ）・通信・Supabase の client・ブラウザの移動・window.turnstile。
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
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

const VALID_EMAIL = 'guest@example.com';
// 16 文字ちょうど
const VALID_PASSWORD = 'abcdefghij123456';
const DEFAULT_SENT_MESSAGE = '確認メールを送信しました。メールのリンクから登録を完了してください。';

type RegisterReply = { ok: boolean; status: number; body: unknown };
let registerReply: RegisterReply | 'network-error' | 'pending';
let resolvePending: ((reply: RegisterReply) => void) | undefined;

function registerCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/auth/register');
}

async function renderRegisterScreen(initialEmail?: string, returnTo?: string) {
  await act(async () => {
    render(
      <LoginProvider>
        <AuthTabs initialTab="register" initialEmail={initialEmail} returnTo={returnTo} />
      </LoginProvider>,
    );
  });
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  password = VALID_PASSWORD,
  confirm = VALID_PASSWORD,
) {
  const email = screen.getByLabelText('Email') as HTMLInputElement;
  if (!email.value) await user.type(email, VALID_EMAIL);
  await user.type(screen.getByLabelText('Password'), password);
  await user.type(screen.getByLabelText('Confirm Password'), confirm);
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '登録して確認メールを受け取る' }));
}

describe('SCR-AUTH-003 会員登録のフォームはメール・パスワード2回・ボットの確かめを受け、送った後は確認のメールの案内だけにする', () => {
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
    registerReply = { ok: true, status: 200, body: { message: DEFAULT_SENT_MESSAGE } };
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
      if (url === '/api/auth/oauth/start') {
        return { ok: true, status: 200, json: async () => ({ url: 'https://accounts.example.test/authorize' }) };
      }
      if (url !== '/api/auth/register') {
        return { ok: false, status: 401, json: async () => ({ authenticated: false }) };
      }
      if (registerReply === 'network-error') throw new TypeError('network down');
      if (registerReply === 'pending') {
        return new Promise((resolve) => {
          resolvePending = (reply) => resolve({ ok: reply.ok, status: reply.status, json: async () => reply.body });
        });
      }
      const reply = registerReply;
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

  it('SCR-AUTH-003 メール・パスワード・パスワード（確認）の3つの欄と登録のボタン、Google のボタンを出す', async () => {
    await renderRegisterScreen();

    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: '登録して確認メールを受け取る' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: /Googleで登録/ })).toBeInTheDocument();
  });

  it('SCR-AUTH-003 パスワードの欄の placeholder に 16 文字の決まりを書かない', async () => {
    await renderRegisterScreen();

    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', 'Password');
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('placeholder', 'Confirm Password');
  });

  it('SCR-AUTH-003 並びはフォーム → OR → Google', async () => {
    await renderRegisterScreen();
    const confirm = screen.getByLabelText('Confirm Password');
    const submitButton = screen.getByRole('button', { name: '登録して確認メールを受け取る' });
    const or = screen.getByText('OR');
    const google = screen.getByRole('button', { name: /Googleで登録/ });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(follows(confirm, submitButton)).toBe(true);
    expect(follows(submitButton, or)).toBe(true);
    expect(follows(or, google)).toBe(true);
    expect(google.closest('[data-auth-alternate]')).toHaveAttribute('aria-label', 'その他の会員登録方法');
  });

  it('SCR-AUTH-003 呼び手から受けたメールを欄の初めの値にする', async () => {
    await renderRegisterScreen('start@example.com');

    expect(screen.getByLabelText('Email')).toHaveValue('start@example.com');
  });

  it('SCR-AUTH-003 3つの欄が全部埋まるまで登録のボタンを押せない', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();
    const button = screen.getByRole('button', { name: '登録して確認メールを受け取る' });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Email'), VALID_EMAIL);
    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Confirm Password'), VALID_PASSWORD);
    expect(button).toBeEnabled();
  });

  it('SCR-AUTH-003 2つのパスワードの欄は別々に表示を切り替えられる', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await user.click(screen.getByRole('button', { name: 'パスワードを表示' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: '確認用パスワードを表示' }));
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: '確認用パスワードを非表示' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('SCR-AUTH-003 16 文字未満なら送らずに文を出す', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await fillForm(user, 'abcdefghij12345', 'abcdefghij12345');
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('パスワードは16文字以上で入力してください');
    expect(registerCalls()).toHaveLength(0);
  });

  it('SCR-AUTH-003 2つのパスワードが一致しなければ送らずに文を出す', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await fillForm(user, VALID_PASSWORD, `${VALID_PASSWORD}x`);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('パスワードが一致しません');
    expect(registerCalls()).toHaveLength(0);
  });

  it('SCR-AUTH-003 ちょうど 16 文字で一致していれば送る', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    await screen.findByText(DEFAULT_SENT_MESSAGE);
    expect(registerCalls()).toHaveLength(1);
  });

  it('SCR-AUTH-003 /api/auth/register へ戻り先が無ければ redirect_to も next も付けずに POST する', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    await screen.findByText(DEFAULT_SENT_MESSAGE);
    const [, init] = registerCalls()[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      email: VALID_EMAIL,
      password: VALID_PASSWORD,
    });
  });

  it('SCR-AUTH-003 戻り先つきの画面は /api/auth/register の本文に next を載せる（redirect_to は載せない）', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen(undefined, '/account');

    await fillForm(user);
    await submit(user);

    await screen.findByText(DEFAULT_SENT_MESSAGE);
    const [, init] = registerCalls()[0];
    expect(JSON.parse(init.body)).toEqual({
      email: VALID_EMAIL,
      password: VALID_PASSWORD,
      next: '/account',
    });
  });

  it('SCR-AUTH-003 送信中は「処理中...」を出して二重に送れない', async () => {
    const user = userEvent.setup();
    registerReply = 'pending';
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    const busy = await screen.findByRole('button', { name: '処理中...' });
    expect(busy).toBeDisabled();
    expect(registerCalls()).toHaveLength(1);

    await act(async () => {
      resolvePending?.({ ok: true, status: 200, body: {} });
    });
    expect(await screen.findByText(DEFAULT_SENT_MESSAGE)).toBeInTheDocument();
  });

  it('SCR-AUTH-003 成功したらフォームを消し、確認メールの案内と迷惑メールの案内だけを出す', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    expect(await screen.findByText(DEFAULT_SENT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText('メールが届かない場合は、迷惑メールフォルダをご確認ください。')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: /Googleで登録/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'ログインページへ' })).toBeInTheDocument();
  });

  it('SCR-AUTH-003 窓口の返した案内の文があればそれを出す', async () => {
    const user = userEvent.setup();
    registerReply = { ok: true, status: 200, body: { message: '窓口からの案内です' } };
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    expect(await screen.findByText('窓口からの案内です')).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_SENT_MESSAGE)).toBeNull();
  });

  it('SCR-AUTH-003 完了の文へフォーカスを移す', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    const message = await screen.findByText(DEFAULT_SENT_MESSAGE);
    expect(message.closest('p')).toHaveFocus();
    expect(message.closest('p')).toHaveAttribute('tabindex', '-1');
  });

  it('SCR-AUTH-003 「ログインページへ」はログインのタブへ戻る', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();
    await fillForm(user);
    await submit(user);

    await user.click(await screen.findByRole('button', { name: 'ログインページへ' }));

    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Confirm Password')).toBeNull();
  });

  it('SCR-AUTH-003 呼び手が戻る手段を渡さない時は /login へのリンクを置く', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(
        <LoginProvider>
          <RegisterModal />
        </LoginProvider>,
      );
    });
    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('link', { name: 'ログインページへ' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', { name: 'ログインページへ' })).toBeNull();
  });

  it('SCR-AUTH-003 漏洩などで断られたら窓口の文を出し、フォームに留まる', async () => {
    const user = userEvent.setup();
    registerReply = { ok: false, status: 400, body: { error: 'このパスワードは漏洩が確認されています' } };
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('このパスワードは漏洩が確認されています');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(DEFAULT_SENT_MESSAGE)).toBeNull();
  });

  it('SCR-AUTH-003 一時的に受け付けられない時の文も窓口の文のまま出す', async () => {
    const user = userEvent.setup();
    registerReply = { ok: false, status: 503, body: { error: '現在受け付けられません。しばらくしてからお試しください' } };
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('現在受け付けられません');
  });

  it('SCR-AUTH-003 断りの文が無ければ既定の失敗の文を出す', async () => {
    const user = userEvent.setup();
    registerReply = { ok: false, status: 500, body: null };
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('登録に失敗しました');
  });

  it('SCR-AUTH-003 通信が切れた時は内部エラーの文を出し、フォームに留まる', async () => {
    const user = userEvent.setup();
    registerReply = 'network-error';
    await renderRegisterScreen();

    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('内部エラーが発生しました');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('SCR-AUTH-003 メールの形が誤りなら送らずにその文を出す', async () => {
    await renderRegisterScreen();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: VALID_PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: VALID_PASSWORD } });

    fireEvent.submit(screen.getByLabelText('Email').closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('メールアドレスの形式が正しくありません'));
    expect(registerCalls()).toHaveLength(0);
  });

  it('SCR-AUTH-003 Google のボタンは開始の窓口へ POST し、返った住所へブラウザを移す', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen(undefined, '/account');

    await user.click(screen.getByRole('button', { name: /Googleで登録/ }));

    await waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith('https://accounts.example.test/authorize'));
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/auth/oauth/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ provider: 'google', next: '/account' });
    expect(registerCalls()).toHaveLength(0);
  });

  it('SCR-AUTH-003 サイトキーが無ければ Turnstile を描かず、トークン無しで送る', async () => {
    const user = userEvent.setup();
    await renderRegisterScreen();

    expect(screen.queryByTestId('turnstile-script')).toBeNull();
    expect(turnstileRenderMock).not.toHaveBeenCalled();

    await fillForm(user);
    await submit(user);

    await screen.findByText(DEFAULT_SENT_MESSAGE);
    expect(JSON.parse(registerCalls()[0][1].body)).not.toHaveProperty('turnstileToken');
  });

  describe('サイトキーがある時', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key-1';
    });

    it('SCR-AUTH-003 Turnstile の Script を読み、読み込み後にウィジェットを描く', async () => {
      await renderRegisterScreen();

      expect(screen.getByTestId('turnstile-script')).toHaveAttribute(
        'data-src',
        'https://challenges.cloudflare.com/turnstile/v0/api.js',
      );
      // 付け直しで描き直されても、生きているウィジェットは1つだけ
      expect(turnstileRenderMock.mock.calls.length - turnstileRemoveMock.mock.calls.length).toBe(1);
      expect(turnstileRenderMock.mock.calls[0][1]).toMatchObject({ sitekey: 'site-key-1', size: 'flexible' });
    });

    it('SCR-AUTH-003 ボットの確かめが済んでいなければ送らずに文を出す', async () => {
      const user = userEvent.setup();
      await renderRegisterScreen();

      await fillForm(user);
      await submit(user);

      expect(await screen.findByRole('alert')).toHaveTextContent('ボット検証を完了してください');
      expect(registerCalls()).toHaveLength(0);
    });

    it('SCR-AUTH-003 確かめのトークンを付けて送り、送った後はウィジェットを引き直す', async () => {
      const user = userEvent.setup();
      await renderRegisterScreen();
      act(() => turnstileCallback?.('token-abc'));

      await fillForm(user);
      await submit(user);

      await screen.findByText(DEFAULT_SENT_MESSAGE);
      expect(JSON.parse(registerCalls()[0][1].body)).toMatchObject({ turnstileToken: 'token-abc' });
      expect(turnstileResetMock).toHaveBeenCalledWith('widget-1');
    });

    it('SCR-AUTH-003 断られた後も引き直し、使い終わったトークンでは再送できない', async () => {
      const user = userEvent.setup();
      registerReply = { ok: false, status: 403, body: { error: 'ボット検証に失敗しました' } };
      await renderRegisterScreen();
      act(() => turnstileCallback?.('token-used'));

      await fillForm(user);
      await submit(user);

      expect(await screen.findByRole('alert')).toHaveTextContent('ボット検証に失敗しました');
      expect(turnstileResetMock).toHaveBeenCalledWith('widget-1');

      await submit(user);

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ボット検証を完了してください'));
      expect(registerCalls()).toHaveLength(1);
    });
  });
});
