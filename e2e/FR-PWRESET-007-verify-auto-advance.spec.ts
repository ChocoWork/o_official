import { test, expect, type Page } from '@playwright/test';

// FREQ-332: 再設定リンクから確認画面を挟まず、新しいパスワードの入力へ直行する。
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

const TOKEN = 'freq332-probe-token';
const EMAIL = 'user@example.com';

// 有効なトークンは DB の行が要る。ここで見たいのは画面遷移なので、
// link と session の応答だけを差し替えて「有効なリンクを踏んだ状態」を作る。
const mockValidLink = async (page: Page) => {
  await page.route('**/api/auth/password-reset/link', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, redirectTo: '/auth/password-reset' }),
    });
  });
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, email: EMAIL }),
    });
  });
};

for (const viewport of viewports) {
  test.describe(`FR-PWRESET-007 verify auto advance (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('AC-02: 有効なリンクは確認画面を経ずに新パスワード入力へ着地する', async ({ page }) => {
      await mockValidLink(page);
      await page.goto(`/auth/password-reset/verify?token=${TOKEN}`);

      await expect(page.locator('#newPassword')).toBeVisible();
      await expect(page.getByRole('button', { name: 'パスワードを更新' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'パスワードを再設定する' })).toHaveCount(0);
    });

    test('AC-01: 自動送信は 1 回だけ', async ({ page }) => {
      let posts = 0;
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/api/auth/password-reset/link')) {
          posts += 1;
        }
      });
      await mockValidLink(page);
      await page.goto(`/auth/password-reset/verify?token=${TOKEN}`);

      await expect(page.locator('#newPassword')).toBeVisible();
      expect(posts).toBe(1);
    });

    test('AC-03: 通信エラーのときだけ手動の再試行を出す', async ({ page }) => {
      await page.route('**/api/auth/password-reset/link', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.fallback();
          return;
        }
        await route.abort('failed');
      });

      await page.goto(`/auth/password-reset/verify?token=${TOKEN}`);

      await expect(page.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
      await expect(page.locator('p[role="alert"]')).toContainText('確認に失敗');
    });
  });
}
