import { test, expect } from '@playwright/test';
import { injectTurnstileToken } from './turnstile-test-utils';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

test.describe('FR-ACCOUNT-007 logout from account page', () => {
  test('allows the user to log out from the account page', async ({ page }) => {
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

    // ログアウト要求が通ったら未認証に切り替える。
    // 固定で authenticated:true を返すと、ログアウト後もクライアントが在ログイン扱いになる。
    let authenticated = true;

    await page.route('**/api/auth/logout', async (route) => {
      authenticated = false;
      await route.continue();
    });

    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated,
          user: {
            id: 'test-user-id',
            email: 'user@example.com',
            role: 'user',
            mfaVerified: false,
          },
        }),
      });
    });

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ fullName: '', phone: '' }),
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

    // FREQ-334: 認証コードの入力は専用画面
    await page.waitForURL('**/login/verify');

    for (let index = 0; index < 8; index += 1) {
      await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(String((index + 1) % 10));
    }

    await page.getByRole('button', { name: 'サインイン' }).click();
    await page.waitForURL('**/account');

    const origin = new URL(page.url()).origin;
    await page.context().addCookies([
      { name: 'sb-access-token', value: 'test-access-token', url: origin, httpOnly: true, sameSite: 'Lax' },
      { name: 'sb-refresh-token', value: 'test-refresh-token', url: origin, httpOnly: true, sameSite: 'Lax' },
      { name: 'sb-csrf-token', value: 'test-csrf-token', url: origin, httpOnly: false, sameSite: 'Lax' },
    ]);

    await page.goto('/account');
    await page.waitForURL('**/account');

    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
    await page.getByRole('button', { name: 'ログアウト' }).click();

    // 実装はログアウト成功時のみホームへハードナビゲーションする
    // （src/app/account/page.tsx handleLogout）。到達自体がログアウト成立の証拠。
    await page.waitForURL('**/');
    await expect(page.getByRole('link', { name: 'ログイン' })).toBeVisible();
  });
});