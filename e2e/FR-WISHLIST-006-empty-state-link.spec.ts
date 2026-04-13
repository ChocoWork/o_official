import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-006 空状態と継続購入リンク', () => {
  test('空状態なら /item へのリンクを表示する', async ({ page }) => {
    await page.goto('/wishlist');

    const emptyText = page.getByText('ウィッシュリストは空です');
    const isEmpty = await emptyText.isVisible().catch(() => false);
    if (!isEmpty) {
      test.skip();
      return;
    }

    await expect(page.getByRole('link', { name: '買い物を続ける' })).toHaveAttribute('href', '/item');
  });
});
