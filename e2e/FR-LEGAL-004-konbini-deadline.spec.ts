import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-106: コンビニ決済の払込期限を7日に設定（Stripe expires_after_days=7）。
 * /legal の「支払方法・支払時期」「申込の有効期限」の期限表記を7日に統一。
 */
for (const vp of viewports) {
  test.describe(`FR-LEGAL-004 コンビニ決済期限7日 (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/legal');
    });

    test('支払方法・支払時期のコンビニ決済期限が7日以内と表示される', async ({
      page,
    }) => {
      const value = page
        .locator('dt', { hasText: /^支払方法・支払時期$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).toContainText('コンビニ決済');
      await expect(value).toContainText('7日以内');
    });

    test('支払方法・支払時期に未入金時7日でのキャンセルが表示される', async ({ page }) => {
      const value = page
        .locator('dt', { hasText: /^支払方法・支払時期$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).toContainText('7日以内');
      await expect(value).toContainText('キャンセル');
    });
  });
}
