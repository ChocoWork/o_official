import { compareIds } from '@/lib/discounts/discount-types';
import {
  compareSlotsByPrice, correctKeptPrice, slotKeyOfSlot,
} from '@/lib/orders/unit-pricing/kept-price';
import {
  UnitPricingError,
  type OrderPricingState, type ReturnSide, type SlotKey, type SlotState, type UnitEventChange, type UnitHold,
  type UnitPlanLine, type UnitPricingMaterials, type UnitPricingPlan, type UnitSlot,
} from '@/lib/orders/unit-pricing/unit-pricing-types';

export { UnitPricingError } from '@/lib/orders/unit-pricing/unit-pricing-types';

/**
 * 値段の計画（FREQ-642。設計書 2・3・5章）。出来事（受け取り・発送前の取り消し）ごとに、返す枠・返す額・1着ごとの割り振りと直し・
 * 手数料・前の注文から差し引く分を出す純関数。DB は上限と状態を守り、この計画をそのまま記録する。
 * 式: Σ割り振り − Σ直し − 手数料 ＝ 新しい E − 前の E。
 *
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-021
 */

type HoldRow = Omit<UnitHold, 'seq'>;
type StateMap = Map<SlotKey, SlotState>;

interface Request {
  side: ReturnSide;
  returnLineId: string | null;
  part: 'now' | 'consult' | null;
  feePercent: number;
  quantity: number;
  /** 返品: 枠を持つ行。取り消し: 注文の行 */
  holderOrderItemId: string;
  cancel: boolean;
}

interface Pick {
  slot: UnitSlot;
  key: SlotKey;
  side: ReturnSide;
  returnLineId: string | null;
  part: 'now' | 'consult' | null;
  feePercent: number;
}

interface HoldLine { order: OrderPricingState; slot: UnitSlot; amount: number; heldOrderId: string }

interface Evaluation {
  keptAfter: { total: number; perSlot: Map<SlotKey, number> };
  holdTotal: number;
  gross: number;
  shopOnly: number;
  fee: number;
  entitlement: number;
  lines: UnitPlanLine[];
  holds: HoldRow[];
  holdLines: HoldLine[];
  releaseRows: HoldRow[];
}

function stateMapOf(order: OrderPricingState): StateMap {
  return new Map(order.slots.map(s => [slotKeyOfSlot(s), s.state]));
}

function withPicks(base: StateMap, picks: readonly Pick[]): StateMap {
  const next = new Map(base);
  for (const p of picks) next.set(p.key, p.side === 'customer' ? 'returned_customer' : 'returned_shop');
  return next;
}

/** お客様のご都合で返した枠を、まだ手元にあるとみなした状態（E′不備。2-4） */
function shopOnlyStates(states: StateMap): StateMap {
  return new Map([...states].map(([k, v]) => [k, v === 'returned_customer' ? 'kept' : v]));
}

function heldSum(order: OrderPricingState): number {
  return order.holds.filter(h => h.heldOrderId === order.orderId).reduce((sum, h) => sum + h.amount, 0);
}

function requestsOf(change: UnitEventChange): Request[] {
  const requests: Request[] = change.kind === 'return_receive'
    ? change.returns.map(r => ({
      side: r.side, returnLineId: r.returnLineId, part: r.part, feePercent: r.feePercent,
      quantity: r.quantity, holderOrderItemId: r.holderOrderItemId, cancel: false,
    }))
    : change.cancels.map(c => ({
      side: 'shop' as const, returnLineId: null, part: null, feePercent: 0,
      quantity: c.quantity, holderOrderItemId: c.orderItemId, cancel: true,
    }));
  // 行の並びを入れ替えても同じ結果になるよう、返品の行の id の順に決める
  return requests.sort((a, b) => compareIds(a.returnLineId ?? '', b.returnLineId ?? '')
    || compareIds(a.holderOrderItemId, b.holderOrderItemId) || compareIds(a.side, b.side));
}

/**
 * 返す枠の選び方（J-12・Q5）。同じ商品の空きの枠のうち、今の値段が「その枠に当てる額」にいちばん近い枠、同じなら安い順・unit_index の順。
 * targetAmount が null の時は安い順（見込みの1回目）。発送後の返品は出荷済みの枠から、発送前の取り消しは出荷前の枠から。
 */
