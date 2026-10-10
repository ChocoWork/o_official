/**
 * FR-ADMIN-072 発送の取消
 * 対応 FREQ: FREQ-443（AC-01〜AC-04）
 *
 * 履歴の画面の操作は窓口を差し替えて確かめる（実装計画 P11）。取消が数・注文の状態・送る前のメールに及ぶこと（AC-03・AC-04）は、
 * 手元の DB の関数・worker の定期処理の入口・Mailpit で確かめる。履歴の画面は、目で見るために3つの画面幅の写しを test-results/group-e1/ に残す。
 */
import { expect, test, type Page } from '@playwright/test';
import type {
  OrderHistoryEmailEntry,
  OrderHistoryFulfillmentCancelEntry,
  OrderHistoryFulfillmentEntry,
  OrderHistoryResponse,
} from '@/lib/orders/email/order-history';
import type { CancelFulfillmentResponse, FulfillmentErrorResponse } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  cancelFulfillment,
  createActor,
  createFulfillment,
  createOrderWithLines,
  lineCounts,
  mailsTo,
  orderState,
  outboxRows,
  recordCompletion,
  runWorkerOnce,
  runWorkerUntil,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';

const ORDER_ID = 'a3b2c3d4-1111-2222-8333-444455556666';
const BLOUSE = 'b3b2c3d4-0000-4000-8000-000000000001';
const SKIRT = 'b3b2c3d4-0000-4000-8000-000000000002';
const FULFILLMENT_ID = 'f3b2c3d4-0000-4000-8000-000000000001';
const CONFIRM =
  '発送（1回目）を取り消し、その商品を発送準備中に戻します。お客様にメールは送りません。送った発送のメールがあれば、店からお客様に連絡してください。';
const REFUSAL = 'この発送は取り消せません。注文の状態を確かめてください。';
const SHIPPED_SUBJECT = '商品を発送いたしました';

type CancelState = { cancelled: boolean; refuse: boolean; posts: string[] };

function entriesOf(state: CancelState): OrderHistoryResponse['entries'] {
  const shipment = {
    type: 'fulfillment',
    at: '2026-10-10T03:00:00.000Z',
    fulfillmentId: FULFILLMENT_ID,
    number: 1,
    carrierLabel: 'ヤマト運輸',
    trackingNumber: '1234-5678-9012',
    items: [{ name: 'シルクブラウス', quantity: 2 }],
    actorEmail: 'admin@example.com',
    notifyCustomer: true,
    completesOrder: false,
    cancelled: state.cancelled,
    cancellable: !state.cancelled,
    legacy: false,
  } satisfies OrderHistoryFulfillmentEntry;
  const mail = {
    type: 'email',
    at: '2026-10-10T03:00:01.000Z',
    emailId: 'e3b2c3d4-0000-4000-8000-000000000001',
    kind: 'shipped',
    kindLabel: '発送（1回目）',
    manual: false,
    requestedByEmail: null,
    stateLabel: '配達済み',
    warning: false,
    attempts: 1,
    errorLabel: null,
    sentAt: '2026-10-10T03:00:05.000Z',
    deliveryEventAt: '2026-10-10T03:01:00.000Z',
    canViewContent: true,
    bodyErased: false,
    resendable: !state.cancelled,
    fulfillmentId: FULFILLMENT_ID,
    fulfillmentNumber: 1,
  } satisfies OrderHistoryEmailEntry;
  const cancel = {
    type: 'fulfillment_cancel',
    at: '2026-10-10T04:00:00.000Z',
    fulfillmentId: FULFILLMENT_ID,
    number: 1,
    actorEmail: 'admin@example.com',
  } satisfies OrderHistoryFulfillmentCancelEntry;
  return [
    ...(state.cancelled ? [cancel] : []),
    mail,
    shipment,
    { type: 'status', at: '2026-10-09T01:00:00.000Z', fromLabel: '支払い手続き中', toLabel: '決済完了', actorEmail: null, detail: null },
    { type: 'created', at: '2026-10-09T00:59:00.000Z' },
  ];
}

function rowOf(state: CancelState) {
  const blouseShipped = state.cancelled ? 0 : 2;
  return adminOrder({
    id: ORDER_ID,
    items: [
      orderLine({ id: BLOUSE, name: 'シルクブラウス', quantity: 2, shipped: blouseShipped, readyUnshipped: 2 - blouseShipped }),
      orderLine({ id: SKIRT, name: 'プリーツスカート', quantity: 1, readyUnshipped: 1 }),
    ],
    partiallyShipped: !state.cancelled,
  });
}

