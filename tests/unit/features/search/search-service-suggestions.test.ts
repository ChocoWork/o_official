import { getResultTypeLabel, getSearchSuggestions } from '@/features/search/services/search.service';
import type { SearchResultType } from '@/features/search/types/search.types';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.Mock;
const mockedCreateServiceRoleClient = createServiceRoleClient as jest.Mock;

type RpcResult = { data?: unknown; error?: unknown };

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Wool Coat',
    description: null,
    category: 'Outer',
    image_url: null,
    price: 12000,
    ...overrides,
  };
}

function look(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    season_year: 2026,
    season_type: 'SS',
    theme: 'Coat Walk',
    theme_description: null,
    image_urls: null,
    ...overrides,
  };
}

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Coat Arrives',
    category: 'Info',
    image_url: null,
    content: 'New arrivals',
    published_date: '2026-01-02',
    ...overrides,
  };
}

let rpc: jest.Mock;
let consoleError: jest.SpyInstance;

function setup(results: Record<string, RpcResult> = {}) {
  const table: Record<string, RpcResult> = {
    search_items: { data: [], error: null },
    search_looks: { data: [], error: null },
    search_news: { data: [], error: null },
    ...results,
  };
  rpc = jest.fn(async (name: string) => table[name]);
  mockedCreateClient.mockResolvedValue({ rpc });
}

