import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@testing-library/react';

const pushMock = jest.fn();
let currentQuery = '';

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
      let limit: number | null = null;
      const run = (): Row[] => {
        let rows = mockRows.filter((row) => filters.every(([col, val]) => String(row[col]) === String(val)));
        if (descBy) {
          const key = descBy;
          rows = [...rows].sort((a, b) => String(b[key]).localeCompare(String(a[key])));
        }
        if (limit !== null) rows = rows.slice(0, limit);
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
          limit = n;
          return query;
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
  usePathname: () => '/news',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => {
    const params = new URLSearchParams(currentQuery);
    return {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    };
  },
}));

const newsPageModule = require('@/app/news/page');
const NewsPage = newsPageModule.default;
const { PublicNewsGrid } = require('@/features/news/components/PublicNewsGrid');

function lastQuery(): RecordedCall[] {
  return mockQueries[mockQueries.length - 1];
}

function categoryFilters(calls: RecordedCall[]): unknown[] {
  return calls.filter((call) => call[0] === 'eq' && call[1] === 'category').map((call) => call[2]);
}

const ARTICLES = [
  {
    id: 'a1',
    title: 'Autumn event',
    published_date: '2026-10-02',
    category: 'EVENT',
    image_url: 'https://cdn.example/a1.jpg',
    content: '## Heading\n**Bold** and [link text](https://example.com) ![img](https://example.com/x.png)',
  },
  {
    id: 'a2',
    title: 'Store renewal',
    published_date: '2026-09-15',
    category: 'STORE',
    image_url: null,
    content: 'Store body',
  },
];

const DRAFT = {
  id: 'a9',
  title: 'Hidden draft',
  published_date: '2026-10-20',
  category: 'EVENT',
  image_url: null,
  content: 'Draft body',
  status: 'private',
};

function published(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((row) => ({ ...row, status: 'published' }));
}

async function renderNewsPage(category?: string) {
  currentQuery = category ? new URLSearchParams({ category }).toString() : '';
  const element = await NewsPage({
    searchParams: Promise.resolve(category ? { category } : {}),
  });
  return render(element);
}

function filterPanel() {
  return within(screen.getByRole('complementary'));
}

