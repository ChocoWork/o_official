import { beginRefund, expectDbError, runWorkerUntil } from './order-email-test-utils';
import {
  createReturnInDb, receiveReturnInDb, returnLabelOf, openReturnsDialog, openReceiveDialog,
  setUnitState, UNIT_STATES, RETURN_TEXT, shopAlertsFor,
} from './return-test-utils';
import { orderNumberOf } from './order-fulfillment-test-utils';
import {
  test, expect, viewports, shipped, requestDb, defaultApproval, approveDb, adminScene, noOverflow,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ADMIN-096 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('サポートは申し込みの返品を計算どおり自動返金し、店への返金待ちの知らせを作らない', async ({ page, rr }) => {
      // FREQ-483-AC-01, FREQ-483-AC-02
      const fx = await shipped(rr);
      const ret = await requestDb(rr, fx);
      await approveDb(rr, ret.id, await defaultApproval(rr, fx, ret.id), fx.actorId);
      const scene = await adminScene(page, rr, fx, 'supporter');
      await openReturnsDialog(page, fx.orderId, '受け取る');
      const dialog = await openReceiveDialog(page, fx.orderId, returnLabelOf(fx.orderId, ret.number));
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(dialog.getByText('受け取ると、計算どおり ￥5,000 を自動で返金します（額は変えられません）。', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('radio', { name: '計算どおり ￥5,000 を返金する', exact: true })).toBeChecked();
      await expect(dialog.getByLabel(/^返金額（返せる額/)).toHaveCount(0);
      await dialog.getByRole('button', { name: 'すべて受け取って ￥5,000 を返金する', exact: true }).click();
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      expect(scene.state.posts.receive[0].body).toMatchObject({ refundChoice: 'now', refundAmount: null, refundShippingAmount: 0 });
      const rows = (await rr.db.query('select actor_can_refund,refund_choice,refund_id from public.order_return_receipts where return_id=$1', [ret.id])).rows;
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ actor_can_refund: false, refund_choice: 'now' });
      expect(typeof rows[0].refund_id).toBe('string');
      const refund = (await rr.db.query('select source,amount,status from public.order_refunds where id=$1', [rows[0].refund_id])).rows[0];
      expect(refund).toEqual({ source: 'return', amount: 5000, status: 'succeeded' });
      expect(Number((await rr.db.query("select count(*) from private.order_email_outbox where return_id=$1 and kind='return_refund_pending_shop'", [ret.id])).rows[0].count)).toBe(0);
      await noOverflow(page);
    });

    test('お店が作った返品と返送不要の申し込みでは今返金を許さず、店の返品は相談で返金待ちになる', async ({ page, request, rr }) => {
      // FREQ-483-AC-03
      const fx = await shipped(rr);
      const created = await createReturnInDb(rr.db, fx, { lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], notify: false });
      await expectDbError(receiveReturnInDb(rr.db, created.returnId, fx.actorId, {
        units: [{ lineId: created.lineIds[fx.orderItemIds[0]], disposition: 'restocked', quantity: 1 }], canRefund: false, choice: 'now',
      }), 'RETURN_FORBIDDEN');
      const scene = await adminScene(page, rr, fx, 'supporter');
      await openReturnsDialog(page, fx.orderId, '受け取る');
      const dialog = await openReceiveDialog(page, fx.orderId, returnLabelOf(fx.orderId, created.number));
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await expect(dialog.getByRole('radio', { name: /^計算どおり/ })).toHaveCount(0);
      await expect(dialog.getByText(RETURN_TEXT.supportRefundNote, { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: RETURN_TEXT.supportConsultButton, exact: true }).click();
      await expect.poll(() => scene.state.posts.receive.length).toBe(1);
      expect(scene.state.posts.receive[0].body.refundChoice).toBe('consult');
      expect(Number((await rr.db.query('select count(*) from public.order_refunds where order_id=$1', [fx.orderId])).rows[0].count)).toBe(0);
      await runWorkerUntil(request, async () => (await shopAlertsFor(request, orderNumberOf(fx.orderId))).length === 1, '返金待ちの店への知らせが1通届く');
      const other = await shipped(rr);
      const ret = await requestDb(rr, other);
      const approval = await defaultApproval(rr, other, ret.id);
      await approveDb(rr, ret.id, { ...approval, returnMethod: 'not_required' }, other.actorId);
      await expectDbError(receiveReturnInDb(rr.db, ret.id, other.actorId, {
        units: [{ lineId: approval.lines[0].returnLineId, disposition: 'restocked', quantity: 1 }], canRefund: false, choice: 'now',
      }), 'RETURN_FORBIDDEN');
    });

    test('Review Focus 5 確かめ中の返金がある今返金は何も受け取らず、相談なら受け取れる', async ({ page, rr }) => {
      // FREQ-483-AC-04
      const fx = await shipped(rr);
      const ret = await requestDb(rr, fx);
      await approveDb(rr, ret.id, await defaultApproval(rr, fx, ret.id), fx.actorId);
      await beginRefund(rr.db, fx.orderId, { amount: 100, actorId: fx.actorId, notifyCustomer: false });
      const scene = await adminScene(page, rr, fx, 'supporter');
      await openReturnsDialog(page, fx.orderId, '受け取る');
      const dialog = await openReceiveDialog(page, fx.orderId, returnLabelOf(fx.orderId, ret.number));
      await setUnitState(dialog, 0, UNIT_STATES.restock);
      await dialog.getByRole('button', { name: 'すべて受け取って ￥5,000 を返金する', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('確かめ中の返金があります。先に確かめてください。');
      expect(Number((await rr.db.query('select count(*) from public.order_return_receipts where return_id=$1', [ret.id])).rows[0].count)).toBe(0);
      expect(Number((await rr.db.query("select count(*) from public.stock_movements where return_id=$1 and reason='return'", [ret.id])).rows[0].count)).toBe(0);
      expect(Number((await rr.db.query('select count(*) from public.order_refunds where order_id=$1', [fx.orderId])).rows[0].count)).toBe(1);
      await dialog.getByRole('radio', { name: '額を相談してから返金する（店長が額を決めます）', exact: true }).check();
      await dialog.getByRole('button', { name: RETURN_TEXT.supportConsultButton, exact: true }).click();
      await expect.poll(() => scene.state.posts.receive.length).toBe(2);
      expect(Number((await rr.db.query('select count(*) from public.order_return_receipts where return_id=$1', [ret.id])).rows[0].count)).toBe(1);
      expect(Number((await rr.db.query("select count(*) from private.order_email_outbox where return_id=$1 and kind='return_refund_pending_shop'", [ret.id])).rows[0].count)).toBe(1);
    });
  });
}
