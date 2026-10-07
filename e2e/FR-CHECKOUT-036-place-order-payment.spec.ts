import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  expectNoHorizontalOverflow,
  fillShippingForm,
  hasPaymentElement,
  placeOrderWithTestCard,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-036 支払いを「注文する」で行う
 * 対応 FREQ: FREQ-418（AC-01 / AC-02）
 *
 * Stripe のテストモードの実際の決済の画面で、テスト用カード（4242…）で支払う。手元の Supabase に注文ができる。
 */
test.describe('FR-CHECKOUT-036 支払いを「注文する」で行う', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）開いただけでは決済の画面を作らず、確認へ進むで作り、注文するで支払って完了する`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);
      let createSessionCalls = 0;
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/checkout/create-session')) {
          createSessionCalls += 1;
        }
      });

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-place-order-${viewport.name}@example.com`);

      // FREQ-418-AC-01
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      expect(createSessionCalls).toBe(0);
      expect(hasPaymentElement(page)).toBe(false);

      await proceedToFinal(page);
      expect(createSessionCalls).toBe(1);
      await expect(page).toHaveURL(/\/checkout\?session_id=cs_test_/);

      // FREQ-418-AC-02
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });
      await expect(page.getByText(/^ORD-[0-9A-F]{8}$/)).toBeVisible();
      await expect(page.getByText('入金済み')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
