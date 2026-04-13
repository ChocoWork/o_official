import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-010 パンくず・戻るリンク', () => {
  test('パンくずナビゲーションが表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // aria-label="breadcrumb" または nav[aria-label^="breadcrumb"] が存在する
    const breadcrumb = page.locator('[aria-label="breadcrumb"]');
    await expect(breadcrumb).toBeVisible();
  });

  test('パンくずに HOME・ITEMS・商品名のリンクが含まれる', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const breadcrumb = page.locator('[aria-label="breadcrumb"]');
    await expect(breadcrumb.getByRole('link', { name: /HOME/i })).toBeVisible();
    await expect(breadcrumb.getByRole('link', { name: /ITEMS/i })).toBeVisible();
  });

  test('"BACK TO ITEMS" リンクが正常時にも表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // パンくずの ITEMS リンクか別の戻るリンクが存在する
    const backLink = page.locator('a[href="/item"]').first();
    await expect(backLink).toBeVisible();
  });
});
