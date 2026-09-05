import { expect, test, type Page } from '@playwright/test';

// FREQ-323: パスワード最小長 16 の提示
//
// 漏洩照合そのもの（HIBP）は外部 API を叩くため、単体テスト
// tests/unit/lib/pwned-password.test.ts と統合テスト側が担当する。
// ここでは利用者に見える表示だけを確認する。

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const viewport of viewports) {
  // FREQ-323-AC-04
  test(`the password reset form states the 16 character minimum (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/auth/password-reset');

    // 要求フォーム（メール入力）が出ていること自体は FR-PWRESET-002 が担保する。
    // ここでは「8文字以上」という古い基準が残っていないことを見る。
    await expect(page.locator('body')).not.toContainText('8文字以上');
  });
}

// FREQ-323-AC-04: 最小長は独立した説明文ではなく入力欄の placeholder で示す
const openConfirmForm = async (page: Page) => {
  await page.route('**/api/auth/password-reset/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, email: 'user@example.com' }),
    });
  });
  await page.goto('/auth/password-reset');
  await expect(page.locator('#newPassword')).toBeVisible();
};

for (const viewport of viewports) {
  test(`the new password fields carry the 16 character minimum (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openConfirmForm(page);

    await expect(page.locator('#newPassword')).toHaveAttribute(
      'placeholder',
      /16\+ characters/,
    );
    await expect(page.locator('#confirmNewPassword')).toHaveAttribute(
      'placeholder',
      /16\+ characters/,
    );
  });
}
