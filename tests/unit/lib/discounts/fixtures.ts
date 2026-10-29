import type { DiscountDefinition, DiscountInput, DiscountLine, DiscountUsageFact } from '@/lib/discounts/discount-types';

export function definition(id: string, patch: Partial<DiscountDefinition> = {}): DiscountDefinition {
  return { id, version: '1', name: id, kind: 'product', method: 'automatic',
    value: { type: 'percent', value: 10 }, targetMode: 'all', itemIds: [],
    minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: true,
    firstOrderOnly: false, usageLimit: null, oncePerCustomer: false,
    startsAt: '2026-01-01T00:00:00Z', endsAt: null, stopped: false,
    combinesWithProduct: true, combinesWithOrder: true, advertise: false,
    advertisingText: null, repeatPrevious: false, repeatInOrder: false, ...patch };
}
export function amount(id: string, value: number, patch: Partial<DiscountDefinition> = {}): DiscountDefinition {
  return definition(id, { value: { type: 'amount', value }, minimum: { type: 'amount', value: value + 1 }, ...patch });
}
export function line(lineKey: string, itemId = 1, unitPrice = 1000, quantity = 1): DiscountLine {
  return { lineKey, itemId, unitPrice, quantity, lineKind: 'order' };
}
export function input(discounts: readonly DiscountDefinition[] = [], lines: readonly DiscountLine[] = [line('a')]): DiscountInput {
  return { lines, discounts, codes: [], facts: { phase: 'confirm', at: '2026-10-29T00:00:00Z',
    buyer: { kind: 'member', userId: 'member' }, hasPreviousOrder: false,
    hasFirstOrderReservation: false, priorUnitsByItem: {}, usage: discounts.map(d => usage(d)) } };
}
export function usage(d: DiscountDefinition, patch: Partial<DiscountUsageFact> = {}): DiscountUsageFact {
  return { discountId: d.id, reserved: 0, confirmed: 0, buyerUses: 0, assigned: false,
    codeId: d.method === 'code' ? `code-${d.id}` : null,
    code: d.method === 'code' ? d.id.toUpperCase() : null,
    audience: d.audience, allowGuests: d.allowGuests, singleUse: false, codeUses: 0, ...patch };
}
export function jacket(single = 1000): DiscountInput {
  return input([amount('set', 3000, { kind: 'set', targetMode: 'include', itemIds: [1, 2] }),
    amount('single', single, { targetMode: 'exclude', itemIds: [2] })], [line('j', 1, 20000, 2), line('p', 2, 10000)]);
}
export function permutations<T>(values: readonly T[]): T[][] {
  return values.length ? values.flatMap((v, i) => permutations(values.filter((_, j) => i !== j)).map(p => [v, ...p])) : [[]];
}

export function reviewerLayout(): DiscountInput {
  const ds = [definition('p1', { targetMode: 'exclude', itemIds: [2] }),
    definition('p2', { targetMode: 'exclude', itemIds: [1], value: { type: 'percent', value: 1 } }),
    ...Array.from({ length: 4 }, (_, n) => definition(`p${n + 3}`, { targetMode: 'exclude', itemIds: [1, 2] })),
    amount('o', 5000, { kind: 'order_amount', minimum: { type: 'amount', value: 40000 } }),
    ...Array.from({ length: 18 }, (_, n) => definition(`u${n}`, { combinesWithProduct: false, combinesWithOrder: false, value: { type: 'percent', value: 1 } })),
    ...Array.from({ length: 5 }, (_, n) => definition(`c${n}`, { method: 'code', targetMode: 'exclude', itemIds: [1, 2] }))];
  const i = input(ds, [line('j', 1, 16000, 2), line('p', 2, 10000)]);
  i.codes = Array.from({ length: 5 }, (_, n) => `C${n}`);
  return i;
}
