import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { SearchPageClient } from '@/features/search/components/SearchPageClient';
import type {
  SearchResult,
  SearchResultType,
  SearchResultsResponse,
} from '@/features/search/types/search.types';

let currentQuery = '';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

// effect を止めて、描いた直後（取り出しを始める前）の見せ方だけを取り出す
function renderFirstPaint(query: string): HTMLElement {
  currentQuery = query;
  const effectSpy = jest.spyOn(React, 'useEffect').mockImplementation(() => {});
  try {
    return render(<SearchPageClient />).container;
  } finally {
    effectSpy.mockRestore();
  }
}

const GUIDE_TEXT =
  '気になる商品名やトピックを入力すると、商品・ルック・ニュースを横断した結果を表示します。';
const ERROR_TEXT = '検索結果を読み込めませんでした';

type Pending = {
  url: string;
  resolve: (body: SearchResultsResponse) => void;
  fail: (kind?: 'status' | 'network') => void;
};

const searchCalls: Pending[] = [];
const fetchMock = jest.fn();

function makeResult(type: SearchResultType, id: string): SearchResult {
  return {
    id,
    type,
    title: `${type} ${id}`,
    description: `${type} ${id} の説明`,
    href: `/${type}/${id}`,
    imageUrl: null,
    meta: `${type} meta ${id}`,
  };
}

function payload(overrides: Partial<SearchResultsResponse> = {}): SearchResultsResponse {
  const items = overrides.items ?? [];
  const looks = overrides.looks ?? [];
  const news = overrides.news ?? [];
  return {
    query: '',
    tab: 'all',
    items,
    looks,
    news,
    counts: { all: items.length + looks.length + news.length, item: items.length, look: looks.length, news: news.length },
    popularItems: [],
    empty: false,
    ...overrides,
  };
}

// 検索の窓口への呼び出しは、テストが応答を返すまで保留にする（取り出し中の見せ方を確かめるため）
function installDeferredFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).startsWith('/api/suggest')) {
      return Promise.resolve({ ok: true, json: async () => ({ suggestions: [] }) });
    }
    return new Promise((resolve, reject) => {
      searchCalls.push({
        url: String(url),
        resolve: (body) => resolve({ ok: true, json: async () => body }),
        fail: (kind = 'status') =>
          kind === 'status' ? resolve({ ok: false, json: async () => ({}) }) : reject(new Error('network down')),
      });
    });
  });
}

async function settle(action: () => void) {
  await act(async () => {
    action();
  });
}

async function renderPending(query: string) {
  currentQuery = query;
  const view = render(<SearchPageClient />);
  await act(async () => {});
  return {
    ...view,
    changeUrl: async (nextQuery: string) => {
      currentQuery = nextQuery;
      view.rerender(<SearchPageClient />);
      await act(async () => {});
    },
  };
}

function rows() {
  return screen.queryAllByTestId('search-result-row');
}

function skeletonBlock(container: HTMLElement) {
  return container.querySelector('[aria-hidden="true"] .animate-pulse')?.closest('[aria-hidden="true"]') ?? null;
}

