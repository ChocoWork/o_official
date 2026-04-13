import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-002 画像カルーセル', () => {
  test('デスクトップではメイン画像とサムネイルが表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // デスクトップ: 横スクロールカルーセルは非表示、通常画像が表示される
    const desktopImage = page.locator('.hidden.md\\:flex').first();
    await expect(desktopImage).toBeVisible();
  });

  test('モバイルでは横スクロールカルーセルが表示される', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    const item = await fetchFirstItemViaApi(page);
    if (!item) {
      await context.close();
      return;
    }

    await page.goto(`/item/${item.id}`);
    await page.waitForLoadState('networkidle');

    // モバイル: 横スクロールカルーセルが表示される
    const carousel = page.locator('.md\\:hidden').first();
    await expect(carousel).toBeVisible();

    await context.close();
  });

  test('サムネイルをクリックするとメイン画像が切り替わる', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // サムネイルが複数ある場合のみテスト
    const thumbnails = page.locator('.hidden.md\\:flex button[aria-label]');
    const count = await thumbnails.count();
    if (count < 2) {
      test.skip(true, 'サムネイルが1枚以下のためスキップ');
      return;
    }

    await thumbnails.nth(1).click();
    // リング状のアクティブスタイルが2枚目に適用される
    await expect(thumbnails.nth(1)).toHaveClass(/ring-2/);
  });
});
