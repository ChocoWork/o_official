import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage, { generateMetadata } from '@/app/login/page';
import { LoginProvider } from '@/contexts/LoginContext';
import { createLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';

// 画面は /login の頁（サーバー）→ AuthTabs → ログイン／会員登録のフォーム → LoginProvider を本物のまま通す。
// 外との境目だけ偽物にする: Cookie の入れ物・転送・ルーター・Turnstile の Script・通信・Supabase の client。
let mockCookieValue: string | undefined;

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const { loginTwoFactorSessionCookieName } = jest.requireActual('@/lib/cookie');
      return name === loginTwoFactorSessionCookieName && mockCookieValue !== undefined
        ? { name, value: mockCookieValue }
        : undefined;
    },
  }),
}));

const redirectMock = jest.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const routerReplaceMock = jest.fn();

jest.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
  useRouter: () => ({ replace: (...args: unknown[]) => routerReplaceMock(...args) }),
}));

jest.mock('next/script', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { signOut: jest.fn() } },
}));

jest.mock('@/lib/browser-location', () => ({
  navigateBrowser: jest.fn(),
}));

const fetchMock = jest.fn();

async function renderLoginPage(searchParams?: Record<string, string | string[] | undefined>) {
  const element = await LoginPage({
    searchParams: searchParams === undefined ? undefined : Promise.resolve(searchParams),
  });
  await act(async () => {
    render(<LoginProvider>{element}</LoginProvider>);
  });
}

function validPendingToken() {
  return createLoginTwoFactorSessionToken({ userId: 'user-1', email: 'user@example.com' });
}

