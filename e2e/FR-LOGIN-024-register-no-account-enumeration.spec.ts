import { expect, test } from '@playwright/test';

// FREQ-320: 会員登録の応答から「そのメールが登録済みか」を判別できないようにする
//
// 注: 本番ビルドでは TURNSTILE_SECRET_KEY 未設定時に verifyTurnstile が fail-closed で
// 403 を返すため、応答の同一性そのものは Turnstile をモックできる
// tests/integration/api/auth/register-enumeration.test.ts が担当する。
// ここでは「画面に登録済みを示す文言が出ないこと」と「409 を返さないこと」を見る。

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

// FREQ-323 で最小長を 16 文字にしたため、フィクスチャもそれ以上にする。
// 15 文字以下だと送信ボタンが無効のままで、AC を一度も検証しない。
const VALID_PASSWORD = 'Passw0rd!2026-enum-check';

const ENUMERATION_WORDS = /既に登録|すでに登録|already registered|Email already registered/i;

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-024 register account enumeration (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-320-AC-04
    test('the register form never reveals that an address is already taken', async ({ page }) => {
      await page.goto('/login');
      await page.getByRole('tab', { name: '会員登録' }).click();

      const panel = page.getByRole('tabpanel');
      await expect(panel).toBeVisible();

      await panel.getByLabel('Email').fill('already-registered@example.com');
      await panel.getByLabel('Password', { exact: true }).fill(VALID_PASSWORD);
      // 確認用パスワードを埋めないと送信ボタンが無効のままで、AC を一度も検証しない。
      await panel.getByLabel('Confirm Password', { exact: true }).fill(VALID_PASSWORD);
      await panel.getByRole('button', { name: /登録|会員登録/ }).first().click();

      // 送信結果がどうであれ（Turnstile 403 を含む）、登録済みを示す文言は出さない
      await expect(page.locator('body')).not.toHaveText(ENUMERATION_WORDS);
    });
  });
}

test.describe('FR-LOGIN-024 register account enumeration (API contract)', () => {
  // FREQ-320-AC-03: 409 は廃止した。登録済みでも 409 を返さない
  test('never answers 409 for the public signup path', async ({ request }) => {
    const response = await request.post('/api/auth/register', {
      data: {
        email: 'already-registered@example.com',
        password: VALID_PASSWORD,
        turnstileToken: 'e2e-probe',
      },
      failOnStatusCode: false,
    });

    expect(response.status()).not.toBe(409);
    expect(await response.text()).not.toMatch(ENUMERATION_WORDS);
  });
});
