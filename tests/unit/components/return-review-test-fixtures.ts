import type { OrderReturnDetail, OrderReturnLineDetail, ReturnCreateMaterials } from '@/lib/orders/returns/return-types';

/**
 * 申し込みを確かめる画面・返品の画面・返品を作る画面・受け取りの画面の試験が共有する道具（グループ E-3 段2）。
 * 呼ぶたびに新しい物を返すので、試験ごとに上書きしてよい
 */

export const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
export const RETURN_ID = 'ret-0001';
export const LABEL = 'ORD-A1B2C3D4-R1';
export const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
export const MATERIALS_URL = `/api/admin/orders/${ORDER_ID}/returns/materials`;
export const PHOTOS_URL = `/api/admin/returns/${RETURN_ID}/photos`;
export const APPROVE_URL = `/api/admin/returns/${RETURN_ID}/approve`;
export const DECLINE_URL = `/api/admin/returns/${RETURN_ID}/decline`;
/** 申し込みの日時。日本時間では 2026年10月13日 14:05 */
export const REQUESTED_AT = '2026-10-13T05:05:00.000Z';

export function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/**
 * 画面が日時に出す書き方（管理画面の他の画面と同じ）。試験の期待も同じ書き方で作る。
 * 画面の文字は Testing Library が空白を1つにそろえて比べるので、期待の側も同じにそろえる（ICU が特殊な空白を入れても外れない）
 */
export function jstText(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value))
    .replace(/\s+/g, ' ');
}

/** 返品の行。2点で、お客様のご希望は返金。まだ何も受け取っていない。返金の額の列は 1点 12,000 円 */
export function returnLine(overrides: Partial<OrderReturnLineDetail> = {}): OrderReturnLineDetail {
  return {
    id: 'line-blouse',
    fulfillmentId: 'ful-1',
    fulfillmentNumber: 1,
    orderItemId: 'item-blouse',
    itemName: 'シルクブラウス',
    color: '白',
    size: 'M',
    quantity: 2,
    reason: 'defective',
    reasonNote: null,
    resolution: 'refund',
    exchange: null,
    progress: {
      restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
      processed: 0, unprocessed: 2, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
    },
    refundAmountsByCount: [12000, 24000],
    refundWaitingAmount: 0,
    customerNote: '袖のほつれがあります。',
    requestedResolution: 'refund',
    requestedExchange: null,
    photos: [],
    returnIneligible: false,
    ...overrides,
  };
}

/** 返品。既定は、お客様が申し込んだばかり（`requested`）。返送は「お客様が送る」で、返送料はお店の負担、手数料は 0 */
export function returnDetail(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
  return {
    id: RETURN_ID,
    number: 1,
    label: LABEL,
    status: 'requested',
    source: 'customer_request',
    displayStatus: 'requested',
    marks: [],
    returnMethod: 'customer_ships',
    returnShippingPayer: 'shop',
    returnCarrier: null,
    returnTrackingNumber: null,
    fees: {
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
      feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
    },
    firstReceiptDone: false,
    firstExchangeReceiptDone: false,
    shopNote: null,
    notifyCustomer: true,
    createdAt: REQUESTED_AT,
    createdByEmail: null,
    closedAt: null,
    cancelledAt: null,
    requestedAt: REQUESTED_AT,
    approvedAt: null,
    approvedByEmail: null,
    declinedAt: null,
    declineReason: null,
    declineMessage: null,
    lines: [returnLine()],
    refunds: [],
    receipts: [],
    exchangeItems: [],
    ...overrides,
  };
}

const REASON_PAYERS: ReturnCreateMaterials['settings']['reasonShippingPayers'] = {
  defective: 'shop', wrong_item: 'shop', size_too_small: 'customer', size_too_large: 'customer', color: 'customer',
  style: 'customer', not_as_described: 'customer', unwanted: 'customer', other: 'customer', unknown: 'customer',
};
const REASON_OUT_OF_STOCK: ReturnCreateMaterials['settings']['reasonOutOfStockExchange'] = {
  defective: 'make', wrong_item: 'make', size_too_small: 'decline', size_too_large: 'decline', color: 'decline',
  style: 'decline', not_as_described: 'decline', unwanted: 'decline', other: 'decline', unknown: 'decline',
};

/**
 * 返品を作る画面の材料（`GET …/returns/materials`）。発送は1回で、シルクブラウス（白 / M）を2点。
 * その商品の色・サイズは、白 / M（在庫5）・白 / L（在庫0・作る目安14日）・黒 / M（使えない）・青 / M（在庫1・作る目安10日）。
 * 設定は、返送先あり・返送不要なし・手数料なし。settings の一部だけ上書きできる
 */
export function reviewMaterials(settings: Partial<ReturnCreateMaterials['settings']> = {}): ReturnCreateMaterials {
  return {
    order: { id: ORDER_ID, status: 'shipped', hasAwaitingRefund: false },
    shipments: [
      {
        fulfillmentId: 'ful-1',
        number: 1,
        shippedAt: '2026-10-10T01:30:00.000Z',
        deadlineDate: '2026-10-20',
        pastDeadline: false,
        lines: [
          {
            orderItemId: 'item-blouse', itemId: 11, variantId: 101, itemName: 'シルクブラウス', color: '白', size: 'M',
            lineKind: 'order', quantity: 2, returnable: 0, returnIneligible: false,
          },
        ],
      },
    ],
    exchangeOptions: [
      {
        itemId: 11,
        variants: [
          { variantId: 101, color: '白', size: 'M', isActive: true, stockQuantity: 5, madeToOrderLeadDays: null },
          { variantId: 102, color: '白', size: 'L', isActive: true, stockQuantity: 0, madeToOrderLeadDays: 14 },
          { variantId: 103, color: '黒', size: 'M', isActive: false, stockQuantity: 9, madeToOrderLeadDays: null },
          { variantId: 104, color: '青', size: 'M', isActive: true, stockQuantity: 1, madeToOrderLeadDays: 10 },
        ],
      },
    ],
    settings: {
      returnAddressSet: true,
      noReturnNeededEnabled: false,
      customerPaidMethod: 'customer_ships',
      shopLabelFee: 0,
      restockingFeeEnabled: false,
      restockingFeePercent: 0,
      exchangeFeesEnabled: false,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      reasonShippingPayers: REASON_PAYERS,
      reasonOutOfStockExchange: REASON_OUT_OF_STOCK,
      ...settings,
    },
  };
}
