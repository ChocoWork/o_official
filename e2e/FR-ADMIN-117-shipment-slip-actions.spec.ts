/**
 * FR-ADMIN-117 発送票の操作（グループ G-3）
 * 対応 FREQ: FREQ-533（AC-04）、FREQ-534（AC-01〜AC-05）、FREQ-540（AC-10）、FREQ-541（AC-03・AC-04）。
 * 旧の発送の操作（G-1 で止めた FR-ADMIN-072・082・093・100・101 の case）の移設先: 伝票番号の後入力・訂正・手動の配達済み・発送の取消・追跡の親・権限・履歴からの票。
 * E-4 の FREQ-488・489・492・493 の画面の確かめも、ここ（票単位の操作）が引き継ぐ。
 *
 * 画面 → 窓口の差し替え（e2e/shipping-test-utils.ts）→ 手元の DB の公開関数（admin_update_shipment_slip_tracking・admin_mark_shipment_slip_delivered・
 * admin_cancel_shipment_slip ほか）で確かめる。材料の注文と票は DB の公開関数で作り、画面では票の頁のダイアログを操作する。
 * 窓口の拒否や履歴の形のように画面を要らない確かめは、bridge の中核（dispatchShippingRequest）を直に呼ぶ（画面から呼ぶのと同じ答え）。
 * メールは起動したアプリの毎分の定期処理が手元の Mailpit へ送る。宛先は試験ごとの新しいアドレスだけで探す。
 * ⑥の鍵の順は withDeliveryScenario（940488 の排他）→ withShippingScenario（190520, 0 の共有）。逆の順では取らない。
 *
 * この spec が確かめない所（照合先）:
 * - 窓口の認可・MFA・CSRF・回数の制限・操作の監査 → FR-ADMIN-123 の G-3 の節と各 route の単体
 * - 取消の戻し・手元の在庫の保存則・拒否の優先・並行 → DB 結合 group_g3_cancel・group_g3_tracking・group_g3_concurrency
 * - 出荷日の訂正 → FR-ADMIN-118
 * - 追跡（17TRACK）の読み直しの細部（輸送中以外の状況・失敗・鍵なし） → FR-ADMIN-102・FR-ACCOUNT-042・043
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { LEGACY_FULFILLMENT_DISABLED, legacyFulfillmentDisabledBody } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import {
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_TEXT,
  formatCancelBlocker,
  formatOpenSlipLabel,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SHIPPING_CARRIERS, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import {
  addDays,
  callMethods,
  expectMailCountStays,
  jstDateOf,
  jstMonthDay,
  markDeliveredInDb,
  pairFor,
  pollMails,
  pollWithMinuteJob,
  readEvents,
  readFakeTrackingCalls,
  readFulfillment,
  readRegistration,
  readTrackingChanges,
  returnDeadlineOf,
  returnWindowSettings,
  sendSignedTrackingWebhook,
  setFakeTracking,
  setTrackingViaFunction,
  withDeliveryScenario,
} from './delivery-tracking-test-utils';
import { beginRefund, expectDbError, mailsTo, uniqueEmail } from './order-email-test-utils';
import { viewports } from './order-fulfillment-test-utils';
import { createPermissionActor, mockPermissionUiBridge } from './permission-settings-test-utils';
import { mockAdminSessionAs } from './refund-test-utils';
import { cancelReturnInDb, createReturnInDb, ensureReturnSettings, receiveReturnInDb } from './return-test-utils';
import {
  UNIT_PRICE,
  callFromPage,
  callShippingApi as send,
  createDraftInDb,
  createMemberUser,
  createShippingMaterial,
  expectNoPageOverflow,
  expectSlipHeading,
  fulfillmentsOf,
  jstToday,
  noticeOf,
  openPacking,
  openSlip,
  orderStatusOf,
  prepareShippingPage,
  readOutbox,
  readSlip,
  readyQuantityOf,
  revealPackingRow,
  setSupporterPermissionOnScreen,
  shipMaterialsInDb,
  variantInventory,
  withShippingScenario,
  confirmSlipInDb,
  type ShippingContext,
  type ShippingMaterial,
  type ShippingMaterialInput,
} from './shipping-test-utils';

test.describe.configure({ timeout: 300_000 });

const SHIPPED = '商品を発送いたしました';
const UPDATED = '発送の情報を更新しました';
const DELIVERED = '商品をお届けしました';
const SUPERSEDED = '先にお知らせした伝票番号は使えません';
const STATUS_LINK_LINE = 'ご注文の状況はこちら: http://localhost:3000/order-status/[ORDER_STATUS_LINK]';
const SLIPS = '/api/admin/shipment-slips';

const tracking = (label: string): string => `E2E-${label}-${randomUUID().slice(0, 8).toUpperCase()}`;

/** 同じ会員の2つの注文（宛先のメールアドレスは注文ごとに別・配送先は完全に同じ）。数は quantities の順 */
async function createBundle(
  ctx: ShippingContext,
  quantities: readonly [number, number] = [4, 3],
  extra: ShippingMaterialInput = {},
): Promise<{ a: ShippingMaterial; b: ShippingMaterial }> {
  const member = await createMemberUser(ctx.client, 'g3act');
  const a = await createShippingMaterial(ctx.client, {
    ...extra, quantity: quantities[0], customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-act-a') },
    paymentIntentId: extra.paymentIntentId ? `${extra.paymentIntentId}_a` : undefined,
  });
  const b = await createShippingMaterial(ctx.client, {
    ...extra, quantity: quantities[1], customer: { kind: 'member', userId: member.userId, email: uniqueEmail('g3-act-b') },
    paymentIntentId: extra.paymentIntentId ? `${extra.paymentIntentId}_b` : undefined,
  });
  return { a, b };
}

function fulfillmentIdOf(confirmed: { fulfillments: readonly { orderId: string; fulfillmentId: string }[] }, material: ShippingMaterial): string {
  const found = confirmed.fulfillments.find((entry) => entry.orderId === material.orderId);
  if (!found) throw new Error('E2E_SLIP_FULFILLMENT_MISSING');
  return found.fulfillmentId;
}

function itemLine(material: ShippingMaterial, quantity: number): string {
  return `・${material.itemName}（${material.colorName} / ${material.sizeLabel}） x${quantity}`;
}

type HistoryEntry = { type: string } & Record<string, unknown>;

/** 「この注文の履歴」の答え（窓口と同じ組み立て）の行 */
async function historyEntries(ctx: ShippingContext, orderId: string): Promise<{ entries: HistoryEntry[]; trackingEnabled: boolean }> {
  const reply = await send(ctx, 'GET', `/api/admin/orders/${orderId}/history`);
  expect(reply.status).toBe(200);
  const body = reply.body as { entries: HistoryEntry[]; deliveryTrackingEnabled?: boolean };
  return { entries: body.entries, trackingEnabled: body.deliveryTrackingEnabled === true };
}

/**
 * 下書きの作成・確定・メールの予定の取り置きを1つの取引にして確定する。発送のメールの予定は、書いた時から毎分の処理が取り出せる。
 * 取り置かずに確定すると、画面を操作している間に他の試験の毎分の処理が先に送ってしまい、「送る前のメールは取りやめ」を確かめられない。
 * 取引の中では他の接続から行が見えず、コミットの時にはもう次の時刻（1時間後）に置いてあるので、取り出されない。
 */
