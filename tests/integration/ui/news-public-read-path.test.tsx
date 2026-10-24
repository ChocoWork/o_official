import React from 'react';
import { render, screen, within } from '@testing-library/react';

type QueryResult = { data: unknown; error: unknown };
type RecordedCall = [string, ...unknown[]];

const publicFrom = jest.fn();
const serviceFrom = jest.fn();
const storageFrom = jest.fn();
const createSignedUrl = jest.fn();
const notFoundMock = jest.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(async () => ({ from: publicFrom })),
  createServiceRoleClient: jest.fn(async () => ({
    from: serviceFrom,
    storage: { from: storageFrom },
  })),
}));

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/news',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({
    get: () => null,
    toString: () => '',
  }),
  notFound: () => notFoundMock(),
}));

const { createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const NewsPage = require('@/app/news/page').default;
const NewsDetailPage = require('@/app/news/[id]/page').default;

/** Supabase の問い合わせの組み立てを記録し、最後に決めた結果を返す偽物。 */
function createRecordingQuery(result: QueryResult) {
  const calls: RecordedCall[] = [];
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  }
  query.single = () => {
    calls.push(['single']);
    return Promise.resolve(result);
  };
  query.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { query, calls };
}

const ARTICLES = [
  {
    id: 'n2',
    title: 'Newer article',
    published_date: '2026-10-02',
    category: 'EVENT',
    image_url: 'news-images/n2.jpg',
    content: 'Newer content',
  },
  {
    id: 'n1',
    title: 'Older article',
    published_date: '2026-09-01',
    category: 'STORE',
    image_url: null,
    content: 'Older content',
  },
];

async function renderNewsPage(searchParams?: Record<string, string>) {
  const element = await NewsPage({
    searchParams: searchParams ? Promise.resolve(searchParams) : undefined,
  });
  return render(element);
}

describe('ARC-NEWS-001 public read path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example/n2.jpg?token=t' },
      error: null,
    });
    storageFrom.mockReturnValue({ createSignedUrl });
  });

  it('ARC-NEWS-001 /news は anon の client で公開済みだけを公開日の新しい順に取り出し、件数を絞らずに描く', async () => {
    const { query, calls } = createRecordingQuery({ data: ARTICLES, error: null });
    publicFrom.mockReturnValue(query);

    await renderNewsPage();

    expect(createPublicClient).toHaveBeenCalled();
    expect(publicFrom).toHaveBeenCalledWith('news_articles');
    expect(calls).toEqual([
      ['select', 'id, title, published_date, category, image_url, content'],
      ['eq', 'status', 'published'],
      ['order', 'published_date', { ascending: false }],
    ]);
    expect(calls.some(([method]) => method === 'limit')).toBe(false);

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(['Newer article', 'Older article']);
  });

  it('ARC-NEWS-001 service role の client は DB を読まず、画像の署名だけに使う', async () => {
    const { query } = createRecordingQuery({ data: ARTICLES, error: null });
    publicFrom.mockReturnValue(query);

    await renderNewsPage();

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(storageFrom).toHaveBeenCalledWith('news-images');
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(createSignedUrl).toHaveBeenCalledWith('n2.jpg', 3600);
  });

  it('ARC-NEWS-001 URL の分類が1つの正しい値なら DB の取り出しをその分類で絞る', async () => {
    const { query, calls } = createRecordingQuery({ data: [ARTICLES[0]], error: null });
    publicFrom.mockReturnValue(query);

    await renderNewsPage({ category: 'event' });

    expect(calls).toContainEqual(['eq', 'category', 'EVENT']);
    expect(screen.getByRole('heading', { level: 2, name: 'Newer article' })).toBeInTheDocument();
  });

  it.each([
    ['正しくない値', 'UNKNOWN'],
    ['複数の値', 'EVENT,STORE'],
    ['ALL', 'ALL'],
  ])('ARC-NEWS-001 URL の分類が%sの時は分類の絞りを DB に渡さない', async (_label, category) => {
    const { query, calls } = createRecordingQuery({ data: ARTICLES, error: null });
    publicFrom.mockReturnValue(query);

    await renderNewsPage({ category });

    expect(calls.filter(([method, column]) => method === 'eq' && column === 'category')).toEqual([]);
    expect(calls).toContainEqual(['eq', 'status', 'published']);
  });

  it('ARC-NEWS-001 DB の失敗は例外にせず、公開の記事が無い一覧として描く', async () => {
    const { query } = createRecordingQuery({ data: null, error: { message: 'db down' } });
    publicFrom.mockReturnValue(query);

    await renderNewsPage();

    expect(screen.getByText('現在、公開されている記事はありません')).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('ARC-NEWS-001 /news/[id] は anon の client で公開済みの1件と前後を取り出して描く', async () => {
    const detail = createRecordingQuery({
      data: {
        ...ARTICLES[0],
        detailed_content: 'Detail body',
      },
      error: null,
    });
    const navigation = createRecordingQuery({
      data: [
        { id: 'n3', title: 'Newest article' },
        { id: 'n2', title: 'Newer article' },
        { id: 'n1', title: 'Older article' },
      ],
      error: null,
    });
    publicFrom.mockReturnValueOnce(detail.query).mockReturnValueOnce(navigation.query);

    const element = await NewsDetailPage({
      params: Promise.resolve({ id: 'n2' }),
      searchParams: Promise.resolve({ category: 'EVENT' }),
    });
    render(element);

    expect(detail.calls).toEqual([
      ['select', 'id, title, published_date, category, image_url, content, detailed_content'],
      ['eq', 'status', 'published'],
      ['eq', 'id', 'n2'],
      ['eq', 'category', 'EVENT'],
      ['single'],
    ]);
    expect(navigation.calls).toEqual([
      ['select', 'id, title'],
      ['eq', 'status', 'published'],
      ['order', 'published_date', { ascending: false }],
      ['eq', 'category', 'EVENT'],
    ]);
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(createSignedUrl).toHaveBeenCalledWith('n2.jpg', 3600);

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByText('Newer article')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Detail body')).toBeInTheDocument();
  });

  it('ARC-NEWS-001 /news/[id] は公開済みの行が返らない時に前後を読まず 404 にする', async () => {
    const detail = createRecordingQuery({ data: null, error: { code: 'PGRST116' } });
    publicFrom.mockReturnValueOnce(detail.query);

    await expect(
      NewsDetailPage({ params: Promise.resolve({ id: 'private-1' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(publicFrom).toHaveBeenCalledTimes(1);
    expect(detail.calls).toContainEqual(['eq', 'status', 'published']);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
