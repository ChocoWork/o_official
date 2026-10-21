/**
 * FR-ACCOUNT-043 配送の状況を出す条件と、お客様に出さない物（グループ E-4 Task 13）
 * 対応 FREQ: FREQ-494（AC-01・AC-03）・FREQ-495（AC-03・AC-05）・FREQ-497（AC-03）
 *
 * 本物のお客様のログインと本物の窓口・画面を使う。条件に合わない時は、サーバーが delivery のキーごと返さないことを窓口の答えで確かめる。
 * 「鍵なし」の時の画面は、窓口の答えの見本（delivery を外した本物の答え）であり、本物の環境変更の証拠ではない
 * （鍵の有無はアプリの環境で決まり、E2E のアプリは作り物の鍵で起動している）。
 */
import { expect, test } from '@playwright/test';
import {
  createAdminActor,
  createPaidOrderFixture,
  customerApi,
  customerShipment,
  deliveryViewports,
  expectNoHorizontalOverflow,
  holdRegistration,
  loginCustomer,
  markDeliveredInDb,
  openCustomerOrder,
  pairFor,
  pollWithMinuteJob,
  readFulfillment,
  readRegistration,
  jstToday,
  setFakeTracking,
  setTrackingViaFunction,
  shipFixture,
  withDeliveryScenario,
  type CustomerOrderBody,
} from './delivery-tracking-test-utils';

const PRIVACY_OUTSOURCING =
  '配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）';
const FOREIGN_TRANSFER_HEADING = '7. 個人情報の国外移転';
const FOREIGN_TRANSFER_START = '当社は、決済処理をはじめとする一部の業務において、外国にある第三者が運営するクラウドサービス等を利用しており';

// 会員のログインは確認コードとログインの Cookie をブラウザの通信に載せるので、通信記録（trace）を残さない。
// trace は worker 単位の設定なので、test.describe の中ではなくファイルの最上位に置く（中に置くと読み込みで落ちる）。
test.use({ trace: 'off' });

const hasDelivery = (body: CustomerOrderBody, number: number) =>
  Object.keys(body.shipments.find((shipment) => shipment.number === number) ?? {}).includes('delivery');