function selectPicks(
  order: OrderPricingState, requests: readonly Request[], excluded: ReadonlySet<SlotKey>, targetAmount: number | null,
): Pick[] {
  const taken = new Set<SlotKey>();
  const picks: Pick[] = [];
  for (const r of requests) {
    if (!Number.isInteger(r.quantity) || r.quantity < 1) throw new UnitPricingError('unit_not_available', 'quantity');
    for (let i = 0; i < r.quantity; i++) {
      const pool = order.slots.filter(s => {
        const key = slotKeyOfSlot(s);
        if (s.state !== 'kept' || taken.has(key) || excluded.has(key) || s.claimedRefundId !== null) return false;
        // 発送前の取り消し: 出荷前の元の行の枠。まだ発送していない交換の品の行は、交換に出した出荷済みの元の枠（持ち主がその行）を返す（Q10）
        if (r.cancel) {
          return (s.holderOrderItemId === r.holderOrderItemId && s.holderOrderItemId !== s.orderItemId)
            || (!s.shipped && s.orderItemId === r.holderOrderItemId);
        }
        return s.shipped && s.holderOrderItemId === r.holderOrderItemId
          && (s.claimedReturnLineId === null || s.claimedReturnLineId === r.returnLineId);
      });
      const bound = (s: UnitSlot) => (r.returnLineId !== null && s.claimedReturnLineId === r.returnLineId ? 0 : 1);
      pool.sort((a, b) => bound(a) - bound(b)
        || (targetAmount === null ? 0 : Math.abs(a.currentPrice - targetAmount) - Math.abs(b.currentPrice - targetAmount))
        || compareSlotsByPrice(a, b));
      const slot = pool[0];
      if (!slot) throw new UnitPricingError('unit_not_available');
      const key = slotKeyOfSlot(slot);
      taken.add(key);
      picks.push({ slot, key, side: r.side, returnLineId: r.returnLineId, part: r.part, feePercent: r.feePercent });
    }
  }
  return picks;
}

const at = (iso: string) => Date.parse(iso);

function qualifiesForHold(order: OrderPricingState): boolean {
  const f = order.snapshot.facts;
  return f.buyer.kind === 'member'
    && order.snapshot.definitions.some(d => d.kind === 'repeat' && d.repeatPrevious)
    && Object.values(f.priorUnitsByItem).some(n => n > 0);
}

function pickHoldSlot(order: OrderPricingState, states: StateMap, itemId: number): UnitSlot {
  const ofItem = order.slots.filter(s => s.itemId === itemId);
  const kept = ofItem.filter(s => (states.get(slotKeyOfSlot(s)) ?? s.state) === 'kept').sort(compareSlotsByPrice);
  const slot = kept[0] ?? [...ofItem].sort(compareSlotsByPrice)[0];
  if (!slot) throw new UnitPricingError('snapshot_invalid', 'hold slot missing');
  return slot;
}

/**
 * 前の注文から差し引く分（2-2・J-13）。後の注文 L ごとに「前の注文の着数」を、L より前の注文で L の受け付けの後に
 * お客様のご都合で返された枠の数だけ減らして出し直し、外れた分を出す。今の holds の和より増えた分は対象の注文に足し、減った分は新しい holds から戻す。
 */