describe('SCR-AUTH-001 /login はログインと会員登録の2つのタブを持つ1つの認証の画面にする', () => {
  const originalSecret = process.env.LOGIN_2FA_SESSION_SECRET;
  let replaceStateSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.LOGIN_2FA_SESSION_SECRET = 'scr-auth-001-secret';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.LOGIN_2FA_SESSION_SECRET;
    else process.env.LOGIN_2FA_SESSION_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieValue = undefined;
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ authenticated: false }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    window.history.pushState(null, '', '/login');
    replaceStateSpy = jest.spyOn(window.history, 'replaceState');
  });

  afterEach(() => {
    replaceStateSpy.mockRestore();
  });

  it('SCR-AUTH-001 サーバーの描画は題・説明・OG の画像を返す', async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe('LOGIN | Le Fil des Heures');
    expect(metadata.description).toContain('Le Fil des Heures のログインページ');
    expect(metadata.openGraph).toMatchObject({
      title: 'LOGIN | Le Fil des Heures',
      images: ['/mainphoto.png'],
    });
  });

  it('SCR-AUTH-001 保留の Cookie が有効なら描く前に /login/verify へ送る', async () => {
    mockCookieValue = validPendingToken();

    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_REDIRECT:/login/verify',
    );

    expect(redirectMock).toHaveBeenCalledWith('/login/verify');
  });

  it('SCR-AUTH-001 保留の Cookie が壊れている時は送らずにタブの画面を出す', async () => {
    mockCookieValue = 'not-a-valid-token';

    await renderLoginPage({});

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole('tablist', { name: 'ログイン / 会員登録' })).toBeInTheDocument();
  });

  it('SCR-AUTH-001 保留の Cookie が無ければ送らずにタブの画面を出す', async () => {
    await renderLoginPage({});

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['ログイン', '会員登録']);
  });

  it('SCR-AUTH-001 問い合わせが無い時はログインのタブから始め、ログインのフォームを出す', async () => {
    await renderLoginPage(undefined);

    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'auth-tab-login');
    expect(screen.getByRole('button', { name: 'ログイン' })).toHaveAttribute('type', 'submit');
    expect(screen.queryByLabelText('Confirm Password')).toBeNull();
  });

  it('SCR-AUTH-001 ?tab=register で会員登録のタブから始め、会員登録のフォームを出す', async () => {
    await renderLoginPage({ tab: 'register' });

    expect(screen.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'auth-tab-register');
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登録して確認メールを受け取る' })).toBeInTheDocument();
  });

  it('SCR-AUTH-001 tab の値が register 以外ならログインのタブから始める', async () => {
    await renderLoginPage({ tab: 'signup' });

    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
  });

  it('SCR-AUTH-001 ?email= が文字列なら会員登録の欄に入れる', async () => {
    await renderLoginPage({ tab: 'register', email: 'guest@example.com' });

    expect(screen.getByLabelText('Email')).toHaveValue('guest@example.com');
  });

  it('SCR-AUTH-001 ?email= が文字列でない（繰り返し）時は欄を空のままにする', async () => {
    await renderLoginPage({ tab: 'register', email: ['a@example.com', 'b@example.com'] });

    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  it('SCR-AUTH-001 タブの押下で中身がログインと会員登録に入れ替わり、URL を /login に置き換える', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/login?tab=register&email=guest%40example.com');
    await renderLoginPage({ tab: 'register', email: 'guest@example.com' });
    replaceStateSpy.mockClear();

    await user.click(screen.getByRole('tab', { name: 'ログイン' }));

    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Confirm Password')).toBeNull();
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/login');
    expect(window.location.pathname).toBe('/login');
    expect(window.location.search).toBe('');

    await user.click(screen.getByRole('tab', { name: '会員登録' }));

    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();
    expect(window.location.pathname).not.toBe('/register');
    expect(replaceStateSpy).toHaveBeenCalledTimes(2);
  });

  it('SCR-AUTH-001 今のタブを押しても履歴を触らない', async () => {
    const user = userEvent.setup();
    await renderLoginPage({});

    await user.click(screen.getByRole('tab', { name: 'ログイン' }));

    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-001 左右の矢印で隣のタブへ移り、そのタブにフォーカスを置く', async () => {
    await renderLoginPage({});
    const login = screen.getByRole('tab', { name: 'ログイン' });
    login.focus();

    fireEvent.keyDown(login, { key: 'ArrowRight' });

    const register = screen.getByRole('tab', { name: '会員登録' });
    expect(register).toHaveAttribute('aria-selected', 'true');
    expect(register).toHaveFocus();
    expect(screen.getByLabelText('Confirm Password')).toBeInTheDocument();

    fireEvent.keyDown(register, { key: 'ArrowLeft' });

    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveFocus();
    expect(screen.queryByLabelText('Confirm Password')).toBeNull();
  });

  it('SCR-AUTH-001 矢印以外のキーではタブを切り替えない', async () => {
    await renderLoginPage({});
    const login = screen.getByRole('tab', { name: 'ログイン' });

    fireEvent.keyDown(login, { key: 'Enter' });
    fireEvent.keyDown(login, { key: 'ArrowDown' });

    expect(login).toHaveAttribute('aria-selected', 'true');
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('SCR-AUTH-001 選んだタブは黒の太い下線、選ばないタブはグレーの文字と細い下線にし、Tab キーの止まりは選んだタブだけにする', async () => {
    await renderLoginPage({});
    const login = screen.getByRole('tab', { name: 'ログイン' });
    const register = screen.getByRole('tab', { name: '会員登録' });

    expect(login.className).toContain('border-b-2');
    expect(login.className).toContain('border-black');
    expect(login).toHaveAttribute('tabindex', '0');
    expect(register.className).toContain('text-[#737373]');
    expect(register.className).not.toContain('border-b-2');
    expect(register).toHaveAttribute('tabindex', '-1');
  });

  it('SCR-AUTH-001 タブとパネルが aria で結ばれ、切り替えでパネルの見出しも追従する', async () => {
    const user = userEvent.setup();
    await renderLoginPage({});

    screen.getAllByRole('tab').forEach((tab) => expect(tab).toHaveAttribute('aria-controls', 'auth-panel'));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'auth-panel');

    await user.click(screen.getByRole('tab', { name: '会員登録' }));

    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'auth-tab-register');
  });

  it('SCR-AUTH-001 会員登録の完了の後の「ログインページへ」でログインのタブへ戻る', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/register'
        ? { ok: true, status: 200, json: async () => ({ message: '確認メールを送りました' }) }
        : { ok: false, status: 401, json: async () => ({ authenticated: false }) },
    );
    await renderLoginPage({ tab: 'register' });

    await user.type(screen.getByLabelText('Email'), 'guest@example.com');
    await user.type(screen.getByLabelText('Password'), 'abcdefghij123456');
    await user.type(screen.getByLabelText('Confirm Password'), 'abcdefghij123456');
    await user.click(screen.getByRole('button', { name: '登録して確認メールを受け取る' }));
    await user.click(await screen.findByRole('button', { name: 'ログインページへ' }));

    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'ログイン' })).toBeInTheDocument();
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/login');
  });
});
