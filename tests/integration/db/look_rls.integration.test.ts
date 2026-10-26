/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';

/**
 * looks・look_items の RLS の方針と表の付与（DATA-LOOK-003）。
 * PostgREST が取引ごとに入れる役と JWT のクレームを set local で再現する。手元の使い捨て DB でだけ流し、
 * 各試験は取引の中で動かして最後に巻き戻すので、足した利用者・役・LOOK・商品を残さない。
 */
type DbRole = 'anon' | 'authenticated' | 'service_role';
type Actor = { role: DbRole; sub?: string; aal?: string };
type Policy = { policyname: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null };

const byCodeUnit = (a: Policy, b: Policy): number => (a.policyname < b.policyname ? -1 : 1);
const byNumber = (a: string, b: string): number => Number(a) - Number(b);

describeLocalDb('integration: looks・look_items の RLS と付与', (db) => {
  let marker: string;
  let publishedLook: string;
  let privateLook: string;
  let publicItem: string;
  let privateItem: string;
  let spareItem: string;
  let plainUser: string;
  let reader: string;
  let manager: string;
  let manageOnly: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-look-rls-${randomUUID()}`;
    publishedLook = await insertLook('published');
    privateLook = await insertLook('private');
    publicItem = await insertItem('published');
    privateItem = await insertItem('private');
    spareItem = await insertItem('published');
    await link(publishedLook, publicItem);
    await link(publishedLook, privateItem);
    await link(privateLook, publicItem);

    // 既存の役の割り当てに左右されないよう、この試験だけの役を作って権限を1つずつ付ける
    const readRole = await createRole(['admin.looks.read']);
    const fullRole = await createRole(['admin.looks.read', 'admin.looks.manage']);
    const manageRole = await createRole(['admin.looks.manage']);
    plainUser = await createUser([]);
    reader = await createUser([readRole]);
    manager = await createUser([fullRole]);
    manageOnly = await createUser([manageRole]);
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertLook(status: 'private' | 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.looks (season_year, season_type, theme, status)
       values (2026, 'AW', $1, $2) returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function insertItem(status: 'private' | 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'integration item', 1000, 'TOPS', 'integration/look-rls.png', $2)
       returning id::text as id`,
      [`${marker} item ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function link(lookId: string, itemId: string): Promise<void> {
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [lookId, itemId]);
  }

  async function createRole(permissionCodes: string[]): Promise<string> {
    const code = `integration_look_${randomUUID().replace(/-/g, '')}`;
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

  async function visibleLooks(actor: Actor): Promise<string[]> {
    const result = await runAs(
      actor,
      'select id::text as id from public.looks where id = any($1::bigint[]) order by id',
      [[publishedLook, privateLook]],
    );
    return result.rows.map((row) => row.id as string);
  }

  /** 見える関連を「LOOK:商品」の文字で返す。 */
  async function visibleLinks(actor: Actor): Promise<string[]> {
    const result = await runAs(
      actor,
      `select look_id::text || ':' || item_id::text as pair from public.look_items
       where look_id = any($1::bigint[]) order by look_id, item_id`,
      [[publishedLook, privateLook]],
    );
    return result.rows.map((row) => row.pair as string);
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const result = await db().query('select status from public.looks where id = $1', [id]);
    return result.rows[0]?.status;
  }

  async function linkCount(lookId: string, itemId: string): Promise<number> {
    const result = await db().query(
      'select count(*)::int as count from public.look_items where look_id = $1 and item_id = $2', [lookId, itemId],
    );
    return result.rows[0].count;
  }

  async function countByTheme(theme: string): Promise<number> {
    const result = await db().query('select count(*)::int as count from public.looks where theme = $1', [theme]);
    return result.rows[0].count;
  }

  async function policies(table: string): Promise<Policy[]> {
    const result = await db().query(
      `select policyname, roles::text[] as roles, cmd, qual, with_check
       from pg_policies where schemaname = 'public' and tablename = $1`,
      [table],
    );
    return (result.rows as Policy[]).sort(byCodeUnit);
  }

  const insertLookSql = `insert into public.looks (season_year, season_type, theme, status)
    values (2026, 'SS', $1, 'private')`;
  const insertLinkSql = 'insert into public.look_items (look_id, item_id) values ($1, $2)';
  const setLookStatusSql = 'update public.looks set status = $2 where id = $1';
  const touchLinkSql = "update public.look_items set created_at = '2020-01-01T00:00:00Z' where look_id = $1 and item_id = $2";
  const deleteLinkSql = 'delete from public.look_items where look_id = $1 and item_id = $2';

  test.each(['looks', 'look_items'])('DATA-LOOK-003 %s の RLS が有効になっている', async (table) => {
    const result = await db().query(
      'select relrowsecurity from pg_class where oid = $1::regclass', [`public.${table}`],
    );

    expect(result.rows).toEqual([{ relrowsecurity: true }]);
  });

  test('DATA-LOOK-003 looks の方針は設計の6つで、役と操作と条件が一致する', async () => {
    const rows = await policies('looks');

    expect(rows.map(({ policyname, roles, cmd }) => ({ policyname, roles, cmd }))).toEqual([
      { policyname: 'Anyone can view published looks', roles: ['anon'], cmd: 'SELECT' },
      { policyname: 'Service role has full access to looks', roles: ['service_role'], cmd: 'ALL' },
      { policyname: 'admin looks manage by permission delete', roles: ['authenticated'], cmd: 'DELETE' },
      { policyname: 'admin looks manage by permission insert', roles: ['authenticated'], cmd: 'INSERT' },
      { policyname: 'admin looks manage by permission update', roles: ['authenticated'], cmd: 'UPDATE' },
      { policyname: 'authenticated looks read', roles: ['authenticated'], cmd: 'SELECT' },
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.policyname, row]));
    expect(byName['Anyone can view published looks'].qual).toContain("'published'");
    expect(byName['Anyone can view published looks'].qual).not.toContain('has_permission');
    expect(byName['authenticated looks read'].qual).toContain("'published'");
    expect(byName['authenticated looks read'].qual).toContain("has_permission('admin.looks.read'");
    expect(byName['admin looks manage by permission insert'].with_check).toContain("has_permission('admin.looks.manage'");
    expect(byName['admin looks manage by permission update'].qual).toContain("has_permission('admin.looks.manage'");
    expect(byName['admin looks manage by permission update'].with_check).toContain("has_permission('admin.looks.manage'");
    expect(byName['admin looks manage by permission delete'].qual).toContain("has_permission('admin.looks.manage'");
  });

  test('DATA-LOOK-003 look_items の方針は設計の6つで、役と操作と条件が一致する（読みは親の LOOK と商品の両方が公開、ADR-0162）', async () => {
    const rows = await policies('look_items');

    expect(rows.map(({ policyname, roles, cmd }) => ({ policyname, roles, cmd }))).toEqual([
      { policyname: 'Service role has full access to look items', roles: ['service_role'], cmd: 'ALL' },
      { policyname: 'admin look_items manage by permission delete', roles: ['authenticated'], cmd: 'DELETE' },
      { policyname: 'admin look_items manage by permission insert', roles: ['authenticated'], cmd: 'INSERT' },
      { policyname: 'admin look_items manage by permission update', roles: ['authenticated'], cmd: 'UPDATE' },
      { policyname: 'anon reads links of published looks to published items', roles: ['anon'], cmd: 'SELECT' },
      { policyname: 'authenticated reads published links, admins read all', roles: ['authenticated'], cmd: 'SELECT' },
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.policyname, row]));
    const anonRead = byName['anon reads links of published looks to published items'];
    const authenticatedRead = byName['authenticated reads published links, admins read all'];
    // 親の LOOK の status と商品の status の 2 か所で 'published' を見る
    expect(anonRead.qual?.split("'published'").length).toBe(3);
    expect(anonRead.qual).not.toContain('has_permission');
    expect(authenticatedRead.qual?.split("'published'").length).toBe(3);
    expect(authenticatedRead.qual).toContain("has_permission('admin.looks.read'");
    expect(byName['admin look_items manage by permission insert'].with_check).toContain("has_permission('admin.looks.manage'");
    expect(byName['admin look_items manage by permission update'].qual).toContain("has_permission('admin.looks.manage'");
    expect(byName['admin look_items manage by permission update'].with_check).toContain("has_permission('admin.looks.manage'");
    expect(byName['admin look_items manage by permission delete'].qual).toContain("has_permission('admin.looks.manage'");
  });

  test.each([
    ['anon', 'looks'], ['anon', 'look_items'], ['authenticated', 'looks'], ['authenticated', 'look_items'],
  ])('DATA-LOOK-003 %s には %s の SELECT だけが付いていて、書き込み系の権限は付いていない（ADR-0414）', async (role, table) => {
    const result = await db().query(
      `select privilege from unnest($3::text[]) as privilege
       where has_table_privilege($1::name, $2::regclass, privilege)
       order by privilege`,
      [role, `public.${table}`, ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']],
    );

    expect(result.rows.map((row) => row.privilege)).toEqual(['SELECT']);
  });

  test('DATA-LOOK-003 anon は has_permission を呼べず、authenticated は呼べる', async () => {
    const result = await db().query(
      `select has_function_privilege('anon', 'public.has_permission(text)', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.has_permission(text)', 'EXECUTE') as authenticated`,
    );

    expect(result.rows).toEqual([{ anon: false, authenticated: true }]);
  });

  test('DATA-LOOK-003 anon は公開済みの LOOK と、その LOOK から公開済みの商品への関連だけを読める', async () => {
    expect(await visibleLooks({ role: 'anon' })).toEqual([publishedLook]);
    expect(await visibleLinks({ role: 'anon' })).toEqual([`${publishedLook}:${publicItem}`]);
  });

  test('DATA-LOOK-003 SEC-LOOK-002 anon は公開済みの LOOK につながる非公開の商品の番号を読めず、公開の商品の番号は読める', async () => {
    const hidden = await runAs(
      { role: 'anon' },
      'select item_id::text as item_id from public.look_items where look_id = $1 and item_id = $2',
      [publishedLook, privateItem],
    );
    const shown = await runAs(
      { role: 'anon' },
      'select item_id::text as item_id from public.look_items where look_id = $1 and item_id = $2',
      [publishedLook, publicItem],
    );

    expect(hidden.rows).toEqual([]);
    expect(shown.rows).toEqual([{ item_id: publicItem }]);
  });

  test('DATA-LOOK-003 SEC-LOOK-002 商品が非公開から公開に変わると、その関連が anon に見えるようになる', async () => {
    await db().query("update public.items set status = 'published' where id = $1", [privateItem]);

    expect(await visibleLinks({ role: 'anon' })).toEqual([
      `${publishedLook}:${publicItem}`, `${publishedLook}:${privateItem}`,
    ]);
  });

  test('DATA-LOOK-003 anon の LOOK の追加・更新・削除は権限の誤り（42501）で落ち、1行も変えない', async () => {
    const theme = `${marker} anon insert`;
    expect(await errorCodeAs({ role: 'anon' }, insertLookSql, [theme])).toBe('42501');
    expect(await countByTheme(theme)).toBe(0);

    expect(await errorCodeAs({ role: 'anon' }, setLookStatusSql, [publishedLook, 'private'])).toBe('42501');
    expect(
      await errorCodeAs({ role: 'anon' }, 'delete from public.looks where id = any($1::bigint[])', [[publishedLook, privateLook]]),
    ).toBe('42501');

    expect(await statusOf(publishedLook)).toBe('published');
    expect(await statusOf(privateLook)).toBe('private');
  });

  test('DATA-LOOK-003 anon の関連の追加・更新・削除は権限の誤り（42501）で落ち、1行も変えない', async () => {
    expect(await errorCodeAs({ role: 'anon' }, insertLinkSql, [publishedLook, spareItem])).toBe('42501');
    expect(await linkCount(publishedLook, spareItem)).toBe(0);

    expect(await errorCodeAs({ role: 'anon' }, touchLinkSql, [publishedLook, publicItem])).toBe('42501');
    expect(await errorCodeAs({ role: 'anon' }, deleteLinkSql, [publishedLook, publicItem])).toBe('42501');

    expect(await linkCount(publishedLook, publicItem)).toBe(1);
  });

  test('DATA-LOOK-003 sub の無い authenticated は公開済みの LOOK と、公開済みの商品への関連だけを読める', async () => {
    expect(await visibleLooks({ role: 'authenticated' })).toEqual([publishedLook]);
    expect(await visibleLinks({ role: 'authenticated' })).toEqual([`${publishedLook}:${publicItem}`]);
  });

  test('DATA-LOOK-003 権限の無い会員は公開済みだけを読め、LOOK も関連も書き換えられない', async () => {
    const actor: Actor = { role: 'authenticated', sub: plainUser };
    const theme = `${marker} plain insert`;

    expect(await visibleLooks(actor)).toEqual([publishedLook]);
    expect(await visibleLinks(actor)).toEqual([`${publishedLook}:${publicItem}`]);
    expect(await errorCodeAs(actor, insertLookSql, [theme])).toBe('42501');
    expect(await countByTheme(theme)).toBe(0);
    expect(await errorCodeAs(actor, insertLinkSql, [publishedLook, spareItem])).toBe('42501');
    expect(await linkCount(publishedLook, spareItem)).toBe(0);
    expect(await errorCodeAs(actor, setLookStatusSql, [publishedLook, 'private'])).toBe('42501');
    expect(await errorCodeAs(actor, 'delete from public.looks where id = $1', [publishedLook])).toBe('42501');
    expect(await errorCodeAs(actor, touchLinkSql, [publishedLook, publicItem])).toBe('42501');
    expect(await errorCodeAs(actor, deleteLinkSql, [publishedLook, publicItem])).toBe('42501');
    expect(await statusOf(publishedLook)).toBe('published');
    expect(await linkCount(publishedLook, publicItem)).toBe(1);
  });

  test('DATA-LOOK-003 admin.looks.read を持つ会員は非公開の LOOK と、非公開の商品への関連も読めるが、書き換えはできない', async () => {
    const actor: Actor = { role: 'authenticated', sub: reader };
    const theme = `${marker} reader insert`;

    expect(await visibleLooks(actor)).toEqual([publishedLook, privateLook].sort(byNumber));
    expect(await visibleLinks(actor)).toHaveLength(3);
    expect(await visibleLinks(actor)).toContain(`${publishedLook}:${privateItem}`);
    expect(await errorCodeAs(actor, insertLookSql, [theme])).toBe('42501');
    expect(await countByTheme(theme)).toBe(0);
    expect(await errorCodeAs(actor, insertLinkSql, [privateLook, spareItem])).toBe('42501');
    expect(await linkCount(privateLook, spareItem)).toBe(0);
    expect(await errorCodeAs(actor, setLookStatusSql, [privateLook, 'published'])).toBe('42501');
    expect(await errorCodeAs(actor, 'delete from public.looks where id = $1', [privateLook])).toBe('42501');
    expect(await errorCodeAs(actor, deleteLinkSql, [privateLook, publicItem])).toBe('42501');
    expect(await statusOf(privateLook)).toBe('private');
    expect(await linkCount(privateLook, publicItem)).toBe(1);
  });

  test('DATA-LOOK-003 割り当てが止まっているか期限切れの会員は非公開を読めない', async () => {
    const roleId = await createRole(['admin.looks.read']);
    const inactive = await createUser([roleId], { active: false, expired: false });
    const expired = await createUser([roleId], { active: true, expired: true });

    expect(await visibleLooks({ role: 'authenticated', sub: inactive })).toEqual([publishedLook]);
    expect(await visibleLooks({ role: 'authenticated', sub: expired })).toEqual([publishedLook]);
    expect(await visibleLinks({ role: 'authenticated', sub: inactive })).toHaveLength(1);
    expect(await visibleLinks({ role: 'authenticated', sub: expired })).toHaveLength(1);
  });

  test('DATA-LOOK-003 admin.looks.read と admin.looks.manage を持つ会員でも、LOOK も関連も追加・更新・削除は権限の誤り（42501）で断られる（書き込みは service role だけ）', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager };
    const theme = `${marker} manager insert`;

    expect(await errorCodeAs(actor, insertLookSql, [theme])).toBe('42501');
    expect(await errorCodeAs(actor, setLookStatusSql, [privateLook, 'published'])).toBe('42501');
    expect(await errorCodeAs(actor, insertLinkSql, [privateLook, spareItem])).toBe('42501');
    expect(await errorCodeAs(actor, touchLinkSql, [privateLook, publicItem])).toBe('42501');
    expect(await errorCodeAs(actor, deleteLinkSql, [privateLook, publicItem])).toBe('42501');
    expect(await errorCodeAs(actor, 'delete from public.looks where id = $1', [publishedLook])).toBe('42501');

    expect(await countByTheme(theme)).toBe(0);
    expect(await statusOf(privateLook)).toBe('private');
    expect(await linkCount(privateLook, spareItem)).toBe(0);
    expect(await linkCount(privateLook, publicItem)).toBe(1);
    expect(await statusOf(publishedLook)).toBe('published');
  });

  test('DATA-LOOK-003 admin.looks.manage だけの会員も追加は権限の誤り（42501）で、非公開は読めない', async () => {
    const actor: Actor = { role: 'authenticated', sub: manageOnly };
    const theme = `${marker} manage-only insert`;

    expect(await errorCodeAs(actor, insertLookSql, [theme])).toBe('42501');
    expect(await errorCodeAs(actor, insertLinkSql, [publishedLook, spareItem])).toBe('42501');

    expect(await countByTheme(theme)).toBe(0);
    expect(await linkCount(publishedLook, spareItem)).toBe(0);
    expect(await visibleLooks(actor)).toEqual([publishedLook]);
    expect(await visibleLinks(actor)).toHaveLength(1);
  });

  test('DATA-LOOK-003 DB は aal を見ないので、aal1 の JWT でも権限があれば非公開を読めるが、書き込みは権限の誤り（42501）で断られる', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager, aal: 'aal1' };

    expect(await visibleLooks(actor)).toEqual([publishedLook, privateLook].sort(byNumber));
    expect(await errorCodeAs(actor, setLookStatusSql, [privateLook, 'published'])).toBe('42501');
    expect(await statusOf(privateLook)).toBe('private');
  });

  test('DATA-LOOK-003 service_role は全部を読み、LOOK も関連も追加・更新・削除ができる', async () => {
    const actor: Actor = { role: 'service_role' };
    const theme = `${marker} service insert`;

    expect(await visibleLooks(actor)).toEqual([publishedLook, privateLook].sort(byNumber));
    expect(await visibleLinks(actor)).toHaveLength(3);
    const inserted = await runAs(actor, insertLookSql, [theme]);
    const updated = await runAs(actor, setLookStatusSql, [privateLook, 'published']);
    const linked = await runAs(actor, insertLinkSql, [privateLook, spareItem]);
    const unlinked = await runAs(actor, deleteLinkSql, [privateLook, publicItem]);
    const deleted = await runAs(actor, 'delete from public.looks where id = $1', [publishedLook]);

    expect(inserted.rowCount).toBe(1);
    expect(await countByTheme(theme)).toBe(1);
    expect(updated.rowCount).toBe(1);
    expect(await statusOf(privateLook)).toBe('published');
    expect(linked.rowCount).toBe(1);
    expect(unlinked.rowCount).toBe(1);
    expect(deleted.rowCount).toBe(1);
    expect(await statusOf(publishedLook)).toBeUndefined();
  });
});
