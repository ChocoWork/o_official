import { test, expect } from '@playwright/test';

test.describe('FR-HOME-007 hero image preload', () => {
  test('preloads hero image for LCP optimization', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const preload = page.locator('head link[rel="preload"][as="image"][href*="mainphoto.png"]');
    await expect(preload).toHaveCount(1);
  });
});
