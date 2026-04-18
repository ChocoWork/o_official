import { test, expect } from '@playwright/test';

test.describe('FR-LOGIN-005 metadata', () => {
  test('sets login page title and description metadata', async ({ page }) => {
    await page.goto('/login');

    await expect(page).toHaveTitle('LOGIN | Le Fil des Heures');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      'Le Fil des Heures のログインページです。メールOTP認証またはGoogleアカウントでサインインできます。'
    );
  });
});