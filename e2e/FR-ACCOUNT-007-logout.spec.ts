import { test, expect } from '@playwright/test';

test.describe('FR-ACCOUNT-007 logout from account page', () => {
  test('allows the user to log out from the account page', async ({ page }) => {
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
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          user: { id: 'test-user-id', email: 'user@example.com' },
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
    await page.getByLabel('EMAIL').fill('user@example.com');
    await page.getByRole('button', { name: 'メールで認証コードを受け取る' }).click();

    for (let index = 0; index < 8; index += 1) {
      await page.getByLabel(`認証コード ${index + 1} 桁目`).fill(String((index + 1) % 10));
    }

    await page.locator('form button[type="submit"]').click();
    await page.waitForURL('**/');

    await page.locator('a[href="/account"]').first().click();
    await page.waitForURL('**/account');

    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
    await page.getByRole('button', { name: 'ログアウト' }).click();

    await expect(page.getByText('会員情報を確認するにはログインが必要です')).toBeVisible();
    await expect(page.getByRole('link', { name: 'ログイン' })).toBeVisible();
  });
});