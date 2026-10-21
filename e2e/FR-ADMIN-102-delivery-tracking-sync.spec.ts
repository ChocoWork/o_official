/**
 * FR-ADMIN-102 配送の追跡の登録・読み直し・知らせ（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-490（AC-01）・FREQ-491（AC-01・AC-02）・FREQ-492（AC-01・AC-02）
 *
 * 追跡の HTTP は手元の作り物の 17TRACK（127.0.0.1:4017）、知らせは署名をつけて起動したアプリの受け口へ送り、
 * 毎分の定期処理を繰り返し呼んで進める（登録 → 読み直し → 次の起動でのメールの送り出し）。メールは Mailpit で数える。
 * 管理画面の窓口は差し替え（P22）、画面は最後に履歴の表示だけを確かめる。
 */
import { expect, test } from '@playwright/test';
import {
  callMethods,
  createAdminActor,
  createShippedFixture,
  deliveryViewports,
  expectDialogFits,
  expectMailCountStays,
  expectNoHorizontalOverflow,
  fulfillmentRow,
  jstMonthDay,
  mockAdminDeliveryBridge,
  newDeliveryBridgeLog,
  openOrderHistory,
  pairFor,
  pollMails,
  pollWithMinuteJob,
  readEvents,
  readFakeTrackingCalls,
  readFulfillment,
  readOutbox,
  readRegistration,
  runTrackingMinuteJob,
  sendSignedTrackingWebhook,
  setFakeTracking,
  setTrackingViaFunction,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';
import { openOrderTab } from './order-fulfillment-test-utils';
import { formatJst } from './refund-test-utils';

const OUT_FOR_DELIVERY_SUBJECT = '商品を配達中です';
const DELIVERED_SUBJECT = '商品をお届けしました';

for (const viewport of deliveryViewports) {
  test.describe(`FR-ADMIN-102 delivery tracking sync (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    // FREQ-490-AC-01, FREQ-491-AC-01, FREQ-491-AC-02, FREQ-492-AC-01, FREQ-492-AC-02
    test('オンの発送を登録し知らせから配達中と配達済みへ進む', async ({ page, request }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        // 登録 → 読み直し: 作り物は輸送中を返す（発送を作る前に決める。別の試験の定期処理が先に読んでも、同じ答えになるように）
        await setFakeTracking({ ...pairFor(numberPrefix, 'E102A'), responseKey: 'inTransit' });
        const fx = await createShippedFixture(client, { numberPrefix, tag: 'E102A', notify: true, actor });
        const { fulfillmentId, pair } = fx.shipment;
        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'in_transit',
          '登録と読み直しで輸送中になること',
        );
        expect(callMethods(await readFakeTrackingCalls(pair))).toEqual(['register', 'gettrackinfo']);
        expect(await readRegistration(client, fulfillmentId)).toMatchObject({ state: 'registered', ever_registered: true });
        expect((await readEvents(client, fulfillmentId)).map((event) => [event.status, event.source])).toEqual([
          ['confirmed', 'shipment'],
          ['in_transit', 'tracking'],
        ]);

        // 署名の合わない知らせは 401 で、外への呼び出しも状況の変化も起きない
        const invalid = await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED', invalidSign: true });
        expect(invalid.status).toBe(401);
        await runTrackingMinuteJob();
        expect(callMethods(await readFakeTrackingCalls(pair))).toEqual(['register', 'gettrackinfo']);

        // 署名の合う更新の知らせ: 本文には偽の Delivered が入っているが、使うのは合図だけ。読み直した答え（輸送中）が記録の元
        const signed = await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' });
        expect(signed.status).toBe(200);
        expect(await signed.json()).toEqual({ received: true });
        await pollWithMinuteJob(
          async () => callMethods(await readFakeTrackingCalls(pair)),
          (methods) => methods.filter((method) => method === 'gettrackinfo').length >= 2,
          '知らせの後に読み直すこと',
        );
        expect((await readFulfillment(client, fulfillmentId)).delivery_status).toBe('in_transit');
        expect((await readEvents(client, fulfillmentId)).some((event) => event.status === 'delivered')).toBe(false);

        // 次: 配達中。読み直しで配達中になり、配達中のメールが1通
        await setFakeTracking({ ...pair, responseKey: 'outForDelivery' });
        expect((await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' })).status).toBe(200);
        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'out_for_delivery',
          '知らせの後に配達中になること',
        );
        const outMails = await pollMails(request, fx.email, OUT_FOR_DELIVERY_SUBJECT, 1);
        expect(outMails[0].Subject).toBe(`【Le Fil des Heures】${OUT_FOR_DELIVERY_SUBJECT}（${fx.orderNumber}）`);
        expect(outMails[0].Text).toContain('ご注文の商品を配達中です。');
        expect(outMails[0].Text).toContain('・E2E配送のシャツ（ホワイト / M） x1');
        expect(outMails[0].Text).toContain('配送業者: ヤマト運輸');
        expect(outMails[0].Text).toContain(`追跡番号: ${fx.shipment.trackingNumber}`);

        // 次: 配達済み。届いた時刻が入り、追跡は止まり、配達済みのメールが1通
        await setFakeTracking({ ...pair, responseKey: 'delivered' });
        expect((await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' })).status).toBe(200);
        const delivered = await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'delivered' && fulfillment.delivered_at !== null,
          '知らせの後に配達済みになること',
        );
        expect(await readRegistration(client, fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });
        const deliveredMails = await pollMails(request, fx.email, DELIVERED_SUBJECT, 1);
        expect(deliveredMails[0].Text).toContain(`お届け日: ${jstMonthDay(delivered.delivered_at as Date)}`);
        expect((await readEvents(client, fulfillmentId)).map((event) => event.status)).toEqual([
          'confirmed', 'in_transit', 'out_for_delivery', 'delivered',
        ]);
        // 外への呼び出しは、最初の登録 → 読み直しと、その後の読み直しだけ（配達済みで止めるために外へ停止は送らない）
        const methods = callMethods(await readFakeTrackingCalls(pair));
        expect(methods.slice(0, 2)).toEqual(['register', 'gettrackinfo']);
        expect(methods.slice(2).every((method) => method === 'gettrackinfo')).toBe(true);

        // 管理画面の履歴: 配達の出来事が時間の順に並び、届いた日は出どころ「追跡」、追跡の登録は「止めた」
        await mockAdminDeliveryBridge(page, { client, orderIds: [fx.orderId], actor, log: newDeliveryBridgeLog() });
        await openOrderTab(page);
        const dialog = await openOrderHistory(page, fx.orderId);
        const row = fulfillmentRow(dialog, 1);
        await expect(row.getByText(`お届け日 ${jstMonthDay(delivered.delivered_at as Date)}（追跡）`, { exact: true })).toBeVisible();
        await expect(row.getByText('配送の状況（1回目）', { exact: true })).toBeVisible();
        await expect(row.getByText('止めた', { exact: true })).toBeVisible();
        await expect(row.getByText(`最後の更新 ${formatJst((delivered.delivery_status_at as Date).toISOString())}`, { exact: true })).toBeVisible();
        // 出来事の4行（受付済み・輸送中・配達中・配達済み）＋発送の行の現在の状況
        await expect(dialog.getByRole('listitem').filter({ hasText: '配送の状況（1回目）' })).toHaveCount(5);
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, dialog);
      });
    });

    // FREQ-491-AC-02, FREQ-492-AC-02
    test('同じ知らせの再送でも出来事とメールは各1回', async ({ page, request }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        await setFakeTracking({ ...pairFor(numberPrefix, 'E102B'), responseKey: 'outForDelivery' });
        const fx = await createShippedFixture(client, { numberPrefix, tag: 'E102B', notify: true, actor });
        const { fulfillmentId, pair } = fx.shipment;

        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'out_for_delivery',
          '登録と読み直しで配達中になること',
        );

        // 同じ合図を2回続けて送る（17TRACK の送り直しや二重配信と同じ）。どちらも 200
        for (let count = 0; count < 2; count += 1) {
          const response = await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ received: true });
        }
        await pollWithMinuteJob(
          async () => callMethods(await readFakeTrackingCalls(pair)),
          (methods) => methods.filter((method) => method === 'gettrackinfo').length >= 2,
          '合図の後に読み直すこと',
        );
        await runTrackingMinuteJob();

        // 出来事は1回だけ、配達中のメールも1通だけ
        const outCount = async () => (await readEvents(client, fulfillmentId)).filter((event) => event.status === 'out_for_delivery').length;
        expect(await outCount()).toBe(1);
        await pollMails(request, fx.email, OUT_FOR_DELIVERY_SUBJECT, 1);
        await expectMailCountStays(request, fx.email, OUT_FOR_DELIVERY_SUBJECT, 1);
        expect(await readOutbox(client, fx.orderId, ['out_for_delivery'])).toHaveLength(1);
        expect(await outCount()).toBe(1);

        // 配達済み: 出来事もメールも1回。同じ知らせをもう一度送っても増えない
        await setFakeTracking({ ...pair, responseKey: 'delivered' });
        expect((await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' })).status).toBe(200);
        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'delivered',
          '合図の後に配達済みになること',
        );
        await pollMails(request, fx.email, DELIVERED_SUBJECT, 1);
        expect((await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' })).status).toBe(200);
        await expectMailCountStays(request, fx.email, DELIVERED_SUBJECT, 1);
        expect((await readEvents(client, fulfillmentId)).filter((event) => event.status === 'delivered')).toHaveLength(1);
        expect(await readOutbox(client, fx.orderId, ['delivered'])).toHaveLength(1);

        // 配達済みの後の配達中は、記録もメールも作らない（追跡は止まっていて、知らせの合図の対象にもならない）
        const settled = await readFakeTrackingCalls(pair);
        await setFakeTracking({ ...pair, responseKey: 'outForDelivery' });
        expect((await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' })).status).toBe(200);
        await runTrackingMinuteJob();
        await runTrackingMinuteJob();
        expect(await readFakeTrackingCalls(pair)).toEqual(settled);
        expect(await outCount()).toBe(1);
        expect((await readFulfillment(client, fulfillmentId)).delivery_status).toBe('delivered');
        await expectMailCountStays(request, fx.email, OUT_FOR_DELIVERY_SUBJECT, 1, 1);
        expect(await readOutbox(client, fx.orderId, ['out_for_delivery'])).toHaveLength(1);

        // 追跡は配達済みで止まっている。外への停止の呼び出しはしていない
        expect(await readRegistration(client, fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });
        expect(callMethods(settled)).not.toContain('stoptrack');
        expect(callMethods(settled)).not.toContain('retrack');

        // 管理画面の履歴にも、出来事が1回ずつだけ出る（受付済み・配達中・配達済みの3行＋発送の行の現在の状況）。各幅ではみ出し・見切れが無い
        await mockAdminDeliveryBridge(page, { client, orderIds: [fx.orderId], actor, log: newDeliveryBridgeLog() });
        await openOrderTab(page);
        const dialog = await openOrderHistory(page, fx.orderId);
        await expect(fulfillmentRow(dialog, 1).getByText('止めた', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('listitem').filter({ hasText: '配送の状況（1回目）' })).toHaveCount(4);
        await expectNoHorizontalOverflow(page);
        await expectDialogFits(page, dialog);
      });
    });
  });
}
