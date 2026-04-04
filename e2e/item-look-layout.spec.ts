import { test, expect } from '@playwright/test';

/**
 * Item and Look page typography & layout verification.
 * Checks that product cards and look cards render correctly
 * across mobile, tablet, and desktop viewports.
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

test.describe('Item catalog – typography layout', () => {
  for (const vp of viewports) {
    test(`item cards render on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/item');

      // Wait for item grid to appear
      const firstLink = page.locator('main a').first();
      await expect(firstLink).toBeVisible({ timeout: 10000 });

      await page.screenshot({
        path: `test-results/item-${vp.name}-${vp.width}w.png`,
        fullPage: true,
      });

      // Item name and price should be visible
      const itemName = page.locator('h3').first();
      await expect(itemName).toBeVisible();
    });
  }
});

test.describe('Look catalog – typography layout', () => {
  for (const vp of viewports) {
    test(`look cards render on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/look');

      // Wait for look grid to appear
      const firstLink = page.locator('main a').first();
      await expect(firstLink).toBeVisible({ timeout: 10000 });

      await page.screenshot({
        path: `test-results/look-${vp.name}-${vp.width}w.png`,
        fullPage: true,
      });

      // Look theme text should be visible
      const firstPara = page.locator('main p').first();
      await expect(firstPara).toBeVisible();
    });
  }
});

test.describe('Home page – Item and Look section typography', () => {
  for (const vp of viewports) {
    test(`home sections render on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      // Scroll to items section
      await page.locator('#items').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/home-items-${vp.name}-${vp.width}w.png`,
        fullPage: false,
      });

      // Scroll to look section
      await page.locator('#look').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/home-look-${vp.name}-${vp.width}w.png`,
        fullPage: false,
      });
    });
  }
});
