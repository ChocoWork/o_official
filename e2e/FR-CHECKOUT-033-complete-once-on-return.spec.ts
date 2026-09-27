import { expect, test, type Page } from '@playwright/test';
import { mockCartApis, sampleCartItem } from './shop-test-utils';
import { stubCheckoutSessionApis } from './checkout-test-utils';

/**
 * FR-CHECKOUT-033 決済から戻ったとき、注文の確定を1回だけ送る
 * 対応 FREQ: FREQ-378（AC-01）
 *
 * 戻り（/checkout?session_id=...）で確定を送る effect は、送ったことを state で覚えていた。
 * state は次の描画まで反映されないので、カートの再描画で依存（updateCartCount）が先に変わると
 * effect が走り直し、3ms 差で2回送ることがあった（15回中4回）。1回の読み込みでは見逃しやすいので、
 * 幅ごとに何度も戻りを繰り返して毎回1回であることを確かめる。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const RETURNS_PER_VIEWPORT = 8;

async function mockReturnApis(page: Page, completeCalls: Map<string, number>): Promise<void> {
  await stubCheckoutSessionApis(page);
  await mockCartApis(page, [sampleCartItem()]);
  await page.route('**/api/profile', (route) =>
    route.fulfill({ status: 401, json: { error: 'Unauthorized' } }),
  );
  await page.route('**/api/checkout/complete', async (route) => {
    const body = route.request().postDataJSON() as { checkoutSessionId?: string } | null;
    const sessionId = body?.checkoutSessionId ?? '(none)';
    completeCalls.set(sessionId, (completeCalls.get(sessionId) ?? 0) + 1);
    await route.fulfill({ status: 200, json: { orderId: `order-${sessionId}` } });
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`FR-CHECKOUT-033 決済からの戻り (${viewport.name} ${viewport.width}px)`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-378-AC-01
    test('戻るたびに確定の送信は1回だけで、完了の案内が出る', async ({ page }) => {
      const completeCalls = new Map<string, number>();
      await mockReturnApis(page, completeCalls);

      for (let attempt = 1; attempt <= RETURNS_PER_VIEWPORT; attempt += 1) {
        const sessionId = `cs_test_${viewport.name}_${attempt}`;
        await page.goto(`/checkout?session_id=${sessionId}`);

        await expect(
          page.getByText('ご注文を承りました。確認メールをお送りしましたのでご確認ください。'),
        ).toBeVisible();
        await expect(page.getByText(`order-${sessionId}`)).toBeVisible();
        // 完了後はクエリを外すので、再読み込みしても確定を送り直さない
        await expect(page).toHaveURL(/\/checkout$/);

        expect(completeCalls.get(sessionId), `${sessionId} の確定の送信回数`).toBe(1);
      }

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
