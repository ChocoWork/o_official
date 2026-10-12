/**
 * FR-ADMIN-093 返品の守り（発送の取消・ふつうの返金の数）と、履歴・在庫の履歴の返品の行
 * 対応 FREQ: FREQ-469（AC-08）、FREQ-471（AC-01〜AC-05）、FREQ-474（AC-01〜AC-04）
 *
 * 画面（履歴・発送の取消の断り・ふつうの返金の画面・在庫の履歴）は窓口の答えを差し替えて確かめ、守り（発送の取消の断り・ふつうの返金の数・
 * 届かない品の二重の返金）と在庫の履歴の返品の番号は、窓口が呼ぶのと同じ DB の関数を手元の DB に直に呼んで確かめる（実装計画 P11）。
 * 履歴の返品の行は、窓口が題（title）と細目（details）とした人（actorEmail）を組み立て済みの形（Task 8 の OrderHistoryReturnEntry。returnHistoryEntry）で
 * 差し替え、画面がそのまま出すことを確かめる。組み立て自体は単体の試験（order-history）が確かめる。
 */
import { expect, test, type Page } from '@playwright/test';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import type { OrderHistoryFulfillmentEntry, OrderHistoryRefundEntry } from '@/lib/orders/email/order-history';
import {
  beginRefund,
  cancelFulfillment,
  expectDbError,
  recordRefundResult,
  withLocalDb,
} from './order-email-test-utils';
import {
  adminOrder,
  fulfillJson,
  historyOf,
  mockAdminSession,
  mockOrderList,
  openOrderTab,
  orderNumberOf,
  viewports,
} from './order-fulfillment-test-utils';
import {
  materialLineOf,
  mockAdminSessionAs,
  mockRefundRoutes,
  newRefundRouteState,
  openRefundDialog,
  quantityInput,
  refundMaterialsOf,
} from './refund-test-utils';
import {
  RETURN_TEXT,
  addVariant,
  cancelReturnInDb,
  closeMissingInDb,
  createReturnInDb,
  createShippedOrder,
  formatYen,
  lineProgressOf,
  openHistoryDialog,
  receiveReturnInDb,
  reopenReturnInDb,
  returnEmailHistoryEntry,
  returnHistoryEntry,
  returnLabelOf,
  returnRefundRows,
} from './return-test-utils';

const ORDER_ID = 'a3b2c3d4-0093-4000-8000-000000000093';
const RETURN_ID = 'b3b2c3d4-0000-4000-8000-000000000001';
const SECOND_RETURN_ID = 'b3b2c3d4-0000-4000-8000-000000000002';
const LABEL = returnLabelOf(ORDER_ID, 1);
const SECOND_LABEL = returnLabelOf(ORDER_ID, 2);
const SHIRT = 'c3b2c3d4-0000-4000-8000-000000000001';
const ITEM_ID = '7';

