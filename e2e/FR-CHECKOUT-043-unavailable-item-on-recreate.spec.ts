/**
 * FR-CHECKOUT-043 作り直し中に買えない商品が見つかったらカートへ案内する
 * 対応 FREQ: FREQ-424（AC-02）。AC-01 の非公開商品名の案内は create-session-route の単体テストで確かめる。
 */
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, fillShippingForm, placeOrderWithTestCard, proceedToFinal, seedCart, stubPostalCode } from './checkout-flow-helpers';

const ITEM_NAME = 'E2E の非公開シャツ';
const MESSAGE = `以下の商品は現在購入できません: ${ITEM_NAME}`;

test.describe('FR-CHECKOUT-043 作り直しでカートへ戻る', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）作り直しの購入不可はカートに商品名で出る`, async ({ page }) => {
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
          await route.fulfill({ status: 409, json: { error: 'out_of_stock', message: MESSAGE } });
        } else {
          await route.continue();
        }
      });
      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-recreate-unavailable-${viewport.name}@example.com`);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);

      await expect(page).toHaveURL(/\/cart$/, { timeout: 30_000 });
      await expect(page.getByTestId('cart-notice')).toContainText(MESSAGE);
      await expect(page.getByTestId('cart-notice')).toContainText(ITEM_NAME);
      expect(placements).toBe(1);
      expect(creations).toBe(2);
    });
  }
});
