import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { SearchHomePreview } from '@/features/search/components/SearchHomePreview';
import type { SearchResult, SearchResultsResponse } from '@/features/search/types/search.types';

let currentSearch = '';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

function result(type: SearchResult['type'], id: number, title: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: String(id),
    type,
    title,
    description: `${title} の説明`,
    href: `/${type}/${id}`,
    imageUrl: `https://signed.test/${type}/${id}.jpg`,
    meta: `${type.toUpperCase()} META ${id}`,
    ...overrides,
  };
}

function payload(parts: Partial<Pick<SearchResultsResponse, 'items' | 'looks' | 'news'>>, query = 'coat'): SearchResultsResponse {
  const items = parts.items ?? [];
  const looks = parts.looks ?? [];
  const news = parts.news ?? [];
  const all = items.length + looks.length + news.length;
  return {
    query,
    tab: 'all',
    items,
    looks,
    news,
    counts: { all, item: items.length, look: looks.length, news: news.length },
    popularItems: [],
    empty: all === 0,
  };
}

const fetchMock = jest.fn();
const FIXED_SENTENCE = '入力した語に関連する結果をホーム上で即時プレビューしています。';

function respondWith(body: SearchResultsResponse, ok = true) {
  fetchMock.mockResolvedValue({ ok, json: async () => body });
}

function cards(): HTMLElement[] {
  return screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.closest('a') as HTMLElement);
}

