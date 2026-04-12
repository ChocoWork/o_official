import { test, expect } from '@playwright/test';

test.describe('FR-HOME-001 hero banner', () => {
  test('renders hero section with brand heading and background image', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('section.relative h1:has-text("Le Fil des Heures")')).toBeVisible();
    await expect(page.locator('img[alt="Hero Background"]')).toHaveCount(1);
  });
});
