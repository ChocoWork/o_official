import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { DiscountInputError } from '@/lib/discounts/discount-types';
import { BETTER_DISCOUNT_MESSAGE, GUEST_DISCOUNT_REFUSAL_MESSAGE, promotionRefusalMessage } from '@/lib/discounts/discount-messages';
import { amount, definition, input, line } from './fixtures';

test('FREQ-545-AC-02: ２着目3000円引きの写しは20000円と17000円で返金の元を保つ', () => {
  const d = amount('repeat', 3000, { kind: 'repeat', targetMode: 'include', itemIds: [1], repeatInOrder: true });
  const i = input([d], [line('j', 1, 20000, 2)]);
  const before = JSON.stringify(i);
  const r = calculateDiscounts(i);
  expect(r.unitAmounts).toEqual([{ lineKey: 'j', unitIndex: 0, paidAmount: 20000 }, { lineKey: 'j', unitIndex: 1, paidAmount: 17000 }]);
  expect(r).toMatchObject({ version: 1, subtotalAmount: 40000, shippingAmount: 0, discountAmount: 3000, totalAmount: 37000, provisional: false, calculationMode: 'exact' });
  expect(JSON.stringify(i)).toBe(before);
});

test('FREQ-544-AC-01: 見込みと入力上限と拒否文は共通契約を守る', () => {
  for (const reason of ['not_found', 'not_eligible', 'expired', 'usage_limit', 'minimum_amount', 'minimum_quantity', 'zero_total'] as const) {
    expect(promotionRefusalMessage({ code: 'X', reason, minimumAmount: 1000 }, 'guest')).toBe(GUEST_DISCOUNT_REFUSAL_MESSAGE);
    expect(promotionRefusalMessage({ code: 'X', reason, minimumAmount: 1000 }, 'restricted')).toBe('このコードは使えません');
  }
  expect(GUEST_DISCOUNT_REFUSAL_MESSAGE).toBe('このコードは使えません。会員の方はログインしてからお試しください。');
  expect(BETTER_DISCOUNT_MESSAGE).toBe('このコードは今の割引と一緒には使えません。よりお得な割引を適用しています。');
  expect(promotionRefusalMessage({ code: 'X', reason: 'expired' }, 'public')).toBe('このコードは有効期限が切れています');
  expect(promotionRefusalMessage({ code: 'X', reason: 'usage_limit' }, 'public')).toBe('このコードは利用回数の上限に達しています');
  expect(promotionRefusalMessage({ code: 'X', reason: 'minimum_amount', minimumAmount: 1000 }, 'public')).toBe('このコードは ¥1,000 以上のご注文で使えます');
  for (const lines of [[line('a', 1, 2147483647, 2)], [line('a', 1, 100, 21)], [line('a'), line('a')]]) {
    expect(() => calculateDiscounts(input([], lines))).toThrow(DiscountInputError);
  }
  const i = input([definition('a')]);
  expect(() => calculateDiscounts({ ...i, facts: { ...i.facts, hasPreviousOrder: null } })).toThrow('invalid_input');
  expect(() => calculateDiscounts({ ...i, codes: ['bad code'] })).toThrow('invalid_input');
});

test('FREQ-544-AC-01: previewはメールを照合せずconfirmの欠けた事実は拒否する', () => {
  const d = definition('first', { firstOrderOnly: true, oncePerCustomer: true });
  const i = input([d]);
  const preview = { ...i, facts: { ...i.facts, phase: 'preview' as const, buyer: { kind: 'guest' as const, normalizedEmail: null }, hasPreviousOrder: null, hasFirstOrderReservation: null, usage: i.facts.usage.map(u => ({ ...u, buyerUses: null })) } };
  expect(calculateDiscounts(preview)).toMatchObject({ provisional: true, discountAmount: 100 });
  for (const phase of ['confirm', 'acceptance'] as const) {
    expect(() => calculateDiscounts({ ...preview, facts: { ...preview.facts, phase } })).toThrow('invalid_input');
  }
  expect(() => calculateDiscounts({ ...i, facts: { ...i.facts, usage: [] } })).toThrow('invalid_input');
  expect(() => calculateDiscounts({ ...i, facts: { ...i.facts, buyer: { kind: 'guest', normalizedEmail: null } } })).toThrow('invalid_input');
});
