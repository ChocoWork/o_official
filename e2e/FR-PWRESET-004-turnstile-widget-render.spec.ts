import { test, expect } from '@playwright/test';
import { stubTurnstileScript } from './turnstile-test-utils';

// FREQ-328-AC-01: /auth/password-reset に Turnstile が描画され、トークンが発行されること
//
// 以前このページだけ自動描画（class="cf-turnstile"）を使っており、スクリプト読込時にしか
// 走らないためウィジェットが出ず、送信時に「ボット検証を完了してください」で止まっていた。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const siteKeyConfigured = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-004 turnstile widget render (${viewport.name})`, () => {
    test.skip(!siteKeyConfigured, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY 未設定時はウィジェット自体を描画しない');

    test('パスワード再設定画面に Turnstile が描画されトークンが発行される', async ({ page }) => {
      await stubTurnstileScript(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/auth/password-reset');

      const response = page.locator('input[name^="cf-turnstile"]');
      await expect(response).toHaveCount(1);
      await expect(response).not.toHaveValue('', { timeout: 15000 });

      // 描画された = 高さを持つこと。0 のままだと token だけ入って見た目が出ない状態を見逃す。
      // token は iframe のレイアウト確定より先に入るため、単発の採寸では 0 を掴む。
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const input = document.querySelector('input[name^="cf-turnstile"]');
              const container = input?.closest('div.pt-2')?.firstElementChild ?? null;
              return container ? container.getBoundingClientRect().height : 0;
            }),
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);
    });
  });
}
