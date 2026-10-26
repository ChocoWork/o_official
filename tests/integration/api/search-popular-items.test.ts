export {};

// 人気商品（取り出しの関数 executeSearch の中の集計の関数の呼び出し）を、
// 窓口と取り出しの関数を本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client・回数の数え場所・応答の型）だけ
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { incrementCounter } = require('@/features/auth/ratelimit');
const { executeSearch } = require('@/features/search/services/search.service');
const searchRoute = require('@/app/api/search/route');

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: unknown };

// 関数が呼ばれた順を、利用者の client と service role の client をまたいで1本の記録に残す
let callOrder: string[];
let userRpc: jest.Mock;
let serviceRpc: jest.Mock;
let errorSpy: jest.SpyInstance;

const POPULAR_ROWS: Row[] = [
  { id: 11, name: 'Best coat', description: 'top seller', category: 'Outer', image_url: null, price: 24800, purchase_count: 120 },
  { id: 12, name: 'Second shirt', description: null, category: 'Shirt', image_url: null, price: 9800, purchase_count: 80 },
  { id: 13, name: 'Third knit', description: 'soft', category: 'Knit', image_url: null, price: 1000000, purchase_count: 5 },
  { id: 14, name: 'Fourth cap', description: 'cap', category: 'Cap', image_url: null, price: 4200, purchase_count: 1 },
];

const SEARCH_ROW: Row = {
  id: 1,
  name: 'Wool coat',
  description: null,
  category: 'Outer',
  image_url: null,
  price: 12800,
};

function setupClients(popular: RpcResult = { data: POPULAR_ROWS, error: null }) {
  userRpc = jest.fn(async (name: string) => {
    callOrder.push(`user:${name}`);
    return { data: name === 'search_items' ? [SEARCH_ROW] : [], error: null };
  });
  serviceRpc = jest.fn(async (name: string) => {
    callOrder.push(`service:${name}`);
    return popular;
  });
  createClient.mockResolvedValue({ rpc: userRpc, storage: { from: jest.fn() } });
  createServiceRoleClient.mockResolvedValue({ rpc: serviceRpc, storage: { from: jest.fn() } });
}

