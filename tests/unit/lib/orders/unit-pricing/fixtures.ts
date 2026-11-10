import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import {
  validateDiscountInput, type DiscountDefinition, type DiscountFacts, type DiscountLine,
} from '@/lib/discounts/discount-types';
import type {
  OrderPricingState, ReturnSide, SlotKey, UnitEventChange, UnitHold, UnitPricingMaterials, UnitPricingPlan,
  UnitReturnInput, UnitSlot,
} from '@/lib/orders/unit-pricing/unit-pricing-types';
import { amount, definition, usage } from '../../discounts/fixtures';

/** 設計書 3章の注文を、本物の割引の計算（注文を受け付けた時の計算）で組み立てる道具 */

export const JACKET = 1;
export const PANTS = 2;
export const VERSION = 'v1';

export interface OrderSpec {
  orderId: string;
  placedAt?: string;
  lines: { orderItemId: string; itemId: number; unitPrice: number; quantity: number }[];
  definitions?: DiscountDefinition[];
  codes?: string[];
  priorUnitsByItem?: Record<string, number>;
  shipped?: boolean;
}

export function buildOrder(spec: OrderSpec): OrderPricingState {
  const placedAt = spec.placedAt ?? '2026-11-01T00:00:00Z';
  const definitions = spec.definitions ?? [];
  const priorUnitsByItem = spec.priorUnitsByItem ?? {};
  const facts: DiscountFacts = {
    phase: 'acceptance', at: placedAt, buyer: { kind: 'member', userId: 'user-1' },
    hasPreviousOrder: Object.values(priorUnitsByItem).some(n => n > 0), hasFirstOrderReservation: false,
    priorUnitsByItem, usage: definitions.map(d => usage(d)),
  };
  const lines: DiscountLine[] = spec.lines.map(l => ({
    lineKey: `line-${l.orderItemId}`, itemId: l.itemId, unitPrice: l.unitPrice, quantity: l.quantity, lineKind: 'order',
  }));
  const codes = spec.codes ?? [];
  const result = calculateDiscounts(validateDiscountInput({ lines, discounts: definitions, codes, facts }));
  const slots: UnitSlot[] = spec.lines.flatMap(l => Array.from({ length: l.quantity }, (_, unitIndex) => {
    const paid = result.unitAmounts.find(u => u.lineKey === `line-${l.orderItemId}` && u.unitIndex === unitIndex)!.paidAmount;
    return {
      orderItemId: l.orderItemId, unitIndex, itemId: l.itemId, paidAmount: paid, allocatedAmount: 0, currentPrice: paid,
      state: 'kept' as const, holderOrderItemId: l.orderItemId, holderUnitIndex: unitIndex,
      shipped: spec.shipped ?? true, returnedCustomerAt: null, returnedFeePercent: null, returnedEventSeq: null, returnedReturnLineId: null, claimedReturnLineId: null, claimedRefundId: null,
    };
  }));
  return {
    orderId: spec.orderId, placedAt, paidTotal: slots.reduce((s, x) => s + x.paidAmount, 0),
    snapshot: {
      engineVersion: 1, definitions, codes, facts,
      lines: spec.lines.map(l => ({ lineKey: `line-${l.orderItemId}`, orderItemId: l.orderItemId, itemId: l.itemId, unitPrice: l.unitPrice, quantity: l.quantity })),
    },
    slots, entitlementPrevious: 0, entitlementMax: 0, feeTotal: 0, holds: [],
  };
}

export const repeatDefinition = () => amount('repeat', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [JACKET], repeatInOrder: true });
export const repeatPreviousDefinition = () => amount('repeatprev', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [JACKET], repeatPrevious: true });
export const setDefinition = () => amount('set', 4500, { kind: 'set', targetMode: 'include', itemIds: [JACKET, PANTS] });
export const tenPercentCode = () => definition('tenpct', { kind: 'product', method: 'code', value: { type: 'percent', value: 10 } });
/** 注文全体の 10%引き（重ねる設定。2着目割引の後の値段に掛かる） */
export const orderTenPercentCode = () => definition('tenpct', { kind: 'order_percent', method: 'code', value: { type: 'percent', value: 10 } });

