/**
 * PRIVACY の画面遷移（FLOW-PRIVACY-001）を確かめる結合テスト。
 * 入口（全頁のフッターの Privacy Policy）が `/privacy` を指し、`/privacy` の12節が `/contact` だけへ移ることを、
 * 実物の Footer と `PrivacyPage` を描いて見る。設定を読めない時は、窓口の節まで届かないことも見る。
 * 設定の読み出しは実物を使い、その下の RPC を持つ client と next/server の connection、next/link だけを差し替える。
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} data-next-link="true" {...props}>
      {children}
    </a>
  ),
}));

const mockRpc = jest.fn();
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));

import PrivacyPage from '@/app/privacy/page';
import Footer from '@/components/Footer';

function okSettings(enabled = false) {
  return {
    data: [{ enabled, updated_at: null, updated_by_email: null, backfill_count: 0 }],
    error: null,
  };
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRpc.mockResolvedValue(okSettings());
  mockCreateServiceRoleClient.mockReset();
  mockCreateServiceRoleClient.mockResolvedValue({ rpc: (...args: unknown[]) => mockRpc(...args) });
});

describe('PRIVACY の画面遷移', () => {
  it('FLOW-PRIVACY-001 フッターの Privacy Policy は /privacy を指すリンクで、別のタブでは開かない', () => {
    render(<Footer />);

    const link = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(link).toHaveAttribute('href', '/privacy');
    expect(link).not.toHaveAttribute('target');
    expect(screen.getAllByRole('link', { name: 'Privacy Policy' })).toHaveLength(1);
  });

  it('FLOW-PRIVACY-001 フッターのリンクは next/link でなく a 要素の素の href（頁をまるごと読み直す）', () => {
    render(<Footer />);

    const link = screen.getByRole('link', { name: 'Privacy Policy' });
    expect(link.tagName).toBe('A');
    expect(link).not.toHaveAttribute('data-next-link');
    expect(link).toHaveClass('footer-legal-link');
  });

  it('FLOW-PRIVACY-001 12節の「お問い合わせフォーム」は /contact へ移るリンクで、別のタブでは開かない', async () => {
    render(await PrivacyPage());

    const section = screen.getByRole('heading', { level: 2, name: '12. お問い合わせ窓口' }).closest('section') as HTMLElement;
    const link = within(section).getByRole('link', { name: 'お問い合わせフォーム' });
    expect(link).toHaveAttribute('href', '/contact');
    expect(link).not.toHaveAttribute('target');
  });

  it('FLOW-PRIVACY-001 頁のリンクは /contact の1つだけで、外のサイトとメールの宛先へのリンクは無い', async () => {
    const { container } = render(await PrivacyPage());

    const hrefs = within(container).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/contact']);
    expect(container.querySelector('a[href^="http"]')).toBeNull();
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('FLOW-PRIVACY-001 追跡がオンでも出口は変わらず、/contact へのリンクだけが残る', async () => {
    mockRpc.mockResolvedValue(okSettings(true));
    const { container } = render(await PrivacyPage());

    expect(within(container).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/contact']);
  });

  it('FLOW-PRIVACY-001 設定を読めない時は頁を描かず、窓口の節にも届かない', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom', code: 'XX000' } });

    await expect(PrivacyPage()).rejects.toThrow(/get_delivery_tracking_settings/);
  });
});
