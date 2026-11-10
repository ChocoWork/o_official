import type { DiscountDefinition, DiscountFacts } from '@/lib/discounts/discount-types';

/**
 * 値段の計画の型（FREQ-642。設計書 2・5章）。純関数の入出力だけで、サーバー専用の物を import しない。
 * DB（Task 4）はここで決めた計画の JSON をそのまま検証して記録する。
 *
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-021
 */
export type SlotState = 'kept' | 'returned_customer' | 'returned_shop';
export type ReturnSide = 'customer' | 'shop';
/** `${orderItemId}:${unitIndex}` */
export type SlotKey = `${string}:${number}`;

export interface UnitSlot {
  orderItemId: string;
  unitIndex: number;
  itemId: number;
  paidAmount: number;
  allocatedAmount: number;
  currentPrice: number;
  state: SlotState;
  holderOrderItemId: string;
  holderUnitIndex: number;
  shipped: boolean;
  returnedCustomerAt: string | null;
  claimedReturnLineId: string | null;
}

/** 注文の時に残す割引の写し。`facts` に `phase` は残らず、値段の計算が 'acceptance' を付ける。 */
export interface OrderDiscountSnapshot {
  engineVersion: number;
  definitions: DiscountDefinition[];
  codes: string[];
  facts: DiscountFacts;
  lines: { lineKey: string; orderItemId: string; itemId: number; unitPrice: number; quantity: number }[];
}

/** 前の注文から差し引いた額。heldOrderId の E から引き、laterOrderId の着の値段の直しを生んだ物 */
export interface UnitHold {
  heldOrderId: string;
  laterOrderId: string;
  itemId: number;
  amount: number;
  seq: number;
}

export interface OrderPricingState {
  orderId: string;
  placedAt: string;
  paidTotal: number;
  snapshot: OrderDiscountSnapshot;
  slots: UnitSlot[];
  entitlementPrevious: number;
  entitlementMax: number;
  feeTotal: number;
  holds: UnitHold[];
}

export interface UnitPricingMaterials {
  version: string;
  target: OrderPricingState;
  related: OrderPricingState[];
}

export interface UnitReturnInput {
  returnLineId: string | null;
  holderOrderItemId: string;
  quantity: number;
  side: ReturnSide;
  part: 'now' | 'consult';
  feePercent: number;
}

export type UnitEventChange =
  | { kind: 'return_receive'; returns: UnitReturnInput[]; excludedSlots: SlotKey[] }
  | { kind: 'pre_shipment_cancel'; cancels: { orderItemId: string; quantity: number }[] };

export interface UnitPlanLine {
  lineKind: 'returned' | 'kept' | 'hold';
  orderItemId: string;
  unitIndex: number;
  slotOrderId: string;
  holderOrderItemId: string;
  holderUnitIndex: number;
  stateBefore: SlotState;
  stateAfter: SlotState;
  priceBefore: number;
  priceAfter: number;
  allocation: number;
  correction: number;
  part: 'now' | 'consult' | null;
  returnLineId: string | null;
  shipped: boolean;
}

export interface UnitPricingPlan {
  version: string;
  orderId: string;
  kind: 'return_receive' | 'pre_shipment_cancel' | 'hold_release';
  entitlementPrevious: number;
  entitlementMaxBefore: number;
  entitlementGross: number;
  entitlementShopOnly: number;
  feeAmount: number;
  holdTotal: number;
  entitlement: number;
  standardRefund: number;
  nowRefund: number;
  consultRefund: number;
  lines: UnitPlanLine[];
  holds: Omit<UnitHold, 'seq'>[];
  releases: UnitPricingPlan[];
  /** returns のうち returnLineId のある物の side をそのまま並べる（受け取りで記録する。最後の行が今の扱い） */
  treatments: { returnLineId: string; treatment: ReturnSide }[];
}

export type UnitPricingErrorCode = 'unit_not_available' | 'snapshot_invalid';

export class UnitPricingError extends Error {
  constructor(readonly code: UnitPricingErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'UnitPricingError';
  }
}

export function slotKeyOf(orderItemId: string, unitIndex: number): SlotKey {
  return `${orderItemId}:${unitIndex}`;
}
