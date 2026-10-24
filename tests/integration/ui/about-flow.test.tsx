/**
 * ABOUT の画面遷移（FLOW-ABOUT-001）を確かめる結合テスト。
 * 入口（ヘッダーのナビ・フッター・ホームの ABOUT の区画）が `/about` を指し、
 * `/about` の締めの CTA が商品 `/item` と LOOK `/look` だけを指すことを、実物の部品を描いて見る。
 * 取得の関数と範囲外の格子の部品、ログイン・カートの文脈だけを差し替える。
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';
import StoryPage from '@/app/about/page';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { src, alt, className, sizes, fill } = props;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src as string}
        alt={alt as string}
        className={className as string}
        sizes={sizes as string}
        data-fill={fill ? 'true' : 'false'}
      />
    );
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: false, userRole: null }),
}));
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ cartCount: 0 }),
}));
jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/lib/items/public', () => ({
  getPublishedItems: jest.fn().mockResolvedValue([]),
  getPublishedItemsCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn().mockResolvedValue([]),
  getPublishedLooksCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn().mockResolvedValue([]),
  getPublishedNewsCount: jest.fn().mockResolvedValue(0),
}));
jest.mock('@/features/stockist/services/public', () => ({
  getHomePublicStockists: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/features/items/components/PublicItemGrid', () => ({
  PublicItemGrid: () => <div data-testid="stub-item-grid" />,
}));
jest.mock('@/features/look/components/PublicLookGrid', () => ({
  PublicLookGrid: () => <div data-testid="stub-look-grid" />,
}));
jest.mock('@/features/news/components/PublicNewsGrid', () => ({
  PublicNewsGrid: () => <div data-testid="stub-news-grid" />,
}));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => <div data-testid="stub-stockist-grid" />,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({
  SearchHomePreview: () => null,
}));

/** 締めの CTA を含む `/about` の最後の区画（見出しなしの一文と2つのボタン） */
function renderClosingBlock(): { block: HTMLElement; links: HTMLAnchorElement[] } {
  const { container } = render(<StoryPage />);
  const tagline = screen.getByText('時を超えて価値の続く服を。');
  const block = tagline.parentElement;
  if (!block || !container.contains(block)) {
    throw new Error('closing block not found');
  }
  return { block, links: within(block).getAllByRole('link') as HTMLAnchorElement[] };
}

describe('ABOUT の画面遷移', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
  });

  it('FLOW-ABOUT-001 ヘッダーのナビの ABOUT は /about へ移るリンクで、別のタブでは開かない', () => {
    render(<Header />);

    const nav = screen.getAllByRole('navigation')[0];
    const about = within(nav).getByRole('link', { name: 'ABOUT' });
    expect(about).toHaveAttribute('href', '/about');
    expect(about).not.toHaveAttribute('target');
  });

  it('FLOW-ABOUT-001 ヘッダーのナビの ABOUT は1つだけで、/about 以外のリンクを ABOUT の名で持たない', () => {
    render(<Header />);

    const aboutLinks = screen
      .getAllByRole('link')
      .filter((link) => link.textContent?.trim() === 'ABOUT');
    expect(aboutLinks).toHaveLength(1);
    expect(aboutLinks.map((link) => link.getAttribute('href'))).toEqual(['/about']);
  });

  it('FLOW-ABOUT-001 フッターの INFORMATION の ABOUT は /about へ移るリンクで、別のタブでは開かない', () => {
    render(<Footer />);

    const heading = screen.getByRole('heading', { name: 'INFORMATION' });
    const list = heading.parentElement as HTMLElement;
    const about = within(list).getByRole('link', { name: 'ABOUT' });
    expect(about).toHaveAttribute('href', '/about');
    expect(about).not.toHaveAttribute('target');
    expect(screen.getAllByRole('link', { name: 'ABOUT' })).toHaveLength(1);
  });

  it('FLOW-ABOUT-001 ホームの ABOUT の区画のボタン READ OUR STORY は /about へ移る', async () => {
    const ui = await Home();
    const { container } = render(ui);

    const section = container.querySelector<HTMLElement>('section#about');
    expect(section).not.toBeNull();
    const story = within(section as HTMLElement).getByRole('link', { name: 'READ OUR STORY' });
    expect(story).toHaveAttribute('href', '/about');
    expect(story).not.toHaveAttribute('target');
    expect(story).toHaveAttribute('data-ui-button-variant', 'secondary');
  });

  it('FLOW-ABOUT-001 ホームで /about へ移るリンクは ABOUT の区画のボタンだけ（商品・LOOK・NEWS・取扱店の格子は差し替え済みで、その中は見ない）', async () => {
    const ui = await Home();
    const { container } = render(ui);

    const toAbout = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href="/about"]'));
    expect(toAbout).toHaveLength(1);
    expect(toAbout[0].closest('section#about')).not.toBeNull();
  });

  it('FLOW-ABOUT-001 締めの CTA は VIEW COLLECTION で /item へ、VIEW LOOKBOOK で /look へ、この順に移る', () => {
    const { links } = renderClosingBlock();

    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['VIEW COLLECTION', '/item'],
      ['VIEW LOOKBOOK', '/look'],
    ]);
    for (const link of links) {
      expect(link).not.toHaveAttribute('target');
    }
  });

  it('FLOW-ABOUT-001 出口は商品と LOOK の2つだけで、CONTACT と NEWS へ移る CTA を置かない', () => {
    const { block, links } = renderClosingBlock();

    expect(links).toHaveLength(2);
    expect(within(block).queryByRole('link', { name: /CONTACT/i })).toBeNull();
    expect(within(block).queryByRole('link', { name: /NEWS/i })).toBeNull();
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/contact');
    expect(hrefs).not.toContain('/news');
  });

  it('FLOW-ABOUT-001 締めの一文はボタンより前に出て、ボタンは640px 未満で縦・幅いっぱい、640px 以上で横・最小幅付きに並ぶ', () => {
    const { block, links } = renderClosingBlock();

    const tagline = screen.getByText('時を超えて価値の続く服を。');
    expect(tagline.compareDocumentPosition(links[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = links[0].parentElement as HTMLElement;
    expect(block).toContainElement(row);
    expect(row).toHaveClass('flex', 'flex-col', 'sm:flex-row');
    for (const link of links) {
      expect(link).toHaveClass('w-full', 'sm:w-auto', 'sm:min-w-65');
    }
  });

  it('FLOW-ABOUT-001 3つの入口は同じ /about を指し、その道の page ファイルの既定の書き出しは出口の CTA を持つ StoryPage', async () => {
    const header = render(<Header />);
    const headerHref = within(screen.getAllByRole('navigation')[0])
      .getByRole('link', { name: 'ABOUT' })
      .getAttribute('href');
    header.unmount();
    const footer = render(<Footer />);
    const footerHref = screen.getByRole('link', { name: 'ABOUT' }).getAttribute('href');
    footer.unmount();
    const homeUi = await Home();
    const home = render(homeUi);
    const homeHref = screen.getByRole('link', { name: 'READ OUR STORY' }).getAttribute('href');
    home.unmount();

    expect(new Set([headerHref, footerHref, homeHref])).toEqual(new Set(['/about']));
    render(<StoryPage />);
    expect(screen.getByRole('link', { name: 'VIEW COLLECTION' })).toHaveAttribute('href', '/item');
    expect(screen.getByRole('link', { name: 'VIEW LOOKBOOK' })).toHaveAttribute('href', '/look');
  });
});
