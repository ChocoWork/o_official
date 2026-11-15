import { test, expect } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-002 Google OAuth button (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('FR-LOGIN-002-AC-01 shows the Google sign-in button on the login page', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('button', { name: /Googleでサインイン/i })).toBeVisible();
    });

    test('FR-LOGIN-002-AC-01 starts Google OAuth with account chooser enabled', async ({ page }) => {
      // 本物の Google の画面は開かない（FR-LOGIN-038 と同じ）。手元の Supabase で Google を有効にすると
      // authorize が Google へ送り、Google 側のクライアントの登録しだいで落ちるため、authorize への移動を作り物のページで受ける。
      await page.route('**/auth/v1/authorize?**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>authorize stub</title>' })
      );
      await page.goto('/login');

      const oauthStartResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/auth/oauth/start' && response.request().method() === 'POST';
      });

      await page.getByRole('button', { name: /Googleでサインイン/i }).click();

      // ボタンは fetch の POST で開始を頼み、本文の url へ端末が移る（SEC-AUTH-026、ADR-0412。CSP の form-action 'self' を避けるため）。
      const oauthStartResponse = await oauthStartResponsePromise;
      expect(oauthStartResponse.status(), 'OAuth start route must return 200 with the authorize url').toBe(200);

      await expect
        .poll(
          async () => page.url(),
          {
            timeout: 20000,
            message: 'Browser should move to the authorize url with prompt=select_account',
          }
        )
        .toContain('prompt=select_account');

      // 移った先は本文の url（端末が移ると応答の本文は読めなくなるので、移った先の URL で確かめる）。
      const authorizeUrl = new URL(page.url());
      expect(authorizeUrl.pathname).toBe('/auth/v1/authorize');
      expect(authorizeUrl.searchParams.get('provider')).toBe('google');
      expect(authorizeUrl.searchParams.get('prompt')).toBe('select_account');
    });
  });
}
