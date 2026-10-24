import React from 'react';
import { render, screen } from '@testing-library/react';
import LoginVerifyPage, { metadata } from '@/app/login/verify/page';
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
jest.mock('@/app/login/verify/VerifyOtpClient', () => ({
  __esModule: true,
  default: ({ email }: { email: string }) => <div data-testid="verify-otp-client" data-email={email} />,
}));

describe('/login/verify page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
    mockVerifySession.mockReturnValue(null);
  });

  test('DD-AUTH-002 保留の Cookie が無ければ /login へ転送し、部品を描かない', async () => {
    await expect(LoginVerifyPage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(mockVerifySession).toHaveBeenCalledWith(undefined);
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(screen.queryByTestId('verify-otp-client')).not.toBeInTheDocument();
  });

  test('DD-AUTH-002 保留の印が偽り・期限切れで無効なら /login へ転送する', async () => {
    mockCookieGet.mockReturnValue({ value: 'forged-or-expired' });
    mockVerifySession.mockReturnValue(null);

    await expect(LoginVerifyPage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(mockCookieGet).toHaveBeenCalledWith(loginTwoFactorSessionCookieName);
    expect(mockVerifySession).toHaveBeenCalledWith('forged-or-expired');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-002 保留が有効なら保留のメールを部品へ渡し、転送しない', async () => {
    mockCookieGet.mockReturnValue({ value: 'pending-token' });
    mockVerifySession.mockReturnValue({ email: 'one@example.invalid' });

    render(await LoginVerifyPage());

    expect(mockVerifySession).toHaveBeenCalledWith('pending-token');
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('verify-otp-client')).toHaveAttribute('data-email', 'one@example.invalid');
  });

  test('DD-AUTH-002 metadata が検索の対象から外す noindex, nofollow を返す', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