/** 履歴の返品の行（新しい順に並べる前の材料）。題と細目は C-5 の言葉。窓口が組み立て済みで、画面はそのまま出す */
function returnEntries() {
  return [
    returnHistoryEntry({ kind: 'created', at: '2026-10-11T00:00:00.000Z', returnId: RETURN_ID, title: `返品を作った（${LABEL}）`, actorEmail: 'admin@example.com' }),
    returnHistoryEntry({
      kind: 'receive',
      at: '2026-10-11T01:00:00.000Z',
      returnId: RETURN_ID,
      title: `返品の受け取り（${LABEL}）`,
      details: ['在庫に戻す 2点', '戻さない 1点', 'お返し 1点', '検品待ち 1点'],
      actorEmail: 'admin@example.com',
    }),
    returnHistoryEntry({ kind: 'close_missing', at: '2026-10-11T02:00:00.000Z', returnId: RETURN_ID, title: `「届かない」として返品を終えた（${LABEL}・2点）`, actorEmail: 'admin@example.com' }),
    returnHistoryEntry({ kind: 'refund_waived', at: '2026-10-11T03:00:00.000Z', returnId: RETURN_ID, title: `返金しないで終えた（${LABEL}・1点）`, actorEmail: 'admin@example.com' }),
    // した人が分からない行（actorEmail が空）。画面は「操作:」を出さない
    returnHistoryEntry({ kind: 'inspect', at: '2026-10-11T04:00:00.000Z', returnId: RETURN_ID, title: `検品を終えた（${LABEL}）`, actorEmail: null }),
    returnHistoryEntry({ kind: 'cancel', at: '2026-10-11T05:00:00.000Z', returnId: SECOND_RETURN_ID, title: `返品を取り消した（${SECOND_LABEL}）`, actorEmail: 'support@example.com' }),
    returnHistoryEntry({ kind: 'reopen', at: '2026-10-11T06:00:00.000Z', returnId: RETURN_ID, title: `返品を開き直した（${LABEL}）`, actorEmail: 'admin@example.com' }),
    returnHistoryEntry({
      kind: 'exchange_added',
      at: '2026-10-11T07:00:00.000Z',
      returnId: null,
      title: '交換の品を足した（E2Eシャツ（ホワイト / L） × 1）',
      actorEmail: 'admin@example.com',
    }),
    // 色・サイズが空の品は「（色 / サイズ）」が付かず、{品名} × {n} になる
    returnHistoryEntry({
      kind: 'exchange_added',
      at: '2026-10-11T07:30:00.000Z',
      returnId: null,
      title: '交換の品を足した（E2Eベルト × 2）',
      actorEmail: 'admin@example.com',
    }),
    returnHistoryEntry({ kind: 'fee_received', at: '2026-10-11T08:00:00.000Z', returnId: RETURN_ID, title: `手数料の受け取りを記録した（${formatYen(800)}）`, actorEmail: 'admin@example.com' }),
    // 手数料をいただかないことにした行も kind は fee_received のまま（言葉は title が運ぶ）
    returnHistoryEntry({ kind: 'fee_received', at: '2026-10-11T08:30:00.000Z', returnId: SECOND_RETURN_ID, title: `手数料をいただかないことにした（${formatYen(800)}）`, actorEmail: 'admin@example.com' }),
    returnHistoryEntry({ kind: 'exchange_released', at: '2026-10-11T09:00:00.000Z', returnId: RETURN_ID, title: `支払いを待たずに送れるようにした（${LABEL}）`, actorEmail: 'admin@example.com' }),
  ];
}
/** 返品の返金の行（どこから: 返品（番号））。道 return と型は Task 8 が足した物で、欄が変わったら tsc が教える */
function returnRefundEntry(): OrderHistoryRefundEntry {
  return {
    type: 'refund',
    at: '2026-10-11T10:00:00.000Z',
    refundId: 'e3b2c3d4-0000-4000-8000-000000000001',
    source: 'return',
    sourceLabel: `返品（${LABEL}）`,
    actorEmail: 'admin@example.com',
    amount: 5_000,
    shippingAmount: 0,
    items: [{ name: 'E2Eシャツ（ホワイト / M）', quantity: 1, beforeShipment: false, restockedQuantity: 0 }],
    steps: [
      { status: 'awaiting_response', label: '返事待ち', at: '2026-10-11T10:00:00.000Z' },
      { status: 'succeeded', label: '成功', at: '2026-10-11T10:00:05.000Z' },
    ],
    failureReasonLabel: null,
    referenceNumber: null,
    customerActionExpiresAt: null,
    note: null,
    stripeReasonLabel: null,
    cancelReasonLabel: null,
  };
}

async function mockHistory(page: Page, entries: ReturnType<typeof returnEntries>): Promise<void> {
  await mockAdminSessionAs(page, 'admin');
  await mockOrderList(page, () => [
    adminOrder({ id: ORDER_ID, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
  ]);
  await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) =>
    fulfillJson(route, historyOf(ORDER_ID, [...entries, returnRefundEntry()].reverse())));
}

const MOVEMENT_ORDER = 'a3b2c3d4-0093-4000-8000-0000000000a1';
const MOVEMENT_RETURN_LABEL = returnLabelOf(MOVEMENT_ORDER, 1);

