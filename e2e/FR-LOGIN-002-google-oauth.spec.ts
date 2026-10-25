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
      await page.goto('/login');

      const oauthStartResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/auth/oauth/start';
      });

      await page.getByRole('button', { name: /Googleでサインイン/i }).click();

      const oauthStartResponse = await oauthStartResponsePromise;
      expect(oauthStartResponse.status(), 'OAuth start route must redirect instead of returning 404').toBe(302);

      await expect
        .poll(
          async () => page.url(),
          {
            timeout: 20000,
            message: 'Google OAuth URL should include prompt=select_account',
          }
        )
        .toContain('prompt=select_account');
    });
  });
}
