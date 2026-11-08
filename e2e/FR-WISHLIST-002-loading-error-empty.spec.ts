import { expect, test } from '@playwright/test';
import { mockCartApis, mockWishlistApis, sampleWishlistItem } from './shop-test-utils';

test.describe('FR-WISHLIST-002 loading/error/empty', () => {
  test('読み込み完了後に空状態と継続購入リンクを表示する', async ({ page }) => {
    await mockCartApis(page, []);
    let completeLoading!: () => void;
    const loading = new Promise<void>((resolve) => { completeLoading = resolve; });
    await page.route('**/api/wishlist', async (route) => {
      await loading;
      await route.fulfill({ json: [] });
    });
    await page.goto('/wishlist');
    try {
      await expect(page.locator('main .animate-pulse').first()).toBeVisible();
    } finally {
      completeLoading();
    }
    await expect(page.getByText('WISHLIST IS EMPTY', { exact: true })).toBeVisible();
    const continueShopping = page.getByRole('link', { name: 'Continue Shopping', exact: true });
    await expect(continueShopping).toBeVisible();
    await expect(continueShopping).toHaveAttribute('href', '/item');
    await expect(page.locator('main .animate-pulse')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'ウィッシュリスト商品一覧' })).toHaveCount(0);
  });

  test('取得失敗時にエラーを表示する', async ({ page }) => {
    await mockCartApis(page, []);
    await page.route('**/api/wishlist', (route) => route.fulfill({ status: 500, json: { error: 'failed' } }));
    await page.goto('/wishlist');
    await expect(page.getByText('ウィッシュリストの取得に失敗しました', { exact: true })).toBeVisible();
    await expect(page.getByText('WISHLIST IS EMPTY', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'ウィッシュリスト商品一覧' })).toHaveCount(0);
  });

  test('取得した商品を一覧に表示する', async ({ page }) => {
    const item = sampleWishlistItem();
    await mockCartApis(page, []);
    await mockWishlistApis(page, [item]);
    await page.goto('/wishlist');
    const list = page.getByRole('list', { name: 'ウィッシュリスト商品一覧' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    const itemLink = list.getByRole('link').filter({ has: page.getByTestId('item-info') });
    await expect(itemLink).toBeVisible();
    await expect(itemLink).toContainText(item.items!.name);
    await expect(itemLink).toHaveAttribute('href', `/item/${item.item_id}`);
    await expect(page.getByText('WISHLIST IS EMPTY', { exact: true })).toHaveCount(0);
  });
});
