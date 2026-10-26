import { executeSearch, SearchBackendError } from '@/features/search/services/search.service';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { signLookImageUrl } from '@/lib/storage/look-images';
import { signNewsImageUrl } from '@/lib/storage/news-images';

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({ signItemImageUrl: jest.fn() }));
jest.mock('@/lib/storage/look-images', () => ({ signLookImageUrl: jest.fn() }));
jest.mock('@/lib/storage/news-images', () => ({ signNewsImageUrl: jest.fn() }));

const mockedCreateClient = createClient as jest.Mock;
const mockedCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockedSignItem = signItemImageUrl as jest.Mock;
const mockedSignLook = signLookImageUrl as jest.Mock;
const mockedSignNews = signNewsImageUrl as jest.Mock;

type RpcResult = { data?: unknown; error?: unknown };

type ItemRow = {
  id: number;
  name: string;
  description: string | null;
  category: string;
  image_url: string | null;
  price: number;
};

type LookRow = {
  id: number;
  season_year: number;
  season_type: 'SS' | 'AW';
  theme: string;
  theme_description: string | null;
  image_urls: string[] | null;
};

type NewsRow = {
  id: number;
  title: string;
  category: string;
  image_url: string | null;
  content: string;
  published_date: string;
};

function item(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    name: 'Wool Coat',
    description: 'A warm coat',
    category: 'Outer',
    image_url: null,
    price: 12000,
    ...overrides,
  };
}

function look(overrides: Partial<LookRow> = {}): LookRow {
  return {
    id: 1,
    season_year: 2026,
    season_type: 'SS',
    theme: 'Coastal Walk',
    theme_description: 'Light layers',
    image_urls: null,
    ...overrides,
  };
}

function article(overrides: Partial<NewsRow> = {}): NewsRow {
  return {
    id: 1,
    title: 'Spring Notice',
    category: 'Info',
    image_url: null,
    content: 'Spring arrivals',
    published_date: '2026-01-02',
    ...overrides,
  };
}

/** 差し替えの client を作る。rpc は関数名で結果を返し、呼び方を記録する */
function makeClient(results: Record<string, RpcResult>) {
  const rpc = jest.fn(async (name: string, _args?: unknown) => results[name] ?? { data: [], error: null });
  return { rpc };
}

let userClient: ReturnType<typeof makeClient>;
let serviceClient: ReturnType<typeof makeClient>;
let consoleError: jest.SpyInstance;