beforeEach(() => {
  jest.clearAllMocks();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  setup();
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('getSearchSuggestions', () => {
  it('DD-SEARCH-007 空白だけの語は空の一覧で、client も作らない', async () => {
    const result = await getSearchSuggestions('  ');

    expect(result).toEqual([]);
    expect(mockedCreateClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-007 上限を渡さなければ3種とも limit_count 8 で呼ぶ', async () => {
    await getSearchSuggestions('co');

    expect(rpc).toHaveBeenCalledTimes(3);
    for (const name of ['search_items', 'search_looks', 'search_news']) {
      expect(rpc).toHaveBeenCalledWith(name, { search_query: 'co', limit_count: 8 });
    }
  });

  it('DD-SEARCH-007 語の前後の空白を除いて上限と一緒に3種へ渡し、service role は使わない', async () => {
    await getSearchSuggestions(' co ', 5);

    for (const name of ['search_items', 'search_looks', 'search_news']) {
      expect(rpc).toHaveBeenCalledWith(name, { search_query: 'co', limit_count: 5 });
    }
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-007 名前・テーマ・題が語を含む行を種別ごとの href の候補にする', async () => {
    setup({
      search_items: { data: [item({ name: 'Wool Coat & Co' })], error: null },
      search_looks: { data: [look({ theme: 'Coat Walk' })], error: null },
      search_news: { data: [article({ title: 'Coat Arrives' })], error: null },
    });

    const result = await getSearchSuggestions('coat');

    expect(result).toEqual(
      expect.arrayContaining([
        { label: 'Wool Coat & Co', type: 'item', href: `/search?q=${encodeURIComponent('Wool Coat & Co')}&tab=item` },
        { label: 'Coat Walk', type: 'look', href: `/search?q=${encodeURIComponent('Coat Walk')}&tab=look` },
        { label: 'Coat Arrives', type: 'news', href: `/search?q=${encodeURIComponent('Coat Arrives')}&tab=news` },
      ]),
    );
    expect(result).toHaveLength(3);
  });

  it('DD-SEARCH-007 説明・本文だけに語がありラベルに語が無い行は候補にしない', async () => {
    setup({
      search_items: { data: [item({ name: 'Jacket', description: 'like a coat' })], error: null },
      search_looks: { data: [look({ theme: 'Walk', theme_description: 'coat season' })], error: null },
      search_news: { data: [article({ title: 'Notice', content: 'coat arrives' })], error: null },
    });

    const result = await getSearchSuggestions('coat');

    expect(result).toEqual([]);
  });

  it('DD-SEARCH-007 語を含まない行は点が0で候補にしない', async () => {
    setup({
      search_items: { data: [item({ name: 'Shirt', description: 'Cotton', category: 'Tops' })], error: null },
      search_looks: { data: [look({ theme: 'Beach', theme_description: 'Sand' })], error: null },
      search_news: { data: [article({ title: 'Sale', content: 'Everything' })], error: null },
    });

    const result = await getSearchSuggestions('coat');

    expect(result).toEqual([]);
  });

  it('DD-SEARCH-007 同じ種別で同じ名前の重なりは1つにし、別の種別の同じ名前は残す', async () => {
    setup({
      search_items: {
        data: [item({ id: 1, name: 'Coat' }), item({ id: 2, name: 'Coat' })],
        error: null,
      },
      search_looks: { data: [look({ id: 1, theme: 'Coat' })], error: null },
    });

    const result = await getSearchSuggestions('coat');

    expect(result.filter((suggestion) => suggestion.type === 'item')).toHaveLength(1);
    expect(result.filter((suggestion) => suggestion.type === 'look')).toHaveLength(1);
    expect(result).toHaveLength(2);
  });

  it('DD-SEARCH-007 点の高い順に並べ、上限で切り、点を落として返す', async () => {
    // 点は題が語で始まる行が一番高く、題に語を含み説明にも語がある行、題に語を含むだけの行の順に低くなる。
    // 点の高い2行を入力の後ろに置き、並べ替えと上限の切りの順番まで確かめる。
    const lowScored = Array.from({ length: 8 }, (_, index) =>
      item({ id: index + 1, name: `${'x'.repeat(index + 1)} coat`, description: null }),
    );
    const items = [
      ...lowScored,
      item({ id: 9, name: 'y coat', description: 'coat' }),
      item({ id: 10, name: 'Coat', description: null }),
    ];
    setup({ search_items: { data: items, error: null } });

    const result = await getSearchSuggestions('coat', 8);

    expect(result.map((suggestion) => suggestion.label)).toEqual([
      'Coat',
      'y coat',
      'x coat',
      'xx coat',
      'xxx coat',
      'xxxx coat',
      'xxxxx coat',
      'xxxxxx coat',
    ]);
    for (const suggestion of result) {
      expect(Object.keys(suggestion).sort()).toEqual(['href', 'label', 'type']);
    }
  });

  it('DD-SEARCH-007 検索の関数が誤りか data なしを返しても空の一覧で、誤りは関数名と符号だけ記録する', async () => {
    setup({
      search_items: { data: null, error: { message: 'down secretword', code: '42501' } },
      search_looks: { data: null, error: null },
      search_news: { data: undefined, error: { message: 'down' } },
    });

    const result = await getSearchSuggestions('secretword');

    expect(result).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_items', name: 'UnknownError', code: '42501' });
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_news', name: 'UnknownError', code: null });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secretword');
  });

  it('DD-SEARCH-007 search_news だけ失敗しても他の2種の候補は返り、投げない（SEC-SEARCH-017）', async () => {
    setup({
      search_items: { data: [item({ name: 'Coat item' })], error: null },
      search_looks: { data: [{ id: 3, season_year: 2026, season_type: 'SS', theme: 'Coat look', theme_description: null, image_urls: null }], error: null },
      search_news: { data: null, error: { message: 'news down', code: '57014' } },
    });

    const result = await getSearchSuggestions('coat');

    expect(result.map((suggestion) => suggestion.type).sort()).toEqual(['item', 'look']);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_news', name: 'UnknownError', code: '57014' });
  });

  it('DD-SEARCH-007 client の作成が投げたら例外がそのまま出る', async () => {
    mockedCreateClient.mockRejectedValue(new Error('no client'));

    await expect(getSearchSuggestions('coat')).rejects.toThrow('no client');
  });
});

describe('getResultTypeLabel', () => {
  it('DD-SEARCH-008 item・look・news は ITEM・LOOK・NEWS を返す', () => {
    expect(getResultTypeLabel('item')).toBe('ITEM');
    expect(getResultTypeLabel('look')).toBe('LOOK');
    expect(getResultTypeLabel('news')).toBe('NEWS');
  });

  it('DD-SEARCH-008 型の外の値は空の文字を返す', () => {
    expect(getResultTypeLabel('foo' as unknown as SearchResultType)).toBe('');
  });
});
