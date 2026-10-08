import { expect, test } from '@playwright/test';
import { fillShippingForm, stubPostalCode } from './checkout-flow-helpers';
import { sampleCartItem, toCartJson } from './shop-test-utils';

test.describe('FR-CHECKOUT-007 購入不可明細を外した案内', () => {
  test('409 cart_updated は入力画面で案内し、確認へ進めるままにする', async ({ page }) => {
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
          error: 'cart_updated',
          retryable: true,
          message: '次の商品はお求めいただけなくなったため、カートから外しました: 在庫テスト商品（BLACK / M）。内容をご確認のうえ、もう一度「確認へ進む」を押してください。',
        }),
      });
    });

    await stubPostalCode(page);
    await page.goto('/checkout');
    await fillShippingForm(page, 'e2e-checkout-error@example.com');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await expect(page.getByText('次の商品はお求めいただけなくなったため、カートから外しました: 在庫テスト商品（BLACK / M）。内容をご確認のうえ、もう一度「確認へ進む」を押してください。')).toBeVisible();
    await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
    await expect(page).toHaveURL(/\/checkout$/);
  });
});
