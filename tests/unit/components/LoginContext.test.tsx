import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginProvider, useLogin } from '@/contexts/LoginContext';

const signOutMock = jest.fn().mockResolvedValue({});
const assignMock = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      signOut: (...args: unknown[]) => signOutMock(...args),
    },
  },
}));

jest.mock('@/lib/browser-location', () => ({
  navigateBrowser: (...args: unknown[]) => assignMock(...args),
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
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        return {
          ok: true,
          json: async () => ({ authenticated: false }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ message: 'ok' }),
      } as Response;
    }) as jest.Mock;
  });

  test('initial session resolves admin state from Supabase session', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: {
              role: 'admin',
              mfaVerified: true,
            },
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ message: 'ok' }),
      } as Response;
    }) as jest.Mock;

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

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/otp/verify') {
        return {
          ok: true,
          json: async () => ({
            message: '認証に成功しました。',
          }),
        } as Response;
      }

      if (url === '/api/auth/me') {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: {
              role: 'user',
              mfaVerified: false,
            },
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ message: 'ok' }),
      } as Response;
    }) as jest.Mock;

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    await user.click(screen.getByText('verify-otp'));

    await waitFor(() => expect(screen.getByText('logged:yes')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/me', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
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
      expect(assignMock).toHaveBeenCalledWith('/api/auth/oauth/start?provider=google&redirect_to=%2Faccount');
    });
  });

  test('logout calls logout API and clears login state', async () => {
    const user = userEvent.setup();

    document.cookie = 'sb-csrf-token=test-csrf-token';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/api/auth/otp/verify') {
        return {
          ok: true,
          json: async () => ({ message: '認証に成功しました。' }),
        } as Response;
      }

      if (url === '/api/auth/me') {
        return {
          ok: true,
          json: async () => ({
            authenticated: true,
            user: {
              role: 'user',
              mfaVerified: false,
            },
          }),
        } as Response;
      }

      if (url === '/api/auth/logout') {
        return {
          ok: true,
          json: async () => ({ message: 'ログアウトしました。' }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ message: 'ok' }),
      } as Response;
    }) as jest.Mock;

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
