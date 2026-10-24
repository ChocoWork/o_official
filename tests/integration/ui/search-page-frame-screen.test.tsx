import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import SearchPage from '@/app/search/page';
import { SearchPageClient } from '@/features/search/components/SearchPageClient';
import type { SearchResultsResponse } from '@/features/search/types/search.types';

const replaceMock = jest.fn();
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
  useRouter: () => ({ replace: (...args: unknown[]) => replaceMock(...args) }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

const EMPTY_RESPONSE: SearchResultsResponse = {
  query: '',
  tab: 'all',
  items: [],
  looks: [],
  news: [],
  counts: { all: 0, item: 0, look: 0, news: 0 },
  popularItems: [],
  empty: false,
};

const fetchMock = jest.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function installFetch(suggestions: Array<{ label: string; type: 'item' | 'look' | 'news'; href: string }> = []) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/api/suggest')) {
      return jsonResponse({ suggestions });
    }
    return jsonResponse(EMPTY_RESPONSE);
  });
}

// 同じ要素を渡し直すと再描画が省かれるので、毎回新しい要素を作る
const ui = () => <SearchPageClient />;

async function renderClient(query = '') {
  currentQuery = query;
  const view = render(ui());
  await act(async () => {});
  return {
    ...view,
    // 利用者が戻るなどで URL だけが変わった状態を作る
    changeUrl: async (nextQuery: string) => {
      currentQuery = nextQuery;
      view.rerender(ui());
      await act(async () => {});
    },
  };
}

function searchInput() {
  return screen.getByRole('combobox', { name: 'Search' }) as HTMLInputElement;
}

function tabs() {
  return within(screen.getByRole('tablist')).getAllByRole('tab');
}

beforeEach(() => {
  replaceMock.mockReset();
  fetchMock.mockReset();
  installFetch();
  currentQuery = '';
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('SCR-SEARCH-001 検索のページ /search の枠と左のカラム', () => {
  describe('殻', () => {
    it('SCR-SEARCH-001 殻は Suspense の間に「読み込み中...」を出す', () => {
      const element = SearchPage() as React.ReactElement<{ fallback: React.ReactNode }>;

      expect(element.type).toBe(React.Suspense);
      render(<>{element.props.fallback}</>);
      expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    });

    it('SCR-SEARCH-001 殻の中に検索の画面（見出し・入力欄・タブ）が描かれる', async () => {
      render(<SearchPage />);
      await act(async () => {});

      expect(await screen.findByRole('heading', { level: 1, name: 'SEARCH' })).toBeInTheDocument();
      expect(searchInput()).toBeInTheDocument();
      expect(tabs()).toHaveLength(4);
    });
  });

  describe('入力欄', () => {
    it('SCR-SEARCH-001 入力欄は type search・aria-label Search・プレースホルダー付きで検索の form に置かれる', async () => {
      await renderClient();
      const input = searchInput();

      expect(input).toHaveAttribute('type', 'search');
      expect(input).toHaveAttribute('aria-label', 'Search');
      expect(input).toHaveAttribute('placeholder', 'Search items, news, looks...');
      expect(input.closest('form')).not.toBeNull();
    });

    it('SCR-SEARCH-001 右に aria-label「検索」の送信のボタンを置き、虫眼鏡は装飾にする', async () => {
      await renderClient();
      const button = screen.getByRole('button', { name: '検索' });

      expect(button).toHaveAttribute('type', 'submit');
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(button.closest('form')).toContainElement(searchInput());
    });

    it('SCR-SEARCH-001 URL の q があれば入力欄の初期値にする', async () => {
      await renderClient('q=coat');

      expect(searchInput()).toHaveValue('coat');
    });

    it('SCR-SEARCH-001 URL の q が変わるたびに、その値で入力欄を詰め直す', async () => {
      const view = await renderClient('q=coat');
      await userEvent.type(searchInput(), 'xyz');
      expect(searchInput()).toHaveValue('coatxyz');

      await view.changeUrl('q=shirt');
      expect(searchInput()).toHaveValue('shirt');

      await view.changeUrl('');
      expect(searchInput()).toHaveValue('');
    });

  });

  describe('種別のタブ', () => {
    it('SCR-SEARCH-001 ALL・ITEM・LOOK・NEWS の4つを tablist の中にこの順で並べる', async () => {
      await renderClient();

      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(tabs().map((tab) => tab.textContent)).toEqual(['ALL', 'ITEM', 'LOOK', 'NEWS']);
    });

    it('SCR-SEARCH-001 tab の指定が無い時は ALL だけが選ばれた状態になる', async () => {
      await renderClient();

      expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual([
        'true',
        'false',
        'false',
        'false',
      ]);
    });

    it.each([
      ['item', 'ITEM'],
      ['look', 'LOOK'],
      ['news', 'NEWS'],
    ])('SCR-SEARCH-001 tab=%s の URL では %s だけが選ばれた状態になる', async (tab, label) => {
      await renderClient(`tab=${tab}`);

      const selected = tabs().filter((t) => t.getAttribute('aria-selected') === 'true');
      expect(selected).toHaveLength(1);
      expect(selected[0]).toHaveTextContent(label);
    });

    it('SCR-SEARCH-001 tab が4つの値に無い時は ALL として扱う', async () => {
      await renderClient('tab=bogus');

      expect(screen.getByRole('tab', { name: 'ALL' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'ITEM' })).toHaveAttribute('aria-selected', 'false');
    });

  });

  describe('端末への保存', () => {
    it('SCR-SEARCH-001 検索語を端末の保存の場所に読み書きせず、RECENT SEARCHES も出さない', async () => {
      const getItem = jest.spyOn(Storage.prototype, 'getItem');
      const setItem = jest.spyOn(Storage.prototype, 'setItem');
      try {
        await renderClient('q=coat');
        await userEvent.type(searchInput(), 'x');
        await userEvent.click(screen.getByRole('button', { name: '検索' }));
        await userEvent.click(screen.getByRole('tab', { name: 'ITEM' }));
        await waitFor(() => expect(replaceMock).toHaveBeenCalled());

        expect(getItem).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
        expect(screen.queryByText(/RECENT SEARCHES/i)).not.toBeInTheDocument();
      } finally {
        getItem.mockRestore();
        setItem.mockRestore();
      }
    });
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
