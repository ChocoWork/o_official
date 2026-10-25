import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginPage from '@/app/login/page';
import LoginVerifyPage from '@/app/login/verify/page';
import { LoginProvider } from '@/contexts/LoginContext';

/**
 * メールとパスワードのログインの道（FLOW-AUTH-001）を、頁・画面の部品・ログインの状態の入れ物は本物のまま通す。
 * 差し替えるのは、Next のルーターと Cookie、保留の印の検証、窓口への fetch だけ。
 * ルーターは移り先の頁（サーバーの描画を含む）を描き直すだけの小さな殻で受ける。
 */

type ApiReply = { status: number; body?: unknown };

const mockState = {
  pending: null as { email: string } | null,
  route: '',
  replaceCalls: [] as string[],
  setView: (_view: { node: React.ReactNode; route: string }) => {},
  login: { status: 200, body: { message: 'sent' } } as ApiReply,
  otp: { status: 200, body: { message: 'ok' } } as ApiReply,
  me: { status: 200, body: { authenticated: false } } as ApiReply | 'throw',
  postLogin: { status: 200, body: { redirectTo: '/', needsMfa: false } } as ApiReply | 'throw',
  fetchCalls: [] as Array<{ url: string; method: string }>,
};
const mockPush = jest.fn();

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (mockState.pending ? { value: 'pending-token' } : undefined),
  }),
}));
jest.mock('@/features/auth/services/login-2fa-session', () => ({
  verifyLoginTwoFactorSessionToken: (token: unknown) =>
    token === 'pending-token' && mockState.pending ? { email: mockState.pending.email } : null,
}));
jest.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
  useRouter: () => ({
    replace: (path: string) => {
      mockState.replaceCalls.push(path);
      void navigate(path);
    },
    push: (...args: unknown[]) => mockPush(...args),
  }),
}));
jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});
jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { signOut: jest.fn() } },
}));
jest.mock('@/lib/browser-location', () => ({ navigateBrowser: jest.fn() }));

const VALID_EMAIL = 'member@example.com';
const VALID_PASSWORD = 'password123456789';

async function resolvePage(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<{ node: React.ReactNode; route: string }> {
  try {
    if (path === '/login') {
      return { node: await LoginPage({ searchParams: Promise.resolve(searchParams) }), route: path };
    }
    if (path === '/login/verify') {
      return { node: await LoginVerifyPage(), route: path };
    }
  } catch (error) {
    const redirected = /^NEXT_REDIRECT:(.+)$/.exec(error instanceof Error ? error.message : '');
    if (!redirected) throw error;
    return resolvePage(redirected[1], searchParams);
  }
  // /account・/item・/auth/verified・/admin などは範囲外の頁。着いた先の名前だけを残す。
  return { node: <p>行き先 {path}</p>, route: path };
}

async function navigate(path: string) {
  const view = await resolvePage(path);
  await act(async () => {
    mockState.setView(view);
  });
}

function Shell({ initial }: { initial: { node: React.ReactNode; route: string } }) {
  const [view, setView] = useState(initial);
  mockState.setView = setView;
  return (
    <LoginProvider>
      <div data-testid="shell" data-route={view.route}>
        {view.node}
      </div>
    </LoginProvider>
  );
}

// 最初の me の取得が描画の後に返るので、act の中で待ち切ってから返す。
async function mount(initial: { node: React.ReactNode; route: string }) {
  await act(async () => {
    render(<Shell initial={initial} />);
  });
}

async function openLoginPage(searchParams: Record<string, string> = {}) {
  await mount(await resolvePage('/login', searchParams));
}

function currentRoute() {
  return screen.getByTestId('shell').getAttribute('data-route');
}

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

function installFetch() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    mockState.fetchCalls.push({ url, method });
    if (url === '/api/auth/me') {
      if (mockState.me === 'throw') throw new Error('network');
      return reply(mockState.me.status, mockState.me.body);
    }
    if (url === '/api/auth/post-login') {
      if (mockState.postLogin === 'throw') throw new Error('network');
      return reply(mockState.postLogin.status, mockState.postLogin.body);
    }
    if (url === '/api/auth/login') {
      if (mockState.login.status === 200) mockState.pending = { email: VALID_EMAIL };
      return reply(mockState.login.status, mockState.login.body);
    }
    if (url === '/api/auth/otp/verify') {
      if (mockState.otp.status === 200) mockState.pending = null;
      return reply(mockState.otp.status, mockState.otp.body);
    }
    if (url === '/api/auth/login/cancel') {
      mockState.pending = null;
      return reply(200, {});
    }
    return reply(404, {});
  }) as unknown as typeof fetch;
}

