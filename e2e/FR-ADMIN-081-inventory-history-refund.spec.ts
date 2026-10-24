/**
 * FR-ADMIN-081 在庫の履歴の返金の行と、返金による在庫の動き
 * 対応 FREQ: FREQ-453（AC-01〜AC-03）
 *
 * 商品の編集画面の在庫の履歴は窓口を差し替えて確かめる（FR-ADMIN-073 と同じやり方）。
 * 返金で在庫が動くこと（戻す・戻さない・失敗で確保し直す）は、手元の DB の関数を直に呼んで確かめる。
 * 戻す返金は FR-ADMIN-080 が本物の Stripe でも確かめる。
 * G-1: 購入と、返金の失敗の確保し直しは、古い注文から順の自動割当（FIFO）が台帳に1行ずつ書く。履歴は台帳の番号の大きい順（新しい順）で、
 * 割当の出来事は別の配列（台帳に結び付く出来事は台帳の行の中に並び、重ねて1行にしない）。
 */
import { expect, test, type Page } from '@playwright/test';
import type { AllocationHistoryEvent } from '@/lib/inventory/allocation-types';
import { PRICE } from '../tests/integration/db/helpers/order-fixtures';
import {
  beginRefund,
  createActor,
  createOrderWithLines,
  recordRefundResult,
  stockLedger,
  uniqueEmail,
  variantStockState,
  withLocalDb,
} from './order-email-test-utils';
import { fulfillJson, mockAdminSession, viewports } from './order-fulfillment-test-utils';

const ITEM_ID = '7';
const ORDER_ID = 'a9b2c3d4-1111-2222-8333-444455556666';
const ORDER_NUMBER = 'ORD-A9B2C3D4';
const REFUND_KEPT = 'e9b2c3d4-0000-4000-8000-000000000001';
const REFUND_FAILED = 'e9b2c3d4-0000-4000-8000-000000000002';

/** 空き 1・入金済みの割当 2・手元 3。履歴の最後の状態（入荷 3 → 注文 3 → 返金 2 → 失敗の確保し直し 1 → 棚卸 +1）と同じ */
const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 1,
  isActive: true,
  committedQuantity: 2,
  onHandQuantity: 3,
  backorderQuantity: 0,
};

/** 履歴の1行。返金で動いた行だけ refundId を持つ */
function movement(input: {
  id: number;
  delta: number;
  reason: string;
  balanceAfter: number;
  refundId?: string;
  orderId?: string;
  actorEmail?: string;
}) {
  const orderId = input.orderId ?? null;
  return {
    id: input.id,
    variantId: 11,
    delta: input.delta,
    reason: input.reason,
    note: null,
    createdAt: `2026-10-12T05:00:${String(input.id).padStart(2, '0')}Z`,
    actorEmail: input.actorEmail ?? null,
    orderId,
    orderNumber: orderId ? ORDER_NUMBER : null,
    balanceAfter: input.balanceAfter,
    refundId: input.refundId ?? null,
  };
}

/**
 * 新しい順（台帳の番号の大きい順）。古い順に、入荷 +3 → 注文への確保 -3 → 戻さない返金の 返金 +1 と 棚卸調整 -1
 * → 戻す返金の 返金 +1（その後に失敗）→ 失敗で再割当 -1（古い注文へ自動で確保し直し）→ 店の手の棚卸調整 +1。
 * 変わった後の数は古い順に 3 / 0 / 1 / 0 / 1 / 0 / 1
 */
