/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, createDraft, ensureFixturePaidAllocation, insertReturnRecord } from './helpers/order-fixtures';
import { seedGroupG1Shipment } from './helpers/group-g1-fixtures';
import { dropH2Additions, hDiscount, seedHDiscount, seedHOrderUnits } from './helpers/group-h-fixtures';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_h_discounts_foundation.sql'));
const sql = files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '';
const section = (name: string) => sql.split(`-- H1_${name}_BEGIN\n`)[1]?.split(`-- H1_${name}_END`)[0] ?? '';

describeLocalDb('H1 foundation: controller reset required', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function reject(run: () => Promise<unknown>, code: string, message?: string) {
    await db().query('savepoint h_expected');
    let caught: { code?: string; message?: string } | undefined;
    try { await run(); } catch (error) { caught = error as typeof caught; }
    finally { await db().query('rollback to savepoint h_expected'); await db().query('release savepoint h_expected'); }
    expect(caught?.code).toBe(code);
    if (message) expect(caught?.message === message).toBe(true);
  }
  async function actor(role: 'admin' | 'supporter' | 'user') {
    const id = randomUUID();
    await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [id]);
    await db().query('insert into public.user_roles(user_id,role_id) select $1,id from public.roles where code=$2', [id, role]);
    return id;
  }
  async function service<T>(run: () => Promise<T>) {
    await db().query('set local role service_role');
    const value = await run();
    await db().query('reset role');
    return value;
  }
  const read = async (orderId: string) => (await db().query(
    'select * from private.order_line_discounts($1) order by order_item_id', [orderId])).rows;

  test('FREQ-542-AC-01: 関係ない明細更新と旧注文の更新は遅延イベントを作らずtriggerを再有効化できる', async () => {
    const discount = await seedHDiscount(db(), hDiscount());
    const lines = [{ itemPrice: 20000, quantity: 1, discounts: [{ discountId: discount, amount: 3000 }], unitAmounts: [17000] }];
    const stored = await seedHOrderUnits(db(), { legacy: false, lines });
    const legacy = await seedHOrderUnits(db(), { legacy: true, lines });
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
    for (const order of [stored, legacy]) {
      await db().query('update public.order_items set color=color where id=$1', [order.orderItemIds[0]]);
      await db().query('alter table public.order_items enable trigger protect_legal_order_item_immutable_fields');
    }
    await db().query('update public.order_items set quantity=quantity where id=$1', [legacy.orderItemIds[0]]);
    await db().query('alter table public.order_items enable trigger protect_legal_order_item_immutable_fields');
    // Relevant updates on H orders still queue the deferred protection.
    await reject(async () => {
      await db().query('update public.order_items set quantity=quantity where id=$1', [stored.orderItemIds[0]]);
      await db().query('alter table public.order_items enable trigger protect_legal_order_item_immutable_fields');
    }, '55006');
  });

  test('FREQ-542-AC-01: 遅延検査時に既に消えた明細はRESTRICTの保護に任せて通す', async () => {
    await db().query(`create temp table h1_deleted_line_event(order_item_id uuid) on commit drop;
      create constraint trigger h1_missing_line after insert on h1_deleted_line_event deferrable initially deferred
        for each row execute function private.group_h_validate_line();
      insert into h1_deleted_line_event values(gen_random_uuid());
      delete from h1_deleted_line_event;
      set constraints all immediate`);
  });

  test('FREQ-542-AC-01: Hの７表は不正な値と直接DMLを拒み保存した金額を変えられない', async () => {
    const id = await seedHDiscount(db(), hDiscount());
    for (const patch of [
      "name=' '", "kind='other'", "method='other'", "value_type='other'", 'value=100', 'value=0',
      "value_type='amount',value=100,minimum_type='none'", "value_type='amount',value=100,minimum_type='amount',minimum_value=100",
      "minimum_type='quantity',minimum_value=0", "target_mode='include'", "audience='assigned',allow_guests=true",
      "method='automatic',allow_guests=false", 'advertise=true', 'usage_limit=0', 'version=0',
      "ends_at=starts_at", "kind='repeat',target_mode='include'", "kind='order_amount',value_type='percent'",
      'search_attention_count=-1', "admin_requests='[]'::jsonb",
    ]) await reject(() => db().query(`update public.discounts set ${patch} where id=$1`, [id]), '23514');
    const catalog = await createCatalogFixture(db());
    await reject(() => db().query('insert into public.discount_items values($1,$2,now())', [id, catalog.itemId]), '23514');
    await reject(() => db().query("insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use) values($1,'lower','anyone',false,false)", [id]), '23514');
    await reject(() => db().query("insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use) values($1,'MISSING','anyone',false,false)", [randomUUID()]), '23503');
    await reject(() => db().query(`insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use,batch_id)
      values($1,'H-NOUSER-ABCD','assigned',false,true,gen_random_uuid())`, [id]), '23514');
    const assigned = await seedHDiscount(db(), hDiscount({ audience: 'assigned', code: 'H-SHARED' }));
    const code = (await db().query('select id from public.discount_codes where discount_id=$1', [assigned])).rows[0].id as string;
    await reject(() => db().query('insert into public.discount_assignments(discount_id,code_id) values($1,$2)', [id, code]), '23503');
    await reject(async () => {
      await db().query("insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use,batch_id) values($1,'H-ABCD','anyone',false,true,gen_random_uuid())", [assigned]);
      await db().query('set constraints all immediate');
    }, '23514');
    const set = await seedHDiscount(db(), hDiscount({ kind: 'set', targetMode: 'include', itemIds: [catalog.itemId] }));
    await reject(() => db().query('set constraints all immediate'), '23514');
    const second = await createCatalogFixture(db());
    await db().query('insert into public.discount_items(discount_id,item_id) values($1,$2)', [set, second.itemId]);
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
    const order = await seedHOrderUnits(db(), { legacy: false, lines: [
      { itemPrice: 20000, quantity: 2, discounts: [{ discountId: id, amount: 3000 }], unitAmounts: [17000, 20000] },
    ] });
    await db().query('set constraints all immediate');
    await reject(() => db().query(`insert into public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount)
      values($1,$2,$3,-1)`, [order.orderId, order.orderItemIds[0], assigned]), '23514');
    await reject(() => db().query('delete from public.discounts where id=$1', [id]), '23503');
    for (const [state, amount] of [['invalid', 0], ['reserved', -1]]) await reject(() => db().query(`insert into public.discount_redemptions
      (discount_id,order_id,identity_key,state,name_snapshot,class_snapshot,amount,first_order_only_snapshot)
      values($1,$2,'fixture',$3,'H fixture','product',$4,false)`, [id, order.orderId, state, amount]), '23514');
    for (const table of ['order_line_discount_allocations', 'order_line_unit_amounts']) {
      await reject(() => db().query(`update public.${table} set order_id=order_id where order_id=$1`, [order.orderId]), '55000');
      await reject(() => db().query(`delete from public.${table} where order_id=$1`, [order.orderId]), '55000');
    }
    for (const bad of [
      { quantity: 2, unitAmounts: [17000] }, { quantity: 2, unitAmounts: [17000, 19999] },
      { quantity: 1, unitAmounts: [-1] },
    ]) await reject(async () => {
      await db().query('set constraints all deferred');
      await seedHOrderUnits(db(), { legacy: false, lines: [{ itemPrice: 20000, ...bad, discounts: [{ discountId: id, amount: 3000 }] }] });
      await db().query('set constraints all immediate');
    }, '23514');
    await reject(() => db().query(`insert into public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount)
      values($1,$2,3,0)`, [order.orderId, order.orderItemIds[0]]), '23514');
    await reject(() => db().query(`insert into public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount)
      values($1,$2,0,0)`, [randomUUID(), order.orderItemIds[0]]), '23503');
    const tables = ['discounts', 'discount_items', 'discount_codes', 'discount_assignments', 'discount_redemptions',
      'order_line_discount_allocations', 'order_line_unit_amounts'];
    for (const role of ['anon', 'authenticated', 'service_role']) for (const table of tables) {
      for (const command of [`select * from public.${table}`, `insert into public.${table} default values`,
        `update public.${table} set created_at=created_at`, `delete from public.${table}`, `truncate public.${table}`]) {
        await reject(async () => { await db().query(`set local role ${role}`); await db().query(command); }, '42501');
      }
    }
    for (const table of tables) for (const privilege of ['REFERENCES', 'TRIGGER']) {
      expect((await db().query('select has_table_privilege($1,$2,$3) as allowed', ['service_role', `public.${table}`, privilege])).rows[0].allowed).toBe(false);
    }
  });

  test('FREQ-542-AC-02: 保存した3000円は対象行だけに付き旧注文の配分と交換0を保つ', async () => {
    const id = await seedHDiscount(db(), hDiscount());
    const lines = [
      { itemPrice: 20000, quantity: 2, discounts: [{ discountId: id, amount: 3000 }], unitAmounts: [17000, 20000] },
      { itemPrice: 10000, quantity: 1, discounts: [], unitAmounts: [10000] },
    ];
    const stored = await seedHOrderUnits(db(), { legacy: false, lines });
    expect(await read(stored.orderId)).toEqual(stored.orderItemIds.map((order_item_id, index) => ({ order_item_id, line_discount: index ? 0 : 3000 }))
      .sort((a, b) => a.order_item_id.localeCompare(b.order_item_id)));
    const legacy = await seedHOrderUnits(db(), { legacy: true, lines });
    expect(await read(legacy.orderId)).toEqual(legacy.orderItemIds.map((order_item_id, index) => ({ order_item_id, line_discount: index ? 600 : 2400 }))
      .sort((a, b) => a.order_item_id.localeCompare(b.order_item_id)));
    // Reuse the exact legacy SQL as an oracle for rounding, including zero-valued lines.
    const oldSql = fs.readFileSync(path.join(directory, '20261013001143_order_return_receipts.sql'), 'utf8');
    const oldBody = oldSql.match(/CREATE OR REPLACE FUNCTION private\.order_line_discounts[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];
    expect(oldBody).toBeDefined();
    await db().query(`create function pg_temp.h_legacy(_order_id uuid) returns table(order_item_id uuid,line_discount integer)
      language sql stable set search_path='' as $legacy$${oldBody}$legacy$`);
    expect(await read(legacy.orderId)).toEqual((await db().query('select * from pg_temp.h_legacy($1) order by order_item_id', [legacy.orderId])).rows);
    for (const order of [stored, legacy]) {
      const orderItemId = order.orderItemIds[0];
      await ensureFixturePaidAllocation(db(), [{ order_item_id: orderItemId, quantity: 1 }]);
      const fulfillmentId = await seedGroupG1Shipment(db(), { orderId: order.orderId,
        lines: [{ orderItemId, quantity: 1 }], shippedAt: new Date().toISOString() });
      const item = (await db().query('select item_id,variant_id from public.order_items where id=$1', [orderItemId])).rows[0];
      const returned = await insertReturnRecord(db(), { orderId: order.orderId, lines: [{ fulfillmentId, orderItemId,
        quantity: 1, resolution: 'exchange', exchangeVariantId: item.variant_id, exchangeMethod: 'make' }] });
      const exchangeId = (await db().query(`insert into public.order_items(order_id,item_id,variant_id,item_name,item_price,
        quantity,line_total,line_kind,exchange_paid_amount,exchange_return_line_id,fulfillment_type)
        values($1,$2,$3,'Exchange',0,1,0,'exchange',0,$4,'backorder') returning id`,
      [order.orderId, item.item_id, item.variant_id, returned.lineIds[0]])).rows[0].id as string;
      expect(await read(order.orderId)).toContainEqual({ order_item_id: exchangeId, line_discount: 0 });
    }
    await db().query('set constraints all immediate');
  });

  test('FREQ-542-AC-03: 旧draftの４欄はNULLで半端な固定欄はCHECK違反', async () => {
    const item = await createCatalogFixture(db());
    const draft = await createDraft(db(), { itemId: item.itemId });
    expect((await db().query(`select discount_result,discount_facts,discount_engine_version,discount_snapshot_hash
      from public.checkout_drafts where id=$1`, [draft.draftId])).rows[0]).toEqual({
      discount_result: null, discount_facts: null, discount_engine_version: null, discount_snapshot_hash: null,
    });
    for (const patch of ["discount_result='{}'", "discount_engine_version=1", "discount_snapshot_hash=repeat('a',64)",
      "discount_result='{}',discount_facts='{}',discount_engine_version=1,discount_snapshot_hash=repeat('a',64)",
      `discount_result='{"version":1,"allocations":{},"unitAmounts":[]}',discount_facts='{}',discount_engine_version=1,discount_snapshot_hash=repeat('a',64)`]) {
      await reject(() => db().query(`update public.checkout_drafts set ${patch} where id=$1`, [draft.draftId]), '23514');
    }
    await db().query(`update public.checkout_drafts set discount_result='{"version":1,"allocations":[],"unitAmounts":[]}',
      discount_facts='{}',discount_engine_version=1,discount_snapshot_hash=repeat('a',64) where id=$1`, [draft.draftId]);
  });

  test('FREQ-543-AC-01: 32コードの初期登録は店長だけへ２件を付与し店長の版だけを1増やす', async () => {
    expect(section('PERMISSION_SEED')).not.toBe('');
    const admin = await actor('admin');
    // Reconstruct pre-H1 in this disposable transaction, then apply the actual H1 seed, without repair DML in production.
    await db().query(`delete from public.role_permissions rp using public.permissions p where rp.permission_id=p.id
      and p.code in ('admin.discounts.read','admin.discounts.manage');
      delete from public.permissions where code in ('admin.discounts.read','admin.discounts.manage');
      update public.roles set permissions_version=permissions_version-1 where code='admin'`);
    const before = (await db().query('select id,code,permissions_version::text as version from public.roles order by id')).rows;
    const grants = (await db().query('select * from public.role_permissions order by role_id,permission_id')).rows;
    await db().query(section('PERMISSION_SEED'));
    // H1's whole-schema assert predates H2: hide only H2's additions inside a savepoint, run the unmodified assert, then restore them.
    await db().query('savepoint h1_rerun');
    await dropH2Additions(db());
    await db().query(section('FINAL_ASSERT'));
    await db().query('rollback to savepoint h1_rerun');
    await db().query('release savepoint h1_rerun');
    const after = (await db().query('select id,code,permissions_version::text as version from public.roles order by id')).rows;
    expect(after).toEqual(before.map((r) => ({ ...r, version: (BigInt(r.version) + (r.code === 'admin' ? BigInt(1) : BigInt(0))).toString() })));
    expect((await db().query(`select rp.* from public.role_permissions rp join public.permissions p on p.id=rp.permission_id
      where p.code not in ('admin.discounts.read','admin.discounts.manage') order by rp.role_id,rp.permission_id`)).rows).toEqual(grants);
    expect((await db().query(`select r.code,p.code as permission from public.role_permissions rp join public.roles r on r.id=rp.role_id
      join public.permissions p on p.id=rp.permission_id where p.code in ('admin.discounts.read','admin.discounts.manage') order by p.code`)).rows)
      .toEqual(['admin.discounts.manage', 'admin.discounts.read'].map((permission) => ({ code: 'admin', permission })));
    const matrix = await service(async () => (await db().query('select public.admin_get_permissions($1) as r', [admin])).rows[0].r);
    expect(matrix.permissionCodes).toHaveLength(32);
    const prior = before.find((r) => r.code === 'admin')!.version;
    await reject(() => service(() => db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5)',
      [admin, 'admin', matrix.permissionCodes, prior, randomUUID()])), 'P0001', 'ROLE_PERMISSION_VERSION_CONFLICT');
    const version = after.find((r) => r.code === 'admin')!.version;
    const saved = await service(async () => (await db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5) as r',
      [admin, 'admin', matrix.permissionCodes, version, randomUUID()])).rows[0].r);
    expect(saved.changedCount).toBe(0);
    expect(saved.role.permissionCodes).toEqual(matrix.permissionCodes);
    await reject(() => service(() => db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5)',
      [admin, 'admin', [...matrix.permissionCodes, 'other'], version, randomUUID()])), '22023', 'ROLE_PERMISSION_ARGUMENT_INVALID');
  });

  test('FREQ-543-AC-01: DBは無効な役割と期限切れuser_rolesと足りない権限を42501で拒む', async () => {
    const admin = await actor('admin');
    const inactive = await actor('admin');
    const expired = await actor('admin');
    const supporter = await actor('supporter');
    await db().query('update public.user_roles set active=false where user_id=$1', [inactive]);
    await db().query("update public.user_roles set expires_at=now()-interval '1 second' where user_id=$1", [expired]);
    // Deliberately no JWT/aal/session: service_role delegates only the trusted actor id.
    expect((await service(async () => (await db().query('select public.admin_get_permissions($1) as r', [admin])).rows[0].r)).permissionCodes).toHaveLength(32);
    for (const id of [inactive, expired, supporter, await actor('user'), randomUUID()]) {
      await reject(() => service(() => db().query('select public.admin_get_permissions($1)', [id])), '42501', 'ROLE_PERMISSION_FORBIDDEN');
      await reject(() => service(() => db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5)',
        [id, 'supporter', [], '0', randomUUID()])), '42501', 'ROLE_PERMISSION_FORBIDDEN');
    }
    expect((await db().query(`select private.group_g_actor_has_permissions($1,array['admin.discounts.read','admin.discounts.manage']) as ok`, [admin])).rows[0].ok).toBe(true);
    expect((await db().query(`select private.group_g_actor_has_permissions($1,array['admin.discounts.read']) as ok`, [supporter])).rows[0].ok).toBe(false);
  });

  test('FREQ-542-AC-01: 利用者を消すと会員FKだけがNULLになり割引と使用と金額は残る', async () => {
    const member = await actor('user');
    const other = await actor('user');
    const id = await seedHDiscount(db(), hDiscount({ audience: 'assigned', code: 'H-ASSIGNED', userIds: [member] }));
    await db().query('update public.discounts set created_by=$1,updated_by=$1 where id=$2', [member, id]);
    const codeId = (await db().query('select id from public.discount_codes where discount_id=$1', [id])).rows[0].id as string;
    const single = await seedHDiscount(db(), hDiscount({ audience: 'assigned' }));
    const singleId = (await db().query(`insert into public.discount_codes(discount_id,code,audience,allow_guests,single_use,batch_id,assigned_user_id)
      values($1,'H-BATCH-ABCD','assigned',false,true,gen_random_uuid(),$2) returning id`, [single, member])).rows[0].id as string;
    const order = await seedHOrderUnits(db(), { legacy: false, lines: [{ itemPrice: 20000, quantity: 2,
      discounts: [{ discountId: id, amount: 3000 }], unitAmounts: [17000, 20000] }] });
    await db().query(`insert into public.discount_redemptions(discount_id,code_id,order_id,user_id,identity_key,state,
      name_snapshot,code_snapshot,class_snapshot,amount,first_order_only_snapshot,attention_kind,attention_resolved_at,attention_resolved_by)
      values($1,$2,$3,$4::uuid,$4::text,'confirmed','H fixture','H-ASSIGNED','product',3000,false,'discount_limit_exceeded',now(),$4::uuid)`,
    [id, codeId, order.orderId, member]);
    const before = await read(order.orderId);
    // No definition trigger may run during FK SET NULL; those paths must not take the G lock.
    await db().query('set constraints all immediate');
    await db().query(`create or replace function private.group_h_validate_definition() returns trigger
      language plpgsql security definer set search_path='' as $$begin raise exception 'H1_USER_DELETE_TRIGGER_RAN'; end$$`);
    await db().query('set constraints all deferred');
    await db().query('delete from auth.users where id=$1', [member]);
    expect((await db().query('select created_by,updated_by from public.discounts where id=$1', [id])).rows[0]).toEqual({ created_by: null, updated_by: null });
    expect((await db().query('select user_id from public.discount_assignments where code_id=$1', [codeId])).rows).toEqual([{ user_id: null }]);
    expect((await db().query('select user_id,attention_resolved_by,amount from public.discount_redemptions where order_id=$1', [order.orderId])).rows)
      .toEqual([{ user_id: null, attention_resolved_by: null, amount: 3000 }]);
    expect((await db().query('select audience,assigned_user_id from public.discount_codes where id=$1', [singleId])).rows[0])
      .toEqual({ audience: 'assigned', assigned_user_id: null });
    await reject(() => db().query('update public.discount_assignments set user_id=$1 where code_id=$2', [other, codeId]), '55000');
    await reject(() => db().query('update public.discount_codes set assigned_user_id=$1 where id=$2', [other, singleId]), '55000');
    await reject(() => db().query("update public.discount_codes set audience='anyone' where id=$1", [singleId]), '55000');
    await reject(() => db().query('update public.discount_codes set single_use=false,batch_id=null where id=$1', [singleId]), '55000');
    for (const buyer of [other, randomUUID()]) expect((await db().query(`select exists(select 1 from public.discount_codes c
      where c.id=any($1::uuid[]) and (c.audience='anyone' or c.assigned_user_id=$2 or exists(
        select 1 from public.discount_assignments a where a.code_id=c.id and a.user_id=$2))) as eligible`, [[codeId, singleId], buyer])).rows[0].eligible).toBe(false);
    expect(await read(order.orderId)).toEqual(before);
    expect((await db().query('select paid_amount from public.order_line_unit_amounts where order_id=$1 order by unit_index', [order.orderId])).rows)
      .toEqual([{ paid_amount: 17000 }, { paid_amount: 20000 }]);
    await db().query('set constraints all immediate');
  });
});
