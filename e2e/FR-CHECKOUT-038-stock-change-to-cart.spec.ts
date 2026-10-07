import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  clickPlaceOrder,
  fillShippingForm,
  fillTestCard,
  paymentElementFrame,
  proceedToFinal,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-038 在庫ありと見せた明細が受注生産に変わったら、お金が動く前にカートで示す
 * 対応 FREQ: FREQ-417（AC-02 を「注文する」から通しで）
 *
 * 受け付けの時点で在庫が変わった状態は、受け付けの入口の応答で作る（在庫の判定は DB の結合テスト、
 * 入口の組み立ては単体テストで確かめる）。Stripe の支払いの命令は送られない。
 *
 * 前提: 行の印（cart-stock-changed）は、カートの取得（GET /api/cart）の fulfillment が 'stock' でない行にだけ出る
 * （断られた後に数量を減らして在庫に収まった行には出さない）。手元の種データ（supabase/seed.sql）では、
 * バリアントはすべて在庫0で、色・サイズなしで入れた行はどのバリアントにも当たらない（バリアントはすべて色を持つ）。
 * だからこの行は受注生産になり、印が出る。種データに、色もサイズも無く在庫を持つバリアントを足すと
 * 行が「在庫あり」になって印が出なくなるので、cart-stock-changed で落ちたらまず種データを確かめる。
 */
const STOCK_NOTICE = '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）';

test.describe('FR-CHECKOUT-038 在庫の変化でカートへ戻る', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）注文するで在庫の変化を断られると、カート画面に変わった商品と印が出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);

      let placeOrderCalls = 0;
      await page.route('**/api/checkout/place-order', async (route) => {
        placeOrderCalls += 1;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'stock_changed',
            message: STOCK_NOTICE,
            changedLines: [{ itemId: seeded.itemId, name: 'E2E の商品', color: null, size: null }],
          }),
        });
      });

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-stock-change-${viewport.name}@example.com`);
      await proceedToFinal(page);
      const frame = await paymentElementFrame(page);
      await fillTestCard(frame);
      await clickPlaceOrder(page, frame);

      // FREQ-417-AC-02
      await expect(page).toHaveURL(/\/cart$/, { timeout: 30_000 });
      const notice = page.getByTestId('cart-notice');
      await expect(notice).toContainText(STOCK_NOTICE);
      await expect(notice).toContainText('E2E の商品');
      await expect(page.getByTestId('cart-stock-changed')).toHaveText('在庫あり → 受注生産');
      expect(placeOrderCalls).toBe(1);
    });
  }
});