export const materialsOf = (target: OrderPricingState, related: OrderPricingState[] = []): UnitPricingMaterials =>
  ({ version: VERSION, target, related });

/** リピート: ジャケット 20,000円を2着。2着目は 3,000円引き（17,000円・20,000円） */
export const repeat = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-r', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 2 }], definitions: [repeatDefinition()],
}));
/** セット: ジャケット 2着とパンツで 4,500円引き */
export const set = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-s',
  lines: [{ orderItemId: 'oi-j', itemId: JACKET, unitPrice: 20000, quantity: 2 }, { orderItemId: 'oi-p', itemId: PANTS, unitPrice: 10000, quantity: 1 }],
  definitions: [setDefinition()],
}));
/** ジャケット1着とパンツ1着だけのセット（17,000円と 8,500円） */
export const pairSet = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-ps',
  lines: [{ orderItemId: 'oi-j', itemId: JACKET, unitPrice: 20000, quantity: 1 }, { orderItemId: 'oi-p', itemId: PANTS, unitPrice: 10000, quantity: 1 }],
  definitions: [setDefinition()],
}));
/** 10%引きの割引コード。ジャケット 18,000円・パンツ 9,000円 */
export const percent10 = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-p10',
  lines: [{ orderItemId: 'oi-j', itemId: JACKET, unitPrice: 20000, quantity: 1 }, { orderItemId: 'oi-p', itemId: PANTS, unitPrice: 10000, quantity: 1 }],
  definitions: [tenPercentCode()], codes: ['TENPCT'],
}));
/** 30,000円以上で 1,000円引き。ジャケット 19,333円・パンツ 9,667円 */
export const threshold = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-th',
  lines: [{ orderItemId: 'oi-j', itemId: JACKET, unitPrice: 20000, quantity: 1 }, { orderItemId: 'oi-p', itemId: PANTS, unitPrice: 10000, quantity: 1 }],
  definitions: [amount('threshold', 1000, { kind: 'order_amount', minimum: { type: 'amount', value: 30000 } })],
}));
/** 重ねた2着目割引と 10%引きの割引コード。18,000円と 15,300円 */
export const stacked = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-st', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 20000, quantity: 2 }],
  definitions: [repeatDefinition(), orderTenPercentCode()], codes: ['TENPCT'],
}));
/** 10,000円×4、3着以上で 50%引き（5,000円ずつ） */
export const quantityTier = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-q', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 10000, quantity: 4 }],
  definitions: [definition('tier', { kind: 'product', value: { type: 'percent', value: 50 }, minimum: { type: 'quantity', value: 3 } })],
}));
/** 注文全体の1円引き。10,000円×2、払った額 9,999円と 10,000円 */
export const oneYenOff = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-1y', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 10000, quantity: 2 }],
  definitions: [amount('oneyen', 1, { kind: 'order_amount', minimum: { type: 'amount', value: 2 } })],
}));
/** 40円×2（残る1着は最低の合計 50円に届かない） */
export const tiny = (): UnitPricingMaterials => materialsOf(buildOrder({
  orderId: 'order-tiny', lines: [{ orderItemId: 'oi-1', itemId: JACKET, unitPrice: 40, quantity: 2 }],
}));

/** 累計の2着目割引: 1回目の注文で1着 20,000円、2回目の注文で1着 17,000円 */
export function twoOrders(): { first: OrderPricingState; second: OrderPricingState } {
  const first = buildOrder({
    orderId: 'order-1', placedAt: '2026-11-01T00:00:00Z',
    lines: [{ orderItemId: 'oi-a', itemId: JACKET, unitPrice: 20000, quantity: 1 }], definitions: [repeatPreviousDefinition()],
  });
  const second = buildOrder({
    orderId: 'order-2', placedAt: '2026-11-02T00:00:00Z',
    lines: [{ orderItemId: 'oi-b', itemId: JACKET, unitPrice: 20000, quantity: 1 }], definitions: [repeatPreviousDefinition()],
    priorUnitsByItem: { [String(JACKET)]: 1 },
  });
  return { first, second };
}

