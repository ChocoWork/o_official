import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-001 Brand Philosophy', () => {
  test('Brand Philosophy セクションを表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: 'Brand Philosophy / ブランドの思想' })).toBeVisible();
    await expect(page.getByText(/時間を超えて選ばれ続ける服をつくるブランド/)).toBeVisible();
  });
});
