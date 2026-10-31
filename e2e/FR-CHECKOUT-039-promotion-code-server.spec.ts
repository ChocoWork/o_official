import { expect, test } from '@playwright/test';
import {
  CHECKOUT_VIEWPORTS,
  expectNoHorizontalOverflow,
  fillShippingForm,
  stubPostalCode,
} from './checkout-flow-helpers';
import { ownDiscountPreview } from './checkout-test-utils';
import { GUEST_REFUSAL, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

/**
 * FR-CHECKOUT-039 割引コードをサーバーで確かめる
 * 対応 FREQ: FREQ-420（AC-01 / AC-02 / AC-03）
 *
 * 「適用」の応答は差し替える（確かめの規則は単体テスト）。ログイン済み member の公開コードは、従来の
 * 0円防御の文（ZERO_TOTAL_MESSAGE）をこの表示の差し替えで保つ。
 * ただし2本目で、guest の存在しないコードの「適用」を自社の割引（グループ H）の本物の入口（HTTP→RPC）へ流し、
 * どの理由でも同じ裁定の文とログインのリンクで断ることを見る（存在を区別できない）。
 * AC-03 は「確認へ進む」の実際の入口（create-session）が、無いコードを断ることを見る。
 */
const ZERO_TOTAL_MESSAGE = 'このコードでは合計が0円になるため使えません';

test.use({ trace: 'off' });
test.describe('FR-CHECKOUT-039 割引コード', () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ locale: 'ja-JP' });

  for (const viewport of CHECKOUT_VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）使えるコードは割引後の金額を出し、0円になるコードは断る`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await withDiscountScenario('legacy-039', async (scenario) => {
      const item = await scenario.item(20_000);
      await scenario.cart('member', [{ ...item, quantity: 1 }]);
      await scenario.cart('guest', [{ ...item, quantity: 1 }]);
      const seeded = { price: 20_000 };
      await installDiscountDbBridge(page, scenario, 'member');
      const discount = Math.round(seeded.price * 0.1);
      await page.route('**/api/checkout/promotion-code', async (route) => {
        const { codes } = route.request().postDataJSON() as { codes: string[] };
        const code = codes.at(-1);
        if (code === 'FREE100') {
          await route.fulfill({
            status: 422,
            json: { error: 'promotion_code_invalid', refusals: [{ code: 'FREE100', reason: 'zero_total' }], message: ZERO_TOTAL_MESSAGE },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          json: { result: ownDiscountPreview(seeded.price, discount, 'WELCOME10') },
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
      await expect(summary).toContainText(`−¥${discount.toLocaleString('ja-JP')}`);
      await expect(summary.locator('.checkout-total')).toHaveText(`¥${(seeded.price - discount).toLocaleString('ja-JP')}`);
      await expectNoHorizontalOverflow(page);
      });
    });

    test(`${viewport.name}（${viewport.width}px）使えないコードで確認へ進むと、最終確認画面へ進まず欄に理由が出る`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await withDiscountScenario('legacy-039-guest', async (scenario) => {
      const item = await scenario.item(20_000);
      await scenario.cart('guest', [{ ...item, quantity: 1 }]);
      const seeded = { price: 20_000 };
      await installDiscountDbBridge(page, scenario, 'guest');
      await stubPostalCode(page);
      // 差し替えるのは、この確かめで決めたコード（NO-SUCH-CODE-E2E）の要求だけ。ほかのコードは本物の入口へ流す
      await page.route('**/api/checkout/promotion-code', async (route) => {
        const { codes } = route.request().postDataJSON() as { codes: string[] };
        const code = codes.at(-1);
        if (code !== 'NO-SUCH-CODE-E2E') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          json: { result: ownDiscountPreview(seeded.price, 1, 'NO-SUCH-CODE-E2E') },
        });
      });
      const createSessionBodies: unknown[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/api/checkout/create-session')) {
          createSessionBodies.push(request.postDataJSON());
        }
      });

      await page.goto('/checkout');
      await fillShippingForm(page, scenario.guestEmail);

      // 本物の「適用」を一度は通す。自社DBに無いコードは、実際の入口が割引を確認して断り、
      // 欄の下に理由が出て、欄が誤りの状態になる（表示は FREQ-420-AC-02 と同じ）
      const input = page.getByLabel('プロモーションコード');
      await input.fill('NO-SUCH-CODE-REAL-E2E');
      const promotionResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/api/checkout/promotion-code' && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '適用' }).click();
      const rejected = await promotionResponse;
      expect(rejected.status()).toBe(422);
      expect(await rejected.json()).toEqual({ error: 'promotion_code_invalid', refusals: [{ code: 'NO-SUCH-CODE-REAL-E2E', reason: 'not_eligible' }], message: GUEST_REFUSAL });
      await expect(page.getByText(GUEST_REFUSAL, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(input).toHaveAttribute('aria-invalid', 'true');

      await page.getByLabel('プロモーションコード').fill('NO-SUCH-CODE-E2E');
      await page.getByRole('button', { name: '適用' }).click();
      await expect(page.locator('.checkout-summary')).toContainText('NO-SUCH-CODE-E2E');
      // 上の本物の断りの案内が消えていること。残っていると、下の AC-03 の確かめが前の案内で通ってしまう
      await expect(page.getByText(GUEST_REFUSAL, { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '確認へ進む' }).click();

      // FREQ-420-AC-03（実際の入口が自社の割引を確認して断る）
      await expect(page.getByText(GUEST_REFUSAL, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByLabel('プロモーションコード')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('heading', { name: '注文内容の最終確認' })).toHaveCount(0);
      expect(createSessionBodies[0]).toMatchObject({ promotionCodes: ['NO-SUCH-CODE-E2E'] });
      await expect(page.getByRole('link', { name: 'ログインして割引を確かめる', exact: true })).toHaveAttribute('href', '/login?next=%2Fcheckout');
      await expectNoHorizontalOverflow(page);
      });
    });
  }
});
