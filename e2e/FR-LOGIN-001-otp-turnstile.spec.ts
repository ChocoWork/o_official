import { test, expect } from '@playwright/test';
import { injectTurnstileToken } from './turnstile-test-utils';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-001 password + OTP login (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FR-LOGIN-001-AC-01 verifies password then advances to OTP code entry', async ({ page }) => {
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

      await injectTurnstileToken(page);

      // /api/auth/login はモックなので本物の 2FA Cookie が発行されない。
      // /login/verify はサーバーで Cookie を検証するため、テスト側で置く。
      await setLoginTwoFactorCookie(page, 'user@example.com');

      await page.getByLabel('EMAIL').fill('user@example.com');
      await page.getByLabel('PASSWORD').fill('Password123456789!');
      await page.getByRole('button', { name: 'ログイン' }).click();

      // FREQ-334: 入力はタブ内ではなく専用画面で行う
      await expect(page).toHaveURL(/\/login\/verify$/);
      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
      await expect(page.getByText(/後に再送可能/)).toBeVisible();

      // この時点ではログインした状態ではない: ヘッダーのアイコンはログインのまま（アカウントにならない）
      await expect(page.getByRole('banner').getByRole('link', { name: 'ログイン', exact: true })).toBeVisible();
      await expect(page.getByRole('banner').getByRole('link', { name: 'アカウント', exact: true })).toHaveCount(0);
    });
  });
}
