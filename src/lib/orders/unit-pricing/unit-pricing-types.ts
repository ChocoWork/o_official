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
  /** returned_customer の枠を返した返品の手数料の率（order_returns.restocking_fee_percent）。それ以外は null */
  returnedFeePercent: number | null;
  /** returned_customer の枠を返した出来事の seq。UnitHold.seq と同じ全体の出来事の数（order_unit_events.seq）で、注文をまたいで比べられる。それ以外は null */
  returnedEventSeq: number | null;
  /** returned_customer の枠を返した返品の行の id（手数料の累計を出来事の時と同じ順で出し直すため）。それ以外・返品の行が無い時は null */
  returnedReturnLineId: string | null;
  /**
   * FREQ-641 の取り押さえ（order_line_unit_amounts.return_line_id）の返品の行の id。返品の行の id だけで、返金の id は入れない。
   * 持ち主が自分の着でない枠（交換に出した枠）は、交換の取り押さえを使い切ったので null。
   */
  claimedReturnLineId: string | null;
  /**
   * この枠の着を握っている返金（order_line_unit_amounts.refund_id）の id。通常の返金などが握っている枠で、計画は選ばない。握られていなければ null。
   */
  claimedRefundId: string | null;
}

/** 注文の時に残す割引の写し。`facts` に `phase` は残らず、値段の計算が 'acceptance' を付ける。 */
export interface OrderDiscountSnapshot {
  engineVersion: number;
  definitions: DiscountDefinition[];
  codes: string[];
  facts: DiscountFacts;
  lines: { lineKey: string; orderItemId: string; itemId: number; unitPrice: number; quantity: number }[];
}

/** 前の注文から差し引いた額。heldOrderId の E から引き、laterOrderId の着の値段の直しを生んだ物。seq は書いた出来事の全体の出来事の数（UnitSlot.returnedEventSeq と同じ数え方） */
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
  /** 今すぐの品だけを同じ選択済みの枠で計算した率の手数料（表示用。nowRefund はすでに差し引いた額） */
  nowFeeAmount?: number;
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

/**
 * 見込みの窓口（受け取り・返金・お客様の申し込み）の答えの形（FREQ-642。設計書 6章）。画面からも読む。
 * 見込みと確定は同じ計画から出すので、店長が額を直さない時は確定の返金の額と同じになる。
 */
export interface ReturnReceiveEstimate {
  /** 注文の時の写しが無い注文（今の計算のまま。AC-20） */
  legacy: boolean;
  standardRefund: number;
  nowRefund: number;
  consultRefund: number;
  feeAmount: number;
  /** 今すぐ返金の内訳に出す率の手数料。nowRefund に含まれるため、再び引かない */
  nowFeeAmount?: number;
  /** 返送料・交換の手数料・交換の送料（最初の受け取りだけ。E の外） */
  fixedFees: number;
  /** 写しのある注文だけ: fixedFees の内訳（合計が fixedFees）。画面は 返送料・交換の手数料・交換の送料 の行をこれで出す */
  fixedFeeParts?: { returnShipping: number; exchangeFee: number; exchangeShipping: number };
  /** 写しのある注文だけ: お支払い待ちになる額（DB の v_due） */
  feeDue?: number;
  /** 写しのある注文だけ: 相談の分に回る手数料（DB の v_pending。受け取りの画面は出さない） */
  feePending?: number;
  /** 今すぐ返金する額の見込み（店長が額を変えない時の確定の額） */
  refundAmount: number;
  /** 店長が直せる額の上限 */
  refundCap: number;
  /** 写しのある注文だけ: この返品の相談の出来事がまだ返していない額。全部返金済みなら 0 */
  consultOutstanding?: number;
}

export interface OrderRefundEstimate {
  legacy: boolean;
  suggestedAmount: number;
  /** 商品の額（送料を除く標準の額。上限で切る前）。画面の内訳の「商品」の行 */
  itemsAmount: number;
  refundCap: number;
  /** 選んだ品が着の状態を変える（発送前の品を選んだ・注文の取り消し）か */
  changesUnits: boolean;
}

export interface CustomerReturnEstimate {
  refundAmount: number;
  /** 交換だけならお金が動かない */
  moneyMoves: boolean;
}

/**
 * 相談の返金（admin_refund_return）の計画。着の状態は変わらないので、版と、前の注文へ戻す計画（releases）だけを持つ。
 * 戻す物が無い時は計画ごと渡さない（null）。
 */
export interface ReleasesOnlyPricing {
  orderId: string;
  version: string;
  releases: UnitPricingPlan[];
}

/** DB の入口（_pricing）へ渡す物 */
export type UnitPricingArg = UnitPricingPlan | ReleasesOnlyPricing;
