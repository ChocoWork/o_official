/**
 * FR-ADMIN-082 返金と発送・仕上がり
 * 対応 FREQ: FREQ-454（AC-01〜AC-04）
 *
 * 画面（発送の画面・履歴・一覧）は窓口を差し替えて確かめ、数や注文の状態が DB の関数で正しく動くことは、手元の DB の関数を直に呼んで
 * 確かめる（実装計画 P16。FR-ADMIN-068・072 と同じやり方）。発送の画面の材料は、DB の本物の数（返金を引いた未発送の数）から作る。
 */
import { expect, test } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import type { OrderHistoryFulfillmentEntry } from '@/lib/orders/email/order-history';
import {
  beginRefund,
  cancelFulfillment,
  createActor,
  createFulfillment,
  createOrderWithLines,
  expectDbError,
  lineCounts,
  orderState,
  recordCompletion,
  recordRefundResult,
  stockLedger,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  materialLine,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderLine,
  orderNumberOf,
  shipMaterials,
  viewports,
} from './order-fulfillment-test-utils';
import {
  REFUND_TEXT,
  acceptedRefund,
  formatYen,
  materialLineOf,
  mockRefundRoutes,
  newRefundRouteState,
  openRefundDialog,
  quantityInput,
  refundMaterialsOf,
} from './refund-test-utils';

