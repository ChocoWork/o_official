/**
 * FR-ADMIN-101 手で配達済みにする（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-489（AC-01〜AC-03）・FREQ-492（AC-01）・FREQ-493（AC-01）
 *
 * 管理画面の窓口だけを差し替え（実装計画 P22）、配達済みにする操作は手元の DB の本物の関数、
 * 配達済みのメールは起動したアプリの毎分の定期処理と Mailpit で確かめる。追跡はオフのまま（手の操作はオフでもできる）。
 */
import { expect, test } from '@playwright/test';
import {
  addDays,
  createAdminActor,
  createPaidOrderFixture,
  createShippedFixture,
  deliveryViewports,
  expectDialogFits,
  expectMailCountStays,
  expectNoHorizontalOverflow,
  fulfillmentRow,
  jstDateOf,
  jstMonthDay,
  jstToday,
  markDeliveredInDb,
  mockAdminDeliveryBridge,
  newDeliveryBridgeLog,
  openOrderHistory,
  pollMails,
  readEvents,
  readFakeTrackingCalls,
  readFulfillment,
  readOutbox,
  readRegistration,
  returnDeadlineOf,
  returnWindowSettings,
  setTrackingFlagDirect,
  shipFixture,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';
import { cancelFulfillment, expectDbError } from './order-email-test-utils';
import { openOrderTab } from './order-fulfillment-test-utils';

const EXPLANATION_OFF = 'お客様に届いたことが分かった時に使います。返品の期限は、この日から数えます';
const NOTIFY_LABEL = 'お客様に配達済みのメールを送る';
const DATE_INVALID = '届いた日は、発送の日から今日までの日を選んでください。';
const DELIVERED_SUBJECT = '商品をお届けしました';

for (const viewport of deliveryViewports) {
  test.describe(`FR-ADMIN-101 fulfillment delivered (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-489-AC-01, FREQ-489-AC-02, FREQ-492-AC-01, FREQ-493-AC-01
    test('届いた日を選び手で配達済みとメールと期限を記録する', async ({ page, request }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        await setTrackingFlagDirect(client, false);
        const fx = await createShippedFixture(client, { numberPrefix, tag: 'E101A', notify: true });
        const fulfillmentId = fx.shipment.fulfillmentId;
        const shipped = await readFulfillment(client, fulfillmentId);
        const today = await jstToday(client);
        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [fx.orderId], actor: fx.actor, log });
        await openOrderTab(page);
        const orderRow = page.getByRole('row', { name: new RegExp(fx.orderId) });
        await expect(orderRow.getByText('配送中', { exact: true })).toBeVisible();

        const dialog = await openOrderHistory(page, fx.orderId);
        await fulfillmentRow(dialog, 1).getByRole('button', { name: '配達済みにする', exact: true }).click();

        // 届いた日は発送の日（日本時間）から今日までで、最初は今日。メールのチェックは発送のメールがオンなので出る
        await expect(dialog.getByText(EXPLANATION_OFF, { exact: true })).toBeVisible();
        const date = dialog.getByLabel('届いた日', { exact: true });
        await expect(date).toHaveValue(today);
        await expect(date).toHaveAttribute('min', jstDateOf(shipped.shipped_at));
        await expect(date).toHaveAttribute('max', today);
        await expect(dialog.getByRole('checkbox', { name: NOTIFY_LABEL, exact: true })).toBeChecked();
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, dialog);

        await date.fill(today);
        await dialog.getByRole('button', { name: '配達済みにする', exact: true }).click();

        await expect(dialog.getByText('配達済みにしました。', { exact: true })).toBeVisible();
        expect(log.deliveredPosts).toHaveLength(1);
        expect(log.deliveredPosts[0].status).toBe(200);
        expect(Object.keys(log.deliveredPosts[0].body).sort()).toEqual(['deliveredOn', 'notifyCustomer', 'requestKey']);
        expect(log.deliveredPosts[0].body).toMatchObject({ deliveredOn: today, notifyCustomer: true });

        // 手元の DB: 手で（manual）配達済み。出来事は管理者つき、届いた日の日本時間の日付は選んだ日
        const after = await readFulfillment(client, fulfillmentId);
        expect(after.delivery_status).toBe('delivered');
        expect(after.delivered_at).not.toBeNull();
        expect(jstDateOf(after.delivered_at as Date)).toBe(today);
        const events = await readEvents(client, fulfillmentId);
        expect(events.map((event) => [event.tracking_version, event.status, event.source])).toEqual([
          [1, 'confirmed', 'shipment'],
          [1, 'delivered', 'manual'],
        ]);
        expect(events[1].created_by).toBe(fx.actor.id);
        // 追跡オフ: 登録も外への呼び出しも無い
        expect(await readRegistration(client, fulfillmentId)).toBeUndefined();
        expect(await readFakeTrackingCalls(fx.shipment.pair)).toEqual([]);

        // 履歴: 届いた日と出どころ「手で」、配送の出来事の行（追跡オフなので現在の状況の行は出さない）
        const row = fulfillmentRow(dialog, 1);
        const deliveredAt = after.delivered_at as Date;
        await expect(row.getByText(`お届け日 ${jstMonthDay(deliveredAt)}（手で）`, { exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: '配達済みにする', exact: true })).toHaveCount(0);
        await expect(dialog.getByText('配送の状況（1回目）', { exact: true })).toHaveCount(2);

        // 返品の期限は、届いた日（日本時間の日付）から数える
        const settings = await returnWindowSettings(client);
        expect(await returnDeadlineOf(client, fx.orderId, fulfillmentId)).toBe(
          settings.windowDays === null ? null : addDays(today, settings.windowDays),
        );

        // 配達済みのメールが1通。届いた日・不具合の連絡の案内（設定の日数。無制限なら案内なし）・注文の画面のリンクが入る
        const mails = await pollMails(request, fx.email, DELIVERED_SUBJECT, 1);
        expect(mails[0].Subject).toBe(`【Le Fil des Heures】${DELIVERED_SUBJECT}（${fx.orderNumber}）`);
        const text = mails[0].Text;
        expect(text).toContain('ご注文の商品をお届けしました。');
        expect(text).toContain(`お届け日: ${jstMonthDay(deliveredAt)}`);
        expect(text).toContain('・E2E配送のシャツ（ホワイト / M） x1');
        expect(text).toMatch(new RegExp(`ご注文の確認はこちら: \\S+/account/orders/${fx.orderId}`));
        const guidance = (days: number) => `商品に不具合がございましたら、到着から ${days} 日以内にご注文の画面またはお問い合わせからご連絡ください`;
        if (settings.windowDays === null) {
          expect(text).not.toContain('商品に不具合がございましたら');
        } else {
          expect(text).toContain(guidance(settings.windowDays));
        }
        await expectMailCountStays(request, fx.email, DELIVERED_SUBJECT, 1);
        expect(await readOutbox(client, fx.orderId, ['delivered'])).toMatchObject([{ status: 'sent', fulfillment_id: fulfillmentId }]);

        // 一覧は読み直され、全部の発送が配達済みの注文の進み具合は「配達済み」
        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        await expect(orderRow.getByText('配達済み', { exact: true })).toBeVisible();
        await expect(orderRow.getByText('配送中', { exact: true })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      });
    });

    // FREQ-489-AC-01, FREQ-489-AC-02, FREQ-489-AC-03
    test('取消と配達済みの操作を出さず通知オフを保つ', async ({ page, request }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        await setTrackingFlagDirect(client, false);
        const actor = await createAdminActor(client);
        const order = await createPaidOrderFixture(client, { label: 'e101b', quantity: 3, actor });
        // 1回目: 知らせない発送（これを画面で配達済みにする）、2回目: 取り消した発送、3回目: すでに配達済みの発送
        const first = await shipFixture(client, order, { numberPrefix, tag: 'E101B1', quantity: 1, notify: false });
        const second = await shipFixture(client, order, { numberPrefix, tag: 'E101B2', quantity: 1, notify: true });
        const third = await shipFixture(client, order, { numberPrefix, tag: 'E101B3', quantity: 1, notify: true });
        await cancelFulfillment(client, order.orderId, second.fulfillmentId, actor.id);
        const today = await jstToday(client);
        await markDeliveredInDb(client, {
          orderId: order.orderId, fulfillmentId: third.fulfillmentId, actorId: actor.id, deliveredOn: today, notify: false,
        });

        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [order.orderId], actor, log });
        await openOrderTab(page);
        const dialog = await openOrderHistory(page, order.orderId);
        const buttons = (number: number) => ({
          edit: fulfillmentRow(dialog, number).getByRole('button', { name: '伝票番号を直す', exact: true }),
          delivered: fulfillmentRow(dialog, number).getByRole('button', { name: '配達済みにする', exact: true }),
          cancel: fulfillmentRow(dialog, number).getByRole('button', { name: 'この発送を取り消す', exact: true }),
        });

        // ボタンの条件: 取り消した発送には3つとも出ない。配達済みの発送には「配達済みにする」だけが出ない
        await expect(fulfillmentRow(dialog, 2).getByText('取り消し済み', { exact: true })).toBeVisible();
        for (const button of Object.values(buttons(2))) await expect(button).toHaveCount(0);
        await expect(buttons(3).edit).toBeVisible();
        await expect(buttons(3).delivered).toHaveCount(0);
        await expect(buttons(1).edit).toBeVisible();
        await expect(buttons(1).delivered).toBeVisible();
        await expect(buttons(1).cancel).toBeVisible();

        // DB も、取り消した発送・配達済みの発送への配達済みの操作を断る
        await expectDbError(
          markDeliveredInDb(client, { orderId: order.orderId, fulfillmentId: second.fulfillmentId, actorId: actor.id, deliveredOn: today, notify: false }),
          'DELIVERY_FULFILLMENT_CANCELLED',
        );
        await expectDbError(
          markDeliveredInDb(client, { orderId: order.orderId, fulfillmentId: third.fulfillmentId, actorId: actor.id, deliveredOn: today, notify: false }),
          'DELIVERY_ALREADY_DELIVERED',
        );

        // 1回目を配達済みにする: 知らせない発送なので、メールのチェックは出ない。届いた日の下限・上限が入力に付く
        await buttons(1).delivered.click();
        await expect(dialog.getByText(EXPLANATION_OFF, { exact: true })).toBeVisible();
        await expect(dialog.getByRole('checkbox', { name: NOTIFY_LABEL, exact: true })).toHaveCount(0);
        const date = dialog.getByLabel('届いた日', { exact: true });
        const shippedJst = jstDateOf((await readFulfillment(client, first.fulfillmentId)).shipped_at);
        await expect(date).toHaveAttribute('min', shippedJst);
        await expect(date).toHaveAttribute('max', today);
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, dialog);

        // 今日より後の日は選べず、窓口へは送らない
        await date.fill(addDays(today, 1));
        await dialog.getByRole('button', { name: '配達済みにする', exact: true }).click();
        await expect(dialog.getByText(DATE_INVALID, { exact: true })).toBeVisible();
        expect(log.deliveredPosts).toHaveLength(0);

        await date.fill(today);
        await dialog.getByRole('button', { name: '配達済みにする', exact: true }).click();
        await expect(dialog.getByText('配達済みにしました。', { exact: true })).toBeVisible();
        expect(log.deliveredPosts).toHaveLength(1);
        expect(log.deliveredPosts[0].body).toMatchObject({ deliveredOn: today, notifyCustomer: false });

        // 手の配達済みは記録され、発送の通知の選択（オフ）は変わらず、配達済みのメールは作られず届かない
        const done = await readFulfillment(client, first.fulfillmentId);
        expect(done).toMatchObject({ delivery_status: 'delivered', notify_customer: false });
        expect((await readEvents(client, first.fulfillmentId)).map((event) => [event.status, event.source])).toEqual([
          ['confirmed', 'shipment'],
          ['delivered', 'manual'],
        ]);
        expect(await readOutbox(client, order.orderId, ['delivered', 'out_for_delivery', 'shipping_update'])).toEqual([]);
        await expectMailCountStays(request, order.email, DELIVERED_SUBJECT, 0, 2);
        await expect(buttons(1).delivered).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