export const ret = (quantity: number, side: ReturnSide, over: Partial<UnitReturnInput> = {}): UnitEventChange => receive([{
  returnLineId: 'rl-1', holderOrderItemId: 'oi-1', quantity, side, part: 'now', feePercent: 0, ...over,
}]);
export const retJacket = (side: ReturnSide, over: Partial<UnitReturnInput> = {}): UnitEventChange => receive([{
  returnLineId: 'rl-j', holderOrderItemId: 'oi-j', quantity: 1, side, part: 'now', feePercent: 0, ...over,
}]);
export const retPants = (side: ReturnSide, over: Partial<UnitReturnInput> = {}): UnitEventChange => receive([{
  returnLineId: 'rl-p', holderOrderItemId: 'oi-p', quantity: 1, side, part: 'now', feePercent: 0, ...over,
}]);
export function receive(returns: UnitReturnInput[], excludedSlots: SlotKey[] = []): UnitEventChange {
  return { kind: 'return_receive', returns, excludedSlots };
}

/** 計画を確定した後の材料（DB が記録した後の状態）。状態・値段・割り振り・E・手数料・holds を更新する */
export function applyPlan(materials: UnitPricingMaterials, plan: UnitPricingPlan, now = '2026-11-20T00:00:00Z',
  feeByReturnLine: Readonly<Record<string, number>> = {}): UnitPricingMaterials {
  const seqBase = Math.max(0, ...[materials.target, ...materials.related].flatMap(o => o.holds.map(h => h.seq)));
  const slotSeqs = [materials.target, ...materials.related].flatMap(o => o.slots.map(s => s.returnedEventSeq ?? 0));
  const eventSeq = Math.max(seqBase, ...slotSeqs) + 1;
  const nextHolds = (rows: UnitPricingPlan['holds']): UnitHold[] => rows.map(r => ({ ...r, seq: eventSeq }));
  const update = (order: OrderPricingState, p: UnitPricingPlan): OrderPricingState => ({
    ...order,
    slots: order.slots.map(s => {
      const line = p.lines.find(l => l.slotOrderId === order.orderId && l.orderItemId === s.orderItemId && l.unitIndex === s.unitIndex);
      if (!line || line.lineKind === 'hold') return s;
      return {
        ...s, state: line.stateAfter, currentPrice: line.priceAfter, allocatedAmount: s.allocatedAmount + line.allocation,
        returnedCustomerAt: line.stateAfter === 'returned_customer' ? now : s.returnedCustomerAt,
        returnedEventSeq: line.stateAfter === 'returned_customer' ? eventSeq : s.returnedEventSeq,
        returnedReturnLineId: line.stateAfter === 'returned_customer' ? line.returnLineId : s.returnedReturnLineId,
        returnedFeePercent: line.stateAfter === 'returned_customer' ? (feeByReturnLine[line.returnLineId ?? ''] ?? 0) : s.returnedFeePercent,
      };
    }),
    entitlementPrevious: p.entitlement,
    entitlementMax: Math.max(order.entitlementMax, p.entitlement),
    feeTotal: order.feeTotal + p.feeAmount,
    holds: [...order.holds, ...nextHolds(p.holds)],
  });
  const target = update(materials.target, plan);
  const related = materials.related.map(o => {
    const release = plan.releases.find(r => r.orderId === o.orderId);
    return release ? update(o, release) : o;
  });
  return { ...materials, target, related };
}

/** 同じ返品を1回ずつ繰り返す（確定のたびに状態を進める） */
export function sequence(materials: UnitPricingMaterials, count: number, changeOf: (i: number) => UnitEventChange,
  plan: (m: UnitPricingMaterials, c: UnitEventChange) => UnitPricingPlan): UnitPricingPlan[] {
  const plans: UnitPricingPlan[] = [];
  let current = materials;
  for (let i = 0; i < count; i++) {
    const change = changeOf(i);
    const p = plan(current, change);
    plans.push(p);
    const fees: Record<string, number> = {};
    if (change.kind === 'return_receive') for (const r of change.returns) if (r.returnLineId) fees[r.returnLineId] = r.feePercent;
    current = applyPlan(current, p, `2026-11-${String(20 + i).padStart(2, '0')}T00:00:00Z`, fees);
  }
  return plans;
}
