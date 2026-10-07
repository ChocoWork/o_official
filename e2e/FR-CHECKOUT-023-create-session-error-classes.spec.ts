import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import { fillShippingForm, stubPostalCode } from './checkout-flow-helpers';

const VIEWPORTS = [
  { name: 'mobile', width: 390 },
  { name: 'tablet', width: 768 },
  { name: 'desktop', width: 1280 },
];

const MESSAGE = 'ご注文内容では決済を開始できません。カートの内容をご確認ください。';

async function proceedWithError(page: Page, status: number, retryable: boolean) {
  await mockCartApis(page, [sampleCartItem()]);
  await stubPostalCode(page);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { authenticated: false, user: null } }));
  await page.route('**/api/profile', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/profile/addresses', (route) => route.fulfill({ json: { addresses: [] } }));
  await page.route('**/api/checkout/create-session', (route) =>
    route.fulfill({
      status,
      json: {
        error: 'checkout_session_failed',
        message: MESSAGE,
        correlationId: '0123abcd-4567-89ef-0123-456789abcdef',
        retryable,
      },
    }),
  );
  await page.goto('/checkout');
  await fillShippingForm(page, 'e2e-error-classes@example.com');
  await page.getByRole('button', { name: '確認へ進む' }).click();
  await expect(page.getByTestId('checkout-session-error')).toHaveText(MESSAGE);
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）422 では確認へ進むを押せなくし、エラーIDと案内を出す`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await proceedWithError(page, 422, false);

    await expect(page.getByText('エラーID: 0123abcd')).toBeVisible();
    const confirmButton = page.getByRole('button', { name: '確認へ進む' });
    await expect(confirmButton).toBeDisabled();
    await expect(confirmButton).toHaveAttribute('aria-describedby', 'checkout-session-error-message');
  });

  test(`${viewport.name}（${viewport.width}px）503 では確認へ進むをもう一度押せる`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await proceedWithError(page, 503, true);

    await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
  });
}