function planHolds(
  materials: UnitPricingMaterials, targetStates: StateMap, addAllowed: boolean, addCap: number,
): { adds: HoldRow[]; releases: HoldRow[]; lines: HoldLine[] } {
  const { target, related } = materials;
  const orders = [target, ...related];
  const statesOf = (o: OrderPricingState) => (o === target ? targetStates : stateMapOf(o));
  const ledger = orders.flatMap(o => o.holds);
  const adds: HoldRow[] = [];
  const releases: HoldRow[] = [];
  const lines: HoldLine[] = [];
  let capLeft = addCap;
  const candidates = orders.filter(qualifiesForHold)
    .sort((a, b) => at(a.placedAt) - at(b.placedAt) || compareIds(a.orderId, b.orderId));
  for (const later of candidates) {
    const laterStates = statesOf(later);
    const laterAt = at(later.placedAt);
    const returnedAfter = new Map<number, number>();
    for (const o of orders) {
      if (at(o.placedAt) >= laterAt) continue;
      for (const s of o.slots) {
        const after = statesOf(o).get(slotKeyOfSlot(s)) ?? s.state;
        if (after !== 'returned_customer') continue;
        const newlyReturned = s.state !== 'returned_customer';
        if (newlyReturned || (s.returnedCustomerAt !== null && at(s.returnedCustomerAt) > laterAt)) {
          returnedAfter.set(s.itemId, (returnedAfter.get(s.itemId) ?? 0) + 1);
        }
      }
    }
    const original = later.snapshot.facts.priorUnitsByItem;
    const adjusted: Record<string, number> = { ...original };
    for (const [itemKey, n] of Object.entries(original)) {
      if (n > 0) adjusted[itemKey] = Math.max(0, n - (returnedAfter.get(Number(itemKey)) ?? 0));
    }
    const changedPrior = Object.keys(original).some(k => adjusted[k] !== original[k]);
    const lost = new Map<number, number>();
    if (changedPrior) {
      const normal = correctKeptPrice(later, laterStates).perSlot;
      const repriced = correctKeptPrice(later, laterStates, { priorUnitsByItem: adjusted }).perSlot;
      for (const s of later.slots) {
        const key = slotKeyOfSlot(s);
        if (!normal.has(key)) continue;
        lost.set(s.itemId, (lost.get(s.itemId) ?? 0) + (repriced.get(key)! - normal.get(key)!));
      }
    }
    const rows = ledger.filter(h => h.laterOrderId === later.orderId);
    const itemIds = [...new Set([...lost.keys(), ...rows.map(h => h.itemId)])].sort((a, b) => a - b);
    for (const itemId of itemIds) {
      const lostAmount = Math.max(0, lost.get(itemId) ?? 0);
      const itemRows = rows.filter(h => h.itemId === itemId);
      const delta = lostAmount - itemRows.reduce((sum, h) => sum + h.amount, 0);
      if (delta > 0 && addAllowed && at(target.placedAt) < laterAt) {
        const amount = Math.min(delta, capLeft);
        if (amount > 0) {
          capLeft -= amount;
          adds.push({ heldOrderId: target.orderId, laterOrderId: later.orderId, itemId, amount });
          lines.push({ order: later, slot: pickHoldSlot(later, laterStates, itemId), amount, heldOrderId: target.orderId });
        }
      } else if (delta < 0) {
        const byHeld = new Map<string, { net: number; seq: number }>();
        for (const h of itemRows) {
          const e = byHeld.get(h.heldOrderId) ?? { net: 0, seq: 0 };
          byHeld.set(h.heldOrderId, { net: e.net + h.amount, seq: Math.max(e.seq, h.seq) });
        }
        let left = -delta;
        const newestFirst = [...byHeld].sort(([ia, a], [ib, b]) => b.seq - a.seq || compareIds(ia, ib));
        for (const [heldOrderId, e] of newestFirst) {
          const give = Math.min(left, Math.max(0, e.net));
          if (give <= 0) continue;
          left -= give;
          releases.push({ heldOrderId, laterOrderId: later.orderId, itemId, amount: -give });
          lines.push({ order: later, slot: pickHoldSlot(later, laterStates, itemId), amount: -give, heldOrderId });
        }
      }
    }
  }
  return { adds, releases, lines };
}

/**
 * 手数料の累計を正確に出し直す。元の額 (E′ − E′不備) の増えは、お客様のご都合の返品が生む。
 * 前の出来事も今の出来事も同じ段取りで数える（段取りは1つだけ持つ）:
 *   段 ＝ 出来事の seq の順 → 出来事の中は返品の行の id の順（前の返品は枠の returnedReturnLineId）に、返品の枠を足していく。
 *   足した後の元の額 ＝ (holds を引く前の E′ − E′不備) − 効いている holds の正味。
 *   holds の行は、同じ出来事の中で同じ商品の枠を返した最後の段から効く（無ければその出来事の最後の段）。
 *   その出来事に返品の段が無い行（戻しの行）は、その出来事の seq に置いた率0の段で効く（戻しで増えた分に手数料は掛けない）。
 *   返品の行が無い枠（returnLineId が null）は1着ずつ段にし、出来事の中では返品の行の id → 枠の順に並べる。
 * 増え（負にもなる）にその段の返品の率を floor(増え × 率 / 100) で掛けた合計が手数料の累計。
 * お店の側の返品は最初から返した状態で数え、率を持たない。
 * picks・newRows はこの出来事の分（seq は Infinity とみなす）。
 */
