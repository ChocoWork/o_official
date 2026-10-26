import {
  getPublishedNews,
  getPublishedNewsCount,
  getPublishedNewsDetailById,
  getPublishedNewsNavigation,
  NewsFetchError,
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
  builder.maybeSingle = jest.fn(() => {
    calls.push(['maybeSingle']);
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getPublishedNews', () => {
  it('DD-NEWS-003 options なしは image_url を除く5つの列・公開済み・公開日の降順で取り、分類と件数を付けない', async () => {
    const { client, calls } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNews()).resolves.toEqual([]);

    expect(calls).toEqual([
      ['from', 'news_articles'],
      ['select', 'id, title, published_date, category, content'],
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

  it('DD-NEWS-003 取った行をそのまま返し、画像の署名も service role の client の作成もしない（SEC-NEWS-005）', async () => {
    const rows = [
      { id: 1, title: 'A', content: 'a' },
      { id: 2, title: 'B', content: 'b' },
    ];
    const { client } = makeClient({ data: rows });
    mockedCreatePublicClient.mockResolvedValue(client);

    const result = await getPublishedNews();

    expect(result).toEqual(rows);
    expect(result.every((article) => !('image_url' in article))).toBe(true);
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-003 DB の error は NewsFetchError（code つき）で reject し、記録は { name, code } だけで message を含まない（SEC-NEWS-020）', async () => {
    const { client } = makeClient({
      data: null,
      error: { code: '42501', message: 'permission denied for table news_articles' },
    });
    mockedCreatePublicClient.mockResolvedValue(client);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const failure = await getPublishedNews().catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(NewsFetchError);
      expect((failure as NewsFetchError).code).toBe('42501');
      expect((failure as NewsFetchError).message).toBe('Failed to fetch published news');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][1]).toEqual({ name: 'UnknownError', code: '42501' });
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('permission denied');
      expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('DD-NEWS-003 error に code が無ければ NewsFetchError の code は null', async () => {
    const { client } = makeClient({ data: null, error: { message: 'db down' } });
    mockedCreatePublicClient.mockResolvedValue(client);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(getPublishedNews()).rejects.toMatchObject({ name: 'NewsFetchError', code: null });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('DD-NEWS-003 data が null で error も無ければ空の配列を返す', async () => {
    const { client } = makeClient({ data: null, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNews()).resolves.toEqual([]);
  });

  it('DD-NEWS-003 記事は公開の client だけで読む（公開の道は service role を持たない）', async () => {
    const { client, from } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNews();

    expect(from).toHaveBeenCalledWith('news_articles');
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-NEWS-003 service role の環境変数が無くても（client の作成が投げても）一覧は返る', async () => {
    const { client } = makeClient({ data: [] });
    mockedCreatePublicClient.mockResolvedValue(client);
    mockedCreateServiceRoleClient.mockRejectedValue(new Error('missing service role key'));

    await expect(getPublishedNews()).resolves.toEqual([]);
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

  it('DD-NEWS-033 error があれば { name, code } だけを console.error に1回出して 0 を返す', async () => {
    const error = { message: 'db down' };
    const { client } = makeClient({ count: 3, error });
    mockedCreatePublicClient.mockResolvedValue(client);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(getPublishedNewsCount()).resolves.toBe(0);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith('Failed to count published news:', {
        name: 'UnknownError',
        code: null,
      });
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
  const row = { id: 5, title: 'A', detailed_content: 'body' };

  it('DD-NEWS-031 options なしは本文を含み image_url を除く列・公開済み・id で絞り、分類で絞らず single で取る', async () => {
    const { client, calls } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await getPublishedNewsDetailById('5');

    expect(calls).toEqual([
      ['from', 'news_articles'],
      ['select', 'id, title, published_date, category, content, detailed_content'],
      ['eq', 'status', 'published'],
      ['eq', 'id', '5'],
      ['maybeSingle'],
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

  it.each(['abc', '0', '01', '1.5', '-1', '1234567890123456789', ''])(
    'DD-NEWS-031 bigint の形でない id "%s" は DB を呼ばず null を返す（SEC-NEWS-012）',
    async (id) => {
      const { client, from } = makeClient({ data: row, error: null });
      mockedCreatePublicClient.mockResolvedValue(client);

      await expect(getPublishedNewsDetailById(id)).resolves.toBeNull();
      expect(from).not.toHaveBeenCalled();
    },
  );

  it('DD-NEWS-031 行が無い（data が null で error も無い）時は null を返す', async () => {
    const { client } = makeClient({ data: null, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsDetailById('5')).resolves.toBeNull();
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
  });

  it('DD-NEWS-031 error は NewsFetchError で reject し、記録は { name, code } だけにする（SEC-NEWS-020）', async () => {
    const { client } = makeClient({
      data: null,
      error: { code: 'PGRST301', message: 'JWT expired for secret-user' },
    });
    mockedCreatePublicClient.mockResolvedValue(client);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const failure = await getPublishedNewsDetailById('5').catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(NewsFetchError);
      expect((failure as NewsFetchError).code).toBe('PGRST301');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][1]).toEqual({ name: 'UnknownError', code: 'PGRST301' });
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('secret-user');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('DD-NEWS-031 data が undefined でも null を返す', async () => {
    const { client } = makeClient({ error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    await expect(getPublishedNewsDetailById('5')).resolves.toBeNull();
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
  });

  it('DD-NEWS-031 行があればそのまま返し、署名も service role の client の作成もしない（SEC-NEWS-005）', async () => {
    const { client, from } = makeClient({ data: row, error: null });
    mockedCreatePublicClient.mockResolvedValue(client);

    const result = await getPublishedNewsDetailById('5');

    expect(result).toEqual(row);
    expect(result).not.toHaveProperty('image_url');
    expect(mockedSignNewsImageFields).not.toHaveBeenCalled();
    expect(mockedCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
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

  it('DD-NEWS-032 error は前後とも null で返し、{ name, code } だけを1回記録する（前後だけ握る）', async () => {
    const { client } = makeClient({
      data: null,
      error: { code: '57014', message: 'canceling statement due to timeout' },
    });
    mockedCreatePublicClient.mockResolvedValue(client);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(getPublishedNewsNavigation('2')).resolves.toEqual({
        prevArticle: null,
        nextArticle: null,
      });
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][1]).toEqual({ name: 'UnknownError', code: '57014' });
      expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('timeout');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('DD-NEWS-032 data が null で error も無ければ前後とも null', async () => {
    const { client } = makeClient({ data: null, error: null });
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
