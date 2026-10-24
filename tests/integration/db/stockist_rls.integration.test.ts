/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * stockists の RLS の方針と表の付与（DATA-STOCKIST-002）。
 * PostgREST が取引ごとに入れる役と JWT のクレームを set local で再現する。手元の使い捨て DB でだけ流し、
 * 各試験は取引の中で動かして最後に巻き戻すので、足した利用者・役・店を残さない。
 */
type DbRole = 'anon' | 'authenticated';
type Actor = { role: DbRole; sub?: string; aal?: string };
type Policy = { policyname: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null };

const TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
const SEQUENCE_PRIVILEGES = ['SELECT', 'UPDATE', 'USAGE'];

const byCodeUnit = (a: Policy, b: Policy): number => (a.policyname < b.policyname ? -1 : 1);
const byNumber = (a: string, b: string): number => Number(a) - Number(b);

describeLocalDb('integration: stockists の RLS と付与', (db) => {
  let marker: string;
  let publishedStore: string;
  let privateStore: string;
  let plainUser: string;
  let reader: string;
  let manager: string;
  let manageOnly: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-stockist-rls-${randomUUID()}`;
    publishedStore = await insertStockist('published');
    privateStore = await insertStockist('private');

    // 既存の役の割り当てに左右されないよう、この試験だけの役を作って権限を1つずつ付ける
    const readRole = await createRole(['admin.stockists.read']);
    const fullRole = await createRole(['admin.stockists.read', 'admin.stockists.manage']);
    const manageRole = await createRole(['admin.stockists.manage']);
    plainUser = await createUser([]);
    reader = await createUser([readRole]);
    manager = await createUser([fullRole]);
    manageOnly = await createUser([manageRole]);
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertStockist(status: 'private' | 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       values ('STORE', $1, '東京都港区南青山0-0-1', '000-0000-0000', '11:00-18:00', 'Synthetic schedule', $2)
       returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function createRole(permissionCodes: string[]): Promise<string> {
    const code = `integration_stockist_${randomUUID().replace(/-/g, '')}`;
    const role = await db().query(
      'insert into public.roles (code, name) values ($1, $1) returning id::text as id', [code],
    );
    const roleId = role.rows[0].id as string;
    const granted = await db().query(
      `insert into public.role_permissions (role_id, permission_id)
       select $1::bigint, p.id from public.permissions p where p.code = any($2::text[])`,
      [roleId, permissionCodes],
    );
    // 権限の名前の打ち間違いで、何も付けないまま通ることを防ぐ
    expect(granted.rowCount).toBe(permissionCodes.length);
    return roleId;
  }

  async function createUser(roleIds: string[], assignment = { active: true, expired: false }): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '{}', '{}', now(), now())`,
      [id],
    );
    for (const roleId of roleIds) {
      await db().query(
        `insert into public.user_roles (user_id, role_id, active, expires_at)
         values ($1, $2::bigint, $3, case when $4::boolean then now() - interval '1 minute' else null end)`,
        [id, roleId, assignment.active, assignment.expired],
      );
    }
    return id;
  }

  async function enter(actor: Actor): Promise<void> {
    const claims = actor.sub ? JSON.stringify({ sub: actor.sub, role: actor.role, aal: actor.aal ?? 'aal2' }) : '';
    await db().query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await db().query("select set_config('request.jwt.claim.sub', $1, true)", [actor.sub ?? '']);
    await db().query(`set local role ${actor.role}`);
  }

  async function leave(): Promise<void> {
    await db().query('reset role');
    await db().query("select set_config('request.jwt.claims', '', true)");
    await db().query("select set_config('request.jwt.claim.sub', '', true)");
  }

  /** 利用者の役で1本流す。失敗しても取引が壊れないよう savepoint に戻す。 */
  async function runAs(actor: Actor, sql: string, params: unknown[] = []) {
    await db().query('savepoint as_actor');
    try {
      await enter(actor);
      const result = await db().query(sql, params);
      await leave();
      await db().query('release savepoint as_actor');
      return result;
    } catch (error) {
      await db().query('rollback to savepoint as_actor');
      throw error;
    }
  }

  async function errorCodeAs(actor: Actor, sql: string, params: unknown[] = []): Promise<string | undefined> {
    try {
      await runAs(actor, sql, params);
      return undefined;
    } catch (caught) {
      return (caught as { code?: string }).code;
    }
  }

  async function visibleStores(actor: Actor): Promise<string[]> {
    const result = await runAs(
      actor,
      'select id::text as id from public.stockists where id = any($1::bigint[]) order by id',
      [[publishedStore, privateStore]],
    );
    return result.rows.map((row) => row.id as string);
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const result = await db().query('select status from public.stockists where id = $1', [id]);
    return result.rows[0]?.status;
  }

  async function countByName(name: string): Promise<number> {
    const result = await db().query('select count(*)::int as count from public.stockists where name = $1', [name]);
    return result.rows[0].count;
  }

  async function policies(): Promise<Policy[]> {
    const result = await db().query(
      `select policyname, roles::text[] as roles, cmd, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = 'stockists'`,
    );
    return (result.rows as Policy[]).sort(byCodeUnit);
  }

  const insertSql = `insert into public.stockists (type, name, address, phone, time, holiday, status)
    values ('STORE', $1, 'a', 'p', 't', 'h', 'private')`;
  const setStatusSql = 'update public.stockists set status = $2 where id = $1';

  test('DATA-STOCKIST-002 stockists の RLS が有効になっている', async () => {
    const result = await db().query(
      "select relrowsecurity from pg_class where oid = 'public.stockists'::regclass",
    );

    expect(result.rows).toEqual([{ relrowsecurity: true }]);
  });

  test('DATA-STOCKIST-002 方針は設計の5つで、役と操作と条件が一致する', async () => {
    const rows = await policies();

    expect(rows.map(({ policyname, roles, cmd }) => ({ policyname, roles, cmd }))).toEqual([
      { policyname: 'admin stockists manage by permission delete', roles: ['authenticated'], cmd: 'DELETE' },
      { policyname: 'admin stockists manage by permission insert', roles: ['authenticated'], cmd: 'INSERT' },
      { policyname: 'admin stockists manage by permission update', roles: ['authenticated'], cmd: 'UPDATE' },
      { policyname: 'authenticated stockists read', roles: ['authenticated'], cmd: 'SELECT' },
      { policyname: 'public stockists read published', roles: ['anon'], cmd: 'SELECT' },
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.policyname, row]));
    expect(byName['public stockists read published'].qual).toContain("'published'");
    expect(byName['public stockists read published'].qual).not.toContain('has_permission');
    expect(byName['authenticated stockists read'].qual).toContain("'published'");
    expect(byName['authenticated stockists read'].qual).toContain("has_permission('admin.stockists.read'");
    expect(byName['admin stockists manage by permission insert'].with_check).toContain("has_permission('admin.stockists.manage'");
    expect(byName['admin stockists manage by permission update'].qual).toContain("has_permission('admin.stockists.manage'");
    expect(byName['admin stockists manage by permission update'].with_check).toContain("has_permission('admin.stockists.manage'");
    expect(byName['admin stockists manage by permission delete'].qual).toContain("has_permission('admin.stockists.manage'");
  });

  test.each(['anon', 'authenticated'])('DATA-STOCKIST-002 %s には表の権限が全部付いている', async (role) => {
    const result = await db().query(
      `select privilege from unnest($2::text[]) as privilege
       where has_table_privilege($1::name, 'public.stockists'::regclass, privilege)
       order by privilege`,
      [role, TABLE_PRIVILEGES],
    );

    expect(result.rows.map((row) => row.privilege)).toEqual(TABLE_PRIVILEGES);
  });

  test.each(['anon', 'authenticated'])('DATA-STOCKIST-002 %s には連番 stockists_id_seq の SELECT・UPDATE・USAGE が付いている', async (role) => {
    const result = await db().query(
      `select privilege from unnest($2::text[]) as privilege
       where has_sequence_privilege($1::name, 'public.stockists_id_seq'::regclass, privilege)
       order by privilege`,
      [role, SEQUENCE_PRIVILEGES],
    );

    expect(result.rows.map((row) => row.privilege)).toEqual(SEQUENCE_PRIVILEGES);
  });

  test('DATA-STOCKIST-002 anon は has_permission を呼べず、authenticated は呼べる', async () => {
    const result = await db().query(
      `select has_function_privilege('anon', 'public.has_permission(text)', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.has_permission(text)', 'EXECUTE') as authenticated`,
    );

    expect(result.rows).toEqual([{ anon: false, authenticated: true }]);
  });

  test('DATA-STOCKIST-002 anon は公開済みの店だけを読める', async () => {
    expect(await visibleStores({ role: 'anon' })).toEqual([publishedStore]);
  });

  test('DATA-STOCKIST-002 anon の追加は RLS の違反で落ち、更新・削除は1行も変えない', async () => {
    const name = `${marker} anon insert`;
    expect(await errorCodeAs({ role: 'anon' }, insertSql, [name])).toBe('42501');
    expect(await countByName(name)).toBe(0);

    const updated = await runAs({ role: 'anon' }, setStatusSql, [publishedStore, 'private']);
    const deleted = await runAs({ role: 'anon' }, 'delete from public.stockists where id = any($1::bigint[])', [[publishedStore, privateStore]]);

    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    expect(await statusOf(publishedStore)).toBe('published');
    expect(await statusOf(privateStore)).toBe('private');
  });

  test('DATA-STOCKIST-002 sub の無い authenticated は公開済みの店だけを読める', async () => {
    expect(await visibleStores({ role: 'authenticated' })).toEqual([publishedStore]);
  });

  test('DATA-STOCKIST-002 権限の無い会員は公開済みだけを読め、書き換えられない', async () => {
    const actor: Actor = { role: 'authenticated', sub: plainUser };
    const name = `${marker} plain insert`;

    expect(await visibleStores(actor)).toEqual([publishedStore]);
    expect(await errorCodeAs(actor, insertSql, [name])).toBe('42501');
    expect(await countByName(name)).toBe(0);
    const updated = await runAs(actor, setStatusSql, [publishedStore, 'private']);
    const deleted = await runAs(actor, 'delete from public.stockists where id = $1', [publishedStore]);
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    expect(await statusOf(publishedStore)).toBe('published');
  });

  test('DATA-STOCKIST-002 admin.stockists.read を持つ会員は非公開の店も読めるが、書き換えはできない', async () => {
    const actor: Actor = { role: 'authenticated', sub: reader };
    const name = `${marker} reader insert`;

    expect(await visibleStores(actor)).toEqual([publishedStore, privateStore].sort(byNumber));
    expect(await errorCodeAs(actor, insertSql, [name])).toBe('42501');
    expect(await countByName(name)).toBe(0);
    const updated = await runAs(actor, setStatusSql, [privateStore, 'published']);
    const deleted = await runAs(actor, 'delete from public.stockists where id = $1', [privateStore]);
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    expect(await statusOf(privateStore)).toBe('private');
  });

  test('DATA-STOCKIST-002 割り当てが止まっているか期限切れの会員は非公開を読めない', async () => {
    const roleId = await createRole(['admin.stockists.read']);
    const inactive = await createUser([roleId], { active: false, expired: false });
    const expired = await createUser([roleId], { active: true, expired: true });

    expect(await visibleStores({ role: 'authenticated', sub: inactive })).toEqual([publishedStore]);
    expect(await visibleStores({ role: 'authenticated', sub: expired })).toEqual([publishedStore]);
  });

  test('DATA-STOCKIST-002 admin.stockists.read と admin.stockists.manage を持つ会員は追加・更新・削除ができる', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager };
    const name = `${marker} manager insert`;

    const inserted = await runAs(actor, insertSql, [name]);
    const updated = await runAs(actor, setStatusSql, [privateStore, 'published']);
    const deleted = await runAs(actor, 'delete from public.stockists where id = $1', [publishedStore]);

    expect(inserted.rowCount).toBe(1);
    expect(await countByName(name)).toBe(1);
    expect(updated.rowCount).toBe(1);
    expect(await statusOf(privateStore)).toBe('published');
    expect(deleted.rowCount).toBe(1);
    expect(await statusOf(publishedStore)).toBeUndefined();
  });

  test('DATA-STOCKIST-002 admin.stockists.manage だけの会員は追加・更新できるが、非公開は読めない', async () => {
    const actor: Actor = { role: 'authenticated', sub: manageOnly };
    const name = `${marker} manage-only insert`;

    const inserted = await runAs(actor, insertSql, [name]);
    const updated = await runAs(actor, setStatusSql, [publishedStore, 'private']);

    expect(inserted.rowCount).toBe(1);
    expect(await countByName(name)).toBe(1);
    expect(updated.rowCount).toBe(1);
    expect(await statusOf(publishedStore)).toBe('private');
    // 公開の店を非公開にした後なので、読める店は無い
    expect(await visibleStores(actor)).toEqual([]);
  });

  test('DATA-STOCKIST-002 DB は aal を見ないので、aal1 の JWT でも権限があれば非公開を読み書きできる', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager, aal: 'aal1' };

    expect(await visibleStores(actor)).toEqual([publishedStore, privateStore].sort(byNumber));
    const updated = await runAs(actor, setStatusSql, [privateStore, 'published']);
    expect(updated.rowCount).toBe(1);
    expect(await statusOf(privateStore)).toBe('published');
  });
});
