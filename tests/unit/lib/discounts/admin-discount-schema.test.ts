/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assignBodySchema, bigintStringSchema, codesBodySchema, createBodySchema, discountCreateInputSchema, discountPatchSchema,
  parseDiscountDetailQuery, parseDiscountListQuery, parseDiscountMemberQuery, patchBodySchema, stopBodySchema, validateDiscountActivation,
} from '@/lib/discounts/admin-discount-schema';
import { createAdminDiscount, validateAdminDiscountActivation } from '@/lib/discounts/admin-discount-store';
import { GROUP_H_ERRORS } from '@/lib/discounts/admin-discount-types';
import type { DiscountDefinition } from '@/lib/discounts/discount-types';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = {
  name: '春の割引', kind: 'order_percent', method: 'automatic', value: { type: 'percent', value: 10 }, targetMode: 'all', itemIds: [],
  minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: true, firstOrderOnly: false, usageLimit: null, oncePerCustomer: false,
  startsAt: '2026-11-01T00:00:00.000Z', endsAt: null, stopped: false, combinesWithProduct: false, combinesWithOrder: false,
  advertise: false, advertisingText: null, repeatPrevious: false, repeatInOrder: false, code: null, codeMode: 'shared',
};
const ok = (input: unknown): boolean => discountCreateInputSchema.safeParse(input).success;
const NOW = new Date('2026-10-29T00:00:00.000Z');
const START = '2026-11-01T00:00:00.000Z';
const startMs = Date.parse(START);
const iso = (ms: number): string => new Date(ms).toISOString();

function definition(n: number, overrides: Partial<DiscountDefinition> = {}): DiscountDefinition {
  return {
    id: uuid(n), version: '1', name: `d${n}`, kind: 'order_percent', method: 'automatic', value: { type: 'percent', value: 10 }, targetMode: 'all',
    itemIds: [], minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: true, firstOrderOnly: false, usageLimit: null,
    oncePerCustomer: false, startsAt: iso(startMs - 86400000), endsAt: null, stopped: false, combinesWithProduct: false,
    combinesWithOrder: false, advertise: false, advertisingText: null, repeatPrevious: false, repeatInOrder: false, ...overrides,
  };
}
const candidate = (overrides: Partial<DiscountDefinition> = {}): Omit<DiscountDefinition, 'id' | 'version'> => {
  const { id: _id, version: _version, ...rest } = definition(0, { startsAt: START, ...overrides });
  void _id; void _version;
  return rest;
};
const many = (count: number, make: (n: number) => Partial<DiscountDefinition>): DiscountDefinition[] =>
  Array.from({ length: count }, (_, i) => definition(i + 1, make(i + 1)));

