import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { searchBestDiscountPlan } from '@/lib/discounts/discount-search';
import { definition, input, line, usage } from '../../../lib/discounts/fixtures';
import { evaluateCheckoutDiscounts, loadCheckoutDiscountContext, recordDiscountSearchFallback } from '@/features/checkout/services/checkout-discounts.service';
import { claimCheckoutDiscountDraft, checkoutDiscountSnapshotHash } from '@/features/checkout/services/checkout-discounts.service';
import type { DiscountFacts } from '@/lib/discounts/discount-types';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/lib/discounts/discount-engine', () => ({ calculateDiscounts: jest.fn((i) => jest.requireActual('@/lib/discounts/discount-engine').calculateDiscounts(i)) }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
const at = '2026-10-29T00:00:00Z';
const lines = [line('b', 1, 20000, 2)];
const d = definition('auto', { firstOrderOnly: true });
function context(phase: 'preview' | 'confirm', previous = false) {
  const facts: DiscountFacts = { ...input([d], lines).facts, phase, buyer: { kind: 'guest', normalizedEmail: phase === 'preview' ? null : 'buyer@example.test' },
    hasPreviousOrder: phase === 'preview' ? null : previous, hasFirstOrderReservation: phase === 'preview' ? null : false,
    usage: [usage(d, { buyerUses: phase === 'preview' ? null : 0 })] };
  return { discounts: [d], facts, refusals: [] };
}
function clientOf(data: unknown) { const rpc = jest.fn().mockResolvedValue({ data, error: null }); return { client: { rpc } as unknown as SupabaseClient, rpc }; }

test('FREQ-548-AC-01: ゲストの見込みは別のメールでも同じ応答で注文の有無が分からない', async () => {
  const { client, rpc } = clientOf(context('preview'));
  const results: Awaited<ReturnType<typeof evaluateCheckoutDiscounts>>[] = [];
  for (const normalizedEmail of ['paid@example.test', 'none@example.test', 'expired@example.test', null]) {
    results.push(await evaluateCheckoutDiscounts(client, { kind: 'guest', normalizedEmail }, lines, [], at, 'preview'));
  }
  expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
  expect(results[0].result.provisional).toBe(true);
  for (const [, args] of rpc.mock.calls) expect(args).toMatchObject({ _guest_email: null, _buyer_user_id: null, _phase: 'preview' });
});

test('FREQ-548-AC-02: 前に注文のあるゲストは自動の初回割引が外れた額で最終確認へ進める', async () => {
  const { client } = clientOf(context('confirm', true));
  const evaluated = await evaluateCheckoutDiscounts(client, { kind: 'guest', normalizedEmail: 'buyer@example.test' }, lines, [], at, 'confirm');
  expect(evaluated.refusals).toEqual([]);
  expect(evaluated.result).toMatchObject({ totalAmount: 40000, discountAmount: 0, applied: [], provisional: false });
});

test('FREQ-546-AC-04: 探索guardでもpreviewとconfirmは200で同じfallback額を固定し要対応へ記録する', async () => {
  const { client, rpc } = clientOf(context('confirm'));
  const actual = jest.requireActual('@/lib/discounts/discount-engine');
  jest.mocked(calculateDiscounts).mockImplementationOnce(i => searchBestDiscountPlan(i, { maxProductPlans: 0, maxCombinations: 0 }));
  const evaluated = await evaluateCheckoutDiscounts(client, { kind: 'guest', normalizedEmail: 'buyer@example.test' }, lines, [], at, 'confirm');
  expect(evaluated.result).toMatchObject({ calculationMode: 'fallback', discountAmount: 4000, totalAmount: 36000 });
  expect(rpc).toHaveBeenCalledWith('record_discount_search_fallback', { _discount_ids: ['auto'] });
  jest.mocked(calculateDiscounts).mockImplementation(actual.calculateDiscounts);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  rpc.mockResolvedValue({ data: null, error: { message: 'secret code/email' } });
  await expect(recordDiscountSearchFallback(client, ['auto'])).resolves.toBeUndefined();
  expect(spy).toHaveBeenCalledWith('discount_search_attention_failed');
  expect(JSON.stringify(spy.mock.calls)).not.toContain('secret');
  spy.mockRestore();
});

