export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/search/services/search.service', () => ({
  executeSearch: jest.fn(),
}));

const route = require('@/app/api/search/route');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { executeSearch } = require('@/features/search/services/search.service');

function searchRequest(query = '') {
  return { nextUrl: new URL(`http://localhost/api/search${query}`) };
}

const RESULT = {
  query: '',
  tab: 'all',
  items: [],
  looks: [],
  news: [],
  counts: { all: 0, item: 0, look: 0, news: 0 },
  popularItems: [],
  empty: true,
};

describe('GET /api/search', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    executeSearch.mockResolvedValue(RESULT);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-SEARCH-004 引数が全部無いと search:public・120・600 で数え、空の語・all・8件で取り出して 200 を返す', async () => {
    const request = searchRequest();

    const response = await route.GET(request);

    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({
      request,
      endpoint: 'search:public',
      limit: 120,
      windowSeconds: 600,
    });
    expect(executeSearch).toHaveBeenCalledWith({ query: '', tab: 'all', limitPerType: 8 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
  });

  it('DD-SEARCH-004 前後の空白を落とした語とタブを取り出しの関数へ渡す', async () => {
    await route.GET(searchRequest('?q=%20coat%20&tab=item'));

    expect(executeSearch).toHaveBeenCalledWith({ query: 'coat', tab: 'item', limitPerType: 8 });
  });

  it.each(['all', 'item', 'look', 'news'])('DD-SEARCH-004 tab=%s を通す', async (tab) => {
    const response = await route.GET(searchRequest(`?tab=${tab}`));

    expect(response.status).toBe(200);
    expect(executeSearch).toHaveBeenCalledWith({ query: '', tab, limitPerType: 8 });
  });

  it('DD-SEARCH-004 preview=true は search:preview・20 で数え、1種別3件で取り出す', async () => {
    const request = searchRequest('?q=coat&preview=true');

    const response = await route.GET(request);

    expect(enforceRateLimit).toHaveBeenCalledWith({
      request,
      endpoint: 'search:preview',
      limit: 20,
      windowSeconds: 600,
    });
    expect(executeSearch).toHaveBeenCalledWith({ query: 'coat', tab: 'all', limitPerType: 3 });
    expect(response.status).toBe(200);
  });

  it.each(['false', '1', 'TRUE', ''])('DD-SEARCH-004 preview=%s は偽として search:public・120・8件で扱う', async (value) => {
    const request = searchRequest(`?q=coat&preview=${value}`);

    await route.GET(request);

    expect(enforceRateLimit).toHaveBeenCalledWith({
      request,
      endpoint: 'search:public',
      limit: 120,
      windowSeconds: 600,
    });
    expect(executeSearch).toHaveBeenCalledWith({ query: 'coat', tab: 'all', limitPerType: 8 });
  });

  it('DD-SEARCH-004 正しくないタブは 400 で断り、数えも取り出しも呼ばない', async () => {
    const response = await route.GET(searchRequest('?tab=foo'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid search query' });
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(executeSearch).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-004 前後の空白を落として101字になる語は 400 で断る', async () => {
    const response = await route.GET(searchRequest(`?q=${'a'.repeat(101)}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid search query' });
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(executeSearch).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-004 100字の語は通す', async () => {
    const query = 'a'.repeat(100);

    const response = await route.GET(searchRequest(`?q=${query}`));

    expect(response.status).toBe(200);
    expect(executeSearch).toHaveBeenCalledWith({ query, tab: 'all', limitPerType: 8 });
  });

  it('DD-SEARCH-004 空白を含めて101字でも、空白を落とすと100字なら通す', async () => {
    const query = 'a'.repeat(100);

    const response = await route.GET(searchRequest(`?q=%20${query}`));

    expect(response.status).toBe(200);
    expect(executeSearch).toHaveBeenCalledWith({ query, tab: 'all', limitPerType: 8 });
  });

  it('DD-SEARCH-004 回数の超過は制限の応答をそのまま返し、取り出しの関数を呼ばない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    enforceRateLimit.mockResolvedValue(limited);

    const response = await route.GET(searchRequest('?q=coat'));

    expect(response).toBe(limited);
    expect(executeSearch).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-004 取り出しの例外は 500 の固定の文にし、console.error に書く', async () => {
    const failure = new Error('db secret detail');
    executeSearch.mockRejectedValue(failure);

    const response = await route.GET(searchRequest('?q=coat'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to search content' });
    expect(consoleErrorSpy).toHaveBeenCalledWith('GET /api/search error:', expect.anything());
  });

  it('DD-SEARCH-004 回数の制限の例外も 500 の固定の文にする', async () => {
    enforceRateLimit.mockRejectedValue(new Error('boom'));

    const response = await route.GET(searchRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to search content' });
    expect(executeSearch).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-004 成功には経過のミリ秒を0以上の整数の文字で x-search-duration-ms に付ける', async () => {
    const response = await route.GET(searchRequest('?q=coat'));

    const duration = response.headers.get('x-search-duration-ms');
    expect(duration).toMatch(/^\d+$/);
    expect(Number(duration)).toBeGreaterThanOrEqual(0);
  });
});
