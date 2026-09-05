import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import VerifyOtpClient from '@/app/login/verify/VerifyOtpClient';

const mockReplace = jest.fn();
const mockVerifyOtp = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => ({ verifyOtp: mockVerifyOtp }) }));

describe('OTP verification and resend feedback', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-05T02:00:00Z'));
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });
  async function resend(status: number, retryAfter?: string) {
    jest.mocked(global.fetch).mockResolvedValue(new Response('{"error":"private DB detail"}', {
      status, headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    }));
    render(<VerifyOtpClient email="one@example.invalid" />);
    act(() => jest.advanceTimersByTime(60000));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });
  }
  test('successful resend clears digits and restarts cooldown', async () => {
    await resend(200);
    expect(screen.getByRole('status')).toHaveTextContent('認証コードを再送信しました。');
    expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/login/resend', {
      method: 'POST', credentials: 'same-origin',
    });
  });
  test('401 returns to login', async () => {
    await resend(401);
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });
  test.each(['120', 'Sat, 05 Sep 2026 02:03:00 GMT'])('429 honors Retry-After %s', async retryAfter => {
    await resend(429, retryAfter);
    expect(screen.getByRole('alert')).toHaveTextContent('送信回数の上限');
    act(() => jest.advanceTimersByTime(119000));
    expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
  });
  test.each([undefined, 'invalid', '-1'])('invalid Retry-After %s uses 60 seconds', async retryAfter => {
    await resend(429, retryAfter);
    act(() => jest.advanceTimersByTime(59000));
    expect(screen.queryByRole('button', { name: '再送信' })).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByRole('button', { name: '再送信' })).toBeEnabled();
  });
  test.each([
    [503, '一時的に認証処理を利用できません'],
    [500, '認証コードの送信に失敗しました'],
  ])('%s displays safe feedback', async (status, message) => {
    await resend(status as number);
    expect(screen.getByRole('alert')).toHaveTextContent(message as string);
    expect(screen.queryByText(/private DB detail/)).not.toBeInTheDocument();
  });
  test('network failure displays resend failure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    render(<VerifyOtpClient email="one@example.invalid" />);
    act(() => jest.advanceTimersByTime(60000));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '再送信' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('認証コードの送信に失敗しました');
    consoleError.mockRestore();
  });
  test('valid OTP completes login using the verified account response', async () => {
    mockVerifyOtp.mockResolvedValue({ success: true });
    jest.mocked(global.fetch).mockResolvedValue(new Response('{"authenticated":true,"user":{"role":"user"}}'));
    render(<VerifyOtpClient email="one@example.invalid" />);
    fireEvent.paste(screen.getByLabelText('認証コード 1 桁目'), {
      clipboardData: { getData: () => '12345678' },
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'サインイン' })); });
    expect(mockVerifyOtp).toHaveBeenCalledWith('12345678');
    expect(mockReplace).toHaveBeenCalledWith('/account');
  });
});
