/**
 * FR-ACCOUNT-042 配送の追跡がオンの間のお客様の画面（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-494（AC-02・AC-04・AC-05）
 *
 * 本物のお客様のログインと本物の窓口・画面を使い、配送の状況は作り物の 17TRACK（127.0.0.1:4017）を
 * 起動したアプリの毎分の定期処理が読んで進める。メールは Mailpit で数える。
 */
import { expect, test, type Locator } from '@playwright/test';
import {
  addDays,
  createAdminActor,
  createPaidOrderFixture,
  createShippedFixture,
  customerApi,
  customerShipment,
  deliveryViewports,
  editTrackingInDb,
  expectNoHorizontalOverflow,
  jstDateOf,
  jstDateTime,
  jstMonthDay,
  loginCustomer,
  makeRegistrationDue,
  openCustomerOrder,
  pairFor,
  pollMails,
  pollWithMinuteJob,
  readFulfillment,
  readRegistration,
  returnDeadlineOf,
  returnWindowSettings,
  setFakeTracking,
  setTrackingViaFunction,
  shipFixture,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';

/** 区切りの「配送の移り変わり」の状況の言葉を、上から順に（新しい順）読む */
async function eventWords(region: Locator): Promise<string[]> {
  return region.getByTestId('shipment-delivery-event').evaluateAll((nodes) =>
    nodes.map((node) => (node.querySelector('span')?.textContent ?? '').trim()),
  );
}

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

for (const viewport of deliveryViewports) {
  test.describe(`FR-ACCOUNT-042 delivery tracking (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-494-AC-02, FREQ-494-AC-04, FREQ-494-AC-05
    test('配達中から配達済みと新しい順の移り変わりを出す', async ({ page, request }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        const member = await loginCustomer(page, 'dt42a');
        // 輸送中 → 配達中（時刻は作り物がその時の時刻にする。受付済み < 輸送中 < 配達中の順になる）。
        // 最初の答えは、発送を作る前に決める（別の試験の定期処理が先に読んでも、同じ答えになるように）
        await setFakeTracking({ ...pairFor(numberPrefix, 'ACC42A'), responseKey: 'inTransit' });
        const fx = await createShippedFixture(client, {
          numberPrefix, tag: 'ACC42A', notify: true, userId: member.userId, email: member.email, actor,
        });
        const { fulfillmentId, pair } = fx.shipment;
        await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'in_transit',
          '登録と読み直しで輸送中になること',
        );
        await setFakeTracking({ ...pair, responseKey: 'outForDelivery' });
        await makeRegistrationDue(client, fulfillmentId);
        const outForDelivery = await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'out_for_delivery',
          '読み直しで配達中になること',
        );
        await pollMails(request, member.email, '商品を配達中です', 1);

        // 窓口: 現版の状況・時刻・出来事（新しい順）だけ。管理者・細かい状況・登録は含まない
        const api = await customerApi(page, `/api/orders/${fx.orderId}`);
        expect(api.status).toBe(200);
        const shipment = api.body.shipments[0];
        expect(shipment.delivery).toBeDefined();
        expect(Object.keys(shipment.delivery ?? {}).sort()).toEqual(['events', 'status', 'statusAt']);
        expect(shipment.delivery?.status).toBe('out_for_delivery');
        expect(shipment.delivery?.events.map((event) => event.status)).toEqual(['out_for_delivery', 'in_transit', 'confirmed']);
        expect(shipment.deliveredAt).toBeNull();

        // 画面: 配達中の札・最後の更新（日本時間）・配送の移り変わり（新しい順）
        await openCustomerOrder(page, fx.orderId);
        const region = customerShipment(page, 1);
        await expect(region.getByTestId('shipment-delivery-status')).toHaveText('配達中');
        await expect(region.getByText(`最後の更新 ${jstDateTime(outForDelivery.delivery_status_at)}`, { exact: true })).toBeVisible();
        await expect(region.getByText('配送の移り変わり', { exact: true })).toBeVisible();
        expect(await eventWords(region)).toEqual(['配達中', '輸送中', '受付済み']);
        await expect(region.getByTestId('shipment-delivered')).toHaveCount(0);
        await expect(page.getByTestId('order-progress-status')).toContainText('配送中');
        await expectNoHorizontalOverflow(page);

        // 配達済み: 追跡が配達済みを返す → 届いた日・配達済みのメール・返品の期限（届いた日から）
        await setFakeTracking({ ...pair, responseKey: 'delivered' });
        await makeRegistrationDue(client, fulfillmentId);
        const delivered = await pollWithMinuteJob(
          () => readFulfillment(client, fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'delivered' && fulfillment.delivered_at !== null,
          '読み直しで配達済みになること',
        );
        const deliveredAt = delivered.delivered_at as Date;
        const mails = await pollMails(request, member.email, '商品をお届けしました', 1);
        expect(mails[0].Text).toContain(`お届け日: ${jstMonthDay(deliveredAt)}`);
        expect(await readRegistration(client, fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });

        await page.reload();
        await expect(region.getByTestId('shipment-delivered')).toContainText('配達済み');
        await expect(region.getByTestId('shipment-delivered')).toContainText(`お届け日 ${jstMonthDay(deliveredAt)}`);
        // 配達済みの時は、状況の札を二重に出さない。最後の更新と移り変わり（新しい順）は出る
        await expect(region.getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(region.getByText(`最後の更新 ${jstDateTime(delivered.delivery_status_at)}`, { exact: true })).toBeVisible();
        expect(await eventWords(region)).toEqual(['配達済み', '配達中', '輸送中', '受付済み']);
        await expect(page.getByTestId('order-progress-status')).toContainText('配達済み');
        await expectNoHorizontalOverflow(page);

        const settings = await returnWindowSettings(client);
        const expectedDeadline = settings.windowDays === null ? null : addDays(jstDateOf(deliveredAt), settings.windowDays);
        expect(await returnDeadlineOf(client, fx.orderId, fulfillmentId)).toBe(expectedDeadline);
        const materials = await customerApi<{ data: { shipments: Array<{ fulfillmentId: string; deadlineDate: string | null }> } }>(
          page,
          `/api/orders/${fx.orderId}/return-request`,
        );
        expect(materials.body.data.shipments.find((entry) => entry.fulfillmentId === fulfillmentId)?.deadlineDate ?? null).toBe(expectedDeadline);
      });
    });

    // FREQ-494-AC-02, FREQ-494-AC-05
    test('直した番号だけを出し一部の配達済みは配送中のまま', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        const member = await loginCustomer(page, 'dt42b');
        // 作り物の答えは、発送を作る前に決める（別の試験の定期処理が先に読んでも、同じ答えになるように）
        await setFakeTracking({ ...pairFor(numberPrefix, 'ACC42B1'), responseKey: 'delivered' });
        await setFakeTracking({ ...pairFor(numberPrefix, 'ACC42B2'), responseKey: 'outForDelivery' });
        // 3つの商品のうち、1つ目・2つ目を別々に送る。3つ目はまだ送らない
        const order = await createPaidOrderFixture(client, { label: 'acc42b', quantity: 3, userId: member.userId, email: member.email, actor });
        const first = await shipFixture(client, order, { numberPrefix, tag: 'ACC42B1', quantity: 1, notify: false });
        const second = await shipFixture(client, order, { numberPrefix, tag: 'ACC42B2', quantity: 1, notify: false });
        const states = async () => ({
          first: (await readFulfillment(client, first.fulfillmentId)).delivery_status,
          second: (await readFulfillment(client, second.fulfillmentId)).delivery_status,
        });
        await pollWithMinuteJob(states, (value) => value.first === 'delivered' && value.second === 'out_for_delivery', '1つ目が配達済み・2つ目が配達中になること');

        // まだ送っていない商品が残るので、注文の進み具合は「発送準備中」（未発送が先）。1回目は配達済み、2回目は配達中
        await openCustomerOrder(page, order.orderId);
        await expect(page.getByTestId('order-progress-status')).toContainText('発送準備中');
        await expect(page.getByTestId('order-progress-status')).toContainText('一部発送済み');
        await expect(customerShipment(page, 1).getByTestId('shipment-delivered')).toContainText('配達済み');
        await expect(customerShipment(page, 2).getByTestId('shipment-delivery-status')).toHaveText('配達中');
        expect(await eventWords(customerShipment(page, 2))).toEqual(['配達中', '受付済み']);

        // 3つ目を送って全部送り終えても、配達済みは1つだけなので、注文は「配送中」のまま（配達済みにならない）
        const third = await shipFixture(client, order, { numberPrefix, tag: 'ACC42B3', quantity: 1, notify: false });
        await page.reload();
        await expect(customerShipment(page, 3)).toBeVisible();
        await expect(page.getByTestId('order-progress-status')).toContainText('配送中');
        await expect(page.getByTestId('order-progress-status')).not.toContainText('配達済み');
        const api = await customerApi(page, `/api/orders/${order.orderId}`);
        expect(api.body.progress).toMatchObject({ key: 'in_transit', label: '配送中', partiallyShipped: false });
        const deliveredByNumber = (number: number) => {
          const shipment = api.body.shipments.find((entry) => entry.number === number);
          return shipment?.deliveredAt !== null && shipment?.deliveredAt !== undefined;
        };
        expect([1, 2, 3].map(deliveredByNumber)).toEqual([true, false, false]);
        expect(third.number).toBe(3);

        // 2回目の伝票番号を直す（配送業者も変える）。直した番号の新しい版は登録待ち: 旧版の配達中の出来事は出さず、新しいリンクを出す
        const oldNumber = second.trackingNumber;
        // 旧い番号の文字を含まない新しい番号にする（画面に旧い番号が残っていないことを、部分一致でも確かめられるように）
        const newNumber = `${numberPrefix}-ACC42NEW2`;
        // 新しい番号の答えは、直す前に決める（直すと新しい版の登録が毎分の処理の対象になる）
        const newPair = { carrier: 100040 as const, number: newNumber.toUpperCase() };
        await setFakeTracking({ ...newPair, responseKey: 'inTransit' });
        await editTrackingInDb(client, {
          orderId: order.orderId, fulfillmentId: second.fulfillmentId, actorId: actor.id, carrier: 'sagawa', trackingNumber: newNumber, notify: false,
        });
        await pollWithMinuteJob(
          () => readFulfillment(client, second.fulfillmentId),
          (fulfillment) => fulfillment.tracking_version === 2 && fulfillment.delivery_status === 'in_transit',
          '直した番号の新しい版が登録されて輸送中になること',
        );

        await page.reload();
        const region = customerShipment(page, 2);
        await expect(region.getByText(newNumber, { exact: true })).toBeVisible();
        await expect(region.getByText('佐川急便', { exact: true })).toBeVisible();
        await expect(region.getByRole('link', { name: '配送状況を確認する', exact: true })).toHaveAttribute(
          'href',
          new RegExp(`k2k\\.sagawa-exp\\.co\\.jp.*${newNumber}`),
        );
        // 旧版の番号は画面のどこにも出ない。移り変わりは新しい版の分（輸送中・受付済み）だけで、旧版の配達中は出ない
        await expect(page.getByText(oldNumber)).toHaveCount(0);
        await expect(region.getByTestId('shipment-delivery-status')).toHaveText('輸送中');
        expect(await eventWords(region)).toEqual(['輸送中', '受付済み']);
        const newVersionApi = await customerApi(page, `/api/orders/${order.orderId}`);
        const second2 = newVersionApi.body.shipments.find((shipment) => shipment.id === second.fulfillmentId);
        expect(second2?.delivery?.events.map((event) => event.status)).toEqual(['in_transit', 'confirmed']);
        expect(JSON.stringify(newVersionApi.body)).not.toContain(oldNumber);
        expect(JSON.stringify(newVersionApi.body)).toContain(newNumber);
        // 1回目の配達済みは変わらず、注文はまだ「配送中」
        await expect(customerShipment(page, 1).getByTestId('shipment-delivered')).toContainText('配達済み');
        await expect(page.getByTestId('order-progress-status')).toContainText('配送中');
        expect(await readRegistration(client, second.fulfillmentId, 2)).toMatchObject({ state: 'registered', tracking_number: newNumber.toUpperCase() });
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
