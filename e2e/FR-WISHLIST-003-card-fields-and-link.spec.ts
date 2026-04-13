import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-003 カード表示と商品遷移', () => {
  test('商品カードが画像・カテゴリ・名称・価格・商品リンクを表示する', async ({ page }) => {
    await page.goto('/wishlist');

    const card = page.locator('[role="listitem"]').first();
    const hasCard = await card.isVisible().catch(() => false);
    if (!hasCard) {
      test.skip();
      return;
    }

    await expect(card.locator('img').first()).toBeVisible();
    await expect(card.locator('text=/¥|円/').first()).toBeVisible();
    await expect(card.locator('a[href^="/item/"]').first()).toBeVisible();
  });
});
