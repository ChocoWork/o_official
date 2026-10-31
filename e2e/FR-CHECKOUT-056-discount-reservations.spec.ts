import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { discountInput, installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-CHECKOUT-056 (${viewport.width}px)`, () => {
    test('FREQ-549-AC-01: 同時の通常注文は上限と１人１回と初回を二重に予約できない', async ({ page, browser }) => {
      test.setTimeout(360_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('concurrent-acceptance', async (s) => {
        const item = await s.item(20_000);
        for (const restriction of ['usageLimit', 'oncePerCustomer', 'firstOrderOnly'] as const) {
          await s.stopAll();
          const input = discountInput({ [restriction]: restriction === 'usageLimit' ? 1 : true });
          const id = await s.createDiscount(input);
          await s.cart('member', [{ ...item, quantity: 1 }]);
          // Different cart sessions for the same verified buyer, frozen before either acceptance.
          const a = await s.createDraft([input.code!], 'member');
          const b = await s.forkDraft([input.code!], 'member');
          const context = await browser.newContext({ baseURL: 'http://localhost:3000', viewport });
          try {
            const second = await context.newPage();
            await installDiscountDbBridge(page, s, 'member', (await s.frozen(a.draftId)).session_id);
            await installDiscountDbBridge(second, s, 'member', b.cartSessionId);
            await page.goto('/checkout'); await second.goto('/checkout');
            const replies = await Promise.all([s.placeFromPage(page, a), s.placeFromPage(second, b)]);
            expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
            const rejected = replies.find(r => r.status === 409)!;
            expect(rejected.body).toMatchObject({ returnTo: 'input', definitive: true });
            expect((await s.db.query("select count(*)::int n from public.discount_redemptions where discount_id=$1 and state='reserved'", [id])).rows[0].n).toBe(1);
            for (const reply of replies) if (reply.body.orderId) await s.release(reply.body.orderId);
          } finally { await context.close(); }
        }
        await s.stopAll();
        const automatic = await s.createDiscount(discountInput({ method: 'automatic', code: null, usageLimit: 1 }));
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        await s.cart('otherMember', [{ ...item, quantity: 1 }]);
        const first = await s.createDraft([], 'guest'), next = await s.createDraft([], 'otherMember');
        await s.accept(first, 'guest');
        const later = await s.place(next, 'otherMember');
        expect(later.status).toBe(200);
        expect(later.body).toEqual({ reconfirmationRequired: true, returnTo: 'confirmation' });
        expect((await s.confirm([], 'otherMember')).body.confirmation?.discountResult?.discountAmount).toBe(0);
        expect((await s.detail(automatic)).used).toBe(true);
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-549-AC-04: 受付を通らないawaitingは割引条件が変わっても予約し入金で確定と要対応へ進む', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('awaiting-recovery', async (s) => {
        const item = await s.item(20_000);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        const input = discountInput(); const id = await s.createDiscount(input);
        const draft = await s.createDraft([input.code!], 'guest');
        await s.stop(id);
        const orderId = await s.reconcile(draft, 'awaiting_payment');
        await s.reconcile(draft, 'awaiting_payment');
        expect(await s.redemptionStates(orderId)).toEqual(['reserved']);
        expect((await s.db.query("select count(*)::int n from private.order_email_outbox where order_id=$1 and kind='awaiting_payment'", [orderId])).rows[0].n).toBe(1);
        await s.recordPaid(orderId);
        expect(await s.redemptionStates(orderId)).toEqual(['confirmed']);
        expect((await s.orderDetail(orderId)).attention.discounts).toHaveLength(1);
        await s.cart('guest', [{ ...item, quantity: 1 }]);
        const unpaidInput = discountInput(); await s.createDiscount(unpaidInput);
        const unpaid = await s.reconcile(await s.createDraft([unpaidInput.code!], 'guest'), 'awaiting_payment');
        await s.release(unpaid);
        expect(await s.redemptionStates(unpaid)).toEqual(['cancelled']);
        await installDiscountDbBridge(page, s);
        await page.goto(`/admin/orders/${orderId}`);
        await expect(page.getByText('割引の条件を確認する注文', { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });

    test('FREQ-549-AC-04: 取消後のpaid回復は超過でも確定しattention１件で出荷を止めない', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('late-paid', async (s) => {
        const item = await s.item(20_000);
        for (const buyer of ['member', 'guest'] as const) await s.cart(buyer, [{ ...item, quantity: 1 }]);
        const input = discountInput({ usageLimit: 1 }); await s.createDiscount(input);
        const draft = await s.createDraft([input.code!], 'guest');
        const cancelled = await s.accept(draft, 'guest'); await s.release(cancelled);
        await s.recordPaid(await s.accept(await s.createDraft([input.code!], 'member'), 'member'));
        expect(await s.reconcile(draft, 'paid')).toBe(cancelled);
        const before = await s.orderDetail(cancelled);
        expect(await s.redemptionStates(cancelled)).toEqual(['confirmed']);
        expect(before.attention.discounts).toHaveLength(1);
        expect(before.attention.discounts?.[0].kind).toBe('discount_limit_exceeded');
        await s.reconcile(draft, 'paid');
        expect((await s.orderDetail(cancelled)).attention.discounts).toEqual(before.attention.discounts);
        await s.ship(cancelled);
        expect((await s.db.query('select count(*)::int n from public.order_fulfillments where order_id=$1 and cancelled_at is null', [cancelled])).rows[0].n).toBe(1);
        await installDiscountDbBridge(page, s);
        await page.goto(`/admin/orders/${cancelled}`);
        await expect(page.getByText('割引の上限を超えた注文', { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
