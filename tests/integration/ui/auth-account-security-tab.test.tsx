/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-065 アカウントの画面: 「ログイン方法」のタブ（お客さんだけ）と、「パスワードを変更」のリンクが無いこと
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import AccountPage from '@/app/account/page';

let mockTab: string | null = null;
let mockRole = 'user';
const mockReplace = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => '/account',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ''),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true, logout: jest.fn(), userRole: mockRole }),
}));
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));
jest.mock('@/components/AccountInquiries', () => ({ __esModule: true, default: () => <div>inquiries</div> }));
jest.mock('@/features/auth/passkey/components/AccountPasskeys', () => ({
  __esModule: true,
  default: () => <div data-testid="account-passkeys" />,
}));

describe('アカウントの画面のタブ', () => {
  beforeEach(() => {
    mockTab = null;
    mockRole = 'user';
    mockReplace.mockClear();
  });

  test('SCR-AUTH-012 お客さんには「ログイン方法」が4つの隣（最後）に出る（PC 用と mobile 用の2か所）', async () => {
    render(<AccountPage />);
    await waitFor(() => expect(screen.getAllByText('ログイン方法')).toHaveLength(2));
    const labels = screen.getAllByText('ログイン方法').map((el) => el.parentElement?.textContent ?? '');
    expect(labels.length).toBe(2);
    for (const tab of screen.getAllByText('ログイン方法')) {
      const siblings = Array.from(tab.closest('[data-ui-tab-segment]')!.querySelectorAll('[data-ui-tab-item]')).map((n) => n.textContent);
      expect(siblings).toEqual(['お客様情報', '配送情報', '購入履歴', 'お問い合わせ', 'ログイン方法']);
    }
  });

  test('SCR-AUTH-012 tab=security で開くとパスキーの部品が出る', async () => {
    mockTab = 'security';
    render(<AccountPage />);
    expect(await screen.findByTestId('account-passkeys')).toBeInTheDocument();
  });

  test('SCR-AUTH-012 店員（admin・supporter）には「ログイン方法」を出さず、tab=security はお客様情報へ戻す', async () => {
    for (const role of ['admin', 'supporter']) {
      mockRole = role;
      mockTab = 'security';
      mockReplace.mockClear();
      const view = render(<AccountPage />);
      expect(screen.queryByText('ログイン方法')).not.toBeInTheDocument();
      expect(screen.queryByTestId('account-passkeys')).not.toBeInTheDocument();
      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/account?tab=profile', { scroll: false }));
      view.unmount();
    }
  });

  test('SCR-AUTH-012 お客様情報に「パスワードを変更」のリンクが無い', async () => {
    render(<AccountPage />);
    await waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull());
    expect(screen.queryByText('パスワードを変更')).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/account/password"]')).toBeNull();
  });
});
