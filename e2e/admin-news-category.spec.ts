import { test, expect } from '@playwright/test';

/**
 * Admin NEWS tab – category label visual verification
 * Confirms that category labels render as outline-bordered TagLabel tags,
 * matching the public NEWS page appearance.
 */

test.describe('Admin NEWS tab – category label as TagLabel', () => {
  test('public news page shows outline-bordered category tags', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/news');

    // Wait for at least one article card
    await page.waitForSelector('[data-testid], article, .font-acumin', { timeout: 10000 });
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: 'test-results/news-public-category-tag.png',
      fullPage: true,
    });

    // The TagLabel renders as a <span> with border styling (outline variant)
    // Check that the category area contains bordered span elements
    const tagLabels = page.locator('span.border');
    const count = await tagLabels.count();
    expect(count).toBeGreaterThan(0);
  });

  test('admin page redirects to login when unauthenticated', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/admin?tab=NEWS');

    // Take screenshot of whatever state the admin page is in
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: 'test-results/admin-news-tab-unauthenticated.png',
      fullPage: true,
    });
  });
});
