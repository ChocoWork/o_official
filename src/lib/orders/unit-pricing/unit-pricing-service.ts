import { computePerItemReturnRefundPreview, type ReceivePreviewLine } from '@/lib/orders/returns/return-calc';
import type { CustomerReturnRequestLine } from '@/lib/orders/returns/customer-return-types';
import { loadRefundMaterials } from '@/lib/orders/refund/refund-materials';
import { estimateRefund } from '@/lib/orders/refund/refund-allocation';
import { RefundOperationError } from '@/lib/orders/refund/refund-store';
import type { CreateRefundRequest, RefundMaterials } from '@/lib/orders/refund/refund-types';
import {
  ReturnStoreError, listOrderReturns, loadReturnCreateMaterials,
} from '@/lib/orders/returns/return-store';
import type {
  OrderReturnDetail, OrderReturnLineDetail, ReceiveReturnRequest, ReturnReason,
} from '@/lib/orders/returns/return-types';
import { planUnitEvent } from '@/lib/orders/unit-pricing/unit-event-plan';
import {
  loadConsultOutstanding, loadReturnOrderId, loadUnitPricingMaterials, type UnitPricingClient,
} from '@/lib/orders/unit-pricing/unit-pricing-store';
import {
  UnitPricingError, slotKeyOf,
  type CustomerReturnEstimate, type OrderRefundEstimate, type ReleasesOnlyPricing, type ReturnReceiveEstimate,
  type ReturnSide, type SlotKey, type UnitPricingMaterials, type UnitPricingPlan, type UnitReturnInput,
} from '@/lib/orders/unit-pricing/unit-pricing-types';

/**
 * 値段の計画をサーバーで作る（FREQ-642。設計書 5〜7章）。見込みの窓口と、受け取り・返金・取り消しの入口が同じ関数を使うので、
 * 店長が額を変えない時は、見込みと確定の返金の額が同じになる。画面から額は受け取らない（店長が直す額は今の別の欄）。
 * 注文の時の写しが無い注文（この変更より前の注文）は計画を作らず（null）、今の計算（return-calc.ts・refund-allocation.ts）のまま見込みを出す（AC-20）。
 * 計画の計算そのもの（式・枠の選び方）は unit-event-plan.ts。ここは、返品の中身・注文の材料から計画の入力を組むところ。
 * 単体試験が直接読むので、サーバー専用の印（server-only）は付けない。
 *
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-022
 */
export type PricingClient = UnitPricingClient;

/** お店の側の事情として扱う返品の理由（設計 2-3）。ほかの理由はお客様のご都合 */
const SHOP_SIDE_REASONS: readonly ReturnReason[] = ['defective', 'wrong_item'];

/** 受け取りで直さなかった時の「割引の扱い」。理由から決まる。交換の頼みを店が返金に変えた行は、理由に関わらずお店の側 */
export function defaultTreatment(reason: ReturnReason, exchangeChangedToRefund: boolean): ReturnSide {
  return exchangeChangedToRefund || SHOP_SIDE_REASONS.includes(reason) ? 'shop' : 'customer';
}

// ---- 版の食い違い（UNIT_PRICING_STALE）の作り直し ----

const STALE_CODES: readonly string[] = ['UNIT_PRICING_STALE', 'unit_pricing_stale'];

function isStaleError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && STALE_CODES.includes(code);
}

/** 入口が断りを答え（投げずに）で返す形（{ kind: 'refused', code }）も、版の食い違いとして見分ける */
function isStaleResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const { kind, code } = result as { kind?: unknown; code?: unknown };
  return kind === 'refused' && typeof code === 'string' && STALE_CODES.includes(code);
}

/**
 * 計画を作って入口に渡す一連（run。材料を読み直して計画を作り、DB の入口を呼ぶ）を、版の食い違い（UNIT_PRICING_STALE）の時だけ
 * もう1回やり直す。同じ requestKey の送り直しは、DB が版を確かめる前に前の結果を返すので二重にならない。
 * 2回目も食い違えばそのまま（投げる・断りを返す）。ほかの誤りは1回で終える。
 */
