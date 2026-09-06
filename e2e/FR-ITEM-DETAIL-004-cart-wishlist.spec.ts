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

    // FREQ-345: 選択肢のある軸が未選択の間は ADD TO CART を押せない
    const cartBtn = page
      .getByTestId('item-actions-main')
      .getByRole('button', { name: /ADD TO CART/ });
    const unselected = page
      .getByTestId('item-spec-table')
      .locator('button[aria-pressed="false"]');
    if ((await unselected.count()) === 0) {
      test.skip(true, '選択肢が各1つのため未選択状態にならない');
      return;
    }
    await expect(cartBtn).toBeDisabled();
  });
});
