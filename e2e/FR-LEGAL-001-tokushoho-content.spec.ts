import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-103: /legal（特定商取引法に基づく表記）を ssstein / HYKE / AURALEE を参考に見直し、
 * 税の二重計上を解消し、申込の有効期限を補う。
 * ※ 送料の独立行（FREQ-103-REQ-02 / AC-01）は FREQ-104（送料込み方針）により廃止。
 */
for (const vp of viewports) {
  test.describe(`FR-LEGAL-001 特商法表記 (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/legal');
    });

    test('支払方法・支払時期にコンビニ決済の未入金時キャンセルが言及される', async ({ page }) => {
      const term = page.locator('dt', { hasText: /^支払方法・支払時期$/ });
      await expect(term).toBeVisible();
      const value = term.locator('xpath=following-sibling::dd[1]');
      await expect(value).toContainText('コンビニ決済');
      await expect(value).toContainText('キャンセル');
    });

    test('商品以外の必要代金に消費税が二重計上されない', async ({ page }) => {
      const value = page
        .locator('dt', { hasText: /^商品以外の必要代金$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).not.toContainText('消費税');
    });
  });
}
