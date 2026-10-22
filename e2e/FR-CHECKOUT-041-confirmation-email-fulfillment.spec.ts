/**
 * FR-CHECKOUT-041 確定メールに明細ごとのお届けの目安を添える
 * 対応 FREQ: FREQ-422（AC-01）
 *
 * seedCart は商品詳細の最初のバリアントをカートに入れる。手元の種データの在庫はすべて0なので、
 * その行は受注生産になる。
 * Mailpit は手元にしかないメール受信箱で、本番のメールには触れない。
 * API の形は Mailpit の公式仕様に合わせる: https://mailpit.axllent.org/docs/api-v1/
 */
import { expect, test } from '@playwright/test';
import { mailBodies } from './order-email-test-utils';
import {
  CHECKOUT_VIEWPORTS,
  fillShippingForm,
  placeOrderWithTestCard,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const FULFILLMENT_TEXT = '受注生産・発送まで数週間〜2か月以上（目安）';

test.describe('FR-CHECKOUT-041 確定メールに明細ごとのお届けの目安を添える', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）テスト用カードで注文すると確定メールに受注生産の目安が出る`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      await stubPostalCode(page);
      const email = `e2e-email-fulfillment-${viewport.name}-${Date.now()}@example.com`;

      await page.goto('/checkout');
      await fillShippingForm(page, email);
      await proceedToFinal(page);
      await placeOrderWithTestCard(page);
      await expect(page.getByRole('heading', { name: 'Thank you for your order' })).toBeVisible({ timeout: 90_000 });

      // FREQ-422-AC-01。非同期のメールが届かない場合も、目安が無い場合も時間切れで落とす。
      await expect.poll(async () => {
        return (await mailBodies(request, email, 'ご注文ありがとうございます')).some((mail) => mail.Text.includes(FULFILLMENT_TEXT));
      }, {
        timeout: 60_000,
        message: '確定メールにお届けの目安が届くこと',
      }).toBe(true);
    });
  }
});
