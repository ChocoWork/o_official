// /privacy の誤りの画面（DD-PRIVACY-002）の単体テスト。案内と窓口だけを出し、方針の本文・誤りの文は出さない。

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));

import PrivacyError from '@/app/privacy/error';

const SECRET = 'get_delivery_tracking_settings permission denied 42501';

function renderError(retry = jest.fn(), digest = 'digest-1') {
  const error = Object.assign(new Error(SECRET), { digest });
  const view = render(<PrivacyError error={error} retry={retry} />);
  return { ...view, retry, error };
}

describe('PrivacyError', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('DD-PRIVACY-002 時間を置いてもう一度試す案内を出す', () => {
    const { container } = renderError();

    expect(container.textContent).toContain('時間を置いて');
    expect(container.textContent).toContain('もう一度');
  });

  test('DD-PRIVACY-002 窓口のメールの字と /contact へのお問い合わせフォームのリンクを出す', () => {
    const { container } = renderError();

    expect(container.textContent).toContain('privacy@lefildesheures.com');
    expect(screen.getByRole('link', { name: 'お問い合わせフォーム' }).getAttribute('href')).toBe('/contact');
  });

  test('DD-PRIVACY-002 h1 は Privacy Policy を含まない', () => {
    renderError();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('プライバシーポリシーを表示できません');
    expect(heading.textContent).not.toContain('Privacy Policy');
  });

  test('DD-PRIVACY-002 誤りの文・17TRACK・委託の一覧を画面に出さない', () => {
    const { container } = renderError();

    expect(container.textContent).not.toContain(SECRET);
    expect(container.textContent).not.toContain('42501');
    expect(container.textContent).not.toContain('17TRACK');
    expect(container.textContent).not.toContain('個人情報の取扱いの委託');
  });

  test('DD-PRIVACY-002 「もう一度表示する」で retry が 1 回呼ばれる', () => {
    const { retry } = renderError();

    fireEvent.click(screen.getByRole('button', { name: 'もう一度表示する' }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('DD-PRIVACY-002 記録は digest だけで、message・stack を持たない', () => {
    renderError(jest.fn(), 'digest-xyz');

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    expect(args).toEqual(['[privacy] render failed', { digest: 'digest-xyz' }]);
    expect(JSON.stringify(args)).not.toContain(SECRET);
    expect(JSON.stringify(args)).not.toContain('stack');
  });
});
