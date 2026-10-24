import {
  getPublishedNews,
  getPublishedNewsCount,
  getPublishedNewsDetailById,
  getPublishedNewsNavigation,
} from '@/features/news/services/public';
import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { signNewsImageFields } from '@/lib/storage/news-images';

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/storage/news-images', () => ({
  signNewsImageFields: jest.fn(),
}));

const mockedCreatePublicClient = createPublicClient as jest.Mock;
const mockedCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockedSignNewsImageFields = signNewsImageFields as jest.Mock;

type Call = [string, ...unknown[]];

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

/** 問い合わせの組み立てを記録し、await・single() で result を返す差し替えの client */
function makeClient(result: QueryResult) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = jest.fn((...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    });
  }
  builder.single = jest.fn(() => {
    calls.push(['single']);
    return Promise.resolve(result);
  });
  builder.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  const from = jest.fn((table: string) => {
    calls.push(['from', table]);
    return builder;
  });
  return { client: { from }, calls, from };
}

function callsOf(calls: Call[], method: string) {
  return calls.filter(([name]) => name === method);
}

const serviceClient = { from: jest.fn(), storage: {} };

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreateServiceRoleClient.mockResolvedValue(serviceClient);
  mockedSignNewsImageFields.mockImplementation(async (_client, row) => ({
    ...row,
    image_url: `signed:${row.image_url}`,
  }));
});

describe('getPublishedNews', () => {
  it('DD-NEWS-003 options なしは6つの列・公開済み・公開日の降順で取り、分類と件数を付けない', async () => {
    const { client, calls } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNews()).resolves.toEqual([]);

    expect(calls).toEqual([
      ['from', 'news_articles'],
      ['select', 'id, title, published_date, category, image_url, content'],
      ['eq', 'status', 'published'],
      ['order', 'published_date', { ascending: false }],
    ]);
  });

  it('DD-NEWS-003 分類を渡すとその分類で絞る', async () => {
    const { client, calls } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNews({ category: 'EVENT' });

    expect(callsOf(calls, 'eq')).toEqual([
      ['eq', 'status', 'published'],
      ['eq', 'category', 'EVENT'],
    ]);
  });

  it.each([
    ['ALL', { category: 'ALL' }],
    ['空の文字', { category: '' }],
    ['分類なし', {}],
  ])('DD-NEWS-003 分類が %s なら絞らない', async (_label, options) => {
    const { client, calls } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNews(options);

    expect(callsOf(calls, 'eq')).toEqual([['eq', 'status', 'published']]);
  });

  it.each([
    [6, 6],
    [2.7, 2],
  ])('DD-NEWS-003 件数 %p は limit(%p) で絞る', async (limit, expected) => {
    const { client, calls } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNews({ limit });

    expect(callsOf(calls, 'limit')).toEqual([['limit', expected]]);
  });

  it.each([
    ['0', 0],
    ['負', -1],
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['数でない', '6' as unknown as number],
  ])('DD-NEWS-003 件数が %s なら件数を絞らない', async (_label, limit) => {
    const { client, calls } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNews({ limit });

    expect(callsOf(calls, 'limit')).toEqual([]);
  });

  it('DD-NEWS-003 行ごとに service role の client で画像を署名し、置き換えた行を返す', async () => {
    const rows = [
      { id: 1, title: 'A', image_url: 'news/a.jpg' },
      { id: 2, title: 'B', image_url: 'news/b.jpg' },
    ];
    const { client } = makeClient({ data: rows });
    mockedCreatePublicClient.mockResolvedValue(client);

    const result = await getPublishedNews();

    expect(mockedSignNewsImageFields).toHaveBeenCalledTimes(2);
    expect(mockedSignNewsImageFields).toHaveBeenNthCalledWith(1, serviceClient, rows[0]);
    expect(mockedSignNewsImageFields).toHaveBeenNthCalledWith(2, serviceClient, rows[1]);
    expect(result).toEqual([
      { id: 1, title: 'A', image_url: 'signed:news/a.jpg' },
      { id: 2, title: 'B', image_url: 'signed:news/b.jpg' },
    ]);
  });

  it('DD-NEWS-003 DB の失敗で data が null なら空の配列を返し、署名を呼ばない', async () => {
    const { client } = makeClient({ data: null, error: { message: 'db down' } });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNews()).resolves.toEqual([]);
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
  });

  it('DD-NEWS-003 記事は公開の client で読み、service role の client では読まない', async () => {
    const { client, from } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNews();

    expect(from).toHaveBeenCalledWith('news_articles');
    expect(serviceClient.from).not.toHaveBeenCalled();
  });

  it('DD-NEWS-003 service role の環境変数が無く client の作成が投げると reject する', async () => {
    const { client } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);
    mockedCreateServiceRoleClient.mockRejectedValue(new Error('missing service role key'));

    await expect(getPublishedNews()).rejects.toThrow('missing service role key');
  });

  it('DD-NEWS-003 署名の呼び出しが例外なら reject する', async () => {
    const { client } = makeClient({ data: [{ id: 1, image_url: 'news/a.jpg' }] });
    mockedCreatePublicClient.mockResolvedValue(client);
    mockedSignNewsImageFields.mockRejectedValue(new Error('sign failed'));

    await expect(getPublishedNews()).rejects.toThrow('sign failed');
  });
});

