/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { createCatalogFixture } from './helpers/order-fixtures';
import { hDiscount, hRpc, hFailure, seedHMember, seedHRedemption, seedHDiscount } from './helpers/group-h-fixtures';

type Created = { discountId: string; version: string; replayed: boolean };
type Assignment = { rowId: string; codeId: string; code: string; userId: string | null; assigneeDeleted: boolean;
  assigneeName: string | null; guestEmailMasked: string | null; status: string; usedAt: string | null; orderId: string | null };
type Detail = { discount: { id: string; version: string; stopped: boolean }; used: boolean;
  assignmentTotal: number; assignments: Assignment[]; searchAttention: { openedAt: string; count: number } | null };

describeLocalDb('H2 admin writers and snapshot reads (controller only)', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string;
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); actor = await flow.manager(); });
  afterEach(async () => { await db().query('rollback'); });
  const create = (input = hDiscount(), key = randomUUID()) => hRpc<Created>(db(), 'admin_create_discount', [input, key, actor]);
  const detail = (id: string, limit = 20, offset = 0) => hRpc<Detail>(db(), 'get_admin_discount', [id, limit, offset, actor]);

  test('FREQ-547-AC-02: 作成と複製と停止と解除も元の結果を再送しactorや操作が違う要求キーを拒む', async () => {
    const input = hDiscount({ audience: 'assigned', code: `REPLAY-${randomUUID().toUpperCase()}` }); const createKey = randomUUID();
    const made = await create(input, createKey);
    expect(await create(input, createKey)).toEqual({ ...made, replayed: true });
    const otherActor = await flow.manager();
    expect(await hFailure(db(), () => hRpc(db(), 'admin_create_discount', [input, createKey, otherActor])))
      .toEqual({ code: '23505', message: 'GROUP_H_REQUEST_KEY_CONFLICT' });
    const duplicateKey = randomUUID();
    const copy = await hRpc<Created>(db(), 'admin_duplicate_discount', [made.discountId, duplicateKey, actor]);
    expect(await hRpc(db(), 'admin_duplicate_discount', [made.discountId, duplicateKey, actor])).toEqual({ ...copy, replayed: true });
    const stopKey = randomUUID();
    const stopped = await hRpc<Created>(db(), 'admin_set_discount_stopped', [made.discountId, true, 1, stopKey, actor]);
    expect(await hRpc(db(), 'admin_set_discount_stopped', [made.discountId, true, 1, stopKey, actor])).toEqual({ ...stopped, replayed: true });
    expect(await create(input, createKey)).toEqual({ ...made, replayed: true });
    const member = await seedHMember(db());
    const code = (await db().query('select id from public.discount_codes where discount_id=$1', [made.discountId])).rows[0].id as string;
    await hRpc(db(), 'admin_assign_discount', [made.discountId, code, [member], randomUUID(), actor]);
    const removeKey = randomUUID();
    const removed = await hRpc(db(), 'admin_unassign_discount', [made.discountId, code, member, removeKey, actor]);
    expect(await hRpc(db(), 'admin_unassign_discount', [made.discountId, code, member, removeKey, actor])).toEqual({ ...(removed as object), replayed: true });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_duplicate_discount', [made.discountId, removeKey, actor])))
      .toEqual({ code: '23505', message: 'GROUP_H_REQUEST_KEY_CONFLICT' });
  });

  test('FREQ-547-AC-01: 一覧は予定・有効・期限切れ・止めたと予約込み回数を返し、絞り込みと頁が一致する', async () => {
    const now = (await db().query('select now() as n')).rows[0].n as Date;
    const active = await create(hDiscount({ name: 'literal%_\\', startsAt: now.toISOString(), code: `H-${randomUUID().toUpperCase()}` }));
    const scheduled = await create(hDiscount({ startsAt: new Date(+now + 60000).toISOString() }));
    const expired = await create(hDiscount({ endsAt: now.toISOString() }));
    const stopped = await create(hDiscount({ stopped: true, startsAt: new Date(+now + 60000).toISOString() }));
    await seedHRedemption(db(), active.discountId, { state: 'reserved' });
    await seedHRedemption(db(), active.discountId, { state: 'confirmed' });
    await seedHRedemption(db(), active.discountId, { state: 'cancelled' });
    type List = { total: number; rows: { id: string; status: string; usedCount: number }[] };
    const all = await hRpc<List>(db(), 'list_admin_discounts', [{}, 100, 0, actor]);
    for (const [id, status] of [[active.discountId, 'active'], [scheduled.discountId, 'scheduled'], [expired.discountId, 'expired'], [stopped.discountId, 'stopped']]) {
      expect(all.rows.find(r => r.id === id)?.status).toBe(status);
    }
    expect(all.rows.find(r => r.id === active.discountId)?.usedCount).toBe(2);
    const literal = await hRpc<List>(db(), 'list_admin_discounts', [{ query: '%_\\' }, 20, 0, actor]);
    expect(literal.rows.map(r => r.id)).toEqual([active.discountId]);
    const filtered = await hRpc<List>(db(), 'list_admin_discounts', [{ status: 'scheduled', kind: 'product', method: 'code' }, 1, 0, actor]);
    expect(filtered.rows.map(r => r.id)).toContain(scheduled.discountId);
    expect((await hRpc<List>(db(), 'list_admin_discounts', [{ status: 'scheduled', kind: 'product', method: 'code' }, 1, 1, actor])).total).toBe(filtered.total);
    for (const filters of [{ unknown: true }, { query: '' }, { query: 'x'.repeat(101) }, { status: 'bad' }]) {
      expect(await hFailure(db(), () => hRpc(db(), 'list_admin_discounts', [filters, 20, 0, actor]))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    }
    expect(await hFailure(db(), () => hRpc(db(), 'list_admin_discounts', [{}, 101, 0, actor]))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
  });

  test('FREQ-547-AC-02: 使用後は許可した６項目だけ変更でき、複製は使用と割り当てを引き継がない', async () => {
    const user = await seedHMember(db());
    const made = await create(hDiscount({ audience: 'assigned', code: `USED-${randomUUID().toUpperCase()}`, userIds: [user] }));
    await seedHRedemption(db(), made.discountId, { userId: user, state: 'cancelled' });
    expect((await detail(made.discountId)).used).toBe(true);
    const forbidden = { kind: 'repeat', method: 'automatic', value: { type: 'percent', value: 20 }, targetMode: 'exclude', itemIds: [],
      minimum: { type: 'quantity', value: 2 }, audience: 'anyone', allowGuests: true, firstOrderOnly: true, oncePerCustomer: true,
      combinesWithProduct: true, combinesWithOrder: true, repeatPrevious: true, repeatInOrder: true, code: 'NEW', userIds: [user], stopped: true };
    for (const [key, value] of Object.entries(forbidden)) expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount',
      [made.discountId, { [key]: value }, 1, randomUUID(), actor]))).toEqual({ code: '55000', message: 'GROUP_H_USED_FIELDS_LOCKED' });
    const key = randomUUID();
    const patch = { name: 'renamed', startsAt: '2026-02-01T00:00:00Z', endsAt: '2030-01-01T00:00:00Z', usageLimit: 20, advertise: false, advertisingText: 'notice' };
    const changed = await hRpc<Created>(db(), 'admin_update_discount', [made.discountId, patch, 1, key, actor]);
    expect(changed.version).toBe('2');
    expect(await hRpc(db(), 'admin_update_discount', [made.discountId, patch, 1, key, actor])).toEqual({ ...changed, replayed: true });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount', [made.discountId, { name: 'stale' }, 1, randomUUID(), actor])))
      .toEqual({ code: '40001', message: 'GROUP_H_VERSION_CONFLICT' });
    const clone = await hRpc<Created>(db(), 'admin_duplicate_discount', [made.discountId, randomUUID(), actor]);
    expect(clone.version).toBe('1'); expect(clone.discountId).not.toBe(made.discountId);
    expect(await detail(clone.discountId)).toMatchObject({ used: false, assignmentTotal: 0, discount: { stopped: true } });
    expect((await db().query('select count(*)::int n from public.discount_codes where discount_id=$1', [clone.discountId])).rows[0].n).toBe(0);
    expect(await hFailure(db(), () => hRpc(db(), 'admin_set_discount_stopped', [clone.discountId, false, 1, randomUUID(), actor])))
      .toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    await hRpc(db(), 'admin_set_discount_stopped', [made.discountId, true, 2, randomUUID(), actor]);
    await hRpc(db(), 'admin_set_discount_stopped', [made.discountId, false, 3, randomUUID(), actor]);
    expect((await detail(made.discountId)).used).toBe(true);
  });

  test('FREQ-547-AC-03: 同じコードを10人に割り当てると10行で、予約・確定・取消と最新注文を区別しゲストを伏せる', async () => {
    const users: string[] = []; for (let i = 0; i < 10; i++) users.push(await seedHMember(db()));
    const made = await create(hDiscount({ audience: 'assigned', code: `TEN-${randomUUID().toUpperCase()}` }));
    const code = (await db().query('select id from public.discount_codes where discount_id=$1', [made.discountId])).rows[0].id as string;
    const key = randomUUID();
    expect(await hRpc(db(), 'admin_assign_discount', [made.discountId, code, users, key, actor])).toMatchObject({ changedCount: 10 });
    expect(await hRpc(db(), 'admin_assign_discount', [made.discountId, code, users, key, actor])).toMatchObject({ changedCount: 10, replayed: true });
    expect(await hRpc(db(), 'admin_assign_discount', [made.discountId, code, users, randomUUID(), actor])).toMatchObject({ changedCount: 0 });
    for (const invalid of [[], [users[0], users[0]], [randomUUID()], Array<string>(101).fill(users[0])]) {
      expect(await hFailure(db(), () => hRpc(db(), 'admin_assign_discount', [made.discountId, code, invalid, randomUUID(), actor])))
        .toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    }
    const reserved = await seedHRedemption(db(), made.discountId, { codeId: code, userId: users[0], state: 'reserved' });
    await seedHRedemption(db(), made.discountId, { codeId: code, userId: users[1], state: 'cancelled' });
    let rows = (await detail(made.discountId)).assignments;
    expect(rows).toHaveLength(10); expect(rows.find(r => r.userId === users[0])).toMatchObject({ status: 'reserved', orderId: reserved.orderId });
    expect(rows.find(r => r.userId === users[0])?.usedAt).not.toBeNull();
    expect(rows.find(r => r.userId === users[1])).toMatchObject({ status: 'unused', usedAt: null, orderId: null });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_unassign_discount', [made.discountId, code, users[0], randomUUID(), actor])))
      .toEqual({ code: '55000', message: 'GROUP_H_ASSIGNMENT_USED' });
    await db().query("update public.discount_redemptions set state='confirmed',confirmed_at=now() where id=$1", [reserved.id]);
    expect((await detail(made.discountId)).assignments.find(r => r.userId === users[0])?.status).toBe('confirmed');
    await db().query('delete from auth.users where id=$1', [users[2]]);
    rows = (await detail(made.discountId)).assignments;
    expect(rows.find(r => r.assigneeDeleted)).toMatchObject({ userId: null, assigneeName: null, status: 'unused' });
    expect((await detail(made.discountId, 3, 3)).assignments).toEqual(rows.slice(3, 6));
    expect((await detail(made.discountId, 20, 20)).assignments).toEqual([]);
    await hRpc(db(), 'admin_unassign_discount', [made.discountId, code, users[1], randomUUID(), actor]);
    expect((await detail(made.discountId)).assignmentTotal).toBe(9);
    const anyone = await create(hDiscount({ code: `GUEST-${randomUUID().toUpperCase()}`, allowGuests: true }));
    const anyCode = (await db().query('select id from public.discount_codes where discount_id=$1', [anyone.discountId])).rows[0].id as string;
    const earliest = await seedHRedemption(db(), anyone.discountId, { codeId: anyCode, email: 'alice@example.invalid', state: 'confirmed' });
    const latest = await seedHRedemption(db(), anyone.discountId, { codeId: anyCode, email: 'alice@example.invalid', state: 'reserved', reservedAt: '2030-01-01T00:00:00Z' });
    const guestRows = (await detail(anyone.discountId)).assignments;
    expect(guestRows).toHaveLength(1); expect(guestRows[0]).toMatchObject({ guestEmailMasked: 'a***@example.invalid', orderId: latest.orderId });
    expect(JSON.stringify(guestRows)).not.toContain('alice@');
    // The row id derives from the smallest redemption id of that person, never from a hash of the email.
    const rowId = guestRows[0].rowId;
    expect(rowId).toBe(`usage:${anyCode}:${[earliest.id, latest.id].sort()[0]}`);
    for (const personal of ['alice@example.invalid', 'guest:alice@example.invalid'])
      expect(rowId).not.toContain(createHash('md5').update(personal).digest('hex'));
    expect((await detail(anyone.discountId)).assignments[0].rowId).toBe(rowId);
    expect((await detail(anyone.discountId, 1, 0)).assignments[0].rowId).toBe(rowId);
  });

  test('FREQ-547-AC-04: 100個の束は全体で一意で、101と接頭辞だけは使えない', async () => {
    const made = await create(); const key = randomUUID(); const prefix = `B-${randomUUID().slice(0, 8).toUpperCase()}`;
    type Batch = { batchId: string; codes: { codeId: string; code: string; userId: string | null }[]; replayed: boolean };
    const batch = await hRpc<Batch>(db(), 'admin_generate_discount_codes', [made.discountId, prefix, null, 100, key, actor]);
    expect(batch.codes).toHaveLength(100); expect(new Set(batch.codes.map(c => c.code)).size).toBe(100);
    for (const code of batch.codes) expect(code.code).toMatch(new RegExp(`^${prefix}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$`));
    expect(batch.codes.map(c => c.code)).not.toContain(prefix);
    expect(await hRpc(db(), 'admin_generate_discount_codes', [made.discountId, prefix, null, 100, key, actor])).toEqual({ ...batch, replayed: true });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_generate_discount_codes', [made.discountId, prefix, null, 1, key, actor])))
      .toEqual({ code: '23505', message: 'GROUP_H_REQUEST_KEY_CONFLICT' });
    for (const [p, count] of [[prefix, 101], ['BAD-', 1], ['x', 1], ['X'.repeat(56), 1]]) expect(await hFailure(db(), () => hRpc(db(),
      'admin_generate_discount_codes', [made.discountId, p, null, count, randomUUID(), actor]))).toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    const member = await seedHMember(db());
    const assigned = await hRpc<Batch>(db(), 'admin_generate_discount_codes', [made.discountId, 'MEMBER', [member], 1, randomUUID(), actor]);
    expect(assigned.codes[0].code).toMatch(/^MEMBER-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect((await detail(made.discountId, 100)).assignmentTotal).toBe(101);
    expect((await db().query('select audience,allow_guests from public.discount_codes where id=$1', [assigned.codes[0].codeId])).rows[0])
      .toEqual({ audience: 'assigned', allow_guests: false });
    await hRpc(db(), 'admin_unassign_discount', [made.discountId, assigned.codes[0].codeId, member, randomUUID(), actor]);
    expect((await detail(made.discountId)).assignmentTotal).toBe(100);
    expect((await db().query('select unassigned_at is not null as removed from public.discount_codes where id=$1', [assigned.codes[0].codeId])).rows[0].removed).toBe(true);
  });

  test('FREQ-547-AC-02: 未使用の入力も未知キーと不正な値を拒みコードは大文字で全体一意にする', async () => {
    const code = `UNIQUE-${randomUUID().toUpperCase()}`;
    const made = await create(hDiscount({ code: code.toLowerCase() }));
    expect((await db().query('select code from public.discount_codes where discount_id=$1', [made.discountId])).rows[0].code).toBe(code);
    expect(await hFailure(db(), () => create(hDiscount({ code })))).toEqual({ code: '23505', message: 'GROUP_H_CODE_CONFLICT' });
    for (const patch of [{ id: randomUUID() }, { version: '2' }, { name: null }, { kind: null }, { value: { type: null, value: 10 } },
      { value: { type: 'percent', value: 100 } }, { value: { type: 'amount', value: 100 }, minimum: { type: 'amount', value: 100 } },
      { itemIds: [1, 1] }, { startsAt: 'invalid' }, { endsAt: '2025-01-01T00:00:00Z' }]) {
      expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount', [made.discountId, patch, 1, randomUUID(), actor])))
        .toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    }
  });

  test('FREQ-543-AC-01: 管理RPCは無効な役割と期限切れuser_rolesと足りない権限を42501で拒む', async () => {
    const id = (await create()).discountId;
    for (const bad of [await flow.createActor([]), await flow.createActor(['admin'], { inactive: ['admin'] }),
      await flow.createActor(['admin'], { expired: ['admin'] }), await flow.createActor(['supporter'])]) {
      for (const [name, args] of [['admin_create_discount', [hDiscount(), randomUUID()]], ['admin_update_discount', [id, { name: 'x' }, 1, randomUUID()]],
        ['admin_set_discount_stopped', [id, true, 1, randomUUID()]], ['admin_duplicate_discount', [id, randomUUID()]],
        ['admin_assign_discount', [id, randomUUID(), [actor], randomUUID()]], ['admin_unassign_discount', [id, randomUUID(), actor, randomUUID()]],
        ['admin_generate_discount_codes', [id, 'X', null, 1, randomUUID()]], ['list_admin_discounts', [{}, 20, 0]],
        ['get_admin_discount', [id, 20, 0]], ['search_admin_discount_members', ['fi', 20]], ['get_admin_discount_activation_context', [id, {}]]] as [string, unknown[]][]) {
        expect(await hFailure(db(), () => hRpc(db(), name, [...args, bad]))).toEqual({ code: '42501', message: 'GROUP_H_FORBIDDEN' });
      }
    }
    const supporter = await flow.createActor(['supporter']);
    await flow.grant('supporter', ['admin.discounts.manage']);
    await hRpc(db(), 'admin_create_discount', [hDiscount(), randomUUID(), supporter]);
    expect(await hFailure(db(), () => hRpc(db(), 'get_admin_discount', [id, 20, 0, supporter]))).toEqual({ code: '42501', message: 'GROUP_H_FORBIDDEN' });
    await flow.revoke('supporter', ['admin.discounts.manage']); await flow.grant('supporter', ['admin.discounts.read']);
    expect((await hRpc<Detail>(db(), 'get_admin_discount', [id, 20, 0, supporter])).discount.id).toBe(id);
    expect(await hFailure(db(), () => hRpc(db(), 'admin_create_discount', [hDiscount(), randomUUID(), supporter])))
      .toEqual({ code: '42501', message: 'GROUP_H_FORBIDDEN' });
  });

  test('FREQ-547-AC-04: 重ねる自動は分類ごと６件で７件目を保存できず共有itemのセットも拒む', async () => {
    const automatic = hDiscount({ method: 'automatic', allowGuests: true, startsAt: '2200-01-01T00:00:00Z', endsAt: '2201-01-01T00:00:00Z' });
    for (const kind of ['product', 'order_percent'] as const) for (let i = 0; i < 6; i++) await create({ ...automatic, kind, combinesWithOrder: true });
    expect(await hFailure(db(), () => create({ ...automatic, combinesWithProduct: true }))).toEqual({ code: '23514', message: 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' });
    for (let i = 0; i < 13; i++) await create(automatic);
    expect(await hFailure(db(), () => create(automatic))).toEqual({ code: '23514', message: 'GROUP_H_AUTOMATIC_LIMIT' });
    await create({ ...automatic, startsAt: '2199-01-01T00:00:00Z', endsAt: automatic.startsAt });
    const paused = await create({ ...automatic, stopped: true, combinesWithOrder: true });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_set_discount_stopped', [paused.discountId, false, 1, randomUUID(), actor])))
      .toEqual({ code: '23514', message: 'GROUP_H_AUTOMATIC_LIMIT' });
    const later = await create({ ...automatic, startsAt: '2201-01-01T00:00:00Z', endsAt: '2202-01-01T00:00:00Z' });
    await seedHRedemption(db(), later.discountId, { state: 'cancelled' });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount', [later.discountId, { startsAt: automatic.startsAt }, 1, randomUUID(), actor])))
      .toEqual({ code: '23514', message: 'GROUP_H_AUTOMATIC_LIMIT' });
    const a = await createCatalogFixture(db()), b = await createCatalogFixture(db());
    const set = hDiscount({ kind: 'set', targetMode: 'include', itemIds: [a.itemId, b.itemId], combinesWithProduct: true,
      startsAt: '2100-01-01T00:00:00Z', endsAt: '2101-01-01T00:00:00Z' });
    await create(set);
    expect(await hFailure(db(), () => create(set))).toEqual({ code: '23514', message: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' });
    await create({ ...set, startsAt: '2101-01-01T00:00:00Z', endsAt: null });
    expect(await hFailure(db(), async () => { await seedHDiscount(db(), set); await db().query('set constraints all immediate'); }))
      .toEqual({ code: '23514', message: 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' });
  });

  test('FREQ-547-AC-04: 終わった期間の割引は保存時の上限に数えず保存を妨げない', async () => {
    const past = hDiscount({ method: 'automatic', allowGuests: true, combinesWithOrder: true, startsAt: '2020-01-01T00:00:00Z', endsAt: '2021-01-01T00:00:00Z' });
    for (let i = 0; i < 26; i++) await seedHDiscount(db(), past);
    await create({ ...past, startsAt: '2200-01-01T00:00:00Z', endsAt: '2201-01-01T00:00:00Z' });
    await db().query('set constraints all immediate');
  });

  test('FREQ-547-AC-04: コード型はコード無しで有効にできず、束の接頭辞と同じ共有コードは作れない', async () => {
    const invalid = { code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' }, conflict = { code: '23505', message: 'GROUP_H_CODE_CONFLICT' };
    const bare = await create(hDiscount({ stopped: true }));
    expect(await hFailure(db(), () => hRpc(db(), 'get_admin_discount_activation_context', [bare.discountId, { stopped: false }, actor]))).toEqual(invalid);
    expect(await hFailure(db(), () => hRpc(db(), 'admin_set_discount_stopped', [bare.discountId, false, 1, randomUUID(), actor]))).toEqual(invalid);
    const auto = await create(hDiscount({ method: 'automatic', allowGuests: true, startsAt: '2300-01-01T00:00:00Z' }));
    expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount', [auto.discountId, { method: 'code' }, 1, randomUUID(), actor]))).toEqual(invalid);
    expect((await hRpc<Created>(db(), 'admin_update_discount', [auto.discountId, { method: 'code', code: `SWITCH-${randomUUID().toUpperCase()}` }, 1, randomUUID(), actor])).version).toBe('2');
    const prefix = `PFX-${randomUUID().slice(0, 8).toUpperCase()}`;
    const owner = await create(hDiscount({ stopped: true }));
    await hRpc(db(), 'admin_generate_discount_codes', [owner.discountId, prefix, null, 1, randomUUID(), actor]);
    await hRpc(db(), 'get_admin_discount_activation_context', [owner.discountId, { stopped: false }, actor]);
    expect(await hFailure(db(), () => create(hDiscount({ code: prefix })))).toEqual(conflict);
    expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount', [bare.discountId, { code: prefix.toLowerCase() }, 1, randomUUID(), actor]))).toEqual(conflict);
    const shared = `SHR-${randomUUID().slice(0, 8).toUpperCase()}`;
    await create(hDiscount({ code: shared }));
    const reverse = await create(hDiscount({ stopped: true }));
    expect(await hFailure(db(), () => hRpc(db(), 'admin_generate_discount_codes', [reverse.discountId, shared, null, 1, randomUUID(), actor]))).toEqual(conflict);
  });

  test('FREQ-547-AC-04: 衝突は同じ長さで再生成し32回尽きると束全体を戻す', async () => {
    const made = await create(); const member = await seedHMember(db());
    await db().query(`create sequence private.h2_suffix_attempt;
      create or replace function private.group_h_random_suffix(_length integer) returns text
      language plpgsql volatile security definer set search_path='' as $$
      declare n bigint := pg_catalog.nextval('private.h2_suffix_attempt');
      begin return case when n<=2 then '2222' else '3333' end; end; $$`);
    const first = await hRpc<{ codes: { code: string }[] }>(db(), 'admin_generate_discount_codes', [made.discountId, 'COLLIDE', [member], 1, randomUUID(), actor]);
    const second = await hRpc<{ codes: { code: string }[] }>(db(), 'admin_generate_discount_codes', [made.discountId, 'COLLIDE', [member], 1, randomUUID(), actor]);
    expect(first.codes[0].code).toBe('COLLIDE-2222'); expect(second.codes[0].code).toBe('COLLIDE-3333');
    await db().query(`alter sequence private.h2_suffix_attempt restart with 1;
      create or replace function private.group_h_random_suffix(_length integer) returns text
      language plpgsql volatile security definer set search_path='' as $$
      declare n bigint := pg_catalog.nextval('private.h2_suffix_attempt');
      begin return case when n=1 then '4444' else '2222' end; end; $$`);
    const other = await seedHMember(db()); const key = randomUUID();
    expect(await hFailure(db(), () => hRpc(db(), 'admin_generate_discount_codes', [made.discountId, 'COLLIDE', [member, other], 2, key, actor])))
      .toEqual({ code: '54000', message: 'GROUP_H_CODE_GENERATION_FAILED' });
    expect(Number((await db().query('select last_value from private.h2_suffix_attempt')).rows[0].last_value)).toBe(33);
    expect((await db().query("select count(*)::int n from public.discount_codes where discount_id=$1 and code='COLLIDE-4444'", [made.discountId])).rows[0].n).toBe(0);
    expect((await db().query('select admin_requests ? $2 as saved from public.discounts where id=$1', [made.discountId, key])).rows[0].saved).toBe(false);
  });

  test('FREQ-547-AC-03: 退会した使用済みの共有割当と結び付けたゲストを二重表示しない', async () => {
    const member = await seedHMember(db());
    const made = await create(hDiscount({ audience: 'assigned', code: `DELETE-${randomUUID().toUpperCase()}`, userIds: [member] }));
    const code = (await db().query('select id from public.discount_codes where discount_id=$1', [made.discountId])).rows[0].id as string;
    await seedHRedemption(db(), made.discountId, { codeId: code, userId: member, state: 'confirmed' });
    await db().query('delete from auth.users where id=$1', [member]);
    expect((await detail(made.discountId)).assignments).toEqual([expect.objectContaining({ assigneeDeleted: true, userId: null, status: 'confirmed' })]);
    const anyone = await create(hDiscount({ allowGuests: true, code: `LINK-${randomUUID().toUpperCase()}` }));
    const anyCode = (await db().query('select id from public.discount_codes where discount_id=$1', [anyone.discountId])).rows[0].id as string;
    const linked = await seedHMember(db());
    await seedHRedemption(db(), anyone.discountId, { codeId: anyCode, email: 'linked@example.invalid', state: 'confirmed' });
    await seedHRedemption(db(), anyone.discountId, { codeId: anyCode, email: 'linked@example.invalid', userId: linked, state: 'reserved' });
    expect((await detail(anyone.discountId)).assignments).toEqual([expect.objectContaining({ userId: linked, guestEmailMasked: null })]);
  });

  test('FREQ-546-AC-04: guardの要対応はcodeを保存せず10分に１回で管理readだけへ出る', async () => {
    const made = await create();
    await hRpc(db(), 'record_discount_search_fallback', [[made.discountId, made.discountId]]);
    await hRpc(db(), 'record_discount_search_fallback', [[made.discountId]]);
    expect((await detail(made.discountId)).searchAttention).toMatchObject({ count: 1 });
    expect((await detail(made.discountId)).discount.version).toBe('1');
    const key = randomUUID();
    await hRpc(db(), 'admin_update_discount', [made.discountId, { acknowledgeSearchAttention: true }, 1, key, actor]);
    await hRpc(db(), 'admin_update_discount', [made.discountId, { acknowledgeSearchAttention: true }, 1, key, actor]);
    expect((await detail(made.discountId)).searchAttention).toBeNull();
    await hRpc(db(), 'record_discount_search_fallback', [[made.discountId]]);
    expect((await detail(made.discountId)).searchAttention).toMatchObject({ count: 2 });
    expect(await hFailure(db(), () => hRpc(db(), 'admin_update_discount', [made.discountId, { acknowledgeSearchAttention: true, name: 'mix' }, 2, randomUUID(), actor])))
      .toEqual({ code: '22023', message: 'GROUP_H_ARGUMENT_INVALID' });
    expect((await db().query('select admin_requests::text as t from public.discounts where id=$1', [made.discountId])).rows[0].t).not.toContain('code');
  });
});
