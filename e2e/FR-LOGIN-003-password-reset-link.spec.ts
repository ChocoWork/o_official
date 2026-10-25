import { test, expect } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-003 password reset link (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FR-LOGIN-003-AC-01 navigates to the password reset page from the login page', async ({ page }) => {
      await page.goto('/login');
      await page.getByRole('link', { name: 'パスワードをお忘れの方はこちら' }).click();
      await page.waitForURL('**/auth/password-reset');
      await expect(page.getByRole('heading', { name: /パスワード再設定/ })).toBeVisible();
    });
  });
}
