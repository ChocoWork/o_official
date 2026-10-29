import { compareIds, DiscountInputError, type DiscountDefinition, type DiscountInput, type DiscountRefusal, type DiscountUsageFact } from './discount-types';

/** Code identity is resolved deterministically even when one discount has two entered codes. */
export function discountUsage(d: DiscountDefinition, input: DiscountInput, codeId?: string | null): DiscountUsageFact | undefined {
  return input.facts.usage.filter(u => u.discountId === d.id && (d.method === 'automatic' ? u.codeId === null :
    codeId !== undefined ? u.codeId === codeId : u.code !== null && input.codes.some(c => c.trim().toUpperCase() === u.code)))
    .sort((a, b) => compareIds(a.codeId ?? '', b.codeId ?? ''))[0];
}
/** Exchange lines never enter eligibility denominators. */
export function targetsItem(d: DiscountDefinition, itemId: number): boolean {
  return d.targetMode === 'all' || (d.targetMode === 'exclude' ? !d.itemIds.includes(itemId) : d.itemIds.includes(itemId));
}
/** Product conditions use the original targeted amount; order conditions are rechecked after products. */
export function evaluateEligibility(discount: DiscountDefinition, input: DiscountInput, codeId: string | null): { eligible: boolean; provisional: boolean; refusal: DiscountRefusal | null } {
  const f = input.facts, d = discount, u = discountUsage(d, input, codeId);
  const code = u?.code ?? '';
  const refuse = (reason: DiscountRefusal['reason'], minimumAmount?: number) => ({ eligible: false, provisional: false,
    refusal: { code, reason, ...(minimumAmount === undefined ? {} : { minimumAmount }) } });
  const preview = f.phase === 'preview' && f.buyer.kind === 'guest';
  if (!preview && (f.hasPreviousOrder === null || f.hasFirstOrderReservation === null || u?.buyerUses === null)) throw new DiscountInputError('invalid_input');
  const at = Date.parse(f.at);
  if (d.stopped) return refuse('not_eligible');
  if (at < Date.parse(d.startsAt) || d.endsAt !== null && at >= Date.parse(d.endsAt)) return refuse('expired');
  if (d.method === 'code' && (!u || !input.codes.some(c => c.trim().toUpperCase() === u.code))) return refuse('not_found');
  if ((d.audience === 'assigned' || u?.audience === 'assigned') && (f.buyer.kind !== 'member' || !u?.assigned)) return refuse('not_eligible');
  if (f.buyer.kind === 'guest' && (!d.allowGuests || u?.allowGuests === false)) return refuse('not_eligible');
  if (d.usageLimit !== null && (u?.reserved ?? 0) + (u?.confirmed ?? 0) >= d.usageLimit || u?.singleUse && u.codeUses > 0 || !preview && d.oncePerCustomer && (u?.buyerUses ?? 0) > 0) return refuse('usage_limit');
  if (!preview && d.firstOrderOnly && (f.hasPreviousOrder || f.hasFirstOrderReservation)) return refuse('not_eligible');
  const lines = input.lines.filter(l => l.lineKind === 'order' && targetsItem(d, l.itemId));
  const amount = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0), quantity = lines.reduce((s, l) => s + l.quantity, 0);
  if (d.minimum.type === 'amount' && amount < d.minimum.value) return refuse('minimum_amount', d.minimum.value);
  if (d.minimum.type === 'quantity' && quantity < d.minimum.value) return refuse('minimum_quantity');
  return { eligible: true, provisional: preview && (d.firstOrderOnly || d.oncePerCustomer), refusal: null };
}
