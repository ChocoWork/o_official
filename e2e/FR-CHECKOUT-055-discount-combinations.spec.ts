import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-CHECKOUT-055 (${viewport.width}px)`, () => {
    test('FREQ-546-AC-01: 双方の併用許可とセットの取り合いから一番お得な割引を選ぶ', async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('combinations', async (s) => {
        const j = await s.item(20_000), p = await s.item(10_000);
        await s.cart('member', [{ ...j, quantity: 2 }, { ...p, quantity: 1 }]);
        const set = discountInput({ kind: 'set', targetMode: 'include', itemIds: [j.itemId, p.itemId], value: { type: 'amount', value: 3_000 },
          minimum: { type: 'amount', value: 3_001 }, combinesWithProduct: true });
        const product = discountInput({ targetMode: 'exclude', itemIds: [p.itemId], value: { type: 'amount', value: 1_000 },
          minimum: { type: 'amount', value: 1_001 }, combinesWithProduct: true });
        const setId = await s.createDiscount(set), productId = await s.createDiscount(product);
        const codes = [set.code!, product.code!];
        expect((await s.preview(codes, 'member')).body.result?.discountAmount).toBe(4_000);
        for (const id of [setId, productId]) {
          expect((await s.update(id, { combinesWithProduct: false })).status).toBe(200);
          expect((await s.preview(codes, 'member')).body.result?.discountAmount).toBe(3_000);
          await s.update(id, { combinesWithProduct: true });
        }
        await s.update(productId, { value: { type: 'amount', value: 4_000 }, minimum: { type: 'amount', value: 4_001 } });
        const best = (await s.preview(codes, 'member')).body.result!;
        expect(best.discountAmount).toBe(8_000);
        expect(best.applied.map(e => e.discountId)).toEqual([productId]);
        const same = await s.item(16_000);
        await s.cart('member', [{ ...same, quantity: 2 }]);
        await s.stopAll();
        const percent = discountInput({ combinesWithOrder: true });
        const amount = discountInput({ kind: 'order_amount', value: { type: 'amount', value: 5_000 }, minimum: { type: 'amount', value: 30_000 }, combinesWithProduct: true });
        await s.createDiscount(percent); const orderId = await s.createDiscount(amount);
        const c22 = (await s.preview([percent.code!, amount.code!], 'member')).body.result!;
        expect(c22.discountAmount).toBe(5_000);
        expect(c22.applied.map(e => e.discountId)).toEqual([orderId]);
        expect(new Set(c22.unitAmounts.map(u => `${u.lineKey}:${u.unitIndex}`)).size).toBe(2);
        await installDiscountDbBridge(page, s, 'member');
        await page.goto('/checkout');
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-546-AC-02: 同額ならcodeを使わず未採用文を表示する', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('tie', async (s) => {
        const item = await s.item(20_000);
        await s.cart('member', [{ ...item, quantity: 1 }]);
        const autoId = await s.createDiscount(discountInput({ method: 'automatic', code: null }));
        const code = discountInput(); const codeId = await s.createDiscount(code);
        const result = (await s.preview([code.code!], 'member')).body.result!;
        expect(result.applied.map(e => e.discountId)).toEqual([autoId]);
        expect(result.unusedCodes).toEqual([code.code]);
        await installDiscountDbBridge(page, s, 'member');
        await page.goto('/checkout');
        await page.getByRole('textbox', { name: 'プロモーションコード', exact: true }).fill(code.code!);
        await page.getByRole('button', { name: '適用', exact: true }).click();
        await expect(page.getByText(`${code.code}：このコードは今の割引と一緒には使えません。よりお得な割引を適用しています。`, { exact: true })).toBeVisible({ timeout: 20_000 });
        await s.recordPaid(await s.accept(await s.createDraft([code.code!], 'member'), 'member'));
        expect((await s.db.query('select count(*)::int n from public.discount_redemptions where discount_id=$1', [codeId])).rows[0].n).toBe(0);
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-545-AC-03: 重ねすぎても注文割引から削って合計50円にする', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('floor', async (s) => {
        const item = await s.item(1_000);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        // Product 50% (500) + order 480 would leave 20 yen. The floor trims the order discount to 450, never the product one.
        // Equal-amount alternatives would be tied by random discount ids, so this pair has exactly one best plan.
        const p = discountInput({ value: { type: 'percent', value: 50 }, combinesWithOrder: true });
        const o = discountInput({ kind: 'order_amount', value: { type: 'amount', value: 480 }, minimum: { type: 'amount', value: 481 }, combinesWithProduct: true });
        await s.createDiscount(p); await s.createDiscount(o);
        const codes = [p.code!, o.code!];
        const input = (await s.preview(codes, 'guest')).body.result!;
        expect(input.totalAmount).toBe(50);
        expect(input.discountAmount).toBe(950);
        expect(input.applied.map(e => [e.class, e.amount])).toEqual([['product', 500], ['order', 450]]);
        expect(input.applied.every(e => e.amount > 0)).toBe(true);
        const draft = await s.createDraft(codes, 'guest');
        const frozen = await s.frozen(draft.draftId);
        expect(frozen.discount_result).toEqual(input.provisional ? { ...input, provisional: false } : input);
        expect(await s.stripeTotal(draft.sessionId)).toBe(50);
        await installDiscountDbBridge(page, s, 'guest');
        await page.goto('/checkout');
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
