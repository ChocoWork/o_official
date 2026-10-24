/**
 * PRIVACY `/privacy` の画面（SCR-PRIVACY-001）を、頁本体 `PrivacyPage` と `generateMetadata` を実際に描いて確かめる結合テスト。
 * 設定の読み出し（`getDeliveryTrackingSettings`）は実物を使い、その下の RPC を持つ client だけを差し替える。
 * next/server の `connection` と next/link だけを差し替える。
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
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}));

import PrivacyPage, { generateMetadata } from '@/app/privacy/page';

function settingsRow(enabled: boolean) {
  return {
    data: [{ enabled, updated_at: null, updated_by_email: null, backfill_count: 0 }],
    error: null,
  };
}

async function renderPage(enabled = false) {
  mockRpc.mockResolvedValue(settingsRow(enabled));
  const element = await PrivacyPage();
  return render(element);
}

/** 見出しを含む `section` を返す */
function sectionOf(heading: HTMLElement): HTMLElement {
  const section = heading.closest('section');
  if (!section) throw new Error('section が見つからない');
  return section;
}

const H2_TITLES = [
  '個人情報の取り扱いについて',
  '1. 個人情報の定義',
  '2. 個人情報の収集方法',
  '3. 個人情報の利用目的',
  '4. 個人情報の第三者提供',
  '5. 個人情報の取扱いの委託',
  '6. 個人情報の保有期間',
  '7. 個人情報の国外移転',
  '8. 個人情報の安全管理',
  '9. Cookie 及び外部サービスの利用',
  '10. 保有個人データの開示・訂正・利用停止等の請求',
  '11. 本ポリシーの変更',
  '12. お問い合わせ窓口',
];

beforeEach(() => {
  mockRpc.mockReset();
});

describe('PRIVACY の画面（SCR-PRIVACY-001）', () => {
  it('SCR-PRIVACY-001 h1 は「Privacy Policy / 個人情報の取り扱いについて」の1つだけ', async () => {
    await renderPage();

    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent('Privacy Policy / 個人情報の取り扱いについて');
  });

  it('SCR-PRIVACY-001 h2 は前置きと 1〜12 の節の13個で、この順に並ぶ', async () => {
    await renderPage();

    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.replace(/\s+/g, ' ').trim());
    expect(titles).toEqual(H2_TITLES);
  });

  it('SCR-PRIVACY-001 h2 を持つ section は13個と、日付だけの section が末尾に1つ。目次と節の id は無い', async () => {
    const { container } = await renderPage();

    const sections = Array.from(container.querySelectorAll('section'));
    expect(sections).toHaveLength(14);
    expect(sections.slice(0, 13).every((s) => s.querySelector('h2'))).toBe(true);
    expect(sections[13].querySelector('h2')).toBeNull();
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelectorAll('[id]')).toHaveLength(0);
  });

  it('SCR-PRIVACY-001 作りは max-w-3xl の1列で、節の間隔は space-y-8', async () => {
    const { container } = await renderPage();

    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass('max-w-3xl', 'mx-auto');
    const stack = root.querySelector('section')?.parentElement as HTMLElement;
    expect(stack).toHaveClass('space-y-8');
  });

  it('SCR-PRIVACY-001 字の大きさは、頁の見出し 5xl・節の見出し md（font-brand）・本文 xs で行間 1.9・日付 2xs', async () => {
    const { container } = await renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toHaveStyle({ fontSize: 'var(--lk-size-5xl)' });
    const h2 = screen.getByRole('heading', { level: 2, name: '1. 個人情報の定義' });
    expect(h2).toHaveStyle({ fontSize: 'var(--lk-size-md)' });
    expect(h2).toHaveClass('font-brand');
    const body = sectionOf(h2).querySelector('p') as HTMLElement;
    expect(body).toHaveStyle({ fontSize: 'var(--lk-size-xs)', lineHeight: '1.9' });
    const date = Array.from(container.querySelectorAll('section')).pop()?.querySelector('p') as HTMLElement;
    expect(date).toHaveStyle({ fontSize: 'var(--lk-size-2xs)', lineHeight: '1.9' });
  });

  it('SCR-PRIVACY-001 末尾に制定日 2026年6月20日 と最終改定日 2026年7月11日 を固定の字で出す。追跡がオンでも変わらない', async () => {
    for (const enabled of [false, true]) {
      const { container, unmount } = await renderPage(enabled);
      const last = Array.from(container.querySelectorAll('section')).pop() as HTMLElement;
      expect(last).toHaveTextContent('制定日：2026年6月20日');
      expect(last).toHaveTextContent('最終改定日：2026年7月11日');
      unmount();
    }
  });

  it('SCR-PRIVACY-001 12節の窓口は事業者名とメールの字を一覧で出し、mailto のリンクにはしない', async () => {
    const { container } = await renderPage();

    const section = sectionOf(screen.getByRole('heading', { level: 2, name: '12. お問い合わせ窓口' }));
    const items = within(section).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['事業者名：Le Fil des Heures', 'お問い合わせ先：privacy@lefildesheures.com']);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('SCR-PRIVACY-001 10節は、ご本人であることを確認した上で応えると書く', async () => {
    await renderPage();

    const section = sectionOf(screen.getByRole('heading', { level: 2, name: /^10\./ }));
    expect(section).toHaveTextContent('ご本人であることを確認させていただいた上で');
    expect(section).toHaveTextContent('下記のお問い合わせ窓口までご連絡ください');
  });

  it('SCR-PRIVACY-001 9節は外部サービスとして Stripe を挙げる', async () => {
    await renderPage(true);

    const section = sectionOf(screen.getByRole('heading', { level: 2, name: /^9\./ }));
    expect(section).toHaveTextContent('Stripe, Inc.');
  });

  it('SCR-PRIVACY-001 メタデータは title・description・og:title・og:description・og:image を固定の字で返す', async () => {
    const metadata = await generateMetadata();

    const description =
      'Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。';
    expect(metadata.title).toBe('Privacy Policy | Le Fil des Heures');
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph).toMatchObject({
      title: 'Privacy Policy | Le Fil des Heures',
      description,
      images: ['/mainphoto.png'],
    });
  });

  it('SCR-PRIVACY-001 メタデータは設定を読まない（DB を呼ばずに返る）', async () => {
    await generateMetadata();

    expect(mockRpc).not.toHaveBeenCalled();
  });
});
