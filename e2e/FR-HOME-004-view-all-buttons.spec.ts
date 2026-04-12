import { test, expect } from '@playwright/test';

test.describe('FR-HOME-004 home CTA buttons', () => {
  test('home sections include VIEW ALL buttons for item, lookbook, and news', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#items a:has-text("VIEW ALL ITEMS")')).toBeVisible();
    await expect(page.locator('#look a:has-text("VIEW LOOKBOOK")')).toBeVisible();
    await expect(page.locator('#news a:has-text("VIEW ALL NEWS")')).toBeVisible();
  });
});
