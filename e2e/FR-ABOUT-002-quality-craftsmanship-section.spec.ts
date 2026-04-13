import { expect, test } from '@playwright/test';

test.describe('FR-ABOUT-002 Quality & Craftsmanship', () => {
  test('Quality & Craftsmanship セクションを表示する', async ({ page }) => {
    await page.goto('/about');

    await expect(page.getByRole('heading', { name: 'Quality & Craftsmanship' })).toBeVisible();
    await expect(page.getByText('こだわりの素材と、職人による丁寧な縫製')).toBeVisible();
  });
});