function feeTotalOf(target: OrderPricingState, picks: readonly Pick[], newRows: readonly HoldRow[]): number {
  interface FeeStep { seq: number; keys: SlotKey[]; rate: number }
  const before = stateMapOf(target);
  const shopBase = withPicks(new Map([...before].map(([k, v]) => [k, v === 'returned_customer' ? 'kept' : v] as [SlotKey, SlotState])),
    picks.filter(p => p.side === 'shop'));
  const itemOfKey = new Map(target.slots.map(s => [slotKeyOfSlot(s), s.itemId]));
  const stepGroups = new Map<string, FeeStep & { lineId: string; order: string }>();
  // 返品の行が無い枠は1着ずつ段にする（率を取り違えず、並びが決まる）
  const pushStep = (seq: number, lineId: string | null, key: SlotKey, rate: number) => {
    const order = lineId ?? key;
    const gk = `${seq}|${lineId === null ? 'slot' : 'line'}|${order}`;
    const g = stepGroups.get(gk) ?? { seq, lineId: lineId ?? '', order, keys: [], rate };
    g.keys.push(key); stepGroups.set(gk, g);
  };
  for (const s of target.slots.filter(x => x.state === 'returned_customer')) {
    pushStep(s.returnedEventSeq ?? 0, s.returnedReturnLineId, slotKeyOfSlot(s), s.returnedFeePercent ?? 0);
  }
  for (const p of picks.filter(x => x.side === 'customer')) pushStep(Infinity, p.returnLineId, p.key, p.feePercent);
  const heldRows = [
    ...target.holds.filter(h => h.heldOrderId === target.orderId).map(h => ({ seq: h.seq, itemId: h.itemId, amount: h.amount })),
    ...newRows.map(h => ({ seq: Infinity, itemId: h.itemId, amount: h.amount })),
  ];
  // 返品の段が無い出来事の holds の行（戻しなど）は、その seq に率0の段を置いてそこで効かせる（手数料を掛けない）
  for (const row of heldRows) {
    if (![...stepGroups.values()].some(g => g.seq === row.seq)) {
      stepGroups.set(`${row.seq}|none|`, { seq: row.seq, lineId: '', order: '', keys: [], rate: 0 });
    }
  }
  const steps = [...stepGroups.values()].sort((x, y) =>
    (x.seq === y.seq ? 0 : x.seq < y.seq ? -1 : 1) || compareIds(x.lineId, y.lineId) || compareIds(x.order, y.order));
  const effectiveFrom = heldRows.map(row => {
    let match = -1;
    let lastOfSeq = -1;
    steps.forEach((st, i) => {
      if (st.seq !== row.seq) return;
      lastOfSeq = i;
      if (st.keys.some(k => itemOfKey.get(k) === row.itemId)) match = i;
    });
    return match >= 0 ? match : lastOfSeq;
  });
  let feeTotalNow = 0;
  let previousBase = 0;
  const done: SlotKey[] = [];
  steps.forEach((step, i) => {
    done.push(...step.keys);
    const st = new Map(shopBase);
    for (const k of done) st.set(k, 'returned_customer');
    const raw = correctKeptPrice(target, shopOnlyStates(st)).total - correctKeptPrice(target, st).total;
    const held = heldRows.reduce((sum, row, n) => sum + (effectiveFrom[n] <= i ? row.amount : 0), 0);
    const current = raw - held;
    feeTotalNow += Math.floor((current - previousBase) * step.rate / 100);
    previousBase = current;
  });
  return feeTotalNow;
}

