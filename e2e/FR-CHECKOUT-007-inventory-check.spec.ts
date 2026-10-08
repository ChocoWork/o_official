import { expect, test } from '@playwright/test';
import { fillShippingForm, stubPostalCode } from './checkout-flow-helpers';
import { sampleCartItem, toCartJson } from './shop-test-utils';

test.describe('FR-CHECKOUT-007 決済前在庫チェック', () => {
  test('確認へ進むで create-session の 409 を買えない商品の案内として表示する', async ({ page }) => {
    // カートの窓口の応答（CartJson）。決済の入力画面が読むカートを、買えない商品を含む形に固定する
    await page.route('**/api/cart', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          toCartJson([
            sampleCartItem({
              id: 'cart-1',
              item_id: 1,
              quantity: 2,
              color: 'BLACK',
              size: 'M',
              items: {
                id: 1,
                name: '在庫テスト商品',
                price: 5000,
                image_url: '/images/test-item.jpg',
                category: 'TOPS',
              },
            }),
          ]),
        ),
      });
    });

    await page.route('**/api/checkout/create-session', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'out_of_stock',
          message: '以下の商品の在庫が不足しています: 在庫テスト商品（要求 2 / 在庫 1）',
        }),
      });
    });

    await stubPostalCode(page);
    await page.goto('/checkout');
    await fillShippingForm(page, 'e2e-checkout-error@example.com');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await expect(page.getByText('以下の商品の在庫が不足しています: 在庫テスト商品（要求 2 / 在庫 1）')).toBeVisible();
  });
});
