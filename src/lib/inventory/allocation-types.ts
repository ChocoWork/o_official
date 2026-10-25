export const ALLOCATION_EVENT_LABELS = {
  hold: '支払い前の仮確保',
  promote: '入金による割当への切替',
  allocate: '注文への割当',
  release: '割当の解放',
  consume: '発送による割当の消費',
  restore: '発送取消による割当の復元',
  transfer: '割当の入替',
} as const;

/**
 * 割当の履歴の理由の決まった値。DB の order_item_allocation_events_reason_check と同じ集合
 * （tests/unit/lib/inventory/allocation-event-reasons.test.ts が移行の文と突き合わせる）
 */
export const ALLOCATION_EVENT_REASON_CODES = [
  'fifo',
  'checkout',
  'stripe_payment_paid',
  'stock_adjustment',
  'refund_restock',
  'refund_release',
  'stripe_checkout_expired',
  'stripe_voucher_expired',
  'admin_cancel',
  'admin_cancel_failed_order',
  'resolve_payment_exception',
  'status_change',
  'fixture_allocation',
  'fixture_release',
  'fixture_shipment',
  'shipment_confirm',
  'shipment_cancel',
] as const;
export type AllocationEventReasonCode = (typeof ALLOCATION_EVENT_REASON_CODES)[number];

/** 割当の履歴の理由（DB の決まった値）。知らない値は「システム」と見せ、DB の文をそのまま出さない */
export const ALLOCATION_EVENT_REASON_LABELS: Readonly<Record<AllocationEventReasonCode, string>> = {
  fifo: '古い注文から順の自動割当',
  checkout: '注文の受付',
  stripe_payment_paid: '入金の確認',
  stock_adjustment: '在庫の調整による解除',
  refund_restock: '返金による在庫への戻し',
  refund_release: '返金による割当の解除',
  stripe_checkout_expired: '決済画面の期限切れ',
  stripe_voucher_expired: '支払い期限切れ',
  admin_cancel: '管理者による取消',
  admin_cancel_failed_order: '管理者による取消',
  resolve_payment_exception: '支払いの要対応の解決',
  status_change: '注文の状態の変更',
  fixture_allocation: '試験用の材料',
  fixture_release: '試験用の材料',
  fixture_shipment: '試験用の材料',
  shipment_confirm: '発送の確定',
  shipment_cancel: '発送の取消',
};

export function allocationEventReasonLabel(reason: string): string {
  return Object.prototype.hasOwnProperty.call(ALLOCATION_EVENT_REASON_LABELS, reason)
    ? ALLOCATION_EVENT_REASON_LABELS[reason as AllocationEventReasonCode]
    : 'システム';
}

export type AllocationHistoryEvent = {
  id: string;
  allocationId: string;
  orderId: string;
  orderItemId: string;
  variantId: number;
  type: keyof typeof ALLOCATION_EVENT_LABELS;
  quantity: number;
  operationId: string;
  counterpartAllocationId: string | null;
  reversesEventId: string | null;
  stockMovementId: string | null;
  reason: string | null;
  actorId: string | null;
  createdAt: string;
};

export type StockMovementInput = {
  itemId: number;
  variantId: number;
  delta: number;
  reason: 'restock' | 'adjustment';
  note: string | null;
  requestKey: string;
  expectedReleaseQuantity: number | null;
};
export type StockMovementResult = {
  movementId: string;
  releasedQuantity: number;
  allocatedQuantity: number;
  replayed: boolean;
};
export type VariantInventory = {
  variant_id: number;
  free: number;
  paid_allocated: number;
  payment_held: number;
  on_hand: number;
  waiting: number;
};
