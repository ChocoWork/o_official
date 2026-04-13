import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-006 レスポンシブレイアウト', () => {
  test('デスクトップではカルーセルが非表示でメイン画像が表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // デスクトップ（デフォルト）: md:hidden 要素は非表示
    const mobileCarousel = page.locator('.md\\:hidden').first();
    await expect(mobileCarousel).toBeHidden();

    // デスクトップ画像エリアが表示される
    const desktopImageArea = page.locator('.hidden.md\\:flex').first();
    await expect(desktopImageArea).toBeVisible();
  });

  test('モバイルでは固定フッターボタンエリアが存在する', async ({ browser }) => {
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

    // モバイル固定フッターボタン存在確認 (fixed bottom-0)
    const fixedFooter = page.locator('.fixed.bottom-0');
    await expect(fixedFooter).toBeAttached();

    await context.close();
  });
});
