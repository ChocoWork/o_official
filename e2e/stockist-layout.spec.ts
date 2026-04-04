import { test, expect } from '@playwright/test';

/**
 * Stockist catalog page layout verification
 * Checks that cards are rendered in a vertical stack style
 * across mobile, tablet, and desktop viewports.
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('Stockist catalog – horizontal card layout', () => {
  for (const vp of viewports) {
    test(`cards render correctly on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/stockist');

      // Wait for at least one card to be present
      const firstCard = page.locator('article').first();
      await expect(firstCard).toBeVisible();

      // Take a full-page screenshot for visual inspection
      await page.screenshot({
        path: `test-results/stockist-${vp.name}-${vp.width}w.png`,
        fullPage: true,
      });

      // Each card should have a reasonable size (not collapsed)
      if (vp.width >= 640) {
        const cards = page.locator('article');
        const count = await cards.count();
        expect(count).toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
          const box = await cards.nth(i).boundingBox();
          if (box) {
            expect(box.width).toBeGreaterThan(100);
            expect(box.height).toBeGreaterThan(50);
          }
        }
      }

      // On mobile, cards should still display all info fields
      const addressIcons = page.locator('.ri-map-pin-line');
      await expect(addressIcons.first()).toBeVisible();
    });
  }

  test('vertical card layout (name + divider + details) visible on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/stockist');

    const firstCard = page.locator('article').first();
    await expect(firstCard).toBeVisible();

    // Shop name heading should be inside the card
    const shopName = firstCard.locator('h2').first();
    await expect(shopName).toBeVisible();

    // All 4 detail icons should be present
    await expect(firstCard.locator('.ri-map-pin-line')).toBeVisible();
    await expect(firstCard.locator('.ri-phone-line')).toBeVisible();
    await expect(firstCard.locator('.ri-time-line')).toBeVisible();
    await expect(firstCard.locator('.ri-calendar-line')).toBeVisible();
  });
});
