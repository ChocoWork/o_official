/**
 * FR-CHECKOUT-042 適用した割引コードを入力画面で確かめ直す
 * 対応 FREQ: FREQ-423（AC-01 / AC-02）
 * Stripe にテスト用コードを作らず、割引の確認入口だけを差し替える。
 */
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, seedCart } from './checkout-flow-helpers';

const CODE = 'WELCOME10';
const INVALID_MESSAGE = 'このコードは期限が切れています';

test.describe('FR-CHECKOUT-042 割引コードの復元', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    for (const invalid of [false, true]) {
      test(`${viewport.name}（${viewport.width}px）開き直しで${invalid ? 'コードと使えない理由' : '割引後の金額'}を表示する`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const seeded = await seedCart(page);
        test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
        if (!seeded.ok) return;
        const discount = Math.round(seeded.price * 0.1);
        let checks = 0;
        await page.route('**/api/checkout/promotion-code', async (route) => {
          checks += 1;
          expect(route.request().postDataJSON()).toEqual({ code: CODE });
          if (invalid && checks > 1) {
            await route.fulfill({ status: 422, json: { error: 'promotion_code_invalid', reason: 'expired', message: INVALID_MESSAGE } });
            return;
          }
          await route.fulfill({ json: { code: CODE, subtotalAmount: seeded.price, shippingAmount: 0, discountAmount: discount, totalAmount: seeded.price - discount } });
        });
        await page.goto('/checkout');
        await page.getByLabel('プロモーションコード').fill(CODE);
        await page.getByRole('button', { name: '適用' }).click();
        await expect(page.locator('.checkout-summary')).toContainText(CODE);

        await page.goto('/cart');
        await expect(page).toHaveURL(/\/cart$/);
        await page.goto('/checkout');
        if (invalid) {
          // FREQ-423-AC-02。無効な記録を適用せず、入力欄にコードと理由を残す。
          const input = page.getByLabel('プロモーションコード');
          await expect(input).toHaveValue(CODE);
          await expect(input).toHaveAccessibleDescription(INVALID_MESSAGE);
          await expect(page.getByText(INVALID_MESSAGE)).toBeVisible();
          expect(await page.evaluate(() => sessionStorage.getItem('checkout:promotion-code'))).toBeNull();
        } else {
          // FREQ-423-AC-01。
          await expect(page.locator('.checkout-summary')).toContainText(CODE);
          await expect(page.locator('.checkout-summary .checkout-total')).toHaveText(`¥${(seeded.price - discount).toLocaleString('ja-JP')}`);
        }
        expect(checks).toBe(2);
      });
    }
  }
});
