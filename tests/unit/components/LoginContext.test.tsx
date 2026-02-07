import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginProvider, useLogin } from '@/app/components/LoginContext';

// Mock supabase client
jest.mock('@/lib/supabase/client', () => {
  return {
    supabase: {
      auth: {
        signInWithPassword: jest.fn(),
        signOut: jest.fn().mockResolvedValue({}),
        getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
        onAuthStateChange: jest.fn().mockReturnValue({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
  };
});

const TestConsumer: React.FC = () => {
  const { login, logout, isLoggedIn, isAdmin } = useLogin();
  return (
    <div>
      <div>logged:{isLoggedIn ? 'yes' : 'no'}</div>
      <div>admin:{isAdmin ? 'yes' : 'no'}</div>
      <button onClick={() => login('user@example.com', 'password123')}>do-login</button>
      <button onClick={() => login('bademail', 'pw')}>do-login-bad</button>
      <button onClick={() => logout()}>do-logout</button>
    </div>
  );
};

describe('LoginContext', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(() => {
    const { supabase } = require('@/lib/supabase/client');
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: () => {} } } });
  });

  test('successful login sets state and returns success', async () => {
    const { supabase } = require('@/lib/supabase/client');
    supabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { email: 'aaa@gmail.com' } }, error: null });

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    userEvent.click(screen.getByText('do-login'));

    await waitFor(() => expect(screen.getByText('logged:yes')).toBeInTheDocument());
    expect(screen.getByText('admin:yes')).toBeInTheDocument();
  });

  test('validation failure returns error and does not call supabase', async () => {
    const { supabase } = require('@/lib/supabase/client');
    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    userEvent.click(screen.getByText('do-login-bad'));

    // Wait a short moment to ensure async validation completes
    await new Promise((r) => setTimeout(r, 50));

    expect(supabase.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(screen.getByText('logged:no')).toBeInTheDocument();
  });

  test('supabase auth error returns failure and keeps logged out', async () => {
    const { supabase } = require('@/lib/supabase/client');
    supabase.auth.signInWithPassword.mockResolvedValue({ data: null, error: { message: 'invalid credentials' } });

    render(
      <LoginProvider>
        <TestConsumer />
      </LoginProvider>
    );

    userEvent.click(screen.getByText('do-login'));

    await waitFor(() => expect(screen.getByText('logged:no')).toBeInTheDocument());
  });
});