const MOVEMENTS = [
  movement({ id: 14, delta: 1, reason: 'adjustment', balanceAfter: 1, actorEmail: 'admin@example.com' }),
  movement({ id: 13, delta: -1, reason: 'purchase', balanceAfter: 0, refundId: REFUND_FAILED, orderId: ORDER_ID }),
  movement({ id: 12, delta: 1, reason: 'refund', balanceAfter: 1, refundId: REFUND_FAILED, orderId: ORDER_ID }),
  movement({ id: 11, delta: -1, reason: 'adjustment', balanceAfter: 0, refundId: REFUND_KEPT, orderId: ORDER_ID }),
  movement({ id: 10, delta: 1, reason: 'refund', balanceAfter: 1, refundId: REFUND_KEPT, orderId: ORDER_ID }),
  movement({ id: 9, delta: -3, reason: 'purchase', balanceAfter: 0, orderId: ORDER_ID }),
  movement({ id: 8, delta: 3, reason: 'restock', balanceAfter: 3, actorEmail: 'admin@example.com' }),
];

/** 履歴の各行の理由の言葉（新しい順） */
const EXPECTED_REASONS = [
  '棚卸調整',
  '注文への確保（返金の失敗で再割当）',
  '返金',
  '棚卸調整（返金で在庫に戻さない）',
  '返金',
  '注文への確保',
  '入荷',
];

/** 割当の出来事（台帳の行の番号に結び付く）。台帳の行の中に並び、別の1行には出ない */
function allocationEvent(input: {
  id: string;
  type: AllocationHistoryEvent['type'];
  quantity: number;
  stockMovementId: string | null;
  reason: string;
  createdAt: string;
}): AllocationHistoryEvent {
  return {
    id: input.id,
    allocationId: 'a9000000-0000-4000-8000-000000000001',
    orderId: ORDER_ID,
    orderItemId: 'c9000000-0000-4000-8000-000000000001',
    variantId: 11,
    type: input.type,
    quantity: input.quantity,
    operationId: `b9000000-0000-4000-8000-${input.id.slice(-12)}`,
    counterpartAllocationId: null,
    reversesEventId: null,
    stockMovementId: input.stockMovementId,
    reason: input.reason,
    actorId: null,
    createdAt: input.createdAt,
  };
}

/** 新しい順（作成時刻・出来事の番号の大きい順）。購入の行 9・失敗の再割当の行 13・返金の解放の行 10・12 に結び付く。最後の1つは台帳に結び付かない */
const ALLOCATION_EVENTS: AllocationHistoryEvent[] = [
  allocationEvent({ id: 'e9000000-0000-4000-8000-000000000004', type: 'allocate', quantity: 1, stockMovementId: '13', reason: 'fifo', createdAt: '2026-10-12T05:00:13Z' }),
  allocationEvent({ id: 'e9000000-0000-4000-8000-000000000003', type: 'release', quantity: 1, stockMovementId: '12', reason: 'refund_restock', createdAt: '2026-10-12T05:00:12Z' }),
  allocationEvent({ id: 'e9000000-0000-4000-8000-000000000002', type: 'release', quantity: 1, stockMovementId: '10', reason: 'refund_release', createdAt: '2026-10-12T05:00:10Z' }),
  allocationEvent({ id: 'e9000000-0000-4000-8000-000000000001', type: 'allocate', quantity: 3, stockMovementId: '9', reason: 'stripe_payment_paid', createdAt: '2026-10-12T05:00:09Z' }),
  allocationEvent({ id: 'e9000000-0000-4000-8000-000000000000', type: 'promote', quantity: 3, stockMovementId: null, reason: 'stripe_payment_paid', createdAt: '2026-10-12T05:00:08Z' }),
];

async function mockAdminApis(page: Page): Promise<void> {
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
    fulfillJson(route, { variants: [VARIANT], movements: MOVEMENTS, allocationEvents: ALLOCATION_EVENTS }));
}

