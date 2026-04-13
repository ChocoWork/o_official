import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-001 ページ見出しとクライアント描画', () => {
  test('wishlistページにh1を表示する', async ({ page }) => {
    await page.goto('/wishlist');
    await expect(page.getByRole('heading', { level: 1, name: 'Wishlist' })).toBeVisible();
  });
});
