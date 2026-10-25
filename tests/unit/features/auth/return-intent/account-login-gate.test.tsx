/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-036 会員だけの頁の 3 つのログインの門は、今いる頁を next に載せた /login へ送る。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import AccountPage from '@/app/account/page';
import AccountOrderDetailPage from '@/app/account/orders/[id]/page';
import ReturnRequestPage from '@/app/account/orders/[id]/return/page';

let mockPathname = '/account';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'order-1' }),
}));

jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: false, isAuthResolved: true, logout: jest.fn() }),
}));

jest.mock('@/features/account/hooks/useReorder', () => ({
  useReorder: () => ({ reorderingItemId: null, reorder: jest.fn() }),
}));

describe('DD-AUTH-036 会員だけの頁のログインの門', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  it('DD-AUTH-036 /account の門のログインは /login?next=%2Faccount', () => {
    mockPathname = '/account';

    render(<AccountPage />);

    expect(screen.getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', '/login?next=%2Faccount');
  });

  it('DD-AUTH-036 注文の詳細の門のログインは /login?next=%2Faccount%2Forders%2F<id>', () => {
    mockPathname = '/account/orders/order-1';

    render(<AccountOrderDetailPage />);

    expect(screen.getByRole('link', { name: 'ログイン' })).toHaveAttribute(
      'href',
      '/login?next=%2Faccount%2Forders%2Forder-1',
    );
  });

  it('DD-AUTH-036 返品の申し込みの門のログインは /login?next=%2Faccount%2Forders%2F<id>%2Freturn', () => {
    mockPathname = '/account/orders/order-1/return';

    render(<ReturnRequestPage />);

    expect(screen.getByRole('link', { name: 'ログイン' })).toHaveAttribute(
      'href',
      '/login?next=%2Faccount%2Forders%2Forder-1%2Freturn',
    );
  });
});
