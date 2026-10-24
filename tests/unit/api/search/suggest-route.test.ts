export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/search/services/search.service', () => ({
  getSearchSuggestions: jest.fn(),
}));

const route = require('@/app/api/suggest/route');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { getSearchSuggestions } = require('@/features/search/services/search.service');

function suggestRequest(query = '') {
  return { nextUrl: new URL(`http://localhost/api/suggest${query}`) };
}

const SUGGESTIONS = [{ label: 'coat', type: 'item', href: '/item/1' }];

describe('GET /api/suggest', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    getSearchSuggestions.mockResolvedValue(SUGGESTIONS);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-SEARCH-005 q が無いと suggest:public・200・600 で数え、空の語と8件で取り出して 200 を返す', async () => {
    const request = suggestRequest();

    const response = await route.GET(request);

    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({
      request,
      endpoint: 'suggest:public',
      limit: 200,
      windowSeconds: 600,
    });
    expect(getSearchSuggestions).toHaveBeenCalledWith('', 8);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: SUGGESTIONS });
  });

  it('DD-SEARCH-005 前後の空白を落とした語を取り出しの関数へ渡す', async () => {
    await route.GET(suggestRequest('?q=%20co%20'));

    expect(getSearchSuggestions).toHaveBeenCalledWith('co', 8);
  });

  it.each(['a%00b', 'a%1Fb', 'a%7Fb', 'a%0Ab'])('DD-SEARCH-005 q=%s の制御文字は 400 で断り、数えも取り出しも呼ばない', async (value) => {
    const response = await route.GET(suggestRequest(`?q=${value}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid suggest query' });
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(getSearchSuggestions).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-005 前後の空白を落として101字になる語は 400 で断る', async () => {
    const response = await route.GET(suggestRequest(`?q=${'a'.repeat(101)}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid suggest query' });
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(getSearchSuggestions).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-005 100字の語は通す', async () => {
    const query = 'a'.repeat(100);

    const response = await route.GET(suggestRequest(`?q=${query}`));

    expect(response.status).toBe(200);
    expect(getSearchSuggestions).toHaveBeenCalledWith(query, 8);
  });

  it('DD-SEARCH-005 カンマ・括弧・ピリオドは今の動きで断らず通す', async () => {
    const response = await route.GET(suggestRequest(`?q=${encodeURIComponent('a,b).or(')}`));

    expect(response.status).toBe(200);
    expect(getSearchSuggestions).toHaveBeenCalledWith('a,b).or(', 8);
  });

  it('DD-SEARCH-005 回数の超過は制限の応答をそのまま返し、取り出しの関数を呼ばない', async () => {
    const limited = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    enforceRateLimit.mockResolvedValue(limited);

    const response = await route.GET(suggestRequest('?q=co'));

    expect(response).toBe(limited);
    expect(getSearchSuggestions).not.toHaveBeenCalled();
  });

  it('DD-SEARCH-005 取り出しの例外は 500 の固定の文にし、console.error に書く', async () => {
    const failure = new Error('db secret detail');
    getSearchSuggestions.mockRejectedValue(failure);

    const response = await route.GET(suggestRequest('?q=co'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load suggestions' });
    expect(consoleErrorSpy).toHaveBeenCalledWith('GET /api/suggest error:', expect.anything());
  });

  it('DD-SEARCH-005 回数の制限の例外も 500 の固定の文にする', async () => {
    enforceRateLimit.mockRejectedValue(new Error('boom'));

    const response = await route.GET(suggestRequest('?q=co'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load suggestions' });
    expect(getSearchSuggestions).not.toHaveBeenCalled();
  });
});
