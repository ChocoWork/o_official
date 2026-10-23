/**
 * FREQ-506 / 波1 Task 1。
 * 選択欄は管理APIを差し替えて確認し、メールは手元DBの取消関数→worker→Mailpitで確認する。
 * controllerが本番ビルドと手元Supabaseで実行する。実Stripeは呼ばない。
 */
import { expect, test } from '@playwright/test';
import { adminOrder, mockAdminSession, mockOrderList, openOrderTab, viewports } from './order-fulfillment-test-utils';
import { materialLineOf, mockRefundRoutes, newRefundRouteState, openPaidCancelDialog, refundMaterialsOf } from './refund-test-utils';
import { createActor, createOrderWithLines, mailBodies, runWorkerUntil, sentOutboxCount, uniqueEmail, withLocalDb } from './order-email-test-utils';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const UNPAID_ID = 'a6b2c3d4-0000-4000-8000-000000000001';
const PAID_ID = 'a6b2c3d4-0000-4000-8000-000000000002';
const OPTIONS = [
  { value: '', label: '選んでください' },
  { value: 'customer_request', label: 'お客様の都合' },
  { value: 'payment_declined', label: '支払いの拒否' },
  { value: 'suspected_fraud', label: '不正' },
  { value: 'stock_unavailable', label: '在庫切れ' },
  { value: 'shop_error', label: 'お店の誤り' },
  { value: 'other', label: 'その他' },
];
const UNPAID_LEADS = [
  ['stock_unavailable', '商品をご用意できなくなったため、ご注文を取り消しました。ご迷惑をおかけし、申し訳ございません。'],
  ['payment_declined', 'お支払いを確認できなかったため、ご注文を取り消しました。'],
  ['shop_error', '当店の不手際により、ご注文を取り消しました。ご迷惑をおかけし、誠に申し訳ございません。'],
] as const;

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-105 cancel reasons (${viewport.name})`, () => {
    test('未入金と支払済みの取消に同じ6理由が決定した順番で表示される', async ({ page }) => {
      // FREQ-506-AC-01
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockAdminSession(page);
      await mockOrderList(page, () => [
        adminOrder({ id: UNPAID_ID, status: '未決済', orderStatus: 'pending', canCancel: true, cancelKind: 'unpaid', canShip: false, canRefund: false }),
        adminOrder({ id: PAID_ID, canCancel: true, cancelKind: 'paid', canShip: false, canRefund: true }),
      ]);
      const materials = refundMaterialsOf({ orderId: PAID_ID, lines: [materialLineOf({ orderItemId: 'b6b2c3d4-0000-4000-8000-000000000001' })] });
      await mockRefundRoutes(page, PAID_ID, newRefundRouteState(materials));
      await openOrderTab(page);
      await page.getByRole('row', { name: new RegExp(UNPAID_ID) }).getByRole('button', { name: 'キャンセル', exact: true }).click();
      const unpaid = page.getByRole('dialog', { name: '注文を取り消す', exact: true });
      expect(await unpaid.getByLabel('取消の理由').getByRole('option').evaluateAll((options) =>
        options.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent })),
      )).toEqual(OPTIONS);
      await unpaid.getByRole('button', { name: '戻る', exact: true }).click();
      const paid = await openPaidCancelDialog(page, PAID_ID);
      expect(await paid.getByLabel('取消の理由').getByRole('option').evaluateAll((options) =>
        options.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent })),
      )).toEqual(OPTIONS);
    });

    for (const from of ['payment_in_progress', 'pending'] as const) {
      for (const [reason, lead] of UNPAID_LEADS) {
        test(`未入金 ${from} を ${reason} で取り消すと、指定の冒頭と未課金の案内がMailpitに届く`, async ({ request }) => {
          // FREQ-506-AC-02
          test.setTimeout(180_000);
          const email = uniqueEmail(`cancel-reasons-${reason}-${from}-${viewport.name}`);
          const orderId = await withLocalDb(async (db) => {
            const actorId = await createActor(db);
            const order = await createOrderWithLines(db, email, [{ name: 'E2E取消シャツ', quantity: 1, fulfillmentType: 'stock' }], { status: from });
            await db.query(
              "select released from public.release_stock_for_unpaid_order($1, $2::public.order_status, 'cancelled', 'admin_cancel', $3, null, $4, null, true)",
              [order.orderId, from, actorId, reason],
            );
            return order.orderId;
          });
          await runWorkerUntil(request, async () => (await sentOutboxCount(orderId, 'canceled')) >= 1, '取消メールが送信済みになること');
          const mails = await mailBodies(request, email, 'ご注文取消のお知らせ');
          expect(mails.length).toBe(1);
          expect(mails[0].Text.includes(`\n\n${lead}\nお支払いは発生していません。`), '理由に合う冒頭と未課金の案内').toBe(true);
          expect(mails[0].Text.includes('不正')).toBe(false);
          expect(mails[0].Text.includes('返金')).toBe(false);
        });
      }
    }
  });
}
