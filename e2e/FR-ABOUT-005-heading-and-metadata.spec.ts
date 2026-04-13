import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-005 見出し階層とmetadata', () => {
  test('h1 を持ち title/description メタを設定する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/ABOUT|Le Fil des Heures/i);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
  });
});
