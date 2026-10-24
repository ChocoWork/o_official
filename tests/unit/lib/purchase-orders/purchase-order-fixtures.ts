// 発注書の読取（G-2 Task 5）の単体試験が共有する材料。DB の関数 get_admin_purchase_order の戻り（camelCase の jsonb）と同じ形。
import type { PurchaseOrderDetail, PurchaseOrderListRow } from '@/lib/purchase-orders/purchase-order-types';

export const ORDER_ID = '22222222-2222-4222-8222-222222222222';
export const LINE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
export const LINE_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
export const RECEIPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
export const RECEIPT_LINE_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
export const ATTACHMENT_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
export const RESERVATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
export const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SHA256 = 'a'.repeat(64);

/** 数量が確定し、一部を受け取った発注書（2行・単価は1行だけ・書類1件・保存途中の予約1件） */
export function confirmedDetail(): PurchaseOrderDetail {
  return {
    id: ORDER_ID,
    number: 'PO-20261025-0001',
    supplierName: '工場A',
    memo: '春の追加分',
    stage: 'quantity_confirmed',
    displayStage: 'partially_received',
    version: 2,
    orderedAt: '2026-10-25T14:30:00+00:00',
    createdBy: ACTOR_ID,
    lines: [
      {
        id: LINE_1, lineNo: 1, variantId: 11, itemName: 'シャツ', colorName: 'BLACK', sizeLabel: 'M', provisionalQuantity: 5,
        orderQuantity: 5, receivedQuantity: 2, outstandingQuantity: 3, unitPriceYen: 1200, version: 2,
      },
      {
        id: LINE_2, lineNo: 2, variantId: 12, itemName: 'パンツ', colorName: null, sizeLabel: null, provisionalQuantity: 4,
        orderQuantity: 3, receivedQuantity: 0, outstandingQuantity: 3, unitPriceYen: null, version: 2,
      },
    ],
    revisions: [
      {
        id: 'f0000000-0000-4000-8000-000000000001', lineId: null, revisionNo: 1, kind: 'order', beforeQuantity: null, afterQuantity: null,
        beforeUnitPriceYen: null, afterUnitPriceYen: null, beforeSupplierName: null, afterSupplierName: '工場A', beforeMemo: null,
        afterMemo: '春の追加分', reason: null, actorId: ACTOR_ID, createdAt: '2026-10-25T14:30:00+00:00',
      },
      {
        id: 'f0000000-0000-4000-8000-000000000002', lineId: LINE_1, revisionNo: 1, kind: 'order', beforeQuantity: null, afterQuantity: 5,
        beforeUnitPriceYen: null, afterUnitPriceYen: null, beforeSupplierName: null, afterSupplierName: null, beforeMemo: null,
        afterMemo: null, reason: null, actorId: ACTOR_ID, createdAt: '2026-10-25T14:30:00+00:00',
      },
      {
        id: 'f0000000-0000-4000-8000-000000000003', lineId: LINE_2, revisionNo: 2, kind: 'quantity', beforeQuantity: 4, afterQuantity: 3,
        beforeUnitPriceYen: null, afterUnitPriceYen: null, beforeSupplierName: null, afterSupplierName: null, beforeMemo: null,
        afterMemo: null, reason: '工場の都合', actorId: ACTOR_ID, createdAt: '2026-10-26T01:00:00+00:00',
      },
    ],
    shortClosures: [
      { id: 'f1000000-0000-4000-8000-000000000001', lineId: LINE_2, closedQuantity: 1, reason: '生産できない', actorId: ACTOR_ID, createdAt: '2026-10-26T01:00:00+00:00' },
    ],
    receipts: [
      {
        id: RECEIPT_ID, kind: 'receive', receivedOn: '2026-10-26', memo: '午前便', reason: null, actorId: ACTOR_ID, actorEmail: 'staff@example.com',
        createdAt: '2026-10-26T02:00:00+00:00',
        lines: [{ id: RECEIPT_LINE_ID, lineId: LINE_1, quantity: 2, reversesReceiptLineId: null, reversibleQuantity: 2 }],
      },
    ],
    attachments: [
      {
        id: ATTACHMENT_ID, kind: 'invoice', fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 2048, sha256: SHA256,
        sha256Source: 'browser', createdAt: '2026-10-26T03:00:00+00:00',
        current: {
          revisionNo: 1, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY', counterparty: '工場A', voided: false,
          reason: null, replacesAttachmentId: null,
        },
        revisionCount: 1,
      },
    ],
    pendingUploads: [
      { reservationId: RESERVATION_ID, kind: 'quote', fileName: 'quote.pdf', createdAt: '2026-10-25T15:00:00+00:00', expiresAt: '2026-10-25T16:00:00+00:00', expired: true, replacesAttachmentId: null },
    ],
    flags: { unitPriceMissing: true, documentMissing: false },
    estimatedAmountYen: 6000,
  };
}

/** 発注を確定した直後の発注書（数量は仮。確定数量・未納・単価は無い） */
export function orderedDetail(): PurchaseOrderDetail {
  const base = confirmedDetail();
  return {
    ...base,
    stage: 'ordered',
    displayStage: 'ordered',
    version: 1,
    lines: base.lines.map((line) => ({
      ...line, orderQuantity: null, receivedQuantity: 0, outstandingQuantity: null, unitPriceYen: null, version: 1,
    })),
    revisions: base.revisions.slice(0, 2),
    shortClosures: [],
    receipts: [],
    attachments: [],
    pendingUploads: [],
    flags: { unitPriceMissing: false, documentMissing: false },
    estimatedAmountYen: null,
  };
}

/** 発注一覧表の1行（DB の戻りを camelCase にした物） */
export function listRow(overrides: Partial<PurchaseOrderListRow> = {}): PurchaseOrderListRow {
  return {
    purchaseOrderId: ORDER_ID,
    number: 'PO-20261025-0001',
    displayStage: 'partially_received',
    lineId: LINE_1,
    lineNo: 1,
    itemName: 'シャツ',
    colorName: 'BLACK',
    sizeLabel: 'M',
    provisionalQuantity: 5,
    orderQuantity: 5,
    receivedQuantity: 2,
    outstandingQuantity: 3,
    ...overrides,
  };
}

/** DB の関数 list_admin_purchase_order_lines の1行（snake_case。total を持つ） */
export function dbListRow(total: number, row: PurchaseOrderListRow = listRow()) {
  return {
    total,
    purchase_order_id: row.purchaseOrderId,
    number: row.number,
    display_stage: row.displayStage,
    line_id: row.lineId,
    line_no: row.lineNo,
    item_name: row.itemName,
    color_name: row.colorName,
    size_label: row.sizeLabel,
    provisional_quantity: row.provisionalQuantity,
    order_quantity: row.orderQuantity,
    received_quantity: row.receivedQuantity,
    outstanding_quantity: row.outstandingQuantity,
  };
}
