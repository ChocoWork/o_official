import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * FREQ-109: /legal の「返品・交換・キャンセルについて」を、原則不可＋初期不良例外・
 * 返品送料の負担区分・返品不可ケース一覧・自社受注生産の良品範囲・返品期限（7日）を
 * 含む詳細な内容に改善。再販業者向けの「国内正規代理店」表現は自社ブランド向けに改文。
 */
for (const vp of viewports) {
  test.describe(`FR-LEGAL-006 返品・交換ポリシー (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/legal');
    });

    const dd = (page) =>
      page
        .locator('dt', { hasText: /^返品・交換・キャンセルについて$/ })
        .locator('xpath=following-sibling::dd[1]');

    test('初期不良と7日以内の連絡が記載される', async ({ page }) => {
      const value = dd(page);
      await expect(value).toContainText('初期不良');
      await expect(value).toContainText('7日以内');
    });

    test('返品送料の負担区分が記載される', async ({ page }) => {
      const value = dd(page);
      await expect(value).toContainText('送料は、お客様のご負担');
      await expect(value).toContainText('当社が当該送料を負担');
    });

    test('返品・交換不可のケースが5項目以上の箇条書きで表示される', async ({
      page,
    }) => {
      const items = dd(page).locator('ul > li');
      expect(await items.count()).toBeGreaterThanOrEqual(5);
    });

    test('返品期限の見出しとサイズ交換の記載がある', async ({ page }) => {
      const value = dd(page);
      await expect(value).toContainText('返品期限');
      await expect(value).toContainText('サイズ交換');
    });

    test('再販業者向けの「国内正規代理店」表現が含まれない', async ({ page }) => {
      await expect(dd(page)).not.toContainText('国内正規代理店');
    });
  });
}
