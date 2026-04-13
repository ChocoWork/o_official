import { expect, test } from '@playwright/test';

test.describe('FR-STOCKIST-005 metadata', () => {
  test('STOCKISTページにtitle/descriptionを設定する', async ({ page }) => {
    await page.goto('/stockist');

    await expect(page).toHaveTitle(/STOCKIST|Le Fil des Heures/i);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
  });
});