export async function withFreshPricing<T>(run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    if (!isStaleResult(result)) return result;
  } catch (error) {
    if (!isStaleError(error)) throw error;
  }
  return run();
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

/**
 * 計画を作って入口を呼ぶ。計画の計算が「着がもう動いている」(unit_not_available。同じ requestKey の送り直しの時など）で断った時だけ、
 * 計画なし（null）で入口を呼び、送り直しなら DB に前の結果を答えさせる（DB は計画を確かめる前に requestKey で探す）。
 * 送り直しでなければ DB が UNIT_PRICING_REQUIRED で断るので、計画の断りと同じ断り（invalid）に戻す。
 * 要らない道（写しの無い注文など）は計画の計算が断らないので、ここに来ない。requestKey を先に調べる案より、入口を1回呼ぶだけで済む
 */
export async function withPlanOrNull<P, T>(
  plan: () => Promise<P | null>,
  enter: (pricing: P | null) => Promise<T>,
  invalid: () => Error,
): Promise<T> {
  let pricing: P | null = null;
  let planFailed = false;
  try {
    pricing = await plan();
  } catch (error) {
    // 着がもう動いている時だけ（送り直しの可能性）。ほかの計画の誤りは、DB が計画なしを通さない道もあるので、断る
    if ((error as { planCause?: unknown } | null)?.planCause !== UNITS_MOVED) throw error;
    planFailed = true;
  }
  try {
    return await enter(pricing);
  } catch (error) {
    if (planFailed && (codeOf(error) === 'UNIT_PRICING_REQUIRED' || codeOf(error) === 'unit_pricing_required')) throw invalid();
    throw error;
  }
}

// ---- 受け取り ----

interface UnitPick { line: OrderReturnLineDetail; part: 'now' | 'consult'; quantity: number }

/** 受け取りの本文から、返金の品（返金の行と、返金に変えた交換の行の、お返しでない品）と交換の品の数を数える（DB の admin_receive_return と同じ数え方） */
function tallyReceive(detail: OrderReturnDetail, body: PlanReceiveBody) {
  const picks = new Map<string, UnitPick>();
  const exchangeByLine = new Map<string, number>();
  const refundLineIds = new Set<string>();
  for (const unit of body.units) {
    if (unit.disposition === 'sent_back') continue;
    const line = detail.lines.find(l => l.id === unit.returnLineId);
    if (!line) continue;
    const overridden = body.exchangeOverrides.some(o => o.returnLineId === line.id && o.action === 'refund');
    if (line.resolution === 'refund' || overridden) {
      const part = unit.refundChoice ?? (body.refundChoice === 'consult' ? 'consult' : 'now');
      const key = `${line.id}|${part}`;
      const entry = picks.get(key) ?? { line, part, quantity: 0 };
      entry.quantity += unit.quantity;
      picks.set(key, entry);
      refundLineIds.add(line.id);
    } else {
      exchangeByLine.set(line.id, (exchangeByLine.get(line.id) ?? 0) + unit.quantity);
    }
  }
  return { picks: [...picks.values()], exchangeByLine };
}

/**
 * 交換の品に結ぶ枠（除く枠）。DB の交換の結びの順と同じに写す: 返品の行ごと（発送の番号 → 注文の行 → 行の id の順）に、
 * その行の持ち主の「手元にある」枠から、すでに結んだ枠 → 今の値段の安い順 → 注文の行・unit_index の順に取る。
 * 返金の取り押さえ（claimedRefundId）が付いた枠は取らない。この枠を返金の枠の選びから除くので、DB が交換に結ぶ枠と重ならない。
 */
