import { expect, test } from '@playwright/test';

test.describe('FR-CHECKOUT-007 決済前在庫チェック', () => {
  test('チェックアウトページで create-session の 409 を在庫切れメッセージとして表示する', async ({ page }) => {
    await page.route('**/api/cart', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'cart-1',
            item_id: 1,
            quantity: 2,
            color: 'BLACK',
            size: 'M',
            added_at: new Date().toISOString(),
            items: {
              id: 1,
              name: '在庫テスト商品',
              price: 5000,
              image_url: '/images/test-item.jpg',
              category: 'TOPS',
            },
          },
        ]),
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

    await page.goto('/checkout');

    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="fullName"]', 'テスト太郎');
    await page.fill('input[name="postalCode"]', '100-0001');
    await page.fill('input[name="city"]', '千代田区');
    await page.fill('input[name="address"]', '丸の内1-1-1');
    await page.fill('input[name="phone"]', '09000000000');

    await page.locator('label:has-text("都道府県") button').click();
    await page.getByRole('button', { name: '東京都', exact: true }).click();

    await page.getByRole('button', { name: '次へ' }).first().click();
    await expect(page.getByText('以下の商品の在庫が不足しています: 在庫テスト商品（要求 2 / 在庫 1）')).toBeVisible();
  });
});