function setup(options: {
  user?: Record<string, RpcResult>;
  service?: Record<string, RpcResult>;
} = {}) {
  userClient = makeClient({
    search_items: { data: [], error: null },
    search_looks: { data: [], error: null },
    search_news: { data: [], error: null },
    ...options.user,
  });
  serviceClient = makeClient({
    get_popular_items: { data: [], error: null },
    ...options.service,
  });
  mockedCreateClient.mockResolvedValue(userClient);
  mockedCreateServiceRoleClient.mockResolvedValue(serviceClient);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSignItem.mockImplementation(async (_client, url: string) => `signed-item:${url}`);
  mockedSignLook.mockImplementation(async (_client, url: string) => `signed-look:${url}`);
  mockedSignNews.mockImplementation(async (_client, url: string) => `signed-news:${url}`);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  setup();
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('executeSearch', () => {
  it('DD-SEARCH-006 語が空白だけなら既定の値で返し、検索の関数を呼ばない', async () => {
    const result = await executeSearch({ query: ' ' });

    expect(result).toEqual({
      query: '',
      tab: 'all',
      items: [],
      looks: [],
      news: [],
      counts: { all: 0, item: 0, look: 0, news: 0 },
      popularItems: [],
      empty: false,
    });
    expect(mockedCreateClient).not.toHaveBeenCalled();
    expect(userClient.rpc).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-006 件数を渡さなければ3種の関数を limit_count 6 で呼ぶ', async () => {
    await executeSearch({ query: 'coat' });

    expect(userClient.rpc).toHaveBeenCalledTimes(3);
    expect(userClient.rpc).toHaveBeenCalledWith('search_items', { search_query: 'coat', limit_count: 6 });
    expect(userClient.rpc).toHaveBeenCalledWith('search_looks', { search_query: 'coat', limit_count: 6 });
    expect(userClient.rpc).toHaveBeenCalledWith('search_news', { search_query: 'coat', limit_count: 6 });
  });

  it('DD-SEARCH-006 件数を limit_count に使い、渡した tab を応答の tab にそのまま返す', async () => {
    setup({
      user: {
        search_items: { data: [item()], error: null },
        search_news: { data: [article({ title: 'Coat news', content: 'coat' })], error: null },
      },
    });

    const result = await executeSearch({ query: 'coat', tab: 'news', limitPerType: 3 });

    expect(userClient.rpc).toHaveBeenCalledWith('search_items', { search_query: 'coat', limit_count: 3 });
    expect(userClient.rpc).toHaveBeenCalledWith('search_looks', { search_query: 'coat', limit_count: 3 });
    expect(userClient.rpc).toHaveBeenCalledWith('search_news', { search_query: 'coat', limit_count: 3 });
    expect(result.tab).toBe('news');
  });

  it('DD-SEARCH-006 人気商品は説明なし・画像なしを補い、価格の形にし、購入数を落とす', async () => {
    setup({
      service: {
        get_popular_items: {
          data: [
            { id: 10, name: 'Tee', description: 'Plain tee', category: 'Tops', image_url: 'tee.jpg', price: 1200, purchase_count: 9 },
            { id: 11, name: 'Cap', description: null, category: 'Hats', image_url: null, price: 3456789, purchase_count: 4 },
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: '' });

    expect(serviceClient.rpc).toHaveBeenCalledWith('get_popular_items', { limit_count: 4 });
    expect(result.popularItems).toEqual([
      { id: '10', type: 'item', title: 'Tee', description: 'Plain tee', href: '/item/10', imageUrl: 'signed-item:tee.jpg', meta: '¥1,200' },
      { id: '11', type: 'item', title: 'Cap', description: 'Hats', href: '/item/11', imageUrl: null, meta: '¥3,456,789' },
    ]);
    for (const popular of result.popularItems) {
      expect(popular).not.toHaveProperty('purchase_count');
      expect(popular).not.toHaveProperty('purchaseCount');
    }
  });

  it('DD-SEARCH-006 人気商品の関数が誤りを返すと空の一覧にして console.error に書く', async () => {
    const error = { message: 'boom secret detail', code: '42501' };
    setup({ service: { get_popular_items: { data: [{ id: 1 }], error } } });

    const result = await executeSearch({ query: '' });

    expect(result.popularItems).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith('Failed to fetch popular items:', { name: 'UnknownError', code: '42501' });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('boom secret detail');
  });

  it('DD-SEARCH-006 人気商品の data が null なら空の一覧', async () => {
    setup({ service: { get_popular_items: { data: null, error: null } } });

    const result = await executeSearch({ query: '' });

    expect(result.popularItems).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-006 検索の関数は利用者の client、人気商品と署名は service role の client で呼び、語の前後の空白を除く', async () => {
    setup({
      user: { search_items: { data: [item({ image_url: 'coat.jpg' })], error: null } },
      service: {
        get_popular_items: {
          data: [{ id: 2, name: 'P', description: null, category: 'C', image_url: 'p.jpg', price: 1 }],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: '  coat ' });

    expect(result.query).toBe('coat');
    expect(userClient.rpc).toHaveBeenCalledTimes(3);
    for (const call of userClient.rpc.mock.calls) {
      expect(call[1]).toEqual({ search_query: 'coat', limit_count: 6 });
    }
    expect(serviceClient.rpc.mock.calls.map((call) => call[0])).toEqual(['get_popular_items']);
    expect(mockedSignItem).toHaveBeenCalledTimes(2);
    for (const call of mockedSignItem.mock.calls) {
      expect(call[0]).toBe(serviceClient);
    }
  });

  it('DD-SEARCH-006 検索の関数が3つとも誤りを返すと SearchBackendError で失敗し、関数ごとに名前と符号だけ記録する（SEC-SEARCH-017・018）', async () => {
    setup({
      user: {
        search_items: { data: null, error: { message: 'items down for secretword', code: '57014' } },
        search_looks: { data: null, error: { message: 'looks down', code: '42501' } },
        search_news: { data: null, error: { message: 'news down' } },
      },
    });

    await expect(executeSearch({ query: 'secretword' })).rejects.toBeInstanceOf(SearchBackendError);

    expect(consoleError).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_items', name: 'UnknownError', code: '57014' });
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_looks', name: 'UnknownError', code: '42501' });
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_news', name: 'UnknownError', code: null });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secretword');
  });

  it('DD-SEARCH-006 検索の関数のどれか1つだけが誤りでも全体を失敗にし、他の種別の結果を返さない（SEC-SEARCH-017）', async () => {
    setup({
      user: {
        search_items: { data: [item({ name: 'Coat item' })], error: null },
        search_looks: { data: null, error: { message: 'looks down for secretword', code: '42501' } },
        search_news: { data: [article({ title: 'Coat news' })], error: null },
      },
    });

    const failure = await executeSearch({ query: 'secretword' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SearchBackendError);
    expect(failure).toMatchObject({ fn: 'search_looks', code: '42501' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Search function failed:', { fn: 'search_looks', name: 'UnknownError', code: '42501' });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secretword');
  });

  it('DD-SEARCH-006 語が空なら検索の関数を呼ばないので失敗にならない', async () => {
    setup({ user: { search_looks: { data: null, error: { message: 'down' } } } });

    await expect(executeSearch({ query: '  ' })).resolves.toMatchObject({ empty: false });
    expect(userClient.rpc).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-006 検索の関数の data が null なら3種とも空で empty が真', async () => {
    setup({
      user: {
        search_items: { data: null, error: null },
        search_looks: { data: null, error: null },
        search_news: { data: null, error: null },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.items).toEqual([]);
    expect(result.looks).toEqual([]);
    expect(result.news).toEqual([]);
    expect(result.counts).toEqual({ all: 0, item: 0, look: 0, news: 0 });
    expect(result.empty).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-006 語を含まない行は点が0で捨てる', async () => {
    setup({
      user: {
        search_items: { data: [item({ id: 1, name: 'Shirt', description: 'Cotton', category: 'Tops' })], error: null },
        search_looks: { data: [look({ id: 2, theme: 'Beach', theme_description: 'Sand' })], error: null },
        search_news: { data: [article({ id: 3, title: 'Sale', content: 'Everything', category: 'Info' })], error: null },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.items).toEqual([]);
    expect(result.looks).toEqual([]);
    expect(result.news).toEqual([]);
    expect(result.empty).toBe(true);
  });

  it('DD-SEARCH-006 題が語で始まる行、題が語を含む行、説明だけが語を含む行の順に並ぶ', async () => {
    setup({
      user: {
        search_items: {
          data: [
            item({ id: 1, name: 'Plain', description: 'made like a coat', category: 'Tops' }),
            item({ id: 2, name: 'Long Coat', description: null, category: 'Outer' }),
            item({ id: 3, name: 'Coat Dress', description: null, category: 'Dress' }),
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.items.map((row) => row.id)).toEqual(['3', '2', '1']);
  });

  it('DD-SEARCH-006 分けた語だけが別の欄で合う行は点が0にならず残る', async () => {
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'coat', description: 'navy', category: 'Outer' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'navy coat' });

    expect(result.items.map((row) => row.id)).toEqual(['1']);
  });

  it('DD-SEARCH-006 分けた語の一部しか合わない行は捨てる', async () => {
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'coat', description: 'wool', category: 'Outer' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'navy coat' });

    expect(result.items).toEqual([]);
  });

  it('DD-SEARCH-006 記号だけの語は語全体を1語として点が付く', async () => {
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'a・・b', description: null, category: 'Misc' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: '・・' });

    expect(result.items.map((row) => row.id)).toEqual(['1']);
  });

  it('DD-SEARCH-006 1種別が上限より多い時は limitPerType 件で切り、数は切った後の数', async () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      item({ id: index + 1, name: `Coat ${index + 1}`, description: null }),
    );
    setup({ user: { search_items: { data: rows, error: null } } });

    const result = await executeSearch({ query: 'coat', limitPerType: 8 });

    expect(result.items).toHaveLength(8);
    expect(result.counts.item).toBe(8);
    expect(result.counts.all).toBe(8);
  });

  it('DD-SEARCH-006 商品の行は説明あり・なし、画像あり・なしを写し、メタは価格にする', async () => {
    setup({
      user: {
        search_items: {
          data: [
            item({ id: 1, name: 'Coat A', description: 'Coat with description', category: 'Outer', image_url: 'a.jpg', price: 12000 }),
            item({ id: 2, name: 'Coat B', description: null, category: 'Outer', image_url: null, price: 800 }),
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });
    const withDescription = result.items.find((row) => row.id === '1');
    const withoutDescription = result.items.find((row) => row.id === '2');

    expect(withDescription).toMatchObject({
      id: '1',
      type: 'item',
      title: 'Coat A',
      description: 'Coat with description',
      href: '/item/1',
      imageUrl: 'signed-item:a.jpg',
      meta: '¥12,000',
    });
    // 説明が無い行は説明の元がカテゴリになり、語が合わないのでカテゴリがそのまま入る。
    expect(withoutDescription).toMatchObject({
      id: '2',
      type: 'item',
      title: 'Coat B',
      description: 'Outer',
      href: '/item/2',
      imageUrl: null,
      meta: '¥800',
    });
  });

  it('DD-SEARCH-006 ルックの行は説明なしならシーズン、画像は配列の1枚目か null', async () => {
    setup({
      user: {
        search_looks: {
          data: [
            look({ id: 1, theme: 'Coat walk', theme_description: null, image_urls: ['l1.jpg', 'l2.jpg'], season_year: 2026, season_type: 'SS' }),
            look({ id: 2, theme: 'Coat walk 2', theme_description: null, image_urls: [], season_year: 2025, season_type: 'AW' }),
            look({ id: 3, theme: 'Coat walk 3', theme_description: null, image_urls: null }),
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });
    const byId = (id: string) => result.looks.find((row) => row.id === id);

    expect(byId('1')).toMatchObject({
      id: '1',
      type: 'look',
      title: 'Coat walk',
      description: '2026 SS',
      href: '/look/1',
      imageUrl: 'signed-look:l1.jpg',
      meta: '2026 SS',
    });
    expect(byId('2')?.imageUrl).toBeNull();
    expect(byId('2')?.meta).toBe('2025 AW');
    expect(byId('2')?.description).toBe('2025 AW');
    expect(byId('3')?.imageUrl).toBeNull();
    expect(mockedSignLook).toHaveBeenCalledTimes(1);
  });

  it('DD-SEARCH-006 ルックの説明に語があれば説明を切り出して使う', async () => {
    setup({
      user: {
        search_looks: {
          data: [look({ id: 1, theme: 'Walk', theme_description: 'A light coat for spring' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.looks[0].description).toBe('A light coat for spring');
  });

  it('DD-SEARCH-006 ニュースの行は画像あり・なしを写し、メタは公開日の - を . に変えた字', async () => {
    setup({
      user: {
        search_news: {
          data: [
            article({ id: 1, title: 'Coat arrives', content: 'New coat', category: 'Info', image_url: 'n.jpg', published_date: '2026-01-02' }),
            article({ id: 2, title: 'Coat sale', content: 'Sale', category: 'Info', image_url: null, published_date: '2025-12-31' }),
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });
    const byId = (id: string) => result.news.find((row) => row.id === id);

    expect(byId('1')).toMatchObject({
      id: '1',
      type: 'news',
      title: 'Coat arrives',
      description: 'New coat',
      href: '/news/1',
      imageUrl: 'signed-news:n.jpg',
      meta: '2026.01.02',
    });
    expect(byId('2')?.imageUrl).toBeNull();
    expect(byId('2')?.meta).toBe('2025.12.31');
  });

  it('DD-SEARCH-006 説明の切り出しは一致が先頭なら前の … を付けず、末尾まで短ければ後ろの … も付けない', async () => {
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'Plain', description: 'Coat short text', category: 'Tops' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.items[0].description).toBe('Coat short text');
  });

  it('DD-SEARCH-006 説明の切り出しは前に29字以上あれば頭に … を付け、後ろが68字以上続けば末尾に … を付ける', async () => {
    const description = `${'a'.repeat(40)}coat${'b'.repeat(80)}`;
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'Plain', description, category: 'Tops' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    // 一致位置 40 の 28 字前から、語の長さ 4 と 68 字の後まで。
    expect(result.items[0].description).toBe(`…${description.slice(12, 112)}…`);
  });

  it('DD-SEARCH-006 説明の切り出しは前だけ長ければ頭だけ、後ろだけ長ければ末尾だけに … を付ける', async () => {
    const tailShort = `${'a'.repeat(40)}coat end`;
    const headShort = `coat${'b'.repeat(90)}`;
    setup({
      user: {
        search_items: {
          data: [
            item({ id: 1, name: 'Plain one', description: tailShort, category: 'Tops' }),
            item({ id: 2, name: 'Plain two', description: headShort, category: 'Tops' }),
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });
    const byId = (id: string) => result.items.find((row) => row.id === id);

    expect(byId('1')?.description).toBe(`…${tailShort.slice(12)}`);
    expect(byId('2')?.description).toBe(`${headShort.slice(0, 72)}…`);
  });

  it('DD-SEARCH-006 説明に語が無く題にだけあるなら決めた値（商品はカテゴリ）を説明にする', async () => {
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'Coat', description: 'Warm outer', category: 'Outer' })],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.items[0].description).toBe('Outer');
  });

  it('DD-SEARCH-006 署名は画像ありの行だけ種別に合う関数で行い、画像なしの行と人気商品の画像なしは呼ばない', async () => {
    setup({
      user: {
        search_items: {
          data: [
            item({ id: 1, name: 'Coat 1', image_url: 'i1.jpg' }),
            item({ id: 2, name: 'Coat 2', image_url: null }),
          ],
          error: null,
        },
        search_looks: {
          data: [
            look({ id: 1, theme: 'Coat look', image_urls: ['l1.jpg'] }),
            look({ id: 2, theme: 'Coat look 2', image_urls: null }),
          ],
          error: null,
        },
        search_news: {
          data: [
            article({ id: 1, title: 'Coat news', image_url: 'n1.jpg' }),
            article({ id: 2, title: 'Coat news 2', image_url: null }),
          ],
          error: null,
        },
      },
      service: {
        get_popular_items: {
          data: [
            { id: 8, name: 'Pop', description: null, category: 'C', image_url: 'p1.jpg', price: 1 },
            { id: 9, name: 'Pop 2', description: null, category: 'C', image_url: null, price: 2 },
          ],
          error: null,
        },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(mockedSignItem.mock.calls.map((call) => call[1]).sort()).toEqual(['i1.jpg', 'p1.jpg']);
    expect(mockedSignLook.mock.calls.map((call) => call[1])).toEqual(['l1.jpg']);
    expect(mockedSignNews.mock.calls.map((call) => call[1])).toEqual(['n1.jpg']);
    for (const mocked of [mockedSignItem, mockedSignLook, mockedSignNews]) {
      for (const call of mocked.mock.calls) {
        expect(call[0]).toBe(serviceClient);
      }
    }
    expect(result.items.map((row) => row.imageUrl).sort()).toEqual([null, 'signed-item:i1.jpg']);
    expect(result.looks.map((row) => row.imageUrl).sort()).toEqual([null, 'signed-look:l1.jpg']);
    expect(result.news.map((row) => row.imageUrl).sort()).toEqual([null, 'signed-news:n1.jpg']);
    expect(result.popularItems.map((row) => row.imageUrl)).toEqual(['signed-item:p1.jpg', null]);
  });

  it('DD-SEARCH-006 署名の関数が null を返したら imageUrl は null になる', async () => {
    mockedSignNews.mockResolvedValue(null);
    setup({
      user: { search_news: { data: [article({ title: 'Coat news', image_url: 'n.jpg' })], error: null } },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.news[0].imageUrl).toBeNull();
  });

  it('DD-SEARCH-006 数は種別ごとの切った後の数で all はその合計、1件でもあれば empty は偽', async () => {
    setup({
      user: {
        search_items: {
          data: [item({ id: 1, name: 'Coat 1' }), item({ id: 2, name: 'Coat 2' })],
          error: null,
        },
        search_looks: { data: [], error: null },
        search_news: { data: [article({ title: 'Coat news' })], error: null },
      },
    });

    const result = await executeSearch({ query: 'coat' });

    expect(result.counts).toEqual({ item: 2, look: 0, news: 1, all: 3 });
    expect(result.empty).toBe(false);
  });

  it('DD-SEARCH-006 service role の client の作成が投げたら例外がそのまま出る', async () => {
    mockedCreateServiceRoleClient.mockRejectedValue(new Error('service role missing'));

    await expect(executeSearch({ query: 'coat' })).rejects.toThrow('service role missing');
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-006 署名の関数が投げたら例外がそのまま出る', async () => {
    mockedSignNews.mockRejectedValue(new Error('sign failed'));
    setup({
      user: { search_news: { data: [article({ title: 'Coat news', image_url: 'n.jpg' })], error: null } },
    });

    await expect(executeSearch({ query: 'coat' })).rejects.toThrow('sign failed');
  });
});
