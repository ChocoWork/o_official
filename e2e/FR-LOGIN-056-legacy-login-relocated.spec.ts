/**
 * FR-LOGIN-056 旧のログイン・会員登録の画面を /login/password へ退避する
 * 対応: FR-AUTH-025-AC-01〜04（SR-AUTH-022）。設計: DD-AUTH-061、ADR-0469。
 *
 * 新しい /login（メールのコード・パスキー）を作る前に、今のパスワードの画面を /login/password へ移した。
 * 旧の画面はパスワードの店員・お客さんの入口として段4まで残す。ここでは、移した先が旧と同じように動くことと、
 * 旧の流れの中の戻り先が /login/password に閉じていることを確かめる（モックを使い、手元の DB は使わない）。
 */
import { expect, test, type Page } from '@playwright/test';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';
import { injectTurnstileToken, stubTurnstileScript } from './turnstile-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const EMAIL = 'legacy-login@example.com';

/** 旧のログインの窓口をモックして、送られた本文を控える。 */
async function mockLoginStep(page: Page): Promise<{ bodies: Array<Record<string, unknown>> }> {
  const seen: Array<Record<string, unknown>> = [];
  await page.route('**/api/auth/login', async (route) => {
    seen.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ step: 'otp', message: '認証コードを送信しました。' }),
    });
  });
  return { bodies: seen };
}

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-056 legacy login relocated (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test(`FR-AUTH-025-AC-01 /login/password は旧と同じ画面で、会員登録のタブを切り替えても住所は /login/password のまま (${viewport.name})`, async ({ page }) => {
      await page.goto('/login/password');

      await expect(page.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'false');
      await expect(page.getByLabel('EMAIL')).toBeVisible();
      await expect(page.getByLabel('PASSWORD')).toBeVisible();

      await page.getByRole('tab', { name: '会員登録' }).click();
      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Confirm Password', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/login\/password$/);

      await page.getByRole('tab', { name: 'ログイン' }).click();
      await expect(page).toHaveURL(/\/login\/password$/);
    });

    test(`FR-AUTH-025-AC-01 tab=register で会員登録のタブが選ばれた状態で開く (${viewport.name})`, async ({ page }) => {
      await page.goto('/login/password?tab=register');

      await expect(page.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Confirm Password', { exact: true })).toBeVisible();
    });

    test(`FR-AUTH-025-AC-02 検索に載せない（meta robots が noindex）(${viewport.name})`, async ({ page }) => {
      await page.goto('/login/password');

      const robots = await page.locator('meta[name="robots"]').getAttribute('content');
      expect(robots ?? '').toContain('noindex');
      await expect(page).toHaveTitle('LOGIN | Le Fil des Heures');
    });

    test(`FR-AUTH-025-AC-02 旧い保留の Cookie があれば /login/verify へ送られ、コードの入力欄が出る (${viewport.name})`, async ({ page }) => {
      await page.goto('/login/password');
      await setLoginTwoFactorCookie(page, EMAIL);

      await page.goto('/login/password');

      await expect(page).toHaveURL(/\/login\/verify$/);
      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
    });

    test(`FR-AUTH-025-AC-03 /login/password?next=/account の戻り先が、旧のログインの窓口の本文に渡る (${viewport.name})`, async ({ page }) => {
      const login = await mockLoginStep(page);
      await page.goto('/login/password?next=%2Faccount');
      await injectTurnstileToken(page);
      await setLoginTwoFactorCookie(page, EMAIL);

      await page.getByLabel('EMAIL').fill(EMAIL);
      await page.getByLabel('PASSWORD').fill('Password123456789!');
      await page.getByRole('button', { name: 'ログイン' }).click();

      await expect(page).toHaveURL(/\/login\/verify$/);
      expect(login.bodies).toHaveLength(1);
      expect(login.bodies[0].next).toBe('/account');
    });

    test(`FR-AUTH-025-AC-04 保留の Cookie が無い /login/verify は /login/password へ送られる (${viewport.name})`, async ({ page }) => {
      await page.goto('/login/verify');

      await expect(page).toHaveURL(/\/login\/password$/);
      await expect(page.getByLabel('認証コード 1 桁目')).toHaveCount(0);
    });

    test(`FR-AUTH-025-AC-04 コードの入力画面で取りやめると /login/password へ戻る (${viewport.name})`, async ({ page }) => {
      await page.goto('/login/password');
      await setLoginTwoFactorCookie(page, EMAIL);
      await page.goto('/login/verify');

      await page.getByRole('button', { name: '別のアドレスでやり直す' }).click();

      await expect(page).toHaveURL(/\/login\/password$/);
      await expect(page.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    });

    test(`FR-AUTH-025-AC-04 登録の完了の画面の「ログインページへ」で、/login/password のログインのタブへ戻る (${viewport.name})`, async ({ page }) => {
      await stubTurnstileScript(page);
      await page.route('**/api/auth/register', (route) =>
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ message: '確認メールを送信しました。メールのリンクから登録を完了してください。' }),
        }),
      );
      await page.goto('/login/password?tab=register');

      const panel = page.getByRole('tabpanel');
      await panel.getByLabel('Email').fill('legacy-register@example.com');
      await panel.getByLabel('Password', { exact: true }).fill('Passw0rd!2026-legacy-check');
      await panel.getByLabel('Confirm Password', { exact: true }).fill('Passw0rd!2026-legacy-check');
      await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue('');
      await panel.getByRole('button', { name: '登録して確認メールを受け取る' }).click();

      await page.getByRole('button', { name: 'ログインページへ' }).click();

      await expect(page.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/\/login\/password$/);
    });
  });
}
