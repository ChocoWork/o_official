import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  SearchResultsResponse,
  SearchResultType,
  SearchSuggestion,
} from '@/features/search/types/search.types';

// URL の q・tab は固定で渡す（候補の開閉と選択の位置だけを見るので、URL の移動は replace の呼び出しで見る）
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

let mockSuggestions: SearchSuggestion[] = [];
// 候補の応答を止めておく門。null なら即座に返す
let mockSuggestGate: Promise<void> | null = null;
const mockFetch = jest.fn();

function installFetch() {
  mockFetch.mockImplementation(async (input: string) => {
    if (input.startsWith('/api/suggest')) {
      if (mockSuggestGate) {
        await mockSuggestGate;
      }
      return { ok: true, json: async () => ({ suggestions: mockSuggestions }) };
    }
    return { ok: true, json: async () => emptyResults };
  });
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
}

function suggestCalls(): string[] {
  return mockFetch.mock.calls.map((call) => call[0] as string).filter((url) => url.startsWith('/api/suggest'));
}

function threeSuggestions() {
  return [suggestion('Coat A'), suggestion('Coat B'), suggestion('Coat C', 'look')];
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByRole('combobox');
  await user.click(input);
  return { input, listbox: await screen.findByRole('listbox') };
}

function selectedIds(): string[] {
  return screen
    .queryAllByRole('option')
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map((option) => option.id);
}

