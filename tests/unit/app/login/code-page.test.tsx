import React from 'react';
import { render, screen } from '@testing-library/react';
import LoginCodePage, { metadata } from '@/app/login/code/page';
import { emailCodeSessionCookieName } from '@/lib/cookie';

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
jest.mock('@/features/auth/services/email-code-session', () => ({
  verifyEmailCodeSessionToken: (token: unknown) => mockVerifySession(token),
}));
jest.mock('@/features/auth/passkey/components/EmailCodeEntry', () => ({
  __esModule: true,
  default: ({ email }: { email: string }) => <div data-testid="email-code-entry" data-email={email} />,
}));

describe('/login/code page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
    mockVerifySession.mockReturnValue(null);
  });

  test('DD-AUTH-062 保留の Cookie が無ければ /login へ転送し、部品を描かない', async () => {
    await expect(LoginCodePage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(mockCookieGet).toHaveBeenCalledWith(emailCodeSessionCookieName);
    expect(mockVerifySession).toHaveBeenCalledWith(undefined);
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(screen.queryByTestId('email-code-entry')).not.toBeInTheDocument();
  });

  test('DD-AUTH-062 保留の印が偽り・期限切れで無効なら /login へ転送する', async () => {
    mockCookieGet.mockReturnValue({ value: 'forged-or-expired' });

    await expect(LoginCodePage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(mockVerifySession).toHaveBeenCalledWith('forged-or-expired');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-062 保留が有効なら保留のメールを部品へ渡し、転送しない', async () => {
    mockCookieGet.mockReturnValue({ value: 'pending-token' });
    mockVerifySession.mockReturnValue({ email: 'one@example.invalid' });

    render(await LoginCodePage());

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('email-code-entry')).toHaveAttribute('data-email', 'one@example.invalid');
  });

  test('DD-AUTH-062 検索に載せない', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
