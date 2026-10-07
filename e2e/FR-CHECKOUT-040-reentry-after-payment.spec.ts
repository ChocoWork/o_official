import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  clickPlaceOrder,
  fillShippingForm,
  fillTestCard,
  hasPaymentElement,
  paymentElementFrame,
  placeOrderWithTestCard,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-040 決済の画面への入り直し
 * 対応 FREQ: FREQ-421（AC-01〜AC-04）
 *
 * AC-01・02 は Stripe のテスト用カードで実際に支払う。AC-03 は PayPay の画面から未払いで戻った状態を、
 * 支払いの試みの記録（決め事 D10）と実際の開いている決済の画面で作る。AC-04 は受け付けの入口の応答を差し替える。
 */
test.describe('FR-CHECKOUT-040 決済の画面への入り直し', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）支払いの後に最終確認画面の URL を開くと、払わせずに注文の状態を出す`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-reentry-${viewport.name}@example.com`);
      await proceedToFinal(page);
      const finalUrl = page.url();
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });
      const orderNumber = (await page.getByText(/^ORD-[0-9A-F]{8}$/).textContent()) ?? '';

      // FREQ-421-AC-01
      await page.goto(finalUrl);
      await expect(page.getByRole('heading', { name: 'ご注文は確定しています' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(orderNumber)).toBeVisible();
      await expect(page.getByText('入金済み')).toBeVisible();
      expect(hasPaymentElement(page)).toBe(false);
    });

    test(`${viewport.name}（${viewport.width}px）注文の確定の通信が切れても、読み込み直すと注文の状態を出す`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);
      let aborted = false;
      await page.route('**/api/checkout/complete', async (route) => {
        if (!aborted) {
          aborted = true;
          await route.abort('failed');
          return;
        }
        await route.continue();
      });

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-reentry-reload-${viewport.name}@example.com`);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);
      await expect(page.getByTestId('checkout-final-notice')).toContainText(
        '注文確定に失敗しました。時間をおいて再度お試しください。',
        { timeout: 90_000 },
      );

      // FREQ-421-AC-02
      await page.reload();
      await expect(page.getByRole('heading', { name: 'ご注文は確定しています' })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('入金済み')).toBeVisible();
    });

    test(`${viewport.name}（${viewport.width}px）PayPay から未払いで戻ると、最終確認画面に案内が出る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-paypay-return-${viewport.name}@example.com`);
      await proceedToFinal(page);
      const checkoutSessionId = new URL(page.url()).searchParams.get('session_id') ?? '';
      await page.evaluate((id) => {
        window.sessionStorage.setItem('checkout:payment-attempt', JSON.stringify({ checkoutSessionId: id, paymentType: 'paypay' }));
      }, checkoutSessionId);
      await page.reload();

      // FREQ-421-AC-03
      await expect(page.getByTestId('checkout-final-notice')).toHaveText('PayPay でのお支払いが完了しませんでした', {
        timeout: 60_000,
      });
      await expect(page.getByRole('button', { name: '注文する' })).toBeEnabled({ timeout: 30_000 });
    });

    test(`${viewport.name}（${viewport.width}px）受け付けが時間切れで断られると、決済の画面を作り直して案内を出す`, async ({ page }) => {
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
      await page.route(
        '**/api/checkout/place-order',
        (route) =>
          route.fulfill({
            status: 409,
            json: { error: 'session_expired', message: '時間がたったため、お支払い情報をもう一度入力してください' },
          }),
        { times: 1 },
      );

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-session-expired-${viewport.name}@example.com`);
      await proceedToFinal(page);
      const frame = await paymentElementFrame(page);
      await fillTestCard(frame);
      await clickPlaceOrder(page, frame);

      // FREQ-421-AC-04
      await expect(page.getByTestId('checkout-final-notice')).toHaveText(
        '時間がたったため、お支払い情報をもう一度入力してください',
        { timeout: 60_000 },
      );
      expect(createSessionCalls).toBe(2);
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toBeVisible();
    });
  }
});
