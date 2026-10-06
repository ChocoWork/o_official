import { expect, test } from '@playwright/test';
import { mockCartApis, mockWishlistApis, sampleWishlistItem } from './shop-test-utils';

test.describe('FR-WISHLIST-008 aria-label と list role', () => {
  test('削除ボタンのaria-labelとカードリストroleを持つ', async ({ page }) => {
    // 空表示や実 API のエラーを成功扱いせず、商品入りの画面で ARIA の契約を確認する。
    await mockCartApis(page, []);
    await mockWishlistApis(page, [sampleWishlistItem()]);
    await page.goto('/wishlist');

    const list = page.getByRole('list', { name: 'ウィッシュリスト商品一覧' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem')).toBeVisible();
    const removeButton = list.getByRole('button', { name: 'ウィッシュリストから削除' });
    await expect(removeButton).toBeVisible();
    await expect(removeButton).toHaveAttribute('aria-label', 'ウィッシュリストから削除');
  });
});
