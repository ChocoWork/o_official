export {};

// 検索の窓口2つ（/api/search・/api/suggest）→ 取り出しの関数 → DB の関数の道を、
// 窓口・取り出しの関数・回数の制限を本物のまま通して確かめる。
// 差し替えるのは外との境目（Supabase の client・回数の数え場所・応答の型）だけ
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers ?? {}),
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
const searchRoute = require('@/app/api/search/route');
const suggestRoute = require('@/app/api/suggest/route');

type RpcResult = { data: unknown; error: unknown };
type RpcCall = { name: string; args: Record<string, unknown> };

function createFakeClient(results: Record<string, RpcResult>) {
  const calls: RpcCall[] = [];
  return {
    calls,
    rpc: jest.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return results[name] ?? { data: [], error: null };
    }),
    storage: { from: jest.fn() },
  };
}

function makeRequest(path: string, headers: Record<string, string> = {}) {
  const all: Record<string, string> = { 'x-forwarded-for': '203.0.113.5', ...headers };
  return {
    nextUrl: new URL(`http://localhost${path}`),
    headers: { get: (name: string) => all[name.toLowerCase()] ?? null },
  };
}

const ITEM = { id: 1, name: 'Wool coat', description: 'warm wool coat', category: 'Outer', image_url: null, price: 12800 };
const LOOK = { id: 2, season_year: 2025, season_type: 'AW', theme: 'Coat season', theme_description: null, image_urls: null };
const NEWS = { id: 3, title: 'Coat restock', category: 'INFO', image_url: null, content: 'coat is back', published_date: '2025-03-01' };

let userClient: ReturnType<typeof createFakeClient>;
let serviceClient: ReturnType<typeof createFakeClient>;
let errorSpy: jest.SpyInstance;

function setupClients(userResults: Record<string, RpcResult> = {}) {
  userClient = createFakeClient({
    search_items: { data: [ITEM], error: null },
    search_looks: { data: [LOOK], error: null },
    search_news: { data: [NEWS], error: null },
    ...userResults,
  });
  serviceClient = createFakeClient({ get_popular_items: { data: [], error: null } });
  createClient.mockResolvedValue(userClient);
  createServiceRoleClient.mockResolvedValue(serviceClient);
}

