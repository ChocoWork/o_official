import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-001 クライアントサイドデータ取得', () => {
  test('商品詳細ページに遷移すると商品名と価格が表示される', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);

    await expect(page.locator('h2').first()).toBeVisible();
    await expect(page.getByText(/¥[\d,]+/).first()).toBeVisible();
  });

  test('存在しないIDにアクセスするとエラーメッセージを表示する', async ({ page }) => {
    await page.goto('/item/9999999999');

    await expect(page.getByRole('button', { name: /BACK TO ITEMS/i })).toBeVisible();
  });
});
