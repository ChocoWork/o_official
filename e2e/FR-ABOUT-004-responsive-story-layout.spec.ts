import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-ABOUT-004 COLLECTION と CTA', () => {
  for (const viewport of viewports) {
    test(`FR-ABOUT-004-AC-01 ${viewport.name}: COLLECTION と CTA をレスポンシブ表示する`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/about');

      await expect(page.getByRole('heading', { name: 'COLLECTION / 商品設計思想' })).toBeVisible();
      const collectionLink = page.getByRole('link', { name: 'VIEW COLLECTION' });
      const lookbookLink = page.getByRole('link', { name: 'VIEW LOOKBOOK' });
      await expect(collectionLink).toHaveAttribute('href', '/item');
      await expect(lookbookLink).toHaveAttribute('href', '/look');
    });
  }
});