describe('getPublishedNewsCount', () => {
  it('DD-NEWS-033 公開済みを head で数え、count を返す', async () => {
    const { client, calls } = makeClient({ count: 7, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsCount()).resolves.toBe(7);
    expect(calls).toEqual([
      ['from', 'news_articles'],
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'status', 'published'],
    ]);
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-033 error があれば console.error を1回出して 0 を返す', async () => {
    const error = { message: 'db down' };
    const { client } = makeClient({ count: 3, error });
    mockedCreatePublicClient.mockResolvedValue(client);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(getPublishedNewsCount()).resolves.toBe(0);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith('Failed to count published news:', error);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('DD-NEWS-033 error が無く count が null なら 0 を返す', async () => {
    const { client } = makeClient({ count: null, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsCount()).resolves.toBe(0);
  });
});

describe('getPublishedNewsDetailById', () => {
  const row = { id: 5, title: 'A', image_url: 'news/a.jpg', detailed_content: 'body' };

  it('DD-NEWS-031 options なしは本文を含む列・公開済み・id で絞り、分類で絞らず single で取る', async () => {
    const { client, calls } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsDetailById('5');

    expect(calls).toEqual([
      ['from', 'news_articles'],
      ['select', 'id, title, published_date, category, image_url, content, detailed_content'],
      ['eq', 'status', 'published'],
      ['eq', 'id', '5'],
      ['single'],
    ]);
  });

  it.each([
    ['ALL', { category: 'ALL' }],
    ['分類なし', {}],
  ])('DD-NEWS-031 分類が %s なら分類で絞らない', async (_label, options) => {
    const { client, calls } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsDetailById('5', options);

    expect(callsOf(calls, 'eq')).toEqual([
      ['eq', 'status', 'published'],
      ['eq', 'id', '5'],
    ]);
  });

  it('DD-NEWS-031 分類を渡すとその分類でも絞る', async () => {
    const { client, calls } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsDetailById('5', { category: 'EVENT' });

    expect(callsOf(calls, 'eq')).toEqual([
      ['eq', 'status', 'published'],
      ['eq', 'id', '5'],
      ['eq', 'category', 'EVENT'],
    ]);
  });

  it('DD-NEWS-031 data が null（error あり）なら null を返し、署名を呼ばない', async () => {
    const { client } = makeClient({ data: null, error: { message: 'not found' } });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsDetailById('abc')).resolves.toBeNull();
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
  });

  it('DD-NEWS-031 data が undefined でも null を返す', async () => {
    const { client } = makeClient({ error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsDetailById('5')).resolves.toBeNull();
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
  });

  it('DD-NEWS-031 行があれば service role の client で署名した結果を返し、DB は公開の client で読む', async () => {
    const { client, from } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsDetailById('5')).resolves.toEqual({
      ...row,
      image_url: 'signed:news/a.jpg',
    });
    expect(mockedSignNewsImageFields).toHaveBeenCalledWith(serviceClient, row);
    expect(from).toHaveBeenCalledTimes(1);
    expect(serviceClient.from).not.toHaveBeenCalled();
  });

  it('DD-NEWS-031 service role の client の作成が投げると reject する', async () => {
    const { client } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);
    mockedCreateServiceRoleClient.mockRejectedValue(new Error('missing service role key'));

    await expect(getPublishedNewsDetailById('5')).rejects.toThrow('missing service role key');
  });
});

describe('getPublishedNewsNavigation', () => {
  const articles = [
    { id: 3, title: 'newest' },
    { id: 2, title: 'middle' },
    { id: 1, title: 'oldest' },
  ];

  it('DD-NEWS-032 options なしは id と題を公開済み・公開日の降順で取り、分類で絞らない', async () => {
    const { client, calls } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsNavigation('2');

    expect(calls).toEqual([
      ['from', 'news_articles'],
      ['select', 'id, title'],
      ['eq', 'status', 'published'],
      ['order', 'published_date', { ascending: false }],
    ]);
    expect(callsOf(calls, 'limit')).toEqual([]);
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each([
    ['ALL', { category: 'ALL' }],
    ['分類なし', {}],
  ])('DD-NEWS-032 分類が %s なら分類で絞らない', async (_label, options) => {
    const { client, calls } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsNavigation('2', options);

    expect(callsOf(calls, 'eq')).toEqual([['eq', 'status', 'published']]);
  });

  it('DD-NEWS-032 分類を渡すとその分類で絞る', async () => {
    const { client, calls } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsNavigation('2', { category: 'STORE' });

    expect(callsOf(calls, 'eq')).toEqual([
      ['eq', 'status', 'published'],
      ['eq', 'category', 'STORE'],
    ]);
  });

  it('DD-NEWS-032 data が null なら前後とも null', async () => {
    const { client } = makeClient({ data: null, error: { message: 'db down' } });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsNavigation('2')).resolves.toEqual({
      prevArticle: null,
      nextArticle: null,
    });
  });

  it('DD-NEWS-032 先頭の記事は前が null、次が2件目', async () => {
    const { client } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsNavigation('3')).resolves.toEqual({
      prevArticle: null,
      nextArticle: articles[1],
    });
  });

  it('DD-NEWS-032 真ん中の記事は前が1件目、次が3件目', async () => {
    const { client } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsNavigation('2')).resolves.toEqual({
      prevArticle: articles[0],
      nextArticle: articles[2],
    });
  });

  it('DD-NEWS-032 最後の記事は前が2件目、次が null', async () => {
    const { client } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsNavigation('1')).resolves.toEqual({
      prevArticle: articles[1],
      nextArticle: null,
    });
  });

  it('DD-NEWS-032 結果に無い id は前後とも null', async () => {
    const { client } = makeClient({ data: articles });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsNavigation('99')).resolves.toEqual({
      prevArticle: null,
      nextArticle: null,
    });
  });

  it('DD-NEWS-032 DB の id が数の 5 で引数が文字の 5 でも位置が見つかる', async () => {
    const rows = [
      { id: 6, title: 'newer' },
      { id: 5, title: 'current' },
      { id: 4, title: 'older' },
    ];
    const { client } = makeClient({ data: rows });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsNavigation('5')).resolves.toEqual({
      prevArticle: rows[0],
      nextArticle: rows[2],
    });
  });
});
