import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';

/**
 * お客様の返品・交換の申し込みの画面の試験が共有する材料（窓口 GET /api/orders/[id]/return-request の答え `data` の形）。
 * 試験の名前は *.test.ts(x) だけなので、この道具のファイルは試験として流れない。
 */

export type Materials = CustomerReturnRequestMaterials;
export type Shipment = Materials['shipments'][number];
export type ShipmentLine = Shipment['lines'][number];
export type ReasonSetting = Materials['reasons'][number];

export const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
export const ORDER_NUMBER = 'ORD-A1B2C3D4';

const SELECTABLE_BASE = { lineKind: 'order', state: 'selectable', returnIneligible: false } as const;

/** 選べる数が2。同じ商品に、使える色・サイズが3つ（白 / M・白 / L・青 / M） */
export const BLOUSE: ShipmentLine = {
  ...SELECTABLE_BASE, orderItemId: 'item-blouse', itemId: 11, itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, selectable: 2,
};
/** 色が無い品。サイズだけが括弧に入る。使える色・サイズは1つ */
export const PANTS: ShipmentLine = {
  ...SELECTABLE_BASE, orderItemId: 'item-pants', itemId: 12, itemName: 'ウールパンツ', color: null, size: '2', quantity: 1, selectable: 1,
};
/** 返品不可の品。サイズが無い */
export const SCARF: ShipmentLine = {
  ...SELECTABLE_BASE, orderItemId: 'item-scarf', itemId: 13, itemName: 'シルクスカーフ', color: '黒', size: null, quantity: 1, selectable: 1,
  returnIneligible: true,
};
/** 交換にできる色・サイズが材料に無い品 */
export const BELT: ShipmentLine = {
  ...SELECTABLE_BASE, orderItemId: 'item-belt', itemId: 14, itemName: 'レザーベルト', color: '茶', size: null, quantity: 1, selectable: 1,
};
/** 返品の交換でお店が送った品の行（「交換の品」の印を付ける） */
export const EXCHANGE_BLOUSE: ShipmentLine = {
  ...SELECTABLE_BASE, orderItemId: 'item-exchange', itemId: 11, itemName: 'シルクブラウス', color: '白', size: 'L', quantity: 1, selectable: 1,
  lineKind: 'exchange',
};

const NOT_SELECTABLE_BASE = { lineKind: 'order', quantity: 1, selectable: 0, returnIneligible: false } as const;
export const COAT_PAST_DEADLINE: ShipmentLine = {
  ...NOT_SELECTABLE_BASE, orderItemId: 'item-coat', itemId: 21, itemName: 'ウールコート', color: '黒', size: 'L', state: 'past_deadline',
};
export const SHIRT_REQUESTED: ShipmentLine = {
  ...NOT_SELECTABLE_BASE, orderItemId: 'item-shirt', itemId: 22, itemName: 'リネンシャツ', color: '白', size: 'S', state: 'requested',
};
export const SKIRT_SENT_BACK: ShipmentLine = {
  ...NOT_SELECTABLE_BASE, orderItemId: 'item-skirt', itemId: 23, itemName: 'プリーツスカート', color: null, size: null, state: 'sent_back',
};
export const HAT_UNAVAILABLE: ShipmentLine = {
  ...NOT_SELECTABLE_BASE, orderItemId: 'item-hat', itemId: 24, itemName: 'ウールハット', color: '灰', size: 'F', state: 'unavailable',
};

/** 発送日は日本時間の日付で出す: 2026-10-10 10:30（日本時間） */
export const SHIPMENT_1: Shipment = {
  fulfillmentId: 'ful-1', number: 1, shippedAt: '2026-10-10T01:30:00.000Z', deadlineDate: '2026-10-20', pastDeadline: false,
  lines: [BLOUSE, PANTS, SCARF, BELT, EXCHANGE_BLOUSE],
};
/** 2026-10-01T16:00Z は日本時間の 10月2日 の 01:00。期限（10月11日）を過ぎた発送 */
export const SHIPMENT_2: Shipment = {
  fulfillmentId: 'ful-2', number: 2, shippedAt: '2026-10-01T16:00:00.000Z', deadlineDate: '2026-10-11', pastDeadline: true,
  lines: [COAT_PAST_DEADLINE, SHIRT_REQUESTED, SKIRT_SENT_BACK, HAT_UNAVAILABLE],
};

const NO_PHOTO = { photo: 'none', photoInstructions: '' } as const;

/** 窓口が出す理由（「不明」を除く9つ。決まった順） */
export const REASONS: ReasonSetting[] = [
  {
    reason: 'defective', resolutions: 'refund_and_exchange', outOfStockExchange: 'make', photo: 'required',
    photoInstructions: '破損している所が分かる写真を撮ってください。', shippingPayer: 'shop',
  },
  {
    reason: 'wrong_item', resolutions: 'refund_and_exchange', outOfStockExchange: 'make', photo: 'optional',
    photoInstructions: '', shippingPayer: 'shop',
  },
  { reason: 'size_too_small', resolutions: 'refund_and_exchange', outOfStockExchange: 'decline', ...NO_PHOTO, shippingPayer: 'customer' },
  { reason: 'size_too_large', resolutions: 'exchange_only', outOfStockExchange: 'decline', ...NO_PHOTO, shippingPayer: 'customer' },
  { reason: 'color', resolutions: 'refund_only', outOfStockExchange: 'decline', ...NO_PHOTO, shippingPayer: 'customer' },
  { reason: 'style', resolutions: 'refund_and_exchange', outOfStockExchange: 'decline', ...NO_PHOTO, shippingPayer: 'customer' },
  { reason: 'not_as_described', resolutions: 'refund_and_exchange', outOfStockExchange: 'decline', ...NO_PHOTO, shippingPayer: 'customer' },
  { reason: 'unwanted', resolutions: 'refund_only', outOfStockExchange: 'decline', ...NO_PHOTO, shippingPayer: 'customer' },
  {
    reason: 'other', resolutions: 'refund_and_exchange', outOfStockExchange: 'decline', photo: 'optional',
    photoInstructions: '', shippingPayer: 'customer',
  },
];

export const EXCHANGE_OPTIONS: Materials['exchangeOptions'] = [
  {
    itemId: 11,
    variants: [
      { variantId: 101, color: '白', size: 'M', stockQuantity: 5, madeToOrderLeadDays: null },
      { variantId: 102, color: '白', size: 'L', stockQuantity: 0, madeToOrderLeadDays: 14 },
      { variantId: 104, color: '青', size: 'M', stockQuantity: 1, madeToOrderLeadDays: 10 },
    ],
  },
  { itemId: 12, variants: [{ variantId: 201, color: null, size: '2', stockQuantity: 1, madeToOrderLeadDays: null }] },
];

export const NO_FEES: Materials['fees'] = {
  customerPaidMethod: 'customer_ships', shopLabelFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
};

export function materials(overrides: Partial<Materials> = {}): Materials {
  return {
    order: { id: ORDER_ID, status: 'shipped' },
    availability: { returns: 'available', endedOn: null },
    noticeText: '',
    shipments: [SHIPMENT_1, SHIPMENT_2],
    reasons: REASONS,
    exchangeOptions: EXCHANGE_OPTIONS,
    fees: NO_FEES,
    ...overrides,
  };
}

/** 窓口の成功の答え */
export function acceptedBody(number = 1) {
  return { data: { returnId: 'ret-1', number, label: `${ORDER_NUMBER}-R${number}`, replayed: false } };
}
