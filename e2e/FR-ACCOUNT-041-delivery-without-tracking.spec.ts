/**
 * FR-ACCOUNT-041 配送の追跡がオフの間のお客様の画面（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-490（AC-01）・FREQ-494（AC-02・AC-04）
 *
 * 本物のお客様のログイン（確認コードは Mailpit から読む）と本物の窓口（GET /api/orders/[id]）・画面を使い、
 * 配達済みは手元の DB の本物の関数（手で配達済み）で作る。追跡がオフの間は、17TRACK（作り物）へ何も送らない。
 */
import { expect, test } from '@playwright/test';
import {
  addDays,
  createShippedFixture,
  customerApi,
  customerShipment,
  deliveryViewports,
  expectNoHorizontalOverflow,
  jstDateOf,
  jstMonthDay,
  jstToday,
  loginCustomer,
  markDeliveredInDb,
  openCustomerOrder,
  readFakeTrackingCalls,
  readFulfillment,
  readRegistration,
  returnDeadlineOf,
  returnWindowSettings,
  runTrackingMinuteJob,
  sendSignedTrackingWebhook,
  setTrackingFlagDirect,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

const STEP_LABELS = ['お支払い', '発送準備中', '配送中', '配達済み'] as const;

for (const viewport of deliveryViewports) {
  test.describe(`FR-ACCOUNT-041 delivery without tracking (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-490-AC-01, FREQ-494-AC-02
    test('追跡オフはリンクだけで手の配達済みは見える', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        await setTrackingFlagDirect(client, false);
        const member = await loginCustomer(page, 'dt41a');
        const fx = await createShippedFixture(client, {
          numberPrefix, tag: 'ACC41A', notify: false, userId: member.userId, email: member.email,
        });
        const fulfillmentId = fx.shipment.fulfillmentId;

        // 窓口の答え: 配送の状況（delivery）のキーは無く、届いた時刻は空。進み具合は配送中
        const before = await customerApi(page, `/api/orders/${fx.orderId}`);
        expect(before.status).toBe(200);
        expect(Object.keys(before.body.shipments[0])).not.toContain('delivery');
        expect(before.body.shipments[0].deliveredAt).toBeNull();
        expect(before.body.progress).toMatchObject({ key: 'in_transit', label: '配送中' });

        // 画面: 追跡のリンク（今までどおり）だけで、配送の状況の札も配達済みも無い
        await openCustomerOrder(page, fx.orderId);
        const region = customerShipment(page, 1);
        await expect(region.getByText(fx.shipment.trackingNumber, { exact: true })).toBeVisible();
        await expect(region.getByRole('link', { name: '配送状況を確認する', exact: true })).toHaveAttribute(
          'href',
          new RegExp(`toi\\.kuronekoyamato\\.co\\.jp.*${fx.shipment.trackingNumber}`),
        );
        await expect(region.getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(region.getByTestId('shipment-delivered')).toHaveCount(0);
        await expect(region.getByText('配送の移り変わり', { exact: true })).toHaveCount(0);
        await expect(page.getByTestId('order-progress-status')).toContainText('配送中');
        const steps = page.getByRole('list', { name: '配送ステータス' });
        await expect(steps.getByText('配達済み', { exact: true })).toHaveClass(/text-\[#999\]/);
        await expectNoHorizontalOverflow(page);

        // 手で配達済みにする（追跡がオフでもできる）→ 届いた日・配達済みの進み具合・一覧の言葉が見える
        const today = await jstToday(client);
        const delivered = await markDeliveredInDb(client, {
          orderId: fx.orderId, fulfillmentId, actorId: fx.actor.id, deliveredOn: today, notify: false,
        });
        await page.reload();
        await expect(region.getByTestId('shipment-delivered')).toContainText('配達済み');
        await expect(region.getByTestId('shipment-delivered')).toContainText(`お届け日 ${jstMonthDay(delivered.deliveredAt)}`);
        await expect(region.getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(page.getByTestId('order-progress-status')).toContainText('配達済み');
        for (const label of STEP_LABELS) await expect(steps.getByText(label, { exact: true })).toHaveClass(/text-black/);
        await expectNoHorizontalOverflow(page);

        const after = await customerApi(page, `/api/orders/${fx.orderId}`);
        expect(Object.keys(after.body.shipments[0])).not.toContain('delivery');
        expect(Date.parse(String(after.body.shipments[0].deliveredAt))).toBe(delivered.deliveredAt.getTime());
        expect(after.body.progress).toMatchObject({ key: 'delivered', label: '配達済み' });

        // 購入履歴の一覧の言葉も「配達済み」（窓口と画面）
        const list = await customerApi<{ data: Array<{ id: string; status: string }> }>(page, '/api/orders');
        expect(list.status).toBe(200);
        expect(list.body.data.find((order) => order.id === fx.orderId)?.status).toBe('配達済み');
        await page.goto('/account?tab=orders');
        const row = page.getByRole('link', { name: new RegExp(fx.orderNumber) });
        await expect(row.getByText('配達済み', { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 追跡がオフの間、17TRACK には何も送っていない
        expect(await readRegistration(client, fulfillmentId)).toBeUndefined();
        expect(await readFakeTrackingCalls(fx.shipment.pair)).toEqual([]);
      });
    });

    // FREQ-490-AC-01, FREQ-494-AC-04
    test('追跡オフの知らせは無視し返品は届いた日を使う', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        await setTrackingFlagDirect(client, false);
        const member = await loginCustomer(page, 'dt41b');
        const fx = await createShippedFixture(client, {
          numberPrefix, tag: 'ACC41B', notify: false, userId: member.userId, email: member.email,
        });
        const fulfillmentId = fx.shipment.fulfillmentId;
        const today = await jstToday(client);
        await markDeliveredInDb(client, { orderId: fx.orderId, fulfillmentId, actorId: fx.actor.id, deliveredOn: today, notify: false });

        // 署名の合う知らせは 200 で受けるが、追跡がオフなので読み直しも外への呼び出しも起きない
        const signal = await sendSignedTrackingWebhook({ ...fx.shipment.pair, event: 'TRACKING_UPDATED' });
        expect(signal.status).toBe(200);
        expect(await signal.json()).toEqual({ received: true });
        await runTrackingMinuteJob();
        await runTrackingMinuteJob();
        expect(await readFakeTrackingCalls(fx.shipment.pair)).toEqual([]);
        expect(await readRegistration(client, fulfillmentId)).toBeUndefined();

        // 返品の期限は、届いた日（日本時間の日付）から数える。DB の期限とお客様の窓口の期限が同じ
        const delivered = (await readFulfillment(client, fulfillmentId)).delivered_at as Date;
        const settings = await returnWindowSettings(client);
        const dbDeadline = await returnDeadlineOf(client, fx.orderId, fulfillmentId);
        expect(dbDeadline).toBe(settings.windowDays === null ? null : addDays(jstDateOf(delivered), settings.windowDays));
        const materials = await customerApi<{ data: { shipments: Array<{ fulfillmentId: string; deadlineDate: string | null }> } }>(
          page,
          `/api/orders/${fx.orderId}/return-request`,
        );
        expect(materials.status).toBe(200);
        expect(materials.body.data.shipments.find((shipment) => shipment.fulfillmentId === fulfillmentId)?.deadlineDate ?? null).toBe(dbDeadline);

        // お客様の画面にも届いた日が出る（追跡がオフでも）
        await openCustomerOrder(page, fx.orderId);
        await expect(customerShipment(page, 1).getByTestId('shipment-delivered')).toContainText(`お届け日 ${jstMonthDay(delivered)}`);
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
