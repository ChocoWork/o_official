/**
 * FR-ADMIN-100 伝票番号を直す（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-488（AC-01〜AC-03）・FREQ-492（AC-01・AC-04）・FREQ-493（AC-01）
 *
 * 管理画面の窓口だけを差し替え（管理者のログイン・CSRF・権限は Task 9 の単体の試験が証明する。実装計画 P22）、
 * 直す操作は手元の DB の本物の関数、発送の更新のメールは起動したアプリの毎分の定期処理と Mailpit で確かめる。
 * 17TRACK は手元の作り物（127.0.0.1:4017）で、追跡オフの間は外へ何も送らないことも確かめる。
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  createShippedFixture,
  deliveryViewports,
  editTrackingInDb,
  expectDialogFits,
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
  expectMailCountStays,
  readEvents,
  readFakeTrackingCalls,
  readFulfillment,
  readOutbox,
  readRegistration,
  readTrackingChanges,
  returnDeadlineOf,
  returnWindowSettings,
  setTrackingFlagDirect,
  withDeliveryScenario,
  addDays,
} from './delivery-tracking-test-utils';
import { openOrderTab, orderNumberOf } from './order-fulfillment-test-utils';

const EXPLANATION_OFF = 'チェックを外すと、この先の配達済みのメールも送りません';
const DELIVERED_WARNING = '配達済みの記録が消え、返品の期限は新しい届いた日から数え直します';
const NOTIFY_LABEL = 'お客様に発送の更新のメールを送る';
const SHIPPING_UPDATE_SUBJECT = '発送の情報を更新しました';

/** 発送の更新のメールの全文（計画 C-6。明細の行は既存の発送のメールと同じ「・品名（色 / サイズ） x数」） */
function shippingUpdateText(input: { orderId: string; carrierLabel: string; trackingNumber: string; trackingUrl: string }): string {
  const orderNumber = orderNumberOf(input.orderId);
  return [
    '山田 花子 様',
    '',
    'ご注文の発送の情報を更新しました。',
    '',
    `注文番号: ${orderNumber}`,
    '',
    '発送した商品:',
    '・E2E配送のシャツ（ホワイト / M） x1',
    '',
    `配送業者: ${input.carrierLabel}`,
    `追跡番号: ${input.trackingNumber}`,
    `追跡はこちら: ${input.trackingUrl}`,
    '',
    '先にお知らせした伝票番号は使えません',
    '',
    `お問い合わせの際は、注文番号（${orderNumber}）をお問い合わせフォームにご入力ください。`,
    '',
    'Le Fil des Heures',
  ].join('\n');
}

