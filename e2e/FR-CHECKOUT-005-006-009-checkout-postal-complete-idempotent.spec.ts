import { expect, test } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import {
  rememberPaymentAttemptBeforeLoad,
  stubCheckoutSessionApis,
  stubResumePaymentDone,
} from './checkout-test-utils';

test.describe('FR-CHECKOUT-005/006/009 checkout postal complete idempotent', () => {
  test('郵便番号から住所を自動補完する', async ({ page }) => {
    await stubCheckoutSessionApis(page);
    await mockCartApis(page, [sampleCartItem()]);
    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });
    await page.route('**/api/checkout/postal-code?postalCode=1500001', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          address: {
            prefecture: '東京都',
            city: '渋谷区',
            address: '神宮前1-2-3',
          },
        }),
      });
    });

    await page.goto('/checkout');

    await page.getByLabel('郵便番号').fill('1500001');
    await expect(page.getByRole('combobox', { name: '都道府県' })).toContainText('東京都');
    await expect(page.getByLabel('市区町村')).toHaveValue('渋谷区');
    await expect(page.getByLabel('番地')).toHaveValue('神宮前1-2-3');
  });

  test('session_id callback を一度だけ確定処理し、完了メッセージを表示する', async ({ page }) => {
    await stubCheckoutSessionApis(page);
    await stubResumePaymentDone(page);
    await rememberPaymentAttemptBeforeLoad(page, 'cs_test_123');
    await mockCartApis(page, [sampleCartItem()]);
    let completeCalls = 0;

    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unauthorized' }),
      });
    });

    await page.route('**/api/checkout/complete', async (route) => {
      completeCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ orderId: 'a1b2c3d4-1001-4000-8000-000000000000' }),
      });
    });

    await page.goto('/checkout?session_id=cs_test_123');

    await expect(page.getByText('ご注文を承りました。確認メールをお送りしましたのでご確認ください。')).toBeVisible();
    await expect(page.getByText('ORD-A1B2C3D4')).toBeVisible();
    await expect(page).toHaveURL(/\/checkout\?session_id=cs_test_123$/);
    expect(completeCalls).toBe(1);
  });
});