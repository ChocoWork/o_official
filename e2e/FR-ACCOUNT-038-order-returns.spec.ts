import type { CustomerReturnStatus } from '@/lib/orders/returns/customer-return-types';
import { addVariant, receiveReturnInDb, exchangeItemRows, returnLabelOf } from './return-test-utils';
import { recordRefundResult, createFulfillment } from './order-email-test-utils';
import {
  test, expect, viewports, shipped, requestDb, line, defaultApproval, approveDb, section, noOverflow,
  type RR,
} from './return-request-test-utils';

test.use({ trace: 'off' });
async function stateOrder(rr: RR, state: CustomerReturnStatus) {
  const quantity = state === 'partially_received' ? 2 : 1;
  const fx = await shipped(rr, [{ name: 'E2Eシャツ', quantity, fulfillmentType: 'stock' }]);
  const ret = await requestDb(rr, fx, [line(fx, 0, { quantity })]);
  if (state === 'requested') return { fx, ret };
  if (state === 'declined') {
    await rr.db.query('select * from public.admin_decline_return($1::uuid,$2::uuid,$3::text,$4::text)',
      [ret.id, fx.actorId, 'other', 'お受けできません。\n<b>試験のメッセージ</b>']);
    return { fx, ret };
  }
  const approval = await defaultApproval(rr, fx, ret.id);
  if (state === 'awaiting_fee') {
    const variant = await addVariant(rr.db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
    approval.lines[0] = { ...approval.lines[0], resolution: 'exchange', exchangeVariantId: variant, exchangeMethod: 'stock' };
    approval.exchangeFee = 500;
  }
  await approveDb(rr, ret.id, approval, fx.actorId);
  if (state === 'accepted') return { fx, ret };
  const result = await receiveReturnInDb(rr.db, ret.id, fx.actorId, {
    units: [{ lineId: approval.lines[0].returnLineId, quantity: 1,
      disposition: state === 'partially_received' || state === 'inspecting' ? 'pending_inspection' : 'restocked' }],
    choice: state === 'awaiting_fee' ? 'none' : state === 'returned' ? 'now' : 'consult', notify: false,
  });
  if (state === 'returned' && result.refundId) await recordRefundResult(rr.db, result.refundId);
  return { fx, ret };
}
for (const viewport of viewports) {
  test.describe('FR-ACCOUNT-038 ' + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('返品の全8状態の言葉・添える文・返金額・お断りの文字を本物の注文 API と画面で確かめる', async ({ page, rr }) => {
      // FREQ-479-AC-05, FREQ-480-AC-02, FREQ-480-AC-07
      await rr.login();
      const cases: Array<[CustomerReturnStatus, string, string | null]> = [
        ['requested', 'お申し込み中', '内容を確かめて、メールでご連絡します。'],
        ['accepted', '返品の受付済み', null],
        ['partially_received', '一部をお受け取りしました', '残りの商品の返送のしかたは、下のとおりです。'],
        ['inspecting', 'お受け取りしました（確かめています）', '確かめてから、ご連絡します。'],
        ['awaiting_fee', 'お支払いをお待ちしています', 'ご案内のメールをご覧ください。'],
        ['refund_preparing', 'ご返金の準備中', null],
        ['returned', '返品済み', null],
        ['declined', 'お受けできませんでした', null],
      ];
      for (const [state, label, note] of cases) {
        const { fx, ret } = await stateOrder(rr, state);
        const data = await section(page, fx.orderId);
        expect(data.returns[0].customerStatus).toBe(state);
        const keys = Object.keys(data.returns[0]);
        for (const hidden of ['shopNote', 'declineReason', 'approvedByEmail', 'stripeFailureReason']) expect(keys).not.toContain(hidden);
        await page.goto('/account/orders/' + fx.orderId);
        const card = page.getByRole('region', { name: '返品番号 ' + returnLabelOf(fx.orderId, ret.number), exact: true });
        await expect(card.getByTestId('order-return-status')).toHaveText(label);
        if (note) await expect(card.getByTestId('order-return-note')).toHaveText(note);
        else await expect(card.getByTestId('order-return-note')).toHaveCount(0);
        if (state === 'returned') await expect(card.getByTestId('order-return-refund')).toHaveText('ご返金 ￥5,000');
        if (state === 'refund_preparing') await expect(card.getByTestId('order-return-refund')).toHaveCount(0);
        if (state === 'declined') {
          await expect(card.getByTestId('order-return-decline')).toContainText('当店より:');
          await expect(card.getByTestId('order-return-decline')).toContainText('<b>試験のメッセージ</b>');
          await expect(card.locator('b')).toHaveCount(0);
        }
        if (state !== 'accepted' && state !== 'partially_received') await expect(card.getByTestId('order-return-how-to')).toHaveCount(0);
        await noOverflow(page);
      }
    });

    test('受付中の返送のしかたは店負担・自己返送・送り状・返送不要を出し分ける', async ({ page, rr }) => {
      // FREQ-480-AC-03
      await rr.login();
      for (const [method, payer, fee, message] of [
        ['customer_ships', 'shop', 0, '返送料は当店が負担いたします。着払いでお送りください。'],
        ['customer_ships', 'customer', 0, '恐れ入りますが、返送料はお客様のご負担でお送りください。'],
        ['shop_label', 'customer', 800, '当店がご用意する送り状でお送りください。返送料 ￥800 をご返金額から差し引きます。'],
        ['not_required', 'shop', 0, '品物のご返送は不要です。'],
      ] as const) {
        const fx = await shipped(rr);
        const ret = await requestDb(rr, fx);
        const approval = await defaultApproval(rr, fx, ret.id);
        await approveDb(rr, ret.id, { ...approval, returnMethod: method, returnShippingPayer: payer, returnShippingFee: fee }, fx.actorId);
        await page.goto('/account/orders/' + fx.orderId);
        await expect(page.getByTestId('order-return-how-to')).toContainText(message);
        if (method === 'not_required') {
          await expect(page.getByTestId('order-return-address')).toHaveCount(0);
        } else {
          await expect(page.getByTestId('order-return-address')).toContainText('E2E返品センター');
          await expect(page.getByTestId('order-return-how-to')).toContainText('下記の返送先へお送りください。');
        }
      }
    });

    test('お返しのメッセージ・伝票と、交換の品の発送前後の一文が出る', async ({ page, rr }) => {
      // FREQ-480-AC-04
      await rr.login();
      const back = await shipped(rr);
      const request = await requestDb(rr, back);
      const approval = await defaultApproval(rr, back, request.id);
      await approveDb(rr, request.id, approval, back.actorId);
      await receiveReturnInDb(rr.db, request.id, back.actorId, {
        units: [{ lineId: approval.lines[0].returnLineId, disposition: 'sent_back', quantity: 1 }],
        // お返しのメッセージは必ず届ける決まりなので notify は true（DB は false を RETURN_ARGUMENT_INVALID で断る）
        choice: 'none', notify: true, sentBack: { message: 'タグが外れているためお返しします。', carrier: 'yamato', trackingNumber: 'E2E-SENT-BACK' },
      });
      await page.goto('/account/orders/' + back.orderId);
      await expect(page.getByTestId('order-return-sent-back')).toContainText('タグが外れているためお返しします。');
      await expect(page.getByTestId('order-return-sent-back')).toContainText('送り返しの伝票番号:');
      await expect(page.getByTestId('order-return-sent-back')).toContainText('E2E-SENT-BACK');
      const fx = await shipped(rr);
      const variant = await addVariant(rr.db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
      const ret = await requestDb(rr, fx, [line(fx, 0, { requestedResolution: 'exchange', requestedExchangeVariantId: variant })]);
      const exchangeApproval = await defaultApproval(rr, fx, ret.id);
      await approveDb(rr, ret.id, exchangeApproval, fx.actorId);
      await receiveReturnInDb(rr.db, ret.id, fx.actorId, {
        units: [{ lineId: exchangeApproval.lines[0].returnLineId, disposition: 'not_restocked', quantity: 1 }], choice: 'none', notify: false,
      });
      await page.goto('/account/orders/' + fx.orderId);
      await expect(page.getByTestId('order-return-exchange-shipping')).toHaveText('交換の品をお送りします。');
      const [item] = await exchangeItemRows(rr.db, fx.orderId);
      await createFulfillment(rr.db, fx.orderId, fx.actorId, { lines: [{ orderItemId: item.id, quantity: 1 }], trackingNumber: 'E2E-EXCHANGE', notify: false });
      await page.reload();
      await expect(page.getByTestId('order-return-exchange-shipping')).toHaveText('交換の品をお送りしました。');
      await noOverflow(page);
    });
  });
}