describe('admin discount schema', () => {
  test('FREQ-547-AC-04: 円引き・set・batchの境界と未知キーを400にする', () => {
    expect(ok(base)).toBe(true);
    // 率: 0と100は不可、1と99は可
    for (const value of [0, 100, 1.5, -1]) expect(ok({ ...base, value: { type: 'percent', value } })).toBe(false);
    for (const value of [1, 99]) expect(ok({ ...base, value: { type: 'percent', value } })).toBe(true);
    // 円: 0は不可、最低額必須、最低額>割引額
    const amount = (value: number, minimum: unknown) => ({ ...base, kind: 'order_amount', value: { type: 'amount', value }, minimum });
    expect(ok(amount(0, { type: 'amount', value: 1000 }))).toBe(false);
    expect(ok(amount(1000, { type: 'none', value: 0 }))).toBe(false);
    expect(ok(amount(1000, { type: 'quantity', value: 2000 }))).toBe(false);
    expect(ok(amount(1000, { type: 'amount', value: 1000 }))).toBe(false);
    expect(ok(amount(1000, { type: 'amount', value: 1001 }))).toBe(true);
    expect(ok({ ...base, kind: 'order_amount', value: { type: 'percent', value: 10 } })).toBe(false);
    expect(ok({ ...base, kind: 'order_percent', value: { type: 'amount', value: 100 }, minimum: { type: 'amount', value: 200 } })).toBe(false);
    // 最低条件の形
    expect(ok({ ...base, minimum: { type: 'none', value: 1 } })).toBe(false);
    expect(ok({ ...base, minimum: { type: 'amount', value: 0 } })).toBe(false);
    // set: 2〜10種類
    const set = (itemIds: number[]) => ({ ...base, kind: 'set', targetMode: 'include', itemIds });
    expect(ok(set([1]))).toBe(false);
    expect(ok(set([1, 2]))).toBe(true);
    expect(ok(set(Array.from({ length: 10 }, (_, i) => i + 1)))).toBe(true);
    expect(ok(set(Array.from({ length: 11 }, (_, i) => i + 1)))).toBe(false);
    expect(ok(set([1, 1]))).toBe(false);
    expect(ok({ ...set([1, 2]), targetMode: 'all' })).toBe(false);
    // 対象の整合
    expect(ok({ ...base, targetMode: 'exclude', itemIds: [1] })).toBe(false);
    expect(ok({ ...base, kind: 'product', targetMode: 'exclude', itemIds: [1] })).toBe(true);
    expect(ok({ ...base, kind: 'product', targetMode: 'include', itemIds: [1] })).toBe(false);
    expect(ok({ ...base, kind: 'product', targetMode: 'all', itemIds: [1] })).toBe(false);
    expect(ok({ ...base, kind: 'repeat', targetMode: 'include', itemIds: [1], repeatPrevious: false, repeatInOrder: false })).toBe(false);
    expect(ok({ ...base, kind: 'repeat', targetMode: 'include', itemIds: [1], repeatPrevious: true })).toBe(true);
    // 未知キー・型違い
    expect(ok({ ...base, extra: 1 })).toBe(false);
    expect(ok({ ...base, value: { type: 'percent', value: 10, extra: 1 } })).toBe(false);
    expect(ok({ ...base, usageLimit: 0 })).toBe(false);
    expect(ok({ ...base, startsAt: '2026-11-01' })).toBe(false);
    expect(ok({ ...base, endsAt: START })).toBe(false);
    expect(ok({ ...base, endsAt: '2026-10-31T00:00:00.000Z' })).toBe(false);
    expect(ok({ ...base, endsAt: '2026-11-01T00:00:00.001Z' })).toBe(true);
    expect(ok({ ...base, name: '   ' })).toBe(false);
    expect(ok({ ...base, name: 'あ'.repeat(101) })).toBe(false);
    // guest + assigned、自動の条件、広告
    const code = { ...base, method: 'code', code: 'SPRING', codeMode: 'shared' };
    expect(ok(code)).toBe(true);
    expect(ok({ ...code, audience: 'assigned', allowGuests: true })).toBe(false);
    expect(ok({ ...code, audience: 'assigned', allowGuests: false })).toBe(true);
    expect(ok({ ...base, audience: 'assigned', allowGuests: false })).toBe(false);
    expect(ok({ ...base, allowGuests: false })).toBe(false);
    expect(ok({ ...code, advertise: true })).toBe(false);
    expect(ok({ ...base, advertise: true, advertisingText: '全品10%オフ' })).toBe(true);
    // コード: 共有は必須、自動と束は持たない。形式と大文字化
    expect(ok({ ...code, code: null })).toBe(false);
    expect(ok({ ...code, code: null, codeMode: 'batch' })).toBe(false);
    expect(ok({ ...code, code: null, codeMode: 'batch', initialBatch: { prefix: 'TEST', userIds: [], count: 1 } })).toBe(true);
    expect(ok({ ...code, code: null, codeMode: 'batch', audience: 'assigned', initialBatch: { prefix: 'TEST', userIds: [], count: 1 } })).toBe(false);
    expect(ok({ ...code, code: null, codeMode: 'batch', initialBatch: { prefix: 'TEST', userIds: ['00000000-0000-4000-8000-000000000001'], count: 1 } })).toBe(false);
    expect(ok({ ...code, codeMode: 'batch' })).toBe(false);
    expect(ok({ ...base, code: 'SPRING' })).toBe(false);
    expect(ok({ ...code, code: 'bad code' })).toBe(false);
    expect(ok({ ...code, code: 'A'.repeat(65) })).toBe(false);
    expect(discountCreateInputSchema.parse({ ...code, code: ' spring-1 ' }).code).toBe('SPRING-1');
    // 本文のキー: actor偽装・未知キーは不可
    expect(createBodySchema.safeParse({ input: base, requestKey: uuid(1) }).success).toBe(true);
    expect(createBodySchema.safeParse({ input: base, requestKey: uuid(1), actorId: uuid(2) }).success).toBe(false);
    expect(createBodySchema.safeParse({ input: base, requestKey: 'bad' }).success).toBe(false);
    // batch: 件数1〜100、prefixは1〜55字
    const codes = (over: Record<string, unknown>) => codesBodySchema.safeParse({ prefix: 'SPRING', userIds: [], count: 10, requestKey: uuid(1), ...over }).success;
    expect(codes({})).toBe(true);
    expect(codes({ count: 0 })).toBe(false);
    expect(codes({ count: 1 })).toBe(true);
    expect(codes({ count: 100 })).toBe(true);
    expect(codes({ count: 101 })).toBe(false);
    expect(codes({ count: 1.5 })).toBe(false);
    expect(codes({ prefix: 'A'.repeat(55) })).toBe(true);
    expect(codes({ prefix: 'A'.repeat(56) })).toBe(false);
    expect(codes({ prefix: '' })).toBe(false);
    expect(codes({ prefix: 'AB-' })).toBe(false);
    expect(codes({ prefix: '-AB' })).toBe(false);
    expect(codes({ prefix: 'A_B' })).toBe(false);
    expect(codesBodySchema.parse({ prefix: ' summer-1 ', userIds: [], count: 1, requestKey: uuid(1) }).prefix).toBe('SUMMER-1');
    expect(codes({ userIds: [uuid(2), uuid(3)], count: 2 })).toBe(true);
    expect(codes({ userIds: [uuid(2), uuid(3)], count: 3 })).toBe(false);
    expect(codes({ userIds: [uuid(2), uuid(2)], count: 2 })).toBe(false);
    expect(codes({ userIds: Array.from({ length: 101 }, (_, i) => uuid(i + 1)), count: 101 })).toBe(false);
    expect(codes({ actorId: uuid(9) })).toBe(false);
    // assign: 1〜100人、重複なし
    const assign = (userIds: string[]) => assignBodySchema.safeParse({ codeId: uuid(1), userIds, requestKey: uuid(2) }).success;
    expect(assign([])).toBe(false);
    expect(assign([uuid(3)])).toBe(true);
    expect(assign([uuid(3), uuid(3)])).toBe(false);
    expect(assign(Array.from({ length: 101 }, (_, i) => uuid(i + 10)))).toBe(false);
    expect(assign(Array.from({ length: 100 }, (_, i) => uuid(i + 10)))).toBe(true);
  });

  test('FREQ-547-AC-02: patchは空・未知キー・stoppedを拒み、制御patchはtrue単独だけ', () => {
    const patch = (p: unknown) => discountPatchSchema.safeParse(p).success;
    expect(patch({})).toBe(false);
    expect(patch({ name: '改名' })).toBe(true);
    expect(patch({ name: '改名', extra: 1 })).toBe(false);
    expect(patch({ stopped: true })).toBe(false);
    expect(patch({ codeMode: 'batch' })).toBe(false);
    expect(patch({ acknowledgeSearchAttention: true })).toBe(true);
    expect(patch({ acknowledgeSearchAttention: false })).toBe(false);
    expect(patch({ acknowledgeSearchAttention: true, name: '改名' })).toBe(false);
    expect(patch({ value: { type: 'percent', value: 100 } })).toBe(false);
    expect(patch({ minimum: { type: 'none', value: 3 } })).toBe(false);
    expect(patch({ usageLimit: null })).toBe(true);
    expect(patch({ code: null })).toBe(false);
    expect(discountPatchSchema.parse({ code: ' abc ' })).toEqual({ code: 'ABC' });
    const body = (v: unknown) => patchBodySchema.safeParse({ patch: { name: 'x' }, expectedVersion: v, requestKey: uuid(1) }).success;
    for (const v of ['0', '1', '9223372036854775807']) expect(body(v)).toBe(true);
    for (const v of ['9223372036854775808', '01', '-1', '', 1, null]) expect(body(v)).toBe(false);
    expect(bigintStringSchema.safeParse('12').success).toBe(true);
    expect(stopBodySchema.safeParse({ expectedVersion: '2', requestKey: uuid(1), extra: 1 }).success).toBe(false);
  });

  test('FREQ-547-AC-02: 版の文字列は数字でない値でも例外を出さずに拒む', () => {
    for (const v of ['v1', 'abc', '1.5', ' 1', '0x10', '', '01', '-1', '9223372036854775808']) {
      expect(() => bigintStringSchema.safeParse(v)).not.toThrow();
      expect([v, bigintStringSchema.safeParse(v).success]).toEqual([v, false]);
    }
    for (const v of ['0', '9223372036854775807']) expect([v, bigintStringSchema.safeParse(v).success]).toEqual([v, true]);
    expect(stopBodySchema.safeParse({ expectedVersion: 'v1', requestKey: uuid(1) }).success).toBe(false);
    expect(patchBodySchema.safeParse({ patch: { name: 'x' }, expectedVersion: 'v1', requestKey: uuid(1) }).success).toBe(false);
  });

  test('FREQ-547-AC-01: 一覧・詳細・会員検索のqueryは許可したキーと範囲だけ', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(parseDiscountListQuery(q(''))).toEqual({ filters: {}, page: 1 });
    expect(parseDiscountListQuery(q('status=active&kind=set&method=code&query=%20abc%20&page=3'))).toEqual({
      filters: { status: 'active', kind: 'set', method: 'code', query: 'abc' }, page: 3,
    });
    expect(parseDiscountListQuery(q('query=%20'))).toEqual({ filters: {}, page: 1 });
    expect(parseDiscountListQuery(q('page=100000'))?.page).toBe(100000);
    for (const bad of ['page=0', 'page=100001', 'page=1.5', 'page=01', 'status=gone', 'kind=x', 'method=y', 'extra=1', 'page=1&page=2', `query=${'a'.repeat(101)}`]) {
      expect(parseDiscountListQuery(q(bad))).toBeNull();
    }
    expect(parseDiscountDetailQuery(q(''))).toEqual({ page: 1 });
    expect(parseDiscountDetailQuery(q('page=2'))).toEqual({ page: 2 });
    expect(parseDiscountDetailQuery(q('page=0'))).toBeNull();
    expect(parseDiscountDetailQuery(q('query=a'))).toBeNull();
    expect(parseDiscountMemberQuery(q('query=%20ab%20'))).toEqual({ query: 'ab' });
    for (const bad of ['', 'query=a', 'query=', `query=${'a'.repeat(101)}`, 'query=ab&page=1', 'query=ab&query=cd']) expect(parseDiscountMemberQuery(q(bad))).toBeNull();
  });

  describe('保存前の有効数検査', () => {
    const run = (input: ReturnType<typeof candidate>, existing: DiscountDefinition[], replacingId?: string) => validateDiscountActivation(input, existing, replacingId, NOW);

    test('FREQ-547-AC-04: schemaとDB拒否は分類６件とセット共有の同じ固定コードと文になる', async () => {
      // 25件: 24+候補=25は可、25+候補=26は不可
      expect(run(candidate(), many(24, () => ({})))).toEqual({ ok: true });
      expect(run(candidate(), many(25, () => ({})))).toEqual({ ok: false, code: 'GROUP_H_AUTOMATIC_LIMIT' });
      // 期間±1ms: 終端と候補の開始が同時なら重ならない。1ms重なれば数える
      expect(run(candidate(), many(25, () => ({ endsAt: START })))).toEqual({ ok: true });
      expect(run(candidate(), many(25, () => ({ endsAt: iso(startMs + 1) })))).toEqual({ ok: false, code: 'GROUP_H_AUTOMATIC_LIMIT' });
      // 候補の終端と既存の開始が同時でも重ならない
      expect(run(candidate({ endsAt: iso(startMs + 1000) }), many(25, () => ({ startsAt: iso(startMs + 1000) })))).toEqual({ ok: true });
      expect(run(candidate({ endsAt: iso(startMs + 1001) }), many(25, () => ({ startsAt: iso(startMs + 1000) })))).toEqual({ ok: false, code: 'GROUP_H_AUTOMATIC_LIMIT' });
      // 各分類６件: 商品側6可・7不可、注文側は別に数える
      const product = (n: number): Partial<DiscountDefinition> => ({ kind: 'product', combinesWithOrder: n > 0 });
      expect(run(candidate({ kind: 'product', combinesWithOrder: true }), many(5, product))).toEqual({ ok: true });
      expect(run(candidate({ kind: 'product', combinesWithOrder: true }), many(6, product))).toEqual({ ok: false, code: 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' });
      expect(run(candidate({ combinesWithProduct: true }), many(6, product))).toEqual({ ok: true });
      // 片側ONだけでも数える。併用なしは数えない
      expect(run(candidate({ kind: 'product', combinesWithProduct: true }), many(6, () => ({ kind: 'product', combinesWithProduct: true })))).toEqual({ ok: false, code: 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' });
      expect(run(candidate({ kind: 'product' }), many(13, () => ({ kind: 'product' })))).toEqual({ ok: true });
      // 25件すべて併用ONは分類6件を超える
      const all = many(24, (n) => ({ kind: n % 2 ? 'product' : 'order_percent', combinesWithOrder: true, combinesWithProduct: true }));
      expect(run(candidate({ combinesWithProduct: true }), all)).toEqual({ ok: false, code: 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' });
      // セットの共有item: コードと自動のセットで共通に検査
      const set = (items: number[], over: Partial<DiscountDefinition> = {}): Partial<DiscountDefinition> => ({
        kind: 'set', targetMode: 'include', itemIds: items, combinesWithProduct: true, ...over,
      });
      const newSet = candidate(set([1, 2]));
      expect(run(newSet, [definition(1, set([2, 3], { method: 'code' }))])).toEqual({ ok: false, code: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' });
      expect(run(newSet, [definition(1, set([2, 3], { method: 'automatic' }))])).toEqual({ ok: false, code: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' });
      expect(run(newSet, [definition(1, set([3, 4], { method: 'code' }))])).toEqual({ ok: true });
      expect(run(newSet, [definition(1, set([2, 3], { method: 'code', combinesWithProduct: false }))])).toEqual({ ok: true });
      expect(run(candidate(set([1, 2], { combinesWithProduct: false })), [definition(1, set([2, 3]))])).toEqual({ ok: true });
      expect(run(newSet, [definition(1, set([2, 3], { endsAt: START }))])).toEqual({ ok: true });
      expect(run(newSet, [definition(1, set([2, 3], { endsAt: iso(startMs + 1) }))])).toEqual({ ok: false, code: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' });

      // DB 409 本文はschemaの拒否と同じ固定コード・文・状態
      const dbText = {
        GROUP_H_AUTOMATIC_LIMIT: '同時に有効にできる自動の割引は25件までです。',
        GROUP_H_STACKABLE_AUTOMATIC_LIMIT: '重ねられる自動の割引は、商品の割引と注文の割引でそれぞれ6件までです。',
        GROUP_H_STACKABLE_SET_ITEM_CONFLICT: '同じ服を含むセット割引は、同じ期間に重ねる設定にできません。',
      } as const;
      const scenarios: Record<keyof typeof dbText, { input: ReturnType<typeof candidate>; existing: DiscountDefinition[] }> = {
        GROUP_H_AUTOMATIC_LIMIT: { input: candidate(), existing: many(25, () => ({})) },
        GROUP_H_STACKABLE_AUTOMATIC_LIMIT: { input: candidate({ kind: 'product', combinesWithOrder: true }), existing: many(6, product) },
        GROUP_H_STACKABLE_SET_ITEM_CONFLICT: { input: candidate(set([1, 2])), existing: [definition(1, set([2, 3]))] },
      };
      for (const [code, text] of Object.entries(dbText) as [keyof typeof dbText, string][]) {
        expect(GROUP_H_ERRORS[code]).toEqual(['23514', 409, text]);
        const { input, existing } = scenarios[code];
        const payload = { ...input, code: null, codeMode: 'shared' as const };
        // 保存前の確認(dry-run)の拒否
        const preRead = jest.fn().mockResolvedValueOnce({ data: { candidate: input, existing }, error: null });
        const pre = await validateAdminDiscountActivation({ rpc: preRead } as unknown as SupabaseClient, uuid(9), null, payload).catch((e: unknown) => e) as { code: string; status: number; message: string };
        expect([pre.code, pre.status, pre.message]).toEqual([code, 409, text]);
        expect(preRead).toHaveBeenCalledTimes(1);
        // 鍵の下のDBの拒否(writer)も同じ固定コードと文。createはwriterだけを呼ぶ
        const writer = jest.fn().mockResolvedValueOnce({ data: null, error: { message: code, code: '23514', details: 'x' } });
        const db = await createAdminDiscount({ rpc: writer } as unknown as SupabaseClient, uuid(9), payload, uuid(1)).catch((e: unknown) => e) as { code: string; status: number; message: string };
        expect([db.code, db.status, db.message]).toEqual([pre.code, pre.status, pre.message]);
        expect(writer).toHaveBeenCalledTimes(1);
        expect(writer.mock.calls[0][0]).toBe('admin_create_discount');
      }
    });

    test('FREQ-547-AC-04: 終わった期間と停止中は件数にも始点にも数えない', () => {
      const past = Date.parse('2026-09-01T00:00:00.000Z');
      // 候補の開始が過去でも、終わった25件は数えない（N3）
      const ended = many(25, () => ({ startsAt: iso(past), endsAt: '2026-10-01T00:00:00.000Z' }));
      expect(run(candidate({ startsAt: iso(past + 86400000) }), ended)).toEqual({ ok: true });
      // 現在時刻ちょうどに終わる物は終了、1ms後に終わる物は数える
      expect(run(candidate({ startsAt: iso(past + 86400000) }), many(25, () => ({ startsAt: iso(past), endsAt: NOW.toISOString() })))).toEqual({ ok: true });
      expect(run(candidate({ startsAt: iso(past + 86400000) }), many(25, () => ({ startsAt: iso(past), endsAt: iso(NOW.getTime() + 1) })))).toEqual({ ok: false, code: 'GROUP_H_AUTOMATIC_LIMIT' });
      // 停止中は数えない。候補が停止なら何も追加しない
      expect(run(candidate(), many(25, () => ({ stopped: true })))).toEqual({ ok: true });
      expect(run(candidate({ stopped: true }), many(25, () => ({})))).toEqual({ ok: true });
      // 自分自身（replacingId）は既存から外す
      const existing = many(25, () => ({}));
      expect(run(candidate(), existing, existing[0].id)).toEqual({ ok: true });
      // 終わった期間のセットは共有itemでも衝突しない
      const set = (over: Partial<DiscountDefinition>): Partial<DiscountDefinition> => ({ kind: 'set', targetMode: 'include', itemIds: [1, 2], combinesWithProduct: true, ...over });
      expect(run(candidate(set({ startsAt: iso(past + 86400000) })), [definition(1, set({ startsAt: iso(past), endsAt: '2026-10-01T00:00:00.000Z' }))])).toEqual({ ok: true });
    });
  });
});
