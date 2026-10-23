import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  fillShippingForm,
  paymentElementFrame,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-052 支払い方法の並びはカード → PayPay（波1 J-11）
 * 対応 FREQ: FREQ-511（AC-01）
 *
 * 最終確認画面の「お支払い方法」の欄（本物の Stripe の iframe）で、最初の支払い方法がカードで、
 * カードが PayPay より上に並ぶことを確かめる。見方は FR-CHECKOUT-022・037 と同じ（iframe を待って中を見る）。
 * 項目のボタンは開閉の状態（aria-expanded）を持つ（selectPaymentMethod と同じ前提）。
 * PayPay が使えない Stripe の設定では、並べ替えても PayPay は出ないので、その時は PayPay のボタンが無いことで落ちる。
 */
test.describe('FR-CHECKOUT-052 支払い方法の並び', () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）最終確認画面のお支払い方法の欄で、最初の支払い方法がカードで、PayPay より上に出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-method-order-${viewport.name}@example.com`);
      await proceedToFinal(page);

      // FREQ-511-AC-01
      const frame = await paymentElementFrame(page);
      const card = frame.getByRole('button', { name: 'カード', exact: true });
      const paypay = frame.getByRole('button', { name: 'PayPay', exact: true });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(paypay).toBeVisible({ timeout: 30_000 });

      await expect(frame.locator('button[aria-expanded]').first()).toHaveAccessibleName('カード');
      const cardBox = await card.boundingBox();
      const paypayBox = await paypay.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(paypayBox).not.toBeNull();
      expect(cardBox!.y).toBeLessThan(paypayBox!.y);
    });
  }
});
