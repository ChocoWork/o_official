/**
 * ホーム `/` の ITEM・LOOK・NEWS の区画の件数と VIEW ALL のボタン（SCR-HOME-004）を、
 * ページ本体 `Home` と各領域の実物の格子の部品で確かめる結合テスト。取得の関数だけ差し替える。
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import Home from '@/app/page';
import { getPublishedItems, getPublishedItemsCount } from '@/lib/items/public';
import { getPublishedLooks, getPublishedLooksCount } from '@/lib/look/server';
import { getPublishedNews, getPublishedNewsCount } from '@/features/news/services/public';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const forwarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      const isDomSafe =
        ['src', 'alt', 'width', 'height', 'className', 'style', 'id', 'title'].includes(key) ||
        key.startsWith('data-') ||
        key.startsWith('aria-');
      if (isDomSafe) forwarded[key] = value;
    }
    return React.createElement('img', forwarded);
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
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

jest.mock('@/lib/items/public', () => ({
  getPublishedItems: jest.fn(),
  getPublishedItemsCount: jest.fn(),
}));
jest.mock('@/lib/look/server', () => ({
  getPublishedLooks: jest.fn(),
  getPublishedLooksCount: jest.fn(),
}));
jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(),
  getPublishedNewsCount: jest.fn(),
}));
jest.mock('@/features/stockist/services/public', () => ({
  getHomePublicStockists: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => <div data-testid="stub-stockist-grid" />,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({
  SearchHomePreview: () => null,
}));

const mockedGetItems = getPublishedItems as jest.Mock;
const mockedGetItemsCount = getPublishedItemsCount as jest.Mock;
const mockedGetLooks = getPublishedLooks as jest.Mock;
const mockedGetLooksCount = getPublishedLooksCount as jest.Mock;
const mockedGetNews = getPublishedNews as jest.Mock;
const mockedGetNewsCount = getPublishedNewsCount as jest.Mock;

function makeItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `Item ${index + 1}`,
    description: 'desc',
    price: 1000,
    image_url: '/img.png',
    category: 'TOPS',
    colors: [],
    stock_quantity: 5,
  }));
}

function makeLooks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    seasonYear: 2026,
    seasonType: 'SS',
    theme: `Theme ${index + 1}`,
    themeDescription: `Theme description ${index + 1}`,
    imageUrls: ['/placeholder.png'],
    createdAt: '2026-09-01T00:00:00.000Z',
    linkedItems: [],
  }));
}

function makeNews(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    title: `Article ${index + 1}`,
    published_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    category: 'EVENT',
    content: `summary ${index + 1}`,
  }));
}

function setPublished(counts: { items: number; looks: number; news: number; itemTotal?: number; lookTotal?: number; newsTotal?: number }) {
  mockedGetItems.mockResolvedValue(makeItems(counts.items));
  mockedGetLooks.mockResolvedValue(makeLooks(counts.looks));
  mockedGetNews.mockResolvedValue(makeNews(counts.news));
  mockedGetItemsCount.mockResolvedValue(counts.itemTotal ?? counts.items);
  mockedGetLooksCount.mockResolvedValue(counts.lookTotal ?? counts.looks);
  mockedGetNewsCount.mockResolvedValue(counts.newsTotal ?? counts.news);
}

async function renderHome(): Promise<void> {
  render(await Home());
}

function viewAllWrapper(name: string): HTMLElement {
  const wrapper = screen.getByRole('link', { name }).parentElement;
  if (!wrapper) {
    throw new Error(`${name} wrapper not found`);
  }
  return wrapper;
}

describe('ホームの ITEM・LOOK・NEWS の件数と VIEW ALL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    setPublished({ items: 10, looks: 8, news: 6, itemTotal: 30, lookTotal: 30, newsTotal: 30 });
  });

  it('SCR-HOME-004 ITEM は8件、LOOK は8件、NEWS は6件を取り、総数は別の数え方で取る', async () => {
    await renderHome();

    expect(mockedGetItems).toHaveBeenCalledWith(8);
    expect(mockedGetLooks).toHaveBeenCalledWith(8);
    expect(mockedGetNews).toHaveBeenCalledWith({ limit: 6 });
    expect(mockedGetItemsCount).toHaveBeenCalledTimes(1);
    expect(mockedGetLooksCount).toHaveBeenCalledTimes(1);
    expect(mockedGetNewsCount).toHaveBeenCalledTimes(1);
  });

  it('SCR-HOME-004 ITEM は10件取っても8件までを描き、7件目以降は 2xl 以上でだけ見せる', async () => {
    await renderHome();

    const section = document.querySelector('section#items') as HTMLElement;
    const cards = within(section).getAllByTestId('item-card-link');
    expect(cards).toHaveLength(8);
    for (const card of cards.slice(0, 6)) {
      expect(card.className).not.toMatch(/hidden/);
    }
    for (const card of cards.slice(6)) {
      expect(card).toHaveClass('hidden', '2xl:block');
    }
  });

  it('SCR-HOME-004 LOOK は8件を描き、7件目以降は 2xl 以上でだけ見せる', async () => {
    await renderHome();

    const section = document.querySelector('section#look') as HTMLElement;
    const cards = within(section).getAllByTestId('look-card');
    expect(cards).toHaveLength(8);
    for (const card of cards.slice(0, 6)) {
      expect(card.className).not.toMatch(/hidden/);
    }
    for (const card of cards.slice(6)) {
      expect(card).toHaveClass('hidden', '2xl:block');
    }
  });

  it('SCR-HOME-004 NEWS は6件を全部の幅で描く', async () => {
    await renderHome();

    const section = document.querySelector('section#news') as HTMLElement;
    expect(within(section).getAllByRole('heading', { level: 3 })).toHaveLength(6);
  });

  it('SCR-HOME-004 同じ VIEW ALL の文字が3つ並ぶので、行き先ごとの名前を付け、行き先を /item・/look・/news にする', async () => {
    await renderHome();

    const buttons = screen.getAllByTestId('home-section-view-all');
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.textContent)).toEqual(['VIEW ALL', 'VIEW ALL', 'VIEW ALL']);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'VIEW ALL ITEMS',
      'VIEW ALL LOOKS',
      'VIEW ALL NEWS',
    ]);
    expect(screen.getByRole('link', { name: 'VIEW ALL ITEMS' })).toHaveAttribute('href', '/item');
    expect(screen.getByRole('link', { name: 'VIEW ALL LOOKS' })).toHaveAttribute('href', '/look');
    expect(screen.getByRole('link', { name: 'VIEW ALL NEWS' })).toHaveAttribute('href', '/news');
  });

  it.each(['VIEW ALL ITEMS', 'VIEW ALL LOOKS'])('SCR-HOME-004 %s は総数が6件以下なら全部の幅で隠し、DOM には残す', async (name) => {
    setPublished({ items: 6, looks: 6, news: 1, itemTotal: 6, lookTotal: 6 });
    await renderHome();

    const wrapper = viewAllWrapper(name);
    expect(wrapper).toHaveClass('hidden', '2xl:hidden');
    expect(wrapper).not.toHaveClass('flex');
  });

  it.each([
    ['VIEW ALL ITEMS', 7],
    ['VIEW ALL ITEMS', 8],
    ['VIEW ALL LOOKS', 7],
    ['VIEW ALL LOOKS', 8],
  ])('SCR-HOME-004 %s は総数が%i件なら 2xl 未満でだけ出し、8件を全部見せる 2xl 以上では隠す', async (name, total) => {
    setPublished({ items: 8, looks: 8, news: 1, itemTotal: total, lookTotal: total });
    await renderHome();

    const wrapper = viewAllWrapper(name);
    expect(wrapper).toHaveClass('flex', '2xl:hidden');
    expect(wrapper).not.toHaveClass('hidden');
  });

  it.each(['VIEW ALL ITEMS', 'VIEW ALL LOOKS'])(
    'SCR-HOME-004 %s は総数が9件以上なら全部の幅で出す',
    async (name) => {
      setPublished({ items: 8, looks: 8, news: 1, itemTotal: 9, lookTotal: 9 });
      await renderHome();

      const wrapper = viewAllWrapper(name);
      expect(wrapper).toHaveClass('flex', '2xl:flex');
      expect(wrapper).not.toHaveClass('hidden');
      expect(wrapper).not.toHaveClass('2xl:hidden');
    },
  );

  it.each([
    [6, '隠す', false],
    [7, '出す', true],
  ])('SCR-HOME-004 NEWS の総数が%i件なら VIEW ALL を%s', async (total, _label, visible) => {
    setPublished({ items: 1, looks: 1, news: 6, newsTotal: total });
    await renderHome();

    const wrapper = viewAllWrapper('VIEW ALL NEWS');
    expect(wrapper.classList.contains('hidden')).toBe(!visible);
  });

  it('SCR-HOME-004 公開の物が0件の区画も消さず、案内の文を出して VIEW ALL は隠したまま残す', async () => {
    setPublished({ items: 0, looks: 0, news: 0 });
    await renderHome();

    expect(screen.getByText('公開中のITEMがありません')).toBeInTheDocument();
    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'ITEMS' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'LOOK' })).toBeInTheDocument();
    expect(viewAllWrapper('VIEW ALL ITEMS')).toHaveClass('hidden', '2xl:hidden');
    expect(viewAllWrapper('VIEW ALL LOOKS')).toHaveClass('hidden', '2xl:hidden');
  });
});
