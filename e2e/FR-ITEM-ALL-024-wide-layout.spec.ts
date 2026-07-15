import { expect, test, type Page } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-118: NEWS / ITEM / LOOK / STOCKIST の一覧をワイドレイアウト化する
// （コンテナ最大幅 1680px / デスクトップの ITEM グリッド5列）。
// レイアウトは xl 以上（デスクトップ）で有効なため、横1680pxで検証する。

async function contentColumnContainerWidth(page: Page, testId: string): Promise<number> {
  const column = page.locator(`[data-testid="${testId}"]`).first();
  await expect(column).toBeVisible();
  // コンテンツ列 + サイドバーを内包する flex 行（= max-w-[1680px] のコンテナ）の実幅。
  return column.evaluate((el) => {
    const flexRow = el.parentElement as HTMLElement;
    return flexRow.getBoundingClientRect().width;
  });
}

test.describe('FR-ITEM-ALL-024 一覧ページのワイドレイアウト', () => {
  test('FREQ-118-AC-02: 横1680pxで ITEM グリッドが5列で表示される', async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await gotoItemList(page);

    const grid = page.locator('[data-testid="item-card-link"]').first();
    await expect(grid).toBeVisible();

    const columnCount = await grid.evaluate((el) => {
      const gridEl = el.parentElement as HTMLElement;
      const cols = getComputedStyle(gridEl).gridTemplateColumns;
      return cols.split(' ').filter(Boolean).length;
    });
    expect(columnCount).toBe(5);
  });

  test('FREQ-118-AC-01/04: コンテナ最大幅が 1680px（超ワイドでも上限で頭打ち）', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });

    await gotoItemList(page);
    const itemWidth = await contentColumnContainerWidth(page, 'item-content-column');
    expect(itemWidth).toBeLessThanOrEqual(1681);
    expect(itemWidth).toBeGreaterThan(1280); // 旧 max-w-7xl(1280px) より広い

    await page.goto('/news');
    const newsWidth = await contentColumnContainerWidth(page, 'news-content-column');
    expect(newsWidth).toBeLessThanOrEqual(1681);
    expect(newsWidth).toBeGreaterThan(1280);

    await page.goto('/look');
    const lookWidth = await contentColumnContainerWidth(page, 'look-content-column');
    expect(lookWidth).toBeLessThanOrEqual(1681);
    expect(lookWidth).toBeGreaterThan(1280);
  });

  // モバイル（390px）/ タブレット（768px）では単一カラム相当となり、
  // ワイドレイアウトが崩れず横スクロールを生まないことを確認する。
  for (const { name, width } of [
    { name: 'mobile', width: 390 },
    { name: 'tablet', width: 768 },
  ]) {
    test(`${name}(${width}px): 横スクロールが発生しない`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoItemList(page);

      const hasOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(hasOverflow).toBe(false);
    });
  }
});
