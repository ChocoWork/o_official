import { randomUUID } from 'node:crypto';
import { SHOP_ALERT_TO } from './return-test-utils';
import { orderNumberOf } from './order-fulfillment-test-utils';
import {
  test, expect, viewports, unshipped, appJson, expectMails, noOverflow,
} from './return-request-test-utils';

test.use({ trace: 'off' });
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-039 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('キャンセルありの設定で未発送の品を申し込み、状態と2種類のメールを確認し、2つ目を断る', async ({ page, request, rr }) => {
      // FREQ-481-AC-01, FREQ-481-AC-02, FREQ-481-AC-03, FREQ-480-AC-07, FREQ-484-AC-06
      test.setTimeout(180_000);
      await rr.db.query("update public.shop_return_settings set request_types='returns_and_cancellations' where id=1");
      const fx = await unshipped(rr);
      await rr.login();
      await page.goto('/account/orders/' + fx.orderId);
      await page.getByTestId('order-cancel-open').click();
      const form = page.getByTestId('cancel-request-form');
      await expect(form.getByRole('heading', { name: 'キャンセルのお申し込み', exact: true })).toBeVisible();
      await form.getByRole('button', { name: '申し込む', exact: true }).click();
      await expect(form).toContainText('キャンセルする商品を選んでください。');
      await form.getByRole('checkbox', { name: 'E2Eシャツ（ホワイト / M）', exact: true }).check();
      await form.getByRole('combobox', { name: '数', exact: true }).selectOption('2');
      await form.getByRole('textbox', { name: 'ご連絡事項（任意・300字まで）', exact: true }).fill('試験の連絡事項');
      await form.getByRole('button', { name: '申し込む', exact: true }).click();
      await expect(page.getByTestId('order-cancel-notice')).toHaveText('キャンセルのお申し込みを受け付けました。内容を確かめて、メールでご連絡します。');
      await expect(page.getByTestId('order-cancel-request-status')).toHaveText('キャンセルのお申し込み中');
      await expect(page.getByTestId('order-cancel-open')).toHaveCount(0);
      const saved = (await rr.db.query('select id,status,customer_note from public.order_cancel_requests where order_id=$1', [fx.orderId])).rows;
      expect(saved.length).toBe(1);
      expect(saved[0]).toMatchObject({ status: 'requested', customer_note: '試験の連絡事項' });
      const lines = (await rr.db.query('select order_item_id,quantity from public.order_cancel_request_lines where cancel_request_id=$1', [saved[0].id])).rows;
      expect(lines).toEqual([{ order_item_id: fx.orderItemIds[0], quantity: 2 }]);
      const response = await appJson<{ code: string }>(page, '/api/orders/' + fx.orderId + '/cancel-request', {
        requestKey: randomUUID(), lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], customerNote: null,
      });
      expect(response.status).toBe(409); expect(response.body.code).toBe('CANCEL_REQUEST_EXISTS');
      const order = orderNumberOf(fx.orderId);
      await expectMails(request, rr.member.email, '【Le Fil des Heures】キャンセルのお申し込みを受け付けました（' + order + '）',
        ['ご注文（' + order + '）のキャンセルのお申し込みを受け付けました。', '・E2Eシャツ（ホワイト / M） × 2']);
      await expectMails(request, SHOP_ALERT_TO, '【要対応】キャンセルの申し込みが届きました（' + order + '）',
        ['お客様からキャンセルの申し込みが届きました。', '管理画面の注文の一覧で「キャンセルの申し込み」を押して、品を外すかお断りしてください。']);
      const outbox = (await rr.db.query(
        "select kind,cancel_request_id from private.order_email_outbox where order_id=$1 and kind in ('cancel_request_received','cancel_request_shop') order by kind", [fx.orderId],
      )).rows;
      expect(outbox).toEqual([
        { kind: 'cancel_request_received', cancel_request_id: saved[0].id },
        { kind: 'cancel_request_shop', cancel_request_id: saved[0].id },
      ]);
      await noOverflow(page);
    });

    test('返品だけの設定ではキャンセルの入口を出さず、直接の申し込みも断る', async ({ page, rr }) => {
      // FREQ-481-AC-01
      const fx = await unshipped(rr, 'pending');
      await rr.login();
      await page.goto('/account/orders/' + fx.orderId);
      await expect(page.getByText(orderNumberOf(fx.orderId))).toBeVisible();
      await expect(page.getByTestId('order-cancel-open')).toHaveCount(0);
      const response = await appJson<{ code: string }>(page, '/api/orders/' + fx.orderId + '/cancel-request', {
        requestKey: randomUUID(), lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }], customerNote: null,
      });
      expect(response.status).toBe(409); expect(response.body.code).toBe('RETURN_REQUESTS_CLOSED');
    });
  });
}
