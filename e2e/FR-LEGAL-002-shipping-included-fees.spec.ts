import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-104: /legal を送料込み販売（送料無料）・決済手数料の負担区分
 * （コンビニ決済手数料はお客様負担、その他は当社負担）・試着サービス料金の
 * 方針に合わせて更新。送料の独立行（FREQ-103-REQ-02 / AC-01）は廃止。
 */
for (const vp of viewports) {
  test.describe(`FR-LEGAL-002 送料込み・手数料区分 (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/legal');
    });

    test('商品以外の必要代金に送料無料・コンビニ手数料・試着サービスが記載される', async ({
      page,
    }) => {
      const value = page
        .locator('dt', { hasText: /^商品以外の必要代金$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).toContainText('送料は無料');
      await expect(value).toContainText('コンビニ決済手数料');
      await expect(value).toContainText('試着サービス');
    });

    test('独立した「送料」ラベル行が表示されない', async ({ page }) => {
      await expect(page.locator('dt', { hasText: /^送料$/ })).toHaveCount(0);
    });

    test('販売価格に消費税込みが明記される', async ({ page }) => {
      const value = page
        .locator('dt', { hasText: /^販売価格$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).toContainText('消費税込み');
    });
  });
}