async function shipHeld(
  ctx: ShippingContext,
  materials: readonly ShippingMaterial[],
  options: { quantities?: readonly number[]; carrier?: ShippingCarrierId | null; trackingNumber?: string | null; notifyCustomer?: boolean },
) {
  const { client } = ctx;
  await client.query('begin');
  try {
    const draft = await createDraftInDb(ctx, materials, options.quantities);
    const confirmed = await confirmSlipInDb(client, ctx.actorId, draft, {
      carrier: options.carrier ?? null,
      trackingNumber: options.trackingNumber ?? null,
      notifyCustomer: options.notifyCustomer,
    });
    await client.query(
      "update private.order_email_outbox set next_attempt_at = now() + interval '1 hour' where order_id = any($1::uuid[]) and status = 'pending'",
      [materials.map((material) => material.orderId)],
    );
    await client.query('commit');
    return confirmed;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** 票の頁の確定済みの記録の欄（出荷日・伝票・注文ごとの発送・出荷日の履歴・荷物の履歴） */
const recordOf = (page: Page) => page.getByRole('region', { name: '発送の記録', exact: true });

/** 注文ごとの発送の行（例: 注文 ORD-… 発送（1回目） 配達済み） */
const orderStatusLine = (page: Page, material: ShippingMaterial, label: string) =>
  page.getByText(new RegExp(`注文 ${material.orderNumber} 発送（\\d+回目） ${label}`));

const operationButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

/** 伝票番号のダイアログを開いて運送会社・番号・メールの選択を入れ、送って、成功の通知とダイアログが閉じるまで待つ */
async function correctTrackingOnScreen(
  page: Page,
  input: { carrier: ShippingCarrierId; number: string; notify: boolean; entering?: boolean },
): Promise<void> {
  const title = input.entering ? SHIPMENT_SLIP_TEXT.trackingEnter : SHIPMENT_SLIP_TEXT.trackingEdit;
  await operationButton(page, title).click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await expect(dialog).toBeVisible();
  // 運送会社の選択欄は、ラベルの文字に選択肢の文字が混ざる（getByLabel の exact が当たらない）ので、役割と名前で探す
  await dialog.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true }).selectOption(input.carrier);
  await dialog.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true }).fill(input.number);
  const notify = dialog.getByRole('checkbox', { name: SHIPMENT_SLIP_TEXT.trackingNotify, exact: true });
  if (input.notify) await notify.check();
  else await notify.uncheck();
  await dialog.getByRole('button', { name: input.entering ? SHIPMENT_SLIP_TEXT.trackingSubmitEnter : SHIPMENT_SLIP_TEXT.trackingSubmitEdit, exact: true }).click();
  await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.trackingUpdated)).toBeVisible();
  await expect(dialog).toBeHidden();
}

