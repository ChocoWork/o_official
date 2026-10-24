import React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  SearchResult,
  SearchResultsResponse,
  SearchResultType,
  SearchSuggestion,
} from '@/features/search/types/search.types';

// URL の q・tab は固定で渡す（候補のドロップダウンの描画だけを見るので、移動は見ない）
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

const emptyResults: SearchResultsResponse = {
  query: '',
  tab: 'all',
  items: [],
  looks: [],
  news: [],
  counts: { all: 0, item: 0, look: 0, news: 0 },
  popularItems: [],
  empty: false,
};

function suggestion(label: string, type: SearchResultType = 'item'): SearchSuggestion {
  return { label, type, href: `/${type}/${encodeURIComponent(label)}` };
}

type SuggestReply =
  | { kind: 'ok'; suggestions?: SearchSuggestion[] }
  | { kind: 'status'; ok: false }
  | { kind: 'throw' };

let mockSuggestReply: SuggestReply = { kind: 'ok', suggestions: [] };
const mockFetch = jest.fn();

function installFetch() {
  mockFetch.mockImplementation(async (input: string) => {
    if (input.startsWith('/api/suggest')) {
      if (mockSuggestReply.kind === 'throw') {
        throw new Error('network');
      }
      if (mockSuggestReply.kind === 'status') {
        return { ok: false, json: async () => ({}) };
      }
      const body = mockSuggestReply.suggestions === undefined ? {} : { suggestions: mockSuggestReply.suggestions };
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => emptyResults satisfies SearchResultsResponse };
  });
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
}

function suggestCalls(): string[] {
  return mockFetch.mock.calls.map((call) => call[0] as string).filter((url) => url.startsWith('/api/suggest'));
}

function setSuggestions(suggestions: SearchSuggestion[]) {
  mockSuggestReply = { kind: 'ok', suggestions };
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole('combobox');
  await user.click(input);
  return { input, listbox: await screen.findByRole('listbox') };
}

