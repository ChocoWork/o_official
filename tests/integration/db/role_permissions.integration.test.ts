/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';

// Controller only: disposable local DB; no integration execution by the implementer.
const catalog = [
  'admin.users.read', 'admin.users.manage', 'admin.items.read', 'admin.items.manage',
  'admin.news.read', 'admin.news.manage', 'admin.looks.read', 'admin.looks.manage',
  'admin.stockists.read', 'admin.stockists.manage', 'admin.orders.read', 'admin.orders.manage',
  'admin.contact.read', 'admin.contact.manage', 'admin.finance.read', 'admin.finance.manage',
  'admin.audit.read', 'admin.orders.refund', 'admin.settings.manage', 'admin.orders.return',
  'admin.stock.read', 'admin.stock.manage', 'admin.orders.allocate', 'admin.purchase_orders.read',
  'admin.purchase_orders.manage', 'admin.receiving.manage', 'admin.shipping.read',
  'admin.shipping.manage', 'admin.shipping.correct_date', 'admin.permissions.manage',
].sort();
const supporterCodes = [
  'admin.users.read', 'admin.orders.read', 'admin.orders.manage', 'admin.contact.read',
  'admin.contact.manage', 'admin.orders.return', 'admin.shipping.read', 'admin.shipping.manage',
].sort();
const fixed = ['admin.users.manage', 'admin.permissions.manage'];

