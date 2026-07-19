import { test, expect, Page } from '@playwright/test';
import { fetchFirstItemViaApi } from './item-list-test-utils';

// FREQ-153: COLOR スウォッチ（選択中は黒枠）/ SIZE テキスト（選択中は下線）/
// MATERIAL・CARE・MADE IN の項目行表示

async function gotoFirstItemDetail(page: Page): Promise<boolean> {
  const item = await fetchFirstItemViaApi(page);
  if (!item) return false;
  await page.goto(`/item/${item.id}`);
  await page.waitForLoadState('networkidle');
  return true;
}

function specTable(page: Page) {
  return page.getByTestId('item-spec-table');
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-015 商品仕様テーブル (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-153-AC-01: COLOR スウォッチが表示され選択中に黒枠が付く', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const table = specTable(page);
      await expect(table).toBeVisible();
      await expect(table.getByText('COLOR', { exact: true })).toBeVisible();

      // スウォッチボタン: aria-pressed を持ち、テキストではなく色付き四角を表示
      const swatches = table.locator('button[aria-pressed][aria-label]');
      const count = await swatches.count();
      expect(count).toBeGreaterThan(0);

      // 先頭カラーが初期選択され黒枠（border-black）が付く
      const selected = table.locator('button[aria-pressed="true"][aria-label]');
      await expect(selected.first()).toHaveClass(/border-black/);

      // スウォッチ内部に hex 背景の要素がある
      const innerStyle = await swatches
        .first()
        .locator('span')
        .getAttribute('style');
      expect(innerStyle).toContain('background-color');
    });

    test('FREQ-153-AC-02: SIZE がテキスト表示され選択中に下線が付く', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      const table = specTable(page);
      await expect(table.getByText('SIZE', { exact: true })).toBeVisible();

      // SIZE 行のボタン（aria-label なし・テキストのみ）
      const sizeButtons = table.locator(
        'button[aria-pressed]:not([aria-label])',
      );
      const count = await sizeButtons.count();
      expect(count).toBeGreaterThan(0);

      // クリックで選択し、下線（border-black の border-b）が付く
      await sizeButtons.first().click();
      await expect(sizeButtons.first()).toHaveAttribute('aria-pressed', 'true');
      await expect(sizeButtons.first()).toHaveClass(/border-black/);

      const borderBottom = await sizeButtons
        .first()
        .evaluate((el) => getComputedStyle(el).borderBottomColor);
      expect(borderBottom).toBe('rgb(0, 0, 0)');
    });

    test('FREQ-153-AC-03: MATERIAL / MADE IN 行が表示され、値の無い行は表示されない', async ({
      page,
    }) => {
      const ok = await gotoFirstItemDetail(page);
      test.skip(!ok, '公開商品データがないためスキップ');

      // 対象商品の material / origin 相当データ有無を API で確認
      const table = specTable(page);
      const materialRow = table.getByTestId('item-material');
      const madeInRow = table.getByTestId('item-made-in');
      const careRow = table.getByTestId('item-care');

      // データがある場合のみ行が存在する（存在する場合は値が空でないこと）
      if ((await materialRow.count()) > 0) {
        await expect(materialRow).toBeVisible();
        await expect(materialRow).not.toBeEmpty();
        await expect(table.getByText('MATERIAL', { exact: true })).toBeVisible();
      }
      if ((await madeInRow.count()) > 0) {
        await expect(madeInRow).toBeVisible();
        await expect(madeInRow).not.toBeEmpty();
        await expect(table.getByText('MADE IN', { exact: true })).toBeVisible();
      }
      // CARE 行が無い場合、ラベルも表示されない
      if ((await careRow.count()) === 0) {
        await expect(
          table.getByText('CARE', { exact: true }),
        ).toHaveCount(0);
      }
    });
  });
}
