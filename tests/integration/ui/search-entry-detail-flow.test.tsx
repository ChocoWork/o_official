import React from 'react';
import userEvent from '@testing-library/user-event';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { SearchHomePreview } from '@/features/search/components/SearchHomePreview';
import { SearchPageClient } from '@/features/search/components/SearchPageClient';
import type { SearchResult, SearchResultsResponse } from '@/features/search/types/search.types';

// 画面の移り先を持つ最小の殻。リンクの操作で URL を替え、URL に合う画面を描く（Next.js のルーターの代わり）
let currentUrl = '/';
let mockNavigate: (href: string) => void = () => undefined;

jest.mock('next/link', () => {
  return ({ href, children, onClick: _onClick, ...props }: { href: string; children: React.ReactNode; onClick?: unknown }) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        mockNavigate(href);
      }}
    >
      {children}
    </a>
  );
});

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => <img src={props.src as string} alt={(props.alt as string) ?? ''} />,
}));

jest.mock('next/navigation', () => ({
  usePathname: () => new URL(currentUrl, 'http://localhost').pathname,
  useSearchParams: () => new URL(currentUrl, 'http://localhost').searchParams,
  useRouter: () => ({
    replace: (href: string) => mockNavigate(href),
    push: (href: string) => mockNavigate(href),
  }),
}));

function Shell() {
  const [url, setUrl] = React.useState(currentUrl);
  React.useLayoutEffect(() => {
    mockNavigate = (href: string) => {
      currentUrl = href;
      setUrl(href);
    };
  }, []);
  const pathname = new URL(url, 'http://localhost').pathname;

  if (pathname === '/') return <SearchHomePreview />;
  if (pathname === '/search') return <SearchPageClient />;
  return <main data-testid="detail-page">{pathname}</main>;
}

function result(type: SearchResult['type'], id: number, title: string): SearchResult {
  return {
    id: String(id),
    type,
    title,
    description: `${title} の説明`,
    href: `/${type}/${id}`,
    imageUrl: null,
    meta: `${type.toUpperCase()} META ${id}`,
  };
}

const coatItem = result('item', 11, 'Wool Coat');
const coatLook = result('look', 22, 'Coat Layers');
const coatNews = result('news', 33, 'Coat Arrival');
const popularA = result('item', 1, 'Popular Knit');
const popularB = result('item', 2, 'Popular Scarf');

function body(query: string, tab: SearchResultsResponse['tab'], parts: { items?: SearchResult[]; looks?: SearchResult[]; news?: SearchResult[] }): SearchResultsResponse {
  const items = parts.items ?? [];
  const looks = parts.looks ?? [];
  const news = parts.news ?? [];
  const all = items.length + looks.length + news.length;
  return {
    query,
    tab,
    items,
    looks,
    news,
    counts: { all, item: items.length, look: looks.length, news: news.length },
    popularItems: [popularA, popularB],
    empty: all === 0,
  };
}

const requested: string[] = [];

// 窓口の偽物。プレビューも検索のページも、同じ語には同じ結果から返す
function serveSearch(url: string) {
  requested.push(url);
  const params = new URL(url, 'http://localhost').searchParams;
  const query = params.get('q') ?? '';
  const tab = (params.get('tab') ?? 'all') as SearchResultsResponse['tab'];
  const full = query === 'coat' ? { items: [coatItem], looks: [coatLook], news: [coatNews] } : {};
  return Promise.resolve({ ok: true, json: async () => body(query, tab, full) });
}

function startAt(url: string) {
  currentUrl = url;
  return render(<Shell />);
}

function detailPath(): string {
  return screen.getByTestId('detail-page').textContent ?? '';
}

