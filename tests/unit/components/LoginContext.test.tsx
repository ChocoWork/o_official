import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginProvider, useLogin } from '@/contexts/LoginContext';

const signInWithOAuthMock = jest.fn();
const signOutMock = jest.fn().mockResolvedValue({});
const getSessionMock = jest.fn();
const onAuthStateChangeMock = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...args: unknown[]) => signInWithOAuthMock(...args),
      signOut: (...args: unknown[]) => signOutMock(...args),
      getSession: (...args: unknown[]) => getSessionMock(...args),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
    },
  },
}));

const TestConsumer = () => {
  const { isLoggedIn, isAdmin, isAuthResolved, sendOtp, verifyOtp, loginWithGoogle, logout } = useLogin();

  return (
    <div>
      <div>logged:{isLoggedIn ? 'yes' : 'no'}</div>
      <div>admin:{isAdmin ? 'yes' : 'no'}</div>
      <div>resolved:{isAuthResolved ? 'yes' : 'no'}</div>
      <button onClick={() => void sendOtp('user@example.com')}>send-otp</button>
      <button onClick={() => void verifyOtp('user@example.com', '12345678')}>verify-otp</button>
      <button onClick={() => void loginWithGoogle({ next: '/account' })}>google-login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
};

describe('LoginContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    onAuthStateChangeMock.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: jest.fn(),
        },
      },
    });
    signInWithOAuthMock.mockResolvedValue({ error: null });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'ok' }),
    } as Response);
  });

  test('initial session resolves admin state from Supabase session', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          user: {
            app_metadata: {
              role: 'admin',
            },
          },
        },
      },
    });

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    await waitFor(() => expect(screen.getByText('resolved:yes')).toBeInTheDocument());
    expect(screen.getByText('logged:yes')).toBeInTheDocument();
    expect(screen.getByText('admin:yes')).toBeInTheDocument();
  });

  test('sendOtp posts identify request with fixed redirect target', async () => {
    const user = userEvent.setup();

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    await user.click(screen.getByText('send-otp'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/auth/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          turnstileToken: undefined,
          redirect_to: '/auth/verified',
        }),
      });
    });
  });

  test('verifyOtp success marks the user as logged in', async () => {
    const user = userEvent.setup();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: '認証に成功しました。' }),
    } as Response);

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    await user.click(screen.getByText('verify-otp'));

    await waitFor(() => expect(screen.getByText('logged:yes')).toBeInTheDocument());
  });

  test('loginWithGoogle starts OAuth with account chooser enabled', async () => {
    const user = userEvent.setup();

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    await user.click(screen.getByText('google-login'));

    await waitFor(() => {
      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: 'http://localhost/auth/callback?next=%2Faccount',
          queryParams: {
            prompt: 'select_account',
          },
        },
      });
    });
  });

  test('logout calls logout API and clears login state', async () => {
    const user = userEvent.setup();

    document.cookie = 'sb-csrf-token=test-csrf-token';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: '認証に成功しました。' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'ログアウトしました。' }),
      } as Response);

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    await user.click(screen.getByText('verify-otp'));
    await waitFor(() => expect(screen.getByText('logged:yes')).toBeInTheDocument());

    await user.click(screen.getByText('logout'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenLastCalledWith('/api/auth/logout', {
        method: 'POST',
        headers: {
          'x-csrf-token': 'test-csrf-token',
        },
      });
    });
    expect(signOutMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('logged:no')).toBeInTheDocument());
  });
});
