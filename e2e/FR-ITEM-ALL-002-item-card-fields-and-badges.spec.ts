import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-002 商品カード表示', () => {
  test('カードにカテゴリ・商品名・価格・サムネイルが表示される', async ({ page }) => {
    await gotoItemList(page);

    const firstCard = page.locator('[data-testid="item-card"]').first();
    await expect(firstCard).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-category"]')).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-name"]')).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-price"]')).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-image"]')).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-badges"]')).toHaveCount(0);
  });
});
