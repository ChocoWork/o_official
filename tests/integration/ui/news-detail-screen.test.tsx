import React from 'react';
import { render, screen, within } from '@testing-library/react';
import NewsDetailPage, { generateMetadata } from '@/app/news/[id]/page';

const NOT_FOUND_ERROR = 'NEXT_NOT_FOUND';

type Row = Record<string, unknown>;
type RecordedCall = [string, ...unknown[]];

// 取り出しの関数（services/public）と画像の署名は本物を通し、Supabase の client だけを表の行を絞って返す偽物にする
let mockRows: Row[] = [];
const mockQueries: RecordedCall[][] = [];

function mockCreateNewsClient() {
  return {
    from: (table: string) => {
      const calls: RecordedCall[] = [['from', table]];
      mockQueries.push(calls);
      const filters: Array<[string, unknown]> = [];
      let columns: string[] = [];
      let descBy: string | null = null;
      const run = (): Row[] => {
        let rows = mockRows.filter((row) => filters.every(([col, val]) => String(row[col]) === String(val)));
        if (descBy) {
          const key = descBy;
          rows = [...rows].sort((a, b) => String(b[key]).localeCompare(String(a[key])));
        }
        return rows.map((row) => Object.fromEntries(columns.map((col) => [col, row[col]])));
      };
      const query: Record<string, unknown> = {
        select: (cols: string) => {
          calls.push(['select', cols]);
          columns = cols.split(',').map((col) => col.trim());
          return query;
        },
        eq: (col: string, val: unknown) => {
          calls.push(['eq', col, val]);
          filters.push([col, val]);
          return query;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          calls.push(['order', col, opts]);
          if (opts?.ascending === false) descBy = col;
          return query;
        },
        single: () => {
          calls.push(['single']);
          const rows = run();
          return Promise.resolve(
            rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116' } },
          );
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(onF, onR),
      };
      return query;
    },
  };
}

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(async () => mockCreateNewsClient()),
  createServiceRoleClient: jest.fn(async () => ({
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }),
      }),
    },
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
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// DB の id は bigint なので数で置く。並びは公開日の新しい順で、前の記事は1つ新しい記事になる
const baseArticle: Row = {
  id: 10,
  title: 'Autumn Collection',
  published_date: '2026-09-01',
  category: 'COLLECTION',
  image_url: 'news/10.jpg',
  content: 'summary',
  detailed_content: 'First paragraph\nsecond line\n\nSecond paragraph',
  status: 'published',
};

const NEWER: Row = { ...baseArticle, id: 11, title: 'Newer Story', published_date: '2026-10-01', detailed_content: 'n' };
const OLDER: Row = { ...baseArticle, id: 9, title: 'Older Story', published_date: '2026-08-01', category: 'EVENT', detailed_content: 'o' };
const DRAFT: Row = { ...baseArticle, id: 12, title: 'Hidden Draft', published_date: '2026-10-10', status: 'private' };

function setArticle(overrides: Row) {
  mockRows = [NEWER, { ...baseArticle, ...overrides }, OLDER, DRAFT];
}

function detailQuery(): RecordedCall[] | undefined {
  return mockQueries.find((calls) => calls.some((call) => call[0] === 'single'));
}

function navigationQuery(): RecordedCall[] | undefined {
  return mockQueries.find((calls) => calls.some((call) => call[0] === 'select' && call[1] === 'id, title'));
}

function categoryFilters(calls: RecordedCall[] | undefined): unknown[] {
  return (calls ?? []).filter((call) => call[0] === 'eq' && call[1] === 'category').map((call) => call[2]);
}

async function renderPage(id: string, category?: string) {
  const element = await NewsDetailPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(category === undefined ? {} : { category }),
  });
  return render(element);
}

function hrefsOf(name: string | RegExp): string[] {
  return screen
    .getAllByRole('link', { name })
    .map((link) => link.getAttribute('href') ?? '');
}

