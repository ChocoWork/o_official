import 'server-only';
import { createHash } from 'node:crypto';
import type { CheckoutDraftItemsSnapshot, CheckoutDiscountClaim, CheckoutDiscountDraft } from './checkout-draft.service';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { evaluateEligibility } from '@/lib/discounts/discount-eligibility';
import { normalizeCodes, validateDiscountInput, type DiscountBuyer, type DiscountDefinition, type DiscountFacts, type DiscountLine, type DiscountRefusal, type DiscountResult } from '@/lib/discounts/discount-types';
import { publicDiscountRefusals } from './promotion-code.service';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().refine(s => Number.isFinite(Date.parse(s)));
const buyerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), userId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('guest'), normalizedEmail: z.string().email().nullable() }).strict(),
]);
const definitionSchema = z.object({
  id: z.string().min(1), version: z.string().regex(/^[1-9][0-9]*$/), name: z.string(),
  kind: z.enum(['order_percent', 'order_amount', 'product', 'repeat', 'set']), method: z.enum(['code', 'automatic']),
  value: z.object({ type: z.enum(['percent', 'amount']), value: count }).strict(),
  targetMode: z.enum(['all', 'exclude', 'include']), itemIds: z.array(count),
  minimum: z.union([z.object({ type: z.literal('none'), value: z.literal(0) }).strict(), z.object({ type: z.enum(['amount', 'quantity']), value: count }).strict()]),
  audience: z.enum(['assigned', 'anyone']), allowGuests: z.boolean(), firstOrderOnly: z.boolean(), usageLimit: count.nullable(), oncePerCustomer: z.boolean(),
  startsAt: timestamp, endsAt: timestamp.nullable(), stopped: z.boolean(), combinesWithProduct: z.boolean(), combinesWithOrder: z.boolean(),
  advertise: z.boolean(), advertisingText: z.string().nullable(), repeatPrevious: z.boolean(), repeatInOrder: z.boolean(),
}).strict();
const refusalSchema = z.object({ code: z.string(), reason: z.enum(['not_found', 'not_eligible', 'expired', 'usage_limit', 'minimum_amount', 'minimum_quantity', 'zero_total']), minimumAmount: count.optional() }).strict();
const factsSchema = z.object({
  phase: z.enum(['preview', 'confirm', 'acceptance']), at: timestamp, buyer: buyerSchema,
  hasPreviousOrder: z.boolean().nullable(), hasFirstOrderReservation: z.boolean().nullable(), priorUnitsByItem: z.record(z.string(), count),
  usage: z.array(z.object({ discountId: z.string(), reserved: count, confirmed: count, buyerUses: count.nullable(), assigned: z.boolean(),
    codeId: z.string().nullable(), code: z.string().nullable(), audience: z.enum(['assigned', 'anyone']), allowGuests: z.boolean(), singleUse: z.boolean(), codeUses: count }).strict()),
}).strict();
const contextSchema = z.object({ discounts: z.array(definitionSchema), facts: factsSchema, refusals: z.array(refusalSchema) }).strict();
type Context = { discounts: DiscountDefinition[]; facts: DiscountFacts; refusals: DiscountRefusal[] };
const definitionsByFacts = new WeakMap<DiscountFacts, readonly DiscountDefinition[]>();
/** Keep candidate versions on the server without extending the public facts/response contract. */
export function checkoutDiscountDefinitions(facts: DiscountFacts): readonly DiscountDefinition[] {
  const definitions = definitionsByFacts.get(facts);
  if (!definitions && facts.usage.length > 0) throw new CheckoutDiscountError();
  return definitions ?? [];
}

/** Raw provider/DB errors must never carry entered codes or email into logs. */
export class CheckoutDiscountError extends Error {
  readonly code: 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' | null;
  constructor(conflict = false) {
    super(conflict ? '割引の条件が変わりました。入力画面で割引を確かめてください。' : '割引の処理に失敗しました。');
    this.name = 'CheckoutDiscountError';
    this.code = conflict ? 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' : null;
  }
}

export async function loadCheckoutDiscountContext(
  client: SupabaseClient, buyer: DiscountBuyer, codes: readonly string[], itemIds: readonly number[], at: string, phase: 'preview' | 'confirm',
): Promise<Context> {
  const safeBuyer: DiscountBuyer = buyer.kind === 'guest' && phase === 'preview' ? { kind: 'guest', normalizedEmail: null } : buyer;
  let response;
  try {
    response = await client.rpc('get_checkout_discount_context', {
      _buyer_user_id: safeBuyer.kind === 'member' ? safeBuyer.userId : null,
      _guest_email: safeBuyer.kind === 'guest' ? safeBuyer.normalizedEmail : null,
      _codes: normalizeCodes(codes), _item_ids: [...new Set(itemIds)], _at: at, _phase: phase,
    });
  } catch { throw new CheckoutDiscountError(); }
  const parsed = contextSchema.safeParse(response.data);
  if (response.error || !parsed.success) throw new CheckoutDiscountError();
  const context = parsed.data;
  const f = context.facts;
  if (f.phase !== phase || Date.parse(f.at) !== Date.parse(at) || JSON.stringify(f.buyer) !== JSON.stringify(safeBuyer)
    || context.refusals.some(r => !normalizeCodes(codes).includes(r.code))) throw new CheckoutDiscountError();
  if (safeBuyer.kind === 'guest' && phase === 'preview' && (f.hasPreviousOrder !== null || f.hasFirstOrderReservation !== null
    || f.usage.some(u => u.buyerUses !== null) || Object.keys(f.priorUnitsByItem).length > 0)) throw new CheckoutDiscountError();
  return context;
}

