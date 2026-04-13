import { expect, test } from '@playwright/test';

test.describe('FR-CONTACT-004 レスポンシブレイアウト', () => {
  test('モバイルとデスクトップでフォームを表示できる', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/contact');
    await expect(page.locator('form')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/contact');
    await expect(page.locator('form')).toBeVisible();
  });
});
