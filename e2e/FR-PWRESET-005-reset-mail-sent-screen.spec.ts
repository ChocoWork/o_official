import { test, expect, type Page } from '@playwright/test';
import { injectTurnstileToken, stubTurnstileScript } from './turnstile-test-utils';

// FREQ-329: 再設定メール送信後はフォームを畳み、送信済みであることと再送手段を
// 独立した結果画面として出す。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const EMAIL = 'user@example.com';

const mockSessionNotReady = async (page: Page) => {
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: false }),
    });
  });
};

const sendResetMail = async (page: Page) => {
  await injectTurnstileToken(page);
  await page.locator('#email').fill(EMAIL);
  await page.getByRole('button', { name: '再設定メールを送信' }).click();
};

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-005 reset mail sent screen (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      // 実 CDN はスイート並列実行時に 429 を返すので、ウィジェットはスタブで出す。
      await stubTurnstileScript(page);
      await mockSessionNotReady(page);
      await page.route('**/api/auth/password-reset/request', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/auth/password-reset');
    });

    test('AC-01: 送信後はフォームを畳んで結果だけ残す', async ({ page }) => {
      await sendResetMail(page);

      await expect(page.getByText('再設定メールを送信しました')).toBeVisible();
      await expect(page.getByRole('button', { name: '再設定メールを送信' })).toHaveCount(0);
      await expect(page.locator('#email')).toHaveCount(0);
    });

    test('AC-02: 前回のリンクが無効になる旨を示し、宛先は画面に残さない', async ({ page }) => {
      await sendResetMail(page);

      await expect(page.getByText('再送信すると前回のリンクは無効です')).toBeVisible();
      await expect(page.getByText(/迷惑メールフォルダ/)).toBeVisible();
      // 宛先は直前に本人が入力した値。残しても新しく分かることが無い一方、
      // 肩越しに見られたときアドレスを晒す。
      await expect(page.getByText(EMAIL)).toHaveCount(0);
    });

    test('AC-03: 送信直後は残り時間だけを出し、再送信ボタンを出さない', async ({ page }) => {
      await sendResetMail(page);

      await expect(page.getByText(/後に再送可能/)).toBeVisible();
      await expect(page.getByRole('button', { name: '再送信する' })).toHaveCount(0);
    });

    test('AC-05: パスワード更新の完了も同じ結果画面で、主アクションはログインへ', async ({ page }) => {
      // 後から追加した route が優先されるので、confirm モードへ上書きする。
      await page.route('**/api/auth/password-reset/session', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ready: true, email: EMAIL }),
        });
      });
      await page.route('**/api/auth/password-reset/confirm', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await page.goto('/auth/password-reset');

      await page.locator('#newPassword').fill('Password123456789!');
      // FREQ-333: 確認欄が埋まるまで送信ボタンは無効。
      await page.locator('#confirmNewPassword').fill('Password123456789!');
      await page.getByRole('button', { name: 'パスワードを更新' }).click();

      await expect(page.getByText('パスワードを更新しました')).toBeVisible();
      await expect(page.getByRole('link', { name: 'ログインへ' })).toBeVisible();
      await expect(page.locator('#newPassword')).toHaveCount(0);
    });
  });
}

test('AC-04: 再送信が 429 なら上限を伝え、再送信ボタンを引っ込める', async ({ page }) => {
  // クールダウンは 60 秒。実時間で待つとテストが止まるので仮想時計で送る。
  await page.clock.install();
  await stubTurnstileScript(page);
  await mockSessionNotReady(page);

  let requestCount = 0;
  await page.route('**/api/auth/password-reset/request', async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': '3600' },
      body: JSON.stringify({ error: 'Too many requests' }),
    });
  });

  await page.goto('/auth/password-reset');
  await sendResetMail(page);
  await expect(page.getByText(/後に再送可能/)).toBeVisible();

  await page.clock.fastForward(61_000);

  const resendButton = page.getByRole('button', { name: '再送信する' });
  await expect(resendButton).toBeVisible();
  // ウィジェットを描き直した直後はトークンが空なので、取り直してから押す。
  await injectTurnstileToken(page);
  await expect(resendButton).toBeEnabled();
  await resendButton.click();

  await expect(
    page.getByText('送信回数の上限に達しました。しばらく時間をおいてからお試しください。'),
  ).toBeVisible();
  await expect(resendButton).toHaveCount(0);
});
