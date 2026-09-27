import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

/**
 * FR-CHECKOUT-034 再試行できない失敗のあとは「確認へ進む」を押せない
 * 対応 FREQ: FREQ-385（AC-01 / AC-02 / AC-03）
 *
 * 在庫切れなど、待っても直らない理由で決済セッションの作成が失敗したあと、代替の
 * 「確認へ進む」を押すと、原因の案内が「決済フォームを準備しています…」に置き換わっていた。
 * 再試行ボタンも出ないため、直らないものを待たせることになる。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
] as const;

const OUT_OF_STOCK_MESSAGE = '「シルクブラウス」は在庫が不足しています。';
const PREPARING_MESSAGE = '決済フォームを準備しています。少し待ってから再度お試しください。';
const ERROR_MESSAGE_ID = 'checkout-session-error-message';

async function openCheckoutWithOutOfStock(page: Page): Promise<void> {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route('**/api/profile', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [] } }));
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'out_of_stock', message: OUT_OF_STOCK_MESSAGE },
    }),
  );
  await page.goto('/checkout');
  await expect(page.locator('input[name="fullName"]')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）原因の案内が残り、確認へ進むは押せない`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckoutWithOutOfStock(page);

    // FREQ-385-AC-01: 原因の案内がそのまま残る
    const errorMessage = page.getByTestId('checkout-session-error');
    await expect(errorMessage).toHaveText(OUT_OF_STOCK_MESSAGE);
    await expect(page.getByText(PREPARING_MESSAGE)).toHaveCount(0);

    // FREQ-385-AC-02: 押しても進めないので、ボタンを止める。再試行ボタンも出ない
    const confirmButton = page.getByRole('button', { name: '確認へ進む' });
    await expect(confirmButton).toBeDisabled();
    await expect(page.getByRole('button', { name: '再試行する' })).toHaveCount(0);

    // FREQ-385-AC-03: 押せない理由として、原因の案内を指す
    await expect(confirmButton).toHaveAttribute('aria-describedby', ERROR_MESSAGE_ID);
    await expect(page.locator(`#${ERROR_MESSAGE_ID}`)).toHaveText(OUT_OF_STOCK_MESSAGE);

    const hasHorizontalOverflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth + 1;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });
}