describe('FLOW-SEARCH-001 検索の入口から検索のページへ移り、結果から各詳細へ移る', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requested.length = 0;
    currentUrl = '/';
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return url.startsWith('/api/search') ? serveSearch(url) : Promise.resolve({ ok: true, json: async () => ({ suggestions: [] }) });
    }) as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('FLOW-SEARCH-001 ホームのプレビューの VIEW ALL RESULTS から検索のページへ移り、同じ語の結果を出す', async () => {
    const user = userEvent.setup();
    startAt('/?q=coat');

    await user.click(await screen.findByRole('link', { name: 'VIEW ALL RESULTS' }));

    expect(currentUrl).toBe('/search?q=coat');
    expect(await screen.findByText('3 RESULTS')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('coat');
    expect(requested).toEqual(['/api/search?q=coat&preview=true', '/api/search?q=coat&tab=all']);
  });

  it('FLOW-SEARCH-001 プレビューの結果の行き先は、検索のページの結果の行の行き先と同じ', async () => {
    const user = userEvent.setup();
    startAt('/?q=coat');
    await screen.findByText('Search Preview');
    const previewHrefs = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.closest('a')?.getAttribute('href'));

    await user.click(screen.getByRole('link', { name: 'VIEW ALL RESULTS' }));
    await screen.findByText('3 RESULTS');
    const rowHrefs = screen.getAllByTestId('search-result-row').map((row) => within(row).getByRole('link').getAttribute('href'));

    expect(previewHrefs).toEqual(['/item/11', '/look/22', '/news/33']);
    expect(rowHrefs).toEqual(expect.arrayContaining(previewHrefs));
    expect(rowHrefs).toHaveLength(previewHrefs.length);
  });

  it('FLOW-SEARCH-001 プレビューのカードから商品・ルック・ニュースの各詳細へ移る', async () => {
    const user = userEvent.setup();
    const expected: Array<[string, string]> = [
      ['Wool Coat', '/item/11'],
      ['Coat Layers', '/look/22'],
      ['Coat Arrival', '/news/33'],
    ];

    for (const [title, path] of expected) {
      const view = startAt('/?q=coat');
      await user.click((await screen.findByRole('heading', { level: 3, name: title })).closest('a') as HTMLElement);

      expect(currentUrl).toBe(path);
      expect(detailPath()).toBe(path);
      view.unmount();
    }
  });

  it('FLOW-SEARCH-001 検索のページの結果の行から種別ごとの詳細へ移る', async () => {
    const user = userEvent.setup();
    const expected: Array<[RegExp, string]> = [
      [/Wool Coat/, '/item/11'],
      [/Coat Layers/, '/look/22'],
      [/Coat Arrival/, '/news/33'],
    ];

    for (const [name, path] of expected) {
      const view = startAt('/search?q=coat&tab=all');
      const row = (await screen.findAllByTestId('search-result-row')).find((candidate) => name.test(candidate.textContent ?? ''));
      await user.click(within(row as HTMLElement).getByRole('link'));

      expect(detailPath()).toBe(path);
      view.unmount();
    }
  });

  it('FLOW-SEARCH-001 語なしで開いた検索のページ（ヘッダーの入口の行き先）は人気商品から始まり、行は商品の詳細へ移る', async () => {
    const user = userEvent.setup();
    startAt('/search');

    expect(await screen.findByText('POPULAR ITEMS')).toBeInTheDocument();
    await screen.findAllByTestId('search-result-row');
    const hrefs = screen.getAllByTestId('search-result-row').map((row) => within(row).getByRole('link').getAttribute('href'));
    expect(hrefs).toEqual(['/item/1', '/item/2']);
    expect(requested).toEqual(['/api/search?q=&tab=all']);

    await user.click(within(screen.getAllByTestId('search-result-row')[1]).getByRole('link'));

    expect(detailPath()).toBe('/item/2');
  });

  it('FLOW-SEARCH-001 0件の語でも検索のページは人気商品を出し、その行も商品の詳細へ移る', async () => {
    const user = userEvent.setup();
    startAt('/?q=zzz');

    await screen.findByText('プレビュー対象の検索結果は見つかりませんでした。');
    await user.click(screen.getByRole('link', { name: 'VIEW ALL RESULTS' }));

    expect(await screen.findByText('「zzz」の検索結果はありません')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('search-result-row')).toHaveLength(2));
    await user.click(within(screen.getAllByTestId('search-result-row')[0]).getByRole('link'));

    expect(detailPath()).toBe('/item/1');
  });

  it('FLOW-SEARCH-001 語に記号を含んでも符号化したまま検索のページへ渡し、窓口にも同じ語を渡す', async () => {
    const user = userEvent.setup();
    startAt('/?q=' + encodeURIComponent('a&b=c'));

    await user.click(await screen.findByRole('link', { name: 'VIEW ALL RESULTS' }));

    expect(currentUrl).toBe(`/search?q=${encodeURIComponent('a&b=c')}`);
    await waitFor(() => expect(requested).toContain(`/api/search?q=${encodeURIComponent('a&b=c')}&tab=all`));
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
