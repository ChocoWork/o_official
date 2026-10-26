import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
  default: ({
    initialTab,
    initialEmail,
    returnTo,
    notice,
  }: {
    initialTab: string;
    initialEmail: string;
    returnTo?: string;
    notice?: string;
  }) => (
    <div
      data-testid="auth-tabs"
      data-tab={initialTab}
      data-email={initialEmail}
      data-has-return-to={String(returnTo !== undefined)}
      data-return-to={returnTo ?? ''}
      data-has-notice={String(notice !== undefined)}
      data-notice={notice ?? ''}
    />
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

  test('DD-AUTH-001 ?next が確かめを通れば、通った道筋だけを returnTo として AuthTabs に渡す', async () => {
    const tabs = await renderPage({ next: '/item/3?color=red#frag' });

    expect(tabs).toHaveAttribute('data-return-to', '/item/3?color=red');
  });

  test.each([
    ['外の住所', '//evil.example'],
    ['/login', '/login'],
    ['/auth/verified', '/auth/verified'],
    ['タブを含む値', '/%09/evil.example'],
    ['許可リスト外', '/unknown'],
  ])('DD-AUTH-001 ?next が %s なら returnTo を渡さない', async (_label, next) => {
    const tabs = await renderPage({ next });

    expect(tabs).toHaveAttribute('data-has-return-to', 'false');
  });

  test('DD-AUTH-001 ?next が配列・未指定なら returnTo を渡さない', async () => {
    expect(await renderPage({ next: ['/item/3', '/item/4'] })).toHaveAttribute('data-has-return-to', 'false');
    cleanup();
    expect(await renderPage({})).toHaveAttribute('data-has-return-to', 'false');
  });

  test('DD-AUTH-001 ?registered=1 なら固定の案内の文を notice として AuthTabs に渡す', async () => {
    const tabs = await renderPage({ registered: '1' });

    expect(tabs).toHaveAttribute('data-notice', '会員登録が完了しました。ログインしてください。');
  });

  test.each([
    ['0', { registered: '0' }],
    ['空', { registered: '' }],
    ['配列', { registered: ['1', '1'] }],
    ['未指定', {}],
  ])('DD-AUTH-001 registered が %s なら notice を渡さない', async (_label, params) => {
    const tabs = await renderPage(params);

    expect(tabs).toHaveAttribute('data-has-notice', 'false');
  });

  test('DD-AUTH-001 registered の値そのものは画面に出さず、案内の文は固定', async () => {
    const tabs = await renderPage({ registered: '1', email: 'x@example.com' });

    expect(tabs.getAttribute('data-notice')).not.toContain('x@example.com');
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
