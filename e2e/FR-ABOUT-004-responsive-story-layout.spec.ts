import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844, direction: 'column' },
  { name: 'tablet', width: 768, height: 1024, direction: 'row' },
  { name: 'desktop', width: 1280, height: 900, direction: 'row' },
] as const;

test.describe('FR-ABOUT-004 COLLECTION と CTA', () => {
  for (const viewport of viewports) {
    test(`${viewport.name}: COLLECTION と CTA をレスポンシブ表示する`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');

      await expect(page.getByRole('heading', { name: 'COLLECTION / 商品設計思想' })).toBeVisible();
      const collectionLink = page.getByRole('link', { name: 'VIEW COLLECTION' });
      const lookbookLink = page.getByRole('link', { name: 'VIEW LOOKBOOK' });
      await expect(collectionLink).toHaveAttribute('href', '/item');
      await expect(lookbookLink).toHaveAttribute('href', '/look');

      const ctaContainer = collectionLink.locator('..');
      await expect(ctaContainer).toHaveCSS('flex-direction', viewport.direction);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    });
  }
});
