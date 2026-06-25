import { expect, test } from '@playwright/test';
import { gotoItemList } from './item-list-test-utils';

// FREQ-43-AC-01: 検索結果の有無で FILTER 列・ITEM 列の横幅が変わらない（デスクトップ）。
test.describe('FR-ITEM-ALL-020 列幅が結果の有無で変化しない', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('0件時と商品あり時で aside と ITEM 列の幅が一致する', async ({ page }) => {
    // 商品がある通常状態
    await gotoItemList(page);
    const asideWithItems = await page.locator('aside').first().boundingBox();
    const colWithItems = await page
      .getByTestId('item-content-column')
      .boundingBox();
    expect(asideWithItems).not.toBeNull();
    expect(colWithItems).not.toBeNull();

    // 確実に0件になる価格条件で再表示
    await gotoItemList(page, '?priceMin=99999999');
    await expect(page.getByText('商品が見つかりません')).toBeVisible();
    const asideEmpty = await page.locator('aside').first().boundingBox();
    const colEmpty = await page.getByTestId('item-content-column').boundingBox();
    expect(asideEmpty).not.toBeNull();
    expect(colEmpty).not.toBeNull();

    expect(Math.round(asideEmpty!.width)).toBe(Math.round(asideWithItems!.width));
    expect(Math.round(colEmpty!.width)).toBe(Math.round(colWithItems!.width));
  });
});
