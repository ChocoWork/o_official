import { expect, Locator, Page, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-44: STOCK / SEASON を COLOR・SIZE と同じマルチセレクトに統一する。
// ALL は他を外して ALL のみ、それ以外は独立トグル（複数選択可）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 900, drawer: false },
] as const;

async function openFilters(page: Page, useDrawer: boolean): Promise<void> {
  if (useDrawer) {
    await page.locator('[data-filter-button="floating"]').click();
  }
  await expect(box(page, 'STOCK ALL')).toBeVisible();
}

// 表示中（サイドバー or Drawer）のチェックボックス input。
function box(page: Page, ariaLabel: string): Locator {
  return page.locator(`input[aria-label="${ariaLabel}"]:visible`).first();
}

async function clickOption(page: Page, ariaLabel: string): Promise<void> {
  await page
    .locator(`label:has(input[aria-label="${ariaLabel}"]):visible`)
    .first()
    .click();
}

test.describe('FR-ITEM-ALL-021 STOCK / SEASON マルチセレクト', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      // FREQ-44-AC-01 / AC-03
      test('STOCK: OUT 選択中に IN を押すと両方選択、ALL で解除', async ({ page }) => {
        await gotoItemList(page);
        await openFilters(page, viewport.drawer);

        await clickOption(page, 'STOCK OUT OF STOCK');
        await expect(box(page, 'STOCK OUT OF STOCK')).toBeChecked();
        await expect(box(page, 'STOCK ALL')).not.toBeChecked();

        await clickOption(page, 'STOCK IN STOCK');
        await expect(box(page, 'STOCK IN STOCK')).toBeChecked();
        await expect(box(page, 'STOCK OUT OF STOCK')).toBeChecked();

        await clickOption(page, 'STOCK ALL');
        await expect(box(page, 'STOCK ALL')).toBeChecked();
        await expect(box(page, 'STOCK IN STOCK')).not.toBeChecked();
        await expect(box(page, 'STOCK OUT OF STOCK')).not.toBeChecked();
      });

      // FREQ-44-AC-02 / AC-03
      test('SEASON: AW 選択中に SS を押すと両方選択、ALL で解除', async ({ page }) => {
        await gotoItemList(page);
        await openFilters(page, viewport.drawer);

        await clickOption(page, 'SEASON AW');
        await expect(box(page, 'SEASON AW')).toBeChecked();
        await expect(box(page, 'SEASON ALL')).not.toBeChecked();

        await clickOption(page, 'SEASON SS');
        await expect(box(page, 'SEASON SS')).toBeChecked();
        await expect(box(page, 'SEASON AW')).toBeChecked();

        await clickOption(page, 'SEASON ALL');
        await expect(box(page, 'SEASON ALL')).toBeChecked();
        await expect(box(page, 'SEASON AW')).not.toBeChecked();
        await expect(box(page, 'SEASON SS')).not.toBeChecked();
      });
    });
  }
});