function exchangeSlots(
  materials: UnitPricingMaterials,
  lines: ReadonlyArray<{ lineId: string | null; orderItemId: string; fulfillmentNumber: number; quantity: number }>,
): SlotKey[] {
  const taken = new Set<SlotKey>();
  const ordered = [...lines].sort((a, b) =>
    a.fulfillmentNumber - b.fulfillmentNumber || (a.orderItemId < b.orderItemId ? -1 : a.orderItemId > b.orderItemId ? 1 : 0)
      || ((a.lineId ?? '') < (b.lineId ?? '') ? -1 : (a.lineId ?? '') > (b.lineId ?? '') ? 1 : 0));
  for (const line of ordered) {
    const pool = materials.target.slots.filter(s =>
      s.state === 'kept' && s.holderOrderItemId === line.orderItemId && s.claimedRefundId === null
      && !taken.has(slotKeyOf(s.orderItemId, s.unitIndex)));
    const bound = (s: { claimedReturnLineId: string | null }) => (line.lineId !== null && s.claimedReturnLineId === line.lineId ? 0 : 1);
    pool.sort((a, b) => bound(a) - bound(b) || a.currentPrice - b.currentPrice
      || (a.orderItemId < b.orderItemId ? -1 : a.orderItemId > b.orderItemId ? 1 : 0) || a.unitIndex - b.unitIndex);
    for (const slot of pool.slice(0, line.quantity)) taken.add(slotKeyOf(slot.orderItemId, slot.unitIndex));
  }
  return [...taken];
}

type PlanReceiveBody = Pick<
  ReceiveReturnRequest,
  'units' | 'exchangeOverrides' | 'refundChoice' | 'refundShippingAmount' | 'treatments'
>;

export interface PlanReceiveOptions {
  /** 返金の権限を持つか。持たない人は割引の扱いを理由からの初めの値から変えられない（変えるとお金が動くため） */
  canRefund?: boolean;
}

/** 計画の計算が「着がもう動いている」(unit_not_available) で断った印。送り直しの時の計画なしの呼び出しは、この断りだけに許す */
export const UNITS_MOVED = 'unit_not_available';

function refused(code: 'RETURN_NOT_FOUND' | 'RETURN_FORBIDDEN' | 'UNIT_PRICING_INVALID', planCause?: string): never {
  throw Object.assign(new ReturnStoreError(code), planCause ? { planCause } : {});
}

/** 計画の計算が断った（枠が足りない・写しがおかしい）。画面を開き直してもらう断りにする */
function guarded<T>(compute: () => T, fail: (cause: string) => never): T {
  try {
    return compute();
  } catch (error) {
    if (error instanceof UnitPricingError) return fail(error.code);
    throw error;
  }
}

/** 返品の受け取りの値段の計画と、画面に出す見込み。写しの無い注文は plan が null で、今の計算の見込み（legacy） */
export async function planReturnReceive(
  client: PricingClient,
  returnId: string,
  body: PlanReceiveBody,
  options: PlanReceiveOptions = {},
): Promise<{ plan: UnitPricingPlan | null; estimate: ReturnReceiveEstimate }> {
  const orderId = await loadReturnOrderId(client, returnId);
  if (orderId === null) return refused('RETURN_NOT_FOUND');
  const [materials, returns, refundMaterials] = await Promise.all([
    loadUnitPricingMaterials(client, orderId),
    listOrderReturns(client, orderId),
    loadRefundMaterials(client, orderId),
  ]);
  const detail = returns.find(r => r.id === returnId);
  if (!detail) return refused('RETURN_NOT_FOUND');
  if (!refundMaterials) throw new ReturnStoreError('order_not_found');

  const { picks, exchangeByLine } = tallyReceive(detail, body);
  const treatmentOf = (line: OrderReturnLineDetail): ReturnSide => {
    const changed = line.resolution === 'exchange';
    const initial = defaultTreatment(line.reason, changed);
    const chosen = body.treatments?.find(t => t.returnLineId === line.id)?.treatment;
    if (chosen !== undefined && chosen !== initial && options.canRefund === false) return refused('RETURN_FORBIDDEN');
    return chosen ?? initial;
  };
  const refundUnits = picks.reduce((sum, p) => sum + p.quantity, 0);
  const exchangeUnits = [...exchangeByLine.values()].reduce((sum, n) => sum + n, 0);
  const nowUnits = picks.filter(p => p.part === 'now').reduce((sum, p) => sum + p.quantity, 0);
  const shipping = nowUnits > 0 ? body.refundShippingAmount : 0;
  const refundable = refundMaterials.order.refundableAmount;
  const fixedFees =
    (!detail.firstReceiptDone && (refundUnits > 0 || exchangeUnits > 0) && detail.returnMethod === 'shop_label'
      ? detail.fees.returnShippingFee : 0)
    + (!detail.firstExchangeReceiptDone && exchangeUnits > 0 ? detail.fees.exchangeFee + detail.fees.exchangeShippingFee : 0);

  if (materials === null) {
    return { plan: null, estimate: legacyReceiveEstimate(detail, picks, exchangeUnits, body.refundShippingAmount, refundable) };
  }

  const returnInputs: UnitReturnInput[] = picks.map(p => ({
    returnLineId: p.line.id, holderOrderItemId: p.line.orderItemId, quantity: p.quantity,
    side: treatmentOf(p.line), part: p.part, feePercent: detail.fees.restockingFeePercent,
  }));
  const excludedSlots = exchangeSlots(materials, [...exchangeByLine].flatMap(([lineId, quantity]) => {
    const line = detail.lines.find(l => l.id === lineId);
    return line ? [{ lineId, orderItemId: line.orderItemId, fulfillmentNumber: line.fulfillmentNumber, quantity }] : [];
  }));
  const plan = guarded(
    () => planUnitEvent(materials, { kind: 'return_receive', returns: returnInputs, excludedSlots }),
    cause => refused('UNIT_PRICING_INVALID', cause),
  );
  const estimate: ReturnReceiveEstimate = {
    legacy: false,
    standardRefund: plan.standardRefund, nowRefund: plan.nowRefund, consultRefund: plan.consultRefund,
    feeAmount: plan.feeAmount, fixedFees,
    // 受け取りの式（DB の admin_receive_return）: 写しのある注文の率は E の中なので、固定の費用だけを引く
    refundAmount: nowUnits > 0 ? Math.min(Math.max(plan.nowRefund - fixedFees, 0) + shipping, refundable) : 0,
    refundCap: nowUnits > 0 ? Math.min(refundable, plan.nowRefund + shipping) : 0,
  };
  return { plan, estimate };
}

