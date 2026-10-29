/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AdminDiscountStoreError, assignAdminDiscount, createAdminDiscount, duplicateAdminDiscount, generateAdminDiscountCodes, getAdminDiscount,
  listAdminDiscounts, searchAdminDiscountMembers, setAdminDiscountStopped, unassignAdminDiscount, updateAdminDiscount,
  validateAdminDiscountActivation,
} from '@/lib/discounts/admin-discount-store';
import { GROUP_H_ERRORS, type DiscountCreateInput } from '@/lib/discounts/admin-discount-types';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = uuid(900); const id = uuid(1); const key = uuid(2); const code = uuid(3);
const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;
const candidate = {
  name: '春', kind: 'order_percent', method: 'automatic', value: { type: 'percent', value: 10 }, targetMode: 'all', itemIds: [],
  minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: true, firstOrderOnly: false, usageLimit: null, oncePerCustomer: false,
  startsAt: '2030-11-01T00:00:00+00:00', endsAt: null, stopped: false, combinesWithProduct: false, combinesWithOrder: false,
  advertise: false, advertisingText: null, repeatPrevious: false, repeatInOrder: false,
};
const definition = { id, version: '3', ...candidate };
const input: DiscountCreateInput = { ...(candidate as unknown as Omit<DiscountCreateInput, 'code' | 'codeMode'>), code: null, codeMode: 'shared' };
const assignment = {
  rowId: 'r1', codeId: code, code: 'AB-1', userId: uuid(5), assigneeDeleted: false, assigneeName: '花', guestEmailMasked: null,
  status: 'unused', usedAt: null, orderId: null,
};
const caught = async (promise: Promise<unknown>): Promise<AdminDiscountStoreError> => {
  try { await promise; } catch (e) { return e as AdminDiscountStoreError; }
  throw new Error('resolved');
};

beforeEach(() => { rpc.mockReset(); });

