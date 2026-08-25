import { expect, Page, test } from '@playwright/test';
import {
  mockCartApis,
  mockItemDetailApis,
  sampleItemDetail,
} from './shop-test-utils';

// FREQ-299: md 以上では ADD TO WISHLIST を廃し、商品名の右端にハートのみを置く

const item = sampleItemDetail({ name: 'Short Sleeveless Vest' });

async function openItemDetail(page: Page): Promise<void> {
  await mockCartApis(page, []);
  await mockItemDetailApis(page, item, []);
  await page.goto('/item/101');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

function bookmarkButton(page: Page) {
  return page.getByTestId('item-wishlist-icon');
}

function actionsWishlist(page: Page) {
  return page
    .getByTestId('item-actions-main')
    .getByRole('button', { name: 'Add to wishlist' });
}

function addToCartButton(page: Page) {
  return page
    .getByTestId('item-actions-main')
    .getByRole('button', { name: /ADD TO CART|SOLD OUT/ })
    .first();
}

for (const viewport of [
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  test.describe(`FR-ITEM-DETAIL-049 アイコンのみのウィッシュリスト (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-299-AC-01: ADD TO WISHLIST のテキストボタンが表示されない', async ({
      page,
    }) => {
      await openItemDetail(page);

      await expect(page.getByText('ADD TO WISHLIST')).toHaveCount(0);
      await expect(actionsWishlist(page)).toBeHidden();
    });

    test('FREQ-299-AC-02: ブックマークが商品名の行に並び右端が ADD TO CART と一致する', async ({
      page,
    }) => {
      await openItemDetail(page);

      const bookmark = bookmarkButton(page);
      await expect(bookmark).toBeVisible();

      const bookmarkBox = await bookmark.boundingBox();
      const nameBox = await page.getByRole('heading', { level: 1 }).boundingBox();
      const cartBox = await addToCartButton(page).boundingBox();
      expect(bookmarkBox).not.toBeNull();
      expect(nameBox).not.toBeNull();
      expect(cartBox).not.toBeNull();

      // 商品名と同じ行（縦方向に重なる）
      expect(bookmarkBox!.y).toBeLessThan(nameBox!.y + nameBox!.height);
      expect(bookmarkBox!.y + bookmarkBox!.height).toBeGreaterThan(nameBox!.y);
      // 商品名より右
      expect(bookmarkBox!.x).toBeGreaterThan(nameBox!.x);
      // 右端が ADD TO CART と一致
      expect(bookmarkBox!.x + bookmarkBox!.width).toBeCloseTo(
        cartBox!.x + cartBox!.width,
        0,
      );
    });
  });
}

test.describe('FR-ITEM-DETAIL-049 アイコンのみのウィッシュリスト (mobile)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('FREQ-299-AC-03: mobile は従来どおり ADD TO CART の右隣にアイコンが出る', async ({
    page,
  }) => {
    await openItemDetail(page);

    await expect(bookmarkButton(page)).toBeHidden();

    const wishlist = actionsWishlist(page);
    await expect(wishlist).toBeVisible();

    const wishlistBox = await wishlist.boundingBox();
    const cartBox = await addToCartButton(page).boundingBox();
    expect(wishlistBox).not.toBeNull();
    expect(cartBox).not.toBeNull();
    expect(wishlistBox!.y).toBeCloseTo(cartBox!.y, 0);
    expect(wishlistBox!.x).toBeGreaterThan(cartBox!.x);
  });
});