describeLocalDb('integration: G0 role permissions', (db) => {
  let admin: string;
  let secondAdmin: string;
  let supporter: string;
  let user: string;
  let seed: string;

  beforeAll(() => {
    const directory = path.join(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g0_permissions.sql'));
    expect(files).toHaveLength(1);
    const sql = fs.readFileSync(path.join(directory, files[0]), 'utf8');
    const match = sql.match(/^-- BEGIN G0_PERMISSION_SEED_RECONCILE\n([\s\S]*?)^-- END G0_PERMISSION_SEED_RECONCILE$/m);
    expect(match).not.toBeNull();
    seed = match![1];
  });
  beforeEach(async () => {
    await db().query('begin');
    admin = await member('admin');
    secondAdmin = await member('admin');
    supporter = await member('supporter');
    user = await member('user');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function member(role: string): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, jsonb_build_object('role', $2::text, 'g0_keep', 'unchanged'), '{}', now(), now())`, [id, role],
    );
    await db().query(
      `insert into public.user_roles (user_id, role_id)
       select $1, id from public.roles where code = $2`, [id, role],
    );
    return id;
  }
  async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
    await db().query(`set local role ${role}`);
    // On an SQL error the caller rolls back its savepoint (including SET LOCAL ROLE).
    // RESET in a failed transaction would replace the contract error with 25P02.
    const value = await run();
    await db().query('reset role');
    return value;
  }
  async function rejected(run: () => Promise<unknown>, message: string, code: string) {
    await db().query('savepoint expected_error');
    let error: unknown;
    try { await run(); } catch (caught) { error = caught; }
    finally { await db().query('rollback to savepoint expected_error'); }
    const caught = error as { message?: string; code?: string } | undefined;
    expect({ message: caught?.message === message ? message : 'G0_UNEXPECTED_DB_ERROR', code: caught?.code })
      .toEqual({ message, code });
  }
  async function deniedSql(sql: string, params: unknown[] = [], role?: string) {
    await db().query('savepoint denied_sql');
    let error: unknown;
    try {
      if (role) await db().query(`set local role ${role}`);
      await db().query(sql, params);
    } catch (caught) { error = caught; }
    finally { await db().query('rollback to savepoint denied_sql'); }
    expect(error).toMatchObject({ code: '42501' });
  }
  async function get(actor = admin) {
    return asRole('service_role', async () =>
      (await db().query('select public.admin_get_permissions($1) as result', [actor])).rows[0].result);
  }
  async function roleState(role = 'supporter') {
    const result = await get();
    return result.roles.find((entry: { code: string }) => entry.code === role) as {
      code: string; version: string; permissionCodes: string[];
    };
  }
  async function save(codes: string[] | null, version: string | null, key: string | null = randomUUID(),
    role: string | null = 'supporter', actor = admin) {
    return asRole('service_role', async () => (await db().query(
      'select public.admin_set_role_permissions($1,$2,$3,$4,$5) as result',
      [actor, role, codes, version, key],
    )).rows[0].result);
  }
  async function changeUser(actor: string, target: string, role: string) {
    return asRole('service_role', async () => (await db().query(
      'select public.admin_set_user_role($1,$2,$3) as result', [actor, target, role],
    )).rows[0].result);
  }
  async function state() {
    return (await db().query(`select
      (select coalesce(jsonb_agg(rp order by role_id, permission_id), '[]') from public.role_permissions rp) as acl,
      (select jsonb_agg(r order by id) from public.roles r) as roles,
      (select coalesce(jsonb_agg(e order by id), '[]') from public.role_permission_events e) as events,
      (select coalesce(jsonb_agg(q order by request_key), '[]') from private.role_permission_requests q) as requests`
    )).rows[0];
  }
  async function userState(id: string) {
    return (await db().query(`select raw_app_meta_data as metadata, updated_at,
      (select jsonb_agg(ur order by role_id) from public.user_roles ur where user_id=$1) as acl
      from auth.users where id=$1`, [id])).rows[0];
  }
  async function fixtureGuard(run: () => Promise<unknown>) {
    await db().query('alter table public.role_permissions disable trigger role_permissions_fixed_guard');
    try { await run(); }
    finally { await db().query('alter table public.role_permissions enable trigger role_permissions_fixed_guard'); }
  }
  async function grant(role: string, code: string) {
    await db().query(`insert into public.role_permissions(role_id,permission_id)
      select r.id,p.id from public.roles r cross join public.permissions p
      where r.code=$1 and p.code=$2 on conflict do nothing`, [role, code]);
  }

  test('seeds the complete G0 matrix', async () => {
    await db().query(`update public.roles set name=case code when 'admin' then 'Administrator'
      when 'supporter' then 'Support' else 'User' end where code in ('admin','supporter','user')`);
    const identities = (await db().query(`select 'role' as kind,id,code,name from public.roles
      where code in ('admin','supporter','user') union all
      select 'permission',id,code,name from public.permissions where code=any($1::text[]) order by kind,code`, [catalog])).rows;
    await db().query("insert into public.permissions(code,name) values ('test.g0.preserved','preserved')");
    await db().query("insert into public.roles(code,name) values ('test_g0_other','other')");
    for (const role of ['admin', 'supporter', 'user']) await grant(role, 'test.g0.preserved');
    await grant('test_g0_other', 'admin.items.read');
    await grant('supporter', 'admin.items.read');
    await grant('user', 'admin.orders.read');
    await fixtureGuard(async () => {
      for (const role of ['supporter', 'user']) for (const code of fixed) await grant(role, code);
    });
    await db().query(seed);
    await db().query(seed); // seed reconciliation remains idempotent, with the fixed guard enabled.
    const grants = (await db().query(`select r.code,array_agg(p.code order by p.code) as codes
      from public.roles r join public.role_permissions rp on rp.role_id=r.id
      join public.permissions p on p.id=rp.permission_id where p.code=any($1::text[])
      group by r.code order by r.code`, [catalog])).rows;
    expect(grants).toEqual([
      { code: 'admin', codes: catalog }, { code: 'supporter', codes: supporterCodes },
      { code: 'test_g0_other', codes: ['admin.items.read'] },
    ]);
    expect((await db().query(`select 'role' as kind,id,code,name from public.roles
      where code in ('admin','supporter','user') union all
      select 'permission',id,code,name from public.permissions where code=any($1::text[]) order by kind,code`, [catalog])).rows).toEqual(identities);
    expect((await db().query(`select r.code from public.role_permissions rp join public.roles r on r.id=rp.role_id
      join public.permissions p on p.id=rp.permission_id where p.code='test.g0.preserved' order by r.code`)).rows)
      .toEqual([{ code: 'admin' }, { code: 'supporter' }, { code: 'user' }]);
    expect((await db().query(`select r.code,p.code as permission from public.role_permissions rp
      join public.roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
      where p.code=any($1::text[]) order by p.code`, [fixed])).rows)
      .toEqual([...fixed].sort().map((permission) => ({ code: 'admin', permission })));
  });

  test.each(fixed)('keeps permission management fixed: %s', async (code) => {
    const before = await state();
    const adminState = await roleState('admin');
    await rejected(() => save(adminState.permissionCodes.filter((p) => p !== code), adminState.version,
      randomUUID(), 'admin'), 'ROLE_PERMISSION_FIXED', '42501');
    const supportState = await roleState();
    await rejected(() => save([...supportState.permissionCodes, code], supportState.version), 'ROLE_PERMISSION_FIXED', '42501');
    await rejected(() => save([], '0', randomUUID(), 'user'), 'ROLE_PERMISSION_ARGUMENT_INVALID', '22023');
    expect(await state()).toEqual(before);
  });

  test.each(fixed)('protects fixed grants from future DML: %s', async (code) => {
    const ids = (await db().query(`select r.id as role_id,p.id as permission_id,
      (select id from public.roles where code='supporter') as other_role,
      (select id from public.permissions where code='admin.items.read') as other_permission
      from public.roles r cross join public.permissions p where r.code='admin' and p.code=$1`, [code])).rows[0];
    const params = [ids.role_id, ids.permission_id];
    for (const sql of [
      'delete from public.role_permissions where role_id=$1 and permission_id=$2',
      `update public.role_permissions set role_id=${ids.other_role} where role_id=$1 and permission_id=$2`,
      `update public.role_permissions set permission_id=${ids.other_permission} where role_id=$1 and permission_id=$2`,
    ]) await rejected(() => db().query(sql, params), 'ROLE_PERMISSION_FIXED', '42501');
    await rejected(() => db().query('insert into public.role_permissions(role_id,permission_id) values($1,$2)',
      [ids.other_role, ids.permission_id]), 'ROLE_PERMISSION_FIXED', '42501');
    await rejected(async () => db().query(`update public.role_permissions set permission_id=$1
      where role_id=$2 and permission_id=$3`, [ids.permission_id, ids.other_role,
      (await db().query("select id from public.permissions where code='admin.orders.read'")).rows[0].id]),
    'ROLE_PERMISSION_FIXED', '42501');
    await db().query('update public.role_permissions set role_id=role_id,permission_id=permission_id where role_id=$1 and permission_id=$2', params);
  });

  test('preserves grants outside the G0 catalog', async () => {
    await db().query("insert into public.permissions(code,name) values ('test.g0.preserved','preserved')");
    for (const role of ['admin', 'supporter']) await grant(role, 'test.g0.preserved');
    const outside = async () => (await db().query(`select rp.* from public.role_permissions rp
      join public.permissions p on p.id=rp.permission_id where p.code='test.g0.preserved' order by role_id`)).rows;
    const before = await outside();
    expect((await get()).permissionCodes).toEqual(catalog);
    expect((await get()).roles.map((r: { code: string }) => r.code)).toEqual(['admin', 'supporter']);
    for (const role of ['admin', 'supporter']) {
      const current = await roleState(role);
      const key = randomUUID();
      const saved = await save(role === 'admin' ? fixed : [], current.version, key, role);
      expect(saved.role.permissionCodes).toEqual(role === 'admin' ? [...fixed].sort() : []);
      expect((await db().query('select result from private.role_permission_requests where request_key=$1', [key])).rows[0].result).toEqual(saved);
      expect((await roleState(role)).permissionCodes).toEqual(saved.role.permissionCodes);
    }
    expect(await outside()).toEqual(before);
  });

  test('checks active admin ACL in the function', async () => {
    const expired = await member('admin');
    const inactive = await member('admin');
    await db().query("update public.user_roles set expires_at=now()-interval '1 second' where user_id=$1", [expired]);
    await db().query('update public.user_roles set active=false where user_id=$1', [inactive]);
    for (const actor of [supporter, user, expired, inactive, randomUUID()]) {
      await rejected(() => get(actor), 'ROLE_PERMISSION_FORBIDDEN', '42501');
      await rejected(() => save(supporterCodes, '0', randomUUID(), 'supporter', actor), 'ROLE_PERMISSION_FORBIDDEN', '42501');
      await rejected(() => changeUser(actor, user, 'admin'), 'ROLE_PERMISSION_FORBIDDEN', '42501');
    }
    // App metadata alone never supplies ACL authority.
    await db().query(`update auth.users set raw_app_meta_data='{"role":"admin"}' where id=$1`, [supporter]);
    await rejected(() => get(supporter), 'ROLE_PERMISSION_FORBIDDEN', '42501');
    await fixtureGuard(() => db().query(`delete from public.role_permissions rp using public.permissions p
      where rp.permission_id=p.id and p.code='admin.permissions.manage'`));
    await rejected(() => get(), 'ROLE_PERMISSION_FORBIDDEN', '42501');
    await rejected(() => save(supporterCodes, '0'), 'ROLE_PERMISSION_FORBIDDEN', '42501');
    await fixtureGuard(() => db().query(`delete from public.role_permissions rp using public.permissions p
      where rp.permission_id=p.id and p.code='admin.users.manage'`));
    await rejected(() => changeUser(admin, user, 'supporter'), 'ROLE_PERMISSION_FORBIDDEN', '42501');
  });

  test('rejects invalid permission arguments before writing', async () => {
    const current = await roleState();
    const before = await state();
    await db().query("insert into public.permissions(code,name) values ('test.g0.outside','outside')");
    for (const codes of [null, [null], ['unknown'], ['test.g0.outside'], ['admin.orders.read', 'admin.orders.read']]) {
      await rejected(() => save(codes as string[] | null, current.version), 'ROLE_PERMISSION_ARGUMENT_INVALID', '22023');
    }
    for (const role of [null, 'unknown', 'user']) await rejected(() => save([], current.version, randomUUID(), role), 'ROLE_PERMISSION_ARGUMENT_INVALID', '22023');
    for (const version of [null, '-1']) await rejected(() => save([], version), 'ROLE_PERMISSION_ARGUMENT_INVALID', '22023');
    await rejected(() => save([], current.version, null), 'ROLE_PERMISSION_ARGUMENT_INVALID', '22023');
    expect(await state()).toEqual(before);
  });

  test('records every diff atomically', async () => {
    const start = await roleState();
    const removed = start.permissionCodes.filter((p) => !p.startsWith('admin.shipping.'));
    for (const [index, codes] of [removed, start.permissionCodes].entries()) {
      const key = randomUUID();
      const saved = await save(codes, (BigInt(start.version) + BigInt(index)).toString(), key);
      expect(saved.changedCount).toBe(2);
      expect(BigInt(saved.role.version)).toBe(BigInt(start.version) + BigInt(index + 1));
      expect(saved.role.permissionCodes).toEqual(codes);
      const events = (await db().query(`select role,permission_code,action,actor_id,request_key,created_at is not null as timed
        from public.role_permission_events where request_key=$1 order by permission_code`, [key])).rows;
      expect(events).toEqual(['admin.shipping.manage', 'admin.shipping.read'].map((permission_code) => ({
        role: 'supporter', permission_code, action: index === 0 ? 'revoke' : 'grant', actor_id: admin, request_key: key, timed: true,
      })));
    }
  });

  test('replays without restoring stale ACL', async () => {
    const start = await roleState();
    const key = randomUUID();
    const codes = start.permissionCodes.filter((p) => p !== 'admin.shipping.read');
    const first = await save(codes, start.version, key);
    const once = await state();
    expect(await save(codes, start.version, key)).toEqual(first);
    expect(await state()).toEqual(once);
    await save(start.permissionCodes, first.role.version);
    const latest = await state();
    expect(await save(codes, start.version, key)).toEqual(first);
    expect(await state()).toEqual(latest);
    expect((await roleState()).permissionCodes).toEqual(start.permissionCodes);
  });

  test('records no-op and rejects key reuse', async () => {
    const start = await roleState();
    const key = randomUUID();
    const first = await save(start.permissionCodes, start.version, key);
    expect(first).toEqual({ role: start, changedCount: 0 });
    const once = await state();
    expect(await save([...start.permissionCodes].reverse(), start.version, key)).toEqual(first);
    expect(await state()).toEqual(once);
    expect((await db().query('select count(*)::int as n from private.role_permission_requests where request_key=$1', [key])).rows[0].n).toBe(1);
    expect((await db().query('select count(*)::int as n from public.role_permission_events where request_key=$1', [key])).rows[0].n).toBe(0);
    for (const run of [
      () => save(start.permissionCodes, start.version, key, 'supporter', secondAdmin),
      () => save(catalog, start.version, key, 'admin'),
      () => save([], start.version, key),
      () => save(start.permissionCodes, (BigInt(start.version) + BigInt(1)).toString(), key),
    ]) await rejected(run, 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT', 'P0001');
    expect(await state()).toEqual(once);
  });

  test('rolls back when event insertion fails', async () => {
    const start = await roleState();
    const before = await state();
    await db().query(`create function pg_temp.g0_fail_event() returns trigger language plpgsql as $$
      begin raise exception using message='G0_TEST_EVENT_FAILURE',errcode='P0001'; end $$;
      create trigger g0_test_fail before insert on public.role_permission_events for each row execute function pg_temp.g0_fail_event()`);
    await rejected(() => save(start.permissionCodes.filter((p) => !p.startsWith('admin.shipping.')), start.version), 'G0_TEST_EVENT_FAILURE', 'P0001');
    expect(await state()).toEqual(before);
  });

  test('denies direct access and mutation', async () => {
    const key = randomUUID();
    const start = await roleState();
    await save(start.permissionCodes.filter((p) => p !== 'admin.shipping.read'), start.version, key);
    const tables = ['public.roles', 'public.permissions', 'public.role_permissions',
      'public.role_permission_events', 'private.role_permission_requests'];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of tables) {
        const privileges = (await db().query(`select
          has_table_privilege($1,$2,'SELECT') as read,
          has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') as write`, [role, table])).rows[0];
        expect(privileges).toEqual({ read: role === 'service_role', write: false });
        if (role !== 'service_role') await deniedSql(`select * from ${table}`, [], role);
        const column = ['public.roles', 'public.permissions'].includes(table) ? 'name'
          : table === 'public.role_permissions' ? 'role_id' : 'actor_id';
        for (const sql of [`insert into ${table} default values`, `delete from ${table}`,
          `update ${table} set ${column}=${column}`, `truncate ${table}`]) {
          await deniedSql(sql, [], role);
        }
      }
      for (const sequence of ['public.roles_id_seq', 'public.permissions_id_seq']) {
        expect((await db().query("select has_sequence_privilege($1,$2,'USAGE,SELECT,UPDATE') as allowed", [role, sequence])).rows[0].allowed).toBe(false);
      }
    }
    const functions = [
      ['admin_get_permissions', 'uuid'],
      ['admin_set_role_permissions', 'uuid,text,text[],bigint,uuid'],
      ['admin_set_user_role', 'uuid,uuid,text'],
    ];
    for (const schema of ['public', 'private']) for (const [name, signature] of functions) {
      const fn = `${schema}.${name}(${signature})`;
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, fn])).rows[0].allowed).toBe(role === 'service_role');
      }
    }
    for (const role of ['anon', 'authenticated']) for (const schema of ['public', 'private']) {
      await deniedSql(`select ${schema}.admin_get_permissions($1)`, [admin], role);
      await deniedSql(`select ${schema}.admin_set_role_permissions($1,'supporter',$2,0,$3)`, [admin, supporterCodes, randomUUID()], role);
      await deniedSql(`select ${schema}.admin_set_user_role($1,$2,'admin')`, [admin, supporter], role);
    }
    for (const table of ['public.role_permission_events', 'private.role_permission_requests']) {
      for (const role of ['postgres', 'service_role']) {
        if (role === 'service_role') await db().query(`grant insert,update,delete,truncate on ${table} to service_role`);
        for (const sql of [`update ${table} set actor_id=actor_id where request_key='${key}'`,
          `delete from ${table} where request_key='${key}'`, `truncate ${table}`]) {
          await rejected(() => asRole(role, () => db().query(sql)), 'ROLE_PERMISSION_IMMUTABLE', '55000');
        }
      }
    }
  });

  test('uses ACL instead of role shortcuts in RLS', async () => {
    async function allowed(id: string, code: string) {
      await db().query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
      return asRole('authenticated', async () => (await db().query('select public.has_permission($1) as allowed', [code])).rows[0].allowed);
    }
    for (const [role, id, code] of [['admin', admin, 'admin.items.manage'], ['supporter', supporter, 'admin.orders.read']]) {
      const start = await roleState(role);
      expect(await allowed(id, code)).toBe(true);
      const saved = await save(start.permissionCodes.filter((p) => p !== code), start.version, randomUUID(), role);
      expect(await allowed(id, code)).toBe(false);
      await save(start.permissionCodes, saved.role.version, randomUUID(), role);
      expect(await allowed(id, code)).toBe(true);
      await db().query('update public.user_roles set active=false where user_id=$1', [id]);
      expect(await allowed(id, code)).toBe(false);
      await db().query("update public.user_roles set active=true,expires_at=now()-interval '1 second' where user_id=$1", [id]);
      expect(await allowed(id, code)).toBe(false);
      await db().query('update public.user_roles set expires_at=null where user_id=$1', [id]);
    }
    await db().query("select set_config('request.jwt.claim.sub','',true)");
    expect(await asRole('authenticated', async () => (await db().query("select public.has_permission('admin.items.manage') as allowed")).rows[0].allowed)).toBe(false);
  });

  test('blocks supporter escalation through user_roles', async () => {
    await db().query("select set_config('request.jwt.claim.sub',$1,true)", [supporter]);
    for (const role of ['anon', 'authenticated']) {
      for (const [sql, params] of [
        ["insert into public.user_roles(user_id,role_id) select $1,id from public.roles where code='admin'", [supporter]],
        ["update public.user_roles set role_id=(select id from public.roles where code='admin'),active=true where user_id=$1", [supporter]],
        ['update public.user_roles set active=true where user_id=$1', [supporter]],
        ['delete from public.user_roles where user_id=$1', [user]],
      ] as [string, unknown[]][]) await deniedSql(sql, params, role);
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN', 'SELECT']) {
        expect((await db().query('select has_table_privilege($1,\'public.user_roles\',$2) as allowed', [role, privilege])).rows[0].allowed)
          .toBe(role === 'authenticated' && privilege === 'SELECT');
      }
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) expect((await db().query(
      'select has_table_privilege(\'service_role\',\'public.user_roles\',$1) as allowed', [privilege])).rows[0].allowed).toBe(true);
  });

  test('keeps at least one active admin and rejects self changes', async () => {
    // All changes are rolled back; pre-existing admins cannot influence this count.
    await db().query(`update public.user_roles set active=false where role_id=(select id from public.roles where code='admin')
      and user_id<>$1`, [admin]);
    await db().query("update public.user_roles set expires_at=now()-interval '1 second',active=true where user_id=$1", [secondAdmin]);
    const before = await userState(admin);
    await rejected(() => changeUser(admin, admin, 'supporter'), 'LAST_ADMIN_REQUIRED', 'P0001');
    expect(await userState(admin)).toEqual(before);
    await db().query('update public.user_roles set expires_at=null,active=true where user_id=$1', [secondAdmin]);
    for (const role of ['admin', 'supporter', 'user']) await rejected(() => changeUser(admin, admin, role), 'SELF_ROLE_CHANGE_FORBIDDEN', '42501');
    expect(await userState(admin)).toEqual(before);
    await rejected(() => changeUser(admin, randomUUID(), 'user'), 'USER_NOT_FOUND', 'P0002');
  });

  test('updates user role and metadata atomically', async () => {
    expect(await changeUser(admin, user, 'supporter')).toEqual({ previousRole: 'user', role: 'supporter' });
    const saved = await userState(user);
    expect(saved.metadata).toEqual({ role: 'supporter', g0_keep: 'unchanged' });
    const acl = (await db().query(`select r.code,ur.active,ur.expires_at,ur.assigned_by,ur.assigned_at is not null as timed
      from public.user_roles ur join public.roles r on r.id=ur.role_id where user_id=$1 order by r.code`, [user])).rows;
    expect(acl).toEqual([
      { code: 'supporter', active: true, expires_at: null, assigned_by: admin, timed: true },
      { code: 'user', active: false, expires_at: null, assigned_by: null, timed: true },
    ]);
    for (const table of ['auth.users', 'public.user_roles']) {
      await db().query('savepoint failure_fixture');
      await db().query(`create or replace function pg_temp.g0_fail_role() returns trigger language plpgsql as $$
        begin raise exception using message='G0_TEST_ROLE_FAILURE',errcode='P0001'; end $$;
        create trigger g0_test_fail before update on ${table} for each row execute function pg_temp.g0_fail_role()`);
      await rejected(() => changeUser(admin, user, 'admin'), 'G0_TEST_ROLE_FAILURE', 'P0001');
      expect(await userState(user)).toEqual(saved);
      await db().query('rollback to savepoint failure_fixture');
    }
  });

  test('retains the actor after account deletion', async () => {
    const start = await roleState();
    const key = randomUUID();
    await save(start.permissionCodes.filter((p) => p !== 'admin.shipping.read'), start.version, key);
    await db().query('delete from auth.users where id=$1', [admin]);
    for (const table of ['public.role_permission_events', 'private.role_permission_requests']) {
      expect((await db().query(`select actor_id from ${table} where request_key=$1`, [key])).rows).toEqual([{ actor_id: admin }]);
    }
  });
});