/** Attention is best effort: a bookkeeping outage must not reject a calculated basket. */
export async function recordDiscountSearchFallback(client: SupabaseClient, discountIds: readonly string[]): Promise<void> {
  const ids = [...new Set(discountIds)].sort();
  try {
    const { error } = await client.rpc('record_discount_search_fallback', { _discount_ids: ids });
    if (error) throw new CheckoutDiscountError();
  } catch { console.error('discount_search_attention_failed'); }
  try {
    await logAudit({ action: 'checkout.discount.search', outcome: 'error', detail: 'discount_search_guard_exceeded', metadata: { discount_ids: ids, candidate_count: ids.length } });
  } catch { console.error('discount_search_attention_failed'); }
}

export async function evaluateCheckoutDiscounts(
  client: SupabaseClient, buyer: DiscountBuyer, lines: readonly DiscountLine[], codes: readonly string[], at: string, phase: 'preview' | 'confirm',
): Promise<{ result: DiscountResult; facts: DiscountFacts; refusals: DiscountRefusal[] }> {
  const context = await loadCheckoutDiscountContext(client, buyer, codes, lines.map(l => l.itemId), at, phase);
  const normalized = normalizeCodes(codes);
  const input = validateDiscountInput({ lines, codes: normalized, discounts: context.discounts, facts: context.facts });
  const refusals: DiscountRefusal[] = [...context.refusals];
  for (const code of normalized) {
    if (refusals.some(r => r.code === code)) continue;
    const fact = input.facts.usage.find(u => u.code === code);
    const discount = input.discounts.find(d => d.id === fact?.discountId && d.method === 'code');
    if (!discount || !fact) { refusals.push({ code, reason: 'not_found' }); continue; }
    const eligibility = evaluateEligibility(discount, input, fact.codeId);
    if (!eligibility.eligible && eligibility.refusal) refusals.push({ ...eligibility.refusal, code });
  }
  // Only entered codes produce refusals; automatic eligibility is handled inside the engine.
  const result = calculateDiscounts(input);
  definitionsByFacts.set(context.facts, context.discounts);
  if (result.calculationMode === 'fallback') await recordDiscountSearchFallback(client, input.discounts.map(d => d.id));
  return { result, facts: context.facts, refusals: publicDiscountRefusals(buyer, refusals, context.discounts, context.facts) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new CheckoutDiscountError();
  return encoded;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Omit observation time and raw counters; preserve the facts that changed eligibility. */
export function checkoutDiscountSnapshotHash(items: CheckoutDraftItemsSnapshot, codes: readonly string[], discounts: readonly DiscountDefinition[], facts: DiscountFacts, result: DiscountResult): string {
  const usage = facts.usage.map(u => ({ discountId: u.discountId, assigned: u.assigned, codeId: u.codeId, code: u.code,
    audience: u.audience, allowGuests: u.allowGuests, singleUse: u.singleUse }))
    .sort((a, b) => compareText(a.discountId, b.discountId) || compareText(a.codeId ?? '', b.codeId ?? ''));
  return createHash('sha256').update(canonical({ version: 1,
    lines: items.map(i => ({ lineKey: i.source_cart_line_id, itemId: i.item_id, unitPrice: i.item_price, quantity: i.quantity })).sort((a, b) => compareText(a.lineKey, b.lineKey)),
    codes: [...new Set(codes.map(c => c.trim().toUpperCase()))].sort(),
    candidates: discounts.map(d => ({ id: d.id, version: d.version })).sort((a, b) => compareText(a.id, b.id)),
    facts: { buyer: facts.buyer, hasPreviousOrder: facts.hasPreviousOrder, hasFirstOrderReservation: facts.hasFirstOrderReservation, priorUnitsByItem: facts.priorUnitsByItem, usage }, result,
  })).digest('hex');
}

export async function claimCheckoutDiscountDraft(client: SupabaseClient, claim: CheckoutDiscountClaim, result: DiscountResult, facts: DiscountFacts): Promise<CheckoutDiscountDraft> {
  let response;
  try { response = await client.rpc('claim_checkout_discount_draft', { _claim: claim, _discount_result: result, _discount_facts: facts }); }
  catch { throw new CheckoutDiscountError(); }
  if (response.error) throw new CheckoutDiscountError(response.error.message === 'GROUP_H_DRAFT_SNAPSHOT_CONFLICT' && response.error.code === '22023');
  const parsed = z.object({ draftId: z.string().min(1), checkoutSessionId: z.string().nullable(), claimCreated: z.boolean(),
    discountResult: z.custom<DiscountResult>(v => v !== null && typeof v === 'object' && 'version' in v && v.version === 1),
    discountSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/), stripeDiscountCouponId: z.string().nullable() }).strict().safeParse(response.data);
  if (!parsed.success || canonical(parsed.data.discountResult) !== canonical(result)) throw new CheckoutDiscountError();
  return parsed.data;
}

