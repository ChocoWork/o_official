import { test, expect } from '@playwright/test';

/**
 * FR-HOME-002 Home page section rendering verification
 * Checks that the home page renders the ITEM, LOOK, NEWS, ABOUT sections correctly.
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('FR-HOME-002 home page sections', () => {
  for (const vp of viewports) {
    test(`renders correctly on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      // Wait for main content to be visible
      await expect(page.locator('main')).toBeVisible();

      // Full-page screenshot for visual inspection
      await page.screenshot({
        path: `test-results/home-${vp.name}-${vp.width}w.png`,
        fullPage: true,
      });

      // Section headings should be visible
      const sectionTitles = ['ITEMS', 'LOOK', 'NEWS', 'ABOUT'];
      for (const title of sectionTitles) {
        const heading = page.locator(`h2:has-text("${title}")`).first();
        await expect(heading).toBeVisible();
      }

      // ABOUT section content should be visible
      await expect(page.locator('#about')).toBeVisible();

      // Hero main image should be present
      const heroSection = page.locator('section').first();
      await expect(heroSection).toBeVisible();
    });
  }
});
