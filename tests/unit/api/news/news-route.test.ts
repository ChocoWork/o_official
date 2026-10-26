export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      headers: new Headers(),
      json: async () => body,
    }),
  },
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(),
}));

const route = require('@/app/api/news/route');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { getPublishedNews } = require('@/features/news/services/public');

function newsRequest(query = '') {
  return { nextUrl: new URL(`http://localhost/api/news${query}`) };
}

const ARTICLES = [
  { id: '1', title: 'A', category: 'EVENT' },
  { id: '2', title: 'B', category: 'STORE' },
];

describe('GET /api/news', () => {
  let consoleErrorSpy: jest.SpyInstance;

  function consoleErrorSpyCalls() {
    return consoleErrorSpy.mock.calls;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(null);
    getPublishedNews.mockResolvedValue([]);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-NEWS-004 回数の制限に news:list・60回・600秒と要求を渡す', async () => {
    const request = newsRequest();

    await route.GET(request);

    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceRateLimit).toHaveBeenCalledWith({
      request,
      endpoint: 'news:list',
      limit: 60,
      windowSeconds: 600,
    });
  });

  it.each([
    { label: '429', status: 429, body: { error: 'Too many requests' } },
    { label: '503', status: 503, body: { error: 'Rate limiter unavailable' } },
  ])('DD-NEWS-004 回数の制限の $label をそのまま返し、取り出しを呼ばない', async ({ status, body }) => {
    const limited = { status, headers: new Headers(), json: async () => body };
    enforceRateLimit.mockResolvedValue(limited);

    const res = await route.GET(newsRequest('?limit=5'));

    expect(res).toBe(limited);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getPublishedNews).not.toHaveBeenCalled();
  });

  it('DD-NEWS-004 クエリが無ければ分類は ALL・件数は12で取り出し、200 を返す', async () => {
    const res = await route.GET(newsRequest());

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 12 });
    expect(res.status).toBe(200);
  });

  it('DD-NEWS-004 数字の件数はそのまま渡す', async () => {
    await route.GET(newsRequest('?limit=5'));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 5 });
  });

  it('DD-NEWS-004 上限ちょうどの20はそのまま渡す', async () => {
    await route.GET(newsRequest('?limit=20'));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 20 });
  });

  it('DD-NEWS-004 20を超える件数は20に丸める', async () => {
    await route.GET(newsRequest('?limit=25'));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 20 });
  });

  it('DD-NEWS-004 件数0は既定の12にする', async () => {
    await route.GET(newsRequest('?limit=0'));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 12 });
  });

  it.each(['abc', '-1', '1.5', ''])('DD-NEWS-004 数字だけでない件数 "%s" は既定の12にする', async (limit) => {
    await route.GET(newsRequest(`?limit=${encodeURIComponent(limit)}`));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 12 });
  });

  it('DD-NEWS-004 Infinity に読める400桁の件数は既定の12にする', async () => {
    await route.GET(newsRequest(`?limit=${'9'.repeat(400)}`));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 12 });
  });

  it('DD-NEWS-004 分類は許可の一覧の値に直して渡す（小文字は大文字にする）', async () => {
    await route.GET(newsRequest('?category=collection&limit=3'));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'COLLECTION', limit: 3 });
  });

  it.each([
    ['300 字', 'X'.repeat(300)],
    ['記号つき', 'EVENT;drop'],
    ['一覧に無い', 'FOO'],
  ])('DD-NEWS-004 外れた分類（%s）は ALL にして取り出しへ渡す（SEC-NEWS-012）', async (_label, category) => {
    const res = await route.GET(newsRequest(`?category=${encodeURIComponent(category)}`));

    expect(getPublishedNews).toHaveBeenCalledWith({ category: 'ALL', limit: 12 });
    expect(res.status).toBe(200);
  });

  it('DD-NEWS-004 取り出した記事を 200 で同じ配列のまま返す', async () => {
    getPublishedNews.mockResolvedValue(ARTICLES);

    const res = await route.GET(newsRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(ARTICLES);
  });

  it('DD-NEWS-004 取り出しが例外なら 500 の固定の文を返し、console には { name, code } だけを記録する', async () => {
    const error = new Error('service role key missing');
    getPublishedNews.mockRejectedValue(error);

    const res = await route.GET(newsRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to fetch news' });
    expect(consoleErrorSpyCalls()).toEqual([
      ['GET /api/news error:', { name: 'Error', code: null }],
    ]);
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('service role key missing');
  });

  it('DD-NEWS-004 取り出しが NewsFetchError（code つき）なら 500 の固定の文を返し、記録は名前と符号だけ', async () => {
    const error = Object.assign(new Error('Failed to fetch published news'), {
      name: 'NewsFetchError',
      code: '42501',
    });
    getPublishedNews.mockRejectedValue(error);

    const res = await route.GET(newsRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to fetch news' });
    expect(consoleErrorSpyCalls()).toEqual([
      ['GET /api/news error:', { name: 'NewsFetchError', code: '42501' }],
    ]);
  });

  it('DD-NEWS-004 全ての応答（200・429・503・500）が Cache-Control: private, no-store で返る（SEC-NEWS-006）', async () => {
    const cases: Array<() => void> = [
      () => enforceRateLimit.mockResolvedValue(null),
      () =>
        enforceRateLimit.mockResolvedValue({ status: 429, headers: new Headers(), json: async () => ({}) }),
      () =>
        enforceRateLimit.mockResolvedValue({ status: 503, headers: new Headers(), json: async () => ({}) }),
      () => {
        enforceRateLimit.mockResolvedValue(null);
        getPublishedNews.mockRejectedValue(new Error('boom'));
      },
      () => enforceRateLimit.mockRejectedValue(new Error('limiter crashed')),
    ];
    const statuses: number[] = [];

    for (const arrange of cases) {
      jest.clearAllMocks();
      enforceRateLimit.mockResolvedValue(null);
      getPublishedNews.mockResolvedValue([]);
      arrange();
      const res = await route.GET(newsRequest());
      statuses.push(res.status);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }

    expect(statuses).toEqual([200, 429, 503, 500, 500]);
  });

  it('DD-NEWS-004 回数の制限が付けた別の Cache-Control は private, no-store に置き換える', async () => {
    const limited = { status: 429, headers: new Headers({ 'Cache-Control': 'public, max-age=60' }), json: async () => ({}) };
    enforceRateLimit.mockResolvedValue(limited);

    const res = await route.GET(newsRequest());

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('DD-NEWS-004 回数の制限が例外なら 500 の固定の文を返し、取り出しを呼ばない', async () => {
    enforceRateLimit.mockRejectedValue(new Error('limiter crashed'));

    const res = await route.GET(newsRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to fetch news' });
    expect(getPublishedNews).not.toHaveBeenCalled();
  });
});
