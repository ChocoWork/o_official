import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-305: サイズは Admin の選択肢の並び（S → M → L → FREE）で表示する

async function openItemDetail(page: Page, sizes: string[]): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, sampleItemDetail({ sizes }), []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function sizeLabels(page: Page) {
  return page.getByTestId('item-size-select').locator('button');
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-054 サイズの並び順 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-305-AC-01: L, M, S で保存されていても S, M, L の順で出る', async ({
      page,
    }) => {
      await openItemDetail(page, ['L', 'M', 'S']);

      await expect(sizeLabels(page)).toHaveText(['S', 'M', 'L']);
    });

    test('FREQ-305-AC-02: FREE は末尾に出る', async ({ page }) => {
      await openItemDetail(page, ['FREE', 'M', 'S']);

      await expect(sizeLabels(page)).toHaveText(['S', 'M', 'FREE']);
    });
  });
}
