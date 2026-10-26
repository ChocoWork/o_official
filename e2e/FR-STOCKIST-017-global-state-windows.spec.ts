/**
 * FR-STOCKIST-017 公開の店を全部巻き込む試験（公開の店が0件・上限を超える件数）
 * 対応: FR-STOCKIST-003-AC-02 / SEC-STOCKIST-018-AC-01
 *
 * 全部の公開の店を一時的に非公開にする・公開の店を 1001 件足す、という変更は、同時に流れる他の試験（取扱店・ホーム・管理画面）の
 * 件数の数えを壊す。そのため playwright.config.ts で、この spec だけを別の project（isolated-global）にし、
 * chromium の project の teardown として、他の全部の試験が終わった後に流す。
 *
 * - 変更の窓を短く保つため、1 つの試験の中で DB を 1 回だけ変え、その窓の中で 3 つの幅を続けて開く（幅ごとに変え直さない）。
 * - 窓の途中で試験が落ちても戻るよう、元に戻す処理を試験の本体の finally と afterEach の両方に置く（繰り返しても害は無い）。
 * - SEC-STOCKIST-018-AC-01 は、公開の取り出しに上限 200 を入れた（2026-10-26）ので、上限を超える店を入れても `/stockist` のカードが 200 以下であることを確かめる（AC の書いた通り）。
 * - ファイルの中は順に 1 本の worker で流す（2 つの試験の窓が重ならないように）。落ちても後ろの試験は流す。
 * JWT が通信記録に残らないよう trace は切る。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { withLocalDb } from './order-email-test-utils';
import { requireLocalSupabaseEnv, STOCKIST_VIEWPORTS as VIEWPORTS, stockistTag as tag } from './stockist-test-utils';

test.use({ trace: 'off' });
test.describe.configure({ mode: 'default', timeout: 180_000 });

const EMPTY_TEXT = '該当する取扱店舗がございません。';
/** 全件を非公開にしている間に待てる最長（これを超えたら窓を閉じて落とす） */
const WINDOW_NAVIGATION_TIMEOUT_MS = 15_000;
/** 要件の文書（SEC-STOCKIST-018）が公開の取り出しの上限として決めた件数（docs/02_Requirements/areas/stockist.md） */
const PUBLIC_FETCH_LIMIT = 200;

// 窓の途中で落ちても戻せるよう、変えたものを module の中に控える
const hiddenIds: number[] = [];
const insertedPrefixes: string[] = [];

async function restoreHidden(): Promise<void> {
  const ids = hiddenIds.splice(0);
  if (ids.length === 0) return;
  await withLocalDb((db) => db.query("update public.stockists set status = 'published' where id = any($1::bigint[])", [ids]));
}

async function deleteInserted(): Promise<void> {
  const prefixes = insertedPrefixes.splice(0);
  for (const prefix of prefixes) {
    await withLocalDb((db) => db.query('delete from public.stockists where name like $1', [`${prefix}-%`]));
  }
}

test.afterEach(async () => {
  await restoreHidden();
  await deleteInserted();
});

function configuredMaxRows(): number {
  const toml = readFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8');
  const match = /^\s*max_rows\s*=\s*(\d+)/m.exec(toml);
  if (!match) throw new Error('supabase/config.toml に max_rows が無い');
  return Number(match[1]);
}

/** 公開の店を max_rows より 1 件多く足す（足した名前の頭は deleteInserted で消す） */
async function insertPublishedOverMaxRows(maxRows: number): Promise<void> {
  const prefix = tag();
  insertedPrefixes.push(prefix);
  await withLocalDb((db) =>
    db.query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       select 'STORE', $1 || '-' || n, '東京都港区0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', 'published'
       from generate_series(1, $2::int) as n`,
      [prefix, maxRows + 1],
    ),
  );
}

test.describe('FR-STOCKIST-017 公開の店が0件・上限超え', () => {
  test('FR-STOCKIST-003-AC-02 公開の店が0件の時、3つの幅のどれでも /stockist が 200 で返り、「該当する取扱店舗がございません。」が出る', async ({ page }) => {
    // 暖機（初回のコンパイルや接続の遅れで、全件を非公開にしている間が延びないように）
    await page.goto('/stockist');
    await expect(page.locator('article').first()).toBeVisible();

    const hidden = await withLocalDb(async (db) => {
      const result = await db.query("update public.stockists set status = 'private' where status = 'published' returning id");
      return result.rows.map((row) => Number(row.id));
    });
    hiddenIds.push(...hidden);
    const observed: Array<{ viewport: string; status: number | null; empty: number; cards: number }> = [];
    try {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const response = await page.goto('/stockist', { waitUntil: 'domcontentloaded', timeout: WINDOW_NAVIGATION_TIMEOUT_MS });
        await expect(page.getByText(EMPTY_TEXT)).toBeVisible({ timeout: WINDOW_NAVIGATION_TIMEOUT_MS });
        observed.push({
          viewport: vp.name,
          status: response?.status() ?? null,
          empty: await page.getByText(EMPTY_TEXT).count(),
          cards: await page.locator('article').count(),
        });
      }
    } finally {
      // 全件を非公開にしている間はここまで。すぐ元に戻す
      await restoreHidden();
    }
    expect(hidden.length, '見本の公開の店が1件以上あった').toBeGreaterThan(0);
    for (const entry of observed) {
      expect(entry.status, `${entry.viewport}: 応答の状態`).toBe(200);
      expect(entry.empty, `${entry.viewport}: 空の文`).toBe(1);
      expect(entry.cards, `${entry.viewport}: カードの数`).toBe(0);
    }
  });

  test('SEC-STOCKIST-018-AC-01 公開の店を上限より多く入れても、anon の select の行の数が max_rows 以下', async ({ request }) => {
    const { url, anonKey } = requireLocalSupabaseEnv();
    const maxRows = configuredMaxRows();
    await insertPublishedOverMaxRows(maxRows);
    try {
      const response = await request.get(`${url}/rest/v1/stockists?select=id`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        failOnStatusCode: false,
      });
      expect(response.status(), 'anon の select の状態').toBe(200);
      const rows = (await response.json()) as unknown[];
      expect(rows.length, `anon の select の行の数（max_rows=${maxRows}）`).toBeLessThanOrEqual(maxRows);
    } finally {
      await deleteInserted();
    }
  });

  test('SEC-STOCKIST-018-AC-01 公開の店を上限より多く入れても、3つの幅のどれでも /stockist のカードの数が公開の取り出しの上限以下', async ({ page }) => {
    await insertPublishedOverMaxRows(configuredMaxRows());
    try {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto('/stockist');
        await expect(page.locator('article').first()).toBeVisible();
        const cardCount = await page.locator('article').count();
        expect(cardCount, `${vp.name}: /stockist のカードの数（公開の取り出しの上限=${PUBLIC_FETCH_LIMIT}）`).toBeLessThanOrEqual(PUBLIC_FETCH_LIMIT);
      }
    } finally {
      await deleteInserted();
    }
  });
});
