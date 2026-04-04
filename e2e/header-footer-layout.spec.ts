import { test, expect } from '@playwright/test';

/**
 * Header and Footer responsive layout verification.
 * Captures screenshots at mobile, tablet, and desktop viewports.
 */

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

test.describe('Header and Footer layout', () => {
  for (const vp of viewports) {
    test(`header and footer render correctly on ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');

      const header = page.locator('header').first();
      await expect(header).toBeVisible();

      const footer = page.locator('footer').first();
      await expect(footer).toBeVisible();

      // Header height should be reasonable
      const headerBox = await header.boundingBox();
      expect(headerBox).not.toBeNull();
      if (headerBox) {
        expect(headerBox.height).toBeGreaterThan(40);
        // Mobile: ~60px, Tablet: ~68px, Desktop: ~78px (none should exceed 120px)
        expect(headerBox.height).toBeLessThan(120);
      }

      // Scroll to footer visibility
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeVisible();

      // Screenshot of just the header (top of page)
      await page.screenshot({
        path: `test-results/header-${vp.name}-${vp.width}w.png`,
        clip: { x: 0, y: 0, width: vp.width, height: Math.min(160, vp.height) },
      });

      // Screenshot of footer
      const footerBox = await footer.boundingBox();
      if (footerBox) {
        await page.screenshot({
          path: `test-results/footer-${vp.name}-${vp.width}w.png`,
          clip: {
            x: 0,
            y: Math.max(0, footerBox.y - 10),
            width: vp.width,
            height: footerBox.height + 20,
          },
        });
      }
    });
  }

  test('header contains brand name and nav icons on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    const header = page.locator('header').first();
    await expect(header.locator('h1')).toBeVisible();

    // Desktop nav links should be visible
    const nav = header.locator('nav');
    await expect(nav).toBeVisible();
  });

  test('footer contains brand name, nav links, and social icons', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    const footer = page.locator('footer').first();
    await footer.scrollIntoViewIfNeeded();

    // Brand name
    await expect(footer.locator('h3').first()).toBeVisible();

    // Nav section titles (SHOP, INFORMATION, FOLLOW US)
    const sectionTitles = footer.locator('h4');
    expect(await sectionTitles.count()).toBeGreaterThanOrEqual(3);

    // Social icons
    await expect(footer.locator('.ri-instagram-line')).toBeVisible();
  });
});