describe('admin discount store', () => {
  test('FREQ-547-AC-02: storeはSQLSTATEとmessageの組だけを分類し不正JSONは500にする', async () => {
    // 拒否表の全行: messageとSQLSTATEが揃った時だけ固定のコード・状態・文になる
    for (const [message, [sqlstate, status, text]] of Object.entries(GROUP_H_ERRORS)) {
      rpc.mockResolvedValueOnce({ data: null, error: { message, code: sqlstate, details: 'PRIVATE', hint: 'PRIVATE' } });
      const error = await caught(duplicateAdminDiscount(client, actor, id, key));
      expect([error.code, error.status, error.message]).toEqual([message, status, text]);
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
      // 別のSQLSTATE: 公開しない
      rpc.mockResolvedValueOnce({ data: null, error: { message, code: (sqlstate as string) === '99999' ? '88888' : '99999', details: message } });
      const mismatched = await caught(duplicateAdminDiscount(client, actor, id, key));
      expect([mismatched.code, mismatched.status, mismatched.message]).toEqual([null, 500, '割引の処理に失敗しました。']);
    }
    // detailsやhintに固定コードがあっても、messageが違えば公開しない
    for (const field of ['details', 'hint', 'name'] as const) {
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'PRIVATE row', code: '42501', [field]: 'GROUP_H_FORBIDDEN' } });
      const error = await caught(duplicateAdminDiscount(client, actor, id, key));
      expect([error.code, error.status]).toEqual([null, 500]);
    }
    // 別のSQLSTATEは診断用に非列挙で持つが、公開しない
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: '40P01' } });
    const unknown = await caught(duplicateAdminDiscount(client, actor, id, key));
    expect(unknown.sqlstate).toBe('40P01'); expect(Object.keys(unknown)).not.toContain('sqlstate');
    expect(Object.hasOwn(GROUP_H_ERRORS, 'toString')).toBe(false);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'toString', code: '22023' } });
    expect((await caught(duplicateAdminDiscount(client, actor, id, key))).code).toBeNull();
    rpc.mockRejectedValueOnce(Object.assign(new Error('PRIVATE'), { code: '08006' }));
    const thrown = await caught(duplicateAdminDiscount(client, actor, id, key));
    expect([thrown.code, thrown.status, thrown.sqlstate, thrown.message]).toEqual([null, 500, '08006', '割引の処理に失敗しました。']);

    // 不正JSONは500。別操作の戻り値（id違い）も成功にしない
    const bad: [() => Promise<unknown>, unknown[]][] = [
      [() => listAdminDiscounts(client, actor, {}, 1), [null, [], { total: 1 }, { total: 0, rows: [], extra: 1 }, { total: -1, rows: [] }, { total: 1, rows: [{ id }] }]],
      [() => getAdminDiscount(client, actor, id, 1), [null, {}, { discount: definition }, { discount: { ...definition, id: uuid(77) }, used: false, assignmentTotal: 0, assignments: [], searchAttention: null }, { discount: { ...definition, version: '0' }, used: false, assignmentTotal: 0, assignments: [], searchAttention: null }, { discount: definition, used: false, assignmentTotal: 0, assignments: [{ ...assignment, status: 'weird' }], searchAttention: null }]],
      [() => duplicateAdminDiscount(client, actor, id, key), [null, 'x', {}, { discountId: id, version: '1', replayed: false }, { discountId: uuid(9), version: 'x', replayed: false }, { discountId: uuid(9), version: '1' }]],
      [() => setAdminDiscountStopped(client, actor, id, true, '3', key), [{ discountId: uuid(9), version: '4', replayed: false }, { discountId: id, version: '4', replayed: 'no' }]],
      [() => assignAdminDiscount(client, actor, id, code, [uuid(5)], key), [{ discountId: id, changedCount: 2, replayed: false }, { discountId: id, changedCount: -1, replayed: false }, { discountId: uuid(9), changedCount: 1, replayed: false }]],
      [() => unassignAdminDiscount(client, actor, id, code, uuid(5), key), [{ discountId: id, changedCount: 2, replayed: false }]],
      [() => generateAdminDiscountCodes(client, actor, id, 'AB', [], 1, key), [
        { discountId: id, batchId: uuid(8), codes: [], replayed: false },
        { discountId: id, batchId: uuid(8), codes: [{ codeId: code, code: 'AB-1', userId: uuid(5) }], replayed: false },
        { discountId: id, batchId: uuid(8), codes: [{ codeId: code, code: 'AB-1', userId: null }, { codeId: uuid(4), code: 'AB-2', userId: null }], replayed: false },
      ]],
      [() => searchAdminDiscountMembers(client, actor, 'ab'), [null, [], { rows: [{ userId: 'x', name: null, email: 'a@b.c' }] }, { rows: [{ userId: uuid(5), name: null, email: 'a@b.c', extra: 1 }] }]],
    ];
    for (const [run, payloads] of bad) {
      for (const data of payloads) {
        rpc.mockReset(); rpc.mockResolvedValue({ data, error: null });
        const error = await caught(run());
        expect([error.code, error.status, error.message]).toEqual([null, 500, '割引の処理に失敗しました。']);
      }
    }
    // 作成のwriterの不正JSONも500。目録の読取は呼ばない
    for (const data of [null, {}, { discountId: id }, { discountId: id, version: '1', replayed: false, extra: 1 }]) {
      rpc.mockReset(); rpc.mockResolvedValue({ data, error: null });
      const error = await caught(createAdminDiscount(client, actor, input, key));
      expect([error.code, error.status]).toEqual([null, 500]);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][0]).toBe('admin_create_discount');
    }
  });

  test('FREQ-547-AC-01: 読取のRPC名と引数は固定で、頁とactorだけが渡る', async () => {
    rpc.mockResolvedValueOnce({ data: { total: 1, rows: [{ id, name: '春', kind: 'set', method: 'code', status: 'active', startsAt: '2030-11-01T00:00:00+00:00', endsAt: null, usedCount: 2, usageLimit: 5, searchAttention: { openedAt: '2030-11-01T00:00:00+00:00', count: 1 } }] }, error: null });
    expect(await listAdminDiscounts(client, actor, { status: 'active', query: 'ab' }, 3)).toMatchObject({ total: 1 });
    expect(rpc).toHaveBeenLastCalledWith('list_admin_discounts', { _filters: { status: 'active', query: 'ab' }, _limit: 20, _offset: 40, _actor_id: actor });
    const detail = { discount: definition, used: true, assignmentTotal: 1, assignments: [assignment], searchAttention: null };
    rpc.mockResolvedValueOnce({ data: detail, error: null });
    expect(await getAdminDiscount(client, actor, id, 2)).toEqual(detail);
    expect(rpc).toHaveBeenLastCalledWith('get_admin_discount', { _discount_id: id, _assignment_limit: 20, _assignment_offset: 20, _actor_id: actor });
    rpc.mockResolvedValueOnce({ data: { rows: [{ userId: uuid(5), name: null, email: 'a@example.test' }] }, error: null });
    expect(await searchAdminDiscountMembers(client, actor, 'ab')).toEqual([{ userId: uuid(5), name: null, email: 'a@example.test' }]);
    expect(rpc).toHaveBeenLastCalledWith('search_admin_discount_members', { _query: 'ab', _limit: 20, _actor_id: actor });
    // 頁が不正ならDBを呼ばない
    rpc.mockClear();
    for (const page of [0, -1, 1.5, 100001]) {
      expect((await caught(listAdminDiscounts(client, actor, {}, page))).code).toBe('GROUP_H_ARGUMENT_INVALID');
      expect((await caught(getAdminDiscount(client, actor, id, page))).code).toBe('GROUP_H_ARGUMENT_INVALID');
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-547-AC-01: 割り当て表のrowIdと順序はDBの値のまま返す', async () => {
    const rows = ['usage:b:2', 'usage:a:9', 'plain'].map((rowId) => ({ ...assignment, rowId }));
    rpc.mockResolvedValueOnce({ data: { discount: definition, used: true, assignmentTotal: 3, assignments: rows, searchAttention: null }, error: null });
    expect((await getAdminDiscount(client, actor, id, 1)).assignments.map((r) => r.rowId)).toEqual(['usage:b:2', 'usage:a:9', 'plain']);
  });

  test('FREQ-547-AC-04: 作成・編集・停止・再開・複製は目録を読まずwriterだけを呼ぶ', async () => {
    const names: string[] = [];
    rpc.mockImplementation(async (name: string) => {
      names.push(name);
      return { data: { discountId: name === 'admin_create_discount' ? uuid(10) : id, version: '4', replayed: false }, error: null };
    });
    // 作成: codeModeは送らず、codeがnullならキー自体を送らない
    await createAdminDiscount(client, actor, input, key);
    expect(names).toEqual(['admin_create_discount']);
    const created = rpc.mock.calls[0][1] as { _input: Record<string, unknown> };
    expect(created._input).not.toHaveProperty('codeMode'); expect(created._input).not.toHaveProperty('code');
    expect(created).toMatchObject({ _request_key: key, _actor_id: actor });
    rpc.mockClear(); names.length = 0;
    await createAdminDiscount(client, actor, { ...input, method: 'code', code: 'SPRING' }, key);
    expect((rpc.mock.calls[0][1] as { _input: Record<string, unknown> })._input.code).toBe('SPRING');
    // 編集・注意の解決・停止・再開・複製
    rpc.mockClear(); names.length = 0;
    await updateAdminDiscount(client, actor, id, { name: '改名' }, '3', key);
    expect(rpc.mock.calls[0][1]).toEqual({ _discount_id: id, _patch: { name: '改名' }, _expected_version: '3', _request_key: key, _actor_id: actor });
    await updateAdminDiscount(client, actor, id, { acknowledgeSearchAttention: true }, '3', key);
    await setAdminDiscountStopped(client, actor, id, true, '3', key);
    await setAdminDiscountStopped(client, actor, id, false, '3', key);
    await duplicateAdminDiscount(client, actor, id, key).catch(() => undefined);
    expect(names).toEqual(['admin_update_discount', 'admin_update_discount', 'admin_set_discount_stopped', 'admin_set_discount_stopped', 'admin_duplicate_discount']);
    expect(rpc.mock.calls[2][1]).toEqual({ _discount_id: id, _stopped: true, _expected_version: '3', _request_key: key, _actor_id: actor });
    expect(rpc.mock.calls[3][1]).toEqual({ _discount_id: id, _stopped: false, _expected_version: '3', _request_key: key, _actor_id: actor });
  });

  test('FREQ-547-AC-04: 本物のDBの順番(初回が確定した後の再送)で、目録が拒否してもwriterの元の結果を返す', async () => {
    // 本物のDB: 初回は目録が通りwriterが確定する。確定した後は、要求キーを知らない目録の読取が自分の行を理由に拒否し、
    // writerは鍵の下で最初に再送を探して元の結果を返す。旧実装(目録の拒否でwriterを呼ばない)はここで409になる。
    const make = (n: number, over: Record<string, unknown> = {}) => ({ ...definition, id: uuid(100 + n), ...over });
    const refusals: Record<string, unknown> = {
      CODE_CONFLICT: { data: null, error: { message: 'GROUP_H_CODE_CONFLICT', code: '23505' } },
      AUTOMATIC_LIMIT: { data: { candidate, existing: Array.from({ length: 25 }, (_, n) => make(n)) }, error: null },
      SET_ITEM_CONFLICT: { data: { candidate: { ...candidate, kind: 'set', targetMode: 'include', itemIds: [1, 2], combinesWithProduct: true, combinesWithOrder: true }, existing: [make(0, { kind: 'set', targetMode: 'include', itemIds: [1, 2], combinesWithProduct: true, combinesWithOrder: true })] }, error: null },
      USED_FIELDS_LOCKED: { data: null, error: { message: 'GROUP_H_USED_FIELDS_LOCKED', code: '55000' } },
    };
    const operations: [string, (k: string) => Promise<{ discountId: string; replayed: boolean }>, string][] = [
      ['create', (k) => createAdminDiscount(client, actor, { ...input, method: 'code', code: 'SPRING' }, k), 'admin_create_discount'],
      ['update', (k) => updateAdminDiscount(client, actor, id, { name: '改名' }, '3', k), 'admin_update_discount'],
      ['resume', (k) => setAdminDiscountStopped(client, actor, id, false, '3', k), 'admin_set_discount_stopped'],
    ];
    for (const [label, run, writer] of operations) {
      for (const [refusal, afterCommit] of Object.entries(refusals)) {
        rpc.mockReset();
        let committed = false;
        const log: string[] = [];
        rpc.mockImplementation(async (name: string) => {
          log.push(name);
          if (name === 'get_admin_discount_activation_context') return committed ? afterCommit : { data: { candidate, existing: [] }, error: null };
          const replayed = committed; committed = true;
          return { data: { discountId: writer === 'admin_create_discount' ? uuid(10) : id, version: '4', replayed }, error: null };
        });
        const first = await run(key);
        const replay = await run(key);
        expect([label, refusal, first.replayed, replay.replayed, replay.discountId]).toEqual([label, refusal, false, true, first.discountId]);
        expect(log.filter((n) => n === writer)).toHaveLength(2);
      }
    }
  });

  test('FREQ-547-AC-04: 再送でない拒否と未知の失敗は、writerの答えをそのまま返す', async () => {
    // writerが鍵の下で固定コードを返す時はそのコードと文。目録の読取が別の答えでもwriterを上書きしない
    for (const run of [
      () => createAdminDiscount(client, actor, input, key),
      () => updateAdminDiscount(client, actor, id, { name: 'x' }, '3', key),
      () => setAdminDiscountStopped(client, actor, id, false, '3', key),
    ]) {
      rpc.mockReset().mockResolvedValue({ data: null, error: { message: 'GROUP_H_AUTOMATIC_LIMIT', code: '23514', details: 'PRIVATE' } });
      const refused = await caught(run());
      expect([refused.code, refused.status, refused.message]).toEqual(['GROUP_H_AUTOMATIC_LIMIT', 409, GROUP_H_ERRORS.GROUP_H_AUTOMATIC_LIMIT[2]]);
      expect(rpc).toHaveBeenCalledTimes(1);
      // 再送の途中の一時的な失敗は、元の作成を疑わせる固定コードにしない(500のまま)
      rpc.mockReset().mockResolvedValue({ data: null, error: { message: 'deadlock', code: '40P01' } });
      const transient = await caught(run());
      expect([transient.code, transient.status]).toEqual([null, 500]);
    }
  });

  test('FREQ-547-AC-04: 保存前の確認(dry-run)は有効数の拒否を返し、終わった期間は拒否の理由にしない', async () => {
    const make = (n: number, over: Record<string, unknown> = {}) => ({ ...definition, id: uuid(100 + n), ...over });
    const full = Array.from({ length: 25 }, (_, n) => make(n));
    rpc.mockResolvedValueOnce({ data: { candidate, existing: full }, error: null });
    const error = await caught(validateAdminDiscountActivation(client, actor, id, { name: 'x' }));
    expect([error.code, error.status]).toEqual(['GROUP_H_AUTOMATIC_LIMIT', 409]);
    expect(rpc).toHaveBeenCalledTimes(1);
    // 自分自身は既存から外す: 自分を含む25件に編集後の自分を足しても26件にならない
    rpc.mockReset().mockResolvedValue({ data: { candidate, existing: [make(0, { id }), ...full.slice(1)] }, error: null });
    await expect(validateAdminDiscountActivation(client, actor, id, { name: 'x' })).resolves.toBeUndefined();
    // 終わった25件(N3)が重なる期間として返っても、有効数の拒否にしない
    rpc.mockReset().mockResolvedValue({ data: { candidate: { ...candidate, startsAt: '2020-02-01T00:00:00+00:00' }, existing: full.map((d) => ({ ...d, startsAt: '2020-01-01T00:00:00+00:00', endsAt: '2020-03-01T00:00:00+00:00' })) }, error: null });
    await expect(validateAdminDiscountActivation(client, actor, id, { stopped: false })).resolves.toBeUndefined();
    expect(rpc.mock.calls[0]).toEqual(['get_admin_discount_activation_context', { _discount_id: id, _patch: { stopped: false }, _actor_id: actor }]);
    // 目録のDB拒否（使用後の項目・権限）はそのまま公開する
    rpc.mockReset().mockResolvedValueOnce({ data: null, error: { message: 'GROUP_H_USED_FIELDS_LOCKED', code: '55000' } });
    expect((await caught(validateAdminDiscountActivation(client, actor, id, { kind: 'set' }))).code).toBe('GROUP_H_USED_FIELDS_LOCKED');
    // 目録の不正JSONは500
    for (const data of [null, {}, { candidate, existing: [{ id }] }, { candidate: { ...candidate, extra: 1 }, existing: [] }, { candidate: { ...candidate, startsAt: 'nope' }, existing: [] }]) {
      rpc.mockReset().mockResolvedValue({ data, error: null });
      expect((await caught(validateAdminDiscountActivation(client, actor, id, { name: 'x' }))).status).toBe(500);
    }
  });

  test('FREQ-547-AC-05: 割り当て・解除・束のRPC引数と戻り値の突き合わせ', async () => {
    const users = [uuid(5), uuid(6)];
    rpc.mockResolvedValueOnce({ data: { discountId: id, changedCount: 2, replayed: false }, error: null });
    expect(await assignAdminDiscount(client, actor, id, code, users, key)).toEqual({ discountId: id, changedCount: 2, replayed: false });
    expect(rpc).toHaveBeenLastCalledWith('admin_assign_discount', { _discount_id: id, _code_id: code, _user_ids: users, _request_key: key, _actor_id: actor });
    rpc.mockResolvedValueOnce({ data: { discountId: id, changedCount: 1, replayed: true }, error: null });
    expect(await unassignAdminDiscount(client, actor, id, code, users[0], key)).toMatchObject({ replayed: true });
    expect(rpc).toHaveBeenLastCalledWith('admin_unassign_discount', { _discount_id: id, _code_id: code, _user_id: users[0], _request_key: key, _actor_id: actor });
    // 束: 空のuserIdsは誰でも使える束としてNULLを渡す
    const result = { discountId: id, batchId: uuid(8), replayed: false, codes: [{ codeId: code, code: 'AB-2345', userId: null }, { codeId: uuid(4), code: 'AB-6789', userId: null }] };
    rpc.mockResolvedValueOnce({ data: result, error: null });
    expect(await generateAdminDiscountCodes(client, actor, id, 'AB', [], 2, key)).toEqual(result);
    expect(rpc).toHaveBeenLastCalledWith('admin_generate_discount_codes', { _discount_id: id, _prefix: 'AB', _user_ids: null, _count: 2, _request_key: key, _actor_id: actor });
    const assigned = { ...result, codes: result.codes.map((c, i) => ({ ...c, userId: users[i] })) };
    rpc.mockResolvedValueOnce({ data: assigned, error: null });
    expect(await generateAdminDiscountCodes(client, actor, id, 'AB', users, 2, key)).toEqual(assigned);
    expect(rpc).toHaveBeenLastCalledWith('admin_generate_discount_codes', expect.objectContaining({ _user_ids: users }));
    // 順序違い・人数違いは成功にしない
    rpc.mockResolvedValueOnce({ data: { ...assigned, codes: [...assigned.codes].reverse().map((c, i) => ({ ...c, userId: users[i === 0 ? 1 : 0] })) }, error: null });
    expect((await caught(generateAdminDiscountCodes(client, actor, id, 'AB', users, 2, key))).status).toBe(500);
    // 配列の上限と件数不一致はDBを呼ばない
    rpc.mockClear();
    expect((await caught(assignAdminDiscount(client, actor, id, code, [], key))).code).toBe('GROUP_H_ARGUMENT_INVALID');
    expect((await caught(assignAdminDiscount(client, actor, id, code, Array.from({ length: 101 }, (_, i) => uuid(i + 10)), key))).code).toBe('GROUP_H_ARGUMENT_INVALID');
    expect((await caught(generateAdminDiscountCodes(client, actor, id, 'AB', users, 3, key))).code).toBe('GROUP_H_ARGUMENT_INVALID');
    expect(rpc).not.toHaveBeenCalled();
  });
});
