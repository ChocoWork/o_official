import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-102: 利用規約 第5条（商品の配送）を受注生産の実態に合わせ、
 * 特定商取引法に基づく表記（/legal）の引渡時期とも整合させる。
 */
for (const vp of viewports) {
  test.describe(`FR-TERMS-004 受注生産の配送記載 (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
    });

    test('/terms 第5条に在庫あり/受注生産の発送記載が表示される', async ({ page }) => {
      await page.goto('/terms');

      const section = page.locator('#terms-5');
      await expect(section).toContainText('受注生産');
      await expect(section).toContainText('在庫がある場合');
      await expect(section).toContainText('在庫がなく受注生産となる場合');
      await expect(section).toContainText('約2ヶ月');
      // 3〜7営業日は在庫がある場合の条件として提示される
      await expect(section.getByText('在庫がある場合', { exact: false })).toContainText('3〜7営業日');
    });

    test('/legal 商品の引渡時期が第5条と整合し、プレースホルダが残っていない', async ({ page }) => {
      await page.goto('/legal');

      const value = page
        .locator('dt', { hasText: /^商品の引渡時期$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(value).toContainText('3〜7営業日');
      await expect(value).toContainText('2ヶ月');
      await expect(value).not.toContainText('◯営業日');
      await expect(value).not.toContainText('要記入');
    });
  });
}
