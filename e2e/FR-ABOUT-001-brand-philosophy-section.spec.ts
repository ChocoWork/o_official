import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-001 Brand Philosophy', () => {
  test('Brand Philosophy セクションを表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: 'Brand Philosophy' })).toBeVisible();
    await expect(page.getByText('Le Fil des Heuresは、「時を紡ぐニュートラルモードな日常着」')).toBeVisible();
  });
});
