import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ACCOUNT-045 (${viewport.width}px)`, () => {
    test('FREQ-551-AC-01: ２着37000円の１着返品は17000円で次は20000円になる', async ({ page }) => {
      test.setTimeout(360_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('member-return', async (s) => {
        const order = await s.repeatOrder();
        await s.ship(order.orderId);
        await installDiscountDbBridge(page, s, 'member');
        await page.goto(`/account/orders/${order.orderId}`);
        await expect(page.locator('#main-content')).toContainText('37,000');
        // Real customer HTTP application, then real admin HTTP approval and receipt.
        const returned = await s.returnOne(order.orderId, order.orderItemId);
        expect(returned.amounts).toEqual([17_000, 37_000]);
        expect(returned.waitingAmount).toBe(17_000);
        await s.refundReturn(returned.returnId, 17_000);
        const next = await s.refundableAmounts(order.orderId, order.orderItemId);
        expect(next).toEqual([20_000]);
        await page.reload();
        await expect(page.locator('#main-content')).toContainText('17,000');
        expect((await s.orderDetail(order.orderId)).amounts.refundedAmount).toBe(17_000);
        expect(await s.redemptionStates(order.orderId)).toEqual(['confirmed']);
        // A set's remaining item keeps its frozen paid amount after the other item is refunded.
        const set = await s.setOrder();
        expect(set.unitAmounts.reduce((sum, amount) => sum + amount, 0)).toBe(27_000); // 20,000 + 10,000 - the 3,000 set discount
        await s.refund(set.orderId, set.orderItemIds[0], 1, set.unitAmounts[0]);
        expect(await s.refundableAmounts(set.orderId, set.orderItemIds[1])).toEqual([set.unitAmounts[1]]);
        const legacy = await s.legacyOrder(false);
        expect(await s.refundableAmounts(legacy.orderId, legacy.orderItemId)).toEqual([18_500, 18_500]);
        await expectNoHorizontalOverflow(page);
      }, { returnSettings: true });
    });
  });
}
