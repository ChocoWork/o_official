export type DiscountKind = 'order_percent' | 'order_amount' | 'product' | 'repeat' | 'set';
export type DiscountClass = 'product' | 'order';
export type DiscountMethod = 'code' | 'automatic';
export type DiscountValue = { type: 'percent' | 'amount'; value: number };
export type DiscountMinimum = { type: 'none'; value: 0 } | { type: 'amount' | 'quantity'; value: number };
export type DiscountDefinition = {
  id: string; version: string; name: string; kind: DiscountKind; method: DiscountMethod;
  value: DiscountValue; targetMode: 'all' | 'exclude' | 'include'; itemIds: readonly number[];
  minimum: DiscountMinimum; audience: 'assigned' | 'anyone'; allowGuests: boolean;
  firstOrderOnly: boolean; usageLimit: number | null; oncePerCustomer: boolean;
  startsAt: string; endsAt: string | null; stopped: boolean;
  combinesWithProduct: boolean; combinesWithOrder: boolean; advertise: boolean;
  advertisingText: string | null; repeatPrevious: boolean; repeatInOrder: boolean;
};
export type DiscountLine = { lineKey: string; itemId: number; unitPrice: number; quantity: number; lineKind: 'order' | 'exchange' };
export type DiscountBuyer = { kind: 'member'; userId: string } | { kind: 'guest'; normalizedEmail: string | null };
export type DiscountUsageFact = {
  discountId: string; reserved: number; confirmed: number; buyerUses: number | null; assigned: boolean;
  codeId: string | null; code: string | null; audience: 'assigned' | 'anyone'; allowGuests: boolean;
  singleUse: boolean; codeUses: number;
};
export type DiscountFacts = {
  phase: 'preview' | 'confirm' | 'acceptance'; at: string; buyer: DiscountBuyer;
  hasPreviousOrder: boolean | null; hasFirstOrderReservation: boolean | null;
  priorUnitsByItem: Readonly<Record<string, number>>; usage: readonly DiscountUsageFact[];
};
export type DiscountEffect = { discountId: string; codeId: string | null; name: string; code: string | null; class: DiscountClass; amount: number };
export type DiscountAllocation = { lineKey: string; discountId: string; amount: number };
export type DiscountUnitAmount = { lineKey: string; unitIndex: number; paidAmount: number };
export type DiscountResult = {
  version: 1; subtotalAmount: number; shippingAmount: 0; discountAmount: number; totalAmount: number;
  applied: readonly DiscountEffect[]; allocations: readonly DiscountAllocation[]; unitAmounts: readonly DiscountUnitAmount[];
  unusedCodes: readonly string[]; provisional: boolean; calculationMode: 'exact' | 'fallback';
};
export type DiscountInput = { lines: readonly DiscountLine[]; discounts: readonly DiscountDefinition[]; codes: readonly string[]; facts: DiscountFacts };
export type DiscountRefusal = { code: string; reason: 'not_found' | 'not_eligible' | 'expired' | 'usage_limit' | 'minimum_amount' | 'minimum_quantity' | 'zero_total'; minimumAmount?: number };
export type DiscountQuantityGroup = { groupKey: string; itemId: number; unitPrice: number; quantity: number; repeatProtected: number };
export type ProductCandidate = { discountId: string; codeId: string | null; targetGroupKeys: readonly string[]; setItemIds: readonly number[] };
export type ProductPlan = {
  selectedDiscountIds: readonly string[]; remaining: Readonly<Record<string, number>>; effects: readonly DiscountEffect[];
  groupAllocations: readonly { groupKey: string; discountId: string; quantity: number; amount: number }[];
  setCounts: Readonly<Record<string, number>>;
};
export type DiscountSearchGuard = { maxProductPlans: number; maxCombinations: number };

export const MAX_DISCOUNT_CODES = 5;
export const MAX_AUTOMATIC_DISCOUNTS = 25;
export const MAX_STACKABLE_AUTOMATIC_PER_CLASS = 6;
export const MIN_CHECKOUT_TOTAL = 50;
export const MAX_DISCOUNT_BATCH = 100;
export const DISCOUNT_PAGE_SIZE = 20;
// Across all C21 layouts, the maximum is 2^(6+5) + (25-6) = 2067.
// The order side can have zero stackable autos, leaving nineteen product singletons.
export const MAX_DISCOUNT_PRODUCT_PLANS = 2 ** (MAX_STACKABLE_AUTOMATIC_PER_CLASS + MAX_DISCOUNT_CODES)
  + MAX_AUTOMATIC_DISCOUNTS - MAX_STACKABLE_AUTOMATIC_PER_CLASS;
