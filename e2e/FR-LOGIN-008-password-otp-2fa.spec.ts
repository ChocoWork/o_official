import { test, expect } from '@playwright/test';

// FREQ-58: ログインをメール + パスワード + メールOTP の2要素認証にすること
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-008 password + OTP 2FA (${viewport.name})`, () => {
    test('shows EMAIL and PASSWORD fields, then requires an OTP code', async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await page.route('**/api/auth/login', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            step: 'otp',
            message: '認証コードを送信しました。メールに届いたコードを入力してください。',
          }),
        });
      });

      await page.goto('/login');

      // FREQ-58-AC-01: EMAIL と PASSWORD の入力欄が表示される
      await expect(page.getByLabel('EMAIL')).toBeVisible();
      await expect(page.getByLabel('PASSWORD')).toBeVisible();

      if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
        await page.evaluate(() => {
          window.onTurnstileSuccess?.('test-turnstile-token');
        });
      }

      await page.getByLabel('EMAIL').fill('user@example.com');
      await page.getByLabel('PASSWORD').fill('password123');
      await page.getByRole('button', { name: 'ログイン' }).click();

      // FREQ-58-AC-02: パスワード入力後に OTP コード入力欄（8桁）が表示される
      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
      await expect(page.getByLabel('認証コード 8 桁目')).toBeVisible();
    });
  });
}