/** 受け取りの見込み（窓口が出す形）。計画の見込みに、相談の残りを足す（全部返金済みなら 0） */
export async function estimateReturnReceive(
  client: PricingClient,
  returnId: string,
  body: PlanReceiveBody,
  options: PlanReceiveOptions = {},
): Promise<ReturnReceiveEstimate> {
  const { estimate } = await planReturnReceive(client, returnId, body, options);
  return estimate.legacy ? estimate : { ...estimate, consultOutstanding: await loadConsultOutstanding(client, returnId) };
}

/** 写しの無い注文: 今の見込み（computePerItemReturnRefundPreview）を同じ形で返す */
function legacyReceiveEstimate(
  detail: OrderReturnDetail, picks: readonly UnitPick[], exchangeUnits: number, shippingRefund: number, refundable: number,
): ReturnReceiveEstimate {
  const lines: ReceivePreviewLine[] = detail.lines.map(line => {
    const mine = picks.filter(p => p.line.id === line.id);
    return {
      returnLineId: line.id, orderItemId: line.orderItemId, refundAmountsByCount: line.refundAmountsByCount,
      receiveRefundAmountsByCount: line.receiveRefundAmountsByCount ?? null,
      nowCount: mine.filter(p => p.part === 'now').reduce((sum, p) => sum + p.quantity, 0),
      consultCount: mine.filter(p => p.part === 'consult').reduce((sum, p) => sum + p.quantity, 0),
    };
  });
  const preview = computePerItemReturnRefundPreview({
    lines, firstReceipt: !detail.firstReceiptDone, hasExchangeInThisReceipt: exchangeUnits > 0,
    firstExchangeReceipt: !detail.firstExchangeReceiptDone, returnMethod: detail.returnMethod,
    returnShippingFee: detail.fees.returnShippingFee, restockingFeePercent: detail.fees.restockingFeePercent,
    exchangeFee: detail.fees.exchangeFee, exchangeShippingFee: detail.fees.exchangeShippingFee,
    shippingRefund: shippingRefund, refundableAmount: refundable,
  });
  const { returnShipping, exchange, exchangeShipping } = preview.nowFees;
  return {
    legacy: true,
    standardRefund: preview.nowItemsAmount + preview.consultItemsAmount,
    nowRefund: preview.nowItemsAmount,
    consultRefund: preview.consultItemsAmount,
    feeAmount: preview.nowFees.restocking + preview.consultRestockingFee,
    fixedFees: returnShipping + exchange + exchangeShipping,
    refundAmount: preview.refundAmount,
    refundCap: preview.refundCap,
  };
}

