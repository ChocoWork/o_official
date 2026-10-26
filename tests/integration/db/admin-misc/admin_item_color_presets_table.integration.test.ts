/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from '../helpers/local-db';

/**
 * 色見本の表 item_color_presets の形・RLS・付与（DATA-ADMIN-005）。
 * PostgREST が取引ごとに入れる役と JWT のクレームを set local で再現する。手元の使い捨て DB でだけ流し、
 * 各試験は取引の中で動かして最後に巻き戻すので、足した利用者・役・色見本を残さない。
 */
type DbRole = 'anon' | 'authenticated' | 'service_role';
type Actor = { role: DbRole; sub?: string };
type Policy = { policyname: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null };

const TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];

const byCodeUnit = (a: Policy, b: Policy): number => (a.policyname < b.policyname ? -1 : 1);

describeLocalDb('integration: 色見本の表 item_color_presets', (db) => {
  let marker: string;
  let plainUser: string;
  let reader: string;
  let manager: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-color-${randomUUID()}`;

    // 既存の役の割り当てに左右されないよう、この試験だけの役を作って権限を1つずつ付ける
    const readRole = await createRole(['admin.items.read']);
    const manageRole = await createRole(['admin.items.manage']);
    plainUser = await createUser([]);
    reader = await createUser([readRole]);
    manager = await createUser([manageRole]);
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function createRole(permissionCodes: string[]): Promise<string> {
    const code = `integration_color_${randomUUID().replace(/-/g, '')}`;
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

  async function createUser(roleIds: string[]): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '{}', '{}', now(), now())`,
      [id],
    );
    for (const roleId of roleIds) {
      await db().query(
        'insert into public.user_roles (user_id, role_id, active) values ($1, $2::bigint, true)',
        [id, roleId],
      );
    }
    return id;
  }

  async function enter(actor: Actor): Promise<void> {
    const claims = actor.sub ? JSON.stringify({ sub: actor.sub, role: actor.role, aal: 'aal2' }) : '';
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

  /** 表の持ち主（RLS の外）として1件足す。 */
  async function seed(name: string, hex: string): Promise<string> {
    const result = await db().query(
      'insert into public.item_color_presets (name, hex) values ($1, $2) returning id::text as id',
      [`${marker} ${name}`, hex],
    );
    return result.rows[0].id;
  }

  async function namesOwned(): Promise<string[]> {
    const result = await db().query(
      'select name from public.item_color_presets where name like $1 order by name',
      [`${marker}%`],
    );
    return result.rows.map((row) => row.name as string);
  }

  async function hexOf(id: string): Promise<string | undefined> {
    const result = await db().query('select hex from public.item_color_presets where id = $1::bigint', [id]);
    return result.rows[0]?.hex;
  }

  async function visibleAs(actor: Actor): Promise<string[]> {
    const result = await runAs(
      actor,
      'select name from public.item_color_presets where name like $1 order by name',
      [`${marker}%`],
    );
    return result.rows.map((row) => row.name as string);
  }

  async function policies(): Promise<Policy[]> {
    const result = await db().query(
      `select policyname, roles::text[] as roles, cmd, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = 'item_color_presets'`,
    );
    return (result.rows as Policy[]).sort(byCodeUnit);
  }

  const insertSql = 'insert into public.item_color_presets (name, hex) values ($1, $2)';
  const updateSql = 'update public.item_color_presets set hex = $2 where id = $1::bigint';
  const deleteSql = 'delete from public.item_color_presets where id = $1::bigint';

  test('DATA-ADMIN-005 列は id・名前・色の値・作った時刻で、id は bigint の連番', async () => {
    const result = await db().query(
      `select column_name, data_type, is_nullable, is_identity, column_default
       from information_schema.columns
       where table_schema = 'public' and table_name = 'item_color_presets'
       order by ordinal_position`,
    );

    expect(result.rows.map((row) => [row.column_name, row.data_type, row.is_nullable])).toEqual([
      ['id', 'bigint', 'NO'],
      ['name', 'text', 'NO'],
      ['hex', 'text', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
    ]);
    expect(result.rows[0].is_identity).toBe('YES');
    expect(result.rows[3].column_default).toContain('now()');
  });

  test('DATA-ADMIN-005 連番の id は足すたびに増え、作った時刻は自動で入る', async () => {
    const first = await seed('a', '#112233');
    const second = await seed('b', '#112233');

    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
    const result = await db().query(
      'select count(*)::int as count from public.item_color_presets where id = $1::bigint and created_at is not null',
      [first],
    );
    expect(result.rows[0].count).toBe(1);
  });

  test.each(['#abcdef', '#ABCDEF', '#aBc123', '#000000'])(
    'DATA-ADMIN-005 色の値 %s は # と 16 進の 6 桁なので入る',
    async (hex) => {
      await seed('valid', hex);

      expect(await namesOwned()).toEqual([`${marker} valid`]);
    },
  );

  test.each(['#fff', 'ff0000', '#GGGGGG', '#12345678', '#12345', ' #123456', '#123456 ', ''])(
    'DATA-ADMIN-005 色の値「%s」は CHECK で断られ、1件も入らない',
    async (hex) => {
      expect(await errorCodeAs({ role: 'service_role' }, insertSql, [`${marker} bad`, hex])).toBe('23514');

      expect(await namesOwned()).toEqual([]);
    },
  );

  test('DATA-ADMIN-005 入っている色の値を壊れた値に直すのも CHECK で断られる', async () => {
    const id = await seed('keep', '#123456');

    expect(await errorCodeAs({ role: 'service_role' }, updateSql, [id, 'red'])).toBe('23514');

    expect(await hexOf(id)).toBe('#123456');
  });

  test('DATA-ADMIN-005 同じ名前と色の値の組は2件目が一意の違反で断られる', async () => {
    await seed('dup', '#123456');

    expect(await errorCodeAs({ role: 'service_role' }, insertSql, [`${marker} dup`, '#123456'])).toBe('23505');

    expect(await namesOwned()).toEqual([`${marker} dup`]);
  });

  test('DATA-ADMIN-005 名前だけ同じ、または色の値だけ同じなら別の組として入る', async () => {
    await seed('same-name', '#111111');
    await seed('same-name', '#222222');
    await seed('other-name', '#111111');

    expect(await namesOwned()).toEqual([
      `${marker} other-name`, `${marker} same-name`, `${marker} same-name`,
    ]);
  });

  test('DATA-ADMIN-005 色の値の大文字小文字は別の値として数え、重なりにしない', async () => {
    await seed('case', '#aabbcc');
    await seed('case', '#AABBCC');

    expect(await namesOwned()).toEqual([`${marker} case`, `${marker} case`]);
  });

  test('DATA-ADMIN-005 名前の長さの上限は表に無く、41 字でも入る（40 字の上限は窓口だけ）', async () => {
    const longName = 'x'.repeat(41);

    await db().query(insertSql, [`${marker}${longName}`, '#010203']);

    expect(await namesOwned()).toEqual([`${marker}${longName}`]);
  });

  test('DATA-ADMIN-005 RLS が有効になっている', async () => {
    const result = await db().query(
      "select relrowsecurity from pg_class where oid = 'public.item_color_presets'::regclass",
    );

    expect(result.rows).toEqual([{ relrowsecurity: true }]);
  });

  test('DATA-ADMIN-005 方針は設計の5つで、役と操作と権限の条件が一致する', async () => {
    const rows = await policies();

    expect(rows.map(({ policyname, roles, cmd }) => ({ policyname, roles, cmd }))).toEqual([
      { policyname: 'Service role has full access to item color presets', roles: ['service_role'], cmd: 'ALL' },
      { policyname: 'admin item_color_presets manage by permission delete', roles: ['authenticated'], cmd: 'DELETE' },
      { policyname: 'admin item_color_presets manage by permission insert', roles: ['authenticated'], cmd: 'INSERT' },
      { policyname: 'admin item_color_presets manage by permission update', roles: ['authenticated'], cmd: 'UPDATE' },
      { policyname: 'admin item_color_presets read by permission', roles: ['authenticated'], cmd: 'SELECT' },
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.policyname, row]));
    expect(byName['admin item_color_presets read by permission'].qual).toContain("has_permission('admin.items.read'");
    expect(byName['admin item_color_presets manage by permission insert'].with_check).toContain("has_permission('admin.items.manage'");
    expect(byName['admin item_color_presets manage by permission update'].qual).toContain("has_permission('admin.items.manage'");
    expect(byName['admin item_color_presets manage by permission update'].with_check).toContain("has_permission('admin.items.manage'");
    expect(byName['admin item_color_presets manage by permission delete'].qual).toContain("has_permission('admin.items.manage'");
  });

  test('DATA-ADMIN-005 anon には表の権限が1つも付いておらず、authenticated には SELECT だけが付いている（ADR-0414）', async () => {
    const privilegesOf = async (role: string) => {
      const result = await db().query(
        `select privilege from unnest($2::text[]) as privilege
         where has_table_privilege($1::name, 'public.item_color_presets'::regclass, privilege)
         order by privilege`,
        [role, TABLE_PRIVILEGES],
      );
      return result.rows.map((row) => row.privilege);
    };

    expect(await privilegesOf('anon')).toEqual([]);
    expect(await privilegesOf('authenticated')).toEqual(['SELECT']);
  });

  test('DATA-ADMIN-005 service_role は全部の操作ができる', async () => {
    const actor: Actor = { role: 'service_role' };
    await runAs(actor, insertSql, [`${marker} svc`, '#0a0b0c']);
    const found = await runAs(actor, 'select id::text as id from public.item_color_presets where name = $1', [`${marker} svc`]);
    const id = found.rows[0].id as string;

    const updated = await runAs(actor, updateSql, [id, '#0d0e0f']);
    expect(updated.rowCount).toBe(1);
    expect(await hexOf(id)).toBe('#0d0e0f');

    const deleted = await runAs(actor, deleteSql, [id]);
    expect(deleted.rowCount).toBe(1);
    expect(await namesOwned()).toEqual([]);
  });

  test('DATA-ADMIN-005 anon は読むことも書くことも権限の誤り（42501）で断られ、行は1つも変わらない', async () => {
    const id = await seed('anon', '#123456');

    expect(await errorCodeAs({ role: 'anon' }, 'select name from public.item_color_presets where name like $1', [`${marker}%`])).toBe('42501');
    expect(await errorCodeAs({ role: 'anon' }, insertSql, [`${marker} anon insert`, '#123456'])).toBe('42501');
    expect(await errorCodeAs({ role: 'anon' }, updateSql, [id, '#654321'])).toBe('42501');
    expect(await errorCodeAs({ role: 'anon' }, deleteSql, [id])).toBe('42501');

    expect(await namesOwned()).toEqual([`${marker} anon`]);
    expect(await hexOf(id)).toBe('#123456');
  });

  test('DATA-ADMIN-005 商品の権限が無い authenticated は読めず、入れる・直す・消すは権限の誤り（42501）', async () => {
    const actor: Actor = { role: 'authenticated', sub: plainUser };
    const id = await seed('plain', '#123456');

    expect(await visibleAs(actor)).toEqual([]);
    expect(await errorCodeAs(actor, insertSql, [`${marker} plain insert`, '#123456'])).toBe('42501');
    expect(await errorCodeAs(actor, updateSql, [id, '#654321'])).toBe('42501');
    expect(await errorCodeAs(actor, deleteSql, [id])).toBe('42501');

    expect(await namesOwned()).toEqual([`${marker} plain`]);
    expect(await hexOf(id)).toBe('#123456');
  });

  test('DATA-ADMIN-005 admin.items.read だけの人は読めるが、入れる・直す・消すは権限の誤り（42501）', async () => {
    const actor: Actor = { role: 'authenticated', sub: reader };
    const id = await seed('reader', '#123456');

    expect(await visibleAs(actor)).toEqual([`${marker} reader`]);
    expect(await errorCodeAs(actor, insertSql, [`${marker} reader insert`, '#123456'])).toBe('42501');
    expect(await errorCodeAs(actor, updateSql, [id, '#654321'])).toBe('42501');
    expect(await errorCodeAs(actor, deleteSql, [id])).toBe('42501');

    expect(await namesOwned()).toEqual([`${marker} reader`]);
    expect(await hexOf(id)).toBe('#123456');
  });

  test('DATA-ADMIN-005 admin.items.manage だけの人は読めず、入れる・直す・消すも権限の誤り（42501）', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager };
    const id = await seed('manager', '#123456');

    expect(await visibleAs(actor)).toEqual([]);
    expect(await errorCodeAs(actor, insertSql, [`${marker} manager insert`, '#abcdef'])).toBe('42501');
    expect(await errorCodeAs(actor, updateSql, [id, '#654321'])).toBe('42501');
    expect(await errorCodeAs(actor, deleteSql, [id])).toBe('42501');

    expect(await namesOwned()).toEqual([`${marker} manager`]);
    expect(await hexOf(id)).toBe('#123456');
  });

  test('DATA-ADMIN-005 読みと管理の両方を持つ人は読めるが、入れる・直す・消すは権限の誤り（42501）で、書き込みは service role だけ', async () => {
    const both = await createUser([await createRole(['admin.items.read', 'admin.items.manage'])]);
    const actor: Actor = { role: 'authenticated', sub: both };
    const id = await seed('both', '#123456');

    expect(await visibleAs(actor)).toEqual([`${marker} both`]);
    expect(await errorCodeAs(actor, insertSql, [`${marker} both insert`, '#abcdef'])).toBe('42501');
    expect(await errorCodeAs(actor, updateSql, [id, '#654321'])).toBe('42501');
    expect(await errorCodeAs(actor, deleteSql, [id])).toBe('42501');

    expect(await namesOwned()).toEqual([`${marker} both`]);
    expect(await hexOf(id)).toBe('#123456');
  });

  test('DATA-ADMIN-005 壊れた色の値は CHECK で断られる（書き込みの役は service role）', async () => {
    expect(await errorCodeAs({ role: 'service_role' }, insertSql, [`${marker} bad`, 'blue'])).toBe('23514');

    expect(await namesOwned()).toEqual([]);
  });
});
