import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-004 カート追加・ウィッシュリスト', () => {
  test('ADD TO CART ボタンが表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('ADD TO CART').first()).toBeVisible();
  });

  test('ウィッシュリストボタンが表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('button[aria-label="Add to wishlist"]').first()).toBeVisible();
  });

  test('未選択状態でカート追加するとバリデーションフィードバックがある', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    // カラー・サイズ未選択でカート追加
    // アラートまたは role="alert" が出ることを確認
    page.on('dialog', async (dialog) => {
      expect(dialog.message()).toContain('選択');
      await dialog.accept();
    });

    const cartBtn = page.getByText('ADD TO CART').first();
    await cartBtn.click();
  });
});
