import { NextRequest } from 'next/server';

// jsdom の Response には静的メソッド json() が無い。NextResponse.json が内部で使うため補う。
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

// 窓口・回数の制限・公開の取り出し・画像の署名は本物を通し、DB と数え場所だけを差し替える
jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

const { createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { incrementCounter } = require('@/features/auth/ratelimit');
const { GET } = require('@/app/api/news/route');

type QueryResult = { data: unknown; error: unknown };

// 表の偽物は eq の絞りと limit の件数を行に当てて返し、応答の本文で絞りと件数を確かめられるようにする
function createNewsQuery(result: QueryResult) {
  const filters: Array<[string, unknown]> = [];
  let limit: number | null = null;
  const query: Record<string, jest.Mock> & { then?: unknown } = {
    select: jest.fn(),
    eq: jest.fn((col: string, val: unknown) => {
      filters.push([col, val]);
      return query;
    }),
    order: jest.fn(),
    limit: jest.fn((n: number) => {
      limit = n;
      return query;
    }),
  };
  query.select.mockReturnValue(query);
  query.order.mockReturnValue(query);
  const resolved = (): QueryResult => {
    if (!Array.isArray(result.data)) return result;
    const rows = (result.data as Array<Record<string, unknown>>).filter((row) =>
      filters.every(([col, val]) => row[col] === undefined || row[col] === val),
    );
    return { ...result, data: limit === null ? rows : rows.slice(0, limit) };
  };
  query.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(resolved()).then(resolve, reject);
  return query;
}

const CATEGORIES = ['COLLECTION', 'EVENT', 'STORE'];

function manyRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Article ${i + 1}`,
    published_date: '2026-04-01',
    category: CATEGORIES[i % CATEGORIES.length],
    image_url: null,
    content: 'summary',
  }));
}

function setupClients(result: QueryResult, signed: { data: unknown; error: unknown } = {
  data: { signedUrl: 'https://project.supabase.co/storage/v1/object/sign/news-images/news/a.jpg?token=t' },
  error: null,
}) {
  const query = createNewsQuery(result);
  const from = jest.fn().mockReturnValue(query);
  const createSignedUrl = jest.fn().mockResolvedValue(signed);
  const storageFrom = jest.fn().mockReturnValue({ createSignedUrl });

  createPublicClient.mockResolvedValue({ from });
  createServiceRoleClient.mockResolvedValue({ storage: { from: storageFrom } });

  return { query, from, createSignedUrl, storageFrom };
}

function makeRequest(search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`https://shop.example.com/api/news${search}`, { method: 'GET', headers });
}

const PUBLISHED_ROW = {
  id: 7,
  title: 'Spring collection',
  published_date: '2026-04-01',
  category: 'COLLECTION',
  image_url: 'news/a.jpg',
  content: 'summary',
};

