import { test, expect } from '@playwright/test';

test.describe('FR-LOGIN-002 Google OAuth button', () => {
  test('shows the Google sign-in button on the login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /Googleでサインイン/i })).toBeVisible();
  });

  test('starts Google OAuth with account chooser enabled', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('button', { name: /Googleでサインイン/i }).click();

    await expect
      .poll(
        async () => page.url(),
        {
          timeout: 20000,
          message: 'Google OAuth URL should include prompt=select_account',
        }
      )
      .toContain('prompt=select_account');
  });
});