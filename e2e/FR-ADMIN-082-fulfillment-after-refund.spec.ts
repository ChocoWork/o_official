/**
 * FR-ADMIN-082 返金と発送・仕上がり
 * 対応 FREQ: FREQ-454（AC-01〜AC-04）
 *
 * 画面（一覧）は窓口を差し替えて確かめ、数や注文の状態が DB の関数で正しく動くことは、手元の DB の関数を直に呼んで
 * 確かめる（実装計画 P16。FR-ADMIN-068・072 と同じやり方）。
 *
 * G-1: 旧の発送の画面・発送の関数・発送の取消（画面と DB の関数）は停止した。G-3: それらに頼っていた3つのケース（AC-01 の1つと AC-02 の2つ）は
 * 発送票へ移した（ケースは削除）。
 * - 発送前に返金した商品は発送の画面に出ず、送らせない → FR-ADMIN-116 の ①（荷作り表に出ない。一部だけ返金した行は残りの数だけ出る。返金した分は窓口を直に呼んでも送らせない）
 * - 発送後に返金した数を下回る取消は断り、下回らない取消は通る → FR-ADMIN-117 の ⑤（2回に分けた発送のうち、最初の票は取り消せず次の票は取り消せる）
 * - 取消が断られると断りの文が取消のダイアログの中に出て、発送は残る → FR-ADMIN-117 の ⑤
 * ここには、返金で数と注文の状態が動くこと（実返金の投影・一覧の読み直し・受注生産の品の発送前返金が在庫の台帳を動かさないこと）が残る。
 * 発送の材料は合成の発送（createFulfillment）。
 */
import { expect, test } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import {
  beginRefund,
  createActor,
  createFulfillment,
  createOrderWithLines,
  lineCounts,
  orderState,
  recordRefundResult,
  stockLedger,
  uniqueEmail,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder, adminOrderDetail, detailSection,
  fulfillJson,
  mockAdminSession,
  mockOrderDetail,
  openOrderDetail,
  orderLine,
  viewports,
} from './order-fulfillment-test-utils';
import {
  REFUND_TEXT,
  acceptedRefund,
  formatYen,
  materialLineOf,
  mockRefundRoutes,
  newRefundRouteState,
  openDetailRefundDialog,
  quantityInput,
  refundMaterialsOf,
} from './refund-test-utils';

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-082 fulfillment after refund (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
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

    test('残りの商品を全部返金すると一覧を読み直して「配送中」になり、旧発送入口は表示しない', async ({ page }) => {
      // FREQ-454-AC-03
      // G-4: 返金の前後とも旧発送入口は出さず、発送欄から荷作り表を開ける
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
      await mockOrderDetail(page, () => adminOrderDetail(phase.refunded ? allShipped : partlyShipped));
      await mockRefundRoutes(page, orderId, state);
      await openOrderDetail(page, orderId);
      const row = detailSection(page, '注文情報');
      await expect(row.getByText('発送準備中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      // G-3: 旧い停止文は、発送票へ誘導する案内（荷作り表から行います）に置き換わった
      await expect(detailSection(page, '発送').getByRole('link', { name: '荷作り表を開く', exact: true })).toBeVisible();

      // 発送前のスカート1つ（残りの商品の全部）を返金する
      const dialog = await openDetailRefundDialog(page, orderId);
      await quantityInput(dialog, '発送前の商品', 'プリーツスカート（ホワイト / M）').fill('1');
      await dialog.getByRole('button', { name: `${formatYen(8_000)} を返金する`, exact: true }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: REFUND_TEXT.noticeSucceeded })).toBeVisible();
      await expect(row.getByText('配送中', { exact: true })).toBeVisible();
      await expect(row.getByText('一部発送済み', { exact: true })).toHaveCount(0);
      await expect(row.getByRole('button', { name: '発送済みにする' })).toHaveCount(0);
      await expect(detailSection(page, '発送').getByRole('link', { name: '荷作り表を開く', exact: true })).toBeVisible();
      await expect(detailSection(page, '支払いと返金').getByText('一部返金', { exact: true })).toBeVisible();
    });

    test('Aがない受注生産品の発送前返金は在庫台帳を動かさない（手元のDB）', async () => {
      // FREQ-454-AC-04
      // G-1: 手動の仕上がりの記録は終了した。数量2・F0・A0の受注生産品は、返金した数だけ「作らずに済む数」が減り、在庫の台帳と有効な A は動かない
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
        // 受注生産の品は在庫を確保していない（有効な A は 0）ので、返金しても在庫の台帳は動かない
        const allocated = await db.query(
          "select coalesce(sum(remaining_quantity), 0)::integer as n from public.order_item_allocations where order_item_id = $1 and kind = 'paid'",
          [coat],
        );
        expect(Number(allocated.rows[0].n)).toBe(0);
        expect(await stockLedger(db, order.orderId)).toEqual([]);
      });
    });
  });
}
