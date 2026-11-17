import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import LoginPage, { generateMetadata } from '@/app/login/page';
import { emailCodeSessionCookieName, loginTwoFactorSessionCookieName } from '@/lib/cookie';

const mockCookieGet = jest.fn();
const mockVerifyEmailCode = jest.fn();
const mockVerifyLegacy = jest.fn();
const mockRedirect = jest.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

jest.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet }),
}));
jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));
jest.mock('@/features/auth/services/email-code-session', () => ({
  verifyEmailCodeSessionToken: (token: unknown) => mockVerifyEmailCode(token),
}));
jest.mock('@/features/auth/services/login-2fa-session', () => ({
  verifyLoginTwoFactorSessionToken: (token: unknown) => mockVerifyLegacy(token),
}));
jest.mock('@/features/auth/passkey/components/LoginChoices', () => ({
  __esModule: true,
  default: ({
    initialEmail,
    returnTo,
    notice,
  }: {
    initialEmail?: string;
    returnTo?: string;
    notice?: string;
  }) => (
    <div
      data-testid="login-choices"
      data-email={initialEmail ?? ''}
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
  return screen.getByTestId('login-choices');
}

describe('/login page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieGet.mockImplementation((name: string) => ({ value: `cookie:${name}` }));
    mockVerifyEmailCode.mockReturnValue(null);
    mockVerifyLegacy.mockReturnValue(null);
  });

  test('DD-AUTH-001 新しい保留の Cookie が有効なら /login/code へ転送し、問い合わせを読まない', async () => {
    mockVerifyEmailCode.mockReturnValue({ email: 'one@example.invalid' });
    const onRead = jest.fn();
    const searchParams = { then: onRead } as unknown as Promise<Record<string, string>>;

    await expect(LoginPage({ searchParams })).rejects.toThrow('NEXT_REDIRECT:/login/code');

    expect(mockCookieGet).toHaveBeenCalledWith(emailCodeSessionCookieName);
    expect(mockVerifyEmailCode).toHaveBeenCalledWith(`cookie:${emailCodeSessionCookieName}`);
    expect(onRead).not.toHaveBeenCalled();
    expect(screen.queryByTestId('login-choices')).not.toBeInTheDocument();
  });

  test('DD-AUTH-001 旧い保留の Cookie が有効なら /login/verify へ転送する', async () => {
    mockVerifyLegacy.mockReturnValue({ email: 'one@example.invalid' });

    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT:/login/verify');

    expect(mockCookieGet).toHaveBeenCalledWith(loginTwoFactorSessionCookieName);
    expect(mockRedirect).toHaveBeenCalledWith('/login/verify');
  });

  test('DD-AUTH-001 両方が有効なら新しい方（/login/code）を先にする', async () => {
    mockVerifyEmailCode.mockReturnValue({ email: 'one@example.invalid' });
    mockVerifyLegacy.mockReturnValue({ email: 'one@example.invalid' });

    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT:/login/code');
  });

  test('DD-AUTH-001 Cookie が無ければ確かめに undefined を渡して画面を描く', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const choices = await renderPage({});

    expect(mockVerifyEmailCode).toHaveBeenCalledWith(undefined);
    expect(mockVerifyLegacy).toHaveBeenCalledWith(undefined);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(choices).toBeInTheDocument();
  });

  test('DD-AUTH-001 偽り・期限切れの Cookie では転送せず画面を描く', async () => {
    const choices = await renderPage({});

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(choices).toBeInTheDocument();
  });

  test('DD-AUTH-001 ?email はメール欄の初めの値として渡し、tab=register が付いていても同じ画面', async () => {
    const choices = await renderPage({ tab: 'register', email: 'a@example.com' });

    expect(choices).toHaveAttribute('data-email', 'a@example.com');
  });

  test('DD-AUTH-001 問い合わせが無い・空・配列なら空のメールを渡す', async () => {
    expect(await renderPage(undefined)).toHaveAttribute('data-email', '');
    cleanup();
    expect(await renderPage({})).toHaveAttribute('data-email', '');
    cleanup();
    expect(await renderPage({ email: ['a@example.com', 'b@example.com'] })).toHaveAttribute('data-email', '');
  });

  test('DD-AUTH-001 ?next が確かめを通れば、通った道筋だけを returnTo として渡す', async () => {
    const choices = await renderPage({ next: '/item/3?color=red#frag' });

    expect(choices).toHaveAttribute('data-return-to', '/item/3?color=red');
  });

  test.each([
    ['外の住所', '//evil.example'],
    ['/login', '/login'],
    ['/auth/verified', '/auth/verified'],
    ['タブを含む値', '/%09/evil.example'],
    ['許可リスト外', '/unknown'],
  ])('DD-AUTH-001 ?next が %s なら returnTo を渡さない', async (_label, next) => {
    const choices = await renderPage({ next });

    expect(choices).toHaveAttribute('data-has-return-to', 'false');
  });

  test('DD-AUTH-001 ?next が配列・未指定なら returnTo を渡さない', async () => {
    expect(await renderPage({ next: ['/item/3', '/item/4'] })).toHaveAttribute('data-has-return-to', 'false');
    cleanup();
    expect(await renderPage({})).toHaveAttribute('data-has-return-to', 'false');
  });

  test('DD-AUTH-001 ?registered=1 なら固定の案内の文を notice として渡す', async () => {
    const choices = await renderPage({ registered: '1' });

    expect(choices).toHaveAttribute('data-notice', '会員登録が完了しました。ログインしてください。');
  });

  test.each([
    ['0', { registered: '0' }],
    ['空', { registered: '' }],
    ['配列', { registered: ['1', '1'] }],
    ['未指定', {}],
  ])('DD-AUTH-001 registered が %s なら notice を渡さない', async (_label, params) => {
    const choices = await renderPage(params);

    expect(choices).toHaveAttribute('data-has-notice', 'false');
  });

  test('DD-AUTH-001 registered と一緒のメールは案内の文に混ぜない', async () => {
    const choices = await renderPage({ registered: '1', email: 'x@example.com' });

    expect(choices.getAttribute('data-notice')).not.toContain('x@example.com');
  });

  test('DD-AUTH-001 metadata が title・新しい description・OG を返す', async () => {
    const metadata = await generateMetadata();
    const description =
      'Le Fil des Heures のログインページです。パスキー、Google アカウント、メールで受け取るコードでサインインできます。';

    expect(metadata.title).toBe('LOGIN | Le Fil des Heures');
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph).toEqual({
      title: 'LOGIN | Le Fil des Heures',
      description,
      images: ['/mainphoto.png'],
    });
  });
});
