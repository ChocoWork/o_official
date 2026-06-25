import { expect, Page, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-40-AC-01: 価格フィルタを適用してもPRICEスライダーの上限が縮まず、
// 再び最大価格までスライドできる（上下限を全商品の最大レンジで保持する）。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 900, drawer: false },
] as const;

// フィルターUI（デスクトップはサイドバー、モバイル/タブレットはDrawer）を開く。
async function openFilters(page: Page, useDrawer: boolean): Promise<void> {
  if (useDrawer) {
    await page.locator('[data-filter-button="floating"]').click();
  }
  // 表示中のPRICEスライダーの最大つまみが現れるまで待つ。
  await expect(maxThumb(page)).toBeVisible();
}

function maxThumb(page: Page) {
  return page.locator('input[aria-label="Maximum value"]:visible').first();
}

test.describe('FR-ITEM-ALL-017 PRICEスライダーの上下限が適用後も保持される', () => {
  for (const viewport of VIEWPORTS) {
    test.describe(`${viewport.name} (${viewport.width}px)`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } });

      test('価格上限を絞って適用しても最大つまみの上限値が縮まない', async ({ page }) => {
        await gotoItemList(page);
        await openFilters(page, viewport.drawer);

        const fullMax = await maxThumb(page).getAttribute('aria-valuemax');
        expect(fullMax).not.toBeNull();

        // 最大つまみを下限まで動かして価格上限を絞る。
        await maxThumb(page).focus();
        await maxThumb(page).press('Home');

        // APPLYボタンは廃止。操作停止後のデバウンス自動適用でURLにpriceMaxが付く。
        await page.waitForURL(/priceMax=/);

        // 適用後も上限値が適用前の最大価格と一致する（縮まない）。
        await expect(maxThumb(page)).toHaveAttribute('aria-valuemax', fullMax!);
      });
    });
  }
});
