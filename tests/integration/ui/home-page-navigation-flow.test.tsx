/**
 * ホームから各一覧・`/about`・検索の結果へ移る画面遷移（FLOW-HOME-001）を、
 * ページ本体 `Home` と実物の格子・検索の窓の部品で確かめる結合テスト。リンクを押した時の移り先を記録して比べる。
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Home from '@/app/page';
import type { SearchResult, SearchResultsResponse } from '@/features/search/types/search.types';
import { getPublishedItems, getPublishedItemsCount } from '@/lib/items/public';
import { getPublishedLooks, getPublishedLooksCount } from '@/lib/look/server';
import { getPublishedNews, getPublishedNewsCount } from '@/features/news/services/public';

const mockNavigate = jest.fn();
let mockSearch = '';

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

// リンクを押すと実際に移る代わりに、移り先を記録する（同じタブの中の移りだけを確かめる）
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        mockNavigate(href);
      }}
    >
      {children}
    </a>
  ),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
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

const SEARCH_WORD = 'ワンピース';

function searchResult(type: SearchResult['type'], id: string, href: string): SearchResult {
  return {
    id,
    type,
    title: `${type} ${id}`,
    description: `${type} ${id} の説明`,
    href,
    imageUrl: null,
    meta: type.toUpperCase(),
  };
}

function searchPayload(overrides: Partial<SearchResultsResponse> = {}): SearchResultsResponse {
  return {
    query: SEARCH_WORD,
    tab: 'all',
    items: [searchResult('item', '1', '/item/1'), searchResult('item', '2', '/item/2')],
    looks: [searchResult('look', '3', '/look/3')],
    news: [searchResult('news', '4', '/news/4')],
    counts: { all: 4, item: 2, look: 1, news: 1 },
    popularItems: [],
    empty: false,
    ...overrides,
  };
}

function setPublished(total: number): void {
  (getPublishedItems as jest.Mock).mockResolvedValue(
    Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      name: `Item ${index + 1}`,
      description: 'desc',
      price: 1000,
      image_url: '/img.png',
      category: 'TOPS',
      colors: [],
      stock_quantity: 5,
    })),
  );
  (getPublishedLooks as jest.Mock).mockResolvedValue(
    Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      seasonYear: 2026,
      seasonType: 'SS',
      theme: `Theme ${index + 1}`,
      themeDescription: `Theme description ${index + 1}`,
      imageUrls: ['/placeholder.png'],
      createdAt: '2026-09-01T00:00:00.000Z',
      linkedItems: [],
    })),
  );
  (getPublishedNews as jest.Mock).mockResolvedValue(
    Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      title: `Article ${index + 1}`,
      published_date: `2026-09-0${index + 1}`,
      category: 'EVENT',
      image_url: `news/${index + 1}.jpg`,
      content: `summary ${index + 1}`,
    })),
  );
  (getPublishedItemsCount as jest.Mock).mockResolvedValue(total);
  (getPublishedLooksCount as jest.Mock).mockResolvedValue(total);
  (getPublishedNewsCount as jest.Mock).mockResolvedValue(total);
}

async function renderHome(): Promise<void> {
  const ui = await Home();
  await act(async () => {
    render(ui);
  });
}

function mockSearchFetch(response: Response | Promise<Response>): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue(response);
  (global as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

function jsonResponse(payload: SearchResultsResponse): Response {
  return { ok: true, json: async () => payload } as unknown as Response;
}

describe('ホームから各一覧・/about・検索の結果への画面遷移', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearch = '';
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    setPublished(30);
    mockSearchFetch(jsonResponse(searchPayload()));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each([
    ['VIEW ALL ITEMS', '/item'],
    ['VIEW ALL LOOKS', '/look'],
    ['VIEW ALL NEWS', '/news'],
    ['READ OUR STORY', '/about'],
  ])('FLOW-HOME-001 ホームの %s のリンクを押すと %s へ移る', async (name, destination) => {
    await renderHome();

    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', destination);
    expect(link).not.toHaveAttribute('target');

    fireEvent.click(link);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(destination);
  });

  it('FLOW-HOME-001 総数が6件以下で VIEW ALL を隠す時も、READ OUR STORY の出口は残る', async () => {
    setPublished(5);
    await renderHome();

    for (const name of ['VIEW ALL ITEMS', 'VIEW ALL LOOKS', 'VIEW ALL NEWS']) {
      const wrapper = screen.getByRole('link', { name }).parentElement as HTMLElement;
      expect(wrapper).toHaveClass('hidden');
    }
    expect(screen.getByRole('link', { name: 'READ OUR STORY' })).toHaveAttribute('href', '/about');
  });

  it('FLOW-HOME-001 /?q=語 で開くと、語を符号化してプレビュー用に結果を取り、VIEW ALL RESULTS で /search?q=語 へ移る', async () => {
    mockSearch = `q=${encodeURIComponent(SEARCH_WORD)}`;
    const fetchMock = mockSearchFetch(jsonResponse(searchPayload()));
    await renderHome();

    const link = await screen.findByRole('link', { name: 'VIEW ALL RESULTS' });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/search?q=${encodeURIComponent(SEARCH_WORD)}&preview=true`,
      { cache: 'no-store' },
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Search Preview' })).toBeInTheDocument();
    expect(link).toHaveAttribute('href', `/search?q=${encodeURIComponent(SEARCH_WORD)}`);

    fireEvent.click(link);
    expect(mockNavigate).toHaveBeenCalledWith(`/search?q=${encodeURIComponent(SEARCH_WORD)}`);
  });

  it('FLOW-HOME-001 検索の窓の結果は ITEM・LOOK・NEWS の順に3件だけ並べ、押すと結果が返した詳細の住所へ移る', async () => {
    mockSearch = `q=${encodeURIComponent(SEARCH_WORD)}`;
    await renderHome();

    await screen.findByRole('link', { name: 'VIEW ALL RESULTS' });
    const cards = screen.getAllByRole('heading', { level: 3 }).filter((heading) => /^(item|look|news) \d$/.test(heading.textContent ?? ''));
    expect(cards.map((card) => card.textContent)).toEqual(['item 1', 'item 2', 'look 3']);
    expect(screen.queryByText('news 4')).toBeNull();

    const first = cards[0].closest('a') as HTMLAnchorElement;
    expect(first).toHaveAttribute('href', '/item/1');
    fireEvent.click(first);
    expect(mockNavigate).toHaveBeenCalledWith('/item/1');
  });
});
