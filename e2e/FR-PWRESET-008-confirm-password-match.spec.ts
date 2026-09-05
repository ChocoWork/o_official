import { test, expect, type Page } from '@playwright/test';

// FREQ-333: 新しいパスワードを 2 回入力させ、打ち間違いをその場で捕まえる。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const EMAIL = 'user@example.com';
const PASSWORD = 'Password123456789!';

// 再設定モードは reset-session cookie で決まる。cookie は DB のトークン行が要るので、
// ここでは session の応答だけを差し替えて「リンクを踏んだ直後」の画面を作る。
const openConfirmForm = async (page: Page) => {
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, email: EMAIL }),
    });
  });
  await page.goto('/auth/password-reset');
  await expect(page.locator('#confirmNewPassword')).toBeVisible();
};

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-008 confirm password match (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('AC-01: 一致しなければ送信しない', async ({ page }) => {
      let posts = 0;
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/api/auth/password-reset/confirm')) {
          posts += 1;
        }
      });

      await openConfirmForm(page);
      await page.locator('#newPassword').fill(PASSWORD);
      await page.locator('#confirmNewPassword').fill('Password123456789?');
      await page.getByRole('button', { name: 'パスワードを更新' }).click();

      await expect(page.getByText('パスワードが一致しません')).toBeVisible();
      expect(posts).toBe(0);
    });

    test('AC-02: 2 つの欄の表示文字と、確認欄の表示切り替え', async ({ page }) => {
      await openConfirmForm(page);

      await expect(page.locator('#newPassword')).toHaveAttribute(
        'placeholder',
        'New Password (16+ characters)',
      );
      await expect(page.locator('#confirmNewPassword')).toHaveAttribute(
        'placeholder',
        'Confirm New Password (16+ characters)',
      );
      // 入力規則は placeholder に畳んだ。同じ規則が説明文と二重に並ばないこと。
      await expect(page.locator('body')).not.toContainText('16文字以上128文字以内');

      await expect(page.locator('#confirmNewPassword')).toHaveAttribute('type', 'password');
      await page.getByRole('button', { name: '確認用パスワードを表示' }).click();
      await expect(page.locator('#confirmNewPassword')).toHaveAttribute('type', 'text');
    });

    test('AC-04: 再設定モードではメールアドレス欄を出さない', async ({ page }) => {
      await openConfirmForm(page);

      // 宛先は直前に本人が入力した値で、この画面では変更もできない。
      await expect(page.locator('#email')).toHaveCount(0);
    });

    test('AC-03: 片方だけでは押せず、一致すれば更新できる', async ({ page }) => {
      let body: unknown = null;
      await page.route('**/api/auth/password-reset/confirm', async (route) => {
        body = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await openConfirmForm(page);
      const submit = page.getByRole('button', { name: 'パスワードを更新' });

      await page.locator('#newPassword').fill(PASSWORD);
      await expect(submit).toBeDisabled();

      await page.locator('#confirmNewPassword').fill(PASSWORD);
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page.getByText('パスワードを更新しました')).toBeVisible();
      // 確認欄はサーバーへ送らない。同じ値を 2 回流しても保証は増えない。
      expect(Object.keys(body as Record<string, unknown>)).toEqual(['new_password']);
    });
  });
}
