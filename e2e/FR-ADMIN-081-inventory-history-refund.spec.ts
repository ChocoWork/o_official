/**
 * FR-ADMIN-081 在庫の履歴の返金の行と、返金による在庫の動き
 * 対応 FREQ: FREQ-453（AC-01〜AC-03）
 *
 * 商品の編集画面の在庫の履歴は窓口を差し替えて確かめる（FR-ADMIN-073 と同じやり方）。
 * 返金で在庫が動くこと（戻す・戻さない・失敗で確保し直す）は、手元の DB の関数を直に呼んで確かめる。
 * 戻す返金は FR-ADMIN-080 が本物の Stripe でも確かめる。
 */
import { expect, test, type Page } from '@playwright/test';
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

const VARIANT = {
  id: 11,
  colorName: 'BLACK',
  colorHex: '#000000',
  sizeLabel: 'M',
  sku: null,
  stockQuantity: 3,
  isActive: true,
  committedQuantity: 2,
  onHandQuantity: 5,
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
 * 新しい順。入荷 +5 → 販売 -3（注文）→ 戻した返金 +1（その後に失敗）→ 戻さない返金 +1 と 棚卸調整 -1
 * → 失敗で確保し直し -1 → 店の手の棚卸調整 +1
 */
const MOVEMENTS = [
  movement({ id: 14, delta: 1, reason: 'adjustment', balanceAfter: 3, actorEmail: 'admin@example.com' }),
  movement({ id: 13, delta: -1, reason: 'purchase', balanceAfter: 2, refundId: REFUND_FAILED, orderId: ORDER_ID }),
  movement({ id: 12, delta: -1, reason: 'adjustment', balanceAfter: 3, refundId: REFUND_KEPT, orderId: ORDER_ID }),
  movement({ id: 11, delta: 1, reason: 'refund', balanceAfter: 4, refundId: REFUND_KEPT, orderId: ORDER_ID }),
  movement({ id: 10, delta: 1, reason: 'refund', balanceAfter: 3, refundId: REFUND_FAILED, orderId: ORDER_ID }),
  movement({ id: 9, delta: -3, reason: 'purchase', balanceAfter: 2, orderId: ORDER_ID }),
  movement({ id: 8, delta: 5, reason: 'restock', balanceAfter: 5, actorEmail: 'admin@example.com' }),
];

/** 履歴の各行の理由の言葉（新しい順） */
const EXPECTED_REASONS = [
  '棚卸調整',
  '販売（返金の失敗で確保し直し）',
  '棚卸調整（返金で在庫に戻さない）',
  '返金',
  '返金',
  '販売',
  '入荷',
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
    fulfillJson(route, { variants: [VARIANT], movements: MOVEMENTS }));
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
      await expect(rows.nth(3)).toContainText('+1');
      await expect(rows.nth(2)).toContainText('-1');
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

        // 戻した返金がその後に失敗した: 外した分を確保し直す（販売 -1。この返金の番号つき）。すぐ出せる数は 1 → 0、引き当て済みは 1 → 2
        const failed = await recordRefundResult(db, restocked.refundId, {
          stripeRefundId: done.stripeRefundId,
          stripeStatus: 'failed',
          failureReason: 'declined',
        });
        expect(failed).toMatchObject({ status: 'failed', newlyFailed: true, rereserveShortage: 0 });
        expect(await movesOf(restocked.refundId)).toEqual([['purchase', -1], ['refund', 1]]);
        expect(await variantStockState(db, order.variantId)).toMatchObject({ stock: 0, committed: 2 });

        // 履歴が読む関数は、返金で動いた行に返金の番号を付けて返し、返金に結び付かない行には付けない
        const history = (
          await db.query('select reason, delta, refund_id from public.list_item_stock_history($1::bigint, 50)', [order.itemId])
        ).rows;
        const historyOf = (refundId: string | null) =>
          history
            .filter((row) => row.refund_id === refundId)
            .map((row) => [row.reason as string, Number(row.delta)])
            .sort();
        expect(historyOf(kept.refundId)).toEqual([['adjustment', -1], ['refund', 1]]);
        expect(historyOf(restocked.refundId)).toEqual([['purchase', -1], ['refund', 1]]);
        expect(historyOf(null)).toEqual([['purchase', -3], ['restock', 3]]);
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
