import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-296: カラースウォッチを参考サイト（roheframes）実測サイズに合わせる
// 外形 23px（1px 枠 + 1px 余白）/ 塗り 19px / 間隔 15px / 選択中は黒枠

const item = sampleItemDetail({
  colors: [
    { hex: '#000000', name: 'Black' },
    { hex: '#f5f5f5', name: 'Ivory' },
  ],
});

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function borderColor(page: Page, index: number) {
  return page
    .getByTestId('item-spec-table')
    .locator('button[aria-label]')
    .nth(index)
    .evaluate((el) => getComputedStyle(el).borderTopColor);
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-046 カラースウォッチ (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-296-AC-01/AC-02: 外形23px・塗り19px・間隔15px・選択中は黒枠', async ({
      page,
    }) => {
      await openItemDetail(page);

      const swatches = page
        .getByTestId('item-spec-table')
        .locator('button[aria-label]');
      await expect(swatches).toHaveCount(2);

      // AC-01: 外形 23px / 塗り 19px
      const first = await swatches.first().boundingBox();
      const fill = await swatches.first().locator('span').boundingBox();
      expect(first).not.toBeNull();
      expect(fill).not.toBeNull();
      expect(first!.width).toBeCloseTo(23, 0);
      expect(first!.height).toBeCloseTo(23, 0);
      expect(fill!.width).toBeCloseTo(19, 0);
      expect(fill!.height).toBeCloseTo(19, 0);

      // AC-02: 間隔 15px
      const second = await swatches.nth(1).boundingBox();
      expect(second).not.toBeNull();
      expect(second!.x - (first!.x + first!.width)).toBeCloseTo(15, 0);

      // AC-02: 選んだ 1 つだけ黒枠（色の遷移中を拾わないよう poll する）
      // FREQ-345: 選択肢が複数あるので初期状態は未選択
      await swatches.first().click();
      await expect(swatches.first()).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => borderColor(page, 0)).toBe('rgb(0, 0, 0)');
      expect(await borderColor(page, 1)).not.toBe('rgb(0, 0, 0)');

      // 2 番目を選ぶと黒枠が移動する
      await swatches.nth(1).click();
      await expect(swatches.nth(1)).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => borderColor(page, 1)).toBe('rgb(0, 0, 0)');
      await expect.poll(() => borderColor(page, 0)).not.toBe('rgb(0, 0, 0)');
    });
  });
}
