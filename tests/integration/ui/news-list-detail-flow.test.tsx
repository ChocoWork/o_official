import React from 'react';
import userEvent from '@testing-library/user-event';
import { cleanup, render, screen, within } from '@testing-library/react';
import NewsPage from '@/app/news/page';
import NewsDetailPage from '@/app/news/[id]/page';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import type { PublicNewsArticle } from '@/features/news/types';

const pushMock = jest.fn();
let currentSearch = '';

type Row = Record<string, unknown>;
type RecordedCall = [string, ...unknown[]];

// 取り出しの関数（services/public）は本物を通し、Supabase の client だけを表の行を絞って返す偽物にする
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
        limit: (n: number) => {
          calls.push(['limit', n]);
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
  // 公開の道は画像を署名しないので service role を使わない（SEC-NEWS-005）。使えば試験が落ちる
  createServiceRoleClient: jest.fn(async () => {
    throw new Error('public news path must not create a service role client');
  }),
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
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

const articles: PublicNewsArticle[] = [
  { id: '3', title: 'Store Opening', published_date: '2026-09-03', category: 'STORE', content: 'c3' },
  { id: '2', title: 'Event Night', published_date: '2026-09-02', category: 'EVENT', content: 'c2' },
  { id: '1', title: 'Collection Drop', published_date: '2026-09-01', category: 'COLLECTION', content: 'c1' },
];

// 表の行。DB の id は bigint なので数で置き、非公開の行を1つ混ぜる
const tableRows: Row[] = [
  ...articles.map((article) => ({
    ...article,
    id: Number(article.id),
    detailed_content: `${article.title} body`,
    status: 'published',
  })),
  {
    id: 4,
    title: 'Hidden Draft',
    published_date: '2026-09-04',
    category: 'EVENT',
    image_url: null,
    content: 'c4',
    detailed_content: 'draft',
    status: 'private',
  },
];

function queriesSelecting(columns: string): RecordedCall[][] {
  return mockQueries.filter((calls) => calls.some((call) => call[0] === 'select' && call[1] === columns));
}

function detailQuery(): RecordedCall[] | undefined {
  return mockQueries.find((calls) => calls.some((call) => call[0] === 'single'));
}

function categoryFilters(calls: RecordedCall[] | undefined): unknown[] {
  return (calls ?? []).filter((call) => call[0] === 'eq' && call[1] === 'category').map((call) => call[2]);
}

function listQuery(): RecordedCall[] | undefined {
  const lists = queriesSelecting('id, title, published_date, category, content');
  return lists[lists.length - 1];
}

function searchOf(href: string): string {
  const index = href.indexOf('?');
  return index === -1 ? '' : href.slice(index + 1);
}

function categoryOf(href: string): string | undefined {
  return new URLSearchParams(searchOf(href)).get('category') ?? undefined;
}

async function renderList(search: string) {
  currentSearch = search;
  const category = new URLSearchParams(search).get('category') ?? undefined;
  const element = await NewsPage({
    searchParams: Promise.resolve(category === undefined ? {} : { category }),
  });
  return render(element);
}

async function renderDetail(href: string) {
  const id = href.replace(/^\/news\//, '').split('?')[0];
  const category = categoryOf(href);
  const element = await NewsDetailPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(category === undefined ? {} : { category }),
  });
  return render(element);
}

function cardHref(title: string): string {
  const heading = screen.getByRole('heading', { name: title });
  const link = heading.closest('a');
  if (!link) throw new Error(`card link for ${title} not found`);
  return link.getAttribute('href') ?? '';
}

function firstCheckbox(name: string): HTMLInputElement {
  return screen.getAllByRole('checkbox', { name })[0] as HTMLInputElement;
}