async function mockCancelApis(page: Page) {
  const state: CancelState = { cancelled: false, refuse: false, posts: [] };
  await mockAdminSession(page);
  const list = await mockOrderList(page, () => [rowOf(state)]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => fulfillJson(route, historyOf(ORDER_ID, entriesOf(state))));
  await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`, async (route) => {
    state.posts.push(route.request().url());
    if (state.refuse) {
      await fulfillJson(route, { error: REFUSAL, code: 'fulfillment_cancel_not_allowed' } satisfies FulfillmentErrorResponse, 409);
      return;
    }
    state.cancelled = true;
    await fulfillJson(route, { outcome: 'cancelled', orderStatus: 'paid' } satisfies CancelFulfillmentResponse);
  });
  return { state, listUrls: list.urls };
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: `${orderNumberOf(ORDER_ID)} の履歴` }).click();
  const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 送信済みになった発送のメールの数 */
async function sentShipped(orderId: string): Promise<number> {
  const rows = await withLocalDb((db) => outboxRows(db, orderId));
  return rows.filter((row) => row.status === 'sent').length;
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-072 fulfillment cancel (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('履歴の発送の行から取り消すと、取消の行が履歴に残り、取り消した発送には取消もメールの再送も出ず、一覧が読み直される', async ({ page }) => {
      // FREQ-443-AC-01
      const { state, listUrls } = await mockCancelApis(page);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(ORDER_ID) });
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();

      const dialog = await openHistory(page);
      const shipment = dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' });
      await expect(shipment).toContainText('発送（1回目）');
      await expect(shipment).toContainText('1234-5678-9012');
      await expect(shipment).toContainText('シルクブラウス');
      await expect(dialog.getByRole('listitem').filter({ hasText: '発送（1回目）のメール' })).toHaveCount(1);
      // ダイアログは開く時に160ミリ秒で現れる。途中の写りを避けるため、動きを終わらせてから撮る
      await page.screenshot({ path: `test-results/group-e1/order-history-fulfillment-${viewport.width}.png`, animations: 'disabled' });

      // 取消の前は、その発送のメールに「お客様へ再送」が1つある（取消の後に無いことの確かめが、名前の変わりで黙って通らないように）
      await expect(dialog.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(1);
      const before = listUrls.length;
      await shipment.getByRole('button', { name: 'この発送を取り消す' }).click();
      await expect(page.getByText(CONFIRM)).toBeVisible();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();

      await expect(dialog.getByRole('listitem').filter({ hasText: '発送（1回目）を取り消しました' })).toHaveCount(1);
      expect(state.posts).toEqual([expect.stringContaining(`/fulfillments/${FULFILLMENT_ID}/cancel`)]);
      await expect(shipment.getByRole('button', { name: 'この発送を取り消す' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(0);
      await expect.poll(() => listUrls.length).toBeGreaterThan(before);
      await page.keyboard.press('Escape');
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
    });

    test('「やめる」では取り消さず、窓口が取消を断った時は理由が確かめの画面の中に出る', async ({ page }) => {
      // FREQ-443-AC-02
      const { state } = await mockCancelApis(page);
      await openOrderTab(page);
      const dialog = await openHistory(page);
      const shipment = dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' });

      await shipment.getByRole('button', { name: 'この発送を取り消す' }).click();
      await expect(page.getByText(CONFIRM)).toBeVisible();
      await page.getByRole('button', { name: 'やめる', exact: true }).click();
      expect(state.posts).toHaveLength(0);
      await expect(shipment.getByRole('button', { name: 'この発送を取り消す' })).toBeVisible();

      state.refuse = true;
      await shipment.getByRole('button', { name: 'この発送を取り消す' }).click();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();
      await expect(page.getByText(REFUSAL)).toBeVisible();
      // 断られた後も、確かめの画面（文と「やめる」）に留まっていて、取り消されてもいない
      await expect(page.getByText(CONFIRM)).toBeVisible();
      await expect(page.getByRole('button', { name: 'やめる', exact: true })).toBeVisible();
      expect(state.posts).toHaveLength(1);
      await expect(page.getByText('発送（1回目）を取り消しました')).toHaveCount(0);
    });

    test('履歴の画面を開いても横方向のページスクロールが発生しない', async ({ page }) => {
      await mockCancelApis(page);
      await openOrderTab(page);
      const dialog = await openHistory(page);
      await expect(dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' })).toBeVisible();

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('発送を取り消すと商品が発送準備中に戻り、全部送っていた注文は決済完了に戻り、送る前のメールは取りやめになり、取消のメールは行かない（手元の DB と Mailpit）', async ({ request }) => {
      // FREQ-443-AC-03, FREQ-443-AC-04
      test.setTimeout(180_000);
      const email = uniqueEmail(`ship-cancel-${viewport.name}`);
      const setup = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(db, email, [
          { name: 'E2E取消のシャツ', quantity: 2, fulfillmentType: 'stock' },
          { name: 'E2E取消のコート', quantity: 1, fulfillmentType: 'backorder' },
        ]);
        const [shirt, coat] = order.orderItemIds;
        await recordCompletion(db, order.orderId, actorId, [{ orderItemId: coat, quantity: 1 }]);
        const first = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-CANCEL-1',
          lines: [{ orderItemId: shirt, quantity: 2 }],
        });
        return { actorId, orderId: order.orderId, shirt, coat, first };
      });

      // 全部を送っていた注文の2回目の発送を、メールが送られる前に取り消す。
      // 発送のメールの行は書いた時から取り出せるので、取消を別の接続でやると、その間にほかの spec の worker が行を取って、
      // 取りやめにできない（sending・sent になる）ことがある。発送と取消を同じ接続の1つの取引にまとめ、コミットまで行を見せない
      const { second, cancelled } = await withLocalDb(async (db) => {
        await db.query('begin');
        try {
          const shipment = await createFulfillment(db, setup.orderId, setup.actorId, {
            trackingNumber: 'E2E-CANCEL-2',
            carrier: 'sagawa',
            lines: [{ orderItemId: setup.coat, quantity: 1 }],
          });
          const result = await cancelFulfillment(db, setup.orderId, shipment.fulfillmentId, setup.actorId);
          await db.query('commit');
          return { second: shipment, cancelled: result };
        } catch (error) {
          await db.query('rollback');
          throw error;
        }
      });
      expect(second).toMatchObject({ number: 2, completesOrder: true, orderStatus: 'shipped' });
      expect(cancelled).toEqual({ outcome: 'cancelled', orderStatus: 'paid' });
      await withLocalDb(async (db) => {
        // 決済完了に戻り、全部を送った時の値は空になる。コートは発送準備中に戻る
        expect(await orderState(db, setup.orderId)).toMatchObject({
          status: 'paid',
          shipped_at: null,
          shipping_carrier: null,
          tracking_number: null,
        });
        expect((await lineCounts(db, setup.orderId))[setup.coat]).toMatchObject({ shipped: 0, readyUnshipped: 1 });
        // まだ送っていないその発送のメールは取りやめ
        const rows = await outboxRows(db, setup.orderId);
        expect(rows.find((row) => row.fulfillment_id === second.fulfillmentId)).toMatchObject({
          status: 'skipped',
          last_error_code: 'fulfillment_cancelled',
        });
      });
      // 2回目の取消は、何度押しても同じ結果
      expect(await withLocalDb((db) => cancelFulfillment(db, setup.orderId, second.fulfillmentId, setup.actorId))).toMatchObject({
        outcome: 'already_cancelled',
      });

      // 取り消していない1回目のメールだけが届く
      await runWorkerUntil(request, async () => (await sentShipped(setup.orderId)) >= 1, '取り消していない発送のメールが送信済みになること');
      const delivered = await mailsTo(request, email);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].Subject).toContain(SHIPPED_SUBJECT);

      // 送った後に取り消しても、お客様にメールは行かない（取消のメールの行も書かれない）
      const afterSent = await withLocalDb((db) => cancelFulfillment(db, setup.orderId, setup.first.fulfillmentId, setup.actorId));
      expect(afterSent.outcome).toBe('cancelled');
      await runWorkerOnce(request);
      expect(await mailsTo(request, email)).toHaveLength(1);
      await withLocalDb(async (db) => {
        expect(await outboxRows(db, setup.orderId, 'canceled')).toHaveLength(0);
        expect((await outboxRows(db, setup.orderId)).find((row) => row.fulfillment_id === setup.first.fulfillmentId)).toMatchObject({
          status: 'sent',
        });
        expect((await lineCounts(db, setup.orderId))[setup.shirt]).toMatchObject({ shipped: 0, readyUnshipped: 2 });

        // 取り消した分の番号は使い回さない。コートを送り直すと3回目になる（この発送のメールは確かめないので、知らせない発送にする）
        const reshipped = await createFulfillment(db, setup.orderId, setup.actorId, {
          trackingNumber: 'E2E-CANCEL-3',
          notify: false,
          lines: [{ orderItemId: setup.coat, quantity: 1 }],
        });
        expect(reshipped).toMatchObject({ number: 3, completesOrder: false });
      });
    });
  });
}
