import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import {
  compareIds, DiscountInputError, MIN_CHECKOUT_TOTAL, validateDiscountInput,
  type DiscountFacts, type DiscountLine,
} from '@/lib/discounts/discount-types';
import {
  slotKeyOf, UnitPricingError,
  type OrderPricingState, type SlotKey, type SlotState, type UnitSlot,
} from '@/lib/orders/unit-pricing/unit-pricing-types';

/**
 * 手元に残る服の正しい値段（FREQ-642。設計書 2-2・J-1・J-14・J-15）。
 * 注文の時に使った割引の計算（`src/lib/discounts/`）を、含める着だけで出し直す。純関数で、DB・時刻に触らない。
 *
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-021
 */

export interface PriceOptions {
  /** 「前の注文の着数」を写しの値でなく、この値で出し直す（後の注文で外れた割引の分。2-2） */
  priorUnitsByItem?: Readonly<Record<string, number>>;
}

export function slotKeyOfSlot(slot: Pick<UnitSlot, 'orderItemId' | 'unitIndex'>): SlotKey {
  return slotKeyOf(slot.orderItemId, slot.unitIndex);
}

/** 枠を商品ごとに、今の値段の安い順（同じなら unit_index・行の id の順）に並べる比べ方 */
export function compareSlotsByPrice(a: UnitSlot, b: UnitSlot): number {
  return a.currentPrice - b.currentPrice || a.unitIndex - b.unitIndex || compareIds(a.orderItemId, b.orderItemId);
}

function indexSlots(state: OrderPricingState): Map<SlotKey, UnitSlot> {
  return new Map(state.slots.map(s => [slotKeyOfSlot(s), s]));
}

/** 期間・回数・初回は注文の時に満たした物として扱う（使った数・予約を0にする。2-2） */
function acceptanceFacts(state: OrderPricingState, options: PriceOptions): DiscountFacts {
  const f = state.snapshot.facts;
  return {
    phase: 'acceptance',
    at: f.at,
    buyer: f.buyer,
    hasPreviousOrder: f.hasPreviousOrder,
    hasFirstOrderReservation: f.hasFirstOrderReservation,
    priorUnitsByItem: options.priorUnitsByItem ?? f.priorUnitsByItem,
    usage: f.usage.map(u => ({ ...u, reserved: 0, confirmed: 0, buyerUses: 0, codeUses: 0 })),
  };
}

/**
 * 含める枠だけを買ったとした時の、枠ごとの値段。含める小計が0なら全部0円、0より大きく最低の合計（50円）未満なら割引なしの単価。
 * 計算が返す着の額は、商品ごとに額の安い順に、枠の今の値段の安い順へ当てる（直しを小さくするため）。
 */