/** 記録済みの出来事だけから出し直した手数料の累計（出来事の時と同じ段取り）。取った累計 feeTotal と合うはず */
export function pastFeeTotal(order: OrderPricingState): number {
  return feeTotalOf(order, [], []);
}

function evaluate(materials: UnitPricingMaterials, kind: UnitEventChange['kind'], picks: readonly Pick[]): Evaluation {
  const { target } = materials;
  const before = stateMapOf(target);
  const after = withPicks(before, picks);
  const keptAfter = correctKeptPrice(target, after);
  const keptDefAfter = correctKeptPrice(target, shopOnlyStates(after)).total;
  const holdsBefore = heldSum(target);

  const customerPicks = picks.filter(p => p.side === 'customer');
  const addCap = Math.max(0, target.paidTotal - keptAfter.total - holdsBefore - target.feeTotal);
  const holdPlan = planHolds(materials, after, kind === 'return_receive' && customerPicks.length > 0, addCap);
  const ownRows = holdPlan.releases.filter(r => r.heldOrderId === target.orderId);
  const holdTotal = holdsBefore + holdPlan.adds.reduce((s, r) => s + r.amount, 0) + ownRows.reduce((s, r) => s + r.amount, 0);

  const gross = target.paidTotal - keptAfter.total - holdTotal;
  const shopOnly = target.paidTotal - keptDefAfter;

  const feeTotalNow = feeTotalOf(target, picks, [...holdPlan.adds, ...ownRows]);
  const fee = Math.max(feeTotalNow - target.feeTotal, 0);
  const entitlement = gross - target.feeTotal - fee;

  const lines: UnitPlanLine[] = [];
  const pickedKeys = new Set(picks.map(p => p.key));
  for (const p of picks) {
    const s = p.slot;
    const allocation = Math.max(0, Math.min(s.currentPrice, s.paidAmount - s.allocatedAmount));
    lines.push({
      lineKind: 'returned', orderItemId: s.orderItemId, unitIndex: s.unitIndex, slotOrderId: target.orderId,
      holderOrderItemId: s.holderOrderItemId, holderUnitIndex: s.holderUnitIndex,
      stateBefore: s.state, stateAfter: p.side === 'customer' ? 'returned_customer' : 'returned_shop',
      priceBefore: s.currentPrice, priceAfter: allocation, allocation, correction: allocation - s.currentPrice,
      part: p.part, returnLineId: p.returnLineId, shipped: s.shipped,
    });
  }
  for (const s of target.slots) {
    const key = slotKeyOfSlot(s);
    if (s.state !== 'kept' || pickedKeys.has(key)) continue;
    const priceAfter = keptAfter.perSlot.get(key);
    if (priceAfter === undefined || priceAfter === s.currentPrice) continue;
    lines.push({
      lineKind: 'kept', orderItemId: s.orderItemId, unitIndex: s.unitIndex, slotOrderId: target.orderId,
      holderOrderItemId: s.holderOrderItemId, holderUnitIndex: s.holderUnitIndex,
      stateBefore: 'kept', stateAfter: 'kept', priceBefore: s.currentPrice, priceAfter,
      allocation: 0, correction: priceAfter - s.currentPrice, part: null, returnLineId: null, shipped: s.shipped,
    });
  }
  return {
    keptAfter, holdTotal, gross, shopOnly, fee, entitlement, lines,
    holds: [...holdPlan.adds, ...ownRows], holdLines: holdPlan.lines, releaseRows: holdPlan.releases,
  };
}

function holdLineOf(h: HoldLine): UnitPlanLine {
  const s = h.slot;
  return {
    lineKind: 'hold', orderItemId: s.orderItemId, unitIndex: s.unitIndex, slotOrderId: h.order.orderId,
    holderOrderItemId: s.holderOrderItemId, holderUnitIndex: s.holderUnitIndex,
    stateBefore: s.state, stateAfter: s.state, priceBefore: s.currentPrice, priceAfter: s.currentPrice,
    allocation: 0, correction: h.amount, part: null, returnLineId: null, shipped: s.shipped,
  };
}

