import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-298: SIZE 選択を角の四角い枠付きボタンにし、幅を ADD TO CART に合わせる

async function openItemDetail(page: Page, sizes: string[]): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, sampleItemDetail({ sizes }), []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function sizeButtons(page: Page) {
  return page.getByTestId('item-size-select').locator('button');
}

function addToCartButton(page: Page) {
  return page
    .getByTestId('item-actions-main')
    .getByRole('button', { name: /ADD TO CART|SOLD OUT/ })
    .first();
}

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-048 SIZE 選択 (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-298-AC-01: 複数選択肢の左右端が ADD TO CART と一致する', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      await expect(buttons).toHaveCount(5);

      const cart = await addToCartButton(page).boundingBox();
      const first = await buttons.first().boundingBox();
      const last = await buttons.last().boundingBox();
      expect(cart).not.toBeNull();
      expect(first).not.toBeNull();
      expect(last).not.toBeNull();

      expect(first!.x).toBeCloseTo(cart!.x, 0);
      expect(last!.x + last!.width).toBeCloseTo(cart!.x + cart!.width, 0);
    });

    test('FREQ-298-AC-02: 選択肢が1つのとき ADD TO CART の1/3幅になる', async ({
      page,
    }) => {
      await openItemDetail(page, ['M']);

      const buttons = sizeButtons(page);
      await expect(buttons).toHaveCount(1);

      const cart = await addToCartButton(page).boundingBox();
      const only = await buttons.first().boundingBox();
      expect(cart).not.toBeNull();
      expect(only).not.toBeNull();
      expect(only!.width).toBeCloseTo(cart!.width / 3, 0);
    });

    // FREQ-301 で塗りつぶしは撤回。配色は FR-ITEM-DETAIL-051 で検証する
    test('FREQ-298-AC-03: 選択中だけ aria-pressed=true で角丸なし', async ({
      page,
    }) => {
      await openItemDetail(page, ['XS', 'S', 'M', 'L', 'XL']);

      const buttons = sizeButtons(page);
      await buttons.nth(2).click();

      await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');
      await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');

      const radius = await buttons
        .nth(2)
        .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      expect(radius).toBe('0px');
    });
  });
}
