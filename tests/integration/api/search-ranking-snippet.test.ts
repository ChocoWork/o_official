export {};

// 並べ替えと説明の切り出し（取り出しの関数 executeSearch・getSearchSuggestions）を、
// DB の関数が返した行を順不同で渡して、返る順と中身で確かめる。
// 差し替えるのは外との境目（Supabase の client）だけ。画像は付けないので署名は動かない
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { executeSearch, getSearchSuggestions } = require('@/features/search/services/search.service');

type Row = Record<string, unknown>;

function item(overrides: Row = {}): Row {
  return { id: 1, name: 'Wool coat', description: null, category: 'Outer', image_url: null, price: 12800, ...overrides };
}

function look(overrides: Row = {}): Row {
  return {
    id: 1,
    season_year: 2025,
    season_type: 'AW',
    theme: 'Coat season',
    theme_description: null,
    image_urls: null,
    ...overrides,
  };
}

function news(overrides: Row = {}): Row {
  return {
    id: 1,
    title: 'Coat restock',
    category: 'INFO',
    image_url: null,
    content: 'coat is back',
    published_date: '2025-03-01',
    ...overrides,
  };
}

function mockDb(rows: { items?: Row[]; looks?: Row[]; news?: Row[] }) {
  const results: Record<string, Row[]> = {
    search_items: rows.items ?? [],
    search_looks: rows.looks ?? [],
    search_news: rows.news ?? [],
  };
  const rpc = jest.fn(async (name: string) => ({ data: results[name] ?? [], error: null }));
  createClient.mockResolvedValue({ rpc });
  createServiceRoleClient.mockResolvedValue({ rpc: jest.fn(async () => ({ data: [], error: null })) });
  return rpc;
}

