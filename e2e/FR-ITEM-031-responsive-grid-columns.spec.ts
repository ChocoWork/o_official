import { expect, test, type Page } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-276: ホーム ITEM セクションと /item 一覧のグリッドを LOOK と同じ考え方で
// レスポンシブ化する（2 / md 3 / 2xl 4 列）。フィルターのサイドバーが現れる
// lg、およびサイドバーが広がる xl では列数を増やさないため、切り替わり目で
// カードが極端に小さくならない。

async function gridColumnCount(page: Page): Promise<number> {
  const card = page.locator('[data-testid="item-card-link"]').first();
  await expect(card).toBeVisible();
  return card.evaluate((el) => {
    const grid = el.parentElement as HTMLElement;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean)
      .length;
  });
}

async function firstCardWidth(page: Page): Promise<number> {
  const card = page.locator('[data-testid="item-card-link"]').first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  if (!box) {
    throw new Error('ITEM カードの矩形を取得できませんでした');
  }
  return box.width;
}

test.describe('FR-ITEM-031 ITEM グリッドのレスポンシブ列数', () => {
  test('FREQ-276-AC-01: lg の切り替わり目でカード幅が 30% 以上縮まない', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1023, height: 900 });
    await gotoItemList(page);
    const beforeWidth = await firstCardWidth(page);

    await page.setViewportSize({ width: 1024, height: 900 });
    const afterWidth = await firstCardWidth(page);

    expect(afterWidth).toBeGreaterThan(beforeWidth * 0.7);
  });

  for (const width of [1024, 1280, 1536, 1920]) {
    test(`FREQ-276-AC-02: ${width}px でカード幅が 200px 以上`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoItemList(page);

      expect(await firstCardWidth(page)).toBeGreaterThanOrEqual(200);
    });
  }

  for (const { name, width, columns } of [
    { name: 'mobile', width: 390, columns: 2 },
    { name: 'tablet', width: 768, columns: 3 },
    { name: 'desktop', width: 1280, columns: 3 },
  ] as const) {
    test(`FREQ-276-AC-04: ${name}(${width}px) でホームと一覧の列数が一致し ${columns} 列`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });

      await gotoItemList(page);
      expect(await gridColumnCount(page)).toBe(columns);

      await page.goto('/');
      const home = page.locator('#items [data-testid="item-card-link"]').first();
      await expect(home).toBeVisible();
      const homeColumns = await home.evaluate((el) => {
        const grid = el.parentElement as HTMLElement;
        return getComputedStyle(grid)
          .gridTemplateColumns.split(' ')
          .filter(Boolean).length;
      });
      expect(homeColumns).toBe(columns);
    });
  }

  // FREQ-276-AC-03: ホームの表示件数は列数に合わせて 2xl 未満 6 / 2xl 8。
  // 公開 ITEM の総数が表示上限に満たない場合もあるため「上限以下」で検証する。
  for (const { name, width, limit } of [
    { name: 'mobile', width: 390, limit: 6 },
    { name: 'tablet', width: 768, limit: 6 },
    { name: 'desktop', width: 1280, limit: 6 },
    { name: 'wide', width: 1536, limit: 8 },
  ] as const) {
    test(`FREQ-276-AC-03: ${name}(${width}px) のホーム ITEM 表示は最大 ${limit} 件`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const scope = page.locator('#items');
      const domCount = await scope
        .locator('[data-testid="item-card-link"]')
        .count();
      const visibleCount = await scope
        .locator('[data-testid="item-card-link"]:visible')
        .count();

      expect(visibleCount).toBe(Math.min(domCount, limit));
    });
  }
});
