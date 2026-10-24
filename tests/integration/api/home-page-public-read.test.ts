/**
 * ホームの公開の読みの結合テスト。
 *
 * 頁が呼ぶ取得の関数（商品・LOOK・NEWS・取扱店）を本物のまま通し、DB の client だけを
 * 問い合わせの組み立てを記録する偽物に差し替える。どの client で、どの表を、公開済みに
 * 絞って読んだかを見る。
 */

type QueryResult = { data: unknown; error: unknown; count?: number | null };
type ClientKind = 'session' | 'public' | 'service';
type Call = [string, ...unknown[]];
type Recorded = { kind: ClientKind; table: string; calls: Call[] };

const recorded: Recorded[] = [];
const created: ClientKind[] = [];
// 表ごとに、行を読む結果(rows)・総数を数える結果(count)・LOOK の関連商品を読む結果(linked)を持つ
type TableResults = { rows?: QueryResult; count?: QueryResult; linked?: QueryResult };
let results: Record<string, TableResults> = {};
const signedBy: ClientKind[] = [];

function pickResult(table: string, calls: Call[]): QueryResult {
  const entry = results[table] ?? {};
  const select = calls.find((call) => call[0] === 'select');
  const isCount = (select?.[2] as { head?: boolean } | undefined)?.head === true;
  if (isCount) return entry.count ?? { data: null, error: null, count: 0 };
  const readsLinkedItems = calls.some((call) => call[0] === 'in' && call[1] === 'id');
  if (table === 'items' && readsLinkedItems) {
    return entry.linked ?? { data: [], error: null };
  }
  return entry.rows ?? { data: [], error: null };
}

function makeClient(kind: ClientKind) {
  created.push(kind);
  const client = {
    __kind: kind,
    from: (table: string) => {
      const record: Recorded = { kind, table, calls: [] };
      recorded.push(record);
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
        query[method] = (...args: unknown[]) => {
          record.calls.push([method, ...args]);
          return query;
        };
      }
      query.then = (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(pickResult(table, record.calls)).then(resolve, reject);
      return query;
    },
  };
  return client;
}

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => makeClient('session')),
  createPublicClient: jest.fn(async () => makeClient('public')),
  createServiceRoleClient: jest.fn(async () => makeClient('service')),
}));

// 画像の署名は第1引数の client を記録して、そのまま返す
jest.mock('@/lib/storage/item-images', () => ({
  signItemImageFields: jest.fn(async (client: { __kind: ClientKind }, item: unknown) => {
    signedBy.push(client.__kind);
    return item;
  }),
  signItemImageUrl: jest.fn(async (client: { __kind: ClientKind }, url: string) => {
    signedBy.push(client.__kind);
    return url;
  }),
}));
jest.mock('@/lib/storage/look-images', () => ({
  signLookImageUrls: jest.fn(async (client: { __kind: ClientKind }, urls: string[]) => {
    signedBy.push(client.__kind);
    return urls;
  }),
}));
jest.mock('@/lib/storage/news-images', () => ({
  signNewsImageFields: jest.fn(async (client: { __kind: ClientKind }, article: unknown) => {
    signedBy.push(client.__kind);
    return article;
  }),
}));

// 頁が並べる部品は取得の結果を受け取るだけなので、中身を描かずに渡された値を見る
jest.mock('@/components/animations/TextReveal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/features/look/components/PublicLookGrid', () => ({ PublicLookGrid: () => null }));
jest.mock('@/features/items/components/PublicItemGrid', () => ({ PublicItemGrid: () => null }));
jest.mock('@/features/news/components/PublicNewsGrid', () => ({ PublicNewsGrid: () => null }));
jest.mock('@/features/stockist/components/PublicStockistGrid', () => ({
  PublicStockistGrid: () => null,
}));
jest.mock('@/features/search/components/SearchHomePreview', () => ({ SearchHomePreview: () => null }));
jest.mock('@/components/ui/SectionTitle/SectionTitle', () => ({ SectionTitle: () => null }));
jest.mock('@/components/ui/Button/Button', () => ({ Button: () => null }));
jest.mock('next/image', () => ({ __esModule: true, default: () => null }));
jest.mock('react-dom', () => {
  const actual = jest.requireActual('react-dom');
  return { ...actual, __esModule: true, default: { ...actual, preload: jest.fn() } };
});

