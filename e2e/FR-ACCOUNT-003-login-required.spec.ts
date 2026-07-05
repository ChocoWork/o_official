import { test, expect } from '@playwright/test';

test.describe('FR-ACCOUNT-003 login required handling', () => {
  test('shows a login guide when the user is not authenticated', async ({ page }) => {
    await page.goto('/account');

    await expect(page.getByRole('heading', { name: 'ACCOUNT' })).toBeVisible();
    await expect(page.getByText('会員情報の確認には、ログインが必要です。')).toBeVisible();
    await expect(
      page.locator('#main-content').getByRole('link', { name: 'ログイン' }),
    ).toHaveAttribute('href', '/login');
  });
});