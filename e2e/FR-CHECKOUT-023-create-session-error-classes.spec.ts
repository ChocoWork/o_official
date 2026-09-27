import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
];

async function openCheckoutWithError(page: Page, status: number, retryable: boolean) {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await page.route('**/api/profile', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [] } }));
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status,
      json: {
        error: 'checkout_session_failed',
        message: 'ご注文内容では決済を開始できません。カートの内容をご確認ください。',
        correlationId: '0123abcd-4567-89ef-0123-456789abcdef',
        retryable,
      },
    }),
  );
  await page.goto('/checkout');
  await expect(page.locator('input[name="fullName"]')).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）422 では再試行ボタンを出さない`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckoutWithError(page, 422, false);

    await expect(page.getByText('エラーID: 0123abcd')).toBeVisible();
    await expect(page.getByRole('button', { name: '再試行する' })).toHaveCount(0);
  });

  test(`${viewport.name}（${viewport.width}px）503 では再試行ボタンを出す`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await openCheckoutWithError(page, 503, true);

    await expect(page.getByRole('button', { name: '再試行する' })).toBeVisible();
  });
}
