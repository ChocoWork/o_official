import { test, expect } from '@playwright/test';
import { injectTurnstileToken } from './turnstile-test-utils';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

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

      await injectTurnstileToken(page);

      // /api/auth/login はモックなので本物の 2FA Cookie が発行されない。
      // /login/verify はサーバーで Cookie を検証するため、テスト側で置く。
      await setLoginTwoFactorCookie(page, 'user@example.com');

      await page.getByLabel('EMAIL').fill('user@example.com');
      await page.getByLabel('PASSWORD').fill('Password123456789!');
      await page.getByRole('button', { name: 'ログイン' }).click();

      // FREQ-58-AC-02 / FREQ-334: パスワード検証後、専用画面で 8 桁を求める
      await expect(page).toHaveURL(/\/login\/verify$/);
      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
      await expect(page.getByLabel('認証コード 8 桁目')).toBeVisible();
    });
  });
}
