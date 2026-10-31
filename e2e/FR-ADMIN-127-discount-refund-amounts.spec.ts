import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS, expectNoHorizontalOverflow } from './checkout-flow-helpers';
import { installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-127 (${viewport.width}px)`, () => {
    test('FREQ-551-AC-04: 安い１着を返した注文の状態別額と返金と割引の内訳が一致する', async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await withDiscountScenario('refund-amounts', async (s) => {
        const order = await s.repeatOrder(true);
        await s.ship(order.orderId);
        const returned = await s.returnOne(order.orderId, order.orderItemId);
        await s.refundReturn(returned.returnId, 17_000);
        const detail = await s.orderDetail(order.orderId);
        expect(detail.amounts).toMatchObject({ total: 42_000, discount: 3_000, refundedAmount: 17_000 });
        expect(detail.rows.find(r => r.status === 'returned')).toMatchObject({ lineAmount: 17_000, refundAmount: 17_000 });
        expect(detail.rows.filter(r => r.status !== 'returned').map(r => r.lineAmount).sort((x, y) => x - y)).toEqual([5_000, 20_000]);
        expect(detail.rows.find(r => r.orderItemId === order.otherOrderItemId!)).toMatchObject({ lineAmount: 5_000, refundAmount: 0 });
        expect(detail.discounts.map(d => d.amount)).toEqual([3_000]);
        await installDiscountDbBridge(page, s);
        await page.goto(`/admin/orders/${order.orderId}`);
        await expect(page.getByRole('region', { name: '割引の内訳', exact: true })).toContainText('3,000');
        const payment = page.locator('section[aria-labelledby="order-payment"]');
        await expect(payment.locator('dt:text-is("割引") + dd')).toContainText('3,000');
        await expect(payment.locator('dt:text-is("返金済み（成功）") + dd')).toContainText('17,000');
        await expect(payment.locator('dt:text-is("合計") + dd')).toContainText('42,000');
        await expect(page.locator('section[aria-labelledby="order-items"]')).toContainText('20,000');        const legacy = await s.legacyOrder();
        expect((await s.orderDetail(legacy.orderId)).rows.map(r => r.lineAmount).sort((a, b) => a - b)).toEqual([33, 33, 34]);
        const untouched = await s.db.query('select count(*)::int n from public.order_refund_lines l join public.order_refunds f on f.id=l.refund_id where f.order_id=$1 and l.order_item_id<>$2', [order.orderId, order.orderItemId]);
        expect(untouched.rows[0].n).toBe(0);
        expect(await s.refundableAmounts(order.orderId, order.otherOrderItemId!)).toEqual([5_000]);
        await expectNoHorizontalOverflow(page);
      }, { returnSettings: true });
    });
  });
}
