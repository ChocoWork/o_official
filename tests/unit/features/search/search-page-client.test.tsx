import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  SearchResult,
  SearchResultsResponse,
  SearchResultType,
  SearchSuggestion,
} from '@/features/search/types/search.types';

// URL の q・tab は文字列で持ち、描き直す前に差し替える
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

import { SearchPageClient } from '@/features/search/components/SearchPageClient';

type FakeResponse = { ok: boolean; json: () => Promise<unknown> };
type Reply = () => Promise<FakeResponse>;

const CASE_GUIDE =
  '気になる商品名やトピックを入力すると、商品・ルック・ニュースを横断した結果を表示します。';
const LOAD_ERROR = '検索結果を読み込めませんでした';

const fetchMock = jest.fn<Promise<FakeResponse>, [string, RequestInit?]>();

/** q の値ごとに窓口の応答を差し替える。無い q は `fallbackSearch` を使う */
let searchByQuery: Record<string, Reply> = {};
let fallbackSearch: Reply;
let suggestByQuery: Record<string, Reply> = {};
let fallbackSuggest: Reply;

function queryOf(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('q') ?? '';
}

function ok(body: unknown): Reply {
  return async () => ({ ok: true, json: async () => body });
}

function notOk(): Reply {
  return async () => ({ ok: false, json: async () => ({}) });
}

function never(): Reply {
  return () => new Promise<FakeResponse>(() => undefined);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function result(type: SearchResultType, id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    type,
    title: `${type}-${id}`,
    description: `${type}-${id}-description`,
    href: `/${type}/${id}`,
    imageUrl: null,
    meta: `${type}-${id}-meta`,
    ...overrides,
  };
}

function payload(parts: Partial<SearchResultsResponse> = {}): SearchResultsResponse {
  const items = parts.items ?? [];
  const looks = parts.looks ?? [];
  const news = parts.news ?? [];
  return {
    query: '',
    tab: 'all',
    items,
    looks,
    news,
    counts: {
      all: items.length + looks.length + news.length,
      item: items.length,
      look: looks.length,
      news: news.length,
    },
    popularItems: [],
    empty: false,
    ...parts,
  };
}

function suggestion(label: string, type: SearchResultType = 'item'): SearchSuggestion {
  return { label, type, href: `/${type}/${encodeURIComponent(label)}` };
}

function manyItems(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, index) => result('item', String(index + 1)));
}

function calls(prefix: string): string[] {
  return fetchMock.mock.calls.map((call) => call[0]).filter((url) => url.startsWith(prefix));
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('search-result-row');
}

function rowTitles(): string[] {
  return rows().map((row) => row.querySelectorAll('p')[1]?.textContent ?? '');
}

const openedChannels: Array<{ port1: { close(): void }; port2: { close(): void } }> = [];

afterAll(() => {
  for (const channel of openedChannels) {
    channel.port1.close();
    channel.port2.close();
  }
});

/** effect を流さない最初の描画だけを文字にする（react-dom/server が要る MessageChannel を足して読む） */
function renderFirstPass(element: React.ReactElement): string {
  const globalWithChannel = globalThis as unknown as { MessageChannel?: unknown };
  if (!globalWithChannel.MessageChannel) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MessageChannel } = require('worker_threads') as typeof import('worker_threads');
    // react-dom/server が作る口は開いたままだと worker が終わらないので、作った口を記録して終わりに閉じる
    globalWithChannel.MessageChannel = class extends MessageChannel {
      constructor() {
        super();
        openedChannels.push(this);
      }
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('react-dom/server') as typeof import('react-dom/server')).renderToString(element);
}

function setUrl(search: string) {
  mockSearch = search;
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole('combobox');
  await user.click(input);
  return { input, listbox: await screen.findByRole('listbox') };
}

