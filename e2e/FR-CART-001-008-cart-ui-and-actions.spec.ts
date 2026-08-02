import { expect, test } from '@playwright/test';
import { expectCartBadge, mockCartApis, sampleCartItem } from './shop-test-utils';

test.describe('FR-CART-001/003/004/008 cart ui and actions', () => {
  test('商品情報を表示し、数量変更と削除でUIとバッジを更新する', async ({ page }) => {
    const cartMocks = await mockCartApis(page, [
      sampleCartItem(),
      sampleCartItem({
        id: 'cart-2',
        item_id: 202,
        quantity: 2,
        color: 'Ivory',
        size: 'S',
        items: {
          id: 202,
          name: 'Tailored Pants',
          price: 18000,
          image_url: '/images/test-item-2.jpg',
          category: 'BOTTOMS',
        },
      }),
    ]);

    await page.goto('/cart');

    await expect(page.getByRole('link', { name: 'Silk Blouse', exact: true }).last()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tailored Pants', exact: true }).last()).toBeVisible();
    await expect(page.getByText('COLOR', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Black', { exact: true })).toBeVisible();
    await expect(page.getByText('SIZE', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('M', { exact: true })).toBeVisible();
    await expect(page.locator('a[href="/item/101"]', { hasText: 'Silk Blouse' })).toBeVisible();
    await expectCartBadge(page, 3);

    const quantityInput = page.locator('input[type="number"]').first();
    await page.getByLabel('increase').first().click();
    await page.getByLabel('increase').first().click();
    await expect(quantityInput).toHaveValue('3');

    await expect
      .poll(() => cartMocks.patchBodies.length, { timeout: 3000 })
      .toBe(1);
    expect(cartMocks.patchBodies[0]).toEqual({ id: 'cart-1', quantity: 3 });
    await expectCartBadge(page, 5);

    page.once('dialog', async (dialog) => {
      await dialog.dismiss();
    });

    await page.getByRole('button', { name: 'カートから削除' }).first().click();
    await expect(page.locator('a[href="/item/101"]', { hasText: 'Silk Blouse' })).toHaveCount(0);
    await expectCartBadge(page, 2);
    expect(cartMocks.deleteIds).toContain('cart-1');
  });
});
