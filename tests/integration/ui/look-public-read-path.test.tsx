import React from 'react';
import { render, screen, within } from '@testing-library/react';

type Row = Record<string, unknown>;
type RecordedCall = [string, ...unknown[]];
type RecordedQuery = { table: string; calls: RecordedCall[] };

// 取り出しの関数（lib/look/server）と画像の署名は本物を通し、Supabase の client だけを表の行を絞って返す偽物にする
const mockDb: {
  tables: Record<string, Row[]>;
  errors: Record<string, unknown>;
  queries: RecordedQuery[];
  signedBuckets: string[];
  serviceFromCalls: string[];
} = { tables: {}, errors: {}, queries: [], signedBuckets: [], serviceFromCalls: [] };

function mockCreateDbClient() {
  return {
    from: (table: string) => {
      const calls: RecordedCall[] = [];
      mockDb.queries.push({ table, calls });
      const filters: Array<(row: Row) => boolean> = [];
      let columns: string[] = [];
      let head = false;
      let descBy: string | null = null;
      let limit: number | null = null;
      const rows = (): Row[] => {
        let found = (mockDb.tables[table] ?? []).filter((row) => filters.every((test) => test(row)));
        if (descBy) {
          const key = descBy;
          found = [...found].sort((a, b) => String(b[key]).localeCompare(String(a[key])));
        }
        if (limit !== null) found = found.slice(0, limit);
        return found;
      };
      const project = (found: Row[]) =>
        found.map((row) => Object.fromEntries(columns.map((col) => [col, row[col]])));
      const settle = () => {
        const error = mockDb.errors[table] ?? null;
        if (error) return { data: null, error, count: null };
        const found = rows();
        if (head) return { data: null, error: null, count: found.length };
        return { data: project(found), error: null, count: null };
      };
      const query: Record<string, unknown> = {
        select: (cols: string, options?: { head?: boolean; count?: string }) => {
          calls.push(options ? ['select', cols, options] : ['select', cols]);
          columns = cols.split(',').map((col) => col.trim());
          head = options?.head === true;
          return query;
        },
        eq: (col: string, val: unknown) => {
          calls.push(['eq', col, val]);
          filters.push((row) => String(row[col]) === String(val));
          return query;
        },
        in: (col: string, vals: unknown[]) => {
          calls.push(['in', col, vals]);
          filters.push((row) => vals.map(String).includes(String(row[col])));
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
        maybeSingle: () => {
          calls.push(['maybeSingle']);
          const settled = settle();
          const data = Array.isArray(settled.data) ? (settled.data[0] ?? null) : null;
          return Promise.resolve({ data, error: settled.error });
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(settle()).then(onF, onR),
      };
      return query;
    },
  };
}

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(async () => mockCreateDbClient()),
  createServiceRoleClient: jest.fn(async () => ({
    from: (table: string) => {
      mockDb.serviceFromCalls.push(table);
      throw new Error('service role は DB を読まない');
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, expiresIn: number) => {
          mockDb.signedBuckets.push(bucket);
          return { data: { signedUrl: `https://signed.test/${bucket}/${path}?exp=${expiresIn}` }, error: null };
        },
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

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt, ...rest }: { src: string; alt: string; fill?: boolean; sizes?: string }) => {
    const { fill: _fill, sizes: _sizes, ...passthrough } = rest;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} {...passthrough} />;
  },
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/look',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const { createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const LookPage = require('@/app/look/page').default;
const LookDetailPageModule = require('@/app/look/[id]/page');
const LookDetailPage = LookDetailPageModule.default;
const { getPublishedLooks, getPublishedLooksCount, getPublishedLookById } = require('@/lib/look/server');

const COLUMNS = 'id,season_year,season_type,theme,theme_description,image_urls,created_at';

const LOOK_ROWS: Row[] = [
  {
    id: 1,
    season_year: 2025,
    season_type: 'AW',
    theme: 'Older theme',
    theme_description: 'older description',
    image_urls: ['looks/2025/older.jpg'],
    created_at: '2025-09-01T00:00:00Z',
    status: 'published',
  },
  {
    id: 2,
    season_year: 2026,
    season_type: 'SS',
    theme: 'Newer theme',
    theme_description: 'newer description',
    image_urls: ['looks/2026/newer-a.jpg', 'looks/2026/newer-b.jpg'],
    created_at: '2026-03-01T00:00:00Z',
    status: 'published',
  },
  {
    id: 3,
    season_year: 2026,
    season_type: 'AW',
    theme: 'Hidden theme',
    theme_description: 'hidden description',
    image_urls: ['looks/2026/hidden.jpg'],
    created_at: '2026-09-01T00:00:00Z',
    status: 'private',
  },
];

const LOOK_ITEM_ROWS: Row[] = [
  { look_id: 2, item_id: 10 },
  { look_id: 2, item_id: 11 },
  { look_id: 1, item_id: 10 },
];

const ITEM_ROWS: Row[] = [
  { id: 10, category: 'COAT', name: 'Wool coat', price: 48000, image_url: 'arc-look-coat.jpg', status: 'published' },
  { id: 11, category: 'BAG', name: 'Secret bag', price: 12000, image_url: 'arc-look-bag.jpg', status: 'private' },
];

function queriesOn(table: string): RecordedQuery[] {
  return mockDb.queries.filter((query) => query.table === table);
}

function captionThemes(): string[] {
  return screen
    .getAllByTestId('look-card-caption')
    .map((caption) => within(caption).getByRole('heading', { level: 3 }).textContent ?? '');
}

async function renderLookPage() {
  const element = await LookPage({ searchParams: undefined });
  return render(element);
}

describe('ARC-LOOK-001 public read path', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.tables = { looks: LOOK_ROWS, look_items: LOOK_ITEM_ROWS, items: ITEM_ROWS };
    mockDb.errors = {};
    mockDb.queries = [];
    mockDb.signedBuckets = [];
    mockDb.serviceFromCalls = [];
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('ARC-LOOK-001 /look は匿名の client で公開済みの LOOK だけを作った日時の新しい順に取り出し、件数を絞らずに描く', async () => {
    await renderLookPage();

    expect(createPublicClient).toHaveBeenCalled();
    const [looksQuery] = queriesOn('looks');
    expect(looksQuery.calls).toEqual([
      ['select', COLUMNS],
      ['eq', 'status', 'published'],
      ['order', 'created_at', { ascending: false }],
    ]);
    expect(looksQuery.calls.some(([method]) => method === 'limit')).toBe(false);

    expect(captionThemes()).toEqual(['Newer theme', 'Older theme']);
    expect(screen.queryByText('Hidden theme')).not.toBeInTheDocument();
  });

  it('ARC-LOOK-001 service role の client は DB を読まず、LOOK と商品の画像の署名だけに使う', async () => {
    // 商品の画像の署名は道筋ごとに使い回されるので、ほかの試しと重ならない道筋にして署名を必ず通す
    mockDb.tables.items = [{ ...ITEM_ROWS[0], image_url: 'arc-look-coat-signing.jpg' }, ITEM_ROWS[1]];

    await renderLookPage();

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(mockDb.serviceFromCalls).toEqual([]);
    expect(new Set(mockDb.signedBuckets)).toEqual(new Set(['look-images', 'item-images']));

    const images = screen.getAllByRole('img');
    expect(images.map((image) => image.getAttribute('src'))).toEqual(
      expect.arrayContaining([
        'https://signed.test/look-images/looks/2026/newer-a.jpg?exp=3600',
        'https://signed.test/look-images/looks/2026/newer-b.jpg?exp=3600',
        'https://signed.test/look-images/looks/2025/older.jpg?exp=3600',
      ]),
    );
  });

  it('ARC-LOOK-001 関連商品は公開中の物だけを付け、非公開の商品の名前と価格を出さない', async () => {
    await renderLookPage();

    const [lookItemsQuery] = queriesOn('look_items');
    expect(lookItemsQuery.calls).toContainEqual(['in', 'look_id', [2, 1]]);
    const [itemsQuery] = queriesOn('items');
    expect(itemsQuery.calls).toContainEqual(['in', 'id', [10, 11]]);
    expect(itemsQuery.calls).toContainEqual(['eq', 'status', 'published']);

    expect(screen.getAllByText('Wool coat').length).toBeGreaterThan(0);
    expect(screen.queryByText('Secret bag')).not.toBeInTheDocument();
    expect(screen.queryByText(/12,000/)).not.toBeInTheDocument();
  });

  it('ARC-LOOK-001 LOOK の取り出しが失敗しても例外にせず、公開中の LOOK が無い一覧として描き、関連も署名も読まない', async () => {
    mockDb.errors.looks = { message: 'db down' };

    await renderLookPage();

    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.queryAllByTestId('look-card')).toHaveLength(0);
    expect(queriesOn('look_items')).toHaveLength(0);
    expect(mockDb.signedBuckets).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch published looks:', { message: 'db down' });
  });

  it('ARC-LOOK-001 関連の取り出しが失敗した時は LOOK を署名していない元の道筋のまま返し、商品は付けない', async () => {
    mockDb.errors.look_items = { message: 'relation down' };

    await renderLookPage();

    expect(captionThemes()).toEqual(['Newer theme', 'Older theme']);
    expect(mockDb.signedBuckets).toEqual([]);
    const sources = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(sources).toContain('looks/2026/newer-a.jpg');
    expect(sources).toContain('looks/2025/older.jpg');
    expect(screen.queryByText('Wool coat')).not.toBeInTheDocument();
    expect(queriesOn('items')).toHaveLength(0);
  });

  it('ARC-LOOK-001 商品の取り出しが失敗した時は LOOK を署名して返し、商品だけを付けない', async () => {
    mockDb.errors.items = { message: 'items down' };

    await renderLookPage();

    expect(captionThemes()).toEqual(['Newer theme', 'Older theme']);
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('src'))).toContain(
      'https://signed.test/look-images/looks/2026/newer-a.jpg?exp=3600',
    );
    expect(screen.queryByText('Wool coat')).not.toBeInTheDocument();
  });

  it('ARC-LOOK-001 ホーム用に件数を渡すと取り出しを limit で絞り、総数は行を取らずに公開済みだけを数える', async () => {
    const looks = await getPublishedLooks(1);

    expect(looks.map((look: { id: number }) => look.id)).toEqual([2]);
    expect(queriesOn('looks')[0].calls).toContainEqual(['limit', 1]);

    mockDb.queries = [];
    await expect(getPublishedLooksCount()).resolves.toBe(2);
    expect(queriesOn('looks')[0].calls).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'status', 'published'],
    ]);
  });

  it('ARC-LOOK-001 総数の取り出しが失敗した時は 0 を返し、LOOK が無い時も 0 を返す', async () => {
    mockDb.errors.looks = { message: 'count down' };
    await expect(getPublishedLooksCount()).resolves.toBe(0);

    mockDb.errors = {};
    mockDb.tables.looks = [];
    await expect(getPublishedLooksCount()).resolves.toBe(0);
  });

  it('ARC-LOOK-001 /look/[id] は公開済みの全件の並びの中の位置で前後を決め、関連は公開中の商品だけを出す', async () => {
    const element = await LookDetailPage({ params: Promise.resolve({ id: '2' }) });
    render(element);

    expect(screen.getByRole('heading', { level: 1, name: 'Newer theme' })).toBeInTheDocument();
    expect(screen.getByText('2026 SS')).toBeInTheDocument();
    expect(screen.getByText('Wool coat')).toBeInTheDocument();
    expect(screen.queryByText('Secret bag')).not.toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'Look navigation' });
    expect(within(nav).getByRole('link', { name: 'Next look: Older theme' })).toHaveAttribute('href', '/look/1');
    expect(within(nav).queryByRole('link', { name: /Previous look/ })).not.toBeInTheDocument();
    expect(queriesOn('looks')[0].calls).toContainEqual(['eq', 'status', 'published']);
  });

  it('ARC-LOOK-001 /look/[id] は非公開の LOOK と無い LOOK を同じ「Look not found」にし、中身を出さない', async () => {
    const hidden = await LookDetailPage({ params: Promise.resolve({ id: '3' }) });
    const { unmount } = render(hidden);
    expect(screen.getByRole('heading', { level: 1, name: 'Look not found' })).toBeInTheDocument();
    expect(screen.queryByText('Hidden theme')).not.toBeInTheDocument();
    unmount();

    const missing = await LookDetailPage({ params: Promise.resolve({ id: '999' }) });
    render(missing);
    expect(screen.getByRole('heading', { level: 1, name: 'Look not found' })).toBeInTheDocument();
  });

  it('ARC-LOOK-001 詳細のメタ情報は公開済みの1件を id で取り、非公開・無い・数でない id は見つからない題にする', async () => {
    const found = await LookDetailPageModule.generateMetadata({ params: Promise.resolve({ id: '2' }) });
    expect(found.title).toBe('Newer theme | LOOK | Le Fil des Heures');
    expect(found.openGraph.images).toEqual([{ url: 'https://signed.test/look-images/looks/2026/newer-a.jpg?exp=3600' }]);

    const [byIdQuery] = queriesOn('looks');
    expect(byIdQuery.calls).toEqual([
      ['select', COLUMNS],
      ['eq', 'status', 'published'],
      ['eq', 'id', 2],
      ['maybeSingle'],
    ]);

    for (const id of ['3', '999', 'abc']) {
      const metadata = await LookDetailPageModule.generateMetadata({ params: Promise.resolve({ id }) });
      expect(metadata.title).toBe('Look not found | Le Fil des Heures');
    }
    await expect(getPublishedLookById(3)).resolves.toBeNull();
  });

  it('ARC-LOOK-001 詳細の関連の取り出しが失敗しても LOOK 本体は返し、関連なしで署名つきの画像を付ける', async () => {
    mockDb.errors.look_items = { message: 'relation down' };

    const look = await getPublishedLookById(2);

    expect(look).toMatchObject({
      id: 2,
      theme: 'Newer theme',
      linkedItems: [],
      imageUrls: [
        'https://signed.test/look-images/looks/2026/newer-a.jpg?exp=3600',
        'https://signed.test/look-images/looks/2026/newer-b.jpg?exp=3600',
      ],
    });
    expect(queriesOn('items')).toHaveLength(0);
  });

  it('ARC-LOOK-001 詳細の商品の取り出しが失敗しても LOOK 本体は返し、商品だけを付けない', async () => {
    mockDb.errors.items = { message: 'items down' };

    const look = await getPublishedLookById(2);

    expect(look).toMatchObject({ id: 2, linkedItems: [] });
  });

  it('ARC-LOOK-001 詳細の関連商品は公開中の物だけを関連の並びで付け、署名つきの画像にする', async () => {
    const look = await getPublishedLookById(2);

    expect(look.linkedItems).toEqual([
      {
        category: 'COAT',
        id: 10,
        name: 'Wool coat',
        price: 48000,
        imageUrl: expect.stringContaining('arc-look-coat.jpg'),
      },
    ]);
    expect(look.linkedItems[0].imageUrl).toMatch(/^https:\/\/signed\.test\/item-images\//);
  });
});