function releasePlan(
  materials: UnitPricingMaterials, held: OrderPricingState, rows: readonly HoldRow[], lines: readonly HoldLine[],
): UnitPricingPlan {
  const given = rows.reduce((sum, r) => sum - r.amount, 0);
  const states = stateMapOf(held);
  const holdsBefore = heldSum(held);
  const grossBefore = held.paidTotal - correctKeptPrice(held, states).total - holdsBefore;
  const releaseRefund = Math.max(held.entitlementPrevious + given - held.entitlementMax, 0);
  return {
    version: materials.version, orderId: held.orderId, kind: 'hold_release',
    entitlementPrevious: held.entitlementPrevious, entitlementMaxBefore: held.entitlementMax,
    entitlementGross: grossBefore + given,
    entitlementShopOnly: held.paidTotal - correctKeptPrice(held, shopOnlyStates(states)).total,
    feeAmount: 0, holdTotal: holdsBefore - given, entitlement: held.entitlementPrevious + given,
    standardRefund: releaseRefund, nowRefund: releaseRefund, consultRefund: 0,
    lines: lines.map(holdLineOf), holds: [...rows], releases: [], treatments: [],
  };
}

export function planUnitEvent(materials: UnitPricingMaterials, change: UnitEventChange): UnitPricingPlan {
  const { target } = materials;
  const requests = requestsOf(change);
  const excluded = new Set<SlotKey>(change.kind === 'return_receive' ? change.excludedSlots : []);

  // 1回目は安い順で額の見当を付け、その額にいちばん近い枠を選び直す（J-12）
  let picks = selectPicks(target, requests, excluded, null);
  if (picks.length > 0) {
    const rough = evaluate(materials, change.kind, picks);
    const roughRefund = Math.max(rough.entitlement - target.entitlementMax, 0);
    picks = selectPicks(target, requests, excluded, Math.floor(roughRefund / picks.length));
  }
  const full = evaluate(materials, change.kind, picks);

  const standardRefund = Math.max(full.entitlement - target.entitlementMax, 0);
  let nowRefund = standardRefund;
  if (picks.some(p => p.part === 'consult')) {
    const nowPicks = picks.filter(p => p.part !== 'consult');
    const entitlementNow = nowPicks.length === 0
      ? target.entitlementPrevious
      : evaluate(materials, change.kind, nowPicks).entitlement;
    nowRefund = Math.min(standardRefund, Math.max(entitlementNow - target.entitlementMax, 0));
  }

  const lines = [...full.lines, ...full.holdLines.filter(h => h.heldOrderId === target.orderId).map(holdLineOf)];
  const sumAllocation = lines.reduce((s, l) => s + l.allocation, 0);
  const sumCorrection = lines.reduce((s, l) => s + l.correction, 0);
  if (sumAllocation - sumCorrection - full.fee !== full.entitlement - target.entitlementPrevious) {
    throw new UnitPricingError('snapshot_invalid', 'allocation identity');
  }

  const releases: UnitPricingPlan[] = [];
  const heldIds = [...new Set(full.releaseRows.filter(r => r.heldOrderId !== target.orderId).map(r => r.heldOrderId))];
  for (const heldId of heldIds) {
    const held = materials.related.find(o => o.orderId === heldId);
    if (!held) throw new UnitPricingError('snapshot_invalid', 'held order missing');
    releases.push(releasePlan(
      materials, held,
      full.releaseRows.filter(r => r.heldOrderId === heldId),
      full.holdLines.filter(h => h.heldOrderId === heldId),
    ));
  }

  return {
    version: materials.version, orderId: target.orderId, kind: change.kind,
    entitlementPrevious: target.entitlementPrevious, entitlementMaxBefore: target.entitlementMax,
    entitlementGross: full.gross, entitlementShopOnly: full.shopOnly, feeAmount: full.fee,
    holdTotal: full.holdTotal, entitlement: full.entitlement,
    standardRefund, nowRefund, consultRefund: standardRefund - nowRefund,
    lines, holds: full.holds, releases,
    treatments: change.kind === 'return_receive'
      ? change.returns.filter(r => r.returnLineId !== null).map(r => ({ returnLineId: r.returnLineId as string, treatment: r.side }))
      : [],
  };
}
