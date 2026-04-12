import { test, expect } from '@playwright/test';

test.describe('NFR-HOME-002 WCAG contrast and accessibility', () => {
  test('hero text has a high-contrast white color and gradient overlay', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const heroTextColor = await page.locator('section.relative h1:has-text("Le Fil des Heures")').evaluate((el) => {
      return window.getComputedStyle(el).color;
    });
    expect(heroTextColor).toBe('rgb(255, 255, 255)');

    const heroOverlay = await page.locator('section.relative div.bg-gradient-to-b').first();
    await expect(heroOverlay).toBeVisible();
  });
});
