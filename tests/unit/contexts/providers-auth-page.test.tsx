import React from 'react';
import { render, screen } from '@testing-library/react';
import { Providers } from '@/contexts/Providers';

const mockUsePathname = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));
jest.mock('@/contexts/CartContext', () => ({
  CartProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/contexts/CartLoginSync', () => ({ CartLoginSync: () => null }));
jest.mock('@/contexts/LoginContext', () => ({
  LoginProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/components/Header', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Footer', () => ({ __esModule: true, default: () => null }));
jest.mock('@/styles/detail-layout.css', () => ({}), { virtual: true });

function mainClassFor(pathname: string): string {
  mockUsePathname.mockReturnValue(pathname);
  render(
    <Providers>
      <p>本文</p>
    </Providers>,
  );
  return screen.getByRole('main').className;
}

describe('Providers の認証の画面の枠（isAuthPage）', () => {
  test.each([
    '/login',
    '/login/verify',
    '/login/password',
    '/login/code',
    '/login/passkey',
    '/auth/password-reset',
  ])('DD-AUTH-061 %s は真ん中寄せの枠になる', (pathname) => {
    expect(mainClassFor(pathname)).toContain('min-h-dvh');
  });

  test.each(['/', '/account', '/login/other', '/login/password/extra'])(
    'DD-AUTH-061 %s は真ん中寄せの枠にならない',
    (pathname) => {
      expect(mainClassFor(pathname)).not.toContain('min-h-dvh');
    },
  );
});