describe('news list to detail flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentSearch = '';
    mockQueries.length = 0;
    mockRows = tableRows;
  });

  it('FLOW-NEWS-001 1つの分類を選んだ一覧から詳細へ移り、VIEW ALL とパンくずの NEWS で同じ選択の一覧へ戻る', async () => {
    await renderList('category=EVENT');

    expect(categoryFilters(listQuery())).toEqual(['EVENT']);
    expect(screen.queryByText('Hidden Draft')).not.toBeInTheDocument();
    expect(firstCheckbox('EVENT').checked).toBe(true);
    const detailHref = cardHref('Event Night');
    expect(detailHref).toBe('/news/2?category=EVENT');

    cleanup();
    await renderDetail(detailHref);

    expect(detailQuery()).toEqual(expect.arrayContaining([['eq', 'id', '2'], ['eq', 'category', 'EVENT']]));
    expect(categoryFilters(queriesSelecting('id, title')[0])).toEqual(['EVENT']);
    const viewAllHref = screen.getAllByRole('link', { name: 'VIEW ALL' })[0].getAttribute('href') ?? '';
    expect(viewAllHref).toBe('/news?category=EVENT');
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'NEWS' })).toHaveAttribute('href', viewAllHref);

    cleanup();
    await renderList(searchOf(viewAllHref));

    expect(firstCheckbox('EVENT').checked).toBe(true);
    expect(firstCheckbox('ALL').checked).toBe(false);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Event Night']);
  });

  it('FLOW-NEWS-001 複数の分類は一覧が画面で絞り、詳細の前後と戻りのリンクに複数のまま引き継ぐ', async () => {
    await renderList('category=EVENT,STORE');

    expect(categoryFilters(listQuery())).toEqual([]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Store Opening',
      'Event Night',
    ]);
    const detailHref = cardHref('Event Night');
    expect(detailHref).toBe('/news/2?category=EVENT%2CSTORE');

    cleanup();
    mockQueries.length = 0;
    await renderDetail(detailHref);

    expect(categoryFilters(detailQuery())).toEqual([]);
    expect(categoryFilters(queriesSelecting('id, title')[0])).toEqual([]);
    for (const name of ['VIEW ALL', '前の記事: Store Opening', '次の記事: Collection Drop']) {
      for (const link of screen.getAllByRole('link', { name })) {
        expect(categoryOf(link.getAttribute('href') ?? '')).toBe('EVENT,STORE');
      }
    }
    expect(screen.getAllByRole('link', { name: '次の記事: Collection Drop' })[0]).toHaveAttribute(
      'href',
      '/news/1?category=EVENT%2CSTORE',
    );
  });

  it('FLOW-NEWS-001 詳細は受けた分類から正しい値だけを残して引き継ぎ、パンくずの分類は記事の分類の一覧へ移る', async () => {
    await renderDetail('/news/2?category=ALL,event,BOGUS,EVENT');

    expect(categoryFilters(detailQuery())).toEqual([]);
    expect(screen.getAllByRole('link', { name: 'VIEW ALL' })[0]).toHaveAttribute('href', '/news?category=EVENT');
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: 'EVENT' })).toHaveAttribute('href', '/news?category=EVENT');
  });

  it('FLOW-NEWS-001 ALL の一覧のカードは分類を付けずに詳細へつなぐ', async () => {
    await renderList('');

    expect(firstCheckbox('ALL').checked).toBe(true);
    expect(cardHref('Store Opening')).toBe('/news/3');
  });

  it('FLOW-NEWS-001 一覧で分類を足すと URL の category を書き換え、スクロールを保つ', async () => {
    const user = userEvent.setup();
    await renderList('category=EVENT');

    await user.click(firstCheckbox('STORE'));

    expect(pushMock).toHaveBeenLastCalledWith('/news?category=EVENT%2CSTORE', { scroll: false });
    expect(cardHref('Event Night')).toBe('/news/2?category=EVENT%2CSTORE');
  });

  it('FLOW-NEWS-001 一覧で ALL を選ぶと URL から category を外す', async () => {
    const user = userEvent.setup();
    await renderList('category=EVENT');

    await user.click(firstCheckbox('ALL'));

    expect(pushMock).toHaveBeenLastCalledWith('/news', { scroll: false });
    expect(cardHref('Event Night')).toBe('/news/2');
  });

  it('FLOW-NEWS-001 記事と違う1つの分類を付けて詳細を開くと 404 になる', async () => {
    await expect(renderDetail('/news/2?category=STORE')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(categoryFilters(detailQuery())).toEqual(['STORE']);
    expect(queriesSelecting('id, title')).toHaveLength(0);
  });

  it('FLOW-NEWS-001 ホームからはカードで分類なしの詳細へ、VIEW ALL で分類なしの一覧へ移る', () => {
    currentSearch = 'category=EVENT';
    render(<PublicNewsGrid variant="home" articles={articles} totalCount={7} />);

    expect(cardHref('Event Night')).toBe('/news/2');
    expect(screen.getByRole('link', { name: 'VIEW ALL NEWS' })).toHaveAttribute('href', '/news');
  });
});
