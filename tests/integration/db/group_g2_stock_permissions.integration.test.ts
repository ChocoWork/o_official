/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, variantStock } from './helpers/order-fixtures';

/**
 * G-2 Task 1: 在庫の入荷・棚卸（admin_record_stock_movement）の権限は admin.stock.manage と admin.stock.read の両方。
 * admin.items.read / admin.items.manage だけでは入荷できない。権限の確認は private.group_g_actor_has_permissions
 * （有効な全ての役割の和集合）に一本化する。各試験は取引の中で動かして最後に rollback する
 * （supporter / user の役割へ足す role_permissions も残さない）。
 */
const STOCK_PAIR = ['admin.stock.manage', 'admin.stock.read'];

describeLocalDb('G-2 Task 1: stock permissions', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function flush() {
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
    await db().query('set constraints all deferred');
  }

  /** 実行者を作り、役割を付ける。expires は役割ごとの期限（SQL の式）、inactive は無効にする役割の code */
  async function createActor(roleCodes: readonly string[], options: { inactive?: readonly string[]; expired?: readonly string[] } = {}): Promise<string> {
    const actor = randomUUID();
    await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [actor]);
    for (const code of roleCodes) {
      await db().query(`insert into public.user_roles(user_id,role_id,active,expires_at)
        select $1::uuid,id,$3::boolean,case when $4::boolean then now() - interval '1 second' else null end
        from public.roles where code=$2::text`,
      [actor, code, !(options.inactive ?? []).includes(code), (options.expired ?? []).includes(code)]);
    }
    return actor;
  }

  async function grant(role: string, codes: string[]) {
    const result = await db().query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p where r.code=$1 and p.code=any($2::text[])
      on conflict do nothing`, [role, codes]);
    expect(result.rowCount).toBe(codes.length);
  }

  async function revoke(role: string, codes: string[]) {
    await db().query(`delete from public.role_permissions where role_id=(select id from public.roles where code=$1)
      and permission_id in (select id from public.permissions where code=any($2::text[]))`, [role, codes]);
  }

  async function move(actor: string, itemId: number, variantId: number, delta = 1, key: string = randomUUID()) {
    const result = (await db().query('select public.admin_record_stock_movement($1,$2,$3,$4,$5,$6,$7,$8) as result',
      [itemId, variantId, delta, 'restock', null, actor, key, null])).rows[0].result;
    await flush();
    return result as { movementId: string; releasedQuantity: number; allocatedQuantity: number; replayed: boolean };
  }

  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code: string; message: string };
      return { code: error.code, message: error.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  async function counts() {
    return (await db().query(`select (select count(*) from public.stock_movements)::int as movements,
      (select count(*) from public.order_item_allocations)::int as allocations,
      (select count(*) from public.order_item_allocation_events)::int as events,
      (select count(*) from public.order_item_state_events)::int as states,
      (select count(*) from private.group_g_operations)::int as operations`)).rows[0];
  }

  const FORBIDDEN = { message: 'GROUP_G_FORBIDDEN', code: '42501' };

  test('FREQ-540-AC-06: admin.items.read/manage だけの実行者の入荷は GROUP_G_FORBIDDEN / 42501 で台帳・在庫・操作の記録が増えない', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    await grant('supporter', ['admin.items.read', 'admin.items.manage']);
    const actor = await createActor(['supporter']);
    // supporter はこの取引の中で items.read / items.manage だけを持つ（stock の権限は無い）
    expect((await db().query(`select p.code from public.user_roles ur join public.role_permissions rp on rp.role_id=ur.role_id
      join public.permissions p on p.id=rp.permission_id where ur.user_id=$1 and p.code like 'admin.items.%' order by p.code`, [actor])).rows
      .map((row) => row.code)).toEqual(['admin.items.manage', 'admin.items.read']);
    const before = await counts();

    expect(await rejected(() => move(actor, c.itemId, c.variantId, 3))).toEqual(FORBIDDEN);

    expect(await counts()).toEqual(before);
    expect(await variantStock(db(), c.variantId)).toBe(0);
  });

  test('FREQ-540-AC-06: stock.manage だけ・stock.read だけはどちらも断られ、両方で入荷できる', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const actor = await createActor(['supporter']);
    const before = await counts();

    await grant('supporter', ['admin.stock.manage']);
    expect(await rejected(() => move(actor, c.itemId, c.variantId, 1))).toEqual(FORBIDDEN);
    await revoke('supporter', ['admin.stock.manage']);

    await grant('supporter', ['admin.stock.read']);
    expect(await rejected(() => move(actor, c.itemId, c.variantId, 1))).toEqual(FORBIDDEN);
    expect(await counts()).toEqual(before);
    expect(await variantStock(db(), c.variantId)).toBe(0);

    await grant('supporter', ['admin.stock.manage']);
    const result = await move(actor, c.itemId, c.variantId, 4);
    expect(result).toMatchObject({ releasedQuantity: 0, allocatedQuantity: 0, replayed: false });
    expect(result.movementId).toMatch(/^[1-9][0-9]*$/);
    expect(await variantStock(db(), c.variantId)).toBe(4);
    expect(await counts()).toMatchObject({ movements: before.movements + 1, operations: before.operations + 1 });
  });

  test('FREQ-540-AC-06: 権限が2つの役割に分かれていても、有効な役割の和集合がそろえば入荷できる', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    await grant('supporter', ['admin.stock.manage']);
    await grant('user', ['admin.stock.read']);
    const actor = await createActor(['supporter', 'user']);

    expect(await move(actor, c.itemId, c.variantId, 2)).toMatchObject({ replayed: false });
    expect(await variantStock(db(), c.variantId)).toBe(2);
  });

  test.each([
    ['無効にした役割', { inactive: ['user'] }],
    ['期限切れの役割', { expired: ['user'] }],
  ] as const)('FREQ-540-AC-06: 和集合には%sの権限を数えない', async (_name, options) => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    await grant('supporter', ['admin.stock.manage']);
    await grant('user', ['admin.stock.read']);
    const actor = await createActor(['supporter', 'user'], options);
    const before = await counts();

    expect(await rejected(() => move(actor, c.itemId, c.variantId, 1))).toEqual(FORBIDDEN);

    expect(await counts()).toEqual(before);
    expect(await variantStock(db(), c.variantId)).toBe(0);
  });

  test.each(['inactive', 'expired', 'no-role', 'admin.stock.manage removed', 'admin.stock.read removed'])(
    'FREQ-540-AC-06: 実行者の現在の権限を毎回確かめる: %s', async (change) => {
      const c = await createCatalogFixture(db(), { stock: 0 });
      const actor = await createActor(change === 'no-role' ? [] : ['admin'],
        { inactive: change === 'inactive' ? ['admin'] : [], expired: change === 'expired' ? ['admin'] : [] });
      if (change.endsWith('removed')) await revoke('admin', [change.split(' ')[0]]);
      const before = await counts();

      expect(await rejected(() => move(actor, c.itemId, c.variantId, 1))).toEqual(FORBIDDEN);

      expect(await counts()).toEqual(before);
      expect(await variantStock(db(), c.variantId)).toBe(0);
    });

  test('店長（admin）の役割は初期のまま stock の2権限を持つので入荷できる', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const actor = await createActor(['admin']);

    expect(await move(actor, c.itemId, c.variantId, 5)).toMatchObject({ replayed: false });
    expect(await variantStock(db(), c.variantId)).toBe(5);
  });

  test('公開 admin_record_stock_movement は service_role だけが EXECUTE でき、所有者 postgres・search_path 空・SQL の INVOKER のまま', async () => {
    const signature = 'public.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)';
    const privateSignature = 'private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)';
    const read = async (sig: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        l.lanname as language, p.proconfig as config, pg_get_function_result(p.oid) as result,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [sig])).rows[0];

    expect(await read(signature)).toEqual({ owner: 'postgres', definer: false, language: 'sql', config: ['search_path=""'], result: 'jsonb',
      service_role: true, anon: false, authenticated: false, public_can_execute: false });
    expect(await read(privateSignature)).toEqual({ owner: 'postgres', definer: true, language: 'plpgsql', config: ['search_path=""'],
      result: 'jsonb', service_role: true, anon: false, authenticated: false, public_can_execute: false });
  });

  test('権限の確認の部品 group_g_actor_has_permissions は内部だけ（誰にも EXECUTE を付けず、所有者 postgres の STABLE DEFINER）', async () => {
    const row = (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.provolatile as volatility,
        l.lanname as language, p.proconfig as config, pg_get_function_result(p.oid) as result,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = 'private.group_g_actor_has_permissions(uuid,text[])'::regprocedure`)).rows[0];

    expect(row).toEqual({ owner: 'postgres', definer: true, volatility: 's', language: 'sql', config: ['search_path=""'], result: 'boolean',
      service_role: false, anon: false, authenticated: false, public_can_execute: false });
  });

  describe('group_g_actor_has_permissions の真偽表', () => {
    async function has(actor: string | null, codes: string[] | null): Promise<boolean> {
      return (await db().query('select private.group_g_actor_has_permissions($1::uuid,$2::text[]) as ok', [actor, codes])).rows[0].ok;
    }

    test('FREQ-540-AC-06: 店長は stock の2権限を持ち、重複した指定も同じ。未登録のコード・NULL の要素・空配列・NULL は false', async () => {
      const admin = await createActor(['admin']);

      expect(await has(admin, STOCK_PAIR)).toBe(true);
      expect(await has(admin, ['admin.stock.read'])).toBe(true);
      expect(await has(admin, ['admin.stock.read', 'admin.stock.read'])).toBe(true);
      expect(await has(admin, [...STOCK_PAIR, 'admin.unknown.code'])).toBe(false);
      expect(await has(admin, ['admin.unknown.code'])).toBe(false);
      expect(await has(admin, [...STOCK_PAIR, null as unknown as string])).toBe(false);
      expect(await has(admin, [])).toBe(false);
      expect(await has(admin, null)).toBe(false);
      expect(await has(null, STOCK_PAIR)).toBe(false);
      expect(await has(randomUUID(), STOCK_PAIR)).toBe(false);
    });

    test('FREQ-540-AC-06: 2つの役割に権限が分かれて付く実行者は和集合で true。足りない・役割が無い・無効・期限切れは false', async () => {
      await grant('supporter', ['admin.stock.manage']);
      await grant('user', ['admin.stock.read']);
      const split = await createActor(['supporter', 'user']);
      const onlySupporter = await createActor(['supporter']);
      const onlyUser = await createActor(['user']);
      const none = await createActor([]);
      const inactiveSecond = await createActor(['supporter', 'user'], { inactive: ['user'] });
      const expiredSecond = await createActor(['supporter', 'user'], { expired: ['user'] });

      expect(await has(split, STOCK_PAIR)).toBe(true);
      expect(await has(split, ['admin.stock.read'])).toBe(true);
      expect(await has(split, ['admin.stock.manage'])).toBe(true);
      expect(await has(split, [...STOCK_PAIR, 'admin.items.manage'])).toBe(false);
      expect(await has(onlySupporter, STOCK_PAIR)).toBe(false);
      expect(await has(onlySupporter, ['admin.stock.manage'])).toBe(true);
      expect(await has(onlyUser, STOCK_PAIR)).toBe(false);
      expect(await has(none, ['admin.stock.read'])).toBe(false);
      expect(await has(inactiveSecond, STOCK_PAIR)).toBe(false);
      expect(await has(expiredSecond, STOCK_PAIR)).toBe(false);
    });
  });
});
