import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-004 レスポンシブストーリーレイアウト', () => {
  test('モバイル・デスクトップで画像とテキストを表示できる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/about');
    await expect(page.locator('img').first()).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/about');
    await expect(page.locator('img').nth(1)).toBeVisible();
  });
});
