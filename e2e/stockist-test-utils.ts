/**
 * 取扱店（STOCKIST）の公開の画面の E2E の道具。FR-STOCKIST-010〜017 の spec が共有する。
 * - 手元の DB への店の行の足し引き（名前は E2E-STK-<uuid>。必ず finally で消す）
 * - 地方・都道府県の絞り込み（desktop=左の列 / mobile・tablet=引き出し）の開け閉め
 * - 手元の Supabase の見本の店 6 件と、その名前で絞ったカード
 * 管理画面の道具（本物の aal2 のログイン）は stockist-admin-test-utils.ts、管理 API の JWT は admin-session-test-utils.ts。
 */
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { isLocalUrl } from '../scripts/e2e/environment';
import { withLocalDb } from './order-email-test-utils';

export const STOCKIST_VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 800, drawer: false },
] as const;

/** supabase/seed.sql の見本の取扱店（全部公開）。他の試験が足した行に左右されないよう、この名前でカードを絞って数える */
export const SEED_STOCKISTS = [
  { name: 'Aoyama Sample Select', address: '東京都港区南青山0-0-1', prefecture: '東京都' },
  { name: 'Osaka Sample Select', address: '大阪府大阪市中央区0-0-1', prefecture: '大阪府' },
  { name: 'Kyoto Sample Select', address: '京都府京都市中京区0-0-1', prefecture: '京都府' },
  { name: 'Ginza Sample Store', address: '東京都中央区銀座0-0-1', prefecture: '東京都' },
  { name: 'Kobe Sample Store', address: '兵庫県神戸市中央区0-0-1', prefecture: '兵庫県' },
  { name: 'Tokyo Synthetic Flagship', address: '東京都渋谷区0-0-1', prefecture: '東京都' },
] as const;

export const KINKI_PREFECTURES = ['大阪府', '京都府', '兵庫県', '滋賀県', '奈良県', '和歌山県'] as const;

export type StockistType = 'FLAGSHIP STORE' | 'STORE' | 'SELECT SHOP';
export type StockistSeed = {
  name: string;
  status: 'private' | 'published';
  address?: string;
  phone?: string;
  type?: StockistType;
  /** 省略すると連番。ホームの取扱店の節は id の小さい公開の 6 件を出すので、非公開の行をそこへ置く試験は randomLowId() を渡す */
  id?: number;
};

/** 見本の id（1〜6）より小さい id（ホームの取扱店の節の「最初の 6 件」に入る位置）。bigint の列なので負の値も入る */
export function randomLowId(): number {
  return -(Math.floor(Math.random() * 1_000_000_000) + 1);
}

export function stockistTag(): string {
  return `E2E-STK-${randomUUID()}`;
}

/** 手元の Supabase の公開値と service role の鍵が env にあり、手元を指していること */
export function requireLocalSupabaseEnv(): { url: string; anonKey: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !anonKey || !serviceKey || !isLocalUrl(url)) {
    throw new Error('手元の Supabase の公開値と service role の鍵が env に無い（この試験は手元の Supabase だけで流す）');
  }
  return { url, anonKey, serviceKey };
}

export async function insertStockists(seeds: StockistSeed[]): Promise<number[]> {
  return withLocalDb(async (db) => {
    const ids: number[] = [];
    for (const seed of seeds) {
      const values = [seed.type ?? 'STORE', seed.name, seed.address ?? '東京都港区0-0-1', seed.phone ?? '000-0000-0000', seed.status];
      const result =
        seed.id === undefined
          ? await db.query(
              `insert into public.stockists (type, name, address, phone, time, holiday, status)
               values ($1, $2, $3, $4, '11:00-18:00', 'Synthetic schedule', $5)
               returning id`,
              values,
            )
          : await db.query(
              `insert into public.stockists (type, name, address, phone, time, holiday, status, id)
               values ($1, $2, $3, $4, '11:00-18:00', 'Synthetic schedule', $5, $6::bigint)
               returning id`,
              [...values, seed.id],
            );
      ids.push(Number(result.rows[0].id));
    }
    return ids;
  });
}

export async function deleteStockists(ids: number[], names: string[] = []): Promise<void> {
  if (ids.length === 0 && names.length === 0) return;
  await withLocalDb((db) =>
    db.query('delete from public.stockists where id = any($1::bigint[]) or name = any($2::text[])', [ids, names]),
  );
}

/** 行を足して場面を流し、finally で必ず消す（extraNames は場面の中で作られうる行の名前） */
export async function withStockists<T>(
  seeds: StockistSeed[],
  scenario: (ids: number[]) => Promise<T>,
  extraNames: string[] = [],
): Promise<T> {
  const ids = await insertStockists(seeds);
  try {
    return await scenario(ids);
  } finally {
    await deleteStockists(ids, [...seeds.map((seed) => seed.name), ...extraNames]);
  }
}

/** 取扱店のカードのうち、h3 の見出しがその店名のもの（他の試験が足した行を数えに入れない） */
export function stockistCardByName(page: Page, name: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) });
}

/** 絞り込み（desktop=左の列 / mobile・tablet=引き出し）を開き、その範囲を返す */
export async function openFilterScope(page: Page, useDrawer: boolean): Promise<Locator> {
  if (useDrawer) {
    await page.locator('[data-filter-button="floating"]').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }
  const sidebar = page.getByRole('complementary');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

export async function closeDrawer(page: Page, useDrawer: boolean): Promise<void> {
  if (useDrawer) {
    await page.getByRole('dialog').getByLabel('Close filter drawer').click();
  }
}

export async function checkArea(page: Page, useDrawer: boolean, label: string): Promise<void> {
  const scope = await openFilterScope(page, useDrawer);
  await scope.getByText(label, { exact: true }).click();
  await closeDrawer(page, useDrawer);
}

export async function expandRegion(page: Page, useDrawer: boolean, region: string): Promise<void> {
  const scope = await openFilterScope(page, useDrawer);
  await scope.getByRole('button', { name: new RegExp(`${region}の都道府県を展開`) }).click();
  await closeDrawer(page, useDrawer);
}
