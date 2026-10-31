import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-CHECKOUT-057 (${viewport.width}px)`, () => {
    test('FREQ-544-AC-02: リピートのAだけ・Bだけ・両方は色サイズをまたいで２着目から効く', async ({ page }) => {
      test.setTimeout(360_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('repeat', async (s) => {
        const item = await s.item(20_000);
        const variant = await s.variant(item);
        for (const [a, b] of [[true, false], [false, true], [true, true]] as const) {
          await s.stopAll();
          const id = await s.createDiscount(discountInput({ method: 'automatic', code: null, kind: 'repeat', targetMode: 'include',
            itemIds: [item.itemId], repeatPrevious: a, repeatInOrder: b }));
          await s.cart('member', [{ ...item, quantity: 1 }, { ...variant, quantity: 1 }]);
          // No paid history: B protects exactly one unit across the two variants of the same item.
          expect((await s.preview([], 'member')).body.result?.discountAmount).toBe(b ? 2_000 : 0);
          await s.stop(id);
        }
        const pending = await s.createDraft([], 'member');
        await s.accept(pending, 'member');
        const aId = await s.createDiscount(discountInput({ method: 'automatic', code: null, kind: 'repeat', targetMode: 'include', itemIds: [item.itemId], repeatPrevious: true }));
        expect((await s.preview([], 'member')).body.result?.discountAmount).toBe(0);
        const orderId = (await s.place(pending, 'member')).body.orderId!;
        await s.recordPaid(orderId);
        await s.cart('member', [{ ...variant, quantity: 1 }]);
        expect((await s.preview([], 'member')).body.result?.discountAmount).toBe(2_000);
        const lines = (await s.db.query('select id from public.order_items where order_id=$1 order by id', [orderId])).rows;
        for (const line of lines) await s.refund(orderId, line.id as string, 1, 20_000);
        expect((await s.preview([], 'member')).body.result?.discountAmount).toBe(0);
        await s.cart('guest', [{ ...variant, quantity: 2 }]);
        expect((await s.preview([], 'guest')).body.result?.discountAmount).toBe(0);
        await s.update(aId, { repeatInOrder: true });
        expect((await s.preview([], 'guest')).body.result?.discountAmount).toBe(2_000);
        expect((await s.preview([], 'guest')).body.result?.provisional).toBe(false);
        await installDiscountDbBridge(page, s, 'member');
        await page.goto('/checkout');
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-544-AC-03: セットはそろう組だけ自動で引き他割引の着を重ねて使わない', async ({ page }) => {
      test.setTimeout(360_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('sets', async (s) => {
        const items = [];
        for (let n = 0; n < 10; n++) items.push(await s.item(n === 0 ? 20_000 : 10_000));
        for (let count = 2; count <= 10; count++) {
          await s.stopAll();
          const selected = items.slice(0, count);
          await s.cart('member', selected.map((item, n) => ({ ...item, quantity: n === 0 ? 2 : 1 })));
          const id = await s.createDiscount(discountInput({ method: 'automatic', code: null, kind: 'set', targetMode: 'include', itemIds: selected.map(i => i.itemId),
            value: { type: 'amount', value: 3_000 }, minimum: { type: 'amount', value: 3_001 }, combinesWithProduct: true }));
          const result = (await s.preview([], 'member')).body.result!;
          expect(result.applied.map(e => [e.discountId, e.amount])).toEqual([[id, 3_000]]);
          expect(result.unitAmounts).toHaveLength(count + 1);
          if (count === 10) {
            await s.cart('member', selected.slice(1).map(item => ({ ...item, quantity: 1 })));
            expect((await s.preview([], 'member')).body.result?.discountAmount).toBe(0);
          }
        }
        await installDiscountDbBridge(page, s, 'member');
        await page.goto('/checkout');
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