export const MAX_DISCOUNT_COMBINATIONS = 160000;
export const MAX_DISCOUNT_AMOUNT = 2147483647;

/** The caller maps these stable codes to its own transport boundary. */
export class DiscountInputError extends Error {
  constructor(readonly code: 'invalid_input' | 'too_many_codes' | 'too_many_automatic' | 'amount_out_of_range' | 'total_below_minimum') {
    super(code); this.name = 'DiscountInputError';
  }
}

/** Locale-independent order for identifiers and snapshot keys. */
export function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Class is derived from the persisted kind rather than supplied separately. */
export function discountClass(d: DiscountDefinition): DiscountClass { return d.kind === 'order_amount' || d.kind === 'order_percent' ? 'order' : 'product'; }
/** BigInt keeps the intermediate yen product exact. */
export function discountValue(d: DiscountDefinition, base: number): number {
  return d.value.type === 'amount' ? Math.min(base, d.value.value) : Number(BigInt(base) * BigInt(d.value.value) / BigInt(100));
}
/** Normalize without changing the caller's order or arrays. */
export function normalizeCodes(codes: readonly string[]): string[] {
  const normalized = [...new Set(codes.map(c => c.trim().toUpperCase()))];
  if (normalized.some(c => !/^[A-Z0-9-]{1,64}$/.test(c))) throw new DiscountInputError('invalid_input');
  if (normalized.length > MAX_DISCOUNT_CODES) throw new DiscountInputError('too_many_codes');
  return normalized;
}
/** Grouping limits product evaluation to at most fifty prices, without unit bits. */
export function quantityGroups(input: DiscountInput): DiscountQuantityGroup[] {
  const grouped = new Map<string, DiscountQuantityGroup>();
  for (const l of input.lines) if (l.lineKind === 'order') {
    const key = `${l.itemId}:${l.unitPrice}`;
    const prior = grouped.get(key);
    if (prior) prior.quantity += l.quantity;
    else grouped.set(key, { groupKey: key, itemId: l.itemId, unitPrice: l.unitPrice, quantity: l.quantity, repeatProtected: 0 });
  }
  const groups = [...grouped.values()].sort((a, b) => a.itemId - b.itemId || a.unitPrice - b.unitPrice);
  const seen = new Set<number>();
  for (const g of groups) { g.repeatProtected = seen.has(g.itemId) ? 0 : 1; seen.add(g.itemId); }
  return groups;
}
/** Validate server facts and saved definitions before any bounded enumeration. */
export function validateDiscountInput(input: DiscountInput): DiscountInput {
  const fail = () => { throw new DiscountInputError('invalid_input'); };
  const integer = (n: number, minimum = 0) => Number.isSafeInteger(n) && n >= minimum;
  const money = (n: number) => { if (!integer(n) || n > MAX_DISCOUNT_AMOUNT) throw new DiscountInputError('amount_out_of_range'); };
  const codes = normalizeCodes(input.codes);
  const keys = new Set<string>();
  let subtotal = 0;
  if (input.lines.length > 50) fail();
  for (const l of input.lines) {
    if (!l.lineKey || keys.has(l.lineKey) || !integer(l.itemId, 1) || !integer(l.quantity, 1) || l.quantity > 20 || !['order', 'exchange'].includes(l.lineKind)) fail();
    keys.add(l.lineKey); money(l.unitPrice);
    if (l.lineKind === 'order') subtotal += l.unitPrice * l.quantity;
  }
  money(subtotal);
  if (subtotal < MIN_CHECKOUT_TOTAL) throw new DiscountInputError('total_below_minimum');
  const f = input.facts;
  if (!['preview', 'confirm', 'acceptance'].includes(f.phase) || !Number.isFinite(Date.parse(f.at))) fail();
  const guestPreview = f.phase === 'preview' && f.buyer.kind === 'guest';
  if (f.buyer.kind === 'member' ? !f.buyer.userId : f.buyer.kind !== 'guest') fail();
  if (!guestPreview && f.buyer.kind === 'guest' && (!f.buyer.normalizedEmail || f.buyer.normalizedEmail !== f.buyer.normalizedEmail.trim().toLowerCase())) fail();
  if (!guestPreview && (typeof f.hasPreviousOrder !== 'boolean' || typeof f.hasFirstOrderReservation !== 'boolean')) fail();
  if (guestPreview && (f.buyer.kind !== 'guest' || f.buyer.normalizedEmail !== null || f.hasPreviousOrder !== null || f.hasFirstOrderReservation !== null)) fail();
  for (const n of Object.values(f.priorUnitsByItem)) if (!integer(n)) fail();
  for (const u of f.usage) {
    if (![u.reserved, u.confirmed, u.codeUses].every(n => integer(n)) || (guestPreview ? u.buyerUses !== null : u.buyerUses === null || !integer(u.buyerUses))) fail();
  }
  const ids = new Set<string>();
  const activeAutomatic: DiscountDefinition[] = [];
  const activeSets: DiscountDefinition[] = [];
  const at = Date.parse(f.at);
  for (const d of input.discounts) {
    if (!d.id || ids.has(d.id) || !/^[1-9][0-9]*$/.test(d.version) || BigInt(d.version) > BigInt('9223372036854775807')) fail();
    ids.add(d.id);
    if (!['order_percent', 'order_amount', 'product', 'repeat', 'set'].includes(d.kind) || !['automatic', 'code'].includes(d.method) || !['percent', 'amount'].includes(d.value.type)) fail();
    if (!integer(d.value.value, 1) || (d.value.type === 'percent' && d.value.value > 99)) fail();
    money(d.value.value);
    if (!['none', 'amount', 'quantity'].includes(d.minimum.type) || !integer(d.minimum.value) || (d.minimum.type === 'none' ? d.minimum.value !== 0 : d.minimum.value < 1)) fail();
    if (d.value.type === 'amount' && (d.minimum.type !== 'amount' || d.minimum.value <= d.value.value)) fail();
    if (d.kind === 'order_percent' && d.value.type !== 'percent' || d.kind === 'order_amount' && d.value.type !== 'amount') fail();
    if (discountClass(d) === 'order' ? d.targetMode !== 'all' : d.kind === 'product' ? !['all', 'exclude'].includes(d.targetMode) : d.targetMode !== 'include') fail();
    if (new Set(d.itemIds).size !== d.itemIds.length || d.itemIds.some(id => !integer(id, 1)) || (d.targetMode === 'all' && d.itemIds.length > 0)) fail();
    if (d.kind === 'set' && (d.itemIds.length < 2 || d.itemIds.length > 10) || d.kind === 'repeat' && (!d.itemIds.length || !d.repeatPrevious && !d.repeatInOrder)) fail();
    if (!['assigned', 'anyone'].includes(d.audience) || d.audience === 'assigned' && d.allowGuests || d.method === 'automatic' && (d.audience !== 'anyone' || !d.allowGuests) || d.advertise && d.method !== 'automatic') fail();
    if (d.usageLimit !== null && !integer(d.usageLimit, 1)) fail();
    const start = Date.parse(d.startsAt), end = d.endsAt === null ? Infinity : Date.parse(d.endsAt);
    if (!Number.isFinite(start) || Number.isNaN(end) || end <= start) fail();
    if (!d.stopped && start <= at && at < end) {
      if (d.method === 'automatic') activeAutomatic.push(d);
      if (d.kind === 'set' && d.combinesWithProduct) activeSets.push(d);
    }
  }
  for (const d of activeAutomatic) if (f.usage.filter(u => u.discountId === d.id && u.codeId === null).length !== 1) fail();
  if (activeAutomatic.length > MAX_AUTOMATIC_DISCOUNTS || ['product', 'order'].some(cls => activeAutomatic.filter(d => discountClass(d) === cls && (d.combinesWithProduct || d.combinesWithOrder)).length > MAX_STACKABLE_AUTOMATIC_PER_CLASS)) throw new DiscountInputError('too_many_automatic');
  for (let n = 0; n < activeSets.length; n++) for (let m = 0; m < n; m++) if (activeSets[n].itemIds.some(id => activeSets[m].itemIds.includes(id))) fail();
  return { ...input, codes };
}
