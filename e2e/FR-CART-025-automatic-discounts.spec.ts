import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-CART-025 (${viewport.width}px)`, () => {
    test('FREQ-550-AC-01: 広告OFFでもカートに自動割引と合計が分かりguestのメール条件は常に見込みになる', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('cart', async (s) => {
        const item = await s.item(20_000);
        await s.cart('guest', [{ ...item, quantity: 2 }]);
        const input = discountInput({ method: 'automatic', code: null, firstOrderOnly: true }); await s.createDiscount(input);
        await installDiscountDbBridge(page, s, 'guest');
        await page.goto('/cart');
        await expect(page.locator('#main-content')).toContainText(`割引（${input.name}）`);
        await expect(page.locator('#main-content')).toContainText('見込み');
        await expect(page.locator('#main-content')).toContainText('36,000');
        const cart = await s.cartView('guest');
        expect(cart).toMatchObject({ items_subtotal_price: 40_000, total_price: 36_000, total_discount: 4_000, discount_provisional: true });
        expect(cart.discounts).toEqual([{ name: input.name, amount: 4_000 }]);
        expect((await s.api('guest', `/api/discounts/advertisements?itemId=${item.itemId}`)).body).toEqual({ rows: [] });
        // The real preview context must contain no guest history facts (not a simulated query count).
        const facts = await s.guestPreviewFacts(item.itemId);
        expect(facts).toMatchObject({ hasPreviousOrder: null, hasFirstOrderReservation: null, priorUnitsByItem: {} });
        expect(facts.usage.every(u => u.buyerUses === null)).toBe(true);
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-546-AC-04: 最大カートはfallbackの時も合計を表示し管理の計算要対応へ残る', async ({ page }) => {
      test.setTimeout(360_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('max-cart', async (s) => {
        const lines = [];
        for (let n = 0; n < 50; n++) lines.push({ ...await s.item(1_000), quantity: 20 });
        await s.cart('guest', lines);
        const ids: string[] = [];
        for (let n = 0; n < 25; n++) ids.push(await s.createDiscount(discountInput({ method: 'automatic', code: null,
          kind: n >= 6 && n < 12 ? 'order_percent' : 'product', combinesWithProduct: n < 12, combinesWithOrder: n < 12 })));
        const codes: string[] = [];
        for (let n = 0; n < 5; n++) {
          const input = discountInput({ combinesWithProduct: true, combinesWithOrder: true }); await s.createDiscount(input); codes.push(input.code!);
        }
        const normal = await s.preview(codes, 'guest');
        expect(normal.status).toBe(200);
        expect(normal.body.result?.unitAmounts).toHaveLength(1_000);
        expect(normal.body.result?.subtotalAmount).toBe(1_000_000);
        expect(normal.body.result?.calculationMode).toBe('exact');
        const attention = async () => Promise.all(ids.map(async id => (await s.detail(id)).searchAttention?.count ?? 0));
        expect(await attention()).toEqual(ids.map(() => 0));
        // Guard fault injection is isolated to the pure engine; persistence uses the real public RPC (exactly one record).
        const fallback = await s.forceFallback(codes, 'guest');
        expect(fallback.calculationMode).toBe('fallback');
        expect(fallback.totalAmount).toBeGreaterThanOrEqual(50);
        expect(await attention()).toEqual(ids.map(() => 1));
        await installDiscountDbBridge(page, s, 'guest');
        await s.showFallbackCart(page, fallback);
        // Count the browser's real requests: one cart read, no attention/record request from the page.
        const cartReads: string[] = [], recordCalls: string[] = [];
        page.on('request', request => {
          const path = new URL(request.url()).pathname;
          if (path === '/api/cart') cartReads.push(request.method());
          if (/fallback|search-attention|record/.test(path)) recordCalls.push(path);
        });
        await page.goto('/cart');
        const shown = Number((await page.getByTestId('cart-total').innerText()).replace(/\D/g, ''));
        expect(shown).toBe(fallback.totalAmount);
        await page.waitForLoadState('networkidle');
        await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
        // The cart page itself reads /api/cart twice on load (observed); a resend loop would keep growing it.
        const settled = cartReads.length;
        await page.waitForTimeout(2_000);
        expect(cartReads).toHaveLength(settled);
        expect(settled).toBeLessThanOrEqual(2);
        expect(cartReads.every(method => method === 'GET')).toBe(true);
        expect(recordCalls).toEqual([]);
        expect(await attention()).toEqual(ids.map(() => 1));
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
