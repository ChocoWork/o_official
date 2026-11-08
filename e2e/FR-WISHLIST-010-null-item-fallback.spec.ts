import { expect, test } from '@playwright/test';
import { mockCartApis, mockWishlistApis, sampleWishlistItem } from './shop-test-utils';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

for (const vp of viewports) {
  test.describe(`FR-WISHLIST-010 null item フォールバック (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockCartApis(page, []);
    });

    test('item.items が null の行でもクラッシュせずフォールバックUIを表示する', async ({ page }) => {
      // items が null の行と、通常の行を 1 件ずつ返す
      await mockWishlistApis(page, [
        sampleWishlistItem({ id: 'wishlist-null', item_id: 202, items: null, variants: [] }),
        sampleWishlistItem(),
      ]);
      await page.goto('/wishlist');

      await expect(page.getByRole('heading', { level: 1, name: 'Wishlist' })).toBeVisible();
      const list = page.getByRole('list', { name: 'ウィッシュリスト商品一覧' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByText('商品情報を取得できませんでした', { exact: true })).toHaveCount(1);
      await expect(list.getByText('Silk Blouse').first()).toBeVisible();
    });

    test('お気に入りが空でも h1 が 1 つあり、空の表示は変わらない', async ({ page }) => {
      await mockWishlistApis(page, []);
      await page.goto('/wishlist');

      await expect(page.getByRole('heading', { level: 1, name: 'Wishlist' })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: 'Wishlist' })).toBeVisible();
      await expect(page.getByText('WISHLIST IS EMPTY', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Continue Shopping', exact: true })).toHaveAttribute('href', '/item');
    });
  });
}