async function searchItems(query: string, items: Row[], limitPerType?: number) {
  mockDb({ items });
  return executeSearch({ query, limitPerType });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('点の順に並べる', () => {
  it('ARC-SEARCH-002 題が語で始まる物、題に含む物、ほかの欄だけに含む物の順に並べ、DB の順は使わない', async () => {
    const response = await searchItems('coat', [
      item({ id: 1, name: 'Wool coat' }),
      item({ id: 2, name: 'Shirt', description: 'a coat shirt' }),
      item({ id: 3, name: 'Coat long' }),
    ]);

    expect(response.items.map((r: { id: string }) => r.id)).toEqual(['3', '1', '2']);
  });

  it('ARC-SEARCH-002 語全体も全部の語も当たらない行は点が 0 なので捨てる', async () => {
    const response = await searchItems('coat', [item({ id: 1, name: 'Shirt', description: 'cotton', category: 'Tops' })]);

    expect(response.items).toEqual([]);
    expect(response.counts.all).toBe(0);
  });

  it('ARC-SEARCH-002 語全体は無くても全部の語が離れて当たる行は残し、1語しか当たらない行は捨てる', async () => {
    const response = await searchItems('wool coat', [
      item({ id: 1, name: 'Wool scarf', description: 'knit' }),
      item({ id: 2, name: 'Coat wool' }),
    ]);

    expect(response.items.map((r: { id: string }) => r.id)).toEqual(['2']);
  });

  it('ARC-SEARCH-002 語全体が当たる行は、離れた語だけが当たる行より先に出す', async () => {
    const response = await searchItems('wool coat', [
      item({ id: 1, name: 'Coat wool' }),
      item({ id: 2, name: 'Fine wool coat' }),
    ]);

    expect(response.items.map((r: { id: string }) => r.id)).toEqual(['2', '1']);
  });

  it('ARC-SEARCH-002 ルックはテーマとテーマの説明、ニュースは題・本文・分類の欄で当てる', async () => {
    mockDb({
      looks: [look({ id: 1, theme: 'Zzz', theme_description: 'a coat look' }), look({ id: 2, theme: 'Zzz', theme_description: 'none' })],
      news: [
        news({ id: 1, title: 'Zzz', content: 'abc', category: 'coat' }),
        news({ id: 2, title: 'Zzz', content: 'abc', category: 'none' }),
      ],
    });

    const response = await executeSearch({ query: 'coat' });

    expect(response.looks.map((r: { id: string }) => r.id)).toEqual(['1']);
    expect(response.news.map((r: { id: string }) => r.id)).toEqual(['1']);
  });

  it('ARC-SEARCH-002 ルックとニュースも点の順に並べる', async () => {
    mockDb({
      looks: [look({ id: 1, theme: 'Warm coat' }), look({ id: 2, theme: 'Coat walk' })],
      news: [news({ id: 1, title: 'New coat', content: '' }), news({ id: 2, title: 'Coat news', content: '' })],
    });

    const response = await executeSearch({ query: 'coat' });

    expect(response.looks.map((r: { id: string }) => r.id)).toEqual(['2', '1']);
    expect(response.news.map((r: { id: string }) => r.id)).toEqual(['2', '1']);
  });
});

describe('件数と空の判定', () => {
  it('ARC-SEARCH-002 種別ごとの上限で点の高い方から切り、counts は切った後の数にする', async () => {
    const response = await searchItems(
      'coat',
      [
        item({ id: 1, name: 'Wool coat' }),
        item({ id: 2, name: 'Shirt', description: 'coat' }),
        item({ id: 3, name: 'Coat long' }),
      ],
      2,
    );

    expect(response.items.map((r: { id: string }) => r.id)).toEqual(['3', '1']);
    expect(response.counts).toEqual({ all: 2, item: 2, look: 0, news: 0 });
  });

  it('ARC-SEARCH-002 上限の指定が無ければ1種別6件で切り、上限は DB の関数にも渡す', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => item({ id: index + 1, name: `Coat ${index + 1}` }));
    const rpc = mockDb({ items: rows });

    const response = await executeSearch({ query: 'coat' });

    expect(response.items).toHaveLength(6);
    expect(rpc).toHaveBeenCalledWith('search_items', { search_query: 'coat', limit_count: 6 });
  });

  it('ARC-SEARCH-002 counts.all は3種の合計で、1種でも結果があれば empty は偽', async () => {
    mockDb({ items: [item()], looks: [], news: [news({ id: 5 })] });

    const response = await executeSearch({ query: 'coat' });

    expect(response.counts).toEqual({ all: 2, item: 1, look: 0, news: 1 });
    expect(response.empty).toBe(false);
  });

  it('ARC-SEARCH-002 3種とも0件なら empty は真', async () => {
    mockDb({});

    const response = await executeSearch({ query: 'coat' });

    expect(response.counts).toEqual({ all: 0, item: 0, look: 0, news: 0 });
    expect(response.empty).toBe(true);
  });

});

describe('説明の切り出し', () => {
  const longDescription = (before: number, after: number) => `${'a'.repeat(before)}coat${'b'.repeat(after)}`;

  it('ARC-SEARCH-002 一致の前28字・後68字を切り、両側が切れた時は両側に「…」を付ける', async () => {
    const response = await searchItems('coat', [item({ name: 'Zzz', description: longDescription(40, 100) })]);

    expect(response.items[0].description).toBe(`…${'a'.repeat(28)}coat${'b'.repeat(68)}…`);
  });

  it('ARC-SEARCH-002 商品の説明が無い時はカテゴリを返す', async () => {
    const response = await searchItems('coat', [item({ description: null, category: 'Outer' })]);
    expect(response.items[0].description).toBe('Outer');
  });

  it('ARC-SEARCH-002 ニュースは本文から切り出し、本文に語が無い時は分類を返す', async () => {
    mockDb({
      news: [
        news({ id: 1, title: 'Zzz', content: 'x'.repeat(40) + 'coat' + 'y'.repeat(100) }),
        news({ id: 2, title: 'Coat', content: 'nothing', category: 'INFO' }),
      ],
    });

    const response = await executeSearch({ query: 'coat' });
    const byId = Object.fromEntries(response.news.map((r: { id: string }) => [r.id, r]));

    expect(byId['1'].description).toBe(`…${'x'.repeat(28)}coat${'y'.repeat(68)}…`);
    expect(byId['2'].description).toBe('INFO');
  });
});

