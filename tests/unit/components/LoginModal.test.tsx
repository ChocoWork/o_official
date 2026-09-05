import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginModal from '@/components/LoginModal';

const loginMock = jest.fn();
const loginWithGoogleMock = jest.fn();
const replaceMock = jest.fn();

// FREQ-334: OTP の検証は /login/verify 側の責務になったので、
// LoginModal はもう verifyOtp を使わない。
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    loginWithGoogle: (...args: unknown[]) => loginWithGoogleMock(...args),
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (...args: unknown[]) => replaceMock(...args),
  }),
}));

describe('LoginModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '';
    loginMock.mockResolvedValue({ success: true, message: '認証コードを送信しました。' });
    loginWithGoogleMock.mockResolvedValue({ success: true });
  });

  test('renders Google sign-in and password reset link', () => {
    render(<LoginModal open={true} onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: /Googleでサインイン/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスワードをお忘れの方はこちら' })).toHaveAttribute(
      'href',
      '/auth/password-reset'
    );
  });

  test('パスワード検証に成功したら専用画面へ replace で送る', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();

    render(<LoginModal open={true} onClose={onClose} />);

    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123456789');
    await user.click(screen.getByRole('button', { name: 'ログイン' }));

    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith('user@example.com', 'password123456789', undefined),
    );

    // FREQ-334-REQ-02: push だと戻るボタンで資格情報フォームに戻れてしまい、
    // 生きた 2FA Cookie を持ったまま再ログインして 2 通目の OTP を発射できる。
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login/verify'));
    expect(onClose).toHaveBeenCalled();

    // OTP の入力欄はこの画面に残っていない
    expect(screen.queryByLabelText('認証コード 1 桁目')).not.toBeInTheDocument();
  });
});