describe('SCR-SEARCH-004 ホームの検索のプレビュー', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentSearch = '';
    global.fetch = fetchMock as unknown as typeof fetch;
    respondWith(payload({}));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('SCR-SEARCH-004 q が無いときは区画を出さず取り出しもしない', () => {
    const { container } = render(<SearchHomePreview />);

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SCR-SEARCH-004 q が空白だけのときも区画を出さず取り出しもしない', () => {
    currentSearch = 'q=%20%20%20';
    const { container } = render(<SearchHomePreview />);

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SCR-SEARCH-004 前後の空白を除いた語で preview=true と no-store を付けて窓口を呼ぶ', async () => {
    currentSearch = 'q=' + encodeURIComponent(' コート & a ');
    respondWith(payload({ items: [result('item', 1, 'ウールコート')] }, 'コート & a'));
    render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/search?q=${encodeURIComponent('コート & a')}&preview=true`, { cache: 'no-store' });
  });

  it('SCR-SEARCH-004 取り出す前は区画を出さず、返ってから見出し・説明・VIEW ALL RESULTS を出す', async () => {
    currentSearch = 'q=coat';
    let resolveFetch: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const { container } = render(<SearchHomePreview />);

    expect(container).toBeEmptyDOMElement();

    resolveFetch({ ok: true, json: async () => payload({ items: [result('item', 1, 'Wool Coat')] }) });

    expect(await screen.findByText('PREVIEW')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Search Preview' })).toBeInTheDocument();
    expect(screen.getByText(FIXED_SENTENCE)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'VIEW ALL RESULTS' })).toHaveAttribute('href', '/search?q=coat');
  });

  it('SCR-SEARCH-004 検索語は固定の説明の文と分かれた「検索した語」の枠に出る', async () => {
    currentSearch = 'q=' + encodeURIComponent('coat 本日休業のお知らせ');
    respondWith(payload({ items: [result('item', 1, 'Wool Coat')] }, 'coat 本日休業のお知らせ'));
    const { container } = render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    const box = screen.getByTestId('search-preview-term');
    expect(within(box).getByText('検索した語')).toBeInTheDocument();
    expect(within(box).getByText('coat 本日休業のお知らせ')).toBeInTheDocument();
    expect(screen.getByText(FIXED_SENTENCE).textContent).not.toContain('本日休業');
    for (const paragraph of Array.from(container.querySelectorAll('p'))) {
      expect(paragraph.textContent).not.toContain('本日休業');
    }
  });

  it('SCR-SEARCH-004 VIEW ALL RESULTS の行き先は語を URL 用に符号化した検索のページ', async () => {
    currentSearch = 'q=' + encodeURIComponent('a&b c');
    respondWith(payload({ items: [result('item', 1, 'A')] }, 'a&b c'));
    render(<SearchHomePreview />);

    const link = await screen.findByRole('link', { name: 'VIEW ALL RESULTS' });

    expect(link).toHaveAttribute('href', `/search?q=${encodeURIComponent('a&b c')}`);
  });

  it('SCR-SEARCH-004 結果は商品・ルック・ニュースの順に並べた先頭3件だけをカードで出す', async () => {
    currentSearch = 'q=coat';
    respondWith(
      payload({
        items: [result('item', 1, 'Item One'), result('item', 2, 'Item Two')],
        looks: [result('look', 3, 'Look Three'), result('look', 4, 'Look Four')],
        news: [result('news', 5, 'News Five')],
      }),
    );
    render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    const titles = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(titles).toEqual(['Item One', 'Item Two', 'Look Three']);
    expect(screen.queryByText('Look Four')).not.toBeInTheDocument();
    expect(screen.queryByText('News Five')).not.toBeInTheDocument();
  });

  it('SCR-SEARCH-004 商品が少なければ後ろの種別から埋め、3件に満たなければあるだけ出す', async () => {
    currentSearch = 'q=coat';
    respondWith(payload({ looks: [result('look', 3, 'Look Three')], news: [result('news', 5, 'News Five')] }));
    render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Look Three', 'News Five']);
  });

  it('SCR-SEARCH-004 カード全体が詳細へのリンクで、メタ・題・説明を持つ', async () => {
    currentSearch = 'q=coat';
    respondWith(
      payload({
        items: [result('item', 1, 'Wool Coat', { meta: 'COAT / ¥48,000', description: 'あたたかい' })],
        looks: [result('look', 2, 'Winter Layers')],
        news: [result('news', 3, 'New Arrival')],
      }),
    );
    render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    const [first, second, third] = cards();
    expect(first).toHaveAttribute('href', '/item/1');
    expect(within(first).getByText('COAT / ¥48,000')).toBeInTheDocument();
    expect(within(first).getByRole('heading', { level: 3, name: 'Wool Coat' })).toBeInTheDocument();
    expect(within(first).getByText('あたたかい')).toBeInTheDocument();
    expect(second).toHaveAttribute('href', '/look/2');
    expect(third).toHaveAttribute('href', '/news/3');
  });

  it('SCR-SEARCH-004 画像と語の強調は出さない', async () => {
    currentSearch = 'q=coat';
    respondWith(payload({ items: [result('item', 1, 'Wool Coat')] }));
    const { container } = render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('mark')).toBeNull();
  });

  it('SCR-SEARCH-004 題・説明・語は文字として出し、タグとして解釈しない', async () => {
    currentSearch = 'q=' + encodeURIComponent('<img src=x onerror=alert(1)>');
    respondWith(
      payload({ items: [result('item', 1, '<b>bold</b>', { description: '<script>alert(1)</script>', meta: '<i>meta</i>' })] }, '<img src=x onerror=alert(1)>'),
    );
    const { container } = render(<SearchHomePreview />);

    await screen.findByText('<b>bold</b>');

    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('<i>meta</i>')).toBeInTheDocument();
    expect(within(screen.getByTestId('search-preview-term')).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('b, script, i, img')).toBeNull();
  });

  it('SCR-SEARCH-004 0件のときは見出しと続きの導線を残し、見つからない旨を出す', async () => {
    currentSearch = 'q=zzz';
    respondWith(payload({}, 'zzz'));
    render(<SearchHomePreview />);

    expect(await screen.findByText('プレビュー対象の検索結果は見つかりませんでした。')).toBeInTheDocument();
    expect(screen.getByText('Search Preview')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'VIEW ALL RESULTS' })).toHaveAttribute('href', '/search?q=zzz');
    expect(cards()).toHaveLength(0);
  });

  it('SCR-SEARCH-004 結果があるときは見つからない旨を出さない', async () => {
    currentSearch = 'q=coat';
    respondWith(payload({ items: [result('item', 1, 'Wool Coat')] }));
    render(<SearchHomePreview />);

    await screen.findByText('Search Preview');

    expect(screen.queryByText('プレビュー対象の検索結果は見つかりませんでした。')).not.toBeInTheDocument();
  });

  it('SCR-SEARCH-004 窓口が失敗の応答を返したら記録して区画ごと出さない', async () => {
    currentSearch = 'q=coat';
    respondWith(payload({ items: [result('item', 1, 'Wool Coat')] }), false);
    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(console.error).toHaveBeenCalledWith('Failed to fetch home search preview'));

    expect(container).toBeEmptyDOMElement();
  });

  it('SCR-SEARCH-004 通信が落ちても記録して区画ごと出さず、例外を外へ出さない', async () => {
    currentSearch = 'q=coat';
    fetchMock.mockRejectedValue(new Error('network down'));
    const { container } = render(<SearchHomePreview />);

    await waitFor(() => expect(console.error).toHaveBeenCalledWith('Failed to fetch home search preview'));

    expect(container).toBeEmptyDOMElement();
  });

  it('SCR-SEARCH-004 語が変わると取り直し、前の結果を新しい結果に置き換える', async () => {
    currentSearch = 'q=coat';
    respondWith(payload({ items: [result('item', 1, 'Wool Coat')] }));
    const { rerender } = render(<SearchHomePreview />);
    await screen.findByText('Wool Coat');

    currentSearch = 'q=scarf';
    respondWith(payload({ items: [result('item', 3, 'Silk Scarf')] }, 'scarf'));
    rerender(<SearchHomePreview />);

    expect(await screen.findByText('Silk Scarf')).toBeInTheDocument();
    expect(screen.queryByText('Wool Coat')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/search?q=scarf&preview=true', { cache: 'no-store' });
    expect(screen.getByRole('link', { name: 'VIEW ALL RESULTS' })).toHaveAttribute('href', '/search?q=scarf');
  });

  it('SCR-SEARCH-004 語が空に戻ると区画を消す', async () => {
    currentSearch = 'q=coat';
    respondWith(payload({ items: [result('item', 1, 'Wool Coat')] }));
    const { container, rerender } = render(<SearchHomePreview />);
    await screen.findByText('Wool Coat');

    currentSearch = '';
    rerender(<SearchHomePreview />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SCR-SEARCH-004 語が変わった後に遅れて返った前の語の結果は反映しない', async () => {
    currentSearch = 'q=coat';
    let resolveOld: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<SearchHomePreview />);

    currentSearch = 'q=scarf';
    respondWith(payload({ items: [result('item', 3, 'Silk Scarf')] }, 'scarf'));
    rerender(<SearchHomePreview />);
    await screen.findByText('Silk Scarf');

    resolveOld({ ok: true, json: async () => payload({ items: [result('item', 1, 'Wool Coat')] }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Wool Coat')).not.toBeInTheDocument();
    expect(screen.getByText('Silk Scarf')).toBeInTheDocument();
  });

  it('SCR-SEARCH-004 外した後に返った結果で例外や警告を出さない', async () => {
    currentSearch = 'q=coat';
    let resolveFetch: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const { unmount } = render(<SearchHomePreview />);

    unmount();
    resolveFetch({ ok: true, json: async () => payload({ items: [result('item', 1, 'Wool Coat')] }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(console.error).not.toHaveBeenCalled();
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