describe('SCR-NEWS-001 news list screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentQuery = '';
    mockQueries.length = 0;
    mockRows = [...published(ARTICLES), DRAFT];
  });

  it('SCR-NEWS-001 title と description は記事に左右されない固定の文を返す', async () => {
    const metadata = await newsPageModule.generateMetadata();

    expect(metadata).toEqual({
      title: 'NEWS | Le Fil des Heures',
      description:
        'Le Fil des Heuresの最新ニュース一覧。コレクション、イベント、コラボレーション、サステナビリティ、ストア情報を掲載。',
    });
    expect(mockQueries).toHaveLength(0);
  });

  it('SCR-NEWS-001 ページの見出し h1 と画像を置かず、公開済みの記事だけをカードにして公開日・分類・題・印を外した概要を出す', async () => {
    await renderNewsPage();

    expect(lastQuery()).toEqual(expect.arrayContaining([['from', 'news_articles'], ['eq', 'status', 'published']]));
    expect(screen.queryByText('Hidden draft')).not.toBeInTheDocument();

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);

    const first = within(cards[0]);
    expect(first.getByText('2026.10.02')).toHaveAttribute('dateTime', '2026-10-02');
    expect(first.getByText('EVENT')).toBeInTheDocument();
    expect(first.getByRole('heading', { level: 2, name: 'Autumn event' })).toBeInTheDocument();
    expect(first.getByText('Heading Bold and link text')).toBeInTheDocument();
  });

  it('SCR-NEWS-001 カードは分類の選択が無い時は詳細へ、選択がある時は分類を引き継いで詳細へつなぐ', async () => {
    const { unmount } = await renderNewsPage();

    expect(screen.getByRole('link', { name: /Autumn event/ })).toHaveAttribute('href', '/news/a1');
    unmount();

    await renderNewsPage('EVENT');

    expect(screen.getByRole('link', { name: /Autumn event/ })).toHaveAttribute(
      'href',
      '/news/a1?category=EVENT',
    );
  });

  it('SCR-NEWS-001 URL の分類が1つの正しい値なら大文字にして取り出しに渡す', async () => {
    await renderNewsPage('event');

    expect(categoryFilters(lastQuery())).toEqual(['EVENT']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['Autumn event']);
  });

  it.each([
    ['無い', undefined],
    ['正しくない', 'UNKNOWN'],
    ['複数', 'EVENT,STORE'],
  ])('SCR-NEWS-001 URL の分類が%s時は ALL で全部を取り出す', async (_label, category) => {
    await renderNewsPage(category);

    expect(mockQueries).toHaveLength(1);
    expect(categoryFilters(lastQuery())).toEqual([]);
  });

  it('SCR-NEWS-001 複数の分類の URL では全部を取り出して画面で選んだ分類だけに絞る', async () => {
    mockRows = published([
      ...ARTICLES,
      {
        id: 'a3',
        title: 'Collab drop',
        published_date: '2026-08-01',
        category: 'COLLABORATION',
        image_url: null,
        content: 'Collab body',
      },
    ]);

    await renderNewsPage('EVENT,STORE');

    const titles = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(titles).toEqual(['Autumn event', 'Store renewal']);
  });

  it('SCR-NEWS-001 公開の記事が無い時は空の文を出す', async () => {
    mockRows = [];

    await renderNewsPage();

    expect(screen.getByText('現在、公開されている記事はありません')).toBeInTheDocument();
    expect(screen.queryByText('該当カテゴリの記事はありません')).not.toBeInTheDocument();
  });

  it('SCR-NEWS-001 BLOG は選択肢に出るが、選ぶと該当の記事が無い文を出す', async () => {
    const user = userEvent.setup();
    await renderNewsPage();

    const blog = filterPanel().getByRole('checkbox', { name: 'BLOG' });
    await user.click(blog);

    expect(await screen.findByText('該当カテゴリの記事はありません')).toBeInTheDocument();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('SCR-NEWS-001 サイドバーに全部の分類の選択肢を出し、FILTER のボタンで左の引き出しを開閉する', async () => {
    const user = userEvent.setup();
    await renderNewsPage();

    const panel = filterPanel();
    const optionNames = ['ALL', 'COLLECTION', 'EVENT', 'COLLABORATION', 'SUSTAINABILITY', 'STORE', 'BLOG'];
    expect(panel.getAllByRole('checkbox')).toHaveLength(optionNames.length);
    for (const name of optionNames) {
      expect(panel.getByRole('checkbox', { name })).toBeInTheDocument();
    }

    const filterButton = screen.getByRole('button', { name: 'FILTER' });
    expect(filterButton).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();

    await user.click(filterButton);

    const drawer = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-ui-drawer]');
      if (!node) throw new Error('drawer not open');
      return node;
    });
    expect(drawer).toHaveAttribute('data-ui-drawer-side', 'left');
    expect(screen.getByRole('button', { name: 'FILTER' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer).getByRole('checkbox', { name: 'EVENT' })).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Close filter drawer' }));

    await waitFor(() => {
      expect(document.querySelector('[data-ui-drawer]')).not.toBeInTheDocument();
    });
  });

  it('SCR-NEWS-001 部品が自分で取り出して失敗した時は赤い失敗の文を出す', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, json: async () => [] });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(<PublicNewsGrid variant="catalog" />);

      const message = await screen.findByText('ニュースデータの取得に失敗しました');
      expect(message).toHaveClass('text-red-500');
      expect(fetchMock).toHaveBeenCalledWith('/api/news', { cache: 'no-store' });
    } finally {
      global.fetch = originalFetch;
      errorSpy.mockRestore();
    }
  });

  it('SCR-NEWS-001 部品が自分で取り出して成功した時は返った記事を並べる', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [ARTICLES[1]] });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      render(<PublicNewsGrid variant="catalog" />);

      expect(await screen.findByRole('heading', { level: 2, name: 'Store renewal' })).toBeInTheDocument();
      expect(screen.queryByText('ニュースデータの取得に失敗しました')).not.toBeInTheDocument();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
