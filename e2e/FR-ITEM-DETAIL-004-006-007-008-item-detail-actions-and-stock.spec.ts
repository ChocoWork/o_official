import { expect, test } from '@playwright/test';
import { mockCartApis, mockItemDetailApis, sampleItemDetail } from './shop-test-utils';

test.describe('FR-ITEM-DETAIL-004/006/007/008 item detail actions and stock', () => {
  test('未選択エラー・在庫表示・モバイル固定CTA・カート追加を確認する', async ({ page }) => {
    const item = sampleItemDetail({ stock_quantity: 2 });
    const cartMocks = await mockCartApis(page, []);
    await mockItemDetailApis(page, item, []);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/item/101');

    await expect(page.getByTestId('stock-status')).toHaveText('残りわずか');

    await page.getByRole('button', { name: 'ADD TO CART' }).first().click();
    await expect(page.getByText('すべてのオプションを選択してください')).toBeVisible();

    await page.getByRole('button', { name: 'M', exact: true }).click();
    await page.getByRole('button', { name: 'ADD TO CART' }).first().click();

    await expect.poll(() => cartMocks.postBodies.length).toBe(1);
    expect(cartMocks.postBodies[0]).toMatchObject({
      item_id: 101,
      quantity: 1,
      color: 'Black',
      size: 'M',
    });

    await expect(page.getByRole('button', { name: 'Add to wishlist' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'ADD TO CART' }).last()).toBeVisible();
  });

  test('売り切れ商品では SOLD OUT 表示と disabled 状態になる', async ({ page }) => {
    const soldOutItem = sampleItemDetail({ stock_quantity: 0, sizes: ['M'] });
    await mockCartApis(page, []);
    await mockItemDetailApis(page, soldOutItem, []);

    await page.goto('/item/101');

    await expect(page.getByTestId('stock-status')).toHaveText('SOLD OUT');
    await expect(page.getByRole('button', { name: 'SOLD OUT' }).first()).toBeDisabled();
  });
});