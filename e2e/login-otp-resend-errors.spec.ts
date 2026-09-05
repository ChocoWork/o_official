import { test, expect } from '@playwright/test';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

for (const viewport of [
  { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 },
]) {
  for (const status of [429, 503]) {
    test(`OTP resend ${status} feedback at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.clock.install();
      await page.route('**/api/auth/login/resend', route => route.fulfill({
        status, contentType: 'application/json',
        headers: { 'Retry-After': '120' },
        body: JSON.stringify({ error: 'private database detail' }),
      }));
      await page.goto('/login');
      await setLoginTwoFactorCookie(page, 'user@example.invalid');
      await page.goto('/login/verify');
      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
      await page.clock.fastForward(61_000);
      await page.getByRole('button', { name: '再送信', exact: true }).click();
      await expect(page.locator('p[role="alert"]')).toContainText(status === 429
        ? '送信回数の上限' : '一時的に認証処理を利用できません');
      await expect(page.locator('body')).not.toContainText('private database detail');
      if (status === 429) {
        await page.clock.fastForward(119_000);
        await expect(page.getByRole('button', { name: '再送信', exact: true })).toHaveCount(0);
        await page.clock.fastForward(1_000);
        await expect(page.getByRole('button', { name: '再送信', exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      )).toBe(false);
    });
  }
}