for (const viewport of deliveryViewports) {
  test.describe(`FR-ADMIN-100 fulfillment tracking edit (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-488-AC-01, FREQ-488-AC-03, FREQ-492-AC-01, FREQ-493-AC-01
    test('追跡オフで番号を直し発送の更新が1通届く', async ({ page, request }) => {
      // 鍵の待ち（ほかの配送の試験が設定を使っている間）と毎分の処理の繰り返しがあるので長めに取る
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        await setTrackingFlagDirect(client, false);
        const fx = await createShippedFixture(client, { numberPrefix, tag: 'E100A', carrier: 'yamato', notify: true });
        const oldNumber = fx.shipment.trackingNumber;
        const newNumber = `${numberPrefix}-E100ANEW`;
        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [fx.orderId], actor: fx.actor, log });
        await openOrderTab(page);

        const dialog = await openOrderHistory(page, fx.orderId);
        const row = fulfillmentRow(dialog, 1);
        await expect(row).toContainText(`配送業者: ヤマト運輸 / 伝票番号: ${oldNumber}`);
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, dialog);

        // 直す画面は、履歴と同じダイアログの中で切り替わる。追跡オフの説明が出る
        await row.getByRole('button', { name: '伝票番号を直す', exact: true }).click();
        await expect(dialog.getByText(EXPLANATION_OFF, { exact: true })).toBeVisible();
        await expect(dialog.getByLabel('配送業者', { exact: true })).toHaveValue('yamato');
        await expect(dialog.getByLabel('伝票番号', { exact: true })).toHaveValue(oldNumber);
        const notify = dialog.getByRole('checkbox', { name: NOTIFY_LABEL, exact: true });
        await expect(notify).toBeChecked();
        await expectDialogFits(page, dialog);

        await dialog.getByLabel('配送業者', { exact: true }).selectOption('sagawa');
        await dialog.getByLabel('伝票番号', { exact: true }).fill(newNumber);
        await dialog.getByRole('button', { name: '伝票番号を直す', exact: true }).click();

        // 成功の知らせと、直しの行（前の値 → 新しい値）が履歴に出る
        await expect(dialog.getByText('伝票番号を直しました。', { exact: true })).toBeVisible();
        await expect(dialog.getByText('伝票番号を直した（1回目）', { exact: true })).toBeVisible();
        await expect(dialog.getByText(`ヤマト運輸 ${oldNumber} → 佐川急便 ${newNumber}`, { exact: true })).toBeVisible();
        await expect(dialog.getByText(/^お客様へのメール：(送信待ち|送信済み)$/)).toBeVisible();
        await expect(fulfillmentRow(dialog, 1)).toContainText(`配送業者: 佐川急便 / 伝票番号: ${newNumber}`);
        expect(log.trackingPosts).toHaveLength(1);
        expect(log.trackingPosts[0].status).toBe(200);
        expect(Object.keys(log.trackingPosts[0].body).sort()).toEqual(['carrier', 'notifyCustomer', 'requestKey', 'trackingNumber']);
        expect(log.trackingPosts[0].body).toMatchObject({ carrier: 'sagawa', trackingNumber: newNumber, notifyCustomer: true });

        // 手元の DB: 新しい番号・版が1つ進む・受付済みへ戻る・直しの記録と受付済みの出来事
        const fulfillment = await readFulfillment(client, fx.shipment.fulfillmentId);
        expect(fulfillment).toMatchObject({
          shipping_carrier: 'sagawa',
          tracking_number: newNumber,
          tracking_version: 2,
          delivery_status: 'confirmed',
          delivered_at: null,
          notify_customer: true,
        });
        expect(await readTrackingChanges(client, fx.shipment.fulfillmentId)).toEqual([
          {
            tracking_version: 2,
            from_carrier: 'yamato',
            from_tracking_number: oldNumber,
            to_carrier: 'sagawa',
            to_tracking_number: newNumber,
            notify_customer: true,
          },
        ]);
        expect((await readEvents(client, fx.shipment.fulfillmentId)).map((event) => [event.tracking_version, event.status, event.source])).toEqual([
          [1, 'confirmed', 'shipment'],
          [2, 'confirmed', 'tracking_edit'],
        ]);
        // 追跡オフの間は、17TRACK へ何も登録しない（登録の行も、外への呼び出しも無い）
        expect(await readRegistration(client, fx.shipment.fulfillmentId)).toBeUndefined();
        expect(await readFakeTrackingCalls({ carrier: 100062, number: oldNumber })).toEqual([]);
        expect(await readFakeTrackingCalls({ carrier: 100040, number: newNumber })).toEqual([]);

        // 発送の更新のメールが1通（発送のメールとは別）。全文は計画 C-6 のとおり
        const mails = await pollMails(request, fx.email, SHIPPING_UPDATE_SUBJECT, 1);
        expect(mails[0].Subject).toBe(`【Le Fil des Heures】${SHIPPING_UPDATE_SUBJECT}（${fx.orderNumber}）`);
        expect(mails[0].Text.trim()).toBe(
          shippingUpdateText({
            orderId: fx.orderId,
            carrierLabel: '佐川急便',
            trackingNumber: newNumber,
            trackingUrl: `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(newNumber)}`,
          }),
        );
        await pollMails(request, fx.email, '商品を発送いたしました', 1);
        await expectMailCountStays(request, fx.email, SHIPPING_UPDATE_SUBJECT, 1);
        const outbox = await readOutbox(client, fx.orderId, ['shipping_update']);
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ status: 'sent', fulfillment_id: fx.shipment.fulfillmentId, tracking_version: 2 });

        // 履歴を開き直すと送信済み。発送の更新のメールの行に「お客様へ再送」は無い（新3種類は再送できない）
        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        const reopened = await openOrderHistory(page, fx.orderId);
        await expect(reopened.getByText('お客様へのメール：送信済み', { exact: true })).toBeVisible();
        const mailRow = reopened.getByRole('listitem').filter({ hasText: '発送の更新のメール' });
        await expect(mailRow).toHaveCount(1);
        await expect(mailRow.getByRole('button', { name: '中身を見る', exact: true })).toBeVisible();
        await expect(mailRow.getByRole('button', { name: 'お客様へ再送', exact: true })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, reopened);
      });
    });

    // FREQ-488-AC-02, FREQ-492-AC-04, FREQ-493-AC-01
    test('配達済みの番号を直し通知を外す', async ({ page, request }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        await setTrackingFlagDirect(client, false);
        const fx = await createShippedFixture(client, { numberPrefix, tag: 'E100B', carrier: 'yamato', notify: true });
        const oldNumber = fx.shipment.trackingNumber;
        const newNumber = `${numberPrefix}-E100BNEW`;
        const fulfillmentId = fx.shipment.fulfillmentId;

        // 手で配達済み（メールあり）にして、配達済みのメールが1通届く。返品の期限は届いた日から数える
        const today = await jstToday(client);
        const delivered = await markDeliveredInDb(client, {
          orderId: fx.orderId, fulfillmentId, actorId: fx.actor.id, deliveredOn: today, notify: true,
        });
        const settings = await returnWindowSettings(client);
        const deliveredJst = jstDateOf(delivered.deliveredAt);
        expect(await returnDeadlineOf(client, fx.orderId, fulfillmentId)).toBe(
          settings.windowDays === null ? null : addDays(deliveredJst, settings.windowDays),
        );
        await pollMails(request, fx.email, '商品をお届けしました', 1);

        const log = newDeliveryBridgeLog();
        await mockAdminDeliveryBridge(page, { client, orderIds: [fx.orderId], actor: fx.actor, log });
        await openOrderTab(page);
        const dialog = await openOrderHistory(page, fx.orderId);
        const row = fulfillmentRow(dialog, 1);
        await expect(row.getByText(`お届け日 ${jstMonthDay(delivered.deliveredAt)}（手で）`, { exact: true })).toBeVisible();
        // 配達済みの発送には「配達済みにする」を出さない。直す画面は出る
        await expect(row.getByRole('button', { name: '配達済みにする', exact: true })).toHaveCount(0);

        // 配達済みの番号を直す時は、記録が消えることの警告が出る。通知のチェックを外して直す
        await row.getByRole('button', { name: '伝票番号を直す', exact: true }).click();
        await expect(dialog.getByText(DELIVERED_WARNING, { exact: true })).toBeVisible();
        await expect(dialog.getByText(EXPLANATION_OFF, { exact: true })).toBeVisible();
        await expectDialogFits(page, dialog);
        await dialog.getByLabel('伝票番号', { exact: true }).fill(newNumber);
        await dialog.getByRole('checkbox', { name: NOTIFY_LABEL, exact: true }).uncheck();
        await dialog.getByRole('button', { name: '伝票番号を直す', exact: true }).click();

        await expect(dialog.getByText('伝票番号を直しました。', { exact: true })).toBeVisible();
        expect(log.trackingPosts).toHaveLength(1);
        expect(log.trackingPosts[0].body).toMatchObject({ carrier: 'yamato', trackingNumber: newNumber, notifyCustomer: false });
        // 届いた日の行は消え、「配達済みにする」がまた出る
        const afterRow = fulfillmentRow(dialog, 1);
        await expect(afterRow).toContainText(`伝票番号: ${newNumber}`);
        await expect(afterRow.getByText(/お届け日/)).toHaveCount(0);
        await expect(afterRow.getByRole('button', { name: '配達済みにする', exact: true })).toBeVisible();

        // 手元の DB: 版が1つ進み、受付済みへ戻り、届いた時刻が消える。直しの記録は通知なし。前の版の配達済みの出来事は残る
        expect(await readFulfillment(client, fulfillmentId)).toMatchObject({
          tracking_version: 2, delivery_status: 'confirmed', delivered_at: null, tracking_number: newNumber, notify_customer: false,
        });
        expect(await readTrackingChanges(client, fulfillmentId)).toMatchObject([
          { tracking_version: 2, from_tracking_number: oldNumber, to_tracking_number: newNumber, notify_customer: false },
        ]);
        expect((await readEvents(client, fulfillmentId)).map((event) => [event.tracking_version, event.status, event.source])).toEqual([
          [1, 'confirmed', 'shipment'],
          [1, 'delivered', 'manual'],
          [2, 'confirmed', 'tracking_edit'],
        ]);
        // 返品の期限は、届いた日でなく発送の日の目安へ戻る
        const fallback =
          settings.windowDays === null
            ? null
            : addDays(addDays(jstDateOf((await readFulfillment(client, fulfillmentId)).shipped_at), settings.bufferDays), settings.windowDays);
        expect(await returnDeadlineOf(client, fx.orderId, fulfillmentId)).toBe(fallback);

        // 発送の更新のメールは作られず、送られない。配達済みのメールは前のとおり1通
        expect(await readOutbox(client, fx.orderId, ['shipping_update'])).toEqual([]);
        await expectMailCountStays(request, fx.email, SHIPPING_UPDATE_SUBJECT, 0, 2);
        await expectMailCountStays(request, fx.email, '商品をお届けしました', 1, 1);

        // 配達済みのお知らせの行に「お客様へ再送」は無い。直しの行のメールは「送らない」
        await expect(dialog.getByText('お客様へのメール：送らない', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        const reopened = await openOrderHistory(page, fx.orderId);
        const deliveredMail = reopened.getByRole('listitem').filter({ hasText: '配達済みのお知らせのメール' });
        await expect(deliveredMail).toHaveCount(1);
        await expect(deliveredMail.getByRole('button', { name: '中身を見る', exact: true })).toBeVisible();
        await expect(deliveredMail.getByRole('button', { name: 'お客様へ再送', exact: true })).toHaveCount(0);
        // 同じ二重防止の番号の再送は、前の結果を返すだけで版を進めない（画面と同じ関数）
        const replay = await editTrackingInDb(client, {
          orderId: fx.orderId, fulfillmentId, actorId: fx.actor.id, carrier: 'yamato', trackingNumber: newNumber, notify: false,
          requestKey: String(log.trackingPosts[0].body.requestKey ?? randomUUID()),
        });
        expect(replay).toMatchObject({ trackingVersion: 2, replayed: true });
        expect((await readFulfillment(client, fulfillmentId)).tracking_version).toBe(2);
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, reopened);
      });
    });
  });
}