function errorRegion() {
  return screen.getAllByRole('alert').find((el) => el.textContent === ERROR_TEXT) ?? null;
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  fetchMock.mockReset();
  searchCalls.length = 0;
  currentQuery = '';
  installDeferredFetch();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('STATE-SEARCH-001 検索のページの右のカラムの見せ方', () => {
  describe('初めの描画', () => {
    it('STATE-SEARCH-001 初めの描画（q なし）は取り出しの前に POPULAR ITEMS の見出しと案内文を出す', () => {
      const container = renderFirstPaint('');

      expect(container).toHaveTextContent('POPULAR ITEMS');
      expect(container).toHaveTextContent(GUIDE_TEXT);
      expect(container.querySelector('.animate-pulse')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('STATE-SEARCH-001 初めの描画（q あり）は灰色の枠を出さず「0 RESULTS」の見出しの行を出す', () => {
      const container = renderFirstPaint('q=coat');

      expect(container).toHaveTextContent('0 RESULTS');
      expect(container.querySelector('.animate-pulse')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('STATE-SEARCH-001 描いた直後に検索の窓口を q と tab を付けて no-store で呼ぶ', async () => {
      await renderPending('q=coat&tab=look');

      expect(searchCalls).toHaveLength(1);
      expect(searchCalls[0].url).toBe('/api/search?q=coat&tab=look');
      expect(fetchMock).toHaveBeenCalledWith('/api/search?q=coat&tab=look', { cache: 'no-store' });
    });

    it('STATE-SEARCH-001 q が無くても取り出しを始める（人気商品を出すため）', async () => {
      await renderPending('');

      expect(searchCalls).toHaveLength(1);
      expect(searchCalls[0].url).toBe('/api/search?q=&tab=all');
    });
  });

  describe('取り出し中', () => {
    it('STATE-SEARCH-001 取り出し中（q あり）は見出しの行と結果の行の形の灰色の枠を5行、aria-hidden で出す', async () => {
      const { container } = await renderPending('q=coat');

      const block = skeletonBlock(container) as HTMLElement;
      expect(block).not.toBeNull();
      expect(block.querySelectorAll('li')).toHaveLength(5);
      expect(block.querySelector('.h-3.w-20.animate-pulse')).not.toBeNull();
      expect(rows()).toHaveLength(0);
      expect(screen.queryByText(/RESULTS$/)).not.toBeInTheDocument();
      expect(screen.queryByText(GUIDE_TEXT)).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 取り出し中（q なし）は POPULAR ITEMS の見出しだけを出し、案内文は出さない', async () => {
      const { container } = await renderPending('');

      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(screen.queryByText(GUIDE_TEXT)).not.toBeInTheDocument();
      expect(rows()).toHaveLength(0);
      expect(skeletonBlock(container)).toBeNull();
    });

    it('STATE-SEARCH-001 取り出し中（q なし）は前の人気商品があれば出したまま、案内文は出さない', async () => {
      const view = await renderPending('');
      await settle(() => searchCalls[0].resolve(payload({ popularItems: [makeResult('item', 'p1')] })));
      expect(rows()).toHaveLength(1);

      await view.changeUrl('tab=item');

      expect(searchCalls).toHaveLength(2);
      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(rows()).toHaveLength(1);
      expect(screen.queryByText(GUIDE_TEXT)).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 取り出し中に q が付くと前の結果ではなく灰色の枠に切り替わる', async () => {
      const view = await renderPending('');
      await settle(() => searchCalls[0].resolve(payload({ popularItems: [makeResult('item', 'p1')] })));
      expect(rows()).toHaveLength(1);

      await view.changeUrl('q=coat');

      expect(skeletonBlock(view.container)).not.toBeNull();
      expect(rows()).toHaveLength(0);
    });
  });

  describe('取り出しの結果', () => {
    it('STATE-SEARCH-001 語なしは POPULAR ITEMS と人気商品の行を出し、件数の見出しは出さない', async () => {
      await renderPending('');
      await settle(() =>
        searchCalls[0].resolve(payload({ popularItems: [makeResult('item', 'p1'), makeResult('item', 'p2')] })),
      );

      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(rows()).toHaveLength(2);
      expect(screen.queryByText(GUIDE_TEXT)).not.toBeInTheDocument();
      expect(screen.queryByText(/RESULTS$/)).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 語なしで人気商品が無ければ POPULAR ITEMS の下に案内文を出す', async () => {
      const { container } = await renderPending('');
      await settle(() => searchCalls[0].resolve(payload({ popularItems: [] })));

      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(screen.getByText(GUIDE_TEXT)).toBeInTheDocument();
      expect(rows()).toHaveLength(0);
      expect(skeletonBlock(container)).toBeNull();
    });

    it('STATE-SEARCH-001 結果ありは「{件数} RESULTS」と結果の行を出し、灰色の枠と0件の文は出さない', async () => {
      const { container } = await renderPending('q=coat');
      await settle(() =>
        searchCalls[0].resolve(payload({ items: [makeResult('item', '1'), makeResult('item', '2')] })),
      );

      expect(screen.getByText('2 RESULTS')).toBeInTheDocument();
      expect(rows()).toHaveLength(2);
      expect(skeletonBlock(container)).toBeNull();
      expect(screen.queryByText(/の検索結果はありません/)).not.toBeInTheDocument();
      expect(errorRegion()).toBeNull();
    });

    it('STATE-SEARCH-001 結果なしは 0件の題と案内文、POPULAR ITEMS の行を出す', async () => {
      await renderPending('q=zzz');
      await settle(() =>
        searchCalls[0].resolve(payload({ empty: true, popularItems: [makeResult('item', 'p1')] })),
      );

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('「zzz」の検索結果はありません');
      expect(
        screen.getByText('別のキーワードをお試しください。人気商品もあわせてご覧いただけます。'),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'POPULAR ITEMS' })).toBeInTheDocument();
      expect(rows()).toHaveLength(1);
      expect(screen.queryByText(/RESULTS$/)).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 empty が偽で一覧が空なら「0 RESULTS」の見出しの行だけを出す（空白だけの q を含む）', async () => {
      await renderPending('q=%20%20');
      await settle(() => searchCalls[0].resolve(payload({ empty: false })));

      expect(screen.getByText('0 RESULTS')).toBeInTheDocument();
      expect(rows()).toHaveLength(0);
      expect(screen.queryByText(/の検索結果はありません/)).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 窓口が200で empty を真にして返せば、中身が何でも結果なしの見せ方になる', async () => {
      await renderPending('q=coat');
      await settle(() =>
        searchCalls[0].resolve(payload({ empty: true, items: [makeResult('item', '1')] })),
      );

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('「coat」の検索結果はありません');
      expect(screen.queryByText(/RESULTS$/)).not.toBeInTheDocument();
    });
  });

  describe('失敗', () => {
    it('STATE-SEARCH-001 200 以外の応答は「検索結果を読み込めませんでした」を赤い字の読み上げの領域に出す', async () => {
      const { container } = await renderPending('q=coat');
      await settle(() => searchCalls[0].fail('status'));

      const region = errorRegion() as HTMLElement;
      expect(region).not.toBeNull();
      expect(region).toHaveAttribute('role', 'alert');
      expect(region).toHaveClass('text-red-600');
      expect(skeletonBlock(container)).toBeNull();
      expect(consoleError).toHaveBeenCalled();
    });

    it('STATE-SEARCH-001 通信の失敗も同じ見せ方で、前の結果は消す', async () => {
      const view = await renderPending('q=coat');
      await settle(() => searchCalls[0].resolve(payload({ items: [makeResult('item', '1')] })));
      expect(rows()).toHaveLength(1);

      await view.changeUrl('q=shirt');
      await settle(() => searchCalls[1].fail('network'));

      expect(errorRegion()).not.toBeNull();
      expect(rows()).toHaveLength(0);
      expect(screen.queryByText('1 RESULTS')).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 失敗の時に q があると失敗の文の下に「0 RESULTS」の見出しの行も出る', async () => {
      await renderPending('q=coat');
      await settle(() => searchCalls[0].fail('status'));

      expect(errorRegion()).not.toBeNull();
      expect(screen.getByText('0 RESULTS')).toBeInTheDocument();
    });

    it('STATE-SEARCH-001 失敗の時に q が無いと失敗の文と案内文が並ぶ', async () => {
      await renderPending('');
      await settle(() => searchCalls[0].fail('status'));

      expect(errorRegion()).not.toBeNull();
      expect(screen.getByText(GUIDE_TEXT)).toBeInTheDocument();
    });

    it('STATE-SEARCH-001 失敗していない時の読み上げの領域は空で、失敗の文を持たない', async () => {
      await renderPending('q=coat');
      await settle(() => searchCalls[0].resolve(payload({ items: [makeResult('item', '1')] })));

      expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
      expect(errorRegion()).toBeNull();
    });
  });

  describe('取り出しへの戻り', () => {
    it('STATE-SEARCH-001 結果あり → q が変わると取り出し中に戻り、新しい応答で結果を入れ替える', async () => {
      const view = await renderPending('q=coat');
      await settle(() => searchCalls[0].resolve(payload({ items: [makeResult('item', 'a')] })));
      expect(screen.getByText('1 RESULTS')).toBeInTheDocument();

      await view.changeUrl('q=shirt');
      expect(skeletonBlock(view.container)).not.toBeNull();
      expect(searchCalls[1].url).toBe('/api/search?q=shirt&tab=all');

      await settle(() =>
        searchCalls[1].resolve(payload({ items: [makeResult('item', 'b'), makeResult('item', 'c')] })),
      );
      expect(skeletonBlock(view.container)).toBeNull();
      expect(screen.getByText('2 RESULTS')).toBeInTheDocument();
    });

    it('STATE-SEARCH-001 結果なし → tab が変わると取り出し中に戻る', async () => {
      const view = await renderPending('q=zzz');
      await settle(() => searchCalls[0].resolve(payload({ empty: true })));
      expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();

      await view.changeUrl('q=zzz&tab=news');

      expect(skeletonBlock(view.container)).not.toBeNull();
      expect(searchCalls[1].url).toBe('/api/search?q=zzz&tab=news');
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 失敗 → q が変わると取り出し中に戻り、成功すれば失敗の文を消す', async () => {
      const view = await renderPending('q=coat');
      await settle(() => searchCalls[0].fail('status'));
      expect(errorRegion()).not.toBeNull();

      await view.changeUrl('q=shirt');
      expect(skeletonBlock(view.container)).not.toBeNull();

      await settle(() => searchCalls[1].resolve(payload({ items: [makeResult('item', '1')] })));
      expect(errorRegion()).toBeNull();
      expect(screen.getByText('1 RESULTS')).toBeInTheDocument();
    });

    it('STATE-SEARCH-001 語なし → q が付くと取り出し中に戻る', async () => {
      const view = await renderPending('');
      await settle(() => searchCalls[0].resolve(payload({ popularItems: [] })));
      expect(screen.getByText(GUIDE_TEXT)).toBeInTheDocument();

      await view.changeUrl('q=coat');

      expect(skeletonBlock(view.container)).not.toBeNull();
      expect(screen.queryByText(GUIDE_TEXT)).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-001 前の取り出しの応答が後から届いても取り消しの印で捨てる', async () => {
      const view = await renderPending('q=coat');
      await view.changeUrl('q=shirt');
      expect(searchCalls).toHaveLength(2);

      await settle(() => searchCalls[1].resolve(payload({ items: [makeResult('item', 'new')] })));
      expect(screen.getByText('1 RESULTS')).toBeInTheDocument();

      await settle(() =>
        searchCalls[0].resolve(payload({ items: [makeResult('item', 'old1'), makeResult('item', 'old2')] })),
      );

      expect(screen.getByText('1 RESULTS')).toBeInTheDocument();
      expect(rows()).toHaveLength(1);
      expect(within(rows()[0]).getByText('item new')).toBeInTheDocument();
    });

    it('STATE-SEARCH-001 前の取り出しの失敗が後から届いても失敗の文を出さず、取り出し中を終わらせない', async () => {
      const view = await renderPending('q=coat');
      await view.changeUrl('q=shirt');

      await settle(() => searchCalls[0].fail('network'));

      expect(errorRegion()).toBeNull();
      expect(skeletonBlock(view.container)).not.toBeNull();

      await settle(() => searchCalls[1].resolve(payload({ items: [makeResult('item', 'new')] })));
      expect(skeletonBlock(view.container)).toBeNull();
      expect(screen.getByText('1 RESULTS')).toBeInTheDocument();
    });
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
