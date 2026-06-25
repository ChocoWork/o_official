import { expect, Page, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-45: ITEM 一覧の FILTER の文字サイズ・余白を stein / HYKE を参考に調整する。
// AC-01: セクション見出し（CATEGORY 等）と直下の最初の選択肢の縦間隔が、選択肢同士の縦間隔より広い。
// AC-02: 選択肢ラベルの文字サイズが 10px 以上 13px 以下。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, drawer: true },
  { name: 'tablet', width: 768, height: 1024, drawer: true },
  { name: 'desktop', width: 1280, height: 900, drawer: false },
] as const;

// ビューポートごとに FILTER UI を開き、操作対象のルート要素を返す。
async function openFilter(page: Page, useDrawer: boolean) {
  if (useDrawer) {
    const filterButton = page.locator('[data-filter-button="floating"]');
    await filterButton.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    return drawer;
  }
  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeVisible();
  return sidebar;
}

for (const vp of VIEWPORTS) {
  test.describe(`FR-ITEM-ALL-022 FILTER タイポグラフィ・余白 (${vp.name})`, () => {
    test('見出し↔選択肢の間隔が選択肢同士より広く、ラベルは10〜13px', async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoItemList(page);

      const root = await openFilter(page, vp.drawer);

      // CATEGORY セクション（最初のアコーディオン項目）を特定する。
      const categoryTrigger = root
        .locator('[data-ui-accordion-trigger]', { hasText: 'CATEGORY' })
        .first();
      await expect(categoryTrigger).toBeVisible();

      const categoryItem = root.locator('[data-ui-accordion-item]').filter({
        has: page.locator('[data-ui-accordion-trigger]', { hasText: 'CATEGORY' }),
      });
      const rows = categoryItem.locator('[data-ui-checkbox]');
      await expect(rows.nth(1)).toBeVisible();

      const triggerBox = await categoryTrigger.boundingBox();
      const firstRowBox = await rows.nth(0).boundingBox();
      const secondRowBox = await rows.nth(1).boundingBox();
      expect(triggerBox).not.toBeNull();
      expect(firstRowBox).not.toBeNull();
      expect(secondRowBox).not.toBeNull();

      // AC-01: 親（見出し）↔子（最初の選択肢）の縦間隔 > 子↔子の縦間隔
      const gapParentChild = firstRowBox!.y - (triggerBox!.y + triggerBox!.height);
      const gapChildChild = secondRowBox!.y - (firstRowBox!.y + firstRowBox!.height);
      expect(gapParentChild).toBeGreaterThan(gapChildChild);

      // AC-02: 選択肢ラベルの文字サイズが 10〜13px
      const label = rows.nth(0).locator('[data-ui-checkbox-label]');
      const fontSize = await label.evaluate(
        (el) => parseFloat(getComputedStyle(el).fontSize),
      );
      expect(fontSize).toBeGreaterThanOrEqual(10);
      expect(fontSize).toBeLessThanOrEqual(13);
    });
  });
}
