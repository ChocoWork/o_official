import { expect, Page, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-41: APPLYボタンを廃止し、操作停止後のデバウンス(300ms)で自動適用する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 900, drawer: false },
] as const;

async function openFilters(page: Page, useDrawer: boolean): Promise<void> {
  if (useDrawer) {
    await page.locator('[data-filter-button="floating"]').click();
  }
  await expect(page.locator('input[aria-label="Maximum value"]:visible').first()).toBeVisible();
}

test.describe('FR-ITEM-ALL-018 フィルタの自動適用（APPLYボタン廃止）', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      // FREQ-41-AC-01: APPLYボタンが存在しない
      test('APPLYボタンが存在しない', async ({ page }) => {
        await gotoItemList(page);
        await openFilters(page, viewport.drawer);
        await expect(page.getByRole('button', { name: 'APPLY' })).toHaveCount(0);
      });

      // FREQ-41-AC-02: 操作後に待つだけでフィルタが自動適用される
      test('PRICEスライダー操作後、待つだけでURLにフィルタが反映される', async ({ page }) => {
        await gotoItemList(page);
        await openFilters(page, viewport.drawer);

        const maxThumb = page.locator('input[aria-label="Maximum value"]:visible').first();
        await maxThumb.focus();
        await maxThumb.press('Home');

        // APPLYを押さず、デバウンス自動適用でpriceMaxが付くのを待つ。
        await page.waitForURL(/priceMax=/);
        await expect(page).toHaveURL(/priceMax=/);
      });
    });
  }
});
