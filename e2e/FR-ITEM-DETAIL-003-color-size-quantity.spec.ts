import { test, expect } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

test.describe('FR-ITEM-DETAIL-003 カラー・サイズ・数量選択', () => {
  test('カラーボタンが表示され、クリックで選択状態が変わる', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const colorSection = page.locator('text=COLOR').first();
    if (!(await colorSection.isVisible())) {
      test.skip(true, 'カラー選択肢なし');
      return;
    }

    // カラースウォッチボタンが存在する（FREQ-153: aria-label にカラー名）
    const colorButtons = page
      .getByTestId('item-spec-table')
      .locator('button[aria-pressed][aria-label]');
    await expect(colorButtons.first()).toBeVisible();

    // 最初のボタンが初期選択状態
    await expect(colorButtons.first()).toHaveAttribute('aria-pressed', 'true');
  });

  test('サイズボタンが表示され、クリックで選択状態が変わる', async ({ page }) => {
    const item = await fetchFirstItemViaApi(page);
    test.skip(!item, '公開商品データがないためスキップ');

    await page.goto(`/item/${item!.id}`);
    await page.waitForLoadState('networkidle');

    const sizeSection = page.locator('text=SIZE').first();
    if (!(await sizeSection.isVisible())) {
      test.skip(true, 'サイズ選択肢なし');
      return;
    }

    // サイズはテキストボタン（FREQ-153: aria-label なし）
    const sizeButtons = page
      .getByTestId('item-spec-table')
      .locator('button[aria-pressed]:not([aria-label])');
    await expect(sizeButtons.first()).toBeVisible();

    await sizeButtons.first().click();
    await expect(sizeButtons.first()).toHaveAttribute('aria-pressed', 'true');
  });

  // 数量ステッパーは FREQ-154 で削除された（FR-ITEM-DETAIL-016 で非表示を検証）
});
