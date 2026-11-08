import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

test.describe('FR-ITEM-ALL-002 商品カード表示', () => {
  // 2026-11-07 改定: 商品カードはカテゴリを表示しない（商品名・価格・サムネイルのみ）
  test('カードに商品名・価格・サムネイルが表示され、カテゴリは表示されない', async ({ page }) => {
    await gotoItemList(page);

    const firstCard = page.locator('[data-testid="item-card"]').first();
    await expect(firstCard).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-category"]')).toHaveCount(0);
    await expect(firstCard.locator('[data-testid="item-name"]')).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-price"]')).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-image"]').first()).toBeVisible();
    await expect(firstCard.locator('[data-testid="item-badges"]')).toHaveCount(0);
  });
});
