import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// 窓口・回数の制限・検索の取り出しは本物を通し、DB・画像の署名・数え場所だけを差し替える
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: jest.fn(async (_c: unknown, raw: string | null) => (raw ? `signed-item:${raw}` : null)),
}));
jest.mock('@/lib/storage/look-images', () => ({
  signLookImageUrl: jest.fn(async (_c: unknown, raw: string | null) => (raw ? `signed-look:${raw}` : null)),
}));
jest.mock('@/lib/storage/news-images', () => ({
  signNewsImageUrl: jest.fn(async (_c: unknown, raw: string | null) => (raw ? `signed-news:${raw}` : null)),
}));

const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { incrementCounter } = require('@/features/auth/ratelimit');
const { GET } = require('@/app/api/search/route');

type RpcResult = { data: unknown; error: unknown };

const ITEM_ROW = {
  id: 1,
  name: 'Wool Coat',
  description: 'A warm wool coat for winter',
  category: 'OUTER',
  image_url: 'items/coat.jpg',
  price: 38000,
};
const LOOK_ROW = {
  id: 2,
  season_year: 2026,
  season_type: 'AW',
  theme: 'Wool Season',
  theme_description: 'Layered wool pieces',
  image_urls: ['looks/a.jpg', 'looks/b.jpg'],
};
const NEWS_ROW = {
  id: 3,
  title: 'Wool restock',
  category: 'STORE',
  image_url: 'news/a.jpg',
  content: 'Wool items are back in stock',
  published_date: '2026-04-01',
};
const POPULAR_ROW = {
  id: 9,
  name: 'Popular Tee',
  description: null,
  category: 'TOPS',
  image_url: null,
  price: 6600,
  purchase_count: 42,
};

function setupClients(
  overrides: Partial<Record<'search_items' | 'search_looks' | 'search_news' | 'get_popular_items', RpcResult>> = {},
) {
  const results: Record<string, RpcResult> = {
    search_items: { data: [ITEM_ROW], error: null },
    search_looks: { data: [LOOK_ROW], error: null },
    search_news: { data: [NEWS_ROW], error: null },
    get_popular_items: { data: [POPULAR_ROW], error: null },
    ...overrides,
  };
  const userRpc = jest.fn(async (name: string) => results[name]);
  const serviceRpc = jest.fn(async (name: string) => results[name]);
  createClient.mockResolvedValue({ rpc: userRpc });
  createServiceRoleClient.mockResolvedValue({ rpc: serviceRpc });
  return { userRpc, serviceRpc };
}

function makeRequest(search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`https://shop.example.com/api/search${search}`, { method: 'GET', headers });
}

