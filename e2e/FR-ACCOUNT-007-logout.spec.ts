import { test, expect } from '@playwright/test';
import { loginAndOpenAccount, mockOtpAuthentication } from './account-test-utils';

test.describe('FR-ACCOUNT-007 logout from account page', () => {
  test('allows the user to log out from the account page', async ({ page }) => {
    await mockOtpAuthentication(page);

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
          user: authenticated ? {
            id: 'test-user-id',
            email: 'user@example.com',
            role: 'user',
            mfaVerified: false,
          } : null,
        }),
      });
    });

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'user@example.com', fullName: '', kanaName: '', phone: '' }),
      });
    });

    await loginAndOpenAccount(page);

    const authCookieNames = ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token'];
    const authCookiesBeforeLogout = (await page.context().cookies())
      .filter((cookie) => authCookieNames.includes(cookie.name))
      .map((cookie) => cookie.name);
    expect(authCookiesBeforeLogout.sort()).toEqual([...authCookieNames].sort());

    await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible();
    const logoutResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'ログアウト' }).click();
    expect((await logoutResponse).ok()).toBe(true);

    // 実装はログアウト成功時のみホームへハードナビゲーションする
    // （src/app/account/page.tsx handleLogout）。到達自体がログアウト成立の証拠。
    await page.waitForURL('**/');
    await expect(page.getByRole('link', { name: 'ログイン' })).toBeVisible();
    await expect.poll(async () => (await page.context().cookies())
      .filter((cookie) => authCookieNames.includes(cookie.name))
      .map((cookie) => cookie.name)).toEqual([]);
  });
});
