import React from 'react';
import { render, screen } from '@testing-library/react';
import LoginPasskeyPage, { metadata } from '@/app/login/passkey/page';

jest.mock('@/features/auth/passkey/components/PasskeyOffer', () => ({
  __esModule: true,
  default: () => <div data-testid="passkey-offer" />,
}));

describe('/login/passkey page', () => {
  test('DD-AUTH-064 勧めの部品を描く', () => {
    render(<LoginPasskeyPage />);
    expect(screen.getByTestId('passkey-offer')).toBeInTheDocument();
  });

  test('DD-AUTH-064 検索に載せない', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
