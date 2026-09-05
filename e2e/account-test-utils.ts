import { expect, Page } from '@playwright/test';
import { injectTurnstileToken } from './turnstile-test-utils';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

export async function mockOtpAuthentication(page: Page, email = 'user@example.com') {
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

  await page.route('**/api/auth/otp/verify', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: '認証に成功しました。',
      }),
    });
  });

  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        user: {
          id: 'test-user-id',
          email,
          role: 'user',
          mfaVerified: false,
        },
      }),
    });
  });
}

export async function loginAndOpenAccount(page: Page, email = 'user@example.com') {
  await page.goto('/login');

  await injectTurnstileToken(page);

  // /api/auth/login はモックなので本物の 2FA Cookie が発行されない。
  // /login/verify はサーバーで Cookie を検証するため、テスト側で置く。
  await setLoginTwoFactorCookie(page, email);

  await page.getByLabel('EMAIL').fill(email);
  await page.getByLabel('PASSWORD').fill('Password123456789!');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // FREQ-334: 認証コードの入力は専用画面
  await page.waitForURL('**/login/verify');

  for (let index = 0; index < 8; index += 1) {
    await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(String((index + 1) % 10));
  }

  await page.getByRole('button', { name: 'サインイン' }).click();
  // 認証フロー刷新後、ログイン成功時のリダイレクト先は /account
  await page.waitForURL('**/account');

  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: 'sb-access-token', value: 'test-access-token', url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'sb-refresh-token', value: 'test-refresh-token', url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'sb-csrf-token', value: 'test-csrf-token', url: origin, httpOnly: false, sameSite: 'Lax' },
  ]);

  await page.goto('/account');
  await page.waitForURL('**/account');
  await expect(page).toHaveURL(/\/account/);
}