const REFUNDED_CANCEL_REFUSAL = '返金した商品の発送は取り消せません。';

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-082 fulfillment after refund (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('発送前に返金した商品は発送の画面に出ず、発送の関数も送らせない。残りの商品は今までどおり送れる（DB の数から作った発送の画面と手元の DB）', async ({ page }) => {
      // FREQ-454-AC-01
      const setup = await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`refund-ship-${viewport.name}`),
          [
            { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
            { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
          ],
          { paidAmount: 'total' },
        );
        const [shirt, skirt] = order.orderItemIds;
        // シャツを2つとも発送前に返金する
        const began = await beginRefund(db, order.orderId, {
          actorId,
          lines: [{ orderItemId: shirt, quantity: 2, beforeShipment: true }],
          amount: PRICE * 2,
        });
        await recordRefundResult(db, began.refundId);

        const counts = await lineCounts(db, order.orderId);
        expect(counts[shirt]).toMatchObject({ quantity: 2, refundedBeforeShipment: 2, unshipped: 0, readyUnshipped: 0 });
        expect(counts[skirt]).toMatchObject({ refundedBeforeShipment: 0, unshipped: 1, readyUnshipped: 1 });
        // 返金した商品は送れない。残りは送れる
        await expectDbError(
          createFulfillment(db, order.orderId, actorId, {
            trackingNumber: 'E2E-REFUNDED-1',
            notify: false,
            lines: [{ orderItemId: shirt, quantity: 1 }],
          }),
          'QUANTITY_EXCEEDS_READY',
        );
        return { orderId: order.orderId, shirt, skirt, counts };
      });

      // 発送の画面の材料は、DB の本物の数から作る
      const line = (orderItemId: string, name: string, quantity: number) => {
        const counts = setup.counts[orderItemId];
        return materialLine({
          orderItemId,
          name,
          quantity,
          shipped: counts.shipped,
          inProduction: counts.inProduction,
          readyUnshipped: counts.readyUnshipped,
          unshipped: counts.unshipped,
        });
      };
      await mockAdminSession(page);
      await mockOrderList(page, () => [
        adminOrder({
          id: setup.orderId,
          items: [
            orderLine({ id: setup.shirt, name: 'E2Eシャツ', quantity: 2, readyUnshipped: 0 }),
            orderLine({ id: setup.skirt, name: 'E2Eスカート', quantity: 1, readyUnshipped: 1 }),
          ],
        }),
      ]);
      await page.route(`**/api/admin/orders/${setup.orderId}/fulfillments`, (route) =>
        fulfillJson(
          route,
          shipMaterials({
            orderId: setup.orderId,
            lines: [line(setup.shirt, 'E2Eシャツ', 2), line(setup.skirt, 'E2Eスカート', 1)],
          }),
        ));
      await openOrderTab(page);
      await page.getByRole('button', { name: '発送済みにする' }).click();
      const dialog = page.getByRole('dialog', { name: '発送済みにする' });

      await expect(dialog.getByLabel('今回送る数')).toHaveCount(1);
      await expect(dialog.getByText('E2Eスカート')).toBeVisible();
      await expect(dialog.getByText('E2Eシャツ')).toHaveCount(0);
    });

    test('発送の取消の関数は、発送後に返金した数を下回る取消を断り、下回らない取消は通る（手元の DB）', async () => {
      // FREQ-454-AC-02
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`refund-cancel-${viewport.name}`),
          [{ name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' }],
          { paidAmount: 'total' },
        );
        const [shirt] = order.orderItemIds;
        // 2回に分けて発送する: 1回目にシャツ2つ、2回目にシャツ1つ（お知らせは送らない）
        const first = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-AFTER-1',
          notify: false,
          lines: [{ orderItemId: shirt, quantity: 2 }],
        });
        const second = await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-AFTER-2',
          notify: false,
          lines: [{ orderItemId: shirt, quantity: 1 }],
        });
        expect(second).toMatchObject({ completesOrder: true, orderStatus: 'shipped' });

        // 発送後にシャツ2つを返金した（品物は戻らない）
        const began = await beginRefund(db, order.orderId, {
          actorId,
          lines: [{ orderItemId: shirt, quantity: 2, beforeShipment: false }],
          amount: PRICE * 2,
        });
        await recordRefundResult(db, began.refundId);
        expect((await lineCounts(db, order.orderId))[shirt]).toMatchObject({
          shipped: 3, refundedAfterShipment: 2, refundedBeforeShipment: 0, unshipped: 0,
        });

        // 1回目（2つ）を取り消すと、発送した数が 3 → 1 で、返金した数（2）を下回るので断る
        await expectDbError(cancelFulfillment(db, order.orderId, first.fulfillmentId, actorId), 'FULFILLMENT_REFUNDED');
        expect((await lineCounts(db, order.orderId))[shirt]).toMatchObject({ shipped: 3 });
        // 2回目（1つ）を取り消すと、発送した数は 3 → 2 で、返金した数（2）を下回らないので通る。未発送が戻るので支払い済みに戻る
        expect(await cancelFulfillment(db, order.orderId, second.fulfillmentId, actorId)).toEqual({
          outcome: 'cancelled',
          orderStatus: 'paid',
        });
        expect((await lineCounts(db, order.orderId))[shirt]).toMatchObject({ shipped: 2, refundedAfterShipment: 2, unshipped: 1 });
      });
    });

    test('履歴から発送の取消が断られると、断りの文が確かめの画面の中に出て、発送の行は残る', async ({ page }) => {
      // FREQ-454-AC-02
      const orderId = 'a2b2c3d4-1111-2222-8333-444455556666';
      const fulfillmentId = 'f2b2c3d4-0000-4000-8000-000000000001';
      const shipment = {
        type: 'fulfillment',
        at: '2026-10-10T03:00:00.000Z',
        fulfillmentId,
        number: 1,
        carrierLabel: 'ヤマト運輸',
        trackingNumber: '1234-5678-9012',
        items: [{ name: 'シルクブラウス', quantity: 2 }],
        actorEmail: 'admin@example.com',
        notifyCustomer: true,
        completesOrder: true,
        cancelled: false,
        cancellable: true,
        legacy: false,
      } satisfies OrderHistoryFulfillmentEntry;
      const posts: string[] = [];
      await mockAdminSession(page);
      await mockOrderList(page, () => [
        adminOrder({ id: orderId, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
      ]);
      await page.route(`**/api/admin/orders/${orderId}/history`, (route) =>
        fulfillJson(route, historyOf(orderId, [shipment, { type: 'created', at: '2026-10-09T00:59:00.000Z' }])));
      await page.route(`**/api/admin/orders/${orderId}/fulfillments/${fulfillmentId}/cancel`, async (route) => {
        posts.push(route.request().url());
        // 発送した 2 つのうち 1 つを返金済みなので、取り消せない（DB の FULFILLMENT_REFUNDED）
        await fulfillJson(route, { error: REFUNDED_CANCEL_REFUSAL, code: 'fulfillment_refunded' }, 409);
      });
      await openOrderTab(page);
      await page.getByRole('button', { name: `${orderNumberOf(orderId)} の履歴` }).click();
      const dialog = page.getByRole('dialog', { name: 'この注文の履歴' });
      const entry = dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' });

      await entry.getByRole('button', { name: 'この発送を取り消す' }).click();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();

      await expect(page.getByText(REFUNDED_CANCEL_REFUSAL)).toBeVisible();
      expect(posts).toHaveLength(1);
      await expect(page.getByText('発送（1回目）を取り消しました')).toHaveCount(0);
    });

    test('残りの未発送を全部返金した注文は発送済みになり、その返金が失敗すると支払い済みに戻って発送の値が空になる（手元の DB）', async () => {
      // FREQ-454-AC-03
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`refund-complete-${viewport.name}`),
          [
            { name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' },
            { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
          ],
          { paidAmount: 'total' },
        );
        const [shirt, skirt] = order.orderItemIds;
        await createFulfillment(db, order.orderId, actorId, {
          trackingNumber: 'E2E-SHIPPED-1',
          carrier: 'sagawa',
          notify: false,
          lines: [{ orderItemId: shirt, quantity: 2 }],
        });
        expect((await orderState(db, order.orderId)).status).toBe('paid');

        // スカートを発送前に返金する。受け付けた時点で未発送が 0 になり、発送した商品があるので「発送済み」になる
        const began = await beginRefund(db, order.orderId, {
          actorId,
          lines: [{ orderItemId: skirt, quantity: 1, beforeShipment: true }],
          amount: PRICE,
        });
        const accepted = await recordRefundResult(db, began.refundId);
        expect(accepted).toMatchObject({ status: 'succeeded', orderStatus: 'shipped' });
        const shipped = await orderState(db, order.orderId);
        // 発送の値は、取り消していない最後の発送のもの
        expect(shipped).toMatchObject({ status: 'shipped', shipping_carrier: 'sagawa', tracking_number: 'E2E-SHIPPED-1' });
        expect(shipped.shipped_at).not.toBeNull();

        // 返金が失敗した: スカートが未発送に戻り、注文は支払い済みに戻り、全部を送った時の値は空になる
        const failed = await recordRefundResult(db, began.refundId, {
          stripeRefundId: accepted.stripeRefundId,
          stripeStatus: 'failed',
          failureReason: 'declined',
        });
        expect(failed).toMatchObject({ status: 'failed', orderStatus: 'paid' });
        expect(await orderState(db, order.orderId)).toMatchObject({
          status: 'paid',
          shipped_at: null,
          shipping_carrier: null,
          tracking_number: null,
        });
        expect((await lineCounts(db, order.orderId))[skirt]).toMatchObject({ refundedBeforeShipment: 0, unshipped: 1 });
      });
    });

    test('一覧の「発送済みにする」が残っている注文で、残りの商品を全部返金すると、一覧を読み直して「配送中」になる', async ({ page }) => {
      // FREQ-454-AC-03
      const orderId = 'a2b2c3d4-2222-2222-8333-444455556666';
      const blouse = 'b2b2c3d4-0000-4000-8000-0000000000a1';
      const skirt = 'b2b2c3d4-0000-4000-8000-0000000000a2';
      const phase = { refunded: false };
      const partlyShipped = adminOrder({
        id: orderId,
        items: [
          orderLine({ id: blouse, name: 'シルクブラウス', quantity: 2, shipped: 2, readyUnshipped: 0 }),
          orderLine({ id: skirt, name: 'プリーツスカート', quantity: 1, readyUnshipped: 1 }),
        ],
        partiallyShipped: true,
        canShip: true,
        canRefund: true,
        paymentStatusKey: 'paid',
        refundedAmountLabel: '-',
        cancelKind: null,
      });
      const allShipped = adminOrder({
        id: orderId,
        items: [
          orderLine({ id: blouse, name: 'シルクブラウス', quantity: 2, shipped: 2, readyUnshipped: 0 }),
          orderLine({ id: skirt, name: 'プリーツスカート', quantity: 1, readyUnshipped: 0 }),
        ],
        status: '配送中',
        orderStatus: 'shipped',
        progressKey: 'in_transit',
        canShip: false,
        canRefund: true,
        paymentStatusKey: 'partially_refunded',
        refundedAmountLabel: formatYen(8_000),
        cancelKind: null,
      });
      const state = newRefundRouteState(
        refundMaterialsOf({
          orderId,
          lines: [
            materialLineOf({ orderItemId: blouse, quantity: 2, shipped: 2, itemPrice: 12_000 }),
            materialLineOf({ orderItemId: skirt, name: 'プリーツスカート', itemPrice: 8_000 }),
          ],
        }),
      );
      state.answerRefund = async (route, body) => {
        phase.refunded = true;
        await fulfillJson(route, acceptedRefund({ refundId: 'e2b2c3d4-0000-4000-8000-000000000001', status: 'succeeded', amount: body.amount }));
      };
      await mockAdminSession(page);
      await mockOrderList(page, () => [phase.refunded ? allShipped : partlyShipped]);
      await mockRefundRoutes(page, orderId, state);
      await openOrderTab(page);
      const row = page.getByRole('row', { name: new RegExp(orderId) });
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '発送済みにする' })).toBeVisible();

      // 発送前のスカート1つ（残りの商品の全部）を返金する
      const dialog = await openRefundDialog(page, orderId);
      await quantityInput(dialog, '発送前の商品', 'プリーツスカート（ホワイト / M）').fill('1');
      await dialog.getByRole('button', { name: `${formatYen(8_000)} を返金する`, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticeSucceeded })).toBeVisible();
      await expect(row.getByText('配送中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      await expect(row.getByText('一部返金', { exact: true })).toBeVisible();
    });

    test('受注生産の品の返金は、まだ作っていない数から先に減り、仕上がりの記録は減った後の数までになる。在庫の台帳は動かない（手元の DB）', async () => {
      // FREQ-454-AC-04
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`refund-made-${viewport.name}`),
          [{ name: 'E2Eコート', quantity: 2, fulfillmentType: 'backorder' }],
          { paidAmount: 'total' },
        );
        const [coat] = order.orderItemIds;
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ inProduction: 2, readyUnshipped: 0, unshipped: 2 });

        // コート1つを発送前に返金する。まだ作っていない数が 2 → 1 に減る（作らずに済む）
        const began = await beginRefund(db, order.orderId, {
          actorId,
          lines: [{ orderItemId: coat, quantity: 1, beforeShipment: true }],
          amount: PRICE,
        });
        await recordRefundResult(db, began.refundId);
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({
          refundedBeforeShipment: 1, inProduction: 1, readyUnshipped: 0, unshipped: 1,
        });
        // 受注生産の品は在庫を確保していないので、返金しても在庫の台帳は動かない
        expect(await stockLedger(db, order.orderId)).toEqual([]);

        // 仕上がりの記録は、まだ作っていない数（1）までにしか記録できない
        await expectDbError(
          recordCompletion(db, order.orderId, actorId, [{ orderItemId: coat, quantity: 2 }]),
          'QUANTITY_EXCEEDS_IN_PRODUCTION',
        );
        await recordCompletion(db, order.orderId, actorId, [{ orderItemId: coat, quantity: 1 }]);
        expect((await lineCounts(db, order.orderId))[coat]).toMatchObject({ inProduction: 0, readyUnshipped: 1, unshipped: 1 });
      });
    });
  });
}
