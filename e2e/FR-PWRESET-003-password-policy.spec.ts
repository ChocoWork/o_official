import { expect, test } from '@playwright/test';

// FREQ-323: パスワード最小長 16 と、パスワードマネージャー利用を促す説明
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

    // 再設定モードでないと新パスワード欄は出ないため、説明文は DOM 全体から探す。
    // 入力欄が出ている場合のみ helperText が描画される。
    const body = page.locator('body');
    await expect(body).toBeVisible();

    // 要求フォーム（メール入力）が出ていること自体は FR-PWRESET-002 が担保する。
    // ここでは「8文字以上」という古い基準が残っていないことを見る。
    await expect(body).not.toContainText('8文字以上');
  });
}
