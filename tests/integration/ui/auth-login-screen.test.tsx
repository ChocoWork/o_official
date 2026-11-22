import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import LoginChoices from '@/features/auth/passkey/components/LoginChoices';
import { LoginProvider } from '@/contexts/LoginContext';

// 画面（LoginChoices）と LoginProvider は本物。差し替えるのは Next のルーター・スクリプト・Turnstile の描画・
// パスキーの端末の部品・ブラウザの通信だけ。ログインの画面 /login の入口の並び（SCR-AUTH-001）を確かめる。
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('next/script', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { signOut: jest.fn(), passkey: { startAuthentication: jest.fn() } } },
}));
jest.mock('@/hooks/useTurnstileWidget', () => ({
  useTurnstileWidget: () => ({ containerRef: () => undefined, renderWidget: jest.fn(), resetWidget: jest.fn() }),
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  isPasskeySupported: () => true,
  requestAssertion: jest.fn(),
}));
jest.mock('@/features/auth/passkey/post-login', () => ({ resolvePostLoginPath: jest.fn().mockResolvedValue('/') }));

describe('SCR-AUTH-001 /login の画面（3つの入口）', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function mount(props: React.ComponentProps<typeof LoginChoices> = {}) {
    render(
      <LoginProvider>
        <LoginChoices {...props} />
      </LoginProvider>,
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/auth/me', expect.anything()));
  }

  test('SCR-AUTH-001 パスキー・Google・メールのコードの3つの入口を並べる', async () => {
    await mount();

    expect(screen.getByRole('button', { name: 'パスキーでログイン' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Googleでサインイン/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'メールでコードを受け取る' })).toBeInTheDocument();
  });

  test('SCR-AUTH-001 パスワードの欄・会員登録のタブ・再設定のリンクを持たない（段4で消した）', async () => {
    await mount();

    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /パスワード/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="/login/password"], a[href*="/login/verify"]')).toBeNull();
  });

  test('SCR-AUTH-001 ?email の初めの値はメール欄に入り、案内の文は渡した物だけを出す', async () => {
    await mount({ initialEmail: 'hanako@example.com', notice: 'しばらく操作がなかったため、ログアウトしました。もう一度ログインしてください。' });

    expect(screen.getByLabelText('Email')).toHaveValue('hanako@example.com');
    expect(screen.getByText('しばらく操作がなかったため、ログアウトしました。もう一度ログインしてください。')).toBeInTheDocument();
  });
});