beforeEach(() => {
  jest.clearAllMocks();
  incrementCounter.mockResolvedValue(1);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  setupClients();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('/api/search の道', () => {
  it('ARC-SEARCH-001 窓口は語を利用者の client の3つの検索の関数へ引数として渡し、結果を種別ごとに返す', async () => {
    const response = await searchRoute.GET(makeRequest('/api/search?q=coat'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(userClient.calls.map((call) => call.name).sort()).toEqual(['search_items', 'search_looks', 'search_news']);
    for (const call of userClient.calls) {
      expect(call.args).toEqual({ search_query: 'coat', limit_count: 8 });
    }
    expect(body.query).toBe('coat');
    expect(body.items.map((r: { id: string }) => r.id)).toEqual(['1']);
    expect(body.looks.map((r: { id: string }) => r.id)).toEqual(['2']);
    expect(body.news.map((r: { id: string }) => r.id)).toEqual(['3']);
    expect(body.counts).toEqual({ all: 3, item: 1, look: 1, news: 1 });
    expect(body.empty).toBe(false);
    expect(response.headers.get('x-search-duration-ms')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('ARC-SEARCH-001 フィルタの文字を含む語も加工せず検索の関数の引数のまま渡す', async () => {
    const hostile = 'a,name.eq.x),or(id.gt.0';
    await searchRoute.GET(makeRequest(`/api/search?q=${encodeURIComponent(hostile)}`));

    expect(userClient.calls).toHaveLength(3);
    for (const call of userClient.calls) {
      expect(call.args.search_query).toBe(hostile);
    }
  });

  it('ARC-SEARCH-001 検索の関数は利用者の client だけで呼び、service role の client は人気商品の関数だけに使う', async () => {
    await searchRoute.GET(makeRequest('/api/search?q=coat'));

    expect(userClient.calls.map((call) => call.name)).not.toContain('get_popular_items');
    expect(serviceClient.calls.map((call) => call.name)).toEqual(['get_popular_items']);
  });

  it('ARC-SEARCH-001 受けた tab を応答の tab にそのまま返す', async () => {
    const response = await searchRoute.GET(makeRequest('/api/search?q=coat&tab=look'));
    const body = await response.json();

    expect(body.tab).toBe('look');
  });

  it('ARC-SEARCH-001 tab を付けない時は all を返す', async () => {
    const body = await (await searchRoute.GET(makeRequest('/api/search?q=coat'))).json();
    expect(body.tab).toBe('all');
  });

  it('ARC-SEARCH-001 語が空なら検索の関数を呼ばず、利用者の client も作らない', async () => {
    const response = await searchRoute.GET(makeRequest('/api/search'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(createClient).not.toHaveBeenCalled();
    expect(userClient.rpc).not.toHaveBeenCalled();
    expect(body.counts).toEqual({ all: 0, item: 0, look: 0, news: 0 });
    expect(body.empty).toBe(false);
  });

  it('ARC-SEARCH-001 前後の空白だけの語は空として扱い、検索の関数を呼ばない', async () => {
    const body = await (await searchRoute.GET(makeRequest('/api/search?q=%20%20%20'))).json();

    expect(body.query).toBe('');
    expect(userClient.rpc).not.toHaveBeenCalled();
  });

  it('ARC-SEARCH-001 語の前後の空白は落として渡す', async () => {
    await searchRoute.GET(makeRequest('/api/search?q=%20coat%20'));
    expect(userClient.calls[0].args.search_query).toBe('coat');
  });

  it('ARC-SEARCH-001 種別ごとの関数が1つ失敗したら窓口は全体を 500 にし、関数名と符号だけ記録する（SEC-SEARCH-017・018）', async () => {
    setupClients({ search_looks: { data: null, error: { message: 'boom for coat', code: '42501' } } });

    const response = await searchRoute.GET(makeRequest('/api/search?q=coat'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to search content' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(errorSpy).toHaveBeenCalledWith('Search function failed:', { fn: 'search_looks', name: 'UnknownError', code: '42501' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('boom');
  });

  it('ARC-SEARCH-001 3種とも失敗したら窓口は 500 にし、失敗を3回記録する（SEC-SEARCH-017）', async () => {
    const failure = { data: null, error: { message: 'down' } };
    setupClients({ search_items: failure, search_looks: failure, search_news: failure });

    const response = await searchRoute.GET(makeRequest('/api/search?q=coat'));

    expect(response.status).toBe(500);
    const searchFailures = errorSpy.mock.calls.filter((call) => call[0] === 'Search function failed:');
    expect(searchFailures).toHaveLength(3);
  });

  it('ARC-SEARCH-001 外のサイトから読み込まれた要求は 403 で、検索の関数を呼ばない（SEC-SEARCH-020）', async () => {
    const response = await searchRoute.GET(makeRequest('/api/search?q=coat', { 'sec-fetch-site': 'cross-site' }));

    expect(response.status).toBe(403);
    expect(userClient.calls).toHaveLength(0);
  });
});

describe('/api/suggest の道', () => {
  it('ARC-SEARCH-001 候補の窓口は語を利用者の client の3つの検索の関数へ8件で渡し、候補を返す', async () => {
    const response = await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(userClient.calls.map((call) => call.name).sort()).toEqual(['search_items', 'search_looks', 'search_news']);
    for (const call of userClient.calls) {
      expect(call.args).toEqual({ search_query: 'coat', limit_count: 8 });
    }
    expect(body.suggestions).toEqual(expect.arrayContaining([
      { label: 'Wool coat', type: 'item', href: '/search?q=Wool%20coat&tab=item' },
      { label: 'Coat season', type: 'look', href: '/search?q=Coat%20season&tab=look' },
      { label: 'Coat restock', type: 'news', href: '/search?q=Coat%20restock&tab=news' },
    ]));
    expect(body.suggestions).toHaveLength(3);
  });

  it('ARC-SEARCH-001 候補では人気商品の関数も service role の client も呼ばない', async () => {
    await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));

    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(serviceClient.rpc).not.toHaveBeenCalled();
  });

  it('ARC-SEARCH-001 語が空なら空の候補を返し、client を作らない', async () => {
    const response = await suggestRoute.GET(makeRequest('/api/suggest'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: [] });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('ARC-SEARCH-001 検索の関数が失敗した種別は候補に出さず、窓口は 200 を返す', async () => {
    setupClients({ search_items: { data: null, error: { message: 'boom' } } });

    const response = await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.suggestions.map((s: { type: string }) => s.type).sort()).toEqual(['look', 'news']);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