// ---- 注文の返金・取り消し ----

type RefundBody = Pick<CreateRefundRequest, 'lines' | 'shippingAmount'>;

function refundRefused(code: 'order_not_found' | 'unit_pricing_invalid', planCause?: string): never {
  throw Object.assign(new RefundOperationError(code), planCause ? { planCause } : {});
}

async function planOrderRefundFrom(
  client: PricingClient, orderId: string, body: RefundBody, refundMaterials: RefundMaterials,
): Promise<{ plan: UnitPricingPlan | null; estimate: OrderRefundEstimate }> {
  const materials = await loadUnitPricingMaterials(client, orderId);
  const selections = body.lines.map(l => ({ orderItemId: l.orderItemId, beforeShipment: l.beforeShipment, quantity: l.quantity }));
  const refundCap = refundMaterials.order.refundableAmount;
  const preLines = body.lines.filter(l => l.beforeShipment);
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);
  if (materials === null || preLines.length === 0) {
    // 写しの無い注文と、発送後の品だけ・品を指定しない返金は、今の計算（着の状態も E も変わらない。AC-28）
    const suggestedAmount = safe(estimateRefund(refundMaterials.lines, selections, body.shippingAmount).total);
    return { plan: null, estimate: { legacy: materials === null, suggestedAmount, refundCap, changesUnits: false } };
  }
  const cancels = preLines.map(l => ({ orderItemId: l.orderItemId, quantity: l.quantity }));
  const plan = guarded(
    () => planUnitEvent(materials, { kind: 'pre_shipment_cancel', cancels }),
    cause => refundRefused('unit_pricing_invalid', cause),
  );
  // 発送後の品の分は着の状態を変えないので、今の計算の額。発送前の品の分は E の増えた分（設計 2-3）
  const shipped = selections.filter(s => !s.beforeShipment);
  const shippedAmount = shipped.length > 0 ? safe(estimateRefund(refundMaterials.lines, shipped, 0).total) : 0;
  return {
    plan,
    estimate: { legacy: false, suggestedAmount: plan.standardRefund + shippedAmount + body.shippingAmount, refundCap, changesUnits: true },
  };
}

/** 管理画面の返金の値段の計画と見込み。発送前の品を選んだ時だけ計画を作る（発送後の品だけの返金は計画なし。AC-28） */
export async function planOrderRefund(
  client: PricingClient,
  orderId: string,
  body: RefundBody,
): Promise<{ plan: UnitPricingPlan | null; estimate: OrderRefundEstimate }> {
  const refundMaterials = await loadRefundMaterials(client, orderId);
  if (!refundMaterials) return refundRefused('order_not_found');
  return planOrderRefundFrom(client, orderId, body, refundMaterials);
}

/** 支払い済みの注文の取り消し: まだ発送していない品を全部、発送前として取り消す計画 */
export async function planOrderCancel(
  client: PricingClient,
  orderId: string,
): Promise<{ plan: UnitPricingPlan | null; estimate: OrderRefundEstimate }> {
  const refundMaterials = await loadRefundMaterials(client, orderId);
  if (!refundMaterials) return refundRefused('order_not_found');
  const lines = refundMaterials.lines
    .filter(line => line.unshipped > 0)
    .map(line => ({ orderItemId: line.orderItemId, quantity: line.unshipped, beforeShipment: true }));
  return planOrderRefundFrom(client, orderId, { lines, shippingAmount: 0 }, refundMaterials);
}

// ---- 返品の相談の返金 ----

/**
 * 相談の返金（額を決めて返金）の入口に渡す物。相談の返金は着の状態を変えないので、計画は「前の注文へ戻す分」だけ。
 * 戻す物が無い時（ふつう）と、写しの無い注文は null。
 */
