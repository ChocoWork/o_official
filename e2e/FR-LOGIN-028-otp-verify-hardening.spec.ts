import { test, expect } from '@playwright/test';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

// FREQ-335-AC-02: アカウント単位の上限に達したら試行の窓ごと閉じる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test(`FR-LOGIN-028 上限到達で 2FA Cookie が破棄される (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    // 実際のカウントを積むには 5 回叩く必要があるので、サーバーの応答だけを再現する。
    // ここで見たいのは「429 を受けたあと入力画面に戻れないこと」。
    await page.route('**/api/auth/otp/verify', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: {
          'Retry-After': '600',
          'Set-Cookie':
            'sb-login-2fa-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
        },
        body: JSON.stringify({ error: 'Too many requests' }),
      });
    });

    await page.goto('/login');
    await setLoginTwoFactorCookie(page, 'user@example.com');
    await page.goto('/login/verify');

    for (let index = 0; index < 8; index += 1) {
      await page.getByLabel(`認証コード ${index + 1} 桁目`).fill('1');
    }
    await page.getByRole('button', { name: 'サインイン' }).click();

    // 案内の入れ物は常に置かれる（FREQ-376）ので、文言が入ったことまで確かめる
    await expect(page.locator('p[role="alert"]')).toHaveText(/\S/);

    // Cookie が消えているので、開き直しても入力画面には入れない
    await page.goto('/login/verify');
    await expect(page).toHaveURL(/\/login$/);
  });
}

// FREQ-336-AC-05: 偽造ヘルパを localhost 以外で動かせないこと。
test('2FA Cookie の偽造ヘルパは localhost 以外で例外を投げる', async ({ page }) => {
  // 遷移前は about:blank でオリジンが localhost にならない。
  await expect(setLoginTwoFactorCookie(page)).rejects.toThrow(/localhost 専用/);
});
