import { expect, test, type Page } from '@playwright/test';
import { CART_OPTION_NAMES, type CartJson } from '../src/features/cart/types/cart-json';
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
 * 入口の組み立ては単体テストで確かめる）。Stripe の支払いの命令は送られない（api.stripe.com への
 * /confirm の要求を数え、カート画面へ移った後に0であることで確かめる）。
 *
 * 前提: 行の印（cart-stock-changed）は、カートの取得（GET /api/cart）の fulfillment が 'stock' でない行にだけ出る
 * （断られた後に数量を減らして在庫に収まった行には出さない）。seedCart は商品詳細の最初のバリアントをカートに入れる。
 * 手元の種データの在庫はすべて0なので、その行は受注生産になり、印が出る。種データに在庫を足すと
 * 行が「在庫あり」になって印が出なくなるので、cart-stock-changed で落ちたらまず種データを確かめる。
 * 印は、案内の明細（changedLines）がカートの行と商品・色・サイズまで同じ時にだけ付く。seedCart の行は
 * バリアントの色・サイズを持つので、案内の明細にもカートから読んだ同じ色・サイズを入れる。
 */
const STOCK_NOTICE = '在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）';

/**
 * seedCart が入れた行の色・サイズを、カートの窓口から読む。案内の明細（changedLines）に使う。
 * 行はバリアントの色・サイズを持つので、案内の明細が null のままだと isSameCartLine が一致せず、行の印が付かない。
 */
async function readSeededVariant(page: Page): Promise<{ color: string | null; size: string | null }> {
  const response = await page.request.get('/api/cart');
  if (!response.ok()) {
    throw new Error(`/api/cart returned ${response.status()}`);
  }
  const line = ((await response.json()) as CartJson).items[0];
  if (!line) {
    throw new Error('seedCart が入れた行がカートに無い');
  }
  return {
    color: line.options_with_values.find((option) => option.name === CART_OPTION_NAMES.color)?.value ?? null,
    size: line.options_with_values.find((option) => option.name === CART_OPTION_NAMES.size)?.value ?? null,
  };
}

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
      const seededVariant = await readSeededVariant(page);
      await stubPostalCode(page);

      let stripeConfirmCalls = 0;
      page.on('request', (request) => {
        const url = request.url();
        if (url.includes('api.stripe.com') && url.includes('/confirm')) {
          stripeConfirmCalls += 1;
        }
      });
      let placeOrderCalls = 0;
      await page.route('**/api/checkout/place-order', async (route) => {
        placeOrderCalls += 1;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'stock_changed',
            message: STOCK_NOTICE,
            changedLines: [{ itemId: seeded.itemId, name: 'E2E の商品', color: seededVariant.color, size: seededVariant.size }],
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
      // お金が動く前に断った（受け付けで断られたので、Stripe の支払いの命令を出していない）
      expect(stripeConfirmCalls).toBe(0);
    });
  }
});
