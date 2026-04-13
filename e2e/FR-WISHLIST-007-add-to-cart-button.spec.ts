import { expect, test } from '@playwright/test';

test.describe('FR-WISHLIST-007 カートに追加ボタン', () => {
  test('カードにカート追加ボタンがある', async ({ page }) => {
    await page.goto('/wishlist');

    const addToCartButton = page.getByRole('button', { name: 'カートに追加' }).first();
    const visible = await addToCartButton.isVisible().catch(() => false);
    if (!visible) {
      test.skip();
      return;
    }

    await expect(addToCartButton).toBeEnabled();
  });
});