describe('GET /api/news 公開済みの記事の一覧', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    incrementCounter.mockResolvedValue(1);
  });

  it('API-NEWS-001 公開済みの記事を公開日の新しい順で取り出し、本文を含めず署名つきの画像で 200 を返す', async () => {
    const { from, query, createSignedUrl, storageFrom } = setupClients({ data: [PUBLISHED_ROW], error: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        ...PUBLISHED_ROW,
        image_url: 'https://project.supabase.co/storage/v1/object/sign/news-images/news/a.jpg?token=t',
      },
    ]);
    expect(from).toHaveBeenCalledWith('news_articles');
    expect(query.select).toHaveBeenCalledWith('id, title, published_date, category, image_url, content');
    expect(query.eq).toHaveBeenCalledWith('status', 'published');
    expect(query.order).toHaveBeenCalledWith('published_date', { ascending: false });
    expect(storageFrom).toHaveBeenCalledWith('news-images');
    expect(createSignedUrl).toHaveBeenCalledWith('news/a.jpg', 3600);
  });

  it('API-NEWS-001 limit が無い時は12件で取り出し、12件の本文を 200 で返す', async () => {
    const { query } = setupClients({ data: manyRows(30), error: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(12);
    expect(query.limit).toHaveBeenCalledWith(12);
  });

  it.each([
    ['5', 5],
    ['20', 20],
    ['50', 20],
  ])('API-NEWS-001 limit=%s は %i 件を返す（上限は20）', async (param, expected) => {
    setupClients({ data: manyRows(30), error: null });

    const res = await GET(makeRequest(`?limit=${param}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(expected);
    expect(body[0]).toMatchObject({ id: 1, title: 'Article 1' });
  });

  it.each(['0', '-3', '3.5', 'abc', ''])('API-NEWS-001 limit=%p は数字だけの正の整数でないので12件に戻して返す', async (param) => {
    setupClients({ data: manyRows(30), error: null });

    const res = await GET(makeRequest(`?limit=${param}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(12);
  });

  it('API-NEWS-001 category で絞った記事だけを返す', async () => {
    const { query } = setupClients({ data: manyRows(9), error: null });

    const res = await GET(makeRequest('?category=EVENT'));

    expect(res.status).toBe(200);
    const body: Array<{ category: string }> = await res.json();
    expect(body).toHaveLength(3);
    expect(body.every((row) => row.category === 'EVENT')).toBe(true);
    expect(query.eq).toHaveBeenCalledWith('category', 'EVENT');
  });

  it('API-NEWS-001 category=ALL と category 無しでは分類で絞らずに全部の分類を返す', async () => {
    const all = setupClients({ data: manyRows(9), error: null });
    const allRes = await GET(makeRequest('?category=ALL'));
    expect(await allRes.json()).toHaveLength(9);
    expect(all.query.eq).not.toHaveBeenCalledWith('category', expect.anything());

    const none = setupClients({ data: manyRows(9), error: null });
    const noneRes = await GET(makeRequest());
    expect(await noneRes.json()).toHaveLength(9);
    expect(none.query.eq).not.toHaveBeenCalledWith('category', expect.anything());
  });

  it('API-NEWS-001 回数の制限を news:list の窓口として数え、送り元は x-forwarded-for の先頭にする', async () => {
    setupClients({ data: [], error: null });

    await GET(makeRequest('', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));

    expect(incrementCounter).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.9', endpoint: 'news:list', subject: null }),
    );
  });

  it('API-NEWS-001 10分に60回までは通す', async () => {
    setupClients({ data: [], error: null });
    incrementCounter.mockResolvedValue(60);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
  });

  it('API-NEWS-001 61回目は 429 と Retry-After 600 を返し、DB を読まない', async () => {
    setupClients({ data: [PUBLISHED_ROW], error: null });
    incrementCounter.mockResolvedValue(61);

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(createPublicClient).not.toHaveBeenCalled();
  });

  it('API-NEWS-001 数え場所が落ちた時は通さず 503 を返し、DB を読まない', async () => {
    setupClients({ data: [PUBLISHED_ROW], error: null });
    incrementCounter.mockRejectedValue(new Error('counter down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Rate limiter unavailable' });
    expect(createPublicClient).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('API-NEWS-001 DB の失敗は取り出しの関数が空にするので 200 と空の配列を返す', async () => {
    setupClients({ data: null, error: { message: 'db down' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('API-NEWS-001 署名に失敗した画像は元の値のまま返す', async () => {
    setupClients({ data: [PUBLISHED_ROW], error: null }, { data: null, error: { message: 'sign failed' } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect((await res.json())[0].image_url).toBe('news/a.jpg');
  });

  it('API-NEWS-001 例外は記録して固定の文の 500 を返し、内部の情報を出さない', async () => {
    createPublicClient.mockRejectedValue(new Error('secret connection string'));
    createServiceRoleClient.mockResolvedValue({ storage: { from: jest.fn() } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to fetch news' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(errorSpy).toHaveBeenCalledWith('GET /api/news error:', expect.any(Error));
    errorSpy.mockRestore();
  });
});