for (const viewport of viewports) {
  test.describe(`FR-ADMIN-081 inventory history refund (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('履歴の理由の言葉は、返金の番号が付いた行だけ変わり、ふつうの棚卸調整・販売・入荷は今のまま。どの注文かも出る', async ({ page }) => {
      // FREQ-453-AC-03
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);

      const rows = page.getByTestId('stock-movement-row');
      await expect(rows).toHaveCount(MOVEMENTS.length);
      for (const [index, expected] of EXPECTED_REASONS.entries()) {
        await expect(rows.nth(index).getByTestId('stock-movement-reason'), `${index + 1}行目の理由`).toHaveText(expected);
      }
      // 返金で動いた行には、どの注文かが出る。店の手の調整・入荷には出ない
      for (const index of [1, 2, 3, 4, 5]) {
        await expect(rows.nth(index)).toContainText(ORDER_NUMBER);
      }
      await expect(rows.nth(0)).not.toContainText('ORD-');
      await expect(rows.nth(6)).not.toContainText('ORD-');
      await expect(rows.nth(2)).toContainText('+1');
      await expect(rows.nth(3)).toContainText('-1');
      // 割当の出来事: 台帳に結び付くものは台帳の行の中に並び、別の1行には出ない。台帳に結び付かないものだけ別の1行に出る
      await expect(rows.nth(1)).toContainText('注文への割当');
      await expect(rows.nth(2)).toContainText('割当の解放');
      await expect(rows.nth(4)).toContainText('割当の解放');
      await expect(rows.nth(5)).toContainText('注文への割当');
      for (const linked of ALLOCATION_EVENTS.filter((event) => event.stockMovementId !== null)) {
        await expect(page.getByTestId(`allocation-event-${linked.id}`), `台帳に結び付く出来事 ${linked.id} は別の行に出ない`).toHaveCount(0);
      }
      const unlinked = ALLOCATION_EVENTS.find((event) => event.stockMovementId === null);
      if (!unlinked) throw new Error('台帳に結び付かない出来事が必要');
      await expect(page.getByTestId(`allocation-event-${unlinked.id}`)).toHaveCount(1);
      // ダイアログではないので、動きは無い。目で見るための写し
      await page.screenshot({ path: `test-results/group-e2/item-stock-history-refund-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    });

    test('戻す返金はすぐ出せる数を増やして引き当て済みを減らし、戻さない返金は台帳に2行を書いて手元の数を減らし、失敗した返金は確保し直す（手元の DB）', async () => {
      // FREQ-453-AC-01, FREQ-453-AC-02, FREQ-453-AC-03
      await withLocalDb(async (db) => {
        const actorId = await createActor(db);
        const order = await createOrderWithLines(
          db,
          uniqueEmail(`stock-refund-${viewport.name}`),
          [{ name: 'E2Eシャツ', quantity: 3, fulfillmentType: 'stock' }],
          { paidAmount: 'total' },
        );
        const [shirt] = order.orderItemIds;
        const refundOneShirt = (restock: boolean) =>
          beginRefund(db, order.orderId, {
            actorId,
            lines: [{ orderItemId: shirt, quantity: 1, beforeShipment: true }],
            restock,
            amount: PRICE,
          });
        const movesOf = async (refundId: string) =>
          (await stockLedger(db, order.orderId))
            .filter((row) => row.refund_id === refundId)
            .map((row) => [row.reason, row.delta])
            .sort();

        // 最初: すぐ出せる数 0、引き当て済み 3（手元の数は 3）
        expect(await variantStockState(db, order.variantId)).toMatchObject({ stock: 0, committed: 3 });

        // 戻さない: 台帳に「返金 +1」と「棚卸調整 -1」の2行。すぐ出せる数は変わらず、引き当て済みと手元の数が減る（手元の数 3 → 2）
        const kept = await refundOneShirt(false);
        await recordRefundResult(db, kept.refundId);
        expect(await movesOf(kept.refundId)).toEqual([['adjustment', -1], ['refund', 1]]);
        expect(await variantStockState(db, order.variantId)).toMatchObject({ stock: 0, committed: 2 });

        // 戻す: 台帳に「返金 +1」の1行。すぐ出せる数が増え（0 → 1）、引き当て済みが減る（2 → 1）
        const restocked = await refundOneShirt(true);
        const done = await recordRefundResult(db, restocked.refundId);
        expect(await movesOf(restocked.refundId)).toEqual([['refund', 1]]);
        expect(await variantStockState(db, order.variantId)).toMatchObject({ stock: 1, committed: 1 });

        // 戻した返金がその後に失敗した: 外した分を古い注文へ自動で割り当て直す（G-1 の FIFO。台帳は注文への確保 -1。この返金の番号つき）。
        // すぐ出せる数は 1 → 0、引き当て済みは 1 → 2
        const failed = await recordRefundResult(db, restocked.refundId, {
          stripeRefundId: done.stripeRefundId,
          stripeStatus: 'failed',
          failureReason: 'declined',
        });
        expect(failed).toMatchObject({ status: 'failed', newlyFailed: true, rereserveShortage: 0 });
        expect(await movesOf(restocked.refundId)).toEqual([['purchase', -1], ['refund', 1]]);
        expect(await variantStockState(db, order.variantId)).toMatchObject({ stock: 0, committed: 2 });

        // 履歴が読む関数の返した配列を、並べ替えずにそのまま確かめる。台帳の番号の大きい順（新しい順）で、
        // 返金で動いた行には返金の番号が付き（原因の返金の番号は FIFO の再割当でも変わらない）、返金に結び付かない行には付かない
        const history = (
          await db.query('select movement_id, reason, delta, refund_id from public.list_item_stock_history($1::bigint, 50)', [order.itemId])
        ).rows;
        const movementIds = history.map((row) => BigInt(row.movement_id as string));
        expect(movementIds.every((id, index) => index === 0 || movementIds[index - 1] > id), '台帳の番号の降順').toBe(true);
        expect(history.map((row) => [row.reason as string, Number(row.delta)])).toEqual([
          ['purchase', -1], ['refund', 1], ['adjustment', -1], ['refund', 1], ['purchase', -3], ['restock', 3],
        ]);
        expect(history.map((row) => row.refund_id as string | null)).toEqual([
          restocked.refundId, restocked.refundId, kept.refundId, kept.refundId, null, null,
        ]);

        // 割当の出来事は別の配列で、作成時刻・出来事の番号の大きい順。台帳に結び付く出来事は台帳の番号を持つ（台帳の行を重ねて表示しない）
        const events = (
          await db.query(
            `select event_id, event_type, quantity, stock_movement_id, reason,
                    to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as created_text
               from public.list_item_allocation_history($1::bigint, 50)`,
            [order.itemId],
          )
        ).rows;
        const eventOrder = events.map((row) => `${row.created_text as string}|${row.event_id as string}`);
        expect(eventOrder, '出来事は作成時刻・出来事の番号の降順').toEqual([...eventOrder].sort().reverse());
        const ledgerIds = new Set(history.map((row) => String(row.movement_id)));
        const linkedEvents = events.filter((row) => row.stock_movement_id !== null);
        expect(linkedEvents.every((row) => ledgerIds.has(String(row.stock_movement_id)))).toBe(true);
        // 失敗の再割当の行（最新の購入 -1）には、古い順の自動割当（fifo）の出来事が1つ結び付く
        expect(
          events
            .filter((row) => String(row.stock_movement_id) === String(history[0].movement_id))
            .map((row) => [row.event_type as string, Number(row.quantity), row.reason as string]),
        ).toEqual([['allocate', 1, 'fifo']]);
      });
    });

    test('返金の行が並んだ在庫の履歴でも、横方向のページスクロールが発生しない', async ({ page }) => {
      await mockAdminApis(page);
      await page.goto(`/admin/item/edit/${ITEM_ID}`);
      await expect(page.getByTestId('stock-movement-row')).toHaveCount(MOVEMENTS.length);

      const hasHorizontalOverflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      expect(hasHorizontalOverflow).toBe(false);
    });
  });
}
