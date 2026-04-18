import { test, expect } from '@playwright/test';

test.describe('FR-LOGIN-003 password reset link', () => {
  test('navigates to the password reset page from the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'パスワードを忘れた方はこちら' }).click();
    await page.waitForURL('**/auth/password-reset');
    await expect(page.getByRole('heading', { name: /パスワード再設定/ })).toBeVisible();
  });
});