describe('GET /api/search 横断検索と人気商品', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    incrementCounter.mockResolvedValue(1);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('API-SEARCH-001 語に合う3種の結果と人気商品を署名つきの画像で 200 と Cache-Control: private, no-store つきで返し、処理時間の見出しは付けない', async () => {
    setupClients();

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-search-duration-ms')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.query).toBe('wool');
    expect(body.tab).toBe('all');
    expect(body.empty).toBe(false);
    expect(body.counts).toEqual({ all: 3, item: 1, look: 1, news: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject(
      {
        id: '1',
        type: 'item',
        title: 'Wool Coat',
        description: 'A warm wool coat for winter',
        href: '/item/1',
        imageUrl: 'signed-item:items/coat.jpg',
        meta: '¥38,000',
      },
    );
    expect(body.looks[0]).toMatchObject({
      id: '2',
      type: 'look',
      title: 'Wool Season',
      href: '/look/2',
      imageUrl: 'signed-look:looks/a.jpg',
      meta: '2026 AW',
    });
    expect(body.news[0]).toMatchObject({
      id: '3',
      type: 'news',
      title: 'Wool restock',
      href: '/news/3',
      imageUrl: 'signed-news:news/a.jpg',
      meta: '2026.04.01',
    });
    expect(body.popularItems).toEqual([
      {
        id: '9',
        type: 'item',
        title: 'Popular Tee',
        description: 'TOPS',
        href: '/item/9',
        imageUrl: null,
        meta: '¥6,600',
      },
    ]);
  });

  it('API-SEARCH-001 結果にも人気商品にも購入数を含めない', async () => {
    setupClients();

    const body = await (await GET(makeRequest('?q=wool'))).json();

    expect(JSON.stringify(body)).not.toContain('purchase_count');
    expect(JSON.stringify(body)).not.toContain('42');
  });

  it('API-SEARCH-001 語は関数の引数で渡し、検索は利用者の client、人気商品は service role の client で呼ぶ', async () => {
    const { userRpc, serviceRpc } = setupClients();

    await GET(makeRequest('?q=%20wool%20'));

    expect(userRpc).toHaveBeenCalledTimes(3);
    expect(userRpc).toHaveBeenCalledWith('search_items', { search_query: 'wool', limit_count: 8 });
    expect(userRpc).toHaveBeenCalledWith('search_looks', { search_query: 'wool', limit_count: 8 });
    expect(userRpc).toHaveBeenCalledWith('search_news', { search_query: 'wool', limit_count: 8 });
    expect(serviceRpc).toHaveBeenCalledTimes(1);
    expect(serviceRpc).toHaveBeenCalledWith('get_popular_items', { limit_count: 4 });
  });

  it('API-SEARCH-001 語が空なら3種の関数を呼ばず、空の3種と人気商品を empty false で返す', async () => {
    const { userRpc, serviceRpc } = setupClients();

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      query: '',
      tab: 'all',
      items: [],
      looks: [],
      news: [],
      counts: { all: 0, item: 0, look: 0, news: 0 },
      empty: false,
    });
    expect(body.popularItems).toHaveLength(1);
    expect(userRpc).not.toHaveBeenCalled();
    expect(serviceRpc).toHaveBeenCalledWith('get_popular_items', { limit_count: 4 });
  });

  it('API-SEARCH-001 どの結果にも語が合わなければ empty true で返す', async () => {
    setupClients();

    const body = await (await GET(makeRequest('?q=nomatchword'))).json();

    expect(body.counts).toEqual({ all: 0, item: 0, look: 0, news: 0 });
    expect(body.empty).toBe(true);
  });

  it('API-SEARCH-001 語の合わない行を除き、題の頭に語がある行を先に並べる', async () => {
    setupClients({
      search_items: {
        data: [
          { ...ITEM_ROW, id: 11, name: 'Old Wool Scarf', description: null, image_url: null },
          { ...ITEM_ROW, id: 12, name: 'Wool Scarf', description: null, image_url: null },
          { ...ITEM_ROW, id: 13, name: 'Cotton Shirt', description: 'plain', category: 'TOPS', image_url: null },
        ],
        error: null,
      },
    });

    const body = await (await GET(makeRequest('?q=wool'))).json();

    expect(body.items.map((r: { id: string }) => r.id)).toEqual(['12', '11']);
    expect(body.counts.item).toBe(2);
  });

  it('API-SEARCH-001 画像が無い行は imageUrl を null で返し、ルックの画像が配列でなければ null にする', async () => {
    setupClients({
      search_items: { data: [{ ...ITEM_ROW, image_url: null }], error: null },
      search_looks: { data: [{ ...LOOK_ROW, image_urls: null }], error: null },
      search_news: { data: [{ ...NEWS_ROW, image_url: null }], error: null },
    });

    const body = await (await GET(makeRequest('?q=wool'))).json();

    expect(body.items[0].imageUrl).toBeNull();
    expect(body.looks[0].imageUrl).toBeNull();
    expect(body.news[0].imageUrl).toBeNull();
  });

  it('API-SEARCH-001 通常は1種別あたり8件、プレビューは3件で呼ぶ', async () => {
    const normal = setupClients();
    await GET(makeRequest('?q=wool'));
    expect(normal.userRpc).toHaveBeenCalledWith('search_items', { search_query: 'wool', limit_count: 8 });

    const preview = setupClients();
    await GET(makeRequest('?q=wool&preview=true'));
    expect(preview.userRpc).toHaveBeenCalledWith('search_items', { search_query: 'wool', limit_count: 3 });
    expect(preview.userRpc).toHaveBeenCalledWith('search_looks', { search_query: 'wool', limit_count: 3 });
    expect(preview.userRpc).toHaveBeenCalledWith('search_news', { search_query: 'wool', limit_count: 3 });
  });

  it('API-SEARCH-001 結果は1種別あたりの件数で切る', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...ITEM_ROW,
      id: 100 + i,
      name: `Wool ${i}`,
      image_url: null,
    }));
    setupClients({ search_items: { data: rows, error: null } });

    const body = await (await GET(makeRequest('?q=wool&preview=true'))).json();

    expect(body.items).toHaveLength(3);
    expect(body.counts.item).toBe(3);
  });

  it('API-SEARCH-001 preview は文字が true の時だけ真にし、false など別の値は通常の枠と件数にする', async () => {
    const { userRpc } = setupClients();

    const res = await GET(makeRequest('?q=wool&preview=false'));

    expect(res.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'search:public' }));
    expect(userRpc).toHaveBeenCalledWith('search_items', { search_query: 'wool', limit_count: 8 });

    incrementCounter.mockClear();
    const other = await GET(makeRequest('?q=wool&preview=1'));
    expect(other.status).toBe(200);
    expect(incrementCounter).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'search:public' }));
  });

  it.each(['all', 'item', 'look', 'news'])('API-SEARCH-001 tab=%s は受け付ける', async (tab) => {
    setupClients();

    const res = await GET(makeRequest(`?q=wool&tab=${tab}`));

    expect(res.status).toBe(200);
    expect((await res.json()).tab).toBe(tab);
  });

  it('API-SEARCH-001 tab が決まりの外なら 400 を返し、回数も取り出しも通さない', async () => {
    const { userRpc, serviceRpc } = setupClients();

    const res = await GET(makeRequest('?q=wool&tab=admin'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid search query' });
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(userRpc).not.toHaveBeenCalled();
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it('API-SEARCH-001 語が101字なら 400、100字なら通す', async () => {
    setupClients();

    const tooLong = await GET(makeRequest(`?q=${'a'.repeat(101)}`));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: 'Invalid search query' });

    const ok = await GET(makeRequest(`?q=${'a'.repeat(100)}`));
    expect(ok.status).toBe(200);
  });

  it('API-SEARCH-001 種別の関数が1つ失敗したら全体を 500 にし、記録は関数名と符号だけ（SEC-SEARCH-017・018）', async () => {
    setupClients({ search_looks: { data: null, error: { message: 'rpc down for secretword', code: '42501' } } });

    const res = await GET(makeRequest('?q=secretword'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to search content' });
    expect(errorSpy).toHaveBeenCalledWith('Search function failed:', { fn: 'search_looks', name: 'UnknownError', code: '42501' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secretword');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('rpc down');
  });

  it('API-SEARCH-001 商品とニュースの関数が失敗しても全体を 500 にし、失敗ごとに記録する', async () => {
    setupClients({
      search_items: { data: null, error: { message: 'items down' } },
      search_news: { data: null, error: { message: 'news down', code: '57014' } },
    });

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith('Search function failed:', { fn: 'search_items', name: 'UnknownError', code: null });
    expect(errorSpy).toHaveBeenCalledWith('Search function failed:', { fn: 'search_news', name: 'UnknownError', code: '57014' });
  });

  it('API-SEARCH-001 制御文字を含む語は 400 で、回数も取り出しも通さない（SEC-SEARCH-004）', async () => {
    const { userRpc } = setupClients();

    const res = await GET(makeRequest('?q=a%00b'));

    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(userRpc).not.toHaveBeenCalled();
  });

  it.each(['cross-site', 'same-site'])(
    'API-SEARCH-001 sec-fetch-site: %s の要求は 403 で、回数にも数えず取り出しも通さない（SEC-SEARCH-020）',
    async (value) => {
      const { userRpc, serviceRpc } = setupClients();

      const res = await GET(makeRequest('?q=wool', { 'sec-fetch-site': value }));

      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await res.json()).toEqual({ error: 'Forbidden' });
      expect(incrementCounter).not.toHaveBeenCalled();
      expect(userRpc).not.toHaveBeenCalled();
      expect(serviceRpc).not.toHaveBeenCalled();
    },
  );

  it('API-SEARCH-001 sec-fetch-site: same-origin の要求は通す', async () => {
    setupClients();

    const res = await GET(makeRequest('?q=wool', { 'sec-fetch-site': 'same-origin' }));

    expect(res.status).toBe(200);
  });

  it('API-SEARCH-001 人気商品の関数の失敗は記録して空の人気商品で 200 を返す', async () => {
    const failure = { message: 'popular down' };
    setupClients({ get_popular_items: { data: null, error: failure } });

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(200);
    expect((await res.json()).popularItems).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch popular items:', { name: 'UnknownError', code: null });
  });

  it('API-SEARCH-001 例外は記録して固定の文の 500 を返し、内部の情報を出さない', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('secret connection string'));
    createClient.mockResolvedValue({ rpc: jest.fn() });

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to search content' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(errorSpy).toHaveBeenCalledWith('GET /api/search error:', { name: 'Error', code: null });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