import type { ReactElement } from 'react';
import Home from '@/app/page';
import { getPublishedItems, getPublishedItemsCount } from '@/lib/items/public';
import { getPublishedLooks, getPublishedLooksCount } from '@/lib/look/server';
import { getPublishedNews, getPublishedNewsCount } from '@/features/news/services/public';
import { getHomePublicStockists } from '@/features/stockist/services/public';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';

const ITEM_ROW = { id: 11, name: 'Coat', price: 12000 };
const LOOK_ROW = {
  id: 21,
  season_year: 2026,
  season_type: 'AW',
  theme: 'Theme',
  theme_description: 'Desc',
  image_urls: ['a.png'],
  created_at: '2026-10-01T00:00:00Z',
};
const NEWS_ROW = { id: 31, title: 'Notice', category: 'NEWS' };
const STOCKIST_ROW = { id: 41, name: 'Shop', address: 'Tokyo', phone: '', time: '', holiday: '' };

function isPublishedOnly(record: Recorded) {
  return record.calls.some(
    (call) => call[0] === 'eq' && call[1] === 'status' && call[2] === 'published',
  );
}

function reads(table: string, kind?: ClientKind) {
  return recorded.filter((r) => r.table === table && (kind === undefined || r.kind === kind));
}

function findElement(root: unknown, type: unknown): ReactElement | null {
  if (!root || typeof root !== 'object') return null;
  if (Array.isArray(root)) {
    for (const child of root) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const element = root as ReactElement<{ children?: unknown }>;
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

function seedAll() {
  results = {
    items: {
      rows: { data: [ITEM_ROW], error: null },
      count: { data: null, error: null, count: 12 },
      linked: {
        data: [{ id: 5, category: 'TOPS', name: 'Linked', price: 9000, image_url: 'l.png' }],
        error: null,
      },
    },
    item_variants: { rows: { data: [], error: null } },
    looks: {
      rows: { data: [LOOK_ROW], error: null },
      count: { data: null, error: null, count: 9 },
    },
    look_items: { rows: { data: [{ look_id: 21, item_id: 5 }], error: null } },
    news_articles: {
      rows: { data: [NEWS_ROW], error: null },
      count: { data: null, error: null, count: 7 },
    },
    stockists: { rows: { data: [STOCKIST_ROW], error: null } },
  };
}

describe('ARC-HOME-002 ホームの公開の読み', () => {
  beforeEach(() => {
    recorded.length = 0;
    created.length = 0;
    signedBy.length = 0;
    results = {};
  });

  describe('頁が呼ぶ取得の関数', () => {
    it('ARC-HOME-002 頁は商品10件・LOOK 8件・NEWS 6件・取扱店6件と3つの総数を取り、格子に渡す', async () => {
      seedAll();

      const tree = await Home();

      const itemGrid = findElement(tree, PublicItemGrid);
      const lookGrid = findElement(tree, PublicLookGrid);
      const newsGrid = findElement(tree, PublicNewsGrid);
      const stockistGrid = findElement(tree, PublicStockistGrid);
      expect(itemGrid?.props).toMatchObject({ variant: 'home', totalCount: 12 });
      expect(lookGrid?.props).toMatchObject({ variant: 'home', totalCount: 9 });
      expect(newsGrid?.props).toMatchObject({ variant: 'home', totalCount: 7 });
      expect(stockistGrid?.props).toMatchObject({ variant: 'home' });
      expect((itemGrid?.props as { items: unknown[] }).items).toHaveLength(1);
      expect((lookGrid?.props as { looks: unknown[] }).looks).toHaveLength(1);
      expect((newsGrid?.props as { articles: unknown[] }).articles).toHaveLength(1);
      expect((stockistGrid?.props as { stockists: unknown[] }).stockists).toHaveLength(1);

      const limitOf = (table: string, kind: ClientKind) =>
        reads(table, kind)
          .flatMap((r) => r.calls)
          .find((call) => call[0] === 'limit')?.[1];
      expect(limitOf('items', 'session')).toBe(10);
      expect(limitOf('looks', 'public')).toBe(8);
      expect(limitOf('news_articles', 'public')).toBe(6);
      expect(limitOf('stockists', 'session')).toBe(6);
    });

    it('ARC-HOME-002 頁が読む行の表は、行を読む問い合わせの全部が公開済みに絞られている', async () => {
      seedAll();

      await Home();

      const rowReads = recorded.filter((r) =>
        ['items', 'looks', 'news_articles', 'stockists'].includes(r.table),
      );
      expect(new Set(rowReads.map((r) => r.table))).toEqual(
        new Set(['items', 'looks', 'news_articles', 'stockists']),
      );
      for (const record of rowReads) {
        expect(isPublishedOnly(record)).toBe(true);
      }
    });
  });

  describe('商品10件・商品の総数', () => {
    it('ARC-HOME-002 行も総数も閲覧者の session の client で読み、公開済みに絞る', async () => {
      seedAll();

      await getPublishedItems(10);
      await getPublishedItemsCount();

      const itemReads = reads('items');
      expect(itemReads.map((r) => r.kind)).toEqual(['session', 'session']);
      expect(itemReads.every(isPublishedOnly)).toBe(true);
      const countRead = itemReads[1];
      expect(countRead.calls).toContainEqual(['select', 'id', { count: 'exact', head: true }]);
    });

    it('ARC-HOME-002 画像の署名と在庫の読みだけ service role で行い、在庫も公開中の商品に絞り直す', async () => {
      seedAll();

      const items = await getPublishedItems(10);

      expect(signedBy).toEqual(['service']);
      const variantRead = reads('item_variants');
      expect(variantRead).toHaveLength(1);
      expect(variantRead[0].kind).toBe('service');
      expect(variantRead[0].calls).toContainEqual(['eq', 'items.status', 'published']);
      expect(variantRead[0].calls).toContainEqual(['in', 'item_id', [11]]);
      // 在庫の行が無い商品は、実数を渡さず受注生産の真偽だけを持つ
      expect(items).toEqual([{ ...ITEM_ROW, madeToOrder: true }]);
    });

  });

  describe('LOOK 8件・LOOK の総数', () => {
    it('ARC-HOME-002 行も総数も公開の client で読み、公開済みに絞る', async () => {
      seedAll();

      await getPublishedLooks(8);
      await getPublishedLooksCount();

      const lookReads = reads('looks');
      expect(lookReads.map((r) => r.kind)).toEqual(['public', 'public']);
      expect(lookReads.every(isPublishedOnly)).toBe(true);
    });

    it('ARC-HOME-002 LOOK の関連商品も公開済みに絞り、画像の署名だけ service role で行う', async () => {
      seedAll();

      const looks = await getPublishedLooks(8);

      const lookItemReads = reads('look_items');
      expect(lookItemReads).toHaveLength(1);
      expect(lookItemReads[0].kind).toBe('public');
      const linkedItemRead = reads('items')[0];
      expect(linkedItemRead.kind).toBe('public');
      expect(isPublishedOnly(linkedItemRead)).toBe(true);
      expect(signedBy.every((kind) => kind === 'service')).toBe(true);
      expect(signedBy.length).toBeGreaterThan(0);
      expect(looks[0].linkedItems).toEqual([
        { category: 'TOPS', id: 5, name: 'Linked', price: 9000, imageUrl: 'l.png' },
      ]);
    });

  });

  describe('NEWS 6件・NEWS の総数', () => {
    it('ARC-HOME-002 行も総数も公開の client で読み、公開済みに絞る', async () => {
      seedAll();

      await getPublishedNews({ limit: 6 });
      await getPublishedNewsCount();

      const newsReads = reads('news_articles');
      expect(newsReads.map((r) => r.kind)).toEqual(['public', 'public']);
      expect(newsReads.every(isPublishedOnly)).toBe(true);
    });

    it('ARC-HOME-002 service role は DB を読まず、画像の署名だけに使う', async () => {
      seedAll();

      await getPublishedNews({ limit: 6 });

      expect(reads('news_articles', 'service')).toHaveLength(0);
      expect(created).toContain('service');
      expect(signedBy).toEqual(['service']);
    });

  });

  describe('取扱店6件', () => {
    it('ARC-HOME-002 閲覧者の session の client で公開済みに絞って読み、service role を作らない', async () => {
      seedAll();

      const stockists = await getHomePublicStockists();

      const stockistReads = reads('stockists');
      expect(stockistReads).toHaveLength(1);
      expect(stockistReads[0].kind).toBe('session');
      expect(isPublishedOnly(stockistReads[0])).toBe(true);
      expect(created).toEqual(['session']);
      expect(stockists).toEqual([
        { id: 41, name: 'Shop', address: 'Tokyo', phone: '', time: '', holiday: '' },
      ]);
    });

  });
});
