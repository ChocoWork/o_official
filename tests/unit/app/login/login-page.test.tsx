import React from 'react';
import { render, screen } from '@testing-library/react';
import LoginPage, { generateMetadata } from '@/app/login/page';
import { loginTwoFactorSessionCookieName } from '@/lib/cookie';

const mockCookieGet = jest.fn();
const mockVerifySession = jest.fn();
const mockRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

jest.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));
jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));
jest.mock('@/features/auth/services/login-2fa-session', () => ({
  verifyLoginTwoFactorSessionToken: (token: unknown) => mockVerifySession(token),
}));
jest.mock('@/components/AuthTabs', () => ({
  __esModule: true,
  default: ({ initialTab, initialEmail }: { initialTab: string; initialEmail: string }) => (
    <div data-testid="auth-tabs" data-tab={initialTab} data-email={initialEmail} />
  ),
}));

async function renderPage(searchParams?: Record<string, string | string[] | undefined>) {
  const element = await LoginPage({
    searchParams: searchParams === undefined ? undefined : Promise.resolve(searchParams),
  });
  render(element);
  return screen.getByTestId('auth-tabs');
}

describe('/login page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
    mockVerifySession.mockReturnValue(null);
  });

  test('DD-AUTH-001 保留の印が有効なら /login/verify へ転送し、問い合わせを読まず AuthTabs を描かない', async () => {
    mockCookieGet.mockReturnValue({ value: 'pending-token' });
    mockVerifySession.mockReturnValue({ email: 'one@example.invalid' });
    const onRead = jest.fn();
    const searchParams = { then: onRead } as unknown as Promise<Record<string, string>>;

    await expect(LoginPage({ searchParams })).rejects.toThrow('NEXT_REDIRECT:/login/verify');

    expect(mockCookieGet).toHaveBeenCalledWith(loginTwoFactorSessionCookieName);
    expect(mockVerifySession).toHaveBeenCalledWith('pending-token');
    expect(mockRedirect).toHaveBeenCalledWith('/login/verify');
    expect(onRead).not.toHaveBeenCalled();
    expect(screen.queryByTestId('auth-tabs')).not.toBeInTheDocument();
  });

  test('DD-AUTH-001 保留の Cookie が無ければ確かめに undefined を渡して頁を描く', async () => {
    const tabs = await renderPage({});

    expect(mockVerifySession).toHaveBeenCalledWith(undefined);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(tabs).toBeInTheDocument();
  });

  test('DD-AUTH-001 保留の印が偽り・期限切れで無効なら頁を描き、転送しない', async () => {
    mockCookieGet.mockReturnValue({ value: 'forged-or-expired' });
    mockVerifySession.mockReturnValue(null);

    const tabs = await renderPage({ tab: 'login' });

    expect(mockVerifySession).toHaveBeenCalledWith('forged-or-expired');
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(tabs).toHaveAttribute('data-tab', 'login');
  });

  test('DD-AUTH-001 保留が無効で ?tab=register&email=a@example.com なら会員登録のタブとメールを渡す', async () => {
    const tabs = await renderPage({ tab: 'register', email: 'a@example.com' });

    expect(tabs).toHaveAttribute('data-tab', 'register');
    expect(tabs).toHaveAttribute('data-email', 'a@example.com');
  });

  test('DD-AUTH-001 問い合わせが無ければログインのタブと空のメールを渡す', async () => {
    const tabs = await renderPage(undefined);

    expect(tabs).toHaveAttribute('data-tab', 'login');
    expect(tabs).toHaveAttribute('data-email', '');
  });

  test('DD-AUTH-001 tab も email も無い空の問い合わせでもログインのタブと空のメールを渡す', async () => {
    const tabs = await renderPage({});

    expect(tabs).toHaveAttribute('data-tab', 'login');
    expect(tabs).toHaveAttribute('data-email', '');
  });

  test('DD-AUTH-001 email が配列なら空にする', async () => {
    const tabs = await renderPage({ email: ['a@example.com', 'b@example.com'] });

    expect(tabs).toHaveAttribute('data-email', '');
  });

  test('DD-AUTH-001 tab がほかの値ならログインのタブにする', async () => {
    const tabs = await renderPage({ tab: 'other' });

    expect(tabs).toHaveAttribute('data-tab', 'login');
  });

  test('DD-AUTH-001 tab が配列ならログインのタブにする', async () => {
    const tabs = await renderPage({ tab: ['register', 'register'] });

    expect(tabs).toHaveAttribute('data-tab', 'login');
  });

  test('DD-AUTH-001 metadata が title・description・OG を返す', async () => {
    const metadata = await generateMetadata();
    const description =
      'Le Fil des Heures のログインページです。メールアドレスとパスワード、または Google アカウントでサインインできます。';

    expect(metadata.title).toBe('LOGIN | Le Fil des Heures');
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph).toEqual({
      title: 'LOGIN | Le Fil des Heures',
      description,
      images: ['/mainphoto.png'],
    });
  });
});
