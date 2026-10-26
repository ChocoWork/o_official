import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  SearchResult,
  SearchResultsResponse,
  SearchResultType,
  SearchSuggestion,
  SearchTab,
} from '@/features/search/types/search.types';

// URL は Next のルーターの持ち物なので、テストが持つ。replace が呼ばれたら、その URL を画面へ渡し直す（rerender）
let mockSearch = '';
const mockReplace = jest.fn();
const mockRouter = { replace: (...args: unknown[]) => mockReplace(...args) };

jest.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

// 画面の部品は本物を通し、窓口 /api/search・/api/suggest の応答だけを差し替える
const { SearchPageClient } = require('@/features/search/components/SearchPageClient');

function row(type: SearchResultType, id: string, title: string): SearchResult {
  return { id, type, title, description: '', href: `/${type}/${id}`, imageUrl: null, meta: '' };
}

function payload(overrides: Partial<SearchResultsResponse> = {}): SearchResultsResponse {
  return {
    query: '',
    tab: 'all',
    items: [],
    looks: [],
    news: [],
    counts: { all: 0, item: 0, look: 0, news: 0 },
    popularItems: [],
    empty: false,
    ...overrides,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SearchReply = { ok: boolean; body: SearchResultsResponse };

// /api/search の応答。URL ごとに決めた応答を返し、決めていなければ空の結果を返す
let searchReplies: Record<string, SearchReply | Deferred<SearchReply>> = {};
let mockSuggestions: SearchSuggestion[] = [];
const mockFetch = jest.fn();

function isDeferred(reply: SearchReply | Deferred<SearchReply>): reply is Deferred<SearchReply> {
  return 'promise' in reply;
}

function installFetch() {
  mockFetch.mockImplementation(async (input: string) => {
    if (input.startsWith('/api/suggest')) {
      return { ok: true, json: async () => ({ suggestions: mockSuggestions }) };
    }
    const reply = searchReplies[input] ?? { ok: true, body: payload() };
    const settled = isDeferred(reply) ? await reply.promise : reply;
    return { ok: settled.ok, json: async () => settled.body };
  });
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
}

function searchCalls(): string[] {
  return mockFetch.mock.calls.map((call) => call[0] as string).filter((url) => url.startsWith('/api/search'));
}

function lastReplaceUrl(): string {
  return mockReplace.mock.calls[mockReplace.mock.calls.length - 1][0] as string;
}

// Next がルーターの replace の後に新しい URL の引数を渡す動きを写す
function followReplace(rerender: (ui: React.ReactElement) => void) {
  const url = lastReplaceUrl();
  mockSearch = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  rerender(<SearchPageClient />);
}

function tab(name: string) {
  return screen.getByRole('tab', { name });
}

describe('FLOW-SEARCH-002 検索のページの中で語・タブ・候補を確定すると URL を置き換えて取り直す', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSearch = 'q=coat&tab=all';
    mockSuggestions = [];
    searchReplies = {};
    mockFetch.mockReset();
    mockReplace.mockReset();
    installFetch();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('語の確定（送信）', () => {
    it('FLOW-SEARCH-002 語を送ると q と tab を入れた URL へ、履歴を積まず（replace）スクロールを保って置き換える', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      await user.clear(input);
      await user.type(input, 'wool{Enter}');

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=wool&tab=all', { scroll: false });
    });

    it('FLOW-SEARCH-002 語の前後の空白を除いて確定する', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      await user.clear(input);
      await user.type(input, '  wool coat  {Enter}');

      expect(mockReplace).toHaveBeenCalledWith('/search?q=wool+coat&tab=all', { scroll: false });
    });

    it('FLOW-SEARCH-002 語を空にして送ると q を URL から消し、tab は残す', async () => {
      mockSearch = 'q=coat&tab=item';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.clear(screen.getByRole('combobox'));
      await user.click(screen.getByRole('button', { name: '検索' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?tab=item', { scroll: false });
    });

    it('FLOW-SEARCH-002 空白だけの語も空として扱い、q を URL から消す', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      await user.clear(input);
      await user.type(input, '   {Enter}');

      expect(mockReplace).toHaveBeenCalledWith('/search?tab=all', { scroll: false });
    });

    it('FLOW-SEARCH-002 今の URL のほかの引数は残し、q と tab だけを入れ替える', async () => {
      mockSearch = 'utm=mail&q=coat&tab=look&ref=top';
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      await user.clear(input);
      await user.type(input, 'wool{Enter}');

      expect(mockReplace).toHaveBeenCalledWith('/search?utm=mail&q=wool&tab=look&ref=top', { scroll: false });
    });

    it('FLOW-SEARCH-002 q を消す時もほかの引数は残す', async () => {
      mockSearch = 'q=coat&utm=mail';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.clear(screen.getByRole('combobox'));
      await user.click(screen.getByRole('button', { name: '検索' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?utm=mail&tab=all', { scroll: false });
    });

    it('FLOW-SEARCH-002 URL に tab が無くても、確定する時は必ず tab=all を入れる', async () => {
      mockSearch = '';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), 'coat{Enter}');

      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=all', { scroll: false });
    });

    it('FLOW-SEARCH-002 語に記号があっても URL の引数として符号化して確定する', async () => {
      mockSearch = '';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), 'a&b=c#d{Enter}');

      expect(mockReplace).toHaveBeenCalledWith('/search?q=a%26b%3Dc%23d&tab=all', { scroll: false });
    });

    it('FLOW-SEARCH-002 語を打っている途中は URL を置き換えず、送った時に初めて置き換える', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), 'abc');
      expect(mockReplace).not.toHaveBeenCalled();

      await user.keyboard('{Enter}');
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
  });

  describe('タブの確定', () => {
    it('FLOW-SEARCH-002 タブを押すと今の語のまま tab だけを替えて URL を置き換える', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(tab('LOOK'));

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=look', { scroll: false });
    });

    it.each<[string, SearchTab]>([
      ['ALL', 'all'],
      ['ITEM', 'item'],
      ['LOOK', 'look'],
      ['NEWS', 'news'],
    ])('FLOW-SEARCH-002 %s のタブは tab=%s で確定する', async (name, key) => {
      mockSearch = key === 'all' ? 'q=coat&tab=news' : 'q=coat&tab=all';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(tab(name));

      expect(mockReplace).toHaveBeenCalledWith(`/search?q=coat&tab=${key}`, { scroll: false });
    });

    it('FLOW-SEARCH-002 URL に q が無ければタブを替えても q を入れず tab だけを入れる', async () => {
      mockSearch = '';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(tab('ITEM'));

      expect(mockReplace).toHaveBeenCalledWith('/search?tab=item', { scroll: false });
    });

    it('FLOW-SEARCH-002 打ちかけで送っていない語は、タブを替えても URL に入れない（URL の語を使う）', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      await user.clear(input);
      await user.type(input, 'draft');
      await user.click(tab('NEWS'));

      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=news', { scroll: false });
    });

    it('FLOW-SEARCH-002 タブを替えてもほかの引数は残す', async () => {
      mockSearch = 'utm=mail&q=coat&tab=all';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(tab('NEWS'));

      expect(mockReplace).toHaveBeenCalledWith('/search?utm=mail&q=coat&tab=news', { scroll: false });
    });

    it('FLOW-SEARCH-002 URL の tab が未知の値なら ALL として扱い、取り出しも tab=all で呼ぶ', async () => {
      mockSearch = 'q=coat&tab=bogus';
      render(<SearchPageClient />);

      expect(tab('ALL')).toHaveAttribute('aria-selected', 'true');
      expect(tab('ITEM')).toHaveAttribute('aria-selected', 'false');
      await waitFor(() => expect(searchCalls()).toEqual(['/api/search?q=coat&tab=all']));
    });
  });

  describe('候補の確定', () => {
    it('FLOW-SEARCH-002 候補を選ぶと、その名前と種別（タブ）で URL を置き換える', async () => {
      mockSuggestions = [
        { label: 'Wool Coat', type: 'look', href: '/look/1' },
        { label: 'Daily News', type: 'news', href: '/news/1' },
      ];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));
      const listbox = await screen.findByRole('listbox');

      await user.click(within(listbox).getAllByRole('option')[0]);

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=Wool+Coat&tab=look', { scroll: false });
      expect(screen.getByRole('combobox')).toHaveValue('Wool Coat');
    });

    it('FLOW-SEARCH-002 今の tab が item でも、候補の種別が news ならその tab に替えて確定する', async () => {
      mockSearch = 'q=coat&tab=item';
      mockSuggestions = [{ label: 'Daily News', type: 'news', href: '/news/1' }];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));

      await user.click(await screen.findByRole('option'));

      expect(mockReplace).toHaveBeenCalledWith('/search?q=Daily+News&tab=news', { scroll: false });
    });

    it('FLOW-SEARCH-002 キーボードで選んだ候補も同じ形で確定する（ほかの引数は残す）', async () => {
      mockSearch = 'utm=mail&q=coat&tab=all';
      mockSuggestions = [{ label: 'Wool Coat', type: 'item', href: '/item/1' }];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));
      await screen.findByRole('listbox');

      await user.keyboard('{ArrowDown}{Enter}');

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?utm=mail&q=Wool+Coat&tab=item', { scroll: false });
    });

    it('FLOW-SEARCH-002 候補の href へは移らず（検索のページの中で取り直す）、リンクにもならない', async () => {
      mockSuggestions = [{ label: 'Wool Coat', type: 'item', href: '/item/1' }];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));

      const option = await screen.findByRole('option');

      expect(option.tagName).toBe('BUTTON');
      expect(screen.queryByRole('link', { name: /Wool Coat/ })).not.toBeInTheDocument();
    });
  });

  describe('URL が変わると取り直す', () => {
    it('FLOW-SEARCH-002 開いた時に今の q と tab で /api/search を no-store で1回呼ぶ', async () => {
      render(<SearchPageClient />);

      await waitFor(() => expect(searchCalls()).toEqual(['/api/search?q=coat&tab=all']));
      const searchCall = mockFetch.mock.calls.find((call) => (call[0] as string).startsWith('/api/search'));
      expect(searchCall?.[1]).toEqual({ cache: 'no-store' });
    });

    it('FLOW-SEARCH-002 語を空にした URL でも取り出しは省かず、q を空にして呼ぶ（人気商品を出すため）', async () => {
      mockSearch = '';
      searchReplies['/api/search?q=&tab=all'] = {
        ok: true,
        body: payload({ popularItems: [row('item', 'p1', 'Popular Shirt')] }),
      };
      render(<SearchPageClient />);

      expect(await screen.findByText('Popular Shirt')).toBeInTheDocument();
      expect(searchCalls()).toEqual(['/api/search?q=&tab=all']);
    });

    it('FLOW-SEARCH-002 語を送って URL が変わると、新しい q で取り直して結果を差し替える', async () => {
      searchReplies['/api/search?q=coat&tab=all'] = {
        ok: true,
        body: payload({ items: [row('item', 'a', 'Alpha Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
      };
      searchReplies['/api/search?q=wool&tab=all'] = {
        ok: true,
        body: payload({ items: [row('item', 'b', 'Beta Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
      };
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);
      expect(await screen.findByText('Alpha Piece')).toBeInTheDocument();

      const input = screen.getByRole('combobox');
      await user.clear(input);
      await user.type(input, 'wool{Enter}');
      followReplace(rerender);

      expect(await screen.findByText('Beta Piece')).toBeInTheDocument();
      expect(screen.queryByText('Alpha Piece')).not.toBeInTheDocument();
      expect(searchCalls()).toEqual(['/api/search?q=coat&tab=all', '/api/search?q=wool&tab=all']);
    });

    it('FLOW-SEARCH-002 タブを押して URL が変わっても取り直さず、取ってあった結果から押したタブの行を出す（SEC-SEARCH-005）', async () => {
      searchReplies['/api/search?q=coat&tab=all'] = {
        ok: true,
        body: payload({
          items: [row('item', 'a', 'Alpha Piece')],
          looks: [row('look', 'l1', 'Gamma Piece')],
          counts: { all: 2, item: 1, look: 1, news: 0 },
        }),
      };
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(searchCalls()).toHaveLength(1));
      expect(tab('ALL')).toHaveAttribute('aria-selected', 'true');

      await user.click(tab('LOOK'));
      // URL が置き換わるまで、選ばれたタブは動かない（URL が持ち主）
      expect(tab('ALL')).toHaveAttribute('aria-selected', 'true');
      followReplace(rerender);

      expect(tab('LOOK')).toHaveAttribute('aria-selected', 'true');
      expect(tab('ALL')).toHaveAttribute('aria-selected', 'false');
      expect(await screen.findByText('Gamma Piece')).toBeInTheDocument();
      expect(screen.queryByText('Alpha Piece')).not.toBeInTheDocument();
      expect(searchCalls()).toEqual(['/api/search?q=coat&tab=all']);
    });

    it('FLOW-SEARCH-002 候補の確定で URL が変わると、その名前と種別で取り直す', async () => {
      mockSuggestions = [{ label: 'Wool Coat', type: 'look', href: '/look/1' }];
      searchReplies['/api/search?q=Wool+Coat&tab=look'] = { ok: true, body: payload() };
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option'));
      followReplace(rerender);

      // URLSearchParams が + で書いた空白を読み戻し、窓口へは %20 で符号化して渡す
      await waitFor(() => expect(searchCalls()).toContain('/api/search?q=Wool%20Coat&tab=look'));
      expect(tab('LOOK')).toHaveAttribute('aria-selected', 'true');
    });

    it('FLOW-SEARCH-002 語を打つだけでは /api/search を呼び直さない（候補の取り出しだけが動く）', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(searchCalls()).toHaveLength(1));

      await user.type(screen.getByRole('combobox'), 'xyz');

      expect(searchCalls()).toHaveLength(1);
    });

    it('FLOW-SEARCH-002 URL が変わらない再描画では取り直さない', async () => {
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(searchCalls()).toHaveLength(1));

      rerender(<SearchPageClient />);
      rerender(<SearchPageClient />);

      expect(searchCalls()).toHaveLength(1);
    });

    it('FLOW-SEARCH-002 URL の q が変わると入力欄をその値で詰め直し、打ちかけの語は捨てる', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);
      const input = screen.getByRole('combobox');
      expect(input).toHaveValue('coat');
      await user.type(input, 'xyz');
      expect(input).toHaveValue('coatxyz');

      mockSearch = 'q=wool&tab=all';
      rerender(<SearchPageClient />);

      await waitFor(() => expect(input).toHaveValue('wool'));
    });

    it('FLOW-SEARCH-002 語を空にして確定すると取り直し、入力欄も空になる', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);
      const input = screen.getByRole('combobox');
      await user.clear(input);
      await user.click(screen.getByRole('button', { name: '検索' }));
      followReplace(rerender);

      await waitFor(() => expect(searchCalls()).toContain('/api/search?q=&tab=all'));
      expect(input).toHaveValue('');
    });

    it('FLOW-SEARCH-002 語やタブが変わると LOAD MORE で足した行を8行に戻す', async () => {
      const items = Array.from({ length: 20 }, (_, index) => row('item', `i${index}`, `Coat ${index}`));
      const full = payload({ tab: 'item', items, counts: { all: 20, item: 20, look: 0, news: 0 } });
      searchReplies['/api/search?q=coat&tab=item'] = { ok: true, body: full };
      searchReplies['/api/search?q=wool&tab=item'] = { ok: true, body: full };
      mockSearch = 'q=coat&tab=item';
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);
      await screen.findAllByTestId('search-result-row');
      expect(screen.getAllByTestId('search-result-row')).toHaveLength(8);

      await user.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(screen.getAllByTestId('search-result-row')).toHaveLength(16);

      mockSearch = 'q=wool&tab=item';
      rerender(<SearchPageClient />);

      await waitFor(() => expect(searchCalls()).toContain('/api/search?q=wool&tab=item'));
      await waitFor(() => expect(screen.getAllByTestId('search-result-row')).toHaveLength(8));
    });
  });

  describe('取り出しの失敗と古い応答', () => {
    it('FLOW-SEARCH-002 応答が ok でなければ失敗を記録して「検索結果を読み込めませんでした」を出し、前の結果は消す', async () => {
      searchReplies['/api/search?q=wool&tab=all'] = { ok: false, body: payload() };
      searchReplies['/api/search?q=coat&tab=all'] = {
        ok: true,
        body: payload({ items: [row('item', 'a', 'Alpha Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
      };
      const { rerender } = render(<SearchPageClient />);
      expect(await screen.findByText('Alpha Piece')).toBeInTheDocument();

      mockSearch = 'q=wool&tab=all';
      rerender(<SearchPageClient />);

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('検索結果を読み込めませんでした'));
      expect(screen.queryByText('Alpha Piece')).not.toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch search results');
    });

    it('FLOW-SEARCH-002 取り出しが例外になっても同じく失敗の文を出し、画面は壊れない', async () => {
      mockFetch.mockImplementation(async (input: string) => {
        if (input.startsWith('/api/suggest')) {
          return { ok: true, json: async () => ({ suggestions: [] }) };
        }
        throw new Error('network');
      });
      render(<SearchPageClient />);

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('検索結果を読み込めませんでした'));
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(tab('ALL')).toBeInTheDocument();
    });

    it('FLOW-SEARCH-002 失敗の後に URL を替えて取り直しが成功すると、失敗の文は消えて結果が出る', async () => {
      searchReplies['/api/search?q=coat&tab=all'] = { ok: false, body: payload() };
      searchReplies['/api/search?q=wool&tab=all'] = {
        ok: true,
        body: payload({ items: [row('item', 'b', 'Beta Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
      };
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('検索結果を読み込めませんでした'));

      mockSearch = 'q=wool&tab=all';
      rerender(<SearchPageClient />);

      expect(await screen.findByText('Beta Piece')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    });

    it('FLOW-SEARCH-002 前の取り出しの応答が後から届いても取り消しの印で捨て、新しい語の結果を残す', async () => {
      const first = deferred<SearchReply>();
      const second = deferred<SearchReply>();
      searchReplies['/api/search?q=coat&tab=all'] = first;
      searchReplies['/api/search?q=wool&tab=all'] = second;
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(searchCalls()).toHaveLength(1));

      mockSearch = 'q=wool&tab=all';
      rerender(<SearchPageClient />);
      await waitFor(() => expect(searchCalls()).toHaveLength(2));

      await act(async () => {
        second.resolve({
          ok: true,
          body: payload({ items: [row('item', 'b', 'Beta Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
        });
      });
      expect(await screen.findByText('Beta Piece')).toBeInTheDocument();

      await act(async () => {
        first.resolve({
          ok: true,
          body: payload({ items: [row('item', 'a', 'Alpha Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
        });
      });

      expect(screen.queryByText('Alpha Piece')).not.toBeInTheDocument();
      expect(screen.getByText('Beta Piece')).toBeInTheDocument();
    });

    it('FLOW-SEARCH-002 前の取り出しの失敗が後から届いても、失敗の文は出さず記録もしない', async () => {
      const first = deferred<SearchReply>();
      searchReplies['/api/search?q=coat&tab=all'] = first;
      searchReplies['/api/search?q=wool&tab=all'] = {
        ok: true,
        body: payload({ items: [row('item', 'b', 'Beta Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
      };
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(searchCalls()).toHaveLength(1));

      mockSearch = 'q=wool&tab=all';
      rerender(<SearchPageClient />);
      expect(await screen.findByText('Beta Piece')).toBeInTheDocument();

      await act(async () => {
        first.resolve({ ok: false, body: payload() });
      });

      expect(screen.getByRole('alert')).toBeEmptyDOMElement();
      expect(screen.getByText('Beta Piece')).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch search results');
    });

    it('FLOW-SEARCH-002 取り出し中は結果の行の形の灰色の枠を5行出し、届くと結果に替わる', async () => {
      const pending = deferred<SearchReply>();
      searchReplies['/api/search?q=coat&tab=all'] = pending;
      const { container } = render(<SearchPageClient />);

      await waitFor(() => expect(container.querySelectorAll('[aria-hidden="true"] li')).toHaveLength(5));
      expect(screen.queryByTestId('search-result-row')).not.toBeInTheDocument();

      await act(async () => {
        pending.resolve({
          ok: true,
          body: payload({ items: [row('item', 'a', 'Alpha Piece')], counts: { all: 1, item: 1, look: 0, news: 0 } }),
        });
      });

      expect(await screen.findByTestId('search-result-row')).toBeInTheDocument();
      expect(container.querySelectorAll('[aria-hidden="true"] li')).toHaveLength(0);
    });
  });

  describe('確定の操作の入り口', () => {
    it('FLOW-SEARCH-002 フォームの送信は画面の遷移（ページ移動）を起こさず、置き換えだけにする', async () => {
      render(<SearchPageClient />);
      const form = screen.getByRole('combobox').closest('form') as HTMLFormElement;

      // 既定の動き（フォーム送信によるページ移動）が止められていれば fireEvent は false を返す
      const notPrevented = fireEvent.submit(form);

      expect(notPrevented).toBe(false);
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
