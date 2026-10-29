import { evaluateEligibility } from '@/lib/discounts/discount-eligibility';
import { amount, definition, input, line, usage } from './fixtures';

test('FREQ-544-AC-01: 対象外と交換行は数えず、期間の始まりは含み終わりは含まない', () => {
  const d = definition('a', { targetMode: 'exclude', itemIds: [2], startsAt: '2026-10-29T00:00:00Z',
    endsAt: '2026-10-30T00:00:00Z', minimum: { type: 'amount', value: 1000 } });
  const i = input([d], [line('a'), line('b', 2, 9999, 20), { ...line('x', 1, 9999, 20), lineKind: 'exchange' }]);
  const eligible = (patch = {}) => evaluateEligibility({ ...d, ...patch }, i, null);
  expect(eligible()).toEqual({ eligible: true, provisional: false, refusal: null });
  expect(eligible({ minimum: { type: 'amount', value: 1001 } }).refusal?.reason).toBe('minimum_amount');
  expect(eligible({ minimum: { type: 'amount', value: 999 } }).eligible).toBe(true);
  for (const [value, want] of [[1, true], [2, false]] as const) {
    expect(eligible({ minimum: { type: 'quantity', value } }).eligible).toBe(want);
  }
  expect(eligible({ startsAt: '2026-10-29T00:00:01Z' }).eligible).toBe(false);
  expect(eligible({ endsAt: i.facts.at }).refusal?.reason).toBe('expired');
  for (const fact of [usage(d, { reserved: 1 }), usage(d, { confirmed: 1 }), usage(d, { buyerUses: 1 })]) {
    expect(evaluateEligibility({ ...d, usageLimit: 1, oncePerCustomer: true },
      { ...i, facts: { ...i.facts, usage: [fact] } }, null).eligible).toBe(false);
  }
  for (const patch of [{ hasPreviousOrder: true }, { hasFirstOrderReservation: true }]) {
    expect(evaluateEligibility({ ...d, firstOrderOnly: true }, { ...i, facts: { ...i.facts, ...patch } }, null).eligible).toBe(false);
  }
  const code = amount('a', 100, { method: 'code', audience: 'assigned', allowGuests: false });
  const ci = { ...i, discounts: [code], codes: ['A'], facts: { ...i.facts, usage: [usage(code)] } };
  expect(evaluateEligibility(code, ci, 'code-a').eligible).toBe(false);
  expect(evaluateEligibility(code, { ...ci, facts: { ...ci.facts, usage: [usage(code, { assigned: true })] } }, 'code-a').eligible).toBe(true);
  const publicCode = { ...code, audience: 'anyone' as const, allowGuests: true };
  expect(evaluateEligibility(publicCode, { ...ci, facts: { ...ci.facts, usage: [usage(publicCode, { singleUse: true, codeUses: 1 })] } }, 'code-a').eligible).toBe(false);
  const guest = { ...ci, facts: { ...ci.facts, phase: 'preview' as const, buyer: { kind: 'guest' as const, normalizedEmail: null },
    hasPreviousOrder: null, hasFirstOrderReservation: null, usage: [usage(publicCode, { buyerUses: null })] } };
  expect(evaluateEligibility(code, guest, 'code-a').eligible).toBe(false);
  expect(evaluateEligibility({ ...publicCode, firstOrderOnly: true, oncePerCustomer: true }, guest, 'code-a'))
    .toEqual({ eligible: true, provisional: true, refusal: null });
});