describe('SCR-SEARCH-003 入力中の候補のドロップダウン', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSearch = 'q=coat&tab=all';
    mockSuggestReply = { kind: 'ok', suggestions: [] };
    mockFetch.mockReset();
    mockReplace.mockReset();
    installFetch();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    window.localStorage.clear();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('SCR-SEARCH-003 入力欄が combobox の属性（aria-controls・aria-autocomplete・autoComplete 無効）を持ち、閉じている間は aria-expanded が偽で選択の指定が無い', async () => {
    setSuggestions([suggestion('Coat A')]);
    render(<SearchPageClient />);

    const input = screen.getByRole('combobox', { name: 'Search' });
    expect(input).toHaveAttribute('aria-controls', 'search-suggestion-list');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await waitFor(() => expect(suggestCalls()).toHaveLength(1));
  });

  it('SCR-SEARCH-003 入力欄に触れると候補が listbox（名前「検索候補」・id が aria-controls と一致）に option として並び、aria-expanded が真になる', async () => {
    setSuggestions([suggestion('Coat A'), suggestion('Coat B', 'look')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { input, listbox } = await openList(user);

    expect(listbox).toHaveAttribute('id', 'search-suggestion-list');
    expect(listbox).toHaveAccessibleName('検索候補');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Coat A');
    expect(options[1]).toHaveTextContent('Coat B');
    options.forEach((option) => expect(option).toHaveAttribute('type', 'button'));
  });

  it('SCR-SEARCH-003 リストは入力欄の下に重ねて出し、左右に 1px ずつ広げて下のタブを押し下げない', async () => {
    setSuggestions([suggestion('Coat A')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(listbox).toHaveClass('absolute', 'top-full', '-left-px', '-right-px');
    // タブは候補のリストと同じ箱の外にあり、リストが開いても別の枠のまま
    expect(listbox.parentElement).not.toContainElement(screen.getByRole('tablist'));
  });

  it('SCR-SEARCH-003 候補は最大 8 件に切って出す', async () => {
    setSuggestions(Array.from({ length: 10 }, (_, index) => suggestion(`Coat ${index}`)));
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(within(listbox).getAllByRole('option')).toHaveLength(8);
    expect(listbox).not.toHaveTextContent('Coat 8');
    expect(within(listbox).getAllByRole('option')[7]).toHaveTextContent('Coat 7');
  });

  it('SCR-SEARCH-003 候補の行は高さ 40px 以上で、右端に種別の名前を出す', async () => {
    setSuggestions([suggestion('Coat A', 'item'), suggestion('Coat B', 'look'), suggestion('Coat C', 'news')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    const options = within(listbox).getAllByRole('option');
    options.forEach((option) => expect(option).toHaveClass('min-h-10'));
    expect(within(options[0]).getByText('ITEM')).toBeInTheDocument();
    expect(within(options[1]).getByText('LOOK')).toBeInTheDocument();
    expect(within(options[2]).getByText('NEWS')).toBeInTheDocument();
  });

  it('SCR-SEARCH-003 ラベルは語に合う所を黒の太字、ほかを #474747 で描き分ける（大文字と小文字を区別しない）', async () => {
    mockSearch = 'q=coat&tab=all';
    setSuggestions([suggestion('Wool COAT long')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    const option = within(listbox).getByRole('option');
    const matched = within(option).getByText('COAT');
    expect(matched).toHaveClass('font-medium', 'text-black');
    expect(within(option).getByText('Wool')).toHaveClass('text-[#474747]');
    expect(within(option).getByText('long')).toHaveClass('text-[#474747]');
  });

  it('SCR-SEARCH-003 選んでいない行は aria-selected が偽で透明な縦線の枠だけを持ち、入力欄に aria-activedescendant が無い', async () => {
    setSuggestions([suggestion('Coat A'), suggestion('Coat B')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { input, listbox } = await openList(user);

    within(listbox).getAllByRole('option').forEach((option) => {
      expect(option).toHaveAttribute('aria-selected', 'false');
      expect(option).toHaveClass('border-l-2', 'border-transparent');
      expect(option).not.toHaveClass('border-black');
    });
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('SCR-SEARCH-003 選んだ行は aria-selected が真で、薄い面と黒の縦線を持ち、入力欄の aria-activedescendant がその行の id を指す', async () => {
    setSuggestions([suggestion('Coat A'), suggestion('Coat B')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { input, listbox } = await openList(user);
    await user.keyboard('{ArrowDown}{ArrowDown}');

    const options = within(listbox).getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveClass('border-black', 'bg-black/4');
    expect(options[1]).toHaveClass('border-l-2');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-1');
    expect(options[1]).toHaveAttribute('id', 'search-suggestion-1');
  });

  it('SCR-SEARCH-003 リストが開いている間は「N 件の検索候補があります」を aria-live の polite で伝え、閉じると空にする', async () => {
    setSuggestions([suggestion('Coat A'), suggestion('Coat B'), suggestion('Coat C')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveClass('sr-only');
    expect(status).toHaveTextContent('');

    await openList(user);
    expect(status).toHaveTextContent('3 件の検索候補があります');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(status).toHaveTextContent('');
  });

  it('SCR-SEARCH-003 読み上げの件数は 8 件に切った後の数を言う', async () => {
    setSuggestions(Array.from({ length: 12 }, (_, index) => suggestion(`Coat ${index}`)));
    const user = userEvent.setup();
    render(<SearchPageClient />);

    await openList(user);

    expect(screen.getByRole('status')).toHaveTextContent('8 件の検索候補があります');
  });

  it('SCR-SEARCH-003 入力が変わるたびに待たず、最小の字数も置かずに 1 文字目から /api/suggest を呼ぶ（前後の空白を除かずに符号化して no-store で送る）', async () => {
    mockSearch = '';
    setSuggestions([suggestion('a')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);
    const input = screen.getByRole('combobox');

    expect(suggestCalls()).toHaveLength(0);

    await user.type(input, 'a');
    await waitFor(() => expect(suggestCalls()).toEqual(['/api/suggest?q=a']));

    await user.type(input, ' b');
    await waitFor(() =>
      expect(suggestCalls()).toEqual(['/api/suggest?q=a', '/api/suggest?q=a%20', '/api/suggest?q=a%20b']),
    );
    mockFetch.mock.calls
      .filter((call) => (call[0] as string).startsWith('/api/suggest'))
      .forEach((call) => expect(call[1]).toEqual({ cache: 'no-store' }));
  });

  it('SCR-SEARCH-003 空白だけの入力は取り出さずに候補を消す', async () => {
    mockSearch = 'q=coat&tab=all';
    setSuggestions([suggestion('Coat A')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);
    await waitFor(() => expect(suggestCalls()).toHaveLength(1));

    const { input } = await openList(user);
    const before = suggestCalls().length;
    fireEvent.change(input, { target: { value: '   ' } });

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(suggestCalls()).toHaveLength(before);
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('SCR-SEARCH-003 入力を空にするとリストを閉じる', async () => {
    setSuggestions([suggestion('Coat A')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { input } = await openList(user);
    await user.clear(input);

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('SCR-SEARCH-003 応答に suggestions が無ければ空の候補として扱いリストを出さない', async () => {
    mockSuggestReply = { kind: 'ok' };
    const user = userEvent.setup();
    render(<SearchPageClient />);
    await waitFor(() => expect(suggestCalls()).toHaveLength(1));

    await user.click(screen.getByRole('combobox'));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('SCR-SEARCH-003 候補の応答が ok でなければ失敗を記録して候補を消す', async () => {
    mockSuggestReply = { kind: 'status', ok: false };
    const user = userEvent.setup();
    render(<SearchPageClient />);

    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch search suggestions:', expect.any(Error)),
    );
    await user.click(screen.getByRole('combobox'));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('SCR-SEARCH-003 候補の取り出しが例外になっても失敗を記録して候補を消し、画面は壊れない', async () => {
    mockSuggestReply = { kind: 'throw' };
    const user = userEvent.setup();
    render(<SearchPageClient />);

    await waitFor(() =>
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch search suggestions:', expect.any(Error)),
    );
    await user.click(screen.getByRole('combobox'));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('SCR-SEARCH-003 失敗の後に入力を変えて取り出しが成功すれば候補が戻る', async () => {
    mockSuggestReply = { kind: 'throw' };
    const user = userEvent.setup();
    render(<SearchPageClient />);
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    const input = screen.getByRole('combobox');
    await user.click(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    setSuggestions([suggestion('Coats')]);
    fireEvent.change(input, { target: { value: 'coats' } });

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('SCR-SEARCH-003 候補はサーバーの候補だけで、端末に残った履歴を混ぜない', async () => {
    window.localStorage.setItem('searchHistory', JSON.stringify(['coat history']));
    window.localStorage.setItem('search-history', JSON.stringify(['coat history']));
    setSuggestions([suggestion('Coat A')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    expect(within(listbox).queryByText(/history/)).not.toBeInTheDocument();
  });

  it('SCR-SEARCH-003 候補のラベルは HTML として解釈せず文字のまま出す', async () => {
    mockSearch = 'q=img&tab=all';
    setSuggestions([suggestion('<img src=x onerror=alert(1)> tag')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(listbox.querySelector('img')).toBeNull();
    expect(listbox).toHaveTextContent('<img src=x onerror=alert(1)> tag');
  });

  it('SCR-SEARCH-003 正規表現の記号を含む語でも例外にならず、その字に合う所を強調する', async () => {
    mockSearch = 'q=' + encodeURIComponent('a+(b') + '&tab=all';
    setSuggestions([suggestion('xa+(by')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(within(listbox).getByText('a+(b')).toHaveClass('font-medium', 'text-black');
    expect(within(listbox).getByText('x')).toHaveClass('text-[#474747]');
    expect(within(listbox).getByText('y')).toHaveClass('text-[#474747]');
  });

  it('SCR-SEARCH-003 入力の語は前後の空白を除いて強調に使う', async () => {
    mockSearch = 'q=' + encodeURIComponent('  coat  ') + '&tab=all';
    setSuggestions([suggestion('Wool coat')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(within(listbox).getByText('coat')).toHaveClass('font-medium', 'text-black');
  });

  it('SCR-SEARCH-003 候補を押すと入力欄をその名前にしてリストを閉じる', async () => {
    setSuggestions([suggestion('Coat A', 'look')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { input, listbox } = await openList(user);
    await user.click(within(listbox).getByRole('option'));

    expect(input).toHaveValue('Coat A');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('SCR-SEARCH-003 候補の上にマウスを載せるとその行が選ばれた見た目になる', async () => {
    setSuggestions([suggestion('Coat A'), suggestion('Coat B')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { input, listbox } = await openList(user);
    const options = within(listbox).getAllByRole('option');
    await user.hover(options[1]);

    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveClass('border-black', 'bg-black/4');
    expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-1');
  });

  it('SCR-SEARCH-003 同じ種別・同じ名前の候補を 2 件含めても画面が描ける（一意な鍵は種別と名前の組）', async () => {
    setSuggestions([suggestion('Coat A', 'item'), suggestion('Coat A', 'look')]);
    const user = userEvent.setup();
    render(<SearchPageClient />);

    const { listbox } = await openList(user);

    expect(within(listbox).getAllByRole('option')).toHaveLength(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

// 型の確認用（SearchResult を使う場面が無くても import の型が崩れていないことを tsc に確かめさせる）
export type _SearchResultShape = SearchResult;

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