test('FREQ-548-AC-01: contextの別買い手と不正な戻り値は一時失敗として断る', async () => {
  const { client } = clientOf(context('confirm'));
  await expect(loadCheckoutDiscountContext(client, { kind: 'member', userId: 'another' }, [], [1], at, 'confirm')).rejects.toThrow('割引の処理に失敗しました。');
});

// The persisted discount_amount=0/CHECK guarantee is exercised by the controller DB suite, not this RPC mock.
test('FREQ-548-AC-02: 固定claimへ割引前額とresultを別々に渡し時刻と生カウンターをhashから除く', async () => {
  const facts = context('confirm').facts;
  const discount = definition('auto', { kind: 'order_amount', value: { type: 'amount', value: 3000 }, minimum: { type: 'amount', value: 40000 } });
  const result = calculateDiscounts({ lines, discounts: [discount], facts, codes: [] });
  expect(result).toMatchObject({ discountAmount: 3000, totalAmount: 37000 });
  const snapshot = [{ source_cart_line_id: 'b', item_id: 1, item_price: 20000, quantity: 2, line_total: 40000, item_name: 'item', item_image_url: null, color: null, size: null }];
  const claim = { sessionId: 'session', requestVersion: 4, requestFingerprint: 'v4:' + 'a'.repeat(64), checkoutUiMode: 'custom' as const, checkoutOrigin: 'https://shop.test', paymentMethod: 'stripe_card' as const,
    currency: 'jpy' as const, subtotalAmount: 40000, taxAmount: 0 as const, shippingAmount: 0 as const, totalAmount: 40000,
    shippingSnapshot: { email: 'buyer@example.test', fullName: null, kanaName: null, postalCode: null, prefecture: null, city: null, address: null, building: null, phone: null }, itemsSnapshot: snapshot, buyerUserId: null, cartId: 'cart' };
  const hash = checkoutDiscountSnapshotHash(snapshot, [], [discount], facts, result);
  expect(checkoutDiscountSnapshotHash(snapshot, [], [discount], { ...facts, at: '2026-10-29T01:00:00Z', usage: facts.usage.map(u => ({ ...u, confirmed: 1, reserved: 1, buyerUses: 1, codeUses: 1 })) }, result)).toBe(hash);
  expect(checkoutDiscountSnapshotHash(snapshot, [], [discount], { ...facts, hasPreviousOrder: true }, result)).not.toBe(hash);
  const { client, rpc } = clientOf({ draftId: 'draft', checkoutSessionId: null, claimCreated: true, discountResult: result, discountSnapshotHash: hash, stripeDiscountCouponId: null });
  expect((await claimCheckoutDiscountDraft(client, claim, result, facts)).discountResult).toEqual(result);
  expect(rpc).toHaveBeenCalledWith('claim_checkout_discount_draft', { _claim: claim, _discount_result: result, _discount_facts: facts });
});

