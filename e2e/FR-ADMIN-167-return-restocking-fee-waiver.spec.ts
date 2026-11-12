/**
 * FREQ-642-AC-35: 受け取りごとの返品手数料免除。見込みは本物、確定は165と同じ入口でStripeだけを差し替える。
 * 率10%は試験自身の返品行にだけ設定する。既存の承認helperが返送先と有効フラグを整えるためisolated-globalで実行する。
 */
import { expect, test } from '@playwright/test';
import { CHECKOUT_VIEWPORTS } from './checkout-flow-helpers';
import { installDiscountDbBridge, withDiscountScenario } from './discount-test-utils';
import { detailSection, openOrderDetail } from './order-fulfillment-test-utils';
import { RETURN_TEXT, UNIT_STATES, confirmButton, formatYen, openReceiveDialog, readReturnBreakdown, returnLabelOf, setUnitState } from './return-test-utils';
import { createApprovedReturn, installReceiveBridge, refundsOf, seedSnapshotOrder, yenOf } from './unit-binding-test-utils';

test.use({ trace: 'off', locale: 'ja-JP' });
for (const viewport of CHECKOUT_VIEWPORTS) {
  test.describe(`FR-ADMIN-167 ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('FREQ-642-AC-35: 店長が免除にチェックすると返品の手数料行が消え返金が18,000円から20,000円へ上がる', async ({ page }) => {
      test.setTimeout(240_000);
      await withDiscountScenario(`ub167-ac35-${viewport.name}`, async (s) => {
        const order = await seedSnapshotOrder(s.db, {
          actorId: s.admin.userId, lines: [{ price: 20_000, quantity: 1 }], definitions: () => [],
        });
        await s.recordPaid(order.orderId);
        const ret = await createApprovedReturn(s.db, {
          orderId: order.orderId, fulfillmentId: order.fulfillmentId!, actorId: s.admin.userId,
          groups: [{ orderItemId: order.orderItemIds[0], quantity: 1 }],
          restockingPercent: 10,
        });
        await installDiscountDbBridge(page, s, 'admin');
        const bridge = await installReceiveBridge(page, s.admin.userId);
        await openOrderDetail(page, order.orderId);
        await detailSection(page, '返品とキャンセルの申し込み').getByRole('button', { name: /^(返品|受け取る|額を決めて返金する)$/ }).first().click();
        const dialog = await openReceiveDialog(page, order.orderId, returnLabelOf(order.orderId, ret.number));
        await setUnitState(dialog, 0, UNIT_STATES.keep);
        const breakdown = dialog.getByRole('group', { name: '返金の内訳', exact: true });
        await expect(breakdown).toBeVisible();
        expect(yenOf((await readReturnBreakdown(dialog))['返金額'])).toBe(18_000);
        await expect(breakdown.getByText('返品の手数料', { exact: true })).toBeVisible();
        await dialog.getByRole('checkbox', { name: '返品手数料免除', exact: true }).check();
        await expect(dialog.getByRole('spinbutton', { name: '返金額', exact: true })).toHaveValue('20000');
        await expect(breakdown.getByText('返品の手数料', { exact: true })).toHaveCount(0);
        expect(yenOf((await readReturnBreakdown(dialog))['返金額'])).toBe(20_000);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
        expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
        await confirmButton(dialog, RETURN_TEXT.receiveAll(formatYen(20_000))).click();
        await expect.poll(() => bridge.results.length, { timeout: 60_000 }).toBe(1);
        expect(bridge.posts[0].body.restockingFeeWaived).toBe(true);
        expect((await refundsOf(s.db, order.orderId)).map(r => r.amount)).toEqual([20_000]);
        expect((await s.db.query('select restocking_fee_waived from public.order_return_receipts where return_id=$1', [ret.returnId])).rows)
          .toEqual([{ restocking_fee_waived: true }]);
      }, { returnSettings: true });
    });
  });
}
