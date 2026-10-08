/**
 * FR-CHECKOUT-043 作り直し中に明細を外したら入力画面で案内する
 * 対応 FREQ: FREQ-430-REQ-05・AC-08。外した商品名の案内は create-session-route の単体テストでも確かめる。
 */
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, fillShippingForm, placeOrderWithTestCard, proceedToFinal, seedCart, stubPostalCode } from './checkout-flow-helpers';

const ITEM_NAME = 'E2E の非公開シャツ';
const MESSAGE = `次の商品はお求めいただけなくなったため、カートから外しました: ${ITEM_NAME}。内容をご確認のうえ、もう一度「確認へ進む」を押してください。`;

test.describe('FR-CHECKOUT-043 作り直しで入力画面へ戻る', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）作り直しで明細を外した案内は入力画面に出て確認へ進める`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      let placements = 0;
      let creations = 0;
      await page.route('**/api/checkout/place-order', async (route) => {
        placements += 1;
        if (placements === 1) {
          await route.fulfill({ status: 409, json: { error: 'session_expired', message: '時間がたったため、お支払い情報をもう一度入力してください' } });
        } else {
          await route.continue();
        }
      });
      await page.route('**/api/checkout/create-session', async (route) => {
        creations += 1;
        if (creations === 2) {
          await route.fulfill({ status: 409, json: { error: 'cart_updated', retryable: true, message: MESSAGE } });
        } else {
          await route.continue();
        }
      });
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-recreate-unavailable-${viewport.name}@example.com`);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);

      await expect(page).toHaveURL(/\/checkout$/, { timeout: 30_000 });
      await expect(page.getByTestId('checkout-session-error')).toHaveText(MESSAGE);
      await expect(page.getByTestId('checkout-session-error')).toContainText(ITEM_NAME);
      await expect(page.getByRole('button', { name: '確認へ進む' })).toBeEnabled();
      expect(placements).toBe(1);
      expect(creations).toBe(2);
    });
  }
});
