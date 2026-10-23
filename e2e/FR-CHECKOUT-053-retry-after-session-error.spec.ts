/**
 * FR-CHECKOUT-053 決済の画面を作れなかった後、すぐに押し直して作り直せる
 * 対応 FREQ: FREQ-518-AC-01
 *
 * Stripe のエラーは本物で起こせないので、1回目の決済の準備だけを 503 に差し替え、2回目は本物の窓口に通す。
 * サーバーの下書きの片付け（K-5）は create-session-route の単体テストと checkout_session_claim の DB 結合で確かめる。
 */
import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  expectNoHorizontalOverflow,
  fillShippingForm,
  paymentElementFrame,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

const UNAVAILABLE_MESSAGE = '決済サービスに接続できませんでした。時間をおいて再度お試しください。';

test.describe('FR-CHECKOUT-053 決済の画面の作成の失敗からの押し直し', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）503 の後に「確認へ進む」を押し直すと決済の画面に進める`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      let creations = 0;
      await page.route('**/api/checkout/create-session', async (route) => {
        creations += 1;
        if (creations === 1) {
          await route.fulfill({
            status: 503,
            json: {
              error: 'checkout_session_failed',
              message: UNAVAILABLE_MESSAGE,
              correlationId: '0123abcd-4567-89ef-0123-456789abcdef',
              retryable: true,
            },
          });
        } else {
          await route.continue();
        }
      });
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-retry-after-session-error-${viewport.name}@example.com`);
      await page.getByRole('button', { name: '確認へ進む' }).click();

      await expect(page.getByTestId('checkout-session-error')).toHaveText(UNAVAILABLE_MESSAGE);
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();

      await proceedToFinal(page);
      await paymentElementFrame(page);
      expect(creations).toBe(2);
      await expectNoHorizontalOverflow(page);
    });
  }
});
