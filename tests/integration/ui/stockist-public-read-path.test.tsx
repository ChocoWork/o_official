import React from 'react';
import { render, screen } from '@testing-library/react';

type Row = Record<string, unknown>;
type RecordedCall = [string, ...unknown[]];

// 取り出しの関数（services/public）とページ・格子は本物を通し、Supabase の client だけを表の行を絞って返す偽物にする
const mockDb: {
  rows: Row[];
  error: unknown;
  nullData: boolean;
  calls: RecordedCall[];
  tables: string[];
  createClientArgs: unknown[][];
} = { rows: [], error: null, nullData: false, calls: [], tables: [], createClientArgs: [] };

function mockCreateDbClient() {
  return {
    from: (table: string) => {
      mockDb.tables.push(table);
      const filters: Array<(row: Row) => boolean> = [];
      let columns: string[] = [];
      let ascBy: string | null = null;
      let limit: number | null = null;
      const settle = () => {
        if (mockDb.error) return { data: null, error: mockDb.error };
        if (mockDb.nullData) return { data: null, error: null };
        let found = mockDb.rows.filter((row) => filters.every((test) => test(row)));
        if (ascBy) {
          const key = ascBy;
          found = [...found].sort((a, b) => Number(a[key]) - Number(b[key]));
        }
        if (limit !== null) found = found.slice(0, limit);
        return {
          data: found.map((row) => Object.fromEntries(columns.map((col) => [col, row[col]]))),
          error: null,
        };
      };
      const query: Record<string, unknown> = {
        select: (cols: string) => {
          mockDb.calls.push(['select', cols]);
          columns = cols.split(',').map((col) => col.trim());
          return query;
        },
        eq: (col: string, val: unknown) => {
          mockDb.calls.push(['eq', col, val]);
          filters.push((row) => row[col] === val);
          return query;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          mockDb.calls.push(['order', col, opts]);
          if (opts?.ascending === true) ascBy = col;
          return query;
        },
        limit: (n: number) => {
          mockDb.calls.push(['limit', n]);
          limit = n;
          return query;
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(settle()).then(onF, onR),
      };
      return query;
    },
  };
}

jest.mock('@/lib/supabase/server', () => ({
  // 公開の取り出しは Cookie を引き継がない公開用の client で行う（SEC-STOCKIST-002）。Cookie の session の client は使わない
  createClient: jest.fn(async () => mockCreateDbClient()),
  createPublicClient: jest.fn(async (...args: unknown[]) => {
    mockDb.createClientArgs.push(args);
    return mockCreateDbClient();
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
  usePathname: () => '/stockist',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const { createClient, createPublicClient } = require('@/lib/supabase/server');
const StockistPage = require('@/app/stockist/page').default;
const { PublicStockistGrid } = require('@/features/stockist/components/PublicStockistGrid');
const { getPublicStockists, getHomePublicStockists } = require('@/features/stockist/services/public');

const SELECT_COLUMNS = 'id, name, address, phone, time, holiday, status';

function makeRow(id: number, overrides: Row = {}): Row {
  return {
    id,
    name: `Shop ${id}`,
    address: `東京都渋谷区 ${id}-1-1`,
    phone: `03-0000-000${id}`,
    time: '11:00-19:00',
    holiday: '水曜',
    status: 'published',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

// 並びの確かめのため、わざと id の順でない並びで DB の行を持たせる
const ROWS: Row[] = [makeRow(3), makeRow(1), makeRow(4, { status: 'private' }), makeRow(2)];

function cardTitles(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
}

describe('ARC-STOCKIST-001 public read path', () => {
  let errorSpy: jest.SpyInstance;
  let fetchSpy: jest.Mock;
  const originalFetch = (globalThis as { fetch?: unknown }).fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.rows = ROWS;
    mockDb.error = null;
    mockDb.nullData = false;
    mockDb.calls = [];
    mockDb.tables = [];
    mockDb.createClientArgs = [];
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  it('ARC-STOCKIST-001 /stockist はページのサーバーの中で stockists を直接読み、公開の店だけを id の昇順に上限 200 件で描く', async () => {
    const element = await StockistPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(mockDb.tables).toEqual(['stockists']);
    expect(mockDb.calls).toEqual([
      ['select', SELECT_COLUMNS],
      ['eq', 'status', 'published'],
      ['order', 'id', { ascending: true }],
      ['limit', 200],
    ]);
    expect(cardTitles()).toEqual(['Shop 1', 'Shop 2', 'Shop 3']);
    expect(screen.queryByText('Shop 4')).not.toBeInTheDocument();
  });

  it('ARC-STOCKIST-001 公開の読み出しは API を呼ばず、引数なしの公開用の client（Cookie を引き継がない）で読む', async () => {
    const element = await StockistPage({ searchParams: undefined });
    render(element);

    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(mockDb.createClientArgs).toEqual([[]]);
    expect(createClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ARC-STOCKIST-001 画面に渡すのは id・店舗名・住所・電話・営業時間・定休日の6つの列だけで、状態や作成日時を詰め直して落とす', async () => {
    const stockists = await getPublicStockists();

    expect(stockists).toHaveLength(3);
    for (const shop of stockists) {
      expect(Object.keys(shop).sort()).toEqual(['address', 'holiday', 'id', 'name', 'phone', 'time']);
    }
    expect(stockists[0]).toEqual({
      id: 1,
      name: 'Shop 1',
      address: '東京都渋谷区 1-1-1',
      phone: '03-0000-0001',
      time: '11:00-19:00',
      holiday: '水曜',
    });
  });

  it('ARC-STOCKIST-001 非公開の店は取り出しの条件で除かれ、返す配列のどこにも非公開の印や作成日時が残らない', async () => {
    const stockists = await getPublicStockists();

    expect(stockists.map((shop: { id: number }) => shop.id)).toEqual([1, 2, 3]);
    expect(JSON.stringify(stockists)).not.toContain('private');
    expect(JSON.stringify(stockists)).not.toContain('created_at');
  });

  it('ARC-STOCKIST-001 ホームは6件までに絞って取り、7件以上あっても id の小さい順の6件だけを節に描く', async () => {
    mockDb.rows = Array.from({ length: 8 }, (_, index) => makeRow(8 - index));

    const stockists = await getHomePublicStockists();

    expect(mockDb.calls).toContainEqual(['limit', 6]);
    expect(stockists.map((shop: { id: number }) => shop.id)).toEqual([1, 2, 3, 4, 5, 6]);

    render(<PublicStockistGrid variant="home" stockists={stockists} />);
    expect(cardTitles()).toEqual(['Shop 1', 'Shop 2', 'Shop 3', 'Shop 4', 'Shop 5', 'Shop 6']);
  });

  it('ARC-STOCKIST-001 件数の指定は正の有限の数のときだけ limit にし、小数は切り捨て、200 を超える値は 200 に切り詰め、0・負・NaN・無限・未指定でも上限の 200 を掛ける', async () => {
    await getPublicStockists({ limit: 2.9 });
    expect(mockDb.calls).toContainEqual(['limit', 2]);

    mockDb.calls = [];
    await getPublicStockists({ limit: 500 });
    expect(mockDb.calls).toContainEqual(['limit', 200]);

    for (const limit of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      mockDb.calls = [];
      const stockists = await getPublicStockists({ limit });
      expect(mockDb.calls).toContainEqual(['limit', 200]);
      expect(stockists).toHaveLength(3);
    }
  });

  it('ARC-STOCKIST-001 取り出しが失敗しても例外にせず、空の一覧として「該当する取扱店舗がございません。」を描き、記録だけ残す', async () => {
    mockDb.error = { message: 'db down: secret detail', code: 'PGRST301' };

    await expect(getPublicStockists()).resolves.toEqual([]);
    // 記録に残すのは誤りの名前と符号だけ。message・details・hint・stack は渡さない（SEC-STOCKIST-014）
    expect(errorSpy).toHaveBeenCalledWith('Failed to fetch public stockists:', { name: 'UnknownError', code: 'PGRST301' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret detail');

    const element = await StockistPage({ searchParams: Promise.resolve({}) });
    render(element);
    expect(screen.getByText('該当する取扱店舗がございません。')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('ARC-STOCKIST-001 取り出しが失敗した時のホームの節は、空の節ではなくオンラインストアへの案内を描く', async () => {
    mockDb.error = { message: 'db down' };

    const stockists = await getHomePublicStockists();
    render(<PublicStockistGrid variant="home" stockists={stockists} />);

    expect(stockists).toEqual([]);
    expect(screen.getByText('現在、取扱店舗はございません。オンラインストアにて販売中です。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'VIEW COLLECTION' })).toHaveAttribute('href', '/item');
  });

  it('ARC-STOCKIST-001 誤りが無くても data が null なら空の配列にし、公開の店が1件も無い時も空の配列にする', async () => {
    mockDb.nullData = true;
    await expect(getPublicStockists()).resolves.toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();

    mockDb.nullData = false;
    mockDb.rows = [makeRow(1, { status: 'private' })];
    await expect(getPublicStockists()).resolves.toEqual([]);
  });
});
