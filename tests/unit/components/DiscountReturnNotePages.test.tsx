import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));

import LegalPage from '@/app/legal/page';
import TermsPage from '@/app/terms/page';

const NOTE = /お手元に残る商品の割引後の価格を差し引いて返金いたします/;

test.each([
  ['/legal', () => <LegalPage />],
  ['/terms', () => <TermsPage />],
])('FREQ-642-AC-22: %s に割引の扱いの文が出る', (_place, page) => {
  render(page());
  expect(screen.getByText(NOTE)).toBeInTheDocument();
  expect(screen.getByText(/返金額がマイナスになることはありません/)).toBeInTheDocument();
});

test('FREQ-642-AC-22: /legal の初期不良・誤送の文は交換（在庫が無ければ再制作）とお送りできない時だけの返金に合わせてある', () => {
  render(<LegalPage />);
  expect(screen.getByText(/交換（在庫が無ければ再制作）を承ります。お送りできない場合に限り、返金いたします。いずれの場合も、該当商品を当店までご返送いただく必要がございます。/)).toBeInTheDocument();
  expect(screen.queryByText(/返品・交換・修理を承ります/)).not.toBeInTheDocument();
});

test('FREQ-642-AC-22: /terms 第6条の初期不良・誤送の文は交換（在庫が無ければ再制作）とお送りできない時だけの返金に合わせてある', () => {
  render(<TermsPage />);
  expect(screen.getByText(/交換（在庫が無ければ再制作）の対応をいたします。お送りできない場合に限り、返金いたします。/)).toBeInTheDocument();
  expect(screen.queryByText(/返品・交換または再制作の対応をいたします/)).not.toBeInTheDocument();
});
