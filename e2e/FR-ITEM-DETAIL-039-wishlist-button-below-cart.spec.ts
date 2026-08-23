import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

const item = sampleItemDetail();

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function actions(page: Page) {
  const root = page.getByTestId('item-actions-main');
  return {
    cart: root.getByRole('button', { name: /ADD TO CART|SOLD OUT/ }),
    wishlist: root.getByRole('button', { name: 'Add to wishlist' }),
  };
}

test.describe('FR-ITEM-DETAIL-039 wishlist button below add to cart', () => {
  for (const viewport of [
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    test(`FREQ-285-AC-01: ${viewport.name}（${viewport.width}px）ではWISHLISTがADD TO CARTの下に表示される`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await openItemDetail(page);

      const { cart, wishlist } = actions(page);
      await expect(wishlist.getByText('ADD TO WISHLIST')).toBeVisible();

      const cartBox = await cart.boundingBox();
      const wishlistBox = await wishlist.boundingBox();
      expect(cartBox).not.toBeNull();
      expect(wishlistBox).not.toBeNull();
      expect(wishlistBox!.y).toBeGreaterThan(cartBox!.y + cartBox!.height - 1);
      expect(wishlistBox!.width).toBeCloseTo(cartBox!.width, 0);
    });
  }

  test('FREQ-285-AC-01: mobile（390px）ではWISHLISTがADD TO CARTと同じ行のアイコンのみ表示', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openItemDetail(page);

    const { cart, wishlist } = actions(page);
    await expect(wishlist.getByText('ADD TO WISHLIST')).toBeHidden();

    const cartBox = await cart.boundingBox();
    const wishlistBox = await wishlist.boundingBox();
    expect(cartBox).not.toBeNull();
    expect(wishlistBox).not.toBeNull();
    expect(wishlistBox!.y).toBeCloseTo(cartBox!.y, 0);
    expect(wishlistBox!.x).toBeGreaterThan(cartBox!.x);
  });
});