describe('STATE-SEARCH-002 入力中の候補のリストの開閉と選択の位置', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockSearch = 'q=coat&tab=all';
    mockSuggestions = threeSuggestions();
    mockSuggestGate = null;
    mockFetch.mockReset();
    mockReplace.mockReset();
    installFetch();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('開く条件（触れている・語が空でない・候補が1件以上の3つがそろう時だけ）', () => {
    it('STATE-SEARCH-002 語も候補もあっても入力欄に触れていなければ閉じたままで、触れると開く', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(suggestCalls()).toHaveLength(1));
      // 候補の応答が画面に届くまで待つ
      await act(async () => undefined);

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');

      const { input } = await openList(user);
      expect(input).toHaveAttribute('aria-expanded', 'true');
    });

    it('STATE-SEARCH-002 触れていて候補があっても語が空なら開かない（候補の取り出しもしない）', async () => {
      mockSearch = '';
      const user = userEvent.setup();
      render(<SearchPageClient />);

      await user.click(screen.getByRole('combobox'));

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(suggestCalls()).toHaveLength(0);
    });

    it('STATE-SEARCH-002 語が空白だけなら触れていても開かない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const input = screen.getByRole('combobox');
      await user.click(input);
      await screen.findByRole('listbox');

      fireEvent.change(input, { target: { value: '   ' } });

      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('STATE-SEARCH-002 触れていて語があっても候補が0件なら開かない', async () => {
      mockSuggestions = [];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(suggestCalls()).toHaveLength(1));

      await user.click(screen.getByRole('combobox'));

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
    });

    it('STATE-SEARCH-002 触れている間に候補の応答が後から届くと、届いた時点で開く', async () => {
      let release: () => void = () => undefined;
      mockSuggestGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      await act(async () => {
        release();
      });

      expect(await screen.findByRole('listbox')).toBeInTheDocument();
    });

    it('STATE-SEARCH-002 開いている間に候補が0件に変わると閉じる', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      mockSuggestions = [];
      await user.type(input, 'x');

      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('STATE-SEARCH-002 語を空にすると閉じ、語を戻して候補が届けば同じ触れた状態のまま再び開く', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.clear(input);
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

      await user.type(input, 'c');
      expect(await screen.findByRole('listbox')).toBeInTheDocument();
    });
  });

  describe('↓↑ による選択の位置（未選択・巡回）', () => {
    it('STATE-SEARCH-002 開いた直後はどの行も選ばれていない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);

      const { input } = await openList(user);

      expect(selectedIds()).toEqual([]);
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });

    it('STATE-SEARCH-002 未選択からの ↓ は先頭を選び、続けて下へ進み、末尾の次は先頭へ巡回する', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-0');

      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-1']);

      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-2']);

      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);
    });

    it('STATE-SEARCH-002 未選択からの ↑ は末尾を選び、続けて上へ進み、先頭の次は末尾へ巡回する', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.keyboard('{ArrowUp}');
      expect(selectedIds()).toEqual(['search-suggestion-2']);
      expect(input).toHaveAttribute('aria-activedescendant', 'search-suggestion-2');

      await user.keyboard('{ArrowUp}');
      expect(selectedIds()).toEqual(['search-suggestion-1']);

      await user.keyboard('{ArrowUp}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);

      await user.keyboard('{ArrowUp}');
      expect(selectedIds()).toEqual(['search-suggestion-2']);
    });

    it('STATE-SEARCH-002 巡回の範囲は8件に切った後の数（10件あっても末尾は8件目）', async () => {
      mockSuggestions = Array.from({ length: 10 }, (_, index) => suggestion(`Coat ${index}`));
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);

      await user.keyboard('{ArrowUp}');
      expect(selectedIds()).toEqual(['search-suggestion-7']);

      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);
    });

    it('STATE-SEARCH-002 候補が1件だけなら ↓↑ のどちらでも同じ行に留まる', async () => {
      mockSuggestions = [suggestion('Coat A')];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);

      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);

      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);
    });

    it('STATE-SEARCH-002 開いている間の ↓↑ は既定の動き（入力欄のカーソル移動）を止める', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      // fireEvent は既定の動きが止められていなければ true を返す
      expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(false);
      expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(false);
    });

    it('STATE-SEARCH-002 閉じている間の ↓↑ は選択を変えず既定の動きも止めない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(suggestCalls()).toHaveLength(1));
      const input = screen.getByRole('combobox');

      expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true);
      expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(true);

      expect(input).not.toHaveAttribute('aria-activedescendant');
      // 触れてから開いても、閉じている間のキーは選択に効いていない
      await user.click(input);
      await screen.findByRole('listbox');
      expect(selectedIds()).toEqual([]);
    });

    it('STATE-SEARCH-002 触れた行（マウスを載せた行）が選択になり、次の ↓ はそこから進む', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);
      const options = screen.getAllByRole('option');

      await user.hover(options[1]);
      expect(selectedIds()).toEqual(['search-suggestion-1']);

      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-2']);

      await user.hover(options[0]);
      expect(selectedIds()).toEqual(['search-suggestion-0']);
    });
  });

  describe('選択を未選択に戻す（入力が変わる・触れている印が変わる）', () => {
    it('STATE-SEARCH-002 選んだ後に入力が変わると選択が外れ、前の候補を選んだまま確定しない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-1']);

      await user.type(input, 'z');

      expect(input).toHaveValue('coatz');
      expect(input).not.toHaveAttribute('aria-activedescendant');
      expect(selectedIds()).toEqual([]);

      // 外れた後の Enter は候補の確定ではなく、入力欄の語での送信になる
      await user.keyboard('{Enter}');
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=coatz&tab=all', { scroll: false });
    });

    it('STATE-SEARCH-002 閉じて開き直すと選択は未選択から始まる', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-0']);

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

      // 入力欄から外して触れ直す（触れている印が偽から真へ変わる）
      await user.click(document.body);
      await user.click(input);

      await screen.findByRole('listbox');
      expect(selectedIds()).toEqual([]);
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });
  });

  describe('Enter（選んだ候補があればその候補で確定し、無ければフォームの送信に任せる）', () => {
    it('STATE-SEARCH-002 選んだ候補がある Enter は送信を止め、その候補の名前と種別で確定して閉じる', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(selectedIds()).toEqual(['search-suggestion-2']);

      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

      expect(input).toHaveValue('Coat C');
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=Coat+C&tab=look', { scroll: false });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });

    it('STATE-SEARCH-002 選んだ候補がある Enter を実際に押しても確定は1回だけでフォームの送信を重ねない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);
      await user.keyboard('{ArrowDown}{Enter}');

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=Coat+A&tab=item', { scroll: false });
    });

    it('STATE-SEARCH-002 何も選んでいない Enter は既定の動きを止めず、フォームの送信で入力欄の語で確定して閉じる', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
      await user.keyboard('{Enter}');

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=all', { scroll: false });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    });

    it('STATE-SEARCH-002 閉じている間の Enter も候補では確定せず、入力欄の語の送信になる', async () => {
      mockSuggestions = [];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(suggestCalls()).toHaveLength(1));
      const input = screen.getByRole('combobox');
      await user.type(input, '{Enter}');

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=all', { scroll: false });
    });

    it('STATE-SEARCH-002 送信ボタンを押しても閉じ、入力欄の語で確定する', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);

      await user.click(screen.getByRole('button', { name: '検索' }));

      expect(mockReplace).toHaveBeenCalledWith('/search?q=coat&tab=all', { scroll: false });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    });

    it('STATE-SEARCH-002 候補の行を押して確定すると閉じて選択も戻る', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      await user.click(screen.getAllByRole('option')[1]);

      expect(input).toHaveValue('Coat B');
      expect(mockReplace).toHaveBeenCalledWith('/search?q=Coat+B&tab=item', { scroll: false });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(input).not.toHaveAttribute('aria-activedescendant');
    });
  });

  describe('Escape・Tab・外を押す（閉じる）', () => {
    it('STATE-SEARCH-002 Escape で閉じ、選択を外し、入力欄の語はそのまま残す', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{ArrowDown}');

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(input).toHaveAttribute('aria-expanded', 'false');
      expect(input).not.toHaveAttribute('aria-activedescendant');
      expect(input).toHaveValue('coat');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('STATE-SEARCH-002 閉じた後に語を打ち足しても、触れ直すまでは開き直さない', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

      await user.type(input, 's');
      await waitFor(() => expect(suggestCalls()).toContain('/api/suggest?q=coats'));

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('STATE-SEARCH-002 リストが閉じていても Escape は触れている印を外し、後から届いた候補で開かない', async () => {
      let release: () => void = () => undefined;
      mockSuggestGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await user.click(screen.getByRole('combobox'));
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

      await user.keyboard('{Escape}');
      await act(async () => {
        release();
      });

      // 触れている印を外した後は、候補が届いても開かない
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
    });

    it('STATE-SEARCH-002 Tab で閉じ、フォーカスは次の要素へ移る', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await openList(user);

      await user.keyboard('{Tab}');

      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: '検索' })).toHaveFocus();
    });

    it('STATE-SEARCH-002 Tab は開いている時だけ閉じる動きになり、閉じている間は何も変えない', async () => {
      mockSuggestions = [];
      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(suggestCalls()).toHaveLength(1));
      const input = screen.getByRole('combobox');

      expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
      expect(input).toHaveAttribute('aria-expanded', 'false');
      await user.click(input);
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('STATE-SEARCH-002 リストの外を押す（mousedown）と閉じる', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);

      fireEvent.mouseDown(document.body);

      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });

    it('STATE-SEARCH-002 リストの中・入力欄を押しても閉じない（候補の選択を妨げない）', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input, listbox } = await openList(user);

      fireEvent.mouseDown(screen.getAllByRole('option')[0]);
      fireEvent.mouseDown(listbox);
      fireEvent.mouseDown(input);

      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-expanded', 'true');
    });

    it('STATE-SEARCH-002 外を押して閉じた後、入力欄を触れ直すと開く', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const { input } = await openList(user);
      fireEvent.mouseDown(document.body);
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

      // フォーカスが入力欄に残っていると focus が起きないので、一度外す
      await user.click(document.body);
      await user.click(input);

      expect(await screen.findByRole('listbox')).toBeInTheDocument();
    });
  });

  describe('外を押す見張りは開いている間だけ', () => {
    it('STATE-SEARCH-002 mousedown の見張りは開いた時に付き、閉じた時に外れる', async () => {
      const addSpy = jest.spyOn(document, 'addEventListener');
      const removeSpy = jest.spyOn(document, 'removeEventListener');
      const mousedownAdds = () => addSpy.mock.calls.filter(([type]) => type === 'mousedown').length;
      const mousedownRemoves = () => removeSpy.mock.calls.filter(([type]) => type === 'mousedown').length;

      const user = userEvent.setup();
      render(<SearchPageClient />);
      await waitFor(() => expect(suggestCalls()).toHaveLength(1));
      await act(async () => undefined);
      // 閉じている間は付けない
      expect(mousedownAdds()).toBe(0);

      await openList(user);
      expect(mousedownAdds()).toBe(1);
      expect(mousedownRemoves()).toBe(0);

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(mousedownRemoves()).toBe(1);
    });

    it('STATE-SEARCH-002 部品を外す時にも見張りを外す', async () => {
      const removeSpy = jest.spyOn(document, 'removeEventListener');
      const user = userEvent.setup();
      const { unmount } = render(<SearchPageClient />);
      await openList(user);
      const before = removeSpy.mock.calls.filter(([type]) => type === 'mousedown').length;

      unmount();

      expect(removeSpy.mock.calls.filter(([type]) => type === 'mousedown').length).toBe(before + 1);
    });
  });

  describe('開いている間の読み上げ', () => {
    it('STATE-SEARCH-002 読み上げの件数は開いている間だけ伝え、閉じると空に戻る', async () => {
      const user = userEvent.setup();
      render(<SearchPageClient />);
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('');

      await openList(user);
      expect(status).toHaveTextContent('3 件の検索候補があります');

      fireEvent.mouseDown(document.body);
      await waitFor(() => expect(status).toHaveTextContent(''));
      expect(within(status).queryByText(/件の検索候補/)).not.toBeInTheDocument();
    });
  });
});

// このファイルが差し替える global.fetch を、終わった後に元へ戻す
const originalFetchBeforeTests = (global as unknown as { fetch: unknown }).fetch;

afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetchBeforeTests;
});
