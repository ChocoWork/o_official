import { test, expect } from '@playwright/test';
import { stubTurnstileScript } from './turnstile-test-utils';

// FREQ-328-AC-02 / AC-03: Turnstile の描画幅がフォーム内の他要素と揃い、横スクロールを起こさないこと
//
// Turnstile の iframe は 300px を下回れない。グリッド項目の min-width:auto を解除しないと
// この 300px が列幅へ伝播し、送信ボタンだけが Google ボタンより横に張り出す。
const viewports = [
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const siteKeyConfigured = !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const widths = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : null);
    const input = document.querySelector('input[name^="cf-turnstile"]');
    const container = input?.closest('div.pt-2')?.firstElementChild ?? null;
    const google =
      [...document.querySelectorAll('button, a')].find((el) =>
        el.textContent?.includes('Googleでサインイン'),
      ) ?? null;
    return {
      turnstile: width(container),
      submit: width(document.querySelector('form button[type="submit"]')),
      google: width(google),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

// ウィジェットは非同期に描画される。トークンは iframe のレイアウト確定より先に入るため、
// トークンだけを待って採寸すると幅 0 や未収束の値を掴む。実寸が確定するまで待つ。
const waitForWidget = async (page: import('@playwright/test').Page) => {
  await expect(page.locator('input[name^="cf-turnstile"]')).not.toHaveValue('', { timeout: 15000 });
  await expect
    .poll(async () => (await widths(page)).turnstile ?? 0, { timeout: 15000 })
    .toBeGreaterThan(0);
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-025 turnstile width fit (${viewport.name})`, () => {
    test.skip(!siteKeyConfigured, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY 未設定時はウィジェット自体を描画しない');

    test.beforeEach(async ({ page }) => {
      await stubTurnstileScript(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('AC-02: /login で Turnstile・送信ボタン・Google ボタンの幅が一致する', async ({ page }) => {
      await page.goto('/login');
      await waitForWidget(page);

      await expect
        .poll(async () => {
          const { turnstile, submit, google } = await widths(page);
          if (turnstile === null || submit === null || google === null) return null;
          return Math.max(Math.abs(turnstile - submit), Math.abs(turnstile - google));
        })
        .toBeLessThan(1);
    });

    test('AC-02: /auth/password-reset で Turnstile と送信ボタンの幅が一致する', async ({ page }) => {
      await page.goto('/auth/password-reset');
      await waitForWidget(page);

      await expect
        .poll(async () => {
          const { turnstile, submit } = await widths(page);
          if (turnstile === null || submit === null) return null;
          return Math.abs(turnstile - submit);
        })
        .toBeLessThan(1);
    });

    test('AC-03: 横スクロールが発生しない', async ({ page }) => {
      await page.goto('/login');
      await waitForWidget(page);

      await expect.poll(async () => (await widths(page)).overflow).toBe(0);
    });
  });
}
