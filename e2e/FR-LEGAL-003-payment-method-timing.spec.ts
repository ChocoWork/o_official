import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-105: /legal の「支払方法」と「支払時期」を1項目に統合し、
 * 採用中の各決済手段（クレジットカード / PayPay / コンビニ決済）ごとに
 * 支払時期を明記。独立した「支払時期」行は廃止。
 */
for (const vp of viewports) {
  test.describe(`FR-LEGAL-003 支払方法・支払時期の統合 (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/legal');
    });

    test('「支払方法・支払時期」に各決済手段の支払時期が表示される', async ({
      page,
    }) => {
      const value = page
        .locator('dt', { hasText: /^支払方法・支払時期$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).toBeVisible();
      await expect(value).toContainText('クレジットカード');
      await expect(value).toContainText('PayPay');
      await expect(value).toContainText('コンビニ決済');
    });

    test('独立した「支払時期」ラベル行が表示されない', async ({ page }) => {
      await expect(page.locator('dt', { hasText: /^支払時期$/ })).toHaveCount(0);
    });
  });
}
