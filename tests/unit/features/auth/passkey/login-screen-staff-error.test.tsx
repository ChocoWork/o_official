/**
 * DD-AUTH-083 /login が、問い合わせの `error` のうち `staff_passkey_required` だけを固定の文にして出す（他の値は出さない）。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
jest.mock('next/navigation', () => ({ redirect: jest.fn(), useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ loginWithGoogle: jest.fn(), refreshAuthState: jest.fn() }),
}));
jest.mock('@/lib/supabase/client', () => ({ supabase: { auth: { passkey: {} } } }));
jest.mock('next/script', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/useTurnstileWidget', () => ({
  useTurnstileWidget: () => ({ containerRef: () => undefined, renderWidget: jest.fn(), resetWidget: jest.fn() }),
}));
jest.mock('@/features/auth/passkey/components/EmailCodeStartForm', () => ({ __esModule: true, default: () => null }));

import LoginPage from '@/app/login/page';
import LoginChoices from '@/features/auth/passkey/components/LoginChoices';

const STAFF_MESSAGE = '店員の方は、パスキーでログインしてください。';

async function pageProps(query: Record<string, string | string[] | undefined>) {
  const element = (await LoginPage({ searchParams: Promise.resolve(query) })) as React.ReactElement<{
    errorMessage?: string;
  }>;
  return element.props;
}

describe('DD-AUTH-083 ログイン画面の error の文', () => {
  test('DD-AUTH-083 error=staff_passkey_required なら固定の文を渡す', async () => {
    expect((await pageProps({ error: 'staff_passkey_required' })).errorMessage).toBe(STAFF_MESSAGE);
  });

  test.each([['access_denied'], ['<script>alert(1)</script>'], [''], ['staff_passkey_required2']])(
    'DD-AUTH-083 他の error の値（%s）は出さない',
    async (value) => {
      expect((await pageProps({ error: value })).errorMessage).toBeUndefined();
    },
  );

  test('DD-AUTH-083 error が配列でも出さない', async () => {
    expect((await pageProps({ error: ['staff_passkey_required', 'x'] })).errorMessage).toBeUndefined();
  });
});

describe('DD-AUTH-083 LoginChoices の errorMessage', () => {
  test('DD-AUTH-083 errorMessage を画面に出し、渡さなければ出さない', () => {
    const { unmount } = render(<LoginChoices errorMessage={STAFF_MESSAGE} />);
    expect(screen.getByText(STAFF_MESSAGE)).toBeTruthy();
    unmount();
    render(<LoginChoices />);
    expect(screen.queryByText(STAFF_MESSAGE)).toBeNull();
  });
});
