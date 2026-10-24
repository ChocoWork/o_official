import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// 窓口・共有の回数の制限・共有の proxy は本物を通し、数え場所と取り出しの関数だけを差し替える
jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

jest.mock('@/features/search/services/search.service', () => ({
  executeSearch: jest.fn(),
  getSearchSuggestions: jest.fn(),
}));

const { incrementCounter } = require('@/features/auth/ratelimit');
const { executeSearch, getSearchSuggestions } = require('@/features/search/services/search.service');
const searchRoute = require('@/app/api/search/route');
const suggestRoute = require('@/app/api/suggest/route');
const { proxy, config } = require('@/proxy');

const ORIGIN = 'https://shop.example.com';

function makeRequest(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${path}`, { method: 'GET', headers });
}

describe('公開の窓口にかかる回数の制限と共有の proxy（ARC-SEARCH-005）', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    incrementCounter.mockResolvedValue(1);
    executeSearch.mockResolvedValue({ query: 'coat', items: [] });
    getSearchSuggestions.mockResolvedValue([]);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('GET /api/search', () => {
    it('ARC-SEARCH-005 preview が無い検索は search:public として数え、10分の窓の頭の時刻を使う', async () => {
      await searchRoute.GET(makeRequest('/api/search?q=coat'));

      expect(incrementCounter).toHaveBeenCalledTimes(1);
      const arg = incrementCounter.mock.calls[0][0];
      expect(arg).toMatchObject({ endpoint: 'search:public', subject: null });
      expect(new Date(arg.bucket).getTime() % (600 * 1000)).toBe(0);
    });

    it('ARC-SEARCH-005 preview が無い検索は10分に120回までは通し、件数は8件で取り出す', async () => {
      incrementCounter.mockResolvedValue(120);

      const res = await searchRoute.GET(makeRequest('/api/search?q=coat'));

      expect(res.status).toBe(200);
      expect(executeSearch).toHaveBeenCalledWith({ query: 'coat', tab: 'all', limitPerType: 8 });
    });

    it('ARC-SEARCH-005 preview が無い検索の121回目は 429 と Retry-After 600 を返し、取り出しを呼ばない', async () => {
      incrementCounter.mockResolvedValue(121);

      const res = await searchRoute.GET(makeRequest('/api/search?q=coat'));

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(await res.json()).toEqual({ error: 'Too many requests' });
      expect(executeSearch).not.toHaveBeenCalled();
    });

    it('ARC-SEARCH-005 preview=true の検索は search:preview として数え、件数は3件で取り出す', async () => {
      await searchRoute.GET(makeRequest('/api/search?q=coat&preview=true'));

      expect(incrementCounter).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'search:preview' }));
      expect(executeSearch).toHaveBeenCalledWith({ query: 'coat', tab: 'all', limitPerType: 3 });
    });

    it('ARC-SEARCH-005 preview=true の検索は20回までは通し、21回目は 429 を返して取り出しを呼ばない', async () => {
      incrementCounter.mockResolvedValue(20);
      const allowed = await searchRoute.GET(makeRequest('/api/search?q=coat&preview=true'));
      expect(allowed.status).toBe(200);

      executeSearch.mockClear();
      incrementCounter.mockResolvedValue(21);
      const blocked = await searchRoute.GET(makeRequest('/api/search?q=coat&preview=true'));

      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('600');
      expect(executeSearch).not.toHaveBeenCalled();
    });

    it.each(['false', 'FALSE', '1', 'yes', ''])(
      'ARC-SEARCH-005 preview=%p は true の文字ではないので search:public の枠で数える',
      async (value) => {
        await searchRoute.GET(makeRequest(`/api/search?q=coat&preview=${value}`));

        expect(incrementCounter).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'search:public' }));
        expect(executeSearch).toHaveBeenCalledWith(expect.objectContaining({ limitPerType: 8 }));
      },
    );

    it('ARC-SEARCH-005 使い切った枠が1つでも、もう1つの枠は別に数えるので通す', async () => {
      incrementCounter.mockImplementation(async ({ endpoint }: { endpoint: string }) =>
        endpoint === 'search:preview' ? 21 : 1,
      );

      const preview = await searchRoute.GET(makeRequest('/api/search?q=coat&preview=true'));
      const full = await searchRoute.GET(makeRequest('/api/search?q=coat'));

      expect(preview.status).toBe(429);
      expect(full.status).toBe(200);
    });

    it('ARC-SEARCH-005 入力が外れた検索は 400 で断り、回数を数えない', async () => {
      const res = await searchRoute.GET(makeRequest(`/api/search?q=${'a'.repeat(101)}`));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid search query' });
      expect(incrementCounter).not.toHaveBeenCalled();
      expect(executeSearch).not.toHaveBeenCalled();
    });

    it('ARC-SEARCH-005 数え場所が落ちた時は通さず 503 を返し、取り出しを呼ばない', async () => {
      incrementCounter.mockRejectedValue(new Error('counter down'));

      const res = await searchRoute.GET(makeRequest('/api/search?q=coat'));

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
      expect(executeSearch).not.toHaveBeenCalled();
    });

    it('ARC-SEARCH-005 送り元は x-forwarded-for の先頭を使い、subject は渡さない', async () => {
      await searchRoute.GET(makeRequest('/api/search?q=coat', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));

      expect(incrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '203.0.113.9', subject: null }),
      );
    });

    it('ARC-SEARCH-005 x-forwarded-for が無ければ x-real-ip を使い、どちらも無ければ 127.0.0.1 で数える', async () => {
      await searchRoute.GET(makeRequest('/api/search?q=coat', { 'x-real-ip': '198.51.100.7' }));
      await searchRoute.GET(makeRequest('/api/search?q=coat'));

      expect(incrementCounter.mock.calls[0][0].ip).toBe('198.51.100.7');
      expect(incrementCounter.mock.calls[1][0].ip).toBe('127.0.0.1');
    });
  });

  describe('GET /api/suggest', () => {
    it('ARC-SEARCH-005 候補は suggest:public として数え、8件で取り出す', async () => {
      await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));

      expect(incrementCounter).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'suggest:public', subject: null }),
      );
      expect(getSearchSuggestions).toHaveBeenCalledWith('coat', 8);
    });

    it('ARC-SEARCH-005 候補は10分に200回までは通し、201回目は 429 と Retry-After 600 を返して取り出しを呼ばない', async () => {
      incrementCounter.mockResolvedValue(200);
      const allowed = await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));
      expect(allowed.status).toBe(200);

      getSearchSuggestions.mockClear();
      incrementCounter.mockResolvedValue(201);
      const blocked = await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));

      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('600');
      expect(getSearchSuggestions).not.toHaveBeenCalled();
    });

    it('ARC-SEARCH-005 制御文字を含む語は 400 で断り、回数を数えない', async () => {
      const res = await suggestRoute.GET(makeRequest('/api/suggest?q=co%00at'));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid suggest query' });
      expect(incrementCounter).not.toHaveBeenCalled();
      expect(getSearchSuggestions).not.toHaveBeenCalled();
    });

    it('ARC-SEARCH-005 数え場所が落ちた時は通さず 503 を返し、取り出しを呼ばない', async () => {
      incrementCounter.mockRejectedValue(new Error('counter down'));

      const res = await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));

      expect(res.status).toBe(503);
      expect(getSearchSuggestions).not.toHaveBeenCalled();
    });

    it('ARC-SEARCH-005 検索の枠とは別の名前で数える', async () => {
      await suggestRoute.GET(makeRequest('/api/suggest?q=coat'));
      await searchRoute.GET(makeRequest('/api/search?q=coat'));

      const endpoints = incrementCounter.mock.calls.map(([arg]: [{ endpoint: string }]) => arg.endpoint);
      expect(endpoints).toEqual(['suggest:public', 'search:public']);
    });
  });

  describe('共有の proxy', () => {
    it.each(['/search', '/search?q=coat&tab=item', '/api/search?q=coat', '/api/suggest?q=coat'])(
      'ARC-SEARCH-005 %s の応答に Referrer-Policy no-referrer を付け、語を参照元で外へ送らない',
      (path) => {
        const res = proxy(makeRequest(path));

        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      },
    );

    it('ARC-SEARCH-005 proxy は検索の応答に Cache-Control を付けない', () => {
      const res = proxy(makeRequest('/api/search?q=coat'));

      expect(res.headers.get('Cache-Control')).toBeNull();
    });

    it('ARC-SEARCH-005 matcher は全部の道を対象にするので検索の窓口にも掛かる', () => {
      expect(config.matcher).toEqual(['/:path*']);
    });
  });
});
