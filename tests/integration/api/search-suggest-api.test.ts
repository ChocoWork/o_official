import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// 窓口・回数の制限・候補の取り出しは本物を通し、DB と数え場所だけを差し替える
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

const { createClient } = require('@/lib/supabase/server');
const { incrementCounter } = require('@/features/auth/ratelimit');
const { GET } = require('@/app/api/suggest/route');

type RpcResult = { data: unknown; error: unknown };

const ITEM_ROW = {
  id: 1,
  name: 'Wool Coat',
  description: 'warm',
  category: 'OUTER',
  image_url: null,
  price: 38000,
};
const LOOK_ROW = {
  id: 2,
  season_year: 2026,
  season_type: 'AW',
  theme: 'Wool Season',
  theme_description: 'Layered',
  image_urls: null,
};
const NEWS_ROW = {
  id: 3,
  title: 'Wool restock',
  category: 'STORE',
  image_url: null,
  content: 'back in stock',
  published_date: '2026-04-01',
};

function setupClient(
  overrides: Partial<Record<'search_items' | 'search_looks' | 'search_news', RpcResult>> = {},
) {
  const results: Record<string, RpcResult> = {
    search_items: { data: [ITEM_ROW], error: null },
    search_looks: { data: [LOOK_ROW], error: null },
    search_news: { data: [NEWS_ROW], error: null },
    ...overrides,
  };
  const rpc = jest.fn(async (name: string) => results[name]);
  createClient.mockResolvedValue({ rpc });
  return { rpc };
}

function makeRequest(search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`https://shop.example.com/api/suggest${search}`, { method: 'GET', headers });
}

describe('GET /api/suggest 入力中の候補', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    incrementCounter.mockResolvedValue(1);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('API-SEARCH-002 ラベルに語を含む候補を種別つきの href で 200 に包んで返す', async () => {
    setupClient();

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions).toEqual(
      expect.arrayContaining([
        { label: 'Wool Coat', type: 'item', href: '/search?q=Wool%20Coat&tab=item' },
        { label: 'Wool Season', type: 'look', href: '/search?q=Wool%20Season&tab=look' },
        { label: 'Wool restock', type: 'news', href: '/search?q=Wool%20restock&tab=news' },
      ]),
    );
  });

  it('API-SEARCH-002 語は関数の引数で渡し、3種の関数をそれぞれ8件で呼ぶ', async () => {
    const { rpc } = setupClient();

    await GET(makeRequest('?q=%20wool%20'));

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledWith('search_items', { search_query: 'wool', limit_count: 8 });
    expect(rpc).toHaveBeenCalledWith('search_looks', { search_query: 'wool', limit_count: 8 });
    expect(rpc).toHaveBeenCalledWith('search_news', { search_query: 'wool', limit_count: 8 });
  });

  it('API-SEARCH-002 ラベルに語が現れず説明だけに合った行は候補にしない', async () => {
    setupClient({
      search_items: { data: [{ ...ITEM_ROW, name: 'Coat', description: 'made of wool' }], error: null },
      search_looks: { data: [{ ...LOOK_ROW, theme: 'Season', theme_description: 'wool layers' }], error: null },
      search_news: { data: [{ ...NEWS_ROW, title: 'Restock', content: 'wool is back' }], error: null },
    });

    const body = await (await GET(makeRequest('?q=wool'))).json();

    expect(body.suggestions).toEqual([]);
  });

  it('API-SEARCH-002 点の高い順に並べ、同じ種別で同じラベルの重なりは最初の1つだけ残す', async () => {
    setupClient({
      search_items: {
        data: [
          { ...ITEM_ROW, id: 21, name: 'Old Wool Scarf', description: null },
          { ...ITEM_ROW, id: 22, name: 'Wool Scarf', description: null },
          { ...ITEM_ROW, id: 23, name: 'Wool Scarf', description: null },
        ],
        error: null,
      },
      search_looks: { data: [], error: null },
      search_news: { data: [{ ...NEWS_ROW, title: 'Wool Scarf' }], error: null },
    });

    const body = await (await GET(makeRequest('?q=wool'))).json();

    const labels = body.suggestions.map((s: { label: string; type: string }) => `${s.type}:${s.label}`);
    expect(labels).toHaveLength(3);
    expect(labels.filter((l: string) => l === 'item:Wool Scarf')).toHaveLength(1);
    expect(labels).toContain('news:Wool Scarf');
    expect(labels.indexOf('item:Old Wool Scarf')).toBe(2);
  });

  it('API-SEARCH-002 候補は最大8件で切る', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ...ITEM_ROW,
      id: 200 + i,
      name: `Wool ${i}`,
      description: null,
    }));
    setupClient({ search_items: { data: rows, error: null } });

    const body = await (await GET(makeRequest('?q=wool'))).json();

    expect(body.suggestions).toHaveLength(8);
  });

  it('API-SEARCH-002 ラベルの記号は href の中で URL 用に符号化する', async () => {
    setupClient({
      search_items: { data: [{ ...ITEM_ROW, name: 'Wool & Silk/Coat', description: null }], error: null },
      search_looks: { data: [], error: null },
      search_news: { data: [], error: null },
    });

    const body = await (await GET(makeRequest('?q=wool'))).json();

    expect(body.suggestions[0].href).toBe('/search?q=Wool%20%26%20Silk%2FCoat&tab=item');
  });

  it('API-SEARCH-002 語が空なら関数を呼ばず空の一覧を返す', async () => {
    const { rpc } = setupClient();

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('API-SEARCH-002 空白だけの語も空として扱い、関数を呼ばない', async () => {
    const { rpc } = setupClient();

    const res = await GET(makeRequest('?q=%20%20'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('API-SEARCH-002 関数の失敗は記録せず空として扱い、ほかの種別の候補を 200 で返す', async () => {
    setupClient({ search_items: { data: null, error: { message: 'rpc down' } } });

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions.map((s: { type: string }) => s.type).sort()).toEqual(['look', 'news']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('API-SEARCH-002 語が101字なら 400、100字なら通す', async () => {
    setupClient();

    const tooLong = await GET(makeRequest(`?q=${'a'.repeat(101)}`));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: 'Invalid suggest query' });

    const ok = await GET(makeRequest(`?q=${'a'.repeat(100)}`));
    expect(ok.status).toBe(200);
  });

  it.each([
    ['%00', 'NUL'],
    ['wo%0Aol', '語の途中の改行'],
    ['wo%09ol', 'タブ'],
    ['%7F', 'DEL'],
  ])('API-SEARCH-002 制御文字 %s（%s）を含む語は 400 で断り、回数も取り出しも通さない', async (raw) => {
    const { rpc } = setupClient();

    const res = await GET(makeRequest(`?q=${raw}`));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid suggest query' });
    expect(incrementCounter).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('API-SEARCH-002 印字できる記号は断らず、取り出しへ渡す', async () => {
    const { rpc } = setupClient();

    const res = await GET(makeRequest('?q=a%2Cb(c).d'));

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('search_items', { search_query: 'a,b(c).d', limit_count: 8 });
  });

  it('API-SEARCH-002 例外は記録して固定の文の 500 を返し、内部の情報を出さない', async () => {
    createClient.mockRejectedValue(new Error('secret connection string'));

    const res = await GET(makeRequest('?q=wool'));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to load suggestions' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(errorSpy).toHaveBeenCalledWith('GET /api/suggest error:', expect.any(Error));
  });
});