export async function planReturnRefund(client: PricingClient, returnId: string): Promise<ReleasesOnlyPricing | null> {
  const orderId = await loadReturnOrderId(client, returnId);
  if (orderId === null) return refused('RETURN_NOT_FOUND');
  const materials = await loadUnitPricingMaterials(client, orderId);
  if (materials === null) return null;
  const plan = guarded(
    () => planUnitEvent(materials, { kind: 'return_receive', returns: [], excludedSlots: [] }),
    cause => refused('UNIT_PRICING_INVALID', cause),
  );
  return plan.releases.length === 0 ? null : { orderId, version: plan.version, releases: plan.releases };
}

// ---- お客様の申し込み ----

/**
 * お客様の返品の申し込みの返金の見込み（確かめる段）。選んだ行が全部届き、今すぐ返金し、店長が額を変えない時の、受け取りの返金の額。
 * 交換だけなら、お金が動かない（moneyMoves: false）。注文の持ち主の確かめは呼ぶ窓口が済ませてから呼ぶ。
 * 返送料などの固定の費用は、お客様の送り方がまだ決まっていないので、設定どおり（お客様の負担の理由で、お店の送り状なら返送料）で出す。
 */
export async function estimateCustomerReturn(
  client: PricingClient,
  orderId: string,
  lines: readonly CustomerReturnRequestLine[],
): Promise<CustomerReturnEstimate> {
  const refundLines = lines.filter(l => l.requestedResolution === 'refund');
  const exchangeLines = lines.filter(l => l.requestedResolution === 'exchange');
  if (refundLines.length === 0) return { refundAmount: 0, moneyMoves: false };

  const [materials, createMaterials, refundMaterials] = await Promise.all([
    loadUnitPricingMaterials(client, orderId),
    loadReturnCreateMaterials(client, orderId),
    loadRefundMaterials(client, orderId),
  ]);
  if (!refundMaterials) throw new ReturnStoreError('order_not_found');
  const { settings } = createMaterials;
  const restockingPercent = settings.restockingFeeEnabled ? settings.restockingFeePercent : 0;
  const refundable = refundMaterials.order.refundableAmount;
  const shopLabel = settings.customerPaidMethod === 'shop_label'
    && [...refundLines, ...exchangeLines].some(l => settings.reasonShippingPayers[l.reason] === 'customer');
  const fixedFees = (shopLabel ? settings.shopLabelFee : 0)
    + (exchangeLines.length > 0 && settings.exchangeFeesEnabled ? settings.exchangeFee + settings.exchangeShippingFee : 0);

  if (materials === null) {
    // 写しの無い注文: 今の計算（返金の画面と同じ、先頭から安い着の額の累計）。率は商品の額に掛ける
    const byItem = new Map<string, number>();
    for (const l of refundLines) byItem.set(l.orderItemId, (byItem.get(l.orderItemId) ?? 0) + l.quantity);
    const items = refundMaterials.lines.reduce((sum, material) => {
      const units = byItem.get(material.orderItemId);
      if (!units) return sum;
      const amounts = material.availableUnitAmounts;
      return sum + (amounts
        ? amounts.slice(0, units).reduce((a, b) => a + b, 0)
        : Math.floor(((material.lineTotal - material.lineDiscount) * units) / Math.max(material.quantity, 1)));
    }, 0);
    const fees = Math.floor((items * restockingPercent) / 100) + fixedFees;
    return { refundAmount: Math.min(Math.max(items - fees, 0), refundable), moneyMoves: true };
  }

  const returns: UnitReturnInput[] = refundLines.map(l => ({
    returnLineId: null, holderOrderItemId: l.orderItemId, quantity: l.quantity,
    side: defaultTreatment(l.reason, false), part: 'now', feePercent: restockingPercent,
  }));
  const excludedSlots = exchangeSlots(materials, exchangeLines.map(l => ({
    lineId: null, orderItemId: l.orderItemId, fulfillmentNumber: 0, quantity: l.quantity,
  })));
  const plan = planUnitEvent(materials, { kind: 'return_receive', returns, excludedSlots });
  return { refundAmount: Math.min(Math.max(plan.nowRefund - fixedFees, 0), refundable), moneyMoves: true };
}