describe('SearchPageClient', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSearch = '';
    mockReplace.mockReset();
    fetchMock.mockReset();
    searchByQuery = {};
    suggestByQuery = {};
    fallbackSearch = ok(payload());
    fallbackSuggest = ok({ suggestions: [] });
    fetchMock.mockImplementation((url) => {
      if (url.startsWith('/api/suggest')) {
        return (suggestByQuery[queryOf(url)] ?? fallbackSuggest)();
      }
      return (searchByQuery[queryOf(url)] ?? fallbackSearch)();
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('タブと取り出しの入口', () => {
    it.each([
      ['tab=item', 'ITEM'],
      ['tab=look', 'LOOK'],
      ['tab=news', 'NEWS'],
      ['tab=foo', 'ALL'],
      ['', 'ALL'],
    ])('DD-SEARCH-002 URL「%s」で %s のタブだけが aria-selected が真になる', async (search, selected) => {
      setUrl(search);
      render(<SearchPageClient />);

      const tabs = screen.getAllByRole('tab');
      expect(tabs.map((tab) => tab.textContent)).toEqual(['ALL', 'ITEM', 'LOOK', 'NEWS']);
      tabs.forEach((tab) =>
        expect(tab).toHaveAttribute('aria-selected', tab.textContent === selected ? 'true' : 'false'),
      );
      await waitFor(() => expect(calls('/api/search')).toHaveLength(1));
    });

    it('DD-SEARCH-002 語が無くても /api/search?q=&tab=all を no-store で呼び、入力欄が空', async () => {
      render(<SearchPageClient />);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/search?q=&tab=all', { cache: 'no-store' }),
      );
      expect(screen.getByRole('combobox')).toHaveValue('');
    });

    it('DD-SEARCH-002 q と tab を符号化して窓口に渡す', async () => {
      setUrl('q=a%26b%20c&tab=look');
      render(<SearchPageClient />);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/search?q=a%26b%20c&tab=look', { cache: 'no-store' }),
      );
    });

    it('DD-SEARCH-002 h1「SEARCH」を見出しとして描く', async () => {
      render(<SearchPageClient />);

      const heading = screen.getByRole('heading', { level: 1, name: 'SEARCH' });
      expect(heading).toHaveTextContent('SEARCH');
      await waitFor(() => expect(calls('/api/search')).toHaveLength(1));
    });

    it('DD-SEARCH-002 effect を流す前の最初の描画: q 無しは「POPULAR ITEMS」と案内文を出し、灰色の枠が無い', () => {
      setUrl('');
      const html = renderFirstPass(<SearchPageClient />);

      expect(html).toContain('POPULAR ITEMS');
      expect(html).toContain(CASE_GUIDE);
      expect(html).not.toContain('animate-pulse');
    });

    it('DD-SEARCH-002 effect を流す前の最初の描画: q=coat は「0 RESULTS」を出し、灰色の枠が無い', () => {
      setUrl('q=coat');
      const html = renderFirstPass(<SearchPageClient />);

      expect(html).toContain('0 RESULTS');
      expect(html).not.toContain('animate-pulse');
    });
  });

  describe('右のカラムの見せ方', () => {
    it('DD-SEARCH-002 語なし・人気商品ありは「POPULAR ITEMS」と人気商品の行を出し、強調しない', async () => {
      fallbackSearch = ok(
        payload({ popularItems: [result('item', 'p1', { title: 'Popular Coat' }), result('item', 'p2')] }),
      );
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(screen.queryByText(CASE_GUIDE)).not.toBeInTheDocument();
      expect(document.querySelectorAll('mark')).toHaveLength(0);
    });

    it('DD-SEARCH-002 語なし・取り出し中は「POPULAR ITEMS」だけで案内文を出さない', async () => {
      fallbackSearch = never();
      render(<SearchPageClient />);

      await waitFor(() => expect(calls('/api/search')).toHaveLength(1));
      expect(screen.getByText('POPULAR ITEMS')).toBeInTheDocument();
      expect(screen.queryByText(CASE_GUIDE)).not.toBeInTheDocument();
      expect(rows()).toHaveLength(0);
    });

    it('DD-SEARCH-002 語なし・人気商品なしは案内文を出す', async () => {
      fallbackSearch = ok(payload({ popularItems: [] }));
      render(<SearchPageClient />);

      expect(await screen.findByText(CASE_GUIDE)).toBeInTheDocument();
      expect(rows()).toHaveLength(0);
    });

    it('DD-SEARCH-002 語ありの取り出し中は aria-hidden の灰色の枠を5行出す', async () => {
      setUrl('q=coat');
      fallbackSearch = never();
      const { container } = render(<SearchPageClient />);

      await waitFor(() => expect(calls('/api/search')).toHaveLength(1));
      const skeleton = container.querySelector('div[aria-hidden="true"]');
      expect(skeleton).not.toBeNull();
      expect(skeleton?.querySelectorAll('li')).toHaveLength(5);
      expect(rows()).toHaveLength(0);
    });

    it('DD-SEARCH-002 結果が0件（empty が真）は「「coat」の検索結果はありません」と案内と人気商品の行を出す', async () => {
      setUrl('q=coat');
      fallbackSearch = ok(
        payload({ empty: true, popularItems: [result('item', 'p1', { title: 'Popular Coat' })] }),
      );
      render(<SearchPageClient />);

      expect(
        await screen.findByRole('heading', { level: 2, name: '「coat」の検索結果はありません' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText('別のキーワードをお試しください。人気商品もあわせてご覧いただけます。'),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'POPULAR ITEMS' })).toBeInTheDocument();
      expect(rowTitles()).toEqual(['Popular Coat']);
      expect(document.querySelectorAll('mark')).toHaveLength(0);
    });

    it('DD-SEARCH-002 ALL タブは商品・ルック・ニュースを1件ずつ交互に並べ、件数を「3 RESULTS」と出す', async () => {
      setUrl('q=zzz&tab=all');
      fallbackSearch = ok(
        payload({ items: [result('item', '1'), result('item', '2')], looks: [result('look', '1')], news: [] }),
      );
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(3));
      expect(rowTitles()).toEqual(['item-1', 'look-1', 'item-2']);
      expect(screen.getByText('3 RESULTS')).toBeInTheDocument();
    });

    it('DD-SEARCH-002 ALL タブは商品・ルック・ニュースの順で交互に並べる（3種そろう場合）', async () => {
      setUrl('q=zzz&tab=all');
      fallbackSearch = ok(
        payload({
          items: [result('item', '1')],
          looks: [result('look', '1')],
          news: [result('news', '1')],
        }),
      );
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(3));
      expect(rowTitles()).toEqual(['item-1', 'look-1', 'news-1']);
    });

    it.each([
      ['item', ['item-1', 'item-2']],
      ['look', ['look-1']],
      ['news', ['news-1', 'news-2', 'news-3']],
    ])('DD-SEARCH-002 tab=%s はその種別の配列だけを出す', async (tab, expected) => {
      setUrl(`q=zzz&tab=${tab}`);
      fallbackSearch = ok(
        payload({
          items: [result('item', '1'), result('item', '2')],
          looks: [result('look', '1')],
          news: [result('news', '1'), result('news', '2'), result('news', '3')],
        }),
      );
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(expected.length));
      expect(rowTitles()).toEqual(expected);
    });

    it('DD-SEARCH-002 結果が全部空で empty が偽なら「0 RESULTS」の見出しを出す', async () => {
      setUrl('q=zzz');
      fallbackSearch = ok(payload({ empty: false }));
      render(<SearchPageClient />);

      expect(await screen.findByText('0 RESULTS')).toBeInTheDocument();
      expect(rows()).toHaveLength(0);
    });
  });

  describe('結果の行', () => {
    it('DD-SEARCH-002 画像ありの行は alt 空の img を出し、種別の名前・題・メタ・href を出す', async () => {
      setUrl('q=zzz');
      fallbackSearch = ok(
        payload({
          items: [result('item', '1', { imageUrl: 'https://example.test/a.png', title: 'Wool Coat', meta: '¥1,000' })],
        }),
      );
      const { container } = render(<SearchPageClient />);

      const row = (await screen.findAllByTestId('search-result-row'))[0];
      const image = row.querySelector('img');
      expect(image).toHaveAttribute('src', 'https://example.test/a.png');
      expect(image).toHaveAttribute('alt', '');
      expect(within(row).getByText('ITEM')).toBeInTheDocument();
      expect(within(row).getByText('Wool Coat')).toBeInTheDocument();
      expect(within(row).getByText('¥1,000')).toBeInTheDocument();
      expect(within(row).getByRole('link')).toHaveAttribute('href', '/item/1');
      expect(container.querySelectorAll('img')).toHaveLength(1);
    });

    it('DD-SEARCH-002 画像なしの行は枠だけで img を出さない。ルックとニュースの種別の名前を出す', async () => {
      setUrl('q=zzz');
      fallbackSearch = ok(payload({ looks: [result('look', '1')], news: [result('news', '1')] }));
      const { container } = render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(within(rows()[0]).getByText('LOOK')).toBeInTheDocument();
      expect(within(rows()[1]).getByText('NEWS')).toBeInTheDocument();
    });

    it('DD-SEARCH-002 窓口が3種の外の種別を返した行は、種別の名前を空にして題とメタだけを出す', async () => {
      setUrl('q=zzz');
      // 窓口の JSON は実行の時に型の保証が無いので、知らない種別の行も壊れずに描く
      const unknown = result('item', '1', { type: 'foo' as unknown as SearchResultType });
      fallbackSearch = ok(payload({ items: [unknown] }));
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(rows()[0].querySelectorAll('p')[0].textContent).toBe('');
      expect(rows()[0]).toHaveTextContent('item-1');
      expect(rows()[0]).toHaveTextContent('item-1-meta');
    });

    it('DD-SEARCH-002 q=Co で題「coat COAT」の合う2か所を mark で包み、メタは強調しない', async () => {
      setUrl('q=Co');
      fallbackSearch = ok(payload({ items: [result('item', '1', { title: 'coat COAT', meta: 'coat meta' })] }));
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      const marks = Array.from(document.querySelectorAll('mark')).map((mark) => mark.textContent);
      expect(marks).toEqual(['co', 'CO']);
      expect(rows()[0]).toHaveTextContent('coat COAT');
    });

    it('DD-SEARCH-002 q の前後の空白を除いて強調する', async () => {
      setUrl('q=%20co%20');
      fallbackSearch = ok(payload({ items: [result('item', '1', { title: 'coat' })] }));
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(Array.from(document.querySelectorAll('mark')).map((mark) => mark.textContent)).toEqual(['co']);
    });

    it('DD-SEARCH-002 空白だけの q は強調せず、題をそのまま出す', async () => {
      setUrl('q=%20%20');
      fallbackSearch = ok(payload({ items: [result('item', '1', { title: 'coat' })] }));
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(document.querySelectorAll('mark')).toHaveLength(0);
      expect(rowTitles()).toEqual(['coat']);
    });

    it('DD-SEARCH-002 q の正規表現の記号を逃がして、例外にならず a.(b だけを mark にする', async () => {
      setUrl('q=a.(b');
      fallbackSearch = ok(payload({ items: [result('item', '1', { title: 'xa.(by' })] }));
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      const marks = Array.from(document.querySelectorAll('mark')).map((mark) => mark.textContent);
      expect(marks).toEqual(['a.(b']);
    });

    it('DD-SEARCH-002 題の HTML は文字として出し、img 要素を増やさない', async () => {
      setUrl('q=zzz');
      const title = '<img src=x onerror=alert(1)>';
      fallbackSearch = ok(payload({ items: [result('item', '1', { title })] }));
      const { container } = render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(container.querySelectorAll('img')).toHaveLength(0);
    });
  });

  describe('LOAD MORE', () => {
    it('DD-SEARCH-002 ALL で9行なら8行と LOAD MORE を出し、押すと9行になって LOAD MORE が消える', async () => {
      setUrl('q=zzz');
      fallbackSearch = ok(payload({ items: manyItems(9) }));
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(8));
      await user.click(screen.getByRole('button', { name: 'LOAD MORE' }));

      expect(rows()).toHaveLength(9);
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 ちょうど8行なら LOAD MORE を出さない', async () => {
      setUrl('q=zzz');
      fallbackSearch = ok(payload({ items: manyItems(8) }));
      render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(8));
      expect(screen.queryByRole('button', { name: 'LOAD MORE' })).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 押して16行にした後、tab が変わると8行に戻る', async () => {
      setUrl('q=zzz&tab=all');
      fallbackSearch = ok(payload({ items: manyItems(17) }));
      const user = userEvent.setup();
      const { rerender } = render(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(8));
      await user.click(screen.getByRole('button', { name: 'LOAD MORE' }));
      expect(rows()).toHaveLength(16);

      setUrl('q=zzz&tab=item');
      rerender(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(8));
      // タブを替えるだけでは取り直さない（SEC-SEARCH-005）
      expect(calls('/api/search')).toHaveLength(1);
    });
  });

  describe('結果の取り出しの失敗と取り消し', () => {
    it('DD-SEARCH-002 結果の応答が ok でなければ失敗の文と「0 RESULTS」を出し、console.error に書く', async () => {
      setUrl('q=coat');
      fallbackSearch = notOk();
      render(<SearchPageClient />);

      expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR);
      expect(screen.getByText('0 RESULTS')).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch search results');
    });

    it('DD-SEARCH-002 結果が 429（本文は使わない）でも、no-store の応答を開いたまま残さないよう本文を読み切る', async () => {
      setUrl('q=coat');
      const drain = jest.fn().mockResolvedValue(new ArrayBuffer(0));
      fallbackSearch = async () => ({ ok: false, json: async () => ({}), status: 429, arrayBuffer: drain }) as FakeResponse;
      render(<SearchPageClient />);

      expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_ERROR);
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('DD-SEARCH-002 取り出しが reject し q が無いなら、失敗の文と案内文が並ぶ', async () => {
      fallbackSearch = async () => {
        throw new Error('network');
      };
      render(<SearchPageClient />);

      expect(await screen.findByText(LOAD_ERROR)).toBeInTheDocument();
      expect(screen.getByText(CASE_GUIDE)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('DD-SEARCH-002 応答の JSON の解析が失敗しても失敗の文を出す', async () => {
      setUrl('q=coat');
      fallbackSearch = async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      });
      render(<SearchPageClient />);

      expect(await screen.findByText(LOAD_ERROR)).toBeInTheDocument();
    });

    it('DD-SEARCH-002 失敗の後に成功すると失敗の文を消して結果を出す', async () => {
      setUrl('q=bad');
      searchByQuery = {
        bad: notOk(),
        good: ok(payload({ items: [result('item', '1')] })),
      };
      const { rerender } = render(<SearchPageClient />);
      expect(await screen.findByText(LOAD_ERROR)).toBeInTheDocument();

      setUrl('q=good');
      rerender(<SearchPageClient />);

      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(screen.queryByText(LOAD_ERROR)).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 取り出しの最中に q が変わると、前の成功の応答は捨てて後の結果のまま', async () => {
      const first = deferred<FakeResponse>();
      setUrl('q=a');
      searchByQuery = {
        a: () => first.promise,
        b: ok(payload({ items: [result('item', 'from-b')] })),
      };
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(calls('/api/search')).toHaveLength(1));

      setUrl('q=b');
      rerender(<SearchPageClient />);
      await waitFor(() => expect(rowTitles()).toEqual(['item-from-b']));

      await act(async () => {
        first.resolve({ ok: true, json: async () => payload({ items: [result('item', 'from-a')] }) });
        await first.promise;
      });

      expect(rowTitles()).toEqual(['item-from-b']);
    });

    it('DD-SEARCH-002 取り出しの最中に q が変わると、前の失敗の応答は失敗の文にも読み込み中にも書かない', async () => {
      const first = deferred<FakeResponse>();
      setUrl('q=a');
      searchByQuery = {
        a: () => first.promise,
        b: ok(payload({ items: [result('item', 'from-b')] })),
      };
      const { rerender } = render(<SearchPageClient />);
      await waitFor(() => expect(calls('/api/search')).toHaveLength(1));

      setUrl('q=b');
      rerender(<SearchPageClient />);
      await waitFor(() => expect(rowTitles()).toEqual(['item-from-b']));

      await act(async () => {
        first.reject(new Error('late failure'));
        await first.promise.catch(() => undefined);
      });

      expect(screen.queryByText(LOAD_ERROR)).not.toBeInTheDocument();
      expect(rowTitles()).toEqual(['item-from-b']);
    });

    it('DD-SEARCH-002 q が変わると入力欄を新しい q に詰め直し、tab が変わると取り直す', async () => {
      setUrl('q=first&tab=all');
      const { rerender } = render(<SearchPageClient />);
      expect(screen.getByRole('combobox')).toHaveValue('first');

      setUrl('q=second&tab=news');
      rerender(<SearchPageClient />);

      expect(screen.getByRole('combobox')).toHaveValue('second');
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/search?q=second&tab=news', { cache: 'no-store' }),
      );
    });
  });

  describe('候補の取り出し', () => {
    it('DD-SEARCH-002 入力 co で /api/suggest?q=co を no-store で呼ぶ', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), 'co');

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/suggest?q=co', {
          cache: 'no-store',
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('DD-SEARCH-002 入力欄の値は前後の空白を除かずに符号化して送る', async () => {
      setUrl('q=%20co');
      render(<SearchPageClient />);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/suggest?q=%20co', {
          cache: 'no-store',
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('DD-SEARCH-002 空白だけの入力では /api/suggest を呼ばず、候補を出さない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), '  ');

      expect(calls('/api/suggest')).toHaveLength(0);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 候補の応答が ok でなければ候補を出さず console.error に書く', async () => {
      setUrl('q=co');
      fallbackSuggest = notOk();
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(screen.getByRole('combobox'));

      await waitFor(() =>
        expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch search suggestions'),
      );
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 候補が 429（本文は使わない）でも、no-store の応答を開いたまま残さないよう本文を読み切る', async () => {
      setUrl('q=co');
      const drain = jest.fn().mockResolvedValue(new ArrayBuffer(0));
      fallbackSuggest = async () => ({ ok: false, json: async () => ({}), status: 429, arrayBuffer: drain }) as FakeResponse;
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(screen.getByRole('combobox'));

      await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    });

    it('DD-SEARCH-002 候補の取り出しが reject しても候補を出さず console.error に書く', async () => {
      setUrl('q=co');
      fallbackSuggest = async () => {
        throw new Error('network');
      };
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(screen.getByRole('combobox'));

      await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 候補の応答に suggestions が無ければ空の候補で、エラーを書かない', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({});
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(screen.getByRole('combobox'));

      await waitFor(() => expect(calls('/api/suggest')).toHaveLength(1));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('DD-SEARCH-002 入力が変わった後に前の成功の応答が届いても、前の候補を入れない', async () => {
      const first = deferred<FakeResponse>();
      suggestByQuery = {
        c: () => first.promise,
        co: ok({ suggestions: [suggestion('Coat')] }),
      };
      const user = userEvent.setup();
      render(<SearchPageClient />);

      const input = screen.getByRole('combobox');
      await user.type(input, 'co');
      expect(await screen.findByRole('option')).toHaveTextContent(/Coat/);

      await act(async () => {
        first.resolve({ ok: true, json: async () => ({ suggestions: [suggestion('Stale')] }) });
        await first.promise;
      });

      expect(screen.queryByText('Stale')).not.toBeInTheDocument();
      expect(screen.getByRole('option')).toHaveTextContent(/Coat/);
    });

    it('DD-SEARCH-002 入力が変わった後に前の失敗の応答が届いても、今の候補を消さない', async () => {
      const first = deferred<FakeResponse>();
      suggestByQuery = {
        c: () => first.promise,
        co: ok({ suggestions: [suggestion('Coat')] }),
      };
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), 'co');
      expect(await screen.findByRole('option')).toHaveTextContent(/Coat/);

      await act(async () => {
        first.reject(new Error('late failure'));
        await first.promise.catch(() => undefined);
      });

      expect(screen.getByRole('option')).toHaveTextContent(/Coat/);
    });

    it('DD-SEARCH-002 入力が空白だけに変わると、出ていた候補を消す', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);

      const { input } = await openList(user);
      await user.clear(input);
      await user.type(input, '  ');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  describe('候補のドロップダウン', () => {
    it('DD-SEARCH-002 候補が10件でも option は8つで、「8 件の検索候補があります」を読み上げる', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({
        suggestions: Array.from({ length: 10 }, (_, index) => suggestion(`Coat ${index + 1}`)),
      });
      const user = userEvent.setup();
      render(<SearchPageClient />);

      const { listbox } = await openList(user);

      expect(within(listbox).getAllByRole('option')).toHaveLength(8);
      expect(screen.getByRole('status')).toHaveTextContent('8 件の検索候補があります');
    });

    it('DD-SEARCH-002 リストが閉じている間は読み上げの文が空で aria-expanded が偽', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      render(<SearchPageClient />);

      await waitFor(() => expect(calls('/api/suggest')).toHaveLength(1));
      expect(screen.getByRole('status')).toHaveTextContent('');
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
    });

    it('DD-SEARCH-002 触れていない・空白だけ・候補0件のどれでも開かず、3つそろった時だけ listbox を開く', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      // 触れていない
      await waitFor(() => expect(calls('/api/suggest')).toHaveLength(1));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      // 空白だけ
      await user.click(input);
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      await user.clear(input);
      await user.type(input, '  ');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      // 候補0件
      fallbackSuggest = ok({ suggestions: [] });
      await user.clear(input);
      await user.type(input, 'zz');
      await waitFor(() => expect(calls('/api/suggest').at(-1)).toBe('/api/suggest?q=zz'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      // 3つそろう
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      await user.clear(input);
      await user.type(input, 'co');
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'true');
    });

    it('DD-SEARCH-002 候補のラベルは合う所とほかを別の要素で描き分け、右に種別の名前を出す', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({
        suggestions: [suggestion('Coat', 'item'), suggestion('Cotton', 'look'), suggestion('Colour', 'news')],
      });
      const user = userEvent.setup();
      render(<SearchPageClient />);

      const { listbox } = await openList(user);

      const options = within(listbox).getAllByRole('option');
      const spans = Array.from(options[0].querySelectorAll('span span')).filter((span) => span.textContent !== '');
      expect(spans.map((span) => span.textContent)).toEqual(['Co', 'at']);
      expect(spans[0].className).not.toBe(spans[1].className);
      expect(options[0]).toHaveTextContent('ITEM');
      expect(options[1]).toHaveTextContent('LOOK');
      expect(options[2]).toHaveTextContent('NEWS');
    });

    it('DD-SEARCH-002 ↓ を4回押すと選択が 0・1・2・0 と巡回し、aria-activedescendant が合う', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B'), suggestion('Coat C')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input, listbox } = await openList(user);
      const options = within(listbox).getAllByRole('option');

      for (const expected of [0, 1, 2, 0]) {
        await user.keyboard('{ArrowDown}');
        expect(input).toHaveAttribute('aria-activedescendant', `search-suggestion-${expected}`);
        options.forEach((option, index) =>
          expect(option).toHaveAttribute('aria-selected', index === expected ? 'true' : 'false'),
        );
      }
    });

    it('DD-SEARCH-002 未選択で ↑ を押すと末尾（2）、続けて ↑ で 1 になる', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B'), suggestion('Coat C')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.keyboard('{ArrowUp}');
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-2');
      await user.keyboard('{ArrowUp}');
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-1');
    });

    it('DD-SEARCH-002 先頭（0）で ↑ を押すと末尾（2）に戻る', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B'), suggestion('Coat C')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.keyboard('{ArrowDown}');
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');
      await user.keyboard('{ArrowUp}');
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-2');
    });

    it('DD-SEARCH-002 選択ありの Enter は入力欄を候補の名前にして URL を置き換え、リストを閉じる', async () => {
      setUrl('q=co&tab=all');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat', 'look')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.keyboard('{ArrowDown}{Enter}');

      expect(input).toHaveValue('Coat');
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=Coat&tab=look', { scroll: false });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });

    it('DD-SEARCH-002 選択なしの Enter はフォームの送信に任せ、入力欄の値と今のタブで置き換える', async () => {
      setUrl('tab=news');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');

      await user.type(input, 'coat');
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
      await user.keyboard('{Enter}');

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?tab=news&q=coat', { scroll: false });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 候補をクリックすると入力欄を候補の名前にして名前と種別で URL を置き換える', async () => {
      setUrl('q=co&tab=all');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B', 'news')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input, listbox } = await openList(user);

      await user.click(within(listbox).getAllByRole('option')[1]);

      expect(input).toHaveValue('Coat B');
      expect(mockReplace).toHaveBeenCalledWith('/search?q=Coat+B&tab=news', { scroll: false });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 候補に mouseenter すると、その行が aria-selected 真になり、ほかの行は偽のまま', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { listbox } = await openList(user);
      const options = within(listbox).getAllByRole('option');
      expect(options[1]).toHaveAttribute('aria-selected', 'false');

      fireEvent.mouseEnter(options[1]);

      expect(options[1]).toHaveAttribute('aria-selected', 'true');
      expect(options[0]).toHaveAttribute('aria-selected', 'false');
    });

    it('DD-SEARCH-002 開いている時の Escape はリストを閉じて選択を戻す', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}');
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'false');
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });

    it('DD-SEARCH-002 閉じている時の Escape も例外にならず閉じたまま', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');
      await user.click(input);

      await user.keyboard('{Escape}');

      expect(input).toHaveAttribute('aria-expanded', 'false');
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });

    it('DD-SEARCH-002 開いている時の Tab はリストを閉じる', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);

      await user.keyboard('{Tab}');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 閉じている時の ↓ は何も変えない', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{Escape}');

      await user.keyboard('{ArrowDown}');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(input).not.toHaveAttribute('aria-activedescendant');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('DD-SEARCH-002 開いている時のそのほかのキーは選択を変えない', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}');

      fireEvent.keyDown(input, { key: 'Home' });

      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('DD-SEARCH-002 検索の箱の外への mousedown は閉じ、箱の中への mousedown は閉じない', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      fireEvent.mouseDown(input);
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('DD-SEARCH-002 開いている間だけ mousedown の聞き手を付け、閉じると外す', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const addSpy = jest.spyOn(document, 'addEventListener');
      const removeSpy = jest.spyOn(document, 'removeEventListener');
      try {
        const user = userEvent.setup();
        render(<SearchPageClient />);
        await waitFor(() => expect(calls('/api/suggest')).toHaveLength(1));
        expect(addSpy.mock.calls.filter(([type]) => type === 'mousedown')).toHaveLength(0);

        await openList(user);
        expect(addSpy.mock.calls.filter(([type]) => type === 'mousedown')).toHaveLength(1);

        await user.keyboard('{Escape}');
        expect(removeSpy.mock.calls.filter(([type]) => type === 'mousedown')).toHaveLength(1);
      } finally {
        addSpy.mockRestore();
        removeSpy.mockRestore();
      }
    });

    it('DD-SEARCH-002 ↓ の後に1字足すと選択を戻し、aria-activedescendant が無くなる', async () => {
      setUrl('q=co');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat A'), suggestion('Coat B')] });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}');
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');

      await user.keyboard('a');

      expect(input).toHaveValue('coa');
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });
  });

  describe('確定', () => {
    it('DD-SEARCH-002 入力「  coat  」の送信は前後の空白を除き、ほかの引数を残して q と tab を入れる', async () => {
      setUrl('foo=1');
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), '  coat  ');
      await user.click(screen.getByRole('button', { name: '検索' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?foo=1&q=coat&tab=all', { scroll: false });
    });

    it('DD-SEARCH-002 入力を空にして送信すると q を消して tab だけにする', async () => {
      setUrl('q=coat&tab=all');
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.clear(screen.getByRole('combobox'));
      await user.click(screen.getByRole('button', { name: '検索' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?tab=all', { scroll: false });
    });

    it('DD-SEARCH-002 NEWS のタブは URL の今の q と押したタブで確定し、入力欄の未送信の語は使わない', async () => {
      setUrl('q=coat&tab=all');
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.type(screen.getByRole('combobox'), 'xyz');
      await user.click(screen.getByRole('tab', { name: 'NEWS' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=news', { scroll: false });
    });

    it('DD-SEARCH-002 q が無い URL でタブを押すと q を足さず tab だけを入れる', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(screen.getByRole('tab', { name: 'LOOK' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?tab=look', { scroll: false });
    });

    it('DD-SEARCH-002 確定しても localStorage と sessionStorage に書かない', async () => {
      setUrl('q=co&foo=1');
      fallbackSuggest = ok({ suggestions: [suggestion('Coat')] });
      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
      try {
        const user = userEvent.setup();
        render(<SearchPageClient />);
        await openList(user);
        await user.keyboard('{ArrowDown}{Enter}');
        await user.click(screen.getByRole('button', { name: '検索' }));

        expect(mockReplace).toHaveBeenCalledTimes(2);
        expect(setItemSpy).not.toHaveBeenCalled();
      } finally {
        setItemSpy.mockRestore();
      }
    });
  });

  describe('候補の待ちと打ち切り・検索の取り直し（SEC-SEARCH-005）', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    async function flush() {
      await act(async () => {
        await Promise.resolve();
      });
    }

    async function advance(ms: number) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
      await flush();
    }

    async function typeValue(input: HTMLElement, value: string) {
      await act(async () => {
        fireEvent.change(input, { target: { value } });
      });
    }

    function suggestSignals(): AbortSignal[] {
      return fetchMock.mock.calls
        .filter((call) => call[0].startsWith('/api/suggest'))
        .map((call) => call[1]?.signal as AbortSignal);
    }

    it('DD-SEARCH-002 5文字を20ミリ秒間隔で打つと、止まって250ミリ秒たつまで候補を呼ばず、最後の語で1回だけ呼ぶ', async () => {
      render(<SearchPageClient />);
      await flush();
      const input = screen.getByRole('combobox');

      for (const value of ['c', 'co', 'coa', 'coat', 'coats']) {
        await typeValue(input, value);
        await advance(20);
      }
      await advance(200);
      expect(calls('/api/suggest')).toHaveLength(0);

      await advance(50);
      expect(calls('/api/suggest')).toEqual(['/api/suggest?q=coats']);
    });

    it('DD-SEARCH-002 入力を空にすると待たずに候補が消え、候補を呼ばない', async () => {
      suggestByQuery = { co: ok({ suggestions: [suggestion('Coat')] }) };
      render(<SearchPageClient />);
      await flush();
      const input = screen.getByRole('combobox');
      await act(async () => {
        fireEvent.focus(input);
      });
      await typeValue(input, 'co');
      await advance(250);
      expect(screen.getByRole('option')).toHaveTextContent(/Coat/);

      await typeValue(input, '');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      await advance(1000);
      expect(calls('/api/suggest')).toHaveLength(1);
    });

    it('DD-SEARCH-002 新しい入力で前の候補の要求を打ち切り、遅れて返った前の応答で候補を上書きしない', async () => {
      const first = deferred<FakeResponse>();
      suggestByQuery = {
        c: () => first.promise,
        co: ok({ suggestions: [suggestion('Coat')] }),
      };
      render(<SearchPageClient />);
      await flush();
      const input = screen.getByRole('combobox');
      await act(async () => {
        fireEvent.focus(input);
      });

      await typeValue(input, 'c');
      await advance(250);
      const [firstSignal] = suggestSignals();
      expect(firstSignal.aborted).toBe(false);

      await typeValue(input, 'co');
      expect(firstSignal.aborted).toBe(true);
      await advance(250);
      expect(screen.getByRole('option')).toHaveTextContent(/Coat/);

      await act(async () => {
        first.resolve({ ok: true, json: async () => ({ suggestions: [suggestion('Stale')] }) });
        await first.promise;
      });

      expect(screen.queryByText('Stale')).not.toBeInTheDocument();
      expect(screen.getByRole('option')).toHaveTextContent(/Coat/);
    });

    it('DD-SEARCH-002 打ち切られた要求の失敗は console.error に書かない', async () => {
      fetchMock.mockImplementation((url, init) => {
        if (url === '/api/suggest?q=c') {
          return new Promise<FakeResponse>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return url.startsWith('/api/suggest') ? ok({ suggestions: [] })() : ok(payload())();
      });
      render(<SearchPageClient />);
      await flush();
      const input = screen.getByRole('combobox');

      await typeValue(input, 'c');
      await advance(250);
      await typeValue(input, 'co');
      await advance(250);

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('DD-SEARCH-002 アンマウントで待ち中の候補を呼ばない', async () => {
      const { unmount } = render(<SearchPageClient />);
      await flush();

      await typeValue(screen.getByRole('combobox'), 'c');
      unmount();
      await advance(1000);

      expect(calls('/api/suggest')).toHaveLength(0);
    });

    it('DD-SEARCH-002 アンマウントで呼んだ後の候補の要求を打ち切る', async () => {
      suggestByQuery = { co: never() };
      const { unmount } = render(<SearchPageClient />);
      await flush();
      await typeValue(screen.getByRole('combobox'), 'co');
      await advance(250);
      const [signal] = suggestSignals();
      expect(signal.aborted).toBe(false);

      unmount();

      expect(signal.aborted).toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('DD-SEARCH-002 タブを ALL から ITEM に替えても /api/search を取り直さず、語を替えると1回増えて URL の tab は最新のタブ', async () => {
      setUrl('q=zzz&tab=all');
      const { rerender } = render(<SearchPageClient />);
      await flush();
      expect(calls('/api/search')).toEqual(['/api/search?q=zzz&tab=all']);

      setUrl('q=zzz&tab=item');
      rerender(<SearchPageClient />);
      await flush();
      expect(calls('/api/search')).toHaveLength(1);

      setUrl('q=yyy&tab=item');
      rerender(<SearchPageClient />);
      await flush();
      expect(calls('/api/search')).toEqual(['/api/search?q=zzz&tab=all', '/api/search?q=yyy&tab=item']);
    });
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