/** 「配達済みにする」のダイアログを開いて、届いた日とメールの選択を入れて送り、成功の通知まで待つ */
async function markDeliveredOnScreen(page: Page, input: { date?: string; notify: boolean }): Promise<void> {
  await operationButton(page, SHIPMENT_SLIP_TEXT.markDelivered).click();
  const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true });
  await expect(dialog).toBeVisible();
  if (input.date) await dialog.getByLabel(SHIPMENT_SLIP_TEXT.deliveredOnLabel, { exact: true }).fill(input.date);
  const notify = dialog.getByRole('checkbox', { name: SHIPMENT_SLIP_TEXT.deliveredNotify, exact: true });
  if (input.notify) await notify.check();
  else await notify.uncheck();
  await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true }).click();
  await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.delivered)).toBeVisible();
  await expect(dialog).toBeHidden();
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-117 shipment slip actions (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('番号なしで確定した票に運送会社と番号を後から入れると、全注文に反映され、更新メールが注文ごとに1通届く', async ({ page, request }) => {
      // FREQ-534-AC-01, FREQ-488-AC-01, FREQ-488-AC-03
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const { a, b } = await createBundle(ctx);
        const confirmed = await shipMaterialsInDb(ctx, [a, b], { quantities: [2, 3], notifyCustomer: false });
        const number = tracking('LATE');
        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        await expect(page.getByText('伝票番号は未入力です', { exact: true })).toBeVisible();

        // 運送会社が無い票は、選ぶまで送れない（送らずに画面の中で止める）
        await operationButton(page, SHIPMENT_SLIP_TEXT.trackingEnter).click();
        const entering = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.trackingEnter, exact: true });
        await entering.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true }).fill(number);
        await entering.getByRole('button', { name: SHIPMENT_SLIP_TEXT.trackingSubmitEnter, exact: true }).click();
        await expect(entering.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_TRACKING_INCOMPLETE[2] })).toBeVisible();
        expect((await readSlip(client, ctx.actorId, confirmed.id)).trackingVersion).toBe(1);
        await entering.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
        await expect(entering).toBeHidden();

        // 運送会社と番号を入れる（更新のメールは最初からオン）
        await operationButton(page, SHIPMENT_SLIP_TEXT.trackingEnter).click();
        const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.trackingEnter, exact: true });
        await dialog.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true }).selectOption('yamato');
        await dialog.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true }).fill(number);
        await expect(dialog.getByRole('checkbox', { name: SHIPMENT_SLIP_TEXT.trackingNotify, exact: true })).toBeChecked();
        await expect(dialog.getByText(SHIPMENT_SLIP_TEXT.trackingDescription, { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.trackingSubmitEnter, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.trackingUpdated)).toBeVisible();
        await expect(page.getByText(`${SHIPPING_CARRIERS.yamato.label} ${number}`, { exact: true })).toBeVisible();

        // 票と全注文の有効な発送へ、同じ運送会社と番号が入る（注文ごとの直しの記録は前の値が空）
        const detail = await readSlip(client, ctx.actorId, confirmed.id);
        expect(detail).toMatchObject({ carrier: 'yamato', trackingNumber: number, trackingVersion: 2 });
        expect(detail.versions.map((entry) => entry.kind)).toEqual(['confirm', 'tracking_update']);
        for (const material of [a, b]) {
          const fulfillmentId = fulfillmentIdOf(confirmed, material);
          expect(await readFulfillment(client, fulfillmentId)).toMatchObject({
            shipping_carrier: 'yamato', tracking_number: number, tracking_version: 2, delivery_status: 'confirmed', notify_customer: true,
          });
          expect(await readTrackingChanges(client, fulfillmentId)).toEqual([
            { tracking_version: 2, from_carrier: null, from_tracking_number: null, to_carrier: 'yamato', to_tracking_number: number, notify_customer: true },
          ]);
          const outbox = await readOutbox(client, material.orderId, ['shipping_update']);
          expect(outbox).toHaveLength(1);
          expect(outbox[0]).toMatchObject({ fulfillment_id: fulfillmentId, tracking_version: 2 });
        }
        // 全部を送った注文（b）は、注文の側の運送会社と番号も入る。一部の注文（a）は発送準備中のまま
        expect((await client.query('select status::text as status, shipping_carrier, tracking_number from public.orders where id = $1::uuid', [b.orderId])).rows[0])
          .toMatchObject({ status: 'shipped', shipping_carrier: 'yamato', tracking_number: number });
        expect(await orderStatusOf(client, a.orderId)).toBe('paid');

        // 更新のメールは注文ごとに1通（その注文のメールアドレス宛）。最初の発送のメールは通知を外していたので無く、番号を初めて入れたので「使えません」の行も無い
        for (const material of [a, b]) {
          const mails = await pollMails(request, material.email, UPDATED, 1);
          expect(mails[0].Subject).toBe(`【Le Fil des Heures】${UPDATED}（${material.orderNumber}）`);
          expect(mails[0].Text).toContain(`注文番号: ${material.orderNumber}`);
          expect(mails[0].Text).toContain(`配送業者: ${SHIPPING_CARRIERS.yamato.label}`);
          expect(mails[0].Text).toContain(`追跡番号: ${number}`);
          expect(mails[0].Text).not.toContain(SUPERSEDED);
          expect(await mailsTo(request, material.email)).toHaveLength(1);
          await expectMailCountStays(request, material.email, UPDATED, 1, 1);
        }

        // 同じ運送会社と番号のままでは直せない（断りの文がダイアログの中に出て、何も増えない）
        await operationButton(page, SHIPMENT_SLIP_TEXT.trackingEdit).click();
        const again = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.trackingEdit, exact: true });
        await expect(again.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true })).toHaveValue('yamato');
        await expect(again.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true })).toHaveValue(number);
        await again.getByRole('button', { name: SHIPMENT_SLIP_TEXT.trackingSubmitEdit, exact: true }).click();
        await expect(again.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_TRACKING_UNCHANGED[2] })).toBeVisible();
        expect((await readSlip(client, ctx.actorId, confirmed.id)).version).toBe(detail.version);
        expect(await readOutbox(client, a.orderId, ['shipping_update'])).toHaveLength(1);
        await again.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
        await expect(again).toBeHidden();
        await expectNoPageOverflow(page);
      });
    });

    test('番号を訂正すると全注文に反映され、荷物の履歴に前後の値が残り、配達済みだった票は配送中に戻る', async ({ page, request }) => {
      // FREQ-534-AC-01, FREQ-488-AC-01, FREQ-488-AC-02, FREQ-488-AC-03, FREQ-492-AC-01
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const { a, b } = await createBundle(ctx);
        const oldNumber = tracking('OLD');
        const midNumber = tracking('MID');
        const newNumber = tracking('NEW');
        const confirmed = await shipMaterialsInDb(ctx, [a, b], {
          quantities: [2, 3], carrier: 'yamato', trackingNumber: oldNumber, notifyCustomer: true,
        });
        const ids = new Map([a, b].map((material) => [material.orderId, fulfillmentIdOf(confirmed, material)]));
        const settings = await returnWindowSettings(client);

        // 手で配達済み（メールあり）にしておく。返品の期限は届いた日から数える。配達済みのメールは訂正の前に届かせる
        await markDeliveredInDb(client, { orderId: a.orderId, fulfillmentId: ids.get(a.orderId)!, actorId: ctx.actorId, deliveredOn: jstToday(), notify: true });
        for (const material of [a, b]) {
          const delivered = await readFulfillment(client, ids.get(material.orderId)!);
          expect(delivered.delivery_status).toBe('delivered');
          expect(await returnDeadlineOf(client, material.orderId, ids.get(material.orderId)!)).toBe(
            settings.windowDays === null ? null : addDays(jstDateOf(delivered.delivered_at as Date), settings.windowDays),
          );
          await pollMails(request, material.email, SHIPPED, 1);
          await pollMails(request, material.email, DELIVERED, 1);
        }

        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        for (const material of [a, b]) await expect(orderStatusLine(page, material, '配達済み')).toBeVisible();
        // 配達済みの票には「配達済みにする」を出さない（取消と番号の訂正は残る）
        await expect(operationButton(page, SHIPMENT_SLIP_TEXT.markDelivered)).toHaveCount(0);
        await expect(operationButton(page, SHIPMENT_SLIP_TEXT.cancelShipment)).toBeVisible();

        // 1回目の訂正: 運送会社も番号も変え、更新のメールは送らない
        await operationButton(page, SHIPMENT_SLIP_TEXT.trackingEdit).click();
        const opened = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.trackingEdit, exact: true });
        await expect(opened.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true })).toHaveValue('yamato');
        await expect(opened.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true })).toHaveValue(oldNumber);
        await expect(opened.getByRole('checkbox', { name: SHIPMENT_SLIP_TEXT.trackingNotify, exact: true })).toBeChecked();
        await opened.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
        await correctTrackingOnScreen(page, { carrier: 'sagawa', number: midNumber, notify: false });

        // 配達済みの記録が消えて受付済みに戻り（版が1つ進む）、全注文の発送へ新しい運送会社と番号が入る。品物は配達済みから発送済みへ戻る
        for (const material of [a, b]) {
          const fulfillmentId = ids.get(material.orderId)!;
          expect(await readFulfillment(client, fulfillmentId)).toMatchObject({
            shipping_carrier: 'sagawa', tracking_number: midNumber, tracking_version: 2, delivery_status: 'confirmed', delivered_at: null, notify_customer: false,
          });
          expect(await readTrackingChanges(client, fulfillmentId)).toEqual([
            { tracking_version: 2, from_carrier: 'yamato', from_tracking_number: oldNumber, to_carrier: 'sagawa', to_tracking_number: midNumber, notify_customer: false },
          ]);
          expect((await readEvents(client, fulfillmentId)).map((event) => [event.tracking_version, event.status, event.source])).toEqual([
            [1, 'confirmed', 'shipment'], [1, 'delivered', 'manual'], [2, 'confirmed', 'tracking_edit'],
          ]);
          const states = (await client.query(
            `select from_status, to_status, quantity from public.order_item_state_events
              where order_item_id = $1::uuid and reason = 'shipment_slip_tracking_update' order by created_at`,
            [material.orderItemId],
          )).rows;
          expect(states).toEqual([{ from_status: 'delivered', to_status: 'shipped', quantity: material === a ? 2 : 3 }]);
          // 返品の期限は、届いた日でなく発送の日の目安へ戻る
          const shippedJst = jstDateOf((await readFulfillment(client, fulfillmentId)).shipped_at);
          expect(await returnDeadlineOf(client, material.orderId, fulfillmentId)).toBe(
            settings.windowDays === null ? null : addDays(addDays(shippedJst, settings.bufferDays), settings.windowDays),
          );
          expect(await readOutbox(client, material.orderId, ['shipping_update'])).toEqual([]);
        }
        expect(await orderStatusOf(client, b.orderId)).toBe('shipped');
        for (const material of [a, b]) await expect(orderStatusLine(page, material, '受付済み')).toBeVisible();
        await expect(operationButton(page, SHIPMENT_SLIP_TEXT.markDelivered)).toBeVisible();
        const afterFirst = await readSlip(client, ctx.actorId, confirmed.id);
        expect(afterFirst).toMatchObject({ carrier: 'sagawa', trackingNumber: midNumber, trackingVersion: 2 });
        expect(afterFirst.versions.map((entry) => entry.kind)).toEqual(['confirm', 'delivered', 'tracking_update']);

        // 通知を外した訂正のメールは作られず、届かない。配達済みのメールは前のとおり1通
        for (const material of [a, b]) {
          await expectMailCountStays(request, material.email, UPDATED, 0, 1);
          await expectMailCountStays(request, material.email, DELIVERED, 1, 1);
        }

        // 2回目の訂正: 更新のメールを送る。前の番号があるので「先にお知らせした伝票番号は使えません」の行が入る
        await correctTrackingOnScreen(page, { carrier: 'japanpost', number: newNumber, notify: true });
        for (const material of [a, b]) {
          const fulfillmentId = ids.get(material.orderId)!;
          expect(await readFulfillment(client, fulfillmentId)).toMatchObject({
            shipping_carrier: 'japanpost', tracking_number: newNumber, tracking_version: 3, notify_customer: true,
          });
          const mails = await pollMails(request, material.email, UPDATED, 1);
          expect(mails[0].Text).toContain(`注文番号: ${material.orderNumber}`);
          expect(mails[0].Text).toContain(`配送業者: ${SHIPPING_CARRIERS.japanpost.label}`);
          expect(mails[0].Text).toContain(`追跡番号: ${newNumber}`);
          expect(mails[0].Text).toContain(SUPERSEDED);
          await expectMailCountStays(request, material.email, UPDATED, 1, 1);
        }

        // 票の頁の荷物の履歴に、前と後の番号が残る
        await expect(page.getByText(`${SHIPPING_CARRIERS.japanpost.label} ${newNumber}`, { exact: true })).toBeVisible();
        for (const value of [oldNumber, midNumber, newNumber]) {
          await expect(recordOf(page).getByText(value).first(), `荷物の履歴に ${value}`).toBeVisible();
        }
        // 注文の履歴には、直した記録（前 → 後・通知の選択）が残る
        const history = await historyEntries(ctx, a.orderId);
        const changes = history.entries
          .filter((entry) => entry.type === 'tracking_change')
          .map((entry) => (entry as unknown as { change: Record<string, unknown> }).change)
          .sort((left, right) => Number(left.trackingVersion) - Number(right.trackingVersion));
        expect(changes.map((change) => [change.fromCarrier, change.fromTrackingNumber, change.toCarrier, change.toTrackingNumber, change.notifyCustomer])).toEqual([
          ['yamato', oldNumber, 'sagawa', midNumber, false],
          ['sagawa', midNumber, 'japanpost', newNumber, true],
        ]);
        // 発送の更新のメールには再送の入口が無く、DB の関数も再送を断る（新しい3種類は再送できない）
        const updateMails = history.entries.filter((entry) => entry.type === 'email' && entry.kind === 'shipping_update');
        expect(updateMails).toHaveLength(1);
        expect(updateMails[0].resendable).toBe(false);
        // 配送の3種類は現行の再送の DB 関数の入力種類に無いので、状態の表を見る前に INVALID_EMAIL_KIND で断られる（DB 結合 order_email_outbox の再送の表と同じ。
        // 管理画面の再送の窓口は DB を呼ぶ前に 409 で断る〔route の単体 order-email-routes〕）
        await expectDbError(
          client.query('select public.request_order_email_resend($1::uuid, $2::text, $3::uuid)', [a.orderId, 'shipping_update', ctx.actorId]),
          'INVALID_EMAIL_KIND',
        );
        await expectNoPageOverflow(page);
      });
    });

    test('手動の配達済みで全注文が配達済みになり、届いた日が選べ、返品の期限が届いた日から数えられる', async ({ page, request }) => {
      // FREQ-534-AC-02, FREQ-489-AC-01, FREQ-489-AC-02, FREQ-489-AC-03, FREQ-492-AC-01, FREQ-492-AC-04, FREQ-503-AC-01
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const { a, b } = await createBundle(ctx);
        const confirmed = await shipMaterialsInDb(ctx, [a, b], {
          quantities: [2, 3], carrier: 'yamato', trackingNumber: tracking('DLV'), notifyCustomer: true,
        });
        const ids = new Map([a, b].map((material) => [material.orderId, fulfillmentIdOf(confirmed, material)]));
        const today = jstToday();
        const settings = await returnWindowSettings(client);
        await pollMails(request, a.email, SHIPPED, 1);
        await pollMails(request, b.email, SHIPPED, 1);

        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        await operationButton(page, SHIPMENT_SLIP_TEXT.markDelivered).click();
        const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true });
        // 届いた日は発送した日から今日まで。最初は今日で、今日より後は選べない。メールの選択は最初からオン
        const date = dialog.getByLabel(SHIPMENT_SLIP_TEXT.deliveredOnLabel, { exact: true });
        await expect(date).toHaveValue(today);
        await expect(date).toHaveAttribute('max', today);
        await expect(dialog.getByRole('checkbox', { name: SHIPMENT_SLIP_TEXT.deliveredNotify, exact: true })).toBeChecked();
        await expect(dialog.getByText(SHIPMENT_SLIP_TEXT.deliveredDescription, { exact: true })).toBeVisible();
        // 発送した日より前の日は断られる（断りの文がダイアログの中に出て、何も変わらない）
        await date.fill(addDays(today, -1));
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true }).click();
        await expect(dialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_DELIVERY_DATE_INVALID[2] })).toBeVisible();
        for (const material of [a, b]) expect((await readFulfillment(client, ids.get(material.orderId)!)).delivered_at).toBeNull();
        // 今日より後の日も同じ（入力の上限は画面の目安で、DB の関数が最後に断る）
        await date.fill(addDays(today, 1));
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true }).click();
        await expect(dialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_DELIVERY_DATE_INVALID[2] })).toBeVisible();
        for (const material of [a, b]) expect((await readFulfillment(client, ids.get(material.orderId)!)).delivered_at).toBeNull();
        // 日を今日に直して送る
        await date.fill(today);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.delivered)).toBeVisible();
        await expect(dialog).toBeHidden();

        // 全注文が配達済み。品物は発送済みから配達済みへ。ボタンは消え、取消と番号の訂正は残る
        for (const material of [a, b]) await expect(orderStatusLine(page, material, '配達済み')).toBeVisible();
        await expect(operationButton(page, SHIPMENT_SLIP_TEXT.markDelivered)).toHaveCount(0);
        await expect(operationButton(page, SHIPMENT_SLIP_TEXT.trackingEdit)).toBeVisible();
        await expect(operationButton(page, SHIPMENT_SLIP_TEXT.cancelShipment)).toBeVisible();
        for (const material of [a, b]) {
          const fulfillmentId = ids.get(material.orderId)!;
          const fulfillment = await readFulfillment(client, fulfillmentId);
          expect(fulfillment.delivery_status).toBe('delivered');
          // 届いた日の日本時間の日付は選んだ日。出来事は手で（manual）で、した人が残る
          expect(jstDateOf(fulfillment.delivered_at as Date)).toBe(today);
          const events = await readEvents(client, fulfillmentId);
          expect(events.map((event) => [event.tracking_version, event.status, event.source])).toEqual([[1, 'confirmed', 'shipment'], [1, 'delivered', 'manual']]);
          expect(events[1].created_by).toBe(ctx.actorId);
          expect((await client.query(
            `select from_status, to_status, quantity from public.order_item_state_events
              where order_item_id = $1::uuid and reason = 'shipment_slip_deliver'`,
            [material.orderItemId],
          )).rows).toEqual([{ from_status: 'shipped', to_status: 'delivered', quantity: material === a ? 2 : 3 }]);
          // 返品の期限は、届いた日（日本時間の日付）から数える
          expect(await returnDeadlineOf(client, material.orderId, fulfillmentId)).toBe(
            settings.windowDays === null ? null : addDays(today, settings.windowDays),
          );
        }

        // 配達済みのメールが注文ごとに1通。届いた日・その注文の品物・注文の画面のリンクが入り、旧会員用のリンクは無い。再送の入口は無い
        for (const material of [a, b]) {
          const deliveredAt = (await readFulfillment(client, ids.get(material.orderId)!)).delivered_at as Date;
          const mails = await pollMails(request, material.email, DELIVERED, 1);
          expect(mails[0].Subject).toBe(`【Le Fil des Heures】${DELIVERED}（${material.orderNumber}）`);
          const text = mails[0].Text;
          expect(text).toContain('ご注文の商品をお届けしました。');
          expect(text).toContain(`お届け日: ${jstMonthDay(deliveredAt)}`);
          expect(text).toContain(itemLine(material, material === a ? 2 : 3));
          expect(text).toContain(STATUS_LINK_LINE);
          expect(text).not.toContain('ご注文の確認はこちら');
          const other = material === a ? b : a;
          expect(text).not.toContain(other.orderNumber);
          expect(text).not.toContain(other.email);
          if (settings.windowDays === null) expect(text).not.toContain('商品に不具合がございましたら');
          else expect(text).toContain(`商品に不具合がございましたら、到着から ${settings.windowDays} 日以内にご注文の画面またはお問い合わせからご連絡ください`);
          await expectMailCountStays(request, material.email, DELIVERED, 1, 1);
          expect(await readOutbox(client, material.orderId, ['delivered'])).toMatchObject([{ status: 'sent', fulfillment_id: ids.get(material.orderId) }]);
        }
        const mailEntries = (await historyEntries(ctx, a.orderId)).entries.filter((entry) => entry.type === 'email' && entry.kind === 'delivered');
        expect(mailEntries).toHaveLength(1);
        expect(mailEntries[0].resendable).toBe(false);
        // 同上: 配送の3種類は DB の再送の関数が種類として受けず INVALID_EMAIL_KIND（窓口は DB の前に 409）
        await expectDbError(
          client.query('select public.request_order_email_resend($1::uuid, $2::text, $3::uuid)', [a.orderId, 'delivered', ctx.actorId]),
          'INVALID_EMAIL_KIND',
        );

        // もう一度は配達済みにできない（断りの文が出て、何も増えない）
        const detail = await readSlip(client, ctx.actorId, confirmed.id);
        const again = await send(ctx, 'POST', `${SLIPS}/${confirmed.id}/delivered`, {
          expectedVersion: detail.version, deliveredOn: today, notifyCustomer: true, requestKey: randomUUID(),
        });
        expect(again).toEqual({
          status: 409, body: { code: 'GROUP_G_SLIP_ALREADY_DELIVERED', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_ALREADY_DELIVERED[2] },
        });
        expect((await readSlip(client, ctx.actorId, confirmed.id)).version).toBe(detail.version);

        // 発送の通知を外した票: 届いた日の画面でメールの選択がオンのままでも、配達済みのメールは作られず、発送の通知の選択（オフ）は変わらない
        const silent = await createShippingMaterial(client, { quantity: 2 });
        const silentSlip = await shipMaterialsInDb(ctx, [silent], { carrier: 'sagawa', trackingNumber: tracking('SILENT'), notifyCustomer: false });
        await openSlip(page, silentSlip.id);
        await markDeliveredOnScreen(page, { notify: true });
        const silentFulfillmentId = fulfillmentIdOf(silentSlip, silent);
        expect(await readFulfillment(client, silentFulfillmentId)).toMatchObject({ delivery_status: 'delivered', notify_customer: false });
        expect(await readOutbox(client, silent.orderId, ['delivered', 'out_for_delivery', 'shipping_update'])).toEqual([]);
        await expectMailCountStays(request, silent.email, DELIVERED, 0, 2);
        await expectNoPageOverflow(page);
      });
    });

    test('発送の取消で票内の全注文が発送準備中に戻り、在庫が戻り、送る前のメールは取りやめになり、取消の知らせは出ない', async ({ page, request }) => {
      // FREQ-534-AC-03, FREQ-533-AC-04, FREQ-443-AC-01, FREQ-443-AC-02, FREQ-443-AC-03, FREQ-443-AC-04, FREQ-489-AC-03
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const { a, b } = await createBundle(ctx);
        const before = { a: await variantInventory(client, a.variantId), b: await variantInventory(client, b.variantId) };
        // メールの予定は取り置く（他の試験の毎分の処理が、画面を操作している間に送ってしまわないように）
        const confirmed = await shipHeld(ctx, [a, b], { quantities: [2, 3], carrier: 'yamato', trackingNumber: tracking('CXL'), notifyCustomer: true });
        const orderIds = [a.orderId, b.orderId];
        const outboxRows = async () => (await client.query(
          'select kind, status, last_error_code from private.order_email_outbox where order_id = any($1::uuid[]) order by seq', [orderIds],
        )).rows;
        expect(await outboxRows()).toEqual([
          { kind: 'shipped', status: 'pending', last_error_code: null }, { kind: 'shipped', status: 'pending', last_error_code: null },
        ]);
        // 発送した数だけ手元の在庫（空きではなく入金済みの割当）が減る
        const shipped = { a: await variantInventory(client, a.variantId), b: await variantInventory(client, b.variantId) };
        expect(shipped.a.onHand).toBe(before.a.onHand - 2);
        expect(shipped.b.onHand).toBe(before.b.onHand - 3);
        expect(await orderStatusOf(client, b.orderId)).toBe('shipped');
        expect(await readyQuantityOf(client, a)).toBe(2);

        await prepareShippingPage(page, ctx);
        await openSlip(page, confirmed.id);
        // 「戻る」では取り消さない
        await operationButton(page, SHIPMENT_SLIP_TEXT.cancelShipment).click();
        const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true });
        await expect(dialog.getByText(SHIPMENT_SLIP_TEXT.cancelDescription, { exact: true })).toBeVisible();
        await expect(dialog.getByTestId('slip-cancel-blockers')).toHaveCount(0);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
        await expect(dialog).toBeHidden();
        for (const material of [a, b]) expect((await fulfillmentsOf(client, material.orderId))[0].cancelled).toBe(false);
        expect(await orderStatusOf(client, b.orderId)).toBe('shipped');

        // 取り消す
        await operationButton(page, SHIPMENT_SLIP_TEXT.cancelShipment).click();
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.cancelled)).toBeVisible();
        await expect(page.getByTestId('slip-stage')).toContainText('取消済み');
        // 取り消した票には、どの操作も出ない（番号・配達済み・出荷日の訂正・取消）
        for (const name of [
          SHIPMENT_SLIP_TEXT.trackingEdit, SHIPMENT_SLIP_TEXT.trackingEnter, SHIPMENT_SLIP_TEXT.markDelivered,
          SHIPMENT_SLIP_TEXT.correctDate, SHIPMENT_SLIP_TEXT.cancelShipment,
        ]) await expect(operationButton(page, name), `${name} は出ない`).toHaveCount(0);

        // 全注文の発送が取り消され、品物は発送準備中に戻る。全部を送っていた注文（b）は決済完了に戻り、出荷日時などが空になる
        for (const material of [a, b]) expect((await fulfillmentsOf(client, material.orderId))[0].cancelled).toBe(true);
        expect(await client.query(
          'select status::text as status, shipped_at, shipping_carrier, tracking_number from public.orders where id = $1::uuid', [b.orderId],
        ).then((result) => result.rows[0])).toEqual({ status: 'paid', shipped_at: null, shipping_carrier: null, tracking_number: null });
        expect(await readyQuantityOf(client, a)).toBe(4);
        expect(await readyQuantityOf(client, b)).toBe(3);
        // 在庫は取消で1回だけ戻る（手元の在庫・入金済みの割当は発送前と同じ。空きは動かない）
        expect({ a: await variantInventory(client, a.variantId), b: await variantInventory(client, b.variantId) }).toEqual(before);
        // まだ送っていない発送のメールは取りやめ。取消のお客様メールの行は作られず、メールは1通も届かない
        expect(await outboxRows()).toEqual([
          { kind: 'shipped', status: 'skipped', last_error_code: 'fulfillment_cancelled' },
          { kind: 'shipped', status: 'skipped', last_error_code: 'fulfillment_cancelled' },
        ]);
        for (const material of [a, b]) {
          await expectMailCountStays(request, material.email, SHIPPED, 0, 2);
          expect(await mailsTo(request, material.email)).toHaveLength(0);
        }
        // 履歴: 取消の行が残り、取り消した発送のメール（取りやめ）には再送の入口が無い。取消のお客様メールの行は作られない
        for (const material of [a, b]) {
          const history = await historyEntries(ctx, material.orderId);
          expect(history.entries.filter((entry) => entry.type === 'fulfillment_cancel')).toHaveLength(1);
          expect(history.entries.find((entry) => entry.type === 'fulfillment')).toMatchObject({ cancelled: true, slipNumber: confirmed.number });
          for (const entry of history.entries.filter((candidate) => candidate.type === 'email')) expect(entry.resendable).toBe(false);
        }
        // 取り消した票は、もう配達済みにも番号の訂正にも、もう一度の取消にもできない
        const cancelled = await readSlip(client, ctx.actorId, confirmed.id);
        expect(cancelled.stage).toBe('cancelled');
        for (const operation of [
          { path: 'delivered', body: { deliveredOn: jstToday(), notifyCustomer: false } },
          { path: 'tracking', body: { carrier: 'sagawa', trackingNumber: tracking('AFTER'), notifyCustomer: false } },
          { path: 'cancel', body: {} },
        ]) {
          const refused = await send(ctx, 'POST', `${SLIPS}/${confirmed.id}/${operation.path}`, {
            expectedVersion: cancelled.version, requestKey: randomUUID(), ...operation.body,
          });
          expect(refused.status, operation.path).toBe(409);
          expect(['GROUP_G_SLIP_CANCELLED', 'GROUP_G_SLIP_NOT_CONFIRMED'], operation.path).toContain((refused.body as { code: string }).code);
        }

        // 取り消した後、同じ品物を新しい票で送り直せる。取り消した分の発送番号は使い回さない
        const reshipped = await shipMaterialsInDb(ctx, [a], { quantities: [4], notifyCustomer: false });
        expect(reshipped.id).not.toBe(confirmed.id);
        expect(await fulfillmentsOf(client, a.orderId)).toMatchObject([
          { number: 1, cancelled: true, quantity: 2 }, { number: 2, cancelled: false, quantity: 4, completesOrder: true },
        ]);

        // 送った後に取り消しても、お客様に取消のメールは行かない（送った発送のメールは送信済みのまま、取消のメールの行も書かれない）
        const sent = await createShippingMaterial(client, { quantity: 2 });
        const sentSlip = await shipMaterialsInDb(ctx, [sent], { carrier: 'sagawa', trackingNumber: tracking('SENT'), notifyCustomer: true });
        await pollMails(request, sent.email, SHIPPED, 1);
        const sentDetail = await readSlip(client, ctx.actorId, sentSlip.id);
        const sentCancel = await send(ctx, 'POST', `${SLIPS}/${sentSlip.id}/cancel`, { expectedVersion: sentDetail.version, requestKey: randomUUID() });
        expect(sentCancel.status).toBe(200);
        await expectMailCountStays(request, sent.email, SHIPPED, 1, 2);
        expect(await mailsTo(request, sent.email)).toHaveLength(1);
        expect((await client.query(
          'select kind, status from private.order_email_outbox where order_id = $1::uuid order by seq', [sent.orderId],
        )).rows).toEqual([{ kind: 'shipped', status: 'sent' }]);
        await expectNoPageOverflow(page);
      });
    });

    test('返品のある注文や発送後に返金した注文が票に含まれると、取消は断りの文が出て票は変わらない', async ({ page }) => {
      // FREQ-534-AC-03, FREQ-471-AC-01, FREQ-471-AC-02, FREQ-454-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        await ensureReturnSettings(client);
        const paymentIntent = () => `pi_e2e_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        /**
         * 取消を断られた時に変わってはいけない物（票・発送・準備中の数・在庫）をまとめて読む。
         * 票の詳細の追跡の登録の欄（registration）は比べない: 追跡のオン・オフは全体の設定で、他の試験が切り替え、登録の状態は
         * 他の試験が呼ぶ毎分の処理で進むので、取消が断られたこととは関係なく値が動く。取消が登録に触れていないことは expectNoCancelStop で別に確かめる。
         */
        const stateOf = async (slipId: string, materials: readonly ShippingMaterial[]) => {
          const detail = await readSlip(client, ctx.actorId, slipId);
          const slip: Omit<typeof detail, 'registration'> & { registration?: unknown } = { ...detail };
          delete slip.registration;
          return {
            slip,
            fulfillments: await Promise.all(materials.map((material) => fulfillmentsOf(client, material.orderId))),
            ready: await Promise.all(materials.map((material) => readyQuantityOf(client, material))),
            inventory: await Promise.all(materials.map((material) => variantInventory(client, material.variantId))),
          };
        };
        /** 断られた取消は、この票の追跡の登録を「取消」で止めていない（止めるのは成功した取消だけ） */
        const expectNoCancelStop = async (slipId: string) => {
          const stopped = await client.query(
            `select count(*)::int as n from private.fulfillment_tracking_registrations as r
               join public.shipment_slip_fulfillments as sf on sf.fulfillment_id = r.fulfillment_id
              where sf.slip_id = $1::uuid and r.stop_reason = 'cancelled'`,
            [slipId],
          );
          expect(stopped.rows[0].n, '断られた取消は追跡の登録を止めない').toBe(0);
        };
        const openCancelDialog = async () => {
          await operationButton(page, SHIPMENT_SLIP_TEXT.cancelShipment).click();
          const dialog = page.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true });
          await expect(dialog).toBeVisible();
          return dialog;
        };
        await prepareShippingPage(page, ctx);

        // 受付中の返品がある注文を含む同梱の票: 断りの文と理由の一覧がダイアログの中に出て、票は変わらない
        const { a, b } = await createBundle(ctx, [4, 3], { paymentIntentId: paymentIntent() });
        const bundle = await shipMaterialsInDb(ctx, [a, b], { carrier: 'yamato', trackingNumber: tracking('RET'), notifyCustomer: false });
        const openReturn = await createReturnInDb(client, { orderId: a.orderId, actorId: ctx.actorId, fulfillmentId: fulfillmentIdOf(bundle, a) }, {
          lines: [{ orderItemId: a.orderItemId, quantity: 1 }], notify: false,
        });
        const beforeBundle = await stateOf(bundle.id, [a, b]);
        expect(beforeBundle.slip.cancelBlockers).toEqual([{ orderId: a.orderId, reason: 'has_return' }]);
        await openSlip(page, bundle.id);
        let dialog = await openCancelDialog();
        await expect(dialog.getByTestId('slip-cancel-blockers')).toContainText(formatCancelBlocker(a.orderNumber, 'has_return'));
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click();
        await expect(dialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_HAS_RETURN[2] })).toBeVisible();
        await expect(dialog).toBeVisible();
        expect(await stateOf(bundle.id, [a, b])).toEqual(beforeBundle);
        await expectNoCancelStop(bundle.id);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByTestId('slip-stage')).toContainText('発送済み');

        // その返品を取り消すと、取消の返品しか指さない票は取り消せる（理由の一覧も消える）
        await cancelReturnInDb(client, openReturn.returnId, ctx.actorId);
        await page.reload();
        await expectSlipHeading(page);
        dialog = await openCancelDialog();
        await expect(dialog.getByTestId('slip-cancel-blockers')).toHaveCount(0);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click();
        await expect(noticeOf(page, SHIPMENT_SLIP_TEXT.cancelled)).toBeVisible();
        await expect(page.getByTestId('slip-stage')).toContainText('取消済み');
        for (const material of [a, b]) expect((await fulfillmentsOf(client, material.orderId))[0].cancelled).toBe(true);

        // 完了した返品（お返しで終えた）が指す票も取り消せない（窓口を直に呼んでも同じ）
        const closedOrder = await createShippingMaterial(client, { quantity: 2, paymentIntentId: paymentIntent() });
        const closedSlip = await shipMaterialsInDb(ctx, [closedOrder], { notifyCustomer: false });
        const closedReturn = await createReturnInDb(client, { orderId: closedOrder.orderId, actorId: ctx.actorId, fulfillmentId: fulfillmentIdOf(closedSlip, closedOrder) }, {
          lines: [{ orderItemId: closedOrder.orderItemId, quantity: 1 }], notify: false,
        });
        await receiveReturnInDb(client, closedReturn.returnId, ctx.actorId, {
          units: [{ lineId: closedReturn.lineIds[closedOrder.orderItemId], disposition: 'sent_back', quantity: 1 }],
          choice: 'none', notify: true, sentBack: { message: 'お返しします。' },
        });
        const beforeClosed = await stateOf(closedSlip.id, [closedOrder]);
        expect(await send(ctx, 'POST', `${SLIPS}/${closedSlip.id}/cancel`, { expectedVersion: beforeClosed.slip.version, requestKey: randomUUID() })).toEqual({
          status: 409, body: { code: 'GROUP_G_SLIP_HAS_RETURN', error: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_HAS_RETURN[2] },
        });
        expect(await stateOf(closedSlip.id, [closedOrder])).toEqual(beforeClosed);
        await expectNoCancelStop(closedSlip.id);

        // 発送後に返金した注文: 2回に分けて送った3点のうち2点を返金すると、最初の票（2点）は取り消せず、次の票（1点）は取り消せる
        const refunded = await createShippingMaterial(client, { quantity: 3, paymentIntentId: paymentIntent() });
        const first = await shipMaterialsInDb(ctx, [refunded], { quantities: [2], notifyCustomer: false });
        const second = await shipMaterialsInDb(ctx, [refunded], { quantities: [1], notifyCustomer: false });
        await beginRefund(client, refunded.orderId, {
          actorId: ctx.actorId,
          lines: [{ orderItemId: refunded.orderItemId, quantity: 2, beforeShipment: false }],
          restock: false,
          notifyCustomer: false,
          amount: UNIT_PRICE * 2,
        });
        const beforeFirst = await stateOf(first.id, [refunded]);
        expect(beforeFirst.slip.cancelBlockers).toEqual([{ orderId: refunded.orderId, reason: 'refunded' }]);
        await openSlip(page, first.id);
        dialog = await openCancelDialog();
        await expect(dialog.getByTestId('slip-cancel-blockers')).toContainText(formatCancelBlocker(refunded.orderNumber, 'refunded'));
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click();
        await expect(dialog.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_ERRORS.GROUP_G_SLIP_REFUNDED[2] })).toBeVisible();
        expect(await stateOf(first.id, [refunded])).toEqual(beforeFirst);
        await expectNoCancelStop(first.id);
        await dialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByTestId('slip-stage')).toContainText('発送済み');
        // 次の票は、取り消しても返金した数（2点）を下回らないので通る。未発送が戻るので決済完了に戻り、最初の票は変わらない
        const beforeSecond = await readSlip(client, ctx.actorId, second.id);
        expect(beforeSecond.cancelBlockers).toEqual([]);
        const cancelled = await send(ctx, 'POST', `${SLIPS}/${second.id}/cancel`, { expectedVersion: beforeSecond.version, requestKey: randomUUID() });
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ id: second.id, restoredQuantity: 1, replayed: false });
        expect(await orderStatusOf(client, refunded.orderId)).toBe('paid');
        expect(await readyQuantityOf(client, refunded)).toBe(1);
        expect((await readSlip(client, ctx.actorId, first.id)).stage).toBe('confirmed');
        await expectNoPageOverflow(page);
      });
    });

    test('追跡オンの2注文の票は、偽のproviderへの登録が1回だけで、読み直しの結果が両方の注文に反映される。追跡がオフでも伝票番号の訂正と手動の配達済みができる', async ({ page }) => {
      // FREQ-534-AC-04, FREQ-541-AC-03, FREQ-488-AC-01, FREQ-489-AC-02, FREQ-493-AC-01
      test.setTimeout(480_000);
      await withDeliveryScenario(async ({ client: settings, numberPrefix }) => {
        await withShippingScenario(async (ctx) => {
          const { client } = ctx;
          await prepareShippingPage(page, ctx);

          // ---- 追跡オン: 外への登録は代表の発送だけに1回。読み直しの答えは票の全注文へ反映される ----
          await setTrackingViaFunction(settings, true, ctx.actorId);
          const pair = pairFor(numberPrefix, 'E117ON');
          await setFakeTracking({ ...pair, responseKey: 'inTransit' });
          const on = await createBundle(ctx, [4, 3]);
          const confirmed = await shipMaterialsInDb(ctx, [on.a, on.b], {
            quantities: [2, 3], carrier: 'yamato', trackingNumber: pair.number, notifyCustomer: false,
          });
          const ids = [on.a, on.b].map((material) => fulfillmentIdOf(confirmed, material));
          const detail = await readSlip(client, ctx.actorId, confirmed.id);
          expect(detail.registration.enabled).toBe(true);
          const leader = [on.a, on.b].find((material) => material.orderId === detail.registration.leaderOrderId);
          expect(leader, '代表の注文は票の注文のどれか').toBeDefined();
          const leaderId = fulfillmentIdOf(confirmed, leader!);
          const participantId = ids.find((id) => id !== leaderId)!;
          // 追跡の登録の行は代表の発送だけに1つ
          expect((await client.query(
            'select fulfillment_id from private.fulfillment_tracking_registrations where fulfillment_id = any($1::uuid[])', [ids],
          )).rows).toEqual([{ fulfillment_id: leaderId }]);

          await pollWithMinuteJob(
            () => Promise.all(ids.map((id) => readFulfillment(client, id))),
            (rows) => rows.every((row) => row.delivery_status === 'in_transit'),
            '登録と読み直しで票の両方の注文が輸送中になること',
          );
          // 外への呼び出しは、票×版に1回の登録とその読み直しだけ（参加の注文の分は無い）
          expect(callMethods(await readFakeTrackingCalls(pair))).toEqual(['register', 'gettrackinfo']);
          expect(await readRegistration(client, leaderId)).toMatchObject({ state: 'registered', ever_registered: true });
          expect(await readRegistration(client, participantId)).toBeUndefined();
          for (const id of ids) expect((await readEvents(client, id)).map((event) => event.status)).toEqual(['confirmed', 'in_transit']);
          await openSlip(page, confirmed.id);
          for (const material of [on.a, on.b]) await expect(orderStatusLine(page, material, '輸送中')).toBeVisible();

          // 配達済みの知らせ: 両方の注文が配達済みになり、代表の登録は止まる
          await setFakeTracking({ ...pair, responseKey: 'delivered' });
          expect((await sendSignedTrackingWebhook({ ...pair, event: 'TRACKING_UPDATED' })).status).toBe(200);
          await pollWithMinuteJob(
            () => Promise.all(ids.map((id) => readFulfillment(client, id))),
            (rows) => rows.every((row) => row.delivery_status === 'delivered' && row.delivered_at !== null),
            '知らせの後に票の両方の注文が配達済みになること',
          );
          expect(await readRegistration(client, leaderId)).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });
          for (const id of ids) expect((await readEvents(client, id)).map((event) => event.status)).toEqual(['confirmed', 'in_transit', 'delivered']);
          expect(callMethods(await readFakeTrackingCalls(pair))[0]).toBe('register');
          expect(callMethods(await readFakeTrackingCalls(pair)).filter((method) => method === 'register')).toHaveLength(1);
          await page.reload();
          await expectSlipHeading(page);
          for (const material of [on.a, on.b]) await expect(orderStatusLine(page, material, '配達済み')).toBeVisible();
          await expect(operationButton(page, SHIPMENT_SLIP_TEXT.markDelivered)).toHaveCount(0);
          // 注文の履歴: 追跡がオンなので配送の状況の欄を出す印が立ち、届いた日の出どころは「追跡」。参加の注文にも同じ票の発送の行が出る
          for (const material of [on.a, on.b]) {
            const history = await historyEntries(ctx, material.orderId);
            expect(history.trackingEnabled).toBe(true);
            const entry = history.entries.find((candidate) => candidate.type === 'fulfillment') as unknown as {
              slipId: string; slipNumber: string; delivery: { deliveredSource: string | null; registration: { state: string } | null };
            };
            expect(entry).toMatchObject({ slipId: confirmed.id, slipNumber: confirmed.number });
            expect(entry.delivery.deliveredSource).toBe('tracking');
          }

          // ---- 追跡オフ: 外への登録は無いまま、伝票番号の訂正と手動の配達済みが票の全注文にできる ----
          await setTrackingViaFunction(settings, false, ctx.actorId);
          const off = await createBundle(ctx, [4, 3]);
          const offPair = pairFor(numberPrefix, 'E117OFF');
          const editedPair = pairFor(numberPrefix, 'E117EDIT', 'sagawa');
          const offSlip = await shipMaterialsInDb(ctx, [off.a, off.b], {
            quantities: [2, 3], carrier: 'yamato', trackingNumber: offPair.number, notifyCustomer: false,
          });
          const offIds = [off.a, off.b].map((material) => fulfillmentIdOf(offSlip, material));
          const registrationsOf = async (fulfillmentIds: readonly string[]) => (await client.query(
            'select fulfillment_id from private.fulfillment_tracking_registrations where fulfillment_id = any($1::uuid[])', [fulfillmentIds],
          )).rows;
          expect((await readSlip(client, ctx.actorId, offSlip.id)).registration.enabled).toBe(false);
          expect(await registrationsOf(offIds)).toEqual([]);

          await openSlip(page, offSlip.id);
          await correctTrackingOnScreen(page, { carrier: 'sagawa', number: editedPair.number, notify: false });
          for (const id of offIds) {
            expect(await readFulfillment(client, id)).toMatchObject({
              shipping_carrier: 'sagawa', tracking_number: editedPair.number, tracking_version: 2, delivery_status: 'confirmed',
            });
          }
          await markDeliveredOnScreen(page, { notify: false });
          for (const id of offIds) {
            const fulfillment = await readFulfillment(client, id);
            expect(fulfillment.delivery_status).toBe('delivered');
            expect(fulfillment.delivered_at).not.toBeNull();
            // 同じ版（2）の中の並びは時刻で決まり、届いた時刻は日本時間の正午より前に丸められることがあるので、並びではなく組で確かめる
            expect((await readEvents(client, id)).map((event) => `${event.status}:${event.source}`).sort()).toEqual([
              'confirmed:shipment', 'confirmed:tracking_edit', 'delivered:manual',
            ]);
          }
          // 登録も外への呼び出しも無い
          expect(await registrationsOf(offIds)).toEqual([]);
          expect(await readFakeTrackingCalls(offPair)).toEqual([]);
          expect(await readFakeTrackingCalls(editedPair)).toEqual([]);
          // 注文の履歴: 追跡がオフなので配送の状況の欄は無く、届いた日の出どころは「手で」
          for (const material of [off.a, off.b]) {
            const history = await historyEntries(ctx, material.orderId);
            expect(history.trackingEnabled).toBe(false);
            const entry = history.entries.find((candidate) => candidate.type === 'fulfillment') as unknown as {
              delivery: { deliveredSource: string | null };
            };
            expect(entry.delivery.deliveredSource).toBe('manual');
            expect(history.entries.filter((candidate) => candidate.type === 'tracking_change')).toHaveLength(1);
          }
          await expectNoPageOverflow(page);
        });
      });
    });

    test('操作の権限（manage）が無いと票を操作できず、旧4つの発送の入口は410のまま', async ({ page }) => {
      // FREQ-540-AC-10, FREQ-534-AC-05
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const supporterId = await createPermissionActor(client, 'supporter');
        const material = await createShippingMaterial(client, { quantity: 2 });
        const shipped = await shipMaterialsInDb(ctx, [material], { notifyCustomer: false });
        const fulfillmentId = fulfillmentIdOf(shipped, material);
        // 店長の画面（権限の保存は bridge 経由で DB の関数へ）と、サポーターの画面は別のタブ
        await mockAdminSessionAs(page, 'admin');
        await mockPermissionUiBridge(page, client, ctx.actorId);
        const supporterPage = await page.context().newPage();
        try {
          await supporterPage.setViewportSize({ width: viewport.width, height: viewport.height });
          await prepareShippingPage(supporterPage, ctx, { role: 'supporter', actorId: supporterId });
          // 票の操作が止めた4つの窓口（旧の発送の窓口）を呼ばないことを、届いた要求で確かめる
          const legacyCalls: string[] = [];
          supporterPage.on('request', (request) => {
            const { pathname } = new URL(request.url());
            if (/^\/api\/admin\/orders\/[^/]+\/fulfillments(\/|$)/.test(pathname)) legacyCalls.push(`${request.method()} ${pathname}`);
          });
          const answerOf = (operation: string) => supporterPage.waitForResponse(
            (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `${SLIPS}/${shipped.id}/${operation}`,
          );
          const forbiddenIn = (scope: Locator) => scope.getByRole('alert').filter({ hasText: SHIPMENT_SLIP_TEXT.forbidden });
          const unchanged = async () => {
            const fulfillment = await readFulfillment(client, fulfillmentId);
            expect(fulfillment).toMatchObject({ shipping_carrier: null, tracking_number: null, tracking_version: 1, delivered_at: null });
            expect(await readTrackingChanges(client, fulfillmentId)).toEqual([]);
            expect(await readOutbox(client, material.orderId, ['shipping_update', 'delivered'])).toEqual([]);
          };
          const versionBefore = (await readSlip(client, ctx.actorId, shipped.id)).version;

          // 店長が発送の操作権限を外す: サポーターは票を見られるが、伝票番号・配達済み・取消は DB の関数が断る
          await setSupporterPermissionOnScreen(page, 'admin.shipping.manage', false);
          await openSlip(supporterPage, shipped.id);
          await expect(supporterPage.getByText(SHIPMENT_SLIP_TEXT.dateOwnerOnly, { exact: true })).toBeVisible();

          await operationButton(supporterPage, SHIPMENT_SLIP_TEXT.trackingEnter).click();
          const trackingDialog = supporterPage.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.trackingEnter, exact: true });
          await trackingDialog.getByRole('combobox', { name: SHIPMENT_SLIP_TEXT.carrierLabel, exact: true }).selectOption('yamato');
          await trackingDialog.getByLabel(SHIPMENT_SLIP_TEXT.trackingNumberLabel, { exact: true }).fill(tracking('DENY'));
          const [trackingAnswer] = await Promise.all([
            answerOf('tracking'),
            trackingDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.trackingSubmitEnter, exact: true }).click(),
          ]);
          expect(trackingAnswer.status()).toBe(403);
          await expect(forbiddenIn(trackingDialog)).toBeVisible();
          await trackingDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
          await expect(trackingDialog).toBeHidden();
          await unchanged();

          await operationButton(supporterPage, SHIPMENT_SLIP_TEXT.markDelivered).click();
          const deliveredDialog = supporterPage.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true });
          const [deliveredAnswer] = await Promise.all([
            answerOf('delivered'),
            deliveredDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.markDelivered, exact: true }).click(),
          ]);
          expect(deliveredAnswer.status()).toBe(403);
          await expect(forbiddenIn(deliveredDialog)).toBeVisible();
          await deliveredDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
          await expect(deliveredDialog).toBeHidden();
          await unchanged();

          await operationButton(supporterPage, SHIPMENT_SLIP_TEXT.cancelShipment).click();
          const cancelDialog = supporterPage.getByRole('dialog', { name: SHIPMENT_SLIP_TEXT.cancelShipment, exact: true });
          const [cancelAnswer] = await Promise.all([
            answerOf('cancel'),
            cancelDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.cancelSubmit, exact: true }).click(),
          ]);
          expect(cancelAnswer.status()).toBe(403);
          await expect(forbiddenIn(cancelDialog)).toBeVisible();
          await cancelDialog.getByRole('button', { name: SHIPMENT_SLIP_TEXT.back, exact: true }).click();
          await expect(cancelDialog).toBeHidden();
          expect((await fulfillmentsOf(client, material.orderId))[0].cancelled).toBe(false);
          // 窓口を直に呼んでも同じ。票の版は動かない
          for (const operation of [
            { path: 'tracking', body: { carrier: 'sagawa', trackingNumber: tracking('DENY2'), notifyCustomer: false } },
            { path: 'delivered', body: { deliveredOn: jstToday(), notifyCustomer: false } },
            { path: 'cancel', body: {} },
          ]) {
            const refused = await send(ctx, 'POST', `${SLIPS}/${shipped.id}/${operation.path}`, {
              expectedVersion: versionBefore, requestKey: randomUUID(), ...operation.body,
            }, supporterId);
            expect(refused, operation.path).toEqual({ status: 403, body: { code: 'GROUP_G_FORBIDDEN', error: SHIPMENT_SLIP_TEXT.forbidden } });
          }
          expect((await readSlip(client, ctx.actorId, shipped.id)).version).toBe(versionBefore);
          await unchanged();
          expect(legacyCalls).toEqual([]);

          // 権限を戻すと、同じ画面から伝票番号の後入力も配達済みもできる（旧の窓口は呼ばない）
          await setSupporterPermissionOnScreen(page, 'admin.shipping.manage', true);
          await openSlip(supporterPage, shipped.id);
          await correctTrackingOnScreen(supporterPage, { carrier: 'yamato', number: tracking('ALLOW'), notify: false, entering: true });
          await markDeliveredOnScreen(supporterPage, { notify: false });
          expect(await readFulfillment(client, fulfillmentId)).toMatchObject({ shipping_carrier: 'yamato', tracking_version: 2, delivery_status: 'delivered' });
          expect(legacyCalls).toEqual([]);

          // 旧4つの発送の入口は停止のまま: DB の旧の関数は固定の記号で断る（手元の DB の関数を直に呼ぶ）
          const id = () => randomUUID();
          await expectDbError(client.query('select * from public.admin_create_fulfillment($1,$2,$3,$4,$5,$6,$7::jsonb)', [
            id(), id(), id(), 'yamato', 'LEGACY-1', false, JSON.stringify([{ order_item_id: id(), quantity: 1 }]),
          ]), LEGACY_FULFILLMENT_DISABLED);
          await expectDbError(client.query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [id(), id(), id()]), LEGACY_FULFILLMENT_DISABLED);
          await expectDbError(client.query('select * from public.admin_update_fulfillment_tracking($1,$2,$3,$4,$5,$6,$7)', [
            id(), id(), id(), id(), 'sagawa', 'Valid-123', true,
          ]), LEGACY_FULFILLMENT_DISABLED);
          await expectDbError(client.query('select * from public.admin_mark_fulfillment_delivered($1,$2,$3,$4,$5::date,$6)', [
            id(), id(), id(), id(), jstToday(), false,
          ]), LEGACY_FULFILLMENT_DISABLED);
          // この明示した route bridge は legacyFulfillmentDisabledBody の本文の形だけを固定し、窓口の guard・DB には届かない。
          // 本物の窓口の 410 は tests/unit/api/admin/order-fulfillment-routes.test.ts（発送・取消）と
          // tests/unit/api/admin/order-delivery-routes.test.ts（伝票番号の訂正・手動の配達済み）が確かめる（FR-ADMIN-123 の G-3 の節⑥と同じ分担）。
          await supporterPage.route(/\/api\/admin\/orders\/[^/]+\/fulfillments(\/.*)?$/, (route) => route.fulfill({
            status: 410, contentType: 'application/json', body: JSON.stringify(legacyFulfillmentDisabledBody(LEGACY_FULFILLMENT_DISABLED)),
          }));
          for (const path of [
            `/api/admin/orders/${material.orderId}/fulfillments`,
            `/api/admin/orders/${material.orderId}/fulfillments/${fulfillmentId}/cancel`,
            `/api/admin/orders/${material.orderId}/fulfillments/${fulfillmentId}/tracking`,
            `/api/admin/orders/${material.orderId}/fulfillments/${fulfillmentId}/delivered`,
          ]) {
            expect(await callFromPage(supporterPage, 'POST', path, {}), path).toEqual({
              status: 410, body: legacyFulfillmentDisabledBody(LEGACY_FULFILLMENT_DISABLED),
            });
          }
          await expectNoPageOverflow(supporterPage);
        } finally {
          await supporterPage.close();
        }
      }, { changesPermissions: true });
    });

    test('注文の履歴の発送の行から、その票を開ける', async ({ page }) => {
      // FREQ-533-AC-01, FREQ-534-AC-05, FREQ-493-AC-01, FREQ-471-AC-02
      await withShippingScenario(async (ctx) => {
        const { client } = ctx;
        const material = await createShippingMaterial(client, { quantity: 4 });
        const oldNumber = tracking('HOLD');
        const newNumber = tracking('HNEW');
        const confirmed = await shipMaterialsInDb(ctx, [material], {
          quantities: [2], carrier: 'yamato', trackingNumber: oldNumber, notifyCustomer: false,
        });
        await prepareShippingPage(page, ctx);
        // 票の頁で番号を直し、手で配達済みにする（履歴に直した記録と届いた日が残る）
        await openSlip(page, confirmed.id);
        await correctTrackingOnScreen(page, { carrier: 'sagawa', number: newNumber, notify: false });
        await markDeliveredOnScreen(page, { notify: false });
        const deliveredAt = (await readFulfillment(client, fulfillmentIdOf(confirmed, material))).delivered_at as Date;

        // 荷作り表の行（2点が準備中のまま残る）の注文IDから履歴を開く
        await openPacking(page);
        const row = await revealPackingRow(page, material);
        await row.getByRole('button', { name: `${material.orderNumber} の履歴を開く`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'この注文の履歴', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(SHIPMENT_SLIP_TEXT.orderHistoryGuide, { exact: true })).toBeVisible();
        const shipment = dialog.getByRole('listitem').filter({ hasText: '発送（1回目）' }).filter({ hasText: '配送業者:' });
        await expect(shipment).toHaveCount(1);
        await expect(shipment).toContainText(`配送業者: ${SHIPPING_CARRIERS.sagawa.label} / 伝票番号: ${newNumber}`);
        await expect(shipment.getByText(`お届け日 ${jstMonthDay(deliveredAt)}（手で）`, { exact: true })).toBeVisible();
        // 直した記録: 前 → 後と、お客様へのメールの状態
        const change = dialog.getByRole('listitem').filter({ hasText: '伝票番号を直した（1回目）' });
        await expect(change).toHaveCount(1);
        await expect(change.getByText(`${SHIPPING_CARRIERS.yamato.label} ${oldNumber} → ${SHIPPING_CARRIERS.sagawa.label} ${newNumber}`, { exact: true })).toBeVisible();
        await expect(change.getByText('お客様へのメール：送らない', { exact: true })).toBeVisible();
        // 旧の操作（この発送を取り消す・伝票番号を直す・配達済みにする）の入口は履歴に無い。操作は発送票から行う
        for (const name of ['この発送を取り消す', '伝票番号を直す', '配達済みにする']) {
          await expect(dialog.getByRole('button', { name, exact: true }), `${name} は履歴に出ない`).toHaveCount(0);
        }
        await expectNoPageOverflow(page);

        // 発送の行の「発送票 … を開く」から、その票の頁へ移る
        await shipment.getByRole('link', { name: formatOpenSlipLabel(confirmed.number), exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/admin/shipment-slips/${confirmed.id}$`));
        expect(await expectSlipHeading(page)).toBe(confirmed.number);
        await expect(page.getByTestId('slip-stage')).toContainText('発送済み');
        await expectNoPageOverflow(page);
      });
    });
  });
}
