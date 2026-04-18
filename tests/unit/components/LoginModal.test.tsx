import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginModal from '@/components/LoginModal';

const sendOtpMock = jest.fn();
const verifyOtpMock = jest.fn();
const loginWithGoogleMock = jest.fn();
const replaceMock = jest.fn();

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    sendOtp: (...args: unknown[]) => sendOtpMock(...args),
    verifyOtp: (...args: unknown[]) => verifyOtpMock(...args),
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
    sendOtpMock.mockResolvedValue({ success: true, message: '認証コードを送信しました。' });
    verifyOtpMock.mockResolvedValue({ success: true, message: '認証に成功しました。' });
    loginWithGoogleMock.mockResolvedValue({ success: true });
  });

  test('renders Google sign-in and password reset link', () => {
    render(<LoginModal open={true} onClose={jest.fn()} />);

    expect(screen.getByRole('button', { name: /Googleでサインイン/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスワードを忘れた方はこちら' })).toHaveAttribute(
      'href',
      '/auth/password-reset'
    );
  });

  test('switches to OTP input mode after successful send', async () => {
    const user = userEvent.setup();

    render(<LoginModal open={true} onClose={jest.fn()} />);

    await user.type(screen.getByLabelText('EMAIL'), 'user@example.com');
    await user.click(screen.getByRole('button', { name: 'メールで認証コードを受け取る' }));

    await waitFor(() => expect(sendOtpMock).toHaveBeenCalledWith('user@example.com', undefined));
    expect(screen.getByLabelText('認証コード 1 桁目')).toBeInTheDocument();
    expect(screen.getByText(/後に再送可能/)).toBeInTheDocument();
  });
});