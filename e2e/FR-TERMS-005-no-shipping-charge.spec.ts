import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-516: 送料は無料に固定し、どこでも同じ言葉で示す。
 * 規約に送料の支払いを書かず、/ui の見本に500円・一律の送料の文を出さない。
 */
for (const vp of viewports) {
  test.describe(`FR-TERMS-005 送料を取らない文 (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test('/terms 第4条は商品代金だけを支払うと書き、「送料」の字が出ない', async ({ page }) => {
      await page.goto('/terms');

      await expect(page.locator('#terms-4')).toContainText(
        'ユーザーは、商品代金を、以下のいずれかの方法により支払うものとします',
      );
      await expect(page.locator('body')).not.toContainText('送料');
    });

    test('/ui の見本に「¥500」「一律」が出ず、送料無料の文が出る', async ({ page }) => {
      await page.goto('/ui');

      await expect(page.getByText('送料は無料です（商品価格に含みます）。')).toBeVisible();
      await expect(page.getByText('送料無料（商品価格に含みます）', { exact: true })).toBeVisible();
      const body = page.locator('body');
      await expect(body).not.toContainText('¥500');
      await expect(body).not.toContainText('一律');
    });
  });
}