for (const viewport of deliveryViewports) {
  test.describe(`FR-ACCOUNT-043 delivery visibility (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // FREQ-494-AC-01, FREQ-495-AC-03
    test('登録待ちと失敗と鍵なしとオフで状況を隠す', async ({ page }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        const member = await loginCustomer(page, 'dt43a');
        // 作り物の答えは、発送を作る前に決める（別の試験の定期処理が先に読んでも、同じ答えになるように）
        await setFakeTracking({ ...pairFor(numberPrefix, 'ACC43I'), responseKey: 'invalidNumber' });
        await setFakeTracking({ ...pairFor(numberPrefix, 'ACC43A'), responseKey: 'inTransit' });
        const order = await createPaidOrderFixture(client, { label: 'acc43a', quantity: 4, userId: member.userId, email: member.email, actor });
        // 1回目: 登録待ち（毎分の処理が借りない先へ予定を送って、登録待ちのまま残す）
        const waiting = await shipFixture(client, order, { numberPrefix, tag: 'ACC43W', quantity: 1, notify: false });
        await holdRegistration(client, waiting.fulfillmentId);
        // 2回目: 番号が正しくない（登録で断られて、登録できない）
        const invalid = await shipFixture(client, order, { numberPrefix, tag: 'ACC43I', quantity: 1, notify: false });
        // 3回目: 追跡中で輸送中
        const active = await shipFixture(client, order, { numberPrefix, tag: 'ACC43A', quantity: 1, notify: false });
        // 4回目: 一度も登録しないまま、手で配達済み
        const manual = await shipFixture(client, order, { numberPrefix, tag: 'ACC43M', quantity: 1, notify: false });
        await holdRegistration(client, manual.fulfillmentId);
        await markDeliveredInDb(client, {
          orderId: order.orderId, fulfillmentId: manual.fulfillmentId, actorId: actor.id, deliveredOn: await jstToday(client), notify: false,
        });
        await pollWithMinuteJob(
          async () => ({
            invalid: await readRegistration(client, invalid.fulfillmentId),
            active: await readFulfillment(client, active.fulfillmentId),
          }),
          (value) => value.invalid?.state === 'failed' && value.active.delivery_status === 'in_transit',
          '2回目が登録できず、3回目が輸送中になること',
        );
        expect(await readRegistration(client, waiting.fulfillmentId)).toMatchObject({ state: 'pending' });
        expect(await readRegistration(client, manual.fulfillmentId)).toMatchObject({ state: 'stopped', stop_reason: 'delivered', ever_registered: false });

        // 窓口: 登録待ち・登録できない・一度も登録しないまま止めた発送は、delivery のキーごと返さない。追跡中の発送だけ返す。
        // 届いた時刻（deliveredAt）は、追跡の条件によらず常に返す
        const api = await customerApi(page, `/api/orders/${order.orderId}`);
        expect(api.status).toBe(200);
        expect([1, 2, 3, 4].map((number) => hasDelivery(api.body, number))).toEqual([false, false, true, false]);
        const byNumber = (number: number) => api.body.shipments.find((shipment) => shipment.number === number);
        expect(byNumber(3)?.delivery?.status).toBe('in_transit');
        expect(byNumber(4)?.deliveredAt).not.toBeNull();
        expect(byNumber(1)?.deliveredAt).toBeNull();

        // 画面: 札は追跡中の3回目だけ。4回目は届いた日（配達済み）
        await openCustomerOrder(page, order.orderId);
        await expect(customerShipment(page, 1).getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(customerShipment(page, 2).getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(customerShipment(page, 3).getByTestId('shipment-delivery-status')).toHaveText('輸送中');
        await expect(customerShipment(page, 4).getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(customerShipment(page, 4).getByTestId('shipment-delivered')).toContainText('配達済み');
        await expectNoHorizontalOverflow(page);

        // 鍵が無い時のサーバーの答えの見本: delivery を外した答え。画面は状況の札を出さないが、届いた日は出す
        const keyless = structuredClone(api.body);
        for (const shipment of keyless.shipments) delete shipment.delivery;
        const pattern = `**/api/orders/${order.orderId}`;
        await page.route(pattern, (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(keyless) }));
        await page.reload();
        await expect(customerShipment(page, 4).getByTestId('shipment-delivered')).toContainText('配達済み');
        await expect(page.getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(page.getByTestId('shipment-delivery-event')).toHaveCount(0);
        await page.unroute(pattern);

        // 設定をオフにすると、以前に読んだ輸送中も隠す（記録は残る）。届いた日は変わらず返す
        await setTrackingViaFunction(client, false, actor.id);
        const off = await customerApi(page, `/api/orders/${order.orderId}`);
        expect([1, 2, 3, 4].map((number) => hasDelivery(off.body, number))).toEqual([false, false, false, false]);
        expect(off.body.shipments.find((shipment) => shipment.number === 4)?.deliveredAt).not.toBeNull();
        expect((await readFulfillment(client, active.fulfillmentId)).delivery_status).toBe('in_transit');
        await page.reload();
        await expect(page.getByTestId('shipment-delivery-status')).toHaveCount(0);
        await expect(customerShipment(page, 4).getByTestId('shipment-delivered')).toContainText('配達済み');
        await expect(customerShipment(page, 3).getByRole('link', { name: '配送状況を確認する', exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });

    // FREQ-494-AC-03, FREQ-495-AC-05, FREQ-497-AC-03
    test('オンだけ委託の文を出し顧客JSONに店内の情報を出さない', async ({ page, browser }) => {
      test.setTimeout(420_000);
      await withDeliveryScenario(async ({ client, numberPrefix }) => {
        const actor = await createAdminActor(client);
        await setTrackingViaFunction(client, true, actor.id);
        const member = await loginCustomer(page, 'dt43b');
        await setFakeTracking({ ...pairFor(numberPrefix, 'ACC43X2'), responseKey: 'inTransit' });
        const order = await createPaidOrderFixture(client, { label: 'acc43b', quantity: 2, userId: member.userId, email: member.email, actor });
        // 1回目: 管理者が手で配達済みにした発送（出来事に管理者の番号が付く）。2回目: 追跡で輸送中（細かい状況 InTransit_Other が付く）
        const manual = await shipFixture(client, order, { numberPrefix, tag: 'ACC43X1', quantity: 1, notify: false });
        await holdRegistration(client, manual.fulfillmentId);
        await markDeliveredInDb(client, {
          orderId: order.orderId, fulfillmentId: manual.fulfillmentId, actorId: actor.id, deliveredOn: await jstToday(client), notify: false,
        });
        const tracked = await shipFixture(client, order, { numberPrefix, tag: 'ACC43X2', quantity: 1, notify: false });
        await pollWithMinuteJob(
          () => readFulfillment(client, tracked.fulfillmentId),
          (fulfillment) => fulfillment.delivery_status === 'in_transit',
          '2回目が輸送中になること',
        );
        expect((await client.query("select count(*)::int as n from public.order_fulfillment_events where fulfillment_id = $1 and provider_sub_status is not null", [tracked.fulfillmentId])).rows[0].n).toBeGreaterThan(0);

        // お客様の窓口の答え: 状況・時刻・出来事の状況と時刻だけ。管理者の情報・細かい状況・登録の状態・版は含まない
        const api = await customerApi(page, `/api/orders/${order.orderId}`);
        expect(api.status).toBe(200);
        const delivery = api.body.shipments.find((shipment) => shipment.number === 2)?.delivery;
        expect(delivery).toBeDefined();
        expect(Object.keys(delivery ?? {}).sort()).toEqual(['events', 'status', 'statusAt']);
        expect((delivery?.events ?? []).every((event) => Object.keys(event).sort().join() === 'happenedAt,status')).toBe(true);
        expect(hasDelivery(api.body, 1)).toBe(false);
        const text = JSON.stringify(api.body);
        expect(text).not.toContain(actor.email);
        expect(text).not.toContain(actor.id);
        expect(text).not.toMatch(/InTransit_Other|actorEmail|providerSubStatus|provider_sub_status|"registration"|recordedAt|trackingVersion|expiresAt|stopReason|failureKind|everRegistered/);

        // 他の会員は、この注文を 404（存在を教えない）
        const other = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
        try {
          const otherPage = await other.newPage();
          await loginCustomer(otherPage, 'dt43c');
          const denied = await customerApi<{ error: string }>(otherPage, `/api/orders/${order.orderId}`);
          expect(denied.status).toBe(404);
          expect(denied.body).toEqual({ error: 'Order not found' });
        } finally {
          await other.close();
        }

        // プライバシーポリシー: オンの間だけ委託の一覧に17TRACKの文が入る
        await page.goto('/privacy');
        await expect(page.getByText(PRIVACY_OUTSOURCING, { exact: true })).toBeVisible();
        await expect(page.getByText('決済処理業務（Stripe, Inc.）', { exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // オフにすると文は出ない。国外移転の文（見出しと本文）は変わらず残る
        await setTrackingViaFunction(client, false, actor.id);
        await page.reload();
        await expect(page.getByText('決済処理業務（Stripe, Inc.）', { exact: true })).toBeVisible();
        await expect(page.getByText(PRIVACY_OUTSOURCING, { exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: FOREIGN_TRANSFER_HEADING, exact: true })).toBeVisible();
        await expect(page.getByText(FOREIGN_TRANSFER_START)).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    });
  });
}
