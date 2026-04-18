import { test, expect } from '@playwright/test';

test.describe('FR-ACCOUNT-003 login required handling', () => {
  test('shows a login guide when the user is not authenticated', async ({ page }) => {
    await page.goto('/account');

    await expect(page.getByRole('heading', { name: '会員情報' })).toBeVisible();
    await expect(page.getByText('会員情報を確認するにはログインが必要です')).toBeVisible();
    await expect(page.getByRole('link', { name: 'ログイン' })).toBeVisible();
  });
});