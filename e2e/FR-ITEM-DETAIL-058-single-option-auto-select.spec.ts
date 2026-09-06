import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-345: 選択肢が 1 つの軸は自動選択、2 つ以上の軸は未選択。
// 選択肢のある軸がすべて選ばれるまで ADD TO CART は押せない。

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const BLACK = { hex: '#000000', name: 'Black' };
const IVORY = { hex: '#f5f5f5', name: 'Ivory' };

async function openItemDetail(
  page: Page,
  overrides: Parameters<typeof sampleItemDetail>[0],
): Promise<void> {
  const item = sampleItemDetail(overrides);
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function addToCartButton(page: Page) {
  return page
    .getByTestId('item-actions-main')
    .getByRole('button', { name: /ADD TO CART/ });
}

function sizeButtons(page: Page) {
  return page.getByTestId('item-size-select').locator('button');
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-ITEM-DETAIL-058 単一選択肢の自動選択 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-345-AC-01: COLOR / SIZE が各1つなら両方選択済みで ADD TO CART が有効', async ({
      page,
    }) => {
      await openItemDetail(page, { colors: [BLACK], sizes: ['M'] });

      await expect(page.getByRole('button', { name: 'Black' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(sizeButtons(page).first()).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(addToCartButton(page)).toBeEnabled();
    });

    test('FREQ-345-AC-02: COLOR が複数なら COLOR は未選択で ADD TO CART が無効', async ({
      page,
    }) => {
      await openItemDetail(page, { colors: [BLACK, IVORY], sizes: ['M'] });

      await expect(page.getByRole('button', { name: 'Black' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(page.getByRole('button', { name: 'Ivory' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      // SIZE は 1 つなので自動選択される
      await expect(sizeButtons(page).first()).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(addToCartButton(page)).toBeDisabled();
    });

    test('FREQ-345-AC-03: SIZE が複数なら SIZE は未選択で ADD TO CART が無効', async ({
      page,
    }) => {
      await openItemDetail(page, { colors: [BLACK], sizes: ['S', 'M'] });

      await expect(page.getByRole('button', { name: 'Black' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(sizeButtons(page).first()).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(sizeButtons(page).nth(1)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(addToCartButton(page)).toBeDisabled();
    });

    test('FREQ-345-AC-04: 両方複数のとき、両方を選ぶと ADD TO CART が有効になる', async ({
      page,
    }) => {
      await openItemDetail(page, { colors: [BLACK, IVORY], sizes: ['S', 'M'] });

      await expect(addToCartButton(page)).toBeDisabled();

      await page.getByRole('button', { name: 'Ivory' }).click();
      await expect(addToCartButton(page)).toBeDisabled();

      await sizeButtons(page).nth(1).click();
      await expect(addToCartButton(page)).toBeEnabled();
    });
  });
}
