// Server Action と公開の取り出し・画像の署名は本物を通し、DB だけを差し替える
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

const { createClient, createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { getLatestNews } = require('@/app/actions/news');

type QueryResult = { data: unknown; error: unknown };

function setupClients(result: QueryResult, signed: { data: unknown; error: unknown } = {
  data: { signedUrl: 'https://project.supabase.co/storage/v1/object/sign/news-images/news/a.jpg?token=t' },
  error: null,
}) {
  const query: Record<string, jest.Mock> & { then?: unknown } = {
    select: jest.fn(),
    eq: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);

  const from = jest.fn().mockReturnValue(query);
  const createSignedUrl = jest.fn().mockResolvedValue(signed);

  createPublicClient.mockResolvedValue({ from });
  createServiceRoleClient.mockResolvedValue({ storage: { from: jest.fn().mockReturnValue({ createSignedUrl }) } });

  return { query, from, createSignedUrl };
}

const ROWS = [
  { id: 3, title: 'c', published_date: '2026-03-01', category: 'EVENT', image_url: 'news/a.jpg', content: 'x' },
  { id: 2, title: 'b', published_date: '2026-02-01', category: 'STORE', image_url: 'news/a.jpg', content: 'y' },
];

describe('Server Action getLatestNews 最新の公開済みの記事', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('API-NEWS-008 公開済みだけを公開日の新しい順に3件まで取り出し、署名つきの画像で返す', async () => {
    const { from, query, createSignedUrl } = setupClients({ data: ROWS, error: null });

    const result = await getLatestNews();

    expect(from).toHaveBeenCalledWith('news_articles');
    expect(query.select).toHaveBeenCalledWith('id, title, published_date, category, image_url, content');
    expect(query.eq).toHaveBeenCalledWith('status', 'published');
    expect(query.order).toHaveBeenCalledWith('published_date', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(createSignedUrl).toHaveBeenCalledWith('news/a.jpg', 3600);
    expect(result).toEqual(
      ROWS.map((row) => ({
        ...row,
        image_url: 'https://project.supabase.co/storage/v1/object/sign/news-images/news/a.jpg?token=t',
      })),
    );
  });

  it('API-NEWS-008 分類で絞らない', async () => {
    const { query } = setupClients({ data: ROWS, error: null });

    await getLatestNews();

    expect(query.eq).toHaveBeenCalledTimes(1);
    expect(query.eq).not.toHaveBeenCalledWith('category', expect.anything());
  });

  it('API-NEWS-008 認可を求めず、利用者の session の client を使わずに anon の client で読む', async () => {
    setupClients({ data: [], error: null });

    await getLatestNews();

    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('API-NEWS-008 DB の失敗では空の配列を返す', async () => {
    setupClients({ data: null, error: { message: 'db down' } });

    await expect(getLatestNews()).resolves.toEqual([]);
  });

  it('API-NEWS-008 client を作れない時は例外をそのまま呼び元に返す', async () => {
    createPublicClient.mockRejectedValue(new Error('no client'));
    createServiceRoleClient.mockResolvedValue({ storage: { from: jest.fn() } });

    await expect(getLatestNews()).rejects.toThrow('no client');
  });
});