function makeRequest(path: string) {
  return {
    nextUrl: new URL(`http://localhost${path}`),
    headers: { get: (name: string) => (name === 'x-forwarded-for' ? '203.0.113.5' : null) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  callOrder = [];
  incrementCounter.mockResolvedValue(1);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  setupClients();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('人気商品の呼び方', () => {
  it('ARC-SEARCH-004 集計の関数は service role の client から件数4で呼び、利用者の client では呼ばない', async () => {
    await executeSearch({ query: 'coat' });

    expect(serviceRpc).toHaveBeenCalledTimes(1);
    expect(serviceRpc).toHaveBeenCalledWith('get_popular_items', { limit_count: 4 });
    expect(userRpc.mock.calls.map((call) => call[0])).not.toContain('get_popular_items');
  });

  it('ARC-SEARCH-004 集計の関数は語を受け取らず、語に左右されずに同じ引数で呼ぶ', async () => {
    await executeSearch({ query: 'coat' });
    await executeSearch({ query: 'shirt' });
    await executeSearch({ query: '' });

    expect(serviceRpc.mock.calls).toEqual([
      ['get_popular_items', { limit_count: 4 }],
      ['get_popular_items', { limit_count: 4 }],
      ['get_popular_items', { limit_count: 4 }],
    ]);
  });

  it('ARC-SEARCH-004 種別ごとの上限やタブを変えても、人気商品は毎回4件の引数で呼ぶ', async () => {
    await executeSearch({ query: 'coat', limitPerType: 2, tab: 'look' });

    expect(serviceRpc).toHaveBeenCalledWith('get_popular_items', { limit_count: 4 });
    expect(userRpc).toHaveBeenCalledWith('search_items', { search_query: 'coat', limit_count: 2 });
  });

  it('ARC-SEARCH-004 語が空でも人気商品は呼んで返し、3種の検索は呼ばない', async () => {
    const response = await executeSearch({ query: '   ' });

    expect(callOrder).toEqual(['service:get_popular_items']);
    expect(response.popularItems).toHaveLength(4);
    expect(response.items).toEqual([]);
    expect(response.empty).toBe(false);
  });

  it('ARC-SEARCH-004 検索の結果が0件でも人気商品はそのまま返す', async () => {
    userRpc.mockImplementation(async () => ({ data: [], error: null }));

    const response = await executeSearch({ query: 'nothing' });

    expect(response.empty).toBe(true);
    expect(response.popularItems.map((p: { id: string }) => p.id)).toEqual(['11', '12', '13', '14']);
  });

});

describe('人気商品の写し方', () => {
  it('ARC-SEARCH-004 id・名前・説明・行き先・画像・価格のメタだけを写し、購入数は落とす', async () => {
    const response = await executeSearch({ query: 'coat' });

    expect(response.popularItems[0]).toEqual({
      id: '11',
      type: 'item',
      title: 'Best coat',
      description: 'top seller',
      href: '/item/11',
      imageUrl: null,
      meta: '¥24,800',
    });
    for (const popular of response.popularItems) {
      expect(popular).not.toHaveProperty('purchase_count');
      expect(Object.keys(popular).sort()).toEqual(['description', 'href', 'id', 'imageUrl', 'meta', 'title', 'type']);
    }
  });

  it('ARC-SEARCH-004 説明が無い商品はカテゴリを説明にする', async () => {
    const response = await executeSearch({ query: '' });

    expect(response.popularItems[1].description).toBe('Shirt');
  });

  it('ARC-SEARCH-004 id は文字にして /item/<id> へ向け、価格はカンマ区切りの円で返す', async () => {
    const response = await executeSearch({ query: '' });

    expect(response.popularItems.map((p: { id: string; href: string }) => [p.id, p.href])).toEqual([
      ['11', '/item/11'],
      ['12', '/item/12'],
      ['13', '/item/13'],
      ['14', '/item/14'],
    ]);
    expect(response.popularItems[2].meta).toBe('¥1,000,000');
  });

  it('ARC-SEARCH-004 関数が返した並びを変えず、購入数の多い順の決定は関数に任せる', async () => {
    setupClients({ data: [...POPULAR_ROWS].reverse(), error: null });

    const response = await executeSearch({ query: '' });

    expect(response.popularItems.map((p: { id: string }) => p.id)).toEqual(['14', '13', '12', '11']);
  });

  it('ARC-SEARCH-004 窓口の応答にも購入数は載らない', async () => {
    const res = await searchRoute.GET(makeRequest('/api/search?q=coat'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.popularItems).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain('purchase_count');
  });

  it('ARC-SEARCH-004 プレビューの窓口でも人気商品は件数4で呼ぶ', async () => {
    const res = await searchRoute.GET(makeRequest('/api/search?q=coat&preview=true'));

    expect(res.status).toBe(200);
    expect(serviceRpc).toHaveBeenCalledWith('get_popular_items', { limit_count: 4 });
    expect((await res.json()).popularItems).toHaveLength(4);
  });
});

describe('人気商品の失敗と空', () => {
  it('ARC-SEARCH-004 関数が失敗したら記録して空の一覧にし、検索の結果は返す', async () => {
    const failure = { message: 'popular down' };
    setupClients({ data: null, error: failure });

    const response = await executeSearch({ query: 'coat' });

    expect(response.popularItems).toEqual([]);
    expect(response.items).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch popular items:', { name: 'UnknownError', code: null });
  });

  it('ARC-SEARCH-004 語が空で関数が失敗しても、窓口は 200 で空の一覧を返す', async () => {
    setupClients({ data: null, error: { message: 'popular down' } });

    const res = await searchRoute.GET(makeRequest('/api/search?q='));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.popularItems).toEqual([]);
  });

  it('ARC-SEARCH-004 関数が行を返さない（null）時は空の一覧にし、記録しない', async () => {
    setupClients({ data: null, error: null });

    const response = await executeSearch({ query: '' });

    expect(response.popularItems).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ARC-SEARCH-004 関数が空の配列を返したら空の一覧にする', async () => {
    setupClients({ data: [], error: null });

    const response = await executeSearch({ query: '' });

    expect(response.popularItems).toEqual([]);
  });
});
