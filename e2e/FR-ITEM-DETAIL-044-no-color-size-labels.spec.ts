import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-292: 商品仕様テーブルの COLOR / SIZE ラベルを削除する

const item = sampleItemDetail({
  name: 'Short Sleeveless Vest',
  price: 24800,
});

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-044 COLOR / SIZE ラベル非表示 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-292-AC-01: ラベルは出ないが選択肢は表示・選択できる', async ({
      page,
    }) => {
      await openItemDetail(page);

      const table = page.getByTestId('item-spec-table');
      await expect(table).toBeVisible();

      // AC-01: COLOR / SIZE のラベルテキストが存在しない
      await expect(table.getByText('COLOR', { exact: true })).toHaveCount(0);
      await expect(table.getByText('SIZE', { exact: true })).toHaveCount(0);

      // カラースウォッチは従来どおり表示される
      const swatches = table.locator('button[aria-pressed][aria-label]');
      expect(await swatches.count()).toBeGreaterThan(0);
      await expect(swatches.first()).toBeVisible();

      // サイズボタンは従来どおり表示・選択できる
      const sizeButtons = table.locator(
        'button[aria-pressed]:not([aria-label])',
      );
      expect(await sizeButtons.count()).toBeGreaterThan(0);
      await sizeButtons.first().click();
      await expect(sizeButtons.first()).toHaveAttribute('aria-pressed', 'true');
    });
  });
}