test.each(['preview', 'confirm'] as const)('FREQ-548-AC-01: %sの拒否は会員とゲストとも理由によらずコード辞書順になる', async phase => {
  for (const kind of ['guest', 'member'] as const) {
    for (const reason of ['not_found', 'expired', 'usage_limit'] as const) {
      const discount = definition('spring', { method: 'code', ...(reason === 'expired' ? { endsAt: '2026-10-28T00:00:00Z' } : { usageLimit: 1 }) });
      const base = context(phase);
      const facts: DiscountFacts = { ...base.facts, buyer: kind === 'guest' ? base.facts.buyer : { kind: 'member', userId: 'member' },
        ...(kind === 'member' ? { hasPreviousOrder: false, hasFirstOrderReservation: false } : {}),
        usage: reason === 'not_found' ? [] : [usage(discount, { buyerUses: kind === 'guest' && phase === 'preview' ? null : 0, confirmed: 1 })] };
      const { client } = clientOf({ discounts: reason === 'not_found' ? [] : [discount], facts,
        refusals: reason === 'not_found' ? [{ code: 'SPRING', reason: 'not_found' }, { code: 'ZZZZZZ', reason: 'not_found' }] : [{ code: 'ZZZZZZ', reason: 'not_found' }] });
      for (const codes of [[' spring ', 'ZZZZZZ'], ['ZZZZZZ', 'spring']]) {
        const evaluated = await evaluateCheckoutDiscounts(client, facts.buyer, lines, codes, at, phase);
        expect(evaluated.refusals.map(r => r.code)).toEqual(['SPRING', 'ZZZZZZ']);
        if (kind === 'guest') expect(JSON.stringify(evaluated.refusals)).toBe('[{"code":"SPRING","reason":"not_eligible"},{"code":"ZZZZZZ","reason":"not_eligible"}]');
      }
    }
  }
});

test('FREQ-548-AC-02: 数値itemキー2と10のhashもSQLの辞書順canonical JSONと一致する', () => {
  const facts = { ...input([], lines).facts, priorUnitsByItem: { '2': 1, '10': 1 } };
  const result = calculateDiscounts({ lines, discounts: [], facts, codes: [] });
  const items = [{ source_cart_line_id: 'b', item_id: 1, item_price: 20000, quantity: 2, line_total: 40000, item_name: 'x', item_image_url: null, color: null, size: null }];
  // Independent fixed wire text: integer object keys must be 10,2, as in PostgreSQL COLLATE C.
  const wire = '{"candidates":[],"codes":[],"facts":{"buyer":{"kind":"member","userId":"member"},"hasFirstOrderReservation":false,"hasPreviousOrder":false,"priorUnitsByItem":{"10":1,"2":1},"usage":[]},"lines":[{"itemId":1,"lineKey":"b","quantity":2,"unitPrice":20000}],"result":{"allocations":[],"applied":[],"calculationMode":"exact","discountAmount":0,"provisional":false,"shippingAmount":0,"subtotalAmount":40000,"totalAmount":40000,"unitAmounts":[{"lineKey":"b","paidAmount":20000,"unitIndex":0},{"lineKey":"b","paidAmount":20000,"unitIndex":1}],"unusedCodes":[],"version":1},"version":1}';
  expect(checkoutDiscountSnapshotHash(items, [], [], facts, result)).toBe(createHash('sha256').update(wire).digest('hex'));
});

test('FREQ-548-AC-02: 複数行と候補とcodeIdのhash比較はロケールに依存しない', () => {
  const ds = [definition('b', { method: 'code' }), definition('a', { method: 'code' })];
  const ls = [line('b'), line('a')];
  const facts = input(ds, ls).facts;
  facts.usage = [usage(ds[0], { codeId: 'z' }), usage(ds[0], { codeId: 'a', code: 'SECOND' }), usage(ds[1])];
  const result = calculateDiscounts({ lines: ls, discounts: [], facts, codes: [] });
  const items = ls.map(l => ({ source_cart_line_id: l.lineKey, item_id: l.itemId, item_price: l.unitPrice, quantity: 1, line_total: l.unitPrice, item_name: 'x', item_image_url: null, color: null, size: null }));
  const locale = jest.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale comparison used'); });
  try {
    const hash = checkoutDiscountSnapshotHash(items, ['B', 'A'], ds, facts, result);
    expect(checkoutDiscountSnapshotHash([...items].reverse(), ['A', 'B'], [...ds].reverse(), { ...facts, usage: [...facts.usage].reverse() }, result)).toBe(hash);
  } finally { locale.mockRestore(); }
});