describe('メタと行き先', () => {
  it('ARC-SEARCH-002 商品は「¥」とカンマ区切りの価格、ルックは年とシーズン、ニュースは公開日を「.」区切りで返す', async () => {
    mockDb({
      items: [item({ id: 11, price: 1234567 })],
      looks: [look({ id: 12, season_year: 2025, season_type: 'AW' })],
      news: [news({ id: 13, published_date: '2025-03-01' })],
    });

    const response = await executeSearch({ query: 'coat' });

    expect(response.items[0]).toMatchObject({ id: '11', type: 'item', href: '/item/11', meta: '¥1,234,567', imageUrl: null });
    expect(response.looks[0]).toMatchObject({ id: '12', type: 'look', href: '/look/12', meta: '2025 AW', imageUrl: null });
    expect(response.news[0]).toMatchObject({ id: '13', type: 'news', href: '/news/13', meta: '2025.03.01', imageUrl: null });
  });

  it('ARC-SEARCH-002 DB の行にある購入数の列は結果に写さない', async () => {
    const response = await searchItems('coat', [item({ purchase_count: 99 })]);

    expect(response.items[0]).toMatchObject({ id: '1', type: 'item', title: 'Wool coat', href: '/item/1' });
    expect(response.items[0]).not.toHaveProperty('purchase_count');
  });
});

describe('候補の点と並べ方', () => {
  it('ARC-SEARCH-002 候補は検索と同じ点の順に並べ、ラベルに語が無い物は出さない', async () => {
    mockDb({
      items: [
        item({ id: 1, name: 'Wool coat' }),
        item({ id: 2, name: 'Shirt', description: 'coat shirt' }),
        item({ id: 3, name: 'Coat long' }),
      ],
    });

    const suggestions = await getSearchSuggestions('coat');

    expect(suggestions.map((s: { label: string }) => s.label)).toEqual(['Coat long', 'Wool coat']);
  });

  it('ARC-SEARCH-002 同じ種別で同じラベルは最初の1つだけ残し、種別が違えば残す', async () => {
    mockDb({
      items: [item({ id: 1, name: 'Wool coat' }), item({ id: 2, name: 'Wool coat' })],
      looks: [look({ id: 3, theme: 'Wool coat' })],
    });

    const suggestions = await getSearchSuggestions('coat');

    expect(suggestions.map((s: { type: string }) => s.type)).toEqual(['item', 'look']);
  });

  it('ARC-SEARCH-002 候補は上限で切り、上限は DB の関数にも渡す', async () => {
    const rpc = mockDb({
      items: [item({ id: 1, name: 'Coat a' }), item({ id: 2, name: 'Coat b' }), item({ id: 3, name: 'Coat c' })],
    });

    const suggestions = await getSearchSuggestions('coat', 2);

    expect(suggestions).toHaveLength(2);
    expect(rpc).toHaveBeenCalledWith('search_items', { search_query: 'coat', limit_count: 2 });
  });

  it('ARC-SEARCH-002 候補は大文字と小文字を区別せず、行き先に題を符号化した語とタブを持つ', async () => {
    mockDb({ news: [news({ title: 'COAT & Co' })] });

    const suggestions = await getSearchSuggestions('coat');

    expect(suggestions).toEqual([{ label: 'COAT & Co', type: 'news', href: '/search?q=COAT%20%26%20Co&tab=news' }]);
  });

  it('ARC-SEARCH-002 語が空の候補は client を作らず空を返す', async () => {
    expect(await getSearchSuggestions('   ')).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
  });
});