/**
 * 在庫の履歴の1行。返品で動いた行は returnId（返品の UUID）と returnNumber（{注文番号}-R{n}。窓口が返品の番号から作る）を持ち、
 * 画面は注文の欄に returnNumber ?? orderNumber を出す。UUID は画面に出さない（実装計画 Task 8・11）。
 */
function movement(input: {
  id: number;
  delta: number;
  reason: string;
  balanceAfter: number;
  returnId?: string;
  returnNumber?: string;
  orderId?: string;
}) {
  return {
    id: input.id,
    variantId: 11,
    delta: input.delta,
    reason: input.reason,
    note: null,
    createdAt: `2026-10-12T05:00:${String(input.id).padStart(2, '0')}Z`,
    actorEmail: null,
    orderId: input.orderId ?? null,
    orderNumber: input.orderId ? orderNumberOf(input.orderId) : null,
    balanceAfter: input.balanceAfter,
    refundId: null,
    returnId: input.returnId ?? null,
    returnNumber: input.returnNumber ?? null,
  };
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-093 return guards and history (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test('申し込み・受付中・完了の返品が指す発送は取り消せず、取消の返品しか指さない発送は取り消せる（手元の DB）', async () => {
      // FREQ-471-AC-01
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(
          db,
          `guard-ship-${viewport.name}`,
          [
            { name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' },
            { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
            { name: 'E2Eコート', quantity: 1, fulfillmentType: 'stock' },
          ],
          { separate: true },
        );
        const [shirt, skirt, coat] = fx.orderItemIds;
        const [first, second, third] = fx.fulfillmentIds;
        const create = (orderItemId: string, fulfillmentId: string) =>
          createReturnInDb(db, { ...fx, fulfillmentId }, { lines: [{ orderItemId, quantity: 1 }], notify: false });

        // 受付中の返品が指す発送
        await create(shirt, first);
        // 完了した返品（お返しで終えた）が指す発送
        const done = await create(skirt, second);
        await receiveReturnInDb(db, done.returnId, fx.actorId, {
          units: [{ lineId: done.lineIds[skirt], disposition: 'sent_back', quantity: 1 }],
          choice: 'none',
          notify: true,
          sentBack: { message: 'お返しします。' },
        });
        // 取り消した返品しか指さない発送
        const cancelled = await create(coat, third);
        await cancelReturnInDb(db, cancelled.returnId, fx.actorId);

        await expectDbError(cancelFulfillment(db, fx.orderId, first, fx.actorId), 'FULFILLMENT_HAS_RETURN');
        await expectDbError(cancelFulfillment(db, fx.orderId, second, fx.actorId), 'FULFILLMENT_HAS_RETURN');
        expect(await cancelFulfillment(db, fx.orderId, third, fx.actorId)).toEqual({ outcome: 'cancelled', orderStatus: 'paid' });
      });
    });

    test('履歴から発送の取消が断られると、「返品のある発送は取り消せません。」が確かめの画面の中に出て、発送の行は残る', async ({ page }) => {
      // FREQ-471-AC-02
      const fulfillmentId = 'f3b2c3d4-0000-4000-8000-000000000001';
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
        adminOrder({ id: ORDER_ID, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
      ]);
      await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) =>
        fulfillJson(route, historyOf(ORDER_ID, [shipment, { type: 'created', at: '2026-10-09T00:59:00.000Z' }])));
      await page.route(`**/api/admin/orders/${ORDER_ID}/fulfillments/${fulfillmentId}/cancel`, async (route) => {
        posts.push(route.request().url());
        await fulfillJson(route, { error: RETURN_TEXT.hasReturnRefusal, code: 'fulfillment_has_return' }, 409);
      });
      await openOrderTab(page);
      const dialog = await openHistoryDialog(page, ORDER_ID);
      const entry = dialog.getByRole('listitem').filter({ hasText: 'ヤマト運輸' });

      await entry.getByRole('button', { name: 'この発送を取り消す' }).click();
      await page.getByRole('button', { name: '取り消す', exact: true }).click();

      await expect(page.getByText(RETURN_TEXT.hasReturnRefusal)).toBeVisible();
      expect(posts).toHaveLength(1);
      await expect(page.getByText('発送（1回目）を取り消しました')).toHaveCount(0);
    });

    test('ふつうの返金で選べる発送済みの数は、返品中・返金待ち・交換にした品を除く。画面の材料の数も同じで、DB も REFUND_QUANTITY_EXCEEDS_SHIPPED で断り、受付中の返品を取り消すと返せるようになる（手元の DB）', async () => {
      // FREQ-471-AC-03, FREQ-471-AC-04
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `ordinary-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
        const refundOne = () =>
          beginRefund(db, fx.orderId, {
            actorId: fx.actorId,
            lines: [{ orderItemId: shirt, quantity: 1, beforeShipment: false }],
            restock: false,
            notifyCustomer: false,
            amount: PRICE,
          });

        // A: 受付中の返品（何も受け取っていない）1点
        const a = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        // B: 交換の品を受け取った1点
        const b = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          notify: false,
        });
        await receiveReturnInDb(db, b.returnId, fx.actorId, {
          units: [{ lineId: b.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
          notify: false,
        });
        // C: 相談で受け取って返金待ちになった1点
        const c = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        await receiveReturnInDb(db, c.returnId, fx.actorId, {
          units: [{ lineId: c.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
          notify: false,
        });

        // ふつうの返金の画面が読む材料（窓口と同じ DB の関数）の、発送済みで返せる数も、返品の数を除く
        const shippedRefundable = async (): Promise<number | undefined> => {
          const res = await db.query('select lines from public.load_order_refund_materials($1::uuid)', [fx.orderId]);
          const lines = res.rows[0].lines as Array<{ order_item_id: string; shipped_refundable: number }>;
          return lines.find((line) => line.order_item_id === shirt)?.shipped_refundable;
        };
        expect(await shippedRefundable()).toBe(0);

        // 3点とも返品の数に入っているので、ふつうの返金で返せる発送済みの数は 0
        await expectDbError(refundOne(), 'REFUND_QUANTITY_EXCEEDS_SHIPPED');
        expect(await returnRefundRows(db, fx.orderId)).toEqual([]);

        // 受付中の返品Aを取り消すと、その1点はふつうの返金で返せる
        await cancelReturnInDb(db, a.returnId, fx.actorId);
        expect(await shippedRefundable()).toBe(1);
        const refunded = await refundOne();
        expect(refunded).toMatchObject({ amount: PRICE, status: 'awaiting_response' });
      });
    });

    test('ふつうの返金の画面の発送済みの数の上限は、窓口が返した材料の数（返品中の品を除いた数）になり、それを超えて入れても収まる', async ({ page }) => {
      // FREQ-471-AC-04
      // 画面が材料の数で上限を決めることまで。材料の数が返品中の品を除いた数になること（窓口と同じ DB の関数）は、上の手元の DB の試験が確かめる
      // 3点とも発送済みだが、2点は返品に入っているので、返せるのは1点（shippedRefundable = 1）
      const state = newRefundRouteState(
        refundMaterialsOf({
          orderId: ORDER_ID,
          lines: [materialLineOf({ orderItemId: SHIRT, quantity: 3, shipped: 3, shippedRefundable: 1, itemPrice: 12_000 })],
        }),
      );
      await mockAdminSessionAs(page, 'admin');
      await mockOrderList(page, () => [
        adminOrder({ id: ORDER_ID, canShip: false, canRefund: true, paymentStatusKey: 'paid', refundedAmountLabel: '-', cancelKind: null }),
      ]);
      await mockRefundRoutes(page, ORDER_ID, state);
      await openOrderTab(page);
      const dialog = await openRefundDialog(page, ORDER_ID);
      const shipped = quantityInput(dialog, '発送済みの商品', 'シルクブラウス（ホワイト / M）');

      await expect(shipped).toHaveAttribute('max', '1');
      await shipped.fill('3');
      await expect(shipped).toHaveValue('1');
    });

    test('届かないで閉じた品をふつうの返金で返した後に、開き直して受け取っても、返金待ちにならず、返金の記録も増えない（手元の DB）', async () => {
      // FREQ-471-AC-05
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `missing-refund-${viewport.name}`, [
          { name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' },
          { name: 'E2Eスカート', quantity: 1, fulfillmentType: 'stock' },
        ]);
        const shirt = fx.orderItemIds[0];
        const created = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        const lineId = created.lineIds[shirt];

        // 品が届かないまま返品を終える。その品を、ふつうの返金で返す（Stripe が受け付ける）
        await closeMissingInDb(db, created.returnId, fx.actorId);
        const ordinary = await beginRefund(db, fx.orderId, {
          actorId: fx.actorId,
          lines: [{ orderItemId: shirt, quantity: 1, beforeShipment: false }],
          restock: false,
          notifyCustomer: false,
          amount: PRICE,
        });
        await recordRefundResult(db, ordinary.refundId);

        // 後から品が届いた。開き直して受け取っても、返金は済んでいるので、返金待ちにならず、新しい返金も作らない
        await reopenReturnInDb(db, created.returnId, fx.actorId);
        const received = await receiveReturnInDb(db, created.returnId, fx.actorId, {
          units: [{ lineId, disposition: 'restocked', quantity: 1 }],
          choice: 'now',
          notify: false,
        });
        expect(received.refundId).toBeNull();
        expect((await lineProgressOf(db, created.returnId))[lineId]).toMatchObject({ restocked: 1, refund_waiting: 0, unprocessed: 0 });
        expect(await returnRefundRows(db, fx.orderId)).toEqual([
          expect.objectContaining({ id: ordinary.refundId, source: 'admin', amount: PRICE }),
        ]);
      });
    });

    test('履歴に返品の行（作った・受け取り（細目つき）・届かない・返金しない・検品・取消・開き直し・交換の品・手数料・支払いを待たずに送る）が出て、返金の行のどこからは「返品（番号）」になる', async ({ page }) => {
      // FREQ-474-AC-01, FREQ-474-AC-02
      await mockHistory(page, returnEntries());
      await openOrderTab(page);
      const dialog = await openHistoryDialog(page, ORDER_ID);

      for (const { title } of returnEntries()) {
        await expect(dialog.getByText(title, { exact: true }), title).toBeVisible();
      }
      // 受け取りの細目は、1行に1つ。0点の物は出ない
      for (const detail of ['在庫に戻す 2点', '戻さない 1点', 'お返し 1点', '検品待ち 1点']) {
        await expect(dialog.getByText(detail, { exact: true }), detail).toBeVisible();
      }
      // 操作した人は「操作: {メール}」。作った・取消・手数料の受け取り・いただかないことにした・支払いを待たずに送る・交換の品を足した行にも、窓口が引いた人が入る
      const row = (text: string) => dialog.getByRole('listitem').filter({ hasText: text });
      await expect(row(`返品を作った（${LABEL}）`)).toContainText('操作: admin@example.com');
      await expect(row(`返品を取り消した（${SECOND_LABEL}）`)).toContainText('操作: support@example.com');
      await expect(row('交換の品を足した（E2Eシャツ（ホワイト / L） × 1）')).toContainText('操作: admin@example.com');
      await expect(row(`手数料の受け取りを記録した（${formatYen(800)}）`)).toContainText('操作: admin@example.com');
      await expect(row(`手数料をいただかないことにした（${formatYen(800)}）`)).toContainText('操作: admin@example.com');
      await expect(row(`支払いを待たずに送れるようにした（${LABEL}）`)).toContainText('操作: admin@example.com');
      // した人が分からない行（actorEmail が空）には「操作:」を出さない
      const inspected = row(`検品を終えた（${LABEL}）`);
      await expect(inspected).toHaveCount(1);
      await expect(inspected).not.toContainText('操作:');
      // 返品の返金の行のどこから
      await expect(dialog.getByText(`返品（${LABEL}）`, { exact: true })).toBeVisible();
    });

    test('履歴のメールの欄に返品のメールの種類の名前が出て、再送のボタンが無い。DB も返品のメールの再送を断る（手元の DB）', async ({ page }) => {
      // FREQ-469-AC-08
      // 名前（kindLabel）と再送の可否（resendable）は窓口の答えを差し替えた値で、画面がそれをそのまま描くことまでを確かめる。
      // 名前の表と再送できない決まりの組み立ては、単体の試験（order-history・order-email-types）が確かめる。
      // 窓口が再送を作らないことの根は DB なので、下で DB の関数が返品のメール4種類の再送を断ることを確かめる
      const mails = [
        returnEmailHistoryEntry({ kind: 'return_accepted', kindLabel: '返品の受付のお知らせ', at: '2026-10-11T00:01:00.000Z' }),
        returnEmailHistoryEntry({ kind: 'return_received', kindLabel: '返品の受け取りのお知らせ', at: '2026-10-11T01:01:00.000Z' }),
        returnEmailHistoryEntry({ kind: 'return_sent_back', kindLabel: '品物のお返しのお知らせ', at: '2026-10-11T02:01:00.000Z' }),
        returnEmailHistoryEntry({ kind: 'return_refund_pending_shop', kindLabel: '店への知らせ（返金待ち）', at: '2026-10-11T03:01:00.000Z' }),
      ];
      await mockAdminSessionAs(page, 'admin');
      await mockOrderList(page, () => [
        adminOrder({ id: ORDER_ID, status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', canShip: false }),
      ]);
      await page.route(`**/api/admin/orders/${ORDER_ID}/history`, (route) => fulfillJson(route, historyOf(ORDER_ID, mails)));
      await openOrderTab(page);
      const dialog = await openHistoryDialog(page, ORDER_ID);

      for (const name of ['返品の受付のお知らせ', '返品の受け取りのお知らせ', '品物のお返しのお知らせ', '店への知らせ（返金待ち）']) {
        await expect(dialog.getByText(`${name}のメール`, { exact: true }), name).toBeVisible();
      }
      await expect(dialog.getByRole('button', { name: 'お客様へ再送' })).toHaveCount(0);

      // DB の再送の関数は、返品のメール4種類をどの注文でも RESEND_NOT_ALLOWED で断る（履歴の再送のボタンが無いことの根）
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `resend-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 1, fulfillmentType: 'stock' }]);
        for (const kind of ['return_accepted', 'return_received', 'return_sent_back', 'return_refund_pending_shop']) {
          await expectDbError(
            db.query('select public.request_order_email_resend($1::uuid, $2::text, $3::uuid)', [fx.orderId, kind, fx.actorId]),
            'RESEND_NOT_ALLOWED',
          );
        }
      });
    });

    test('在庫の履歴の理由の言葉が、返品の受け取りは「返品の受け取り」、交換の品の確保は「交換の品の確保」になり、その行の注文の欄には返品の番号（{注文番号}-R{n}）が出る。返品の UUID は出さない', async ({ page }) => {
      // FREQ-474-AC-03
      const movements = [
        movement({ id: 12, delta: -1, reason: 'exchange', balanceAfter: 1, returnId: RETURN_ID, returnNumber: MOVEMENT_RETURN_LABEL, orderId: MOVEMENT_ORDER }),
        movement({ id: 11, delta: 2, reason: 'return', balanceAfter: 2, returnId: RETURN_ID, returnNumber: MOVEMENT_RETURN_LABEL, orderId: MOVEMENT_ORDER }),
        movement({ id: 10, delta: 1, reason: 'adjustment', balanceAfter: 0 }),
      ];
      await mockAdminSession(page);
      await page.route('**/api/admin/item-color-presets**', (route) => fulfillJson(route, { data: [] }));
      await page.route(`**/api/admin/items/${ITEM_ID}`, (route) =>
        fulfillJson(route, {
          data: {
            id: Number(ITEM_ID),
            name: 'リネンシャツ',
            description: '説明',
            price: 28000,
            category: 'TOPS',
            colors: [{ name: 'BLACK', hex: '#000000' }],
            sizes: ['M'],
            material: '',
            origin: '',
            care: '',
            product_note: '',
            status: 'published',
            image_url: null,
            image_urls: [],
          },
        }));
      await page.route(`**/api/admin/items/${ITEM_ID}/variants`, (route) =>
        fulfillJson(route, {
          variants: [
            { id: 11, colorName: 'BLACK', colorHex: '#000000', sizeLabel: 'M', sku: null, stockQuantity: 1, isActive: true, committedQuantity: 0, onHandQuantity: 1, backorderQuantity: 0 },
          ],
          movements,
        }));
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const rows = page.getByTestId('stock-movement-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).getByTestId('stock-movement-reason')).toHaveText('交換の品の確保');
      await expect(rows.nth(1).getByTestId('stock-movement-reason')).toHaveText('返品の受け取り');
      await expect(rows.nth(2).getByTestId('stock-movement-reason')).toHaveText('棚卸調整');
      // 注文の欄: 返品で動いた行は返品の番号（注文番号に -R{n}）、ふつうの行は注文の番号。注文に結び付かない行には欄が無い
      await expect(rows.nth(0).getByTestId('stock-movement-order')).toHaveText(MOVEMENT_RETURN_LABEL);
      await expect(rows.nth(1).getByTestId('stock-movement-order')).toHaveText(MOVEMENT_RETURN_LABEL);
      await expect(rows.nth(2).getByTestId('stock-movement-order')).toHaveCount(0);
      await expect(rows.nth(1)).not.toContainText(RETURN_ID);
    });

    test('在庫の履歴の関数は、返品の受け取りと交換の品の確保の行に返品の番号を付けて返し、返品に結び付かない行には付けない（手元の DB）', async () => {
      // FREQ-474-AC-04
      await withLocalDb(async (db) => {
        const fx = await createShippedOrder(db, `stock-history-${viewport.name}`, [{ name: 'E2Eシャツ', quantity: 2, fulfillmentType: 'stock' }]);
        const shirt = fx.orderItemIds[0];
        const variantL = await addVariant(db, fx.itemId, { color: 'ホワイト', size: 'L', stock: 2 });
        // A: 戻して相談で受け取る（在庫 +1）。B: 交換で受け取る（交換の色・サイズの在庫 −1）
        const a = await createReturnInDb(db, fx, { lines: [{ orderItemId: shirt, quantity: 1 }], notify: false });
        await receiveReturnInDb(db, a.returnId, fx.actorId, {
          units: [{ lineId: a.lineIds[shirt], disposition: 'restocked', quantity: 1 }],
          choice: 'consult',
          notify: false,
        });
        const b = await createReturnInDb(db, fx, {
          lines: [{ orderItemId: shirt, quantity: 1, exchange: { variantId: variantL, method: 'stock' } }],
          notify: false,
        });
        await receiveReturnInDb(db, b.returnId, fx.actorId, {
          units: [{ lineId: b.lineIds[shirt], disposition: 'not_restocked', quantity: 1 }],
          choice: 'none',
          notify: false,
        });

        const history = (
          await db.query('select reason, delta, return_id from public.list_item_stock_history($1::bigint, 50)', [fx.itemId])
        ).rows;
        const movesOf = (returnId: string | null) =>
          history
            .filter((row) => row.return_id === returnId)
            .map((row) => [row.reason as string, Number(row.delta)])
            .sort();
        expect(movesOf(a.returnId)).toEqual([['return', 1]]);
        expect(movesOf(b.returnId)).toEqual([['exchange', -1]]);
        // 返品に結び付かない行（入荷・販売）には返品の番号が付かない
        expect(movesOf(null)).toEqual([['purchase', -2], ['restock', 2], ['restock', 2]].sort());
      });
    });

    test('返品の行が並んだ履歴でも、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockHistory(page, returnEntries());
      await openOrderTab(page);
      await openHistoryDialog(page, ORDER_ID);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
