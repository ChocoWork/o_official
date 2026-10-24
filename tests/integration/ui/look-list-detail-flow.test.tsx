import React from 'react';
import userEvent from '@testing-library/user-event';
import { cleanup, render, screen, within } from '@testing-library/react';
import LookPage from '@/app/look/page';
import LookDetailPage from '@/app/look/[id]/page';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { getPublishedLooks, getPublishedLooksCount } from '@/lib/look/server';

const pushMock = jest.fn();
let currentSearch = '';

type Row = Record<string, unknown>;

// 取り出しの関数（lib/look/server）と画像の署名は本物を通し、Supabase の client だけを表の行を絞って返す偽物にする
let mockTables: Record<string, Row[]> = {};

function mockCreateLookClient() {
  return {
    from: (table: string) => {
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
      const settle = () => {
        const rows = run();
        return Promise.resolve({ data: headOnly ? null : rows, count: rows.length, error: null });
      };
      const query: Record<string, unknown> = {
        select: (cols: string, opts?: { head?: boolean }) => {
          columns = cols.split(',').map((col) => col.trim());
          headOnly = opts?.head === true;
          return query;
        },
        eq: (col: string, val: unknown) => {
          filters.push((row) => String(row[col]) === String(val));
          return query;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((row) => vals.map(String).includes(String(row[col])));
          return query;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          if (opts?.ascending === false) descBy = col;
          return query;
        },
        limit: (n: number) => {
          limit = n;
          return query;
        },
        maybeSingle: async () => {
          const result = await settle();
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

jest.mock('next/navigation', () => ({
  usePathname: () => '/look',
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

// 並びは作った日時の新しい順。30（AW）→ 20（SS）→ 10（AW）で、40 は非公開の最新
const lookTable: Row[] = [
  {
    id: 30,
    season_year: 2026,
    season_type: 'AW',
    theme: 'Winter Layers',
    theme_description: 'Layered knit and coat',
    image_urls: ['looks/30-a.jpg'],
    created_at: '2026-10-03T00:00:00Z',
    status: 'published',
  },
  {
    id: 20,
    season_year: 2026,
    season_type: 'SS',
    theme: 'Spring Light',
    theme_description: 'Light linen',
    image_urls: ['looks/20-a.jpg'],
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

async function renderList(search: string) {
  currentSearch = search;
  const season = new URLSearchParams(search).get('season') ?? undefined;
  const element = await LookPage({ searchParams: Promise.resolve(season === undefined ? {} : { season }) });
  return render(element);
}

async function renderDetail(href: string) {
  const id = href.replace(/^\/look\//, '');
  const element = await LookDetailPage({ params: Promise.resolve({ id }) });
  return render(element);
}

function cardFor(theme: string): HTMLElement {
  const card = screen.getAllByTestId('look-card').find((candidate) => candidate.textContent?.includes(theme));
  if (!card) throw new Error(`card for ${theme} not found`);
  return card;
}

function cardHref(theme: string): string {
  return within(cardFor(theme)).getAllByRole('link')[0].getAttribute('href') ?? '';
}

function cardThemes(): string[] {
  return screen
    .getAllByTestId('look-card')
    .map((card) => card.querySelector('[data-testid="look-card-caption"] h3')?.textContent ?? '');
}

function seasonCheckbox(name: string): HTMLInputElement {
  return screen.getAllByRole('checkbox', { name })[0] as HTMLInputElement;
}

function desktopNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Look navigation' });
}

describe('look list to detail flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentSearch = '';
    mockTables = { looks: lookTable, items: itemTable, look_items: lookItemTable };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('FLOW-LOOK-001 一覧のカードは公開の LOOK の詳細へ移り、非公開の LOOK のカードを出さない', async () => {
    await renderList('');

    expect(cardThemes()).toEqual(['Winter Layers', 'Spring Light', 'Autumn Walk']);
    expect(cardHref('Winter Layers')).toBe('/look/30');
    expect(cardHref('Spring Light')).toBe('/look/20');
    expect(cardHref('Autumn Walk')).toBe('/look/10');
    expect(screen.queryByText('Hidden Draft Look')).not.toBeInTheDocument();
  });

  it('FLOW-LOOK-001 一覧のカードから詳細へ移り、NEXT LOOK を辿って最後の LOOK まで進み、PREV LOOK で戻る', async () => {
    await renderList('');
    const first = cardHref('Winter Layers');

    cleanup();
    await renderDetail(first);
    expect(screen.getByRole('heading', { level: 1, name: 'Winter Layers' })).toBeInTheDocument();
    const second = within(desktopNav()).getByRole('link', { name: 'Next look: Spring Light' }).getAttribute('href') ?? '';
    expect(second).toBe('/look/20');

    cleanup();
    await renderDetail(second);
    expect(screen.getByRole('heading', { level: 1, name: 'Spring Light' })).toBeInTheDocument();
    const third = within(desktopNav()).getByRole('link', { name: 'Next look: Autumn Walk' }).getAttribute('href') ?? '';
    expect(third).toBe('/look/10');

    cleanup();
    await renderDetail(third);
    expect(screen.getByRole('heading', { level: 1, name: 'Autumn Walk' })).toBeInTheDocument();
    const back = within(desktopNav()).getByRole('link', { name: 'Previous look: Spring Light' }).getAttribute('href');
    expect(back).toBe('/look/20');
  });

  it('FLOW-LOOK-001 端の LOOK では無い側を押せず、md 以上は薄い非リンク、md 未満は押せない表示にする', async () => {
    await renderDetail('/look/30');

    expect(within(desktopNav()).getByText('PREV LOOK').closest('a')).toBeNull();
    expect(within(desktopNav()).getByText('PREV LOOK').closest('[aria-hidden="true"]')).not.toBeNull();
    const fixed = screen.getByTestId('look-detail-fixed-nav');
    expect(within(fixed).getByText('PREV LOOK').closest('[data-ui-bottom-nav-disabled="true"]')).not.toBeNull();
    expect(within(fixed).getByRole('link', { name: 'NEXT LOOK' })).toHaveAttribute('href', '/look/20');

    cleanup();
    await renderDetail('/look/10');

    expect(within(desktopNav()).getByText('NEXT LOOK').closest('a')).toBeNull();
    expect(
      within(screen.getByTestId('look-detail-fixed-nav'))
        .getByText('NEXT LOOK')
        .closest('[data-ui-bottom-nav-disabled="true"]'),
    ).not.toBeNull();
  });

  it('FLOW-LOOK-001 シーズンで絞った一覧のカードも詳細へは /look/<id> だけで移り、選んだシーズンを引き継がない', async () => {
    await renderList('season=SS');

    expect(cardThemes()).toEqual(['Spring Light']);
    expect(cardHref('Spring Light')).toBe('/look/20');
    expect(cardHref('Spring Light')).not.toContain('season');
  });

  it('FLOW-LOOK-001 絞った一覧から入った詳細の前後は、絞ったシーズンの中でなく公開の全件の並びで決める', async () => {
    await renderList('season=SS');
    const detailHref = cardHref('Spring Light');

    cleanup();
    await renderDetail(detailHref);

    const nav = desktopNav();
    expect(within(nav).getByRole('link', { name: 'Previous look: Winter Layers' })).toHaveAttribute('href', '/look/30');
    expect(within(nav).getByRole('link', { name: 'Next look: Autumn Walk' })).toHaveAttribute('href', '/look/10');
  });

  it('FLOW-LOOK-001 詳細の LOOK LIST は選んだシーズンを付けない /look へ移り、全シーズンの一覧に戻る', async () => {
    await renderList('season=SS');
    const detailHref = cardHref('Spring Light');

    cleanup();
    await renderDetail(detailHref);
    const listHref = within(desktopNav()).getByRole('link', { name: 'Look list' }).getAttribute('href') ?? '';
    expect(listHref).toBe('/look');
    expect(
      within(screen.getByTestId('look-detail-fixed-nav')).getByRole('link', { name: 'LOOK LIST' }),
    ).toHaveAttribute('href', listHref);

    cleanup();
    await renderList('');
    expect(cardThemes()).toEqual(['Winter Layers', 'Spring Light', 'Autumn Walk']);
    expect(seasonCheckbox('ALL').checked).toBe(true);
  });

  it('FLOW-LOOK-001 一覧でシーズンを選ぶと履歴を1つ足して URL の season を書き換え、スクロールを保つ', async () => {
    const user = userEvent.setup();
    await renderList('');

    await user.click(seasonCheckbox('SS'));

    expect(pushMock).toHaveBeenLastCalledWith('/look?season=SS', { scroll: false });
    expect(cardThemes()).toEqual(['Spring Light']);

    await user.click(seasonCheckbox('AW'));

    expect(pushMock).toHaveBeenLastCalledWith('/look?season=AW', { scroll: false });
    expect(cardThemes()).toEqual(['Winter Layers', 'Autumn Walk']);
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it('FLOW-LOOK-001 一覧で ALL を選ぶと URL から season を外して全件に戻す', async () => {
    const user = userEvent.setup();
    await renderList('season=AW');
    expect(cardThemes()).toEqual(['Winter Layers', 'Autumn Walk']);

    await user.click(seasonCheckbox('ALL'));

    expect(pushMock).toHaveBeenLastCalledWith('/look', { scroll: false });
    expect(cardThemes()).toEqual(['Winter Layers', 'Spring Light', 'Autumn Walk']);
  });

  it('FLOW-LOOK-001 該当シーズンの LOOK が無い時の「すべて見る」で season を外した一覧へ戻る', async () => {
    mockTables.looks = [lookTable[1]];
    const user = userEvent.setup();
    await renderList('season=AW');

    expect(screen.getByText('該当シーズンのLOOKがありません')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'すべて見る' }));

    expect(pushMock).toHaveBeenLastCalledWith('/look', { scroll: false });
    expect(cardThemes()).toEqual(['Spring Light']);
  });

  it('FLOW-LOOK-001 カードの関連商品は md 未満のリンクで公開中の商品の /item/<id> へ移る', async () => {
    await renderList('');

    const related = within(cardFor('Winter Layers'))
      .getAllByRole('link')
      .filter((link) => (link.getAttribute('href') ?? '').startsWith('/item/'));
    expect(related.map((link) => link.getAttribute('href'))).toEqual(['/item/3', '/item/1']);
    expect(related[0]).toHaveTextContent('Silk Scarf');
    expect(related[1]).toHaveTextContent('Wool Coat');
    expect(within(cardFor('Autumn Walk')).queryByTestId('look-card-overlay-item')).toBeNull();
  });

  it('FLOW-LOOK-001 PC のカードの関連商品の行は、クリックで詳細でなく商品へ移り、キーボードの Enter でも商品へ移る', async () => {
    const user = userEvent.setup();
    await renderList('');
    const rows = within(cardFor('Winter Layers')).getAllByTestId('look-card-overlay-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('role', 'link');

    await user.click(rows[0]);
    expect(pushMock).toHaveBeenLastCalledWith('/item/3');

    rows[1].focus();
    await user.keyboard('{Enter}');
    expect(pushMock).toHaveBeenLastCalledWith('/item/1');
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it('FLOW-LOOK-001 PC のカードの関連商品の行は Enter 以外のキーでは移らない', async () => {
    const user = userEvent.setup();
    await renderList('');
    const [row] = within(cardFor('Winter Layers')).getAllByTestId('look-card-overlay-item');

    row.focus();
    await user.keyboard('a');

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('FLOW-LOOK-001 詳細の STYLING ITEMS は一覧のカードの関連商品と同じ商品へ移る', async () => {
    await renderList('');
    const fromCard = within(cardFor('Winter Layers'))
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => (href ?? '').startsWith('/item/'));
    const detailHref = cardHref('Winter Layers');

    cleanup();
    await renderDetail(detailHref);
    const fromDetail = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => (href ?? '').startsWith('/item/'));

    expect(fromDetail).toEqual(fromCard);
    expect(fromDetail).toEqual(['/item/3', '/item/1']);
  });

  it('FLOW-LOOK-001 ホームの LOOK の区画はカードで詳細へ、関連商品で商品へ、VIEW ALL で選びのない /look へ移る', async () => {
    currentSearch = 'season=SS';
    const looks = await getPublishedLooks(8);
    const totalCount = await getPublishedLooksCount();
    render(<PublicLookGrid variant="home" looks={looks} totalCount={totalCount} />);

    expect(totalCount).toBe(3);
    expect(cardHref('Winter Layers')).toBe('/look/30');
    expect(cardHref('Autumn Walk')).toBe('/look/10');
    expect(screen.getByRole('link', { name: 'VIEW ALL LOOKS' })).toHaveAttribute('href', '/look');
    const related = within(cardFor('Spring Light'))
      .getAllByRole('link')
      .filter((link) => (link.getAttribute('href') ?? '').startsWith('/item/'));
    expect(related.map((link) => link.getAttribute('href'))).toEqual(['/item/3']);
  });

  it('FLOW-LOOK-001 ホームから入った詳細も同じ並びで前後へ移れる', async () => {
    const looks = await getPublishedLooks(8);
    render(<PublicLookGrid variant="home" looks={looks} />);
    const detailHref = cardHref('Spring Light');

    cleanup();
    await renderDetail(detailHref);

    expect(within(desktopNav()).getByRole('link', { name: 'Previous look: Winter Layers' })).toHaveAttribute(
      'href',
      '/look/30',
    );
    expect(within(desktopNav()).getByRole('link', { name: 'Next look: Autumn Walk' })).toHaveAttribute(
      'href',
      '/look/10',
    );
  });

  it('FLOW-LOOK-001 公開の LOOK が1件も無い時、一覧は「公開中のLOOKがありません」を出して詳細へのカードを出さない', async () => {
    mockTables.looks = [lookTable[3]];

    await renderList('');

    expect(screen.getByText('公開中のLOOKがありません')).toBeInTheDocument();
    expect(screen.queryAllByTestId('look-card')).toHaveLength(0);
  });

  it('FLOW-LOOK-001 非公開の LOOK の詳細を URL で直接開くと一覧にも前後にも出ない「Look not found」になる', async () => {
    await renderDetail('/look/40');

    expect(screen.getByRole('heading', { level: 1, name: 'Look not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Look navigation' })).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden Draft Look')).not.toBeInTheDocument();
  });
});
