import { expect, test } from '@playwright/test';
import { gotoItemList, itemCards } from './item-list-test-utils';

// FREQ-124: ITEM 一覧カードから在庫（数量：残り〇点／受注生産）の表示を削除する。
// カラースウォッチ（色）は維持する。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

test.describe('FR-ITEM-ALL-029 カードの在庫（数量）表示を削除', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: item-stock が表示されない`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoItemList(page);

      await expect(itemCards(page).first()).toBeVisible();

      // FREQ-124-AC-01: 在庫表示（item-stock）が存在しない
      await expect(page.locator('[data-testid="item-stock"]')).toHaveCount(0);
    });
  }
});
