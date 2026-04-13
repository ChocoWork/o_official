import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-003 Our Values 3カラム', () => {
  test('Timeless / Sustainable / Thoughtful を表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: 'Our Values' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Timeless' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sustainable' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Thoughtful' })).toBeVisible();
  });
});
