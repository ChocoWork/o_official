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
  const { isLoggedIn, isAdmin, isAuthResolved, loginWithGoogle, logout } = useLogin();
  const [googleResult, setGoogleResult] = React.useState('none');

  return (
    <div>
      <div>logged:{isLoggedIn ? 'yes' : 'no'}</div>
      <div>admin:{isAdmin ? 'yes' : 'no'}</div>
      <div>resolved:{isAuthResolved ? 'yes' : 'no'}</div>
      <button onClick={() => void loginWithGoogle({ next: '/account' })}>google-login</button>
      <button onClick={() => void loginWithGoogle()}>google-login-plain</button>
      <button
        onClick={() =>
          void loginWithGoogle({ next: '/account' }).then((r) => setGoogleResult(r.success ? 'success' : 'failure'))
        }
      >
        google-login-result
      </button>
      <div>google:{googleResult}</div>
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

  test('DD-AUTH-001 LoginContext はパスワードのログイン・会員登録・旧のコード確認の関数を持たない（段4で消した）', async () => {
    const holder: { value: Record<string, unknown> } = { value: {} };
    const Probe = () => {
      holder.value = useLogin() as unknown as Record<string, unknown>;
      return null;
    };

    render(
      <LoginProvider>
        <Probe />
      </LoginProvider>
    );

    await waitFor(() => expect(typeof holder.value.refreshAuthState).toBe('function'));
    expect('login' in holder.value).toBe(false);
    expect('register' in holder.value).toBe(false);
    expect('verifyOtp' in holder.value).toBe(false);
    expect(typeof holder.value.loginWithGoogle).toBe('function');
    expect(typeof holder.value.logout).toBe('function');
  });

  describe('FLOW-AUTH-002 loginWithGoogle', () => {
    const startCalls = () =>
      (global.fetch as jest.Mock).mock.calls.filter(([input]) => input === '/api/auth/oauth/start');

    const mockStart = (response: unknown) => {
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/auth/oauth/start') return response as Response;
        return { ok: true, json: async () => ({ authenticated: false }) } as Response;
      }) as jest.Mock;
    };

    test('FLOW-AUTH-002 POST /api/auth/oauth/start を本文 { provider, next } で呼び、返った url へ移る', async () => {
      const user = userEvent.setup();
      mockStart({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://accounts.example.test/authorize?x=1' }),
      });

      render(
        <LoginProvider>
          <TestConsumer />
        </LoginProvider>
      );
      await user.click(screen.getByText('google-login'));

      await waitFor(() => {
        expect(assignMock).toHaveBeenCalledWith('https://accounts.example.test/authorize?x=1');
      });
      expect(startCalls()).toHaveLength(1);
      expect(startCalls()[0]).toEqual([
        '/api/auth/oauth/start',
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'google', next: '/account' }),
        },
      ]);
      expect(assignMock).toHaveBeenCalledTimes(1);
      expect(assignMock.mock.calls[0][0]).not.toContain('/api/auth/oauth/start');
    });

    test('FLOW-AUTH-002 next が無ければ本文は { provider } だけ', async () => {
      const user = userEvent.setup();
      mockStart({ ok: true, status: 200, json: async () => ({ url: 'https://accounts.example.test/a' }) });

      render(
        <LoginProvider>
          <TestConsumer />
        </LoginProvider>
      );
      await user.click(screen.getByText('google-login-plain'));

      await waitFor(() => expect(assignMock).toHaveBeenCalledWith('https://accounts.example.test/a'));
      expect((startCalls()[0][1] as RequestInit).body).toBe(JSON.stringify({ provider: 'google' }));
    });

    test.each([
      ['502', { ok: false, status: 502, json: async () => ({ error: 'bad' }) }],
      ['200 以外の 2xx', { ok: true, status: 201, json: async () => ({ url: 'https://accounts.example.test/a' }) }],
      ['url が無い', { ok: true, status: 200, json: async () => ({}) }],
      ['url が文字列でない', { ok: true, status: 200, json: async () => ({ url: 42 }) }],
      ['javascript: の url', { ok: true, status: 200, json: async () => ({ url: 'javascript:alert(1)' }) }],
      ['url が解釈できない', { ok: true, status: 200, json: async () => ({ url: 'not a url' }) }],
      [
        '本文が JSON でない',
        {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('bad json');
          },
        },
      ],
    ])('FLOW-AUTH-002 応答が %s なら移らず失敗を返す', async (_label, response) => {
      const user = userEvent.setup();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockStart(response);

      render(
        <LoginProvider>
          <TestConsumer />
        </LoginProvider>
      );
      await user.click(screen.getByText('google-login-result'));

      await waitFor(() => expect(screen.getByText('google:failure')).toBeInTheDocument());
      expect(assignMock).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 fetch が投げても移らず失敗を返す', async () => {
      const user = userEvent.setup();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/auth/oauth/start') throw new Error('network');
        return { ok: true, json: async () => ({ authenticated: false }) } as Response;
      }) as jest.Mock;

      render(
        <LoginProvider>
          <TestConsumer />
        </LoginProvider>
      );
      await user.click(screen.getByText('google-login-result'));

      await waitFor(() => expect(screen.getByText('google:failure')).toBeInTheDocument());
      expect(assignMock).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  test('logout calls logout API and clears login state', async () => {
    const user = userEvent.setup();

    document.cookie = 'sb-csrf-token=test-csrf-token';
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

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

    // 初めの状態の確かめ（/api/auth/me）で、ログイン済みになる
    await waitFor(() => expect(screen.getByText('logged:yes')).toBeInTheDocument());

    await user.click(screen.getByText('logout'));

    await waitFor(() => {
      const logoutCall = (global.fetch as jest.Mock).mock.calls.find(
        ([input]) => input === '/api/auth/logout'
      );
      expect(logoutCall).toBeDefined();

      const [, options] = logoutCall as [string, RequestInit & { headers: Headers }];
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('same-origin');
      expect((options.headers as Headers).get('x-csrf-token')).toBe('test-csrf-token');
    });
    expect(signOutMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('logged:no')).toBeInTheDocument());
  });
});
