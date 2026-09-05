import { test, expect, type Page } from '@playwright/test';
import { setLoginTwoFactorCookie } from './auth-2fa-test-utils';

// FREQ-334: メール OTP の入力を、ログイン / 会員登録タブ内の一状態ではなく専用画面で行う。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const EMAIL = '14masa56@gmail.com';

const openVerify = async (page: Page) => {
  // Cookie を置くにはオリジンが要るので、先に同一オリジンのページを開く。
  await page.goto('/login');
  await setLoginTwoFactorCookie(page, EMAIL);
  await page.goto('/login/verify');
};

for (const viewport of viewports) {
  test.describe(`FR-LOGIN-027 otp dedicated screen (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
    });

    test('AC-01: 2FA Cookie が無ければ /login へ送り返す', async ({ page }) => {
      await page.goto('/login/verify');

      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel('認証コード 1 桁目')).toHaveCount(0);
    });

    test('AC-04: 宛先はマスクして表示する', async ({ page }) => {
      await openVerify(page);

      await expect(page.getByText('14***56@gmail.com')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(EMAIL);
    });

    test('タブ（ログイン / 会員登録）を出さない', async ({ page }) => {
      await openVerify(page);

      await expect(page.getByRole('tab')).toHaveCount(0);
      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
    });

    test('リロードしてもコード入力が残る', async ({ page }) => {
      await openVerify(page);
      await page.reload();

      await expect(page.getByLabel('認証コード 1 桁目')).toBeVisible();
    });

    test('AC-06: 別のアドレスでやり直すと Cookie が消える', async ({ page }) => {
      await openVerify(page);

      await page.getByRole('button', { name: '別のアドレスでやり直す' }).click();
      await expect(page).toHaveURL(/\/login$/);

      // Cookie が消えているので、開き直しても入力画面には入れない
      await page.goto('/login/verify');
      await expect(page).toHaveURL(/\/login$/);
    });
  });
}

// 再送はクールダウン明けにしか出ないので、仮想時計で単独検証する。
test('AC-05: 再送はパスワードも宛先も送らない', async ({ page }) => {
  await page.clock.install();
  await page.goto('/login');
  await setLoginTwoFactorCookie(page, EMAIL);
  await page.goto('/login/verify');

  let hadBody: unknown = 'not-called';
  await page.route('**/api/auth/login/resend', async (route) => {
    hadBody = route.request().postData();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  await expect(page.getByText(/後に再送可能/)).toBeVisible();
  await page.clock.fastForward(61_000);

  const resend = page.getByRole('button', { name: '再送信' });
  await expect(resend).toBeVisible();
  await resend.click();

  await expect(page.getByText('認証コードを再送信しました。')).toBeVisible();
  // 宛先は Cookie 由来。本文を持たせると他人宛に送らせる導線になる。
  expect(hadBody).toBeNull();
});
