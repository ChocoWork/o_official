import { expect, test } from '@playwright/test';
import { gotoItemList, itemCards } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-001 公開済み商品一覧', () => {
  test('公開済み商品が一覧表示される', async ({ page }) => {
    await gotoItemList(page);
    await expect(itemCards(page).first()).toBeVisible();
    await expect(itemCards(page)).toHaveCount(await itemCards(page).count());
  });
});
