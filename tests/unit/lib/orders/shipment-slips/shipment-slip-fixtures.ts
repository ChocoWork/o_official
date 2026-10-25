// 発送票の読取（G-3 Task 3）の単体試験が共有する材料。DB の関数の戻り（snake_case の行・camelCase の jsonb）と、store が返す camelCase の形。
import type {
  PackingRow,
  ShipmentSlipDetail,
  ShipmentSlipListRow,
} from '@/lib/orders/shipment-slips/shipment-slip-types';

export const ORDER_ID = '11111111-1111-4111-8111-111111111111';
export const ORDER_ID_2 = '11111111-1111-4111-8111-111111111112';
export const ITEM_ID = '22222222-2222-4222-8222-222222222221';
export const ITEM_ID_2 = '22222222-2222-4222-8222-222222222222';
export const SLIP_ID = '33333333-3333-4333-8333-333333333331';
export const SLIP_ID_2 = '33333333-3333-4333-8333-333333333332';
export const FULFILLMENT_ID = '44444444-4444-4444-8444-444444444441';
export const FULFILLMENT_ID_2 = '44444444-4444-4444-8444-444444444442';

/** 荷作り表の1行（store が返す形）。選べる行 */
export function packingRow(overrides: Partial<PackingRow> = {}): PackingRow {
  return {
    orderId: ORDER_ID,
    orderItemId: ITEM_ID,
    orderCreatedAt: '2026-10-20T01:00:00+00:00',
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    itemName: 'シルクブラウス',
    color: '白',
    size: 'M',
    readyQuantity: 3,
    shippableQuantity: 3,
    unitPrice: 12800,
    isExchange: false,
    blockedReasons: [],
    otherSlipNumbers: [],
    selectedQuantity: null,
    bundleOk: true,
    bundleKey: 'a'.repeat(32),
    ...overrides,
  };
}

/** DB の関数 list_admin_packing の1行（snake_case）。packingRow と同じ内容 */
export function dbPackingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: ORDER_ID,
    order_item_id: ITEM_ID,
    order_created_at: '2026-10-20T01:00:00+00:00',
    customer_name: '山田 花子',
    customer_email: 'hanako@example.com',
    item_name: 'シルクブラウス',
    color: '白',
    size: 'M',
    ready_quantity: 3,
    shippable_quantity: 3,
    unit_price: 12800,
    is_exchange: false,
    blocked_reasons: [],
    other_slip_numbers: [],
    selected_quantity: null,
    bundle_ok: true,
    bundle_key: 'a'.repeat(32),
    total_count: 1,
    ...overrides,
  };
}

/** 票の一覧の1行（store が返す形）。確定済みで伝票番号つき */
export function slipListRow(overrides: Partial<ShipmentSlipListRow> = {}): ShipmentSlipListRow {
  return {
    id: SLIP_ID,
    number: 'SL-20261025-0001',
    stage: 'confirmed',
    version: 2,
    expired: false,
    shipmentDate: '2026-10-25',
    shippingCarrier: 'yamato',
    trackingNumber: '1234-5678',
    orderCount: 2,
    itemQuantity: 5,
    updatedAt: '2026-10-25T03:00:00+00:00',
    ...overrides,
  };
}

/** DB の関数 list_admin_shipment_slips の1行（snake_case）。slipListRow と同じ内容 */
export function dbSlipListRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SLIP_ID,
    number: 'SL-20261025-0001',
    stage: 'confirmed',
    version: 2,
    expired: false,
    shipment_date: '2026-10-25',
    shipping_carrier: 'yamato',
    tracking_number: '1234-5678',
    order_count: 2,
    item_quantity: 5,
    updated_at: '2026-10-25T03:00:00+00:00',
    total_count: 1,
    ...overrides,
  };
}

const SHIP_TO = {
  fullName: '山田 花子', postalCode: '150-0001', prefecture: '東京都', city: '渋谷区', address: '神南1-1-1', building: null, phone: '03-0000-0000',
};

/** 下書きの詳細（get_admin_shipment_slip の戻りと同じ形）。問題が1つある */
export function draftDetail(overrides: Partial<ShipmentSlipDetail> = {}): ShipmentSlipDetail {
  return {
    id: SLIP_ID,
    number: 'SL-20261025-0001',
    stage: 'draft',
    version: 1,
    expired: false,
    customerKind: 'member',
    shipTo: SHIP_TO,
    carrier: null,
    trackingNumber: null,
    notifyCustomer: null,
    shipmentDate: null,
    trackingVersion: 1,
    confirmedAt: null,
    cancelledAt: null,
    expiresAt: '2026-11-01T03:00:00+00:00',
    updatedAt: '2026-10-25T03:00:00+00:00',
    lines: [{
      orderId: ORDER_ID, orderItemId: ITEM_ID, itemName: 'シルクブラウス', color: '白', size: 'M',
      quantity: 2, readyQuantity: 3, unitPrice: 12800, isExchange: false,
    }],
    issues: [{ code: 'quantity_exceeds_ready', orderItemId: ITEM_ID }],
    cancelBlockers: [],
    orders: [],
    versions: [],
    dateHistory: [],
    registration: { enabled: false, state: null, everRegistered: null, leaderOrderId: null },
    ...overrides,
  };
}

/** 確定済みの詳細（伝票番号つき・追跡がオンで登録済み・取消を止める理由が1つ） */
export function confirmedDetail(overrides: Partial<ShipmentSlipDetail> = {}): ShipmentSlipDetail {
  return draftDetail({
    stage: 'confirmed',
    version: 2,
    carrier: 'yamato',
    trackingNumber: '1234-5678',
    notifyCustomer: true,
    shipmentDate: '2026-10-25',
    confirmedAt: '2026-10-25T04:00:00+00:00',
    expiresAt: null,
    issues: [],
    cancelBlockers: [{ orderId: ORDER_ID, reason: 'has_return' }],
    orders: [{
      orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, fulfillmentNumber: 1, deliveryStatus: 'in_transit',
      deliveredAt: null, cancelledAt: null,
    }],
    versions: [{
      version: 1, kind: 'confirm', carrier: 'yamato', trackingNumber: '1234-5678', trackingVersion: 1,
      shipmentDate: '2026-10-25', reason: null, actorEmail: 'admin@example.com', createdAt: '2026-10-25T04:00:00+00:00',
    }],
    dateHistory: [{
      version: 1, kind: 'initial', previousDate: '2026-10-25', newDate: '2026-10-25', reason: null,
      actorEmail: 'admin@example.com', createdAt: '2026-10-25T04:00:00+00:00',
    }],
    registration: { enabled: true, state: 'registered', everRegistered: true, leaderOrderId: ORDER_ID },
    ...overrides,
  });
}