function submitCredentials() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: VALID_EMAIL } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: VALID_PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
}

function submitCode(code = '12345678') {
  Array.from({ length: 8 }, (_, i) => screen.getByLabelText(`認証コード ${i + 1} 桁目`)).forEach(
    (input, i) => fireEvent.change(input, { target: { value: code[i] } }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'サインイン' }));
}

async function goToVerifyScreen() {
  await openLoginPage();
  submitCredentials();
  await screen.findByRole('heading', { name: '認証コードを入力' });
}

describe('メールとパスワードのログインの画面遷移', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.pending = null;
    mockState.replaceCalls = [];
    mockState.fetchCalls = [];
    mockState.login = { status: 200, body: { message: 'sent' } };
    mockState.otp = { status: 200, body: { message: 'ok' } };
    mockState.me = { status: 200, body: { authenticated: false } };
    mockState.postLogin = { status: 200, body: { redirectTo: '/', needsMfa: false } };
    installFetch();
  });

  describe('/login から /login/verify へ', () => {
    test('FLOW-AUTH-001 パスワードの確かめが通ると認証コードの画面へ置き換えて移る', async () => {
      await openLoginPage();
      expect(currentRoute()).toBe('/login');

      submitCredentials();

      expect(await screen.findByRole('heading', { name: '認証コードを入力' })).toBeInTheDocument();
      expect(currentRoute()).toBe('/login/verify');
      expect(screen.getByText('me***er@example.com 宛に送信しました')).toBeInTheDocument();
      expect(mockState.replaceCalls).toEqual(['/login/verify']);
    });

    test('FLOW-AUTH-001 移る手段は置き換えだけで、履歴に積まない', async () => {
      await goToVerifyScreen();

      expect(mockPush).not.toHaveBeenCalled();
      expect(mockState.replaceCalls.every((path) => path.startsWith('/'))).toBe(true);
    });

    test('FLOW-AUTH-001 ログインが失敗したら /login に留まり、窓口の文を出す', async () => {
      mockState.login = { status: 401, body: { error: 'メールアドレスまたはパスワードが正しくありません' } };
      await openLoginPage();

      submitCredentials();

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('メールアドレスまたはパスワードが正しくありません'),
      );
      expect(currentRoute()).toBe('/login');
      expect(mockState.replaceCalls).toEqual([]);
      expect(mockState.pending).toBeNull();
    });

    test('FLOW-AUTH-001 保留の間に /login を開くと、フォームを描かず続きへ送る', async () => {
      mockState.pending = { email: VALID_EMAIL };

      await openLoginPage();

      expect(screen.getByRole('heading', { name: '認証コードを入力' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
      expect(currentRoute()).toBe('/login/verify');
    });

    test('FLOW-AUTH-001 保留が無いのに /login/verify を開くと /login へ戻す', async () => {
      await mount(await resolvePage('/login/verify'));

      expect(currentRoute()).toBe('/login');
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.queryByLabelText('認証コード 1 桁目')).not.toBeInTheDocument();
    });

    test('FLOW-AUTH-001 ?next= のような送り先は URL からは受けず、行き先は窓口の答えだけで決める', async () => {
      await openLoginPage({ next: '/admin' });
      submitCredentials();
      await screen.findByRole('heading', { name: '認証コードを入力' });

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/'));
      expect(mockState.replaceCalls).toEqual(['/login/verify', '/']);
    });
  });

  describe('やり直し', () => {
    test('FLOW-AUTH-001 やり直すと保留を捨ててから /login のフォームへ戻る', async () => {
      await goToVerifyScreen();
      expect(mockState.pending).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '別のアドレスでやり直す' }));

      await waitFor(() => expect(currentRoute()).toBe('/login'));
      expect(mockState.fetchCalls).toContainEqual({ url: '/api/auth/login/cancel', method: 'POST' });
      expect(mockState.pending).toBeNull();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.queryByLabelText('認証コード 1 桁目')).not.toBeInTheDocument();
    });
  });

  describe('認証コードの後の行き先', () => {
    test('FLOW-AUTH-001 戻り先が無い一般の会員は管理者用の確認を通らず / へ。行き先は post-login で決める', async () => {
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/'));
      expect(mockState.fetchCalls).toContainEqual({ url: '/api/auth/otp/verify', method: 'POST' });
      expect(mockState.fetchCalls).toContainEqual({ url: '/api/auth/post-login', method: 'POST' });
      expect(mockState.pending).toBeNull();
      expect(mockState.replaceCalls).toEqual(['/login/verify', '/']);
    });

    test('FLOW-AUTH-001 控えた戻り先があれば、確定の後にその頁へ置き換える', async () => {
      mockState.postLogin = { status: 200, body: { redirectTo: '/item/3?color=red', needsMfa: false } };
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/item/3?color=red'));
      expect(mockState.replaceCalls).toEqual(['/login/verify', '/item/3?color=red']);
    });

    test.each([
      ['外の住所', 'https://evil.example/'],
      ['プロトコル相対', '//evil.example'],
      ['/auth/verified（needsMfa の印なし）', '/auth/verified'],
    ])('FLOW-AUTH-001 窓口が不正な戻り先（%s）を返してもクライアントの確かめで / に直す', async (_label, redirectTo) => {
      mockState.postLogin = { status: 200, body: { redirectTo, needsMfa: false } };
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/'));
      expect(mockState.replaceCalls).toEqual(['/login/verify', '/']);
    });

    test('FLOW-AUTH-001 管理者・サポーターは 2 段目が要る（needsMfa）ので /auth/verified へ送り、/admin へは直接移らない', async () => {
      mockState.postLogin = { status: 200, body: { redirectTo: '/auth/verified', needsMfa: true } };
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/auth/verified'));
      expect(mockState.replaceCalls).not.toContain('/admin');
    });

    test('FLOW-AUTH-001 post-login が 401 なら未ログインとして /login へ戻す', async () => {
      mockState.postLogin = { status: 401, body: { error: 'Unauthorized' } };
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/login'));
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
    });

    test.each([503, 429, 500])('FLOW-AUTH-001 post-login が %i なら /auth/verified へ倒す（特権が 2 段目を飛ばさない）', async (status) => {
      mockState.postLogin = { status, body: {} };
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/auth/verified'));
      expect(mockState.replaceCalls).not.toContain('/admin');
      expect(mockState.replaceCalls).not.toContain('/account');
    });

    test('FLOW-AUTH-001 post-login の呼び出しが落ちたら /auth/verified へ倒す', async () => {
      mockState.postLogin = 'throw';
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(currentRoute()).toBe('/auth/verified'));
    });

    test('FLOW-AUTH-001 認証コードが誤りなら /login/verify に留まり、保留も残す', async () => {
      mockState.otp = { status: 401, body: { error: 'コードが正しくありません' } };
      await goToVerifyScreen();

      submitCode();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('コードが正しくありません'));
      expect(currentRoute()).toBe('/login/verify');
      expect(mockState.pending).not.toBeNull();
      expect(mockState.replaceCalls).toEqual(['/login/verify']);
    });
  });
});
