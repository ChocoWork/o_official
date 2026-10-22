import { expect, test } from '@playwright/test';
import {
  customerApi, expectNoHorizontalOverflow, loginCustomer, setTrackingFlagDirect, withDeliveryScenario,
} from './delivery-tracking-test-utils';
import {
  createOrderStatusScenario, inspectOrderStatusPublicTransport, isolateOrderStatusApiIp,
  openOrderStatusPage, orderStatusViewports, prepareOrderStatusTestLink, reloadOrderStatusPage,
  verifyOrderStatusInPage, withOrderStatusDb,
} from './order-status-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.setTimeout(420_000);

for (const viewport of orderStatusViewports) {
  // FREQ-498-AC-02
  // FREQ-498-AC-03
  // FREQ-505-AC-04
  test(`${viewport.width}px 配送と返金の条件を会員とそろえ非公開の番号を混ぜない`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await isolateOrderStatusApiIp(page);
    // E-4 と同じ advisory lock と finally の設定復旧。status API は差し替えない。
    await withDeliveryScenario(async ({ client }) => {
      await withOrderStatusDb(async (db) => {
        await setTrackingFlagDirect(client, true);
        const order = await createOrderStatusScenario(db, { kind: 'delivery' });
        const token = await prepareOrderStatusTestLink(db, order.orderId);
        await openOrderStatusPage(page, token);
        const current = page.getByRole('region', { name: '配送情報（1回目）', exact: true });
        const delivered = page.getByRole('region', { name: '配送情報（3回目）', exact: true });
        await expect(current.getByText('輸送中', { exact: true }).first()).toBeVisible();
        await expect(current.getByText('配送の移り変わり', { exact: true })).toBeVisible(); // 追跡オンの時だけ出る。
        await expect(page.getByText('一部発送済み', { exact: true })).toBeVisible();
        await expect(page.getByText('発送準備中', { exact: true }).first()).toBeVisible();
        await expect(current.getByText('不在で持ち帰り', { exact: true })).toHaveCount(0); // 旧版だけの出来事。
        await expect(page.getByRole('region', { name: '配送情報（2回目）', exact: true })).toHaveCount(0); // 取り消し済み。
        await expect(delivered.getByText(/^お届け日 /)).toBeVisible();
        await expect(page.getByRole('link', { name: '配送状況を確認する', exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: '伝票番号', exact: true })).toHaveCount(0);
        expect(await inspectOrderStatusPublicTransport(page, token)).toEqual({ htmlPrivate: false, rscPrivate: false, rsc: true });
        const refunds = page.locator('section').filter({ has: page.getByRole('heading', { name: 'ご返金', exact: true }) });
        await expect(refunds.getByText('手続き中', { exact: true })).toBeVisible();
        await expect(refunds.getByText('完了', { exact: true })).toBeVisible();
        await expect(refunds.getByText('ご返金の合計', { exact: true })).toBeVisible();
        expect(await refunds.locator('dd').evaluateAll((nodes) => nodes.map((node) => node.textContent)))
          .toEqual(['￥1,000 手続き中', '￥2,000 完了', '￥3,000']);
        expect(await page.evaluate(() => /E5_INTERNAL_REFUND|ご返金に失敗/.test(document.body.textContent ?? ''))).toBe(false);
        await expectNoHorizontalOverflow(page);
        await setTrackingFlagDirect(client, false);
        await reloadOrderStatusPage(page);
        await expect(current.getByText('配送の移り変わり', { exact: true })).toHaveCount(0);
        await expect(current.getByText('輸送中', { exact: true })).toHaveCount(0);
        await expect(delivered.getByText(/^お届け日 /)).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await setTrackingFlagDirect(client, true);
        await db.query(`update private.fulfillment_tracking_registrations
          set ever_registered=false,registered_at=null
          where fulfillment_id in (select id from public.order_fulfillments where order_id=$1)`, [order.orderId]);
        await reloadOrderStatusPage(page);
        await expect(current.getByText('配送の移り変わり', { exact: true })).toHaveCount(0);
        await expect(current.getByText('輸送中', { exact: true })).toHaveCount(0);
        await expect(delivered.getByText(/^お届け日 /)).toBeVisible();
        await verifyOrderStatusInPage(page, order.lastFour!);
        await expect(page.getByRole('heading', { name: '伝票番号', exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: '配送状況を確認する', exact: true })).toHaveCount(2);
        await expectNoHorizontalOverflow(page);
        const member = await loginCustomer(page, `e5-delivery-${viewport.width}`);
        await db.query('update public.orders set user_id=$2 where id=$1', [order.orderId, member.userId]);
        const response = await customerApi(page, `/api/orders/${order.orderId}`);
        expect(response.status).toBe(200);
        expect(response.body.shipments.map((shipment) => shipment.number)).toEqual([1, 3]);
        expect(response.body.shipments.every((shipment) => !('delivery' in shipment))).toBe(true);
        expect(Boolean(response.body.shipments[1].deliveredAt)).toBe(true);
        expect(response.body.progress.key).toBe('ready');
        expect(response.body.progress.partiallyShipped).toBe(true);
        expect((response.body.refunds as Array<{ amount: string; status: string }>).map((refund) => [refund.amount, refund.status]))
          .toEqual([['￥1,000', 'processing'], ['￥2,000', 'completed']]);
        // 鍵無しの条件は view の単体で検証。起動したアプリの環境は変更しない。
      });
    });
  });
}