export function priceSlots(
  state: OrderPricingState,
  include: readonly SlotKey[],
  options: PriceOptions = {},
): Map<SlotKey, number> {
  const index = indexSlots(state);
  const chosen: UnitSlot[] = [];
  for (const key of new Set(include)) {
    const slot = index.get(key);
    if (!slot) throw new UnitPricingError('snapshot_invalid', `unknown slot ${key}`);
    chosen.push(slot);
  }
  const result = new Map<SlotKey, number>();
  if (chosen.length === 0) return result;

  const counts = new Map<string, number>();
  for (const s of chosen) counts.set(s.orderItemId, (counts.get(s.orderItemId) ?? 0) + 1);
  const snapshotLines = state.snapshot.lines.filter(l => counts.has(l.orderItemId));
  if (snapshotLines.length !== counts.size) throw new UnitPricingError('snapshot_invalid', 'line missing in snapshot');
  const lines: DiscountLine[] = snapshotLines.map(l => ({
    lineKey: l.lineKey, itemId: l.itemId, unitPrice: l.unitPrice, quantity: counts.get(l.orderItemId)!, lineKind: 'order',
  }));
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  if (subtotal < MIN_CHECKOUT_TOTAL) {
    // 0円ならどの単価も0円。50円未満は割引なしの単価（エンジンは total_below_minimum で止まるため呼ばない）
    const priceByItemLine = new Map(snapshotLines.map(l => [l.orderItemId, l.unitPrice]));
    for (const s of chosen) result.set(slotKeyOfSlot(s), priceByItemLine.get(s.orderItemId)!);
    return result;
  }

  let amounts;
  try {
    const input = validateDiscountInput({
      lines, discounts: state.snapshot.definitions, codes: state.snapshot.codes, facts: acceptanceFacts(state, options),
    });
    amounts = calculateDiscounts(input).unitAmounts;
  } catch (error) {
    if (error instanceof DiscountInputError) throw new UnitPricingError('snapshot_invalid', error.code);
    throw error;
  }

  const itemOfLineKey = new Map(lines.map(l => [l.lineKey, l.itemId]));
  const amountsByItem = new Map<number, number[]>();
  for (const u of amounts) {
    const itemId = itemOfLineKey.get(u.lineKey)!;
    amountsByItem.set(itemId, [...(amountsByItem.get(itemId) ?? []), u.paidAmount]);
  }
  const slotsByItem = new Map<number, UnitSlot[]>();
  for (const s of chosen) slotsByItem.set(s.itemId, [...(slotsByItem.get(s.itemId) ?? []), s]);
  for (const [itemId, slots] of slotsByItem) {
    const sortedAmounts = [...(amountsByItem.get(itemId) ?? [])].sort((a, b) => a - b);
    if (sortedAmounts.length !== slots.length) throw new UnitPricingError('snapshot_invalid', 'unit count mismatch');
    [...slots].sort(compareSlotsByPrice).forEach((s, i) => result.set(slotKeyOfSlot(s), sortedAmounts[i]));
  }
  return result;
}

function pack(perSlot: Map<SlotKey, number>): { total: number; perSlot: Map<SlotKey, number> } {
  let total = 0;
  for (const v of perSlot.values()) total += v;
  return { total, perSlot };
}

/**
 * 手元に残る服の正しい値段（合計と枠ごと）。`states` に無い枠は枠の持つ状態を使う。
 * お店の側の事情で返した枠が無ければ、手元にある枠だけで出し直す。有れば、籠（手元にある＋お店の側で返した）で出し、
 * 商品ごとに籠の中の額の安い着からお店の側で返した数を引いた残り（A）と、手元にある枠だけで出し直した値段（B）の低い方を使う（J-1・J-15）。
 */
export function correctKeptPrice(
  state: OrderPricingState,
  states: ReadonlyMap<SlotKey, SlotState>,
  options: PriceOptions = {},
): { total: number; perSlot: Map<SlotKey, number> } {
  const stateOf = (s: UnitSlot) => states.get(slotKeyOfSlot(s)) ?? s.state;
  const kept = state.slots.filter(s => stateOf(s) === 'kept');
  const shop = state.slots.filter(s => stateOf(s) === 'returned_shop');
  if (kept.length === 0) return { total: 0, perSlot: new Map() };
  const keptKeys = kept.map(slotKeyOfSlot);
  const onlyKept = pack(priceSlots(state, keptKeys, options));
  if (shop.length === 0) return onlyKept;

  const basket = priceSlots(state, [...keptKeys, ...shop.map(slotKeyOfSlot)], options);
  const remaining = new Map<SlotKey, number>();
  const itemIds = new Set(kept.map(s => s.itemId));
  for (const itemId of itemIds) {
    const shopCount = shop.filter(s => s.itemId === itemId).length;
    const basketAmounts = [...kept, ...shop].filter(s => s.itemId === itemId)
      .map(s => basket.get(slotKeyOfSlot(s))!).sort((a, b) => a - b);
    const rest = basketAmounts.slice(shopCount);
    kept.filter(s => s.itemId === itemId).sort(compareSlotsByPrice)
      .forEach((s, i) => remaining.set(slotKeyOfSlot(s), rest[i]));
  }
  const withBasket = pack(remaining);
  return onlyKept.total <= withBasket.total ? onlyKept : withBasket;
}
