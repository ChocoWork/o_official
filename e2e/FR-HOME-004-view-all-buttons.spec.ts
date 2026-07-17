import { test, expect } from '@playwright/test';

// FREQ-126〜128: VIEW ALL 導線は各セクション見出し右側のリンクに統一された。
test.describe('FR-HOME-004 home CTA buttons', () => {
  test('home sections include VIEW ALL links for item, lookbook, and news', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#items a[href="/item"]:has-text("VIEW ALL")')).toBeVisible();
    await expect(page.locator('#look a[href="/look"]:has-text("VIEW ALL")')).toBeVisible();
    await expect(page.locator('#news a[href="/news"]:has-text("VIEW ALL")')).toBeVisible();
  });
});
