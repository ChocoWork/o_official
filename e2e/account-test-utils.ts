import { expect, Page } from '@playwright/test';

export async function mockOtpAuthentication(page: Page, email = 'user@example.com') {
  await page.route('**/api/auth/identify', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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

  if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    await page.evaluate(() => {
      window.onTurnstileSuccess?.('test-turnstile-token');
    });
  }

  await page.getByLabel('EMAIL').fill(email);
  await page.getByRole('button', { name: 'メールで認証コードを受け取る' }).click();

  for (let index = 0; index < 8; index += 1) {
    await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(String((index + 1) % 10));
  }

  await page.locator('form button[type="submit"]').click();
  await page.waitForURL('**/');

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