describe('news detail screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueries.length = 0;
    setArticle({});
  });

  it('SCR-NEWS-002 公開済みの id の記事を読み、日付・分類・題・段落に分けた本文を出す', async () => {
    const { container } = await renderPage('10');

    expect(detailQuery()).toEqual(
      expect.arrayContaining([['from', 'news_articles'], ['eq', 'status', 'published'], ['eq', 'id', '10']]),
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Autumn Collection' })).toBeInTheDocument();
    expect(screen.getByText('2026.09.01')).toBeInTheDocument();

    const paragraphs = Array.from(container.querySelectorAll('p.whitespace-pre-line'));
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      'First paragraph\nsecond line',
      'Second paragraph',
    ]);
    expect(container.querySelector('img')).toBeNull();
  });

  it('SCR-NEWS-002 パンくずは NEWS・記事の分類・題の順で、題に aria-current を付ける', async () => {
    await renderPage('10');

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const items = within(breadcrumb).getAllByRole('listitem');
    const visible = items.filter((item) => item.getAttribute('aria-hidden') !== 'true');

    expect(visible.map((item) => item.textContent)).toEqual([
      'NEWS',
      'COLLECTION',
      'Autumn Collection',
    ]);
    expect(visible[2]).toHaveAttribute('aria-current', 'page');
    expect(within(breadcrumb).getByRole('link', { name: 'NEWS' })).toHaveAttribute('href', '/news');
    expect(within(breadcrumb).getByRole('link', { name: 'COLLECTION' })).toHaveAttribute(
      'href',
      '/news?category=COLLECTION',
    );
  });

  it('SCR-NEWS-002 本文の HTML を解釈せず文字のまま出す', async () => {
    setArticle({ detailed_content: '<img src=x onerror="alert(1)"><script>alert(2)</script>' });

    const { container } = await renderPage('10');

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.getByText('<img src=x onerror="alert(1)"><script>alert(2)</script>'),
    ).toBeInTheDocument();
  });

  it('SCR-NEWS-002 公開済みの並びの前後の記事を aria-label 付きのリンクとしてスマホと sm 以上で2回ずつ出す', async () => {
    await renderPage('10');

    expect(hrefsOf('前の記事: Newer Story')).toEqual(['/news/11', '/news/11']);
    expect(hrefsOf('次の記事: Older Story')).toEqual(['/news/9', '/news/9']);
    expect(screen.queryByRole('link', { name: /Hidden Draft/ })).toBeNull();
    expect(hrefsOf('VIEW ALL')).toEqual(['/news', '/news']);
  });

  it('SCR-NEWS-002 前後の記事が無い時は前後のリンクを出さず VIEW ALL だけを出す', async () => {
    mockRows = [baseArticle, DRAFT];

    await renderPage('10');

    expect(screen.queryByRole('link', { name: /前の記事/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /次の記事/ })).toBeNull();
    expect(hrefsOf('VIEW ALL')).toHaveLength(2);
  });

  it('SCR-NEWS-002 記事が無いか非公開の時は notFound で 404 にし、前後を取りに行かない', async () => {
    await expect(renderPage('999')).rejects.toThrow(NOT_FOUND_ERROR);
    await expect(renderPage('12')).rejects.toThrow(NOT_FOUND_ERROR);
    expect(navigationQuery()).toBeUndefined();
  });

  it('SCR-NEWS-002 正しい分類が1つの時は記事と前後をその分類で絞る', async () => {
    await renderPage('10', 'collection');

    expect(categoryFilters(detailQuery())).toEqual(['COLLECTION']);
    expect(categoryFilters(navigationQuery())).toEqual(['COLLECTION']);
    expect(hrefsOf('前の記事: Newer Story')).toEqual(['/news/11?category=COLLECTION', '/news/11?category=COLLECTION']);
    expect(screen.queryByRole('link', { name: /次の記事/ })).toBeNull();
    expect(hrefsOf('VIEW ALL')).toEqual(['/news?category=COLLECTION', '/news?category=COLLECTION']);
  });

  it('SCR-NEWS-002 正しくない分類は ALL で読み、リンクに分類を付けない', async () => {
    await renderPage('10', 'UNKNOWN');

    expect(categoryFilters(detailQuery())).toEqual([]);
    expect(categoryFilters(navigationQuery())).toEqual([]);
    expect(hrefsOf('VIEW ALL')).toEqual(['/news', '/news']);
  });

  it('SCR-NEWS-002 空白だけの分類は ALL で読み、リンクに分類を付けない', async () => {
    await renderPage('10', '   ');

    expect(detailQuery()).toBeDefined();
    expect(categoryFilters(detailQuery())).toEqual([]);
    expect(hrefsOf('VIEW ALL')).toEqual(['/news', '/news']);
  });

  it('SCR-NEWS-002 searchParams が無い時は ALL で読む', async () => {
    const element = await NewsDetailPage({ params: Promise.resolve({ id: '10' }) });
    render(element);

    expect(detailQuery()).toBeDefined();
    expect(categoryFilters(detailQuery())).toEqual([]);
    expect(hrefsOf('VIEW ALL')).toEqual(['/news', '/news']);
  });

  it('SCR-NEWS-002 メタの title は題を含み、description は本文の空白を詰めた先頭120字にする', async () => {
    setArticle({ detailed_content: `${'a'.repeat(100)}\n\n${'b'.repeat(40)}` });

    const metadata = await generateMetadata({ params: Promise.resolve({ id: '10' }) });

    expect(metadata.title).toBe('Autumn Collection | NEWS | Le Fil des Heures');
    expect(metadata.description).toBe(`${'a'.repeat(100)} ${'b'.repeat(19)}...`);
  });

  it('SCR-NEWS-002 メタの description は120字以内ならそのまま、空なら固定の文にする', async () => {
    setArticle({ detailed_content: '  short\n text  ' });
    const shortMeta = await generateMetadata({ params: Promise.resolve({ id: '10' }) });
    expect(shortMeta.description).toBe('short text');

    setArticle({ detailed_content: ' \n\n ' });
    const emptyMeta = await generateMetadata({ params: Promise.resolve({ id: '10' }) });
    expect(emptyMeta.description).toBe('Le Fil des Heuresのニュース詳細ページです。');
  });

  it('SCR-NEWS-002 記事が無い時のメタは固定の title と description にする', async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: '999' }) });

    expect(metadata).toEqual({
      title: 'NEWS DETAIL | Le Fil des Heures',
      description: 'Le Fil des Heuresのニュース詳細ページです。',
    });
  });
});
