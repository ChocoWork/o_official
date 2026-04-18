import { expect, test } from '@playwright/test';
import {
  mockCartApis,
  mockWishlistApis,
  sampleWishlistItem,
} from './shop-test-utils';

test.describe('FR-WISHLIST-003/004/006/007/008/010 wishlist behavior', () => {
  test('カード表示・削除・カート追加・ARIA role を確認する', async ({ page }) => {
    await mockCartApis(page, []);
    const wishlistMocks = await mockWishlistApis(page, [sampleWishlistItem()]);

    await page.goto('/wishlist');

    const wishlistList = page.getByRole('list', { name: 'ウィッシュリスト商品一覧' });

    const firstItem = wishlistList.getByRole('listitem').first();

    await expect(wishlistList).toBeVisible();
    await expect(wishlistList.getByRole('listitem')).toHaveCount(1);
    await expect(firstItem.getByText('TOPS')).toBeVisible();
    await expect(firstItem.getByRole('heading', { level: 3, name: 'Silk Blouse' })).toBeVisible();
    await expect(firstItem.getByText('¥12,000')).toBeVisible();
    await expect(firstItem.getByRole('link', { name: 'Silk Blouse', exact: true })).toHaveAttribute('href', '/item/101');
    await expect(page.getByRole('button', { name: 'ウィッシュリストから削除' })).toBeVisible();

    await page.getByRole('button', { name: 'カートに追加' }).click();
    await expect(page.getByRole('status')).toHaveText('カートに追加しました。');

    await page.getByRole('button', { name: 'ウィッシュリストから削除' }).click();
    expect(wishlistMocks.deleteIds).toContain('wishlist-1');
    await expect(page.getByText('ウィッシュリストは空です')).toBeVisible();
    await expect(page.getByRole('link', { name: '買い物を続ける' })).toHaveAttribute('href', '/item');
  });

  test('item.items が null の場合はフォールバック UI を表示する', async ({ page }) => {
    await mockCartApis(page, []);
    await mockWishlistApis(page, [sampleWishlistItem({ id: 'wishlist-2', items: null })]);

    await page.goto('/wishlist');

    await expect(page.getByText('商品情報を取得できませんでした')).toBeVisible();
    await expect(page.getByText('削除済み商品')).toBeVisible();
  });
});