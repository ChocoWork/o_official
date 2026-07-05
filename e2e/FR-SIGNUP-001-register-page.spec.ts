import { test, expect } from '@playwright/test';

// FREQ-63: 会員登録とログインを /login に一本化し、専用 /register ルートを廃止すること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-SIGNUP-001 register route removed (${viewport.name})`, () => {
    test('returns 404 on /register', async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const response = await page.goto('/register');

      // FREQ-63-AC-01: /register にアクセスすると 404 になること
      expect(response?.status()).toBe(404);
    });

    test('login page provides a path to registration via tab', async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/login');

      // 会員登録はタブで /login 内に統合される
      await expect(page.getByRole('tab', { name: '会員登録' })).toBeVisible();
    });
  });
}
