import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  expectNoHorizontalOverflow,
  fillShippingForm,
  seedCart,
  stubPostalCode,
} from './checkout-flow-helpers';

/**
 * FR-CHECKOUT-039 割引コードをサーバーで確かめる
 * 対応 FREQ: FREQ-420（AC-01 / AC-02 / AC-03）
 *
 * 「適用」の応答は差し替える（Stripe のテストのアカウントにコードを作らないため。確かめの規則は単体テスト）。
 * AC-03 は「確認へ進む」の実際の入口が Stripe に問い合わせて、無いコードを断ることを見る。
 */
const ZERO_TOTAL_MESSAGE = 'このコードでは合計が0円になるため使えません';

test.describe('FR-CHECKOUT-039 割引コード', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）使えるコードは割引後の金額を出し、0円になるコードは断る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      const discount = Math.round(seeded.price * 0.1);
      await page.route('**/api/checkout/promotion-code', async (route) => {
        const { code } = route.request().postDataJSON() as { code: string };
        if (code === 'FREE100') {
          await route.fulfill({
            status: 422,
            json: { error: 'promotion_code_invalid', reason: 'zero_total', message: ZERO_TOTAL_MESSAGE },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          json: {
            code: 'WELCOME10',
            subtotalAmount: seeded.price,
            shippingAmount: 0,
            discountAmount: discount,
            totalAmount: seeded.price - discount,
          },
        });
      });

      await page.goto('/checkout');
      const input = page.getByLabel('プロモーションコード');

      // FREQ-420-AC-02
      await input.fill('FREE100');
      await page.getByRole('button', { name: '適用' }).click();
      await expect(page.getByText(ZERO_TOTAL_MESSAGE)).toBeVisible();
      await expect(input).toHaveAttribute('aria-invalid', 'true');

      // FREQ-420-AC-01
      await input.fill('welcome10');
      await page.getByRole('button', { name: '適用' }).click();
      const summary = page.locator('.checkout-summary');
      await expect(summary).toContainText('WELCOME10');
      await expect(summary).toContainText(`-¥${discount.toLocaleString('ja-JP')}`);
      await expect(summary.locator('.checkout-total')).toHaveText(`¥${(seeded.price - discount).toLocaleString('ja-JP')}`);
      await expectNoHorizontalOverflow(page);
    });

    test(`${viewport.name}（${viewport.width}px）使えないコードで確認へ進むと、最終確認画面へ進まず欄に理由が出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seeded = await seedCart(page);
      test.skip(!seeded.ok, seeded.ok ? '' : seeded.reason);
      if (!seeded.ok) return;
      await stubPostalCode(page);
      await page.route('**/api/checkout/promotion-code', (route) =>
        route.fulfill({
          status: 200,
          json: {
            code: 'NO-SUCH-CODE-E2E',
            subtotalAmount: seeded.price,
            shippingAmount: 0,
            discountAmount: 1,
            totalAmount: seeded.price - 1,
          },
        }),
      );
      const createSessionBodies: unknown[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/checkout/create-session')) {
          createSessionBodies.push(request.postDataJSON());
        }
      });

      await page.goto('/checkout');
      await fillShippingForm(page, `e2e-promotion-${viewport.name}@example.com`);
      await page.getByLabel('プロモーションコード').fill('NO-SUCH-CODE-E2E');
      await page.getByRole('button', { name: '適用' }).click();
      await expect(page.locator('.checkout-summary')).toContainText('NO-SUCH-CODE-E2E');
      await page.getByRole('button', { name: '確認へ進む' }).click();

      // FREQ-420-AC-03（実際の入口が Stripe に問い合わせて断る）
      await expect(page.getByText('このコードは使えません')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel('プロモーションコード')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toHaveCount(0);
      expect(createSessionBodies[0]).toMatchObject({ promotionCode: 'NO-SUCH-CODE-E2E' });
    });
  }
});
