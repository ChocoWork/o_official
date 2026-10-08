import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import { fillShippingForm, stubPostalCode } from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-034 明細を外した案内後も「確認へ進む」を押せる
 * 対応 FREQ: FREQ-430-REQ-05・AC-08
 *
 * 購入不可の明細はサーバーが外すため、残りの明細で押し直せるままにする。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

const CART_UPDATED_MESSAGE = '次の商品はお求めいただけなくなったため、カートから外しました: シルクブラウス（Black / M）。内容をご確認のうえ、もう一度「確認へ進む」を押してください。';

async function openCheckoutWithCartUpdated(page: Page): Promise<void> {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route('**/api/profile', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [] } }));
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'cart_updated', retryable: true, message: CART_UPDATED_MESSAGE },
    }),
  );
  await stubPostalCode(page);
  await page.goto('/checkout');
  await expect(page.locator('input[name="fullName"]')).toBeVisible();
  await fillShippingForm(page, 'e2e-cart-updated@example.com');
  await page.getByRole('button', { name: '確認へ進む' }).click();
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）入力画面に外した明細の案内が出て、確認へ進める`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckoutWithCartUpdated(page);

    // 外した内容を確かめてから押し直せるよう、入力画面で商品名・色・サイズを案内する。
    const errorMessage = page.getByTestId('checkout-session-error');
    await expect(errorMessage).toHaveText(CART_UPDATED_MESSAGE);

    // 外した後のカートで続けられるため、ボタンは押せるままにする。
    const confirmButton = page.getByRole('button', { name: '確認へ進む' });
    await expect(confirmButton).toBeEnabled();
    await expect(page).toHaveURL(/\/checkout$/);

    const hasHorizontalOverflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth + 1;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });
}
