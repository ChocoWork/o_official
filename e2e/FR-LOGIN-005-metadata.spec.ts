import { test, expect } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-005 metadata (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FR-LOGIN-005-AC-01 sets login page title and description metadata', async ({ page }) => {
      await page.goto('/login');

      await expect(page).toHaveTitle('LOGIN | Le Fil des Heures');
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        'content',
        'Le Fil des Heures のログインページです。メールアドレスとパスワード、または Google アカウントでサインインできます。'
      );
    });
  });
}
