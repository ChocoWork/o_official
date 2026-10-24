import React from 'react';
import { render, screen, within } from '@testing-library/react';
import LookDetailPage, { generateMetadata } from '@/app/look/[id]/page';

type Row = Record<string, unknown>;
type RecordedCall = [string, ...unknown[]];

// 取り出しの関数（lib/look/server）と画像の署名は本物を通し、Supabase の client だけを表の行を絞って返す偽物にする
let mockTables: Record<string, Row[]> = {};
let mockFailTables: string[] = [];
const mockQueries: RecordedCall[][] = [];

function mockCreateLookClient() {
  return {
    from: (table: string) => {
      const calls: RecordedCall[] = [['from', table]];
      mockQueries.push(calls);
      const filters: Array<(row: Row) => boolean> = [];
      let columns: string[] = [];
      let descBy: string | null = null;
      let limit: number | null = null;
      let headOnly = false;
      const run = (): Row[] => {
        let rows = (mockTables[table] ?? []).filter((row) => filters.every((match) => match(row)));
        if (descBy) {
          const key = descBy;
          rows = [...rows].sort((a, b) => String(b[key]).localeCompare(String(a[key])));
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return rows.map((row) => Object.fromEntries(columns.map((col) => [col, row[col]])));
      };
      const settle = (): Promise<{ data: Row[] | null; count: number | null; error: unknown }> => {
        if (mockFailTables.includes(table)) {
          return Promise.resolve({ data: null, count: null, error: { message: `${table} failed` } });
        }
        const rows = run();
        return Promise.resolve({ data: headOnly ? null : rows, count: rows.length, error: null });
      };
      const query: Record<string, unknown> = {
        select: (cols: string, opts?: { head?: boolean }) => {
          calls.push(['select', cols]);
          columns = cols.split(',').map((col) => col.trim());
          headOnly = opts?.head === true;
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
        maybeSingle: async () => {
          calls.push(['maybeSingle']);
          const result = await settle();
          if (result.error) return result;
          return { data: (result.data ?? [])[0] ?? null, error: null };
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => settle().then(onF, onR),
      };
      return query;
    },
  };
}

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(async () => mockCreateLookClient()),
  createServiceRoleClient: jest.fn(async () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://signed.test/${bucket}/${path}` },
          error: null,
        }),
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

// 並びは作った日時の新しい順。30 → 20 → 10 で、40 は非公開の最新
const lookTable: Row[] = [
  {
    id: 30,
    season_year: 2026,
    season_type: 'AW',
    theme: 'Winter Layers',
    theme_description: 'Layered knit and coat',
    image_urls: ['looks/30-a.jpg', 'looks/30-b.jpg'],
    created_at: '2026-10-03T00:00:00Z',
    status: 'published',
  },
  {
    id: 20,
    season_year: 2026,
    season_type: 'SS',
    theme: 'Spring Light',
    theme_description: '',
    image_urls: [],
    created_at: '2026-09-03T00:00:00Z',
    status: 'published',
  },
  {
    id: 10,
    season_year: 2025,
    season_type: 'AW',
    theme: 'Autumn Walk',
    theme_description: 'Slow walk',
    image_urls: ['looks/10-a.jpg'],
    created_at: '2025-09-03T00:00:00Z',
    status: 'published',
  },
  {
    id: 40,
    season_year: 2026,
    season_type: 'AW',
    theme: 'Hidden Draft Look',
    theme_description: 'draft only',
    image_urls: ['looks/40-a.jpg'],
    created_at: '2026-10-10T00:00:00Z',
    status: 'private',
  },
];

const itemTable: Row[] = [
  { id: 1, category: 'COAT', name: 'Wool Coat', price: 48000, image_url: 'items/1.jpg', status: 'published' },
  { id: 2, category: 'KNIT', name: 'Hidden Knit', price: 12000, image_url: 'items/2.jpg', status: 'private' },
  { id: 3, category: 'SCARF', name: 'Silk Scarf', price: 9800, image_url: 'items/3.jpg', status: 'published' },
];

// 30 には公開の商品2つと非公開の商品1つ、20 には公開の商品1つを結ぶ。10 には何も結ばない
const lookItemTable: Row[] = [
  { look_id: 30, item_id: 3 },
  { look_id: 30, item_id: 2 },
  { look_id: 30, item_id: 1 },
  { look_id: 20, item_id: 3 },
];

function resetTables() {
  mockTables = { looks: lookTable, items: itemTable, look_items: lookItemTable };
  mockFailTables = [];
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function renderDetail(id: string) {
  const element = await LookDetailPage(paramsOf(id));
  return render(element);
}

function desktopNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Look navigation' });
}

function fixedNav(): HTMLElement {
  return screen.getByTestId('look-detail-fixed-nav');
}

function itemLinks(): HTMLElement[] {
  return screen.queryAllByRole('link').filter((link) => (link.getAttribute('href') ?? '').startsWith('/item/'));
}

describe('look detail screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueries.length = 0;
    resetTables();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SCR-LOOK-004 公開の LOOK の id で、シーズン・テーマの見出し・説明文を出す', async () => {
    await renderDetail('30');

    expect(screen.getByText('2026 AW')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Winter Layers' })).toBeInTheDocument();
    expect(screen.getByText('Layered knit and coat')).toBeInTheDocument();
  });

  it('SCR-LOOK-004 公開の LOOK を新しい順に全部取って位置を探し、件数の上限を付けない', async () => {
    await renderDetail('30');

    const lookQueries = mockQueries.filter((calls) => calls.some((call) => call[0] === 'from' && call[1] === 'looks'));
    expect(lookQueries).toHaveLength(1);
    expect(lookQueries[0]).toEqual(
      expect.arrayContaining([
        ['eq', 'status', 'published'],
        ['order', 'created_at', { ascending: false }],
      ]),
    );
    expect(lookQueries[0].some((call) => call[0] === 'limit')).toBe(false);
  });

  it('SCR-LOOK-004 説明文が空の時は空白1文字の段落を残す', async () => {
    await renderDetail('20');

    expect(screen.getByRole('heading', { level: 1, name: 'Spring Light' })).toBeInTheDocument();
    const paragraph = screen.getByText('2026 SS').parentElement?.nextElementSibling?.querySelector('p');
    expect(paragraph?.textContent).toBe(' ');
  });

  it('SCR-LOOK-004 テーマと説明文の HTML を解釈せず文字のまま出す', async () => {
    mockTables.looks = [
      {
        ...lookTable[0],
        theme: '<img src=x onerror="alert(1)">',
        theme_description: '<script>alert(2)</script>',
      },
    ];

    const { container } = await renderDetail('30');

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(screen.getByText('<script>alert(2)</script>')).toBeInTheDocument();
  });

  it('SCR-LOOK-004 STYLING ITEMS は公開中の商品だけを結んだ順に、名前・分類・価格・商品へのリンクつきで出す', async () => {
    await renderDetail('30');

    const links = itemLinks();
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/item/3', '/item/1']);
    expect(within(links[0]).getByText('Silk Scarf')).toBeInTheDocument();
    expect(within(links[0]).getByText('SCARF')).toBeInTheDocument();
    expect(links[0]).toHaveTextContent(/9,800/);
    expect(within(links[1]).getByText('Wool Coat')).toBeInTheDocument();
    expect(links[1]).toHaveTextContent(/48,000/);
    expect(within(links[1]).getByRole('img', { name: 'Wool Coat' })).toHaveAttribute(
      'src',
      expect.stringContaining('signed.test'),
    );
    expect(screen.queryByText('Hidden Knit')).not.toBeInTheDocument();
    expect(screen.queryByText('紐づけ商品はありません')).not.toBeInTheDocument();
  });

  it('SCR-LOOK-004 結んだ商品が無い時は「紐づけ商品はありません」を出し、商品のリンクを出さない', async () => {
    await renderDetail('10');

    expect(screen.getByText('紐づけ商品はありません')).toBeInTheDocument();
    expect(itemLinks()).toHaveLength(0);
  });

  it('SCR-LOOK-004 画像のギャラリーに署名つきの画像を渡し、モバイル・タブレット・PC のどれにも1枚目を出す', async () => {
    await renderDetail('30');

    const firstImages = screen.getAllByAltText('Winter Layers - 1枚目');
    expect(firstImages).toHaveLength(3);
    for (const image of firstImages) {
      expect(image).toHaveAttribute('src', 'https://signed.test/look-images/looks/30-a.jpg');
    }
    expect(screen.getAllByAltText('Winter Layers - 2枚目').length).toBeGreaterThanOrEqual(2);
  });

  it('SCR-LOOK-004 md 以上の前後の格子は PREV LOOK・LOOK LIST・NEXT LOOK を前後のテーマの名前つきで出す', async () => {
    await renderDetail('20');

    const nav = desktopNav();
    expect(within(nav).getByRole('link', { name: 'Previous look: Winter Layers' })).toHaveAttribute('href', '/look/30');
    expect(within(nav).getByRole('link', { name: 'Look list' })).toHaveAttribute('href', '/look');
    expect(within(nav).getByRole('link', { name: 'Next look: Autumn Walk' })).toHaveAttribute('href', '/look/10');
    expect(within(nav).getByText('PREV LOOK')).toBeInTheDocument();
    expect(within(nav).getByText('LOOK LIST')).toBeInTheDocument();
    expect(within(nav).getByText('NEXT LOOK')).toBeInTheDocument();
  });

  it('SCR-LOOK-004 前後は公開の全件の並びで決め、非公開の LOOK を前後にしない', async () => {
    await renderDetail('30');

    expect(screen.queryByRole('link', { name: /Hidden Draft Look/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Previous look/ })).not.toBeInTheDocument();
    expect(within(desktopNav()).getByRole('link', { name: 'Next look: Spring Light' })).toHaveAttribute(
      'href',
      '/look/20',
    );
  });

  it('SCR-LOOK-004 最新の LOOK は前の側を薄い非リンク（aria-hidden）にし、次と一覧は押せる', async () => {
    await renderDetail('30');

    const nav = desktopNav();
    const placeholder = within(nav).getByText('PREV LOOK').closest('[aria-hidden="true"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.closest('a')).toBeNull();
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
  });

  it('SCR-LOOK-004 最古の LOOK は次の側を薄い非リンク（aria-hidden）にし、前と一覧は押せる', async () => {
    await renderDetail('10');

    const nav = desktopNav();
    const placeholder = within(nav).getByText('NEXT LOOK').closest('[aria-hidden="true"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.closest('a')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Previous look: Spring Light' })).toHaveAttribute('href', '/look/20');
    expect(within(nav).getByRole('link', { name: 'Look list' })).toHaveAttribute('href', '/look');
  });

  it('SCR-LOOK-004 md 未満は同じ3項目を固定のナビに出し、前後が無い側は押せない表示にする', async () => {
    await renderDetail('30');

    const fixed = fixedNav();
    const prev = within(fixed).getByText('PREV LOOK');
    expect(prev.closest('a')).toBeNull();
    expect(prev.closest('[data-ui-bottom-nav-disabled="true"]')).not.toBeNull();
    expect(within(fixed).getByRole('link', { name: 'LOOK LIST' })).toHaveAttribute('href', '/look');
    expect(within(fixed).getByRole('link', { name: 'NEXT LOOK' })).toHaveAttribute('href', '/look/20');
    expect(fixed.querySelector('nav')).toHaveAttribute('data-ui-bottom-nav-fixed', 'true');
  });

  it('SCR-LOOK-004 md 未満の固定のナビは両側に LOOK がある時、前後とも押せるリンクにする', async () => {
    await renderDetail('20');

    const fixed = fixedNav();
    expect(within(fixed).getByRole('link', { name: 'PREV LOOK' })).toHaveAttribute('href', '/look/30');
    expect(within(fixed).getByRole('link', { name: 'NEXT LOOK' })).toHaveAttribute('href', '/look/10');
    expect(fixed.querySelector('[data-ui-bottom-nav-disabled="true"]')).toBeNull();
  });

  it('SCR-LOOK-004 ナビのアイコンは線幅1のインラインの SVG で、読み上げから外す', async () => {
    await renderDetail('20');

    const icons = screen.getAllByTestId('look-detail-nav-icon');
    expect(icons).toHaveLength(6);
    for (const icon of icons) {
      expect(icon.tagName.toLowerCase()).toBe('svg');
      expect(icon).toHaveAttribute('stroke-width', '1');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('SCR-LOOK-004 「Back to Lookbook」のリンクを出さない', async () => {
    await renderDetail('20');

    expect(screen.queryByRole('link', { name: /Back to Lookbook/i })).not.toBeInTheDocument();
  });

  it('SCR-LOOK-004 非公開・無い・数でない id は見出し「Look not found」だけを出し、中身を出さない', async () => {
    for (const id of ['40', '999', 'abc']) {
      const { container, unmount } = await renderDetail(id);

      expect(screen.getByRole('heading', { level: 1, name: 'Look not found' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Look navigation' })).not.toBeInTheDocument();
      expect(container).not.toHaveTextContent('Hidden Draft Look');
      expect(container).not.toHaveTextContent('draft only');
      unmount();
    }
  });

  it('SCR-LOOK-004 LOOK の取り出しに失敗した時も、無い時と同じ「Look not found」の画面にする', async () => {
    mockFailTables = ['looks'];

    await renderDetail('30');

    expect(screen.getByRole('heading', { level: 1, name: 'Look not found' })).toBeInTheDocument();
    expect(screen.queryByText('Winter Layers')).not.toBeInTheDocument();
  });

  it('SCR-LOOK-004 メタの title は「<テーマ> | LOOK | Le Fil des Heures」、description は説明文、OG の画像は1枚目の署名つき URL にする', async () => {
    const metadata = await generateMetadata(paramsOf('30'));

    expect(metadata.title).toBe('Winter Layers | LOOK | Le Fil des Heures');
    expect(metadata.description).toBe('Layered knit and coat');
    expect(metadata.openGraph).toMatchObject({
      title: 'Winter Layers | LOOK | Le Fil des Heures',
      description: 'Layered knit and coat',
      images: [{ url: 'https://signed.test/look-images/looks/30-a.jpg' }],
    });
  });

  it('SCR-LOOK-004 メタの取り出しは公開の印と id で1件に絞る', async () => {
    await generateMetadata(paramsOf('30'));

    const detailQuery = mockQueries.find((calls) => calls.some((call) => call[0] === 'maybeSingle'));
    expect(detailQuery).toEqual(
      expect.arrayContaining([['from', 'looks'], ['eq', 'status', 'published'], ['eq', 'id', 30]]),
    );
  });

  it('SCR-LOOK-004 説明文が空の LOOK のメタ description はテーマから作り、画像が無ければ OG の画像を空にする', async () => {
    const metadata = await generateMetadata(paramsOf('20'));

    expect(metadata.description).toBe('Spring Light のスタイリング詳細ページ');
    expect(metadata.openGraph).toMatchObject({ images: [] });
  });

  it('SCR-LOOK-004 無い・非公開の LOOK のメタは固定の title と description にする', async () => {
    for (const id of ['999', '40']) {
      const metadata = await generateMetadata(paramsOf(id));

      expect(metadata).toEqual({
        title: 'Look not found | Le Fil des Heures',
        description: '指定されたルックは見つかりませんでした。',
      });
    }
  });

  it('SCR-LOOK-004 数でない id のメタは DB を引かずに固定の title にする', async () => {
    const metadata = await generateMetadata(paramsOf('abc'));

    expect(metadata.title).toBe('Look not found | Le Fil des Heures');
    expect(mockQueries).toHaveLength(0);
  });
});
