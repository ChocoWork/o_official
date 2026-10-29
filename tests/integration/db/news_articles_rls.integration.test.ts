/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { createLiveAppSession, jwtClaims } from './helpers/app-session';
import { describeLocalDb } from './helpers/local-db';

/**
 * news_articles の RLS の方針と表の付与（DATA-NEWS-002）。
 * PostgREST が取引ごとに入れる役と JWT のクレームを set local で再現する。手元の使い捨て DB でだけ流し、
 * 各試験は取引の中で動かして最後に巻き戻すので、足した利用者・役・記事を残さない。
 */
type DbRole = 'anon' | 'authenticated' | 'service_role';
type Actor = { role: DbRole; sub?: string; aal?: string };

const TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];

describeLocalDb('integration: news_articles の RLS と付与', (db) => {
  let marker: string;
  let publishedId: string;
  let privateId: string;
  let plainUser: string;
  let reader: string;
  let manager: string;
  let manageOnly: string;
  // has_permission は aal2 とアプリに結び付いた生きた session を求める（SEC-AUTH-010-AC-03）。利用者ごとの session
  let liveSessions: Map<string, { sessionId: string }>;

  beforeEach(async () => {
    await db().query('begin');
    liveSessions = new Map();
    marker = `integration-news-rls-${randomUUID()}`;
    publishedId = await insertArticle('published');
    privateId = await insertArticle('private');

    // 既存の役の割り当てに左右されないよう、この試験だけの役を作って権限を1つずつ付ける
    const readRole = await createRole(['admin.news.read']);
    const fullRole = await createRole(['admin.news.read', 'admin.news.manage']);
    const manageRole = await createRole(['admin.news.manage']);
    plainUser = await createUser([]);
    reader = await createUser([readRole]);
    manager = await createUser([fullRole]);
    manageOnly = await createUser([manageRole]);
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertArticle(status: 'private' | 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'EVENT', '2026-05-01', 'news/integration/news-rls.png', 'summary', 'body', $2)
       returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  async function createRole(permissionCodes: string[]): Promise<string> {
    const code = `integration_news_${randomUUID().replace(/-/g, '')}`;
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
    liveSessions.set(id, await createLiveAppSession(db(), id));
    return id;
  }

  async function enter(actor: Actor): Promise<void> {
    const session = actor.sub ? liveSessions.get(actor.sub) : undefined;
    const aal = actor.aal === 'aal1' ? 'aal1' : 'aal2';
    const claims = actor.sub
      ? JSON.stringify(session ? { ...jwtClaims(actor.sub, session, aal), role: actor.role } : { sub: actor.sub, role: actor.role, aal })
      : '';
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

  async function visibleIds(actor: Actor): Promise<string[]> {
    const result = await runAs(
      actor,
      `select id::text as id from public.news_articles where id = any($1::bigint[]) order by id`,
      [[publishedId, privateId]],
    );
    return result.rows.map((row) => row.id as string);
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const result = await db().query('select status from public.news_articles where id = $1', [id]);
    return result.rows[0]?.status;
  }

  const insertSql = `insert into public.news_articles
      (title, category, published_date, image_url, content, detailed_content, status)
    values ($1, 'STORE', '2026-05-02', 'news/integration/news-rls-new.png', 'summary', 'body', 'private')`;

  async function countByTitle(title: string): Promise<number> {
    const result = await db().query('select count(*)::int as count from public.news_articles where title = $1', [title]);
    return result.rows[0].count;
  }

  test('DATA-NEWS-002 表の RLS が有効になっている', async () => {
    const result = await db().query(
      "select relrowsecurity from pg_class where oid = 'public.news_articles'::regclass",
    );

    expect(result.rows).toEqual([{ relrowsecurity: true }]);
  });

  test('DATA-NEWS-002 方針は設計の6つで、役と操作が一致する', async () => {
    const result = await db().query(
      `select policyname, roles::text[] as roles, cmd, qual, with_check
       from pg_policies
       where schemaname = 'public' and tablename = 'news_articles'
       order by policyname`,
    );
    const rows = result.rows as { policyname: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }[];

    expect(rows.map(({ policyname, roles, cmd }) => ({ policyname, roles, cmd }))).toEqual([
      { policyname: 'Anyone can view published news articles', roles: ['anon'], cmd: 'SELECT' },
      { policyname: 'Service role has full access to news articles', roles: ['service_role'], cmd: 'ALL' },
      { policyname: 'admin news manage by permission delete', roles: ['authenticated'], cmd: 'DELETE' },
      { policyname: 'admin news manage by permission insert', roles: ['authenticated'], cmd: 'INSERT' },
      { policyname: 'admin news manage by permission update', roles: ['authenticated'], cmd: 'UPDATE' },
      { policyname: 'authenticated news read', roles: ['authenticated'], cmd: 'SELECT' },
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.policyname, row]));
    expect(byName['Anyone can view published news articles'].qual).toContain("'published'");
    expect(byName['Anyone can view published news articles'].qual).not.toContain('has_permission');
    expect(byName['authenticated news read'].qual).toContain("'published'");
    expect(byName['authenticated news read'].qual).toContain("has_permission('admin.news.read'");
    expect(byName['admin news manage by permission insert'].with_check).toContain("has_permission('admin.news.manage'");
    expect(byName['admin news manage by permission update'].qual).toContain("has_permission('admin.news.manage'");
    expect(byName['admin news manage by permission update'].with_check).toContain("has_permission('admin.news.manage'");
    expect(byName['admin news manage by permission delete'].qual).toContain("has_permission('admin.news.manage'");
  });

  test.each(['anon', 'authenticated'] as const)('DATA-NEWS-002 %s には表の SELECT だけが付いていて、書き込み系の権限は付いていない（ADR-0414）', async (role) => {
    const result = await db().query(
      `select privilege from unnest($2::text[]) as privilege
       where has_table_privilege($1, 'public.news_articles', privilege)
       order by privilege`,
      [role, TABLE_PRIVILEGES],
    );

    expect(result.rows.map((row) => row.privilege)).toEqual(['SELECT']);
  });

  test('DATA-NEWS-002 anon は has_permission を呼べず、authenticated は呼べる', async () => {
    const result = await db().query(
      `select has_function_privilege('anon', 'public.has_permission(text)', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.has_permission(text)', 'EXECUTE') as authenticated`,
    );

    expect(result.rows).toEqual([{ anon: false, authenticated: true }]);
  });

  test('DATA-NEWS-002 anon は公開済みだけを読める', async () => {
    expect(await visibleIds({ role: 'anon' })).toEqual([publishedId]);
  });

  test('DATA-NEWS-002 anon の追加・更新・削除は権限の誤り（42501）で落ち、1行も変えない', async () => {
    const title = `${marker} anon insert`;
    expect(await errorCodeAs({ role: 'anon' }, insertSql, [title])).toBe('42501');
    expect(await countByTitle(title)).toBe(0);

    expect(
      await errorCodeAs({ role: 'anon' }, "update public.news_articles set status = 'private' where id = $1", [publishedId]),
    ).toBe('42501');
    expect(
      await errorCodeAs({ role: 'anon' }, 'delete from public.news_articles where id = any($1::bigint[])', [[publishedId, privateId]]),
    ).toBe('42501');

    expect(await statusOf(publishedId)).toBe('published');
    expect(await statusOf(privateId)).toBe('private');
  });

  test('DATA-NEWS-002 sub の無い authenticated は公開済みだけを読める', async () => {
    expect(await visibleIds({ role: 'authenticated' })).toEqual([publishedId]);
  });

  test('DATA-NEWS-002 権限の無い会員は公開済みだけを読め、追加・更新・削除ができない', async () => {
    const actor: Actor = { role: 'authenticated', sub: plainUser };
    const title = `${marker} plain insert`;

    expect(await visibleIds(actor)).toEqual([publishedId]);
    expect(await errorCodeAs(actor, insertSql, [title])).toBe('42501');
    expect(await countByTitle(title)).toBe(0);
    expect(await errorCodeAs(actor, "update public.news_articles set status = 'private' where id = $1", [publishedId])).toBe('42501');
    expect(await errorCodeAs(actor, 'delete from public.news_articles where id = $1', [publishedId])).toBe('42501');
    expect(await statusOf(publishedId)).toBe('published');
  });

  test('DATA-NEWS-002 admin.news.read を持つ会員は非公開も読めるが、書き換えはできない', async () => {
    const actor: Actor = { role: 'authenticated', sub: reader };
    const title = `${marker} reader insert`;

    expect(await visibleIds(actor)).toEqual([publishedId, privateId].sort((a, b) => Number(a) - Number(b)));
    expect(await errorCodeAs(actor, insertSql, [title])).toBe('42501');
    expect(await countByTitle(title)).toBe(0);
    expect(await errorCodeAs(actor, "update public.news_articles set status = 'published' where id = $1", [privateId])).toBe('42501');
    expect(await errorCodeAs(actor, 'delete from public.news_articles where id = $1', [privateId])).toBe('42501');
    expect(await statusOf(privateId)).toBe('private');
  });

  test('DATA-NEWS-002 割り当てが止まっているか期限切れの会員は非公開を読めない', async () => {
    const roleId = await createRole(['admin.news.read']);
    const inactive = await createUser([roleId], { active: false, expired: false });
    const expired = await createUser([roleId], { active: true, expired: true });

    expect(await visibleIds({ role: 'authenticated', sub: inactive })).toEqual([publishedId]);
    expect(await visibleIds({ role: 'authenticated', sub: expired })).toEqual([publishedId]);
  });

  test('DATA-NEWS-002 admin.news.read と admin.news.manage を持つ会員でも、追加・更新・削除は権限の誤り（42501）で断られる（書き込みは service role だけ）', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager };
    const title = `${marker} manager insert`;

    expect(await errorCodeAs(actor, insertSql, [title])).toBe('42501');
    expect(await errorCodeAs(actor, "update public.news_articles set status = 'published' where id = $1", [privateId])).toBe('42501');
    expect(await errorCodeAs(actor, 'delete from public.news_articles where id = $1', [publishedId])).toBe('42501');

    expect(await countByTitle(title)).toBe(0);
    expect(await statusOf(privateId)).toBe('private');
    expect(await statusOf(publishedId)).toBe('published');
  });

  test('DATA-NEWS-002 admin.news.manage だけの会員も追加は権限の誤り（42501）で、非公開は読めない', async () => {
    const actor: Actor = { role: 'authenticated', sub: manageOnly };
    const title = `${marker} manage-only insert`;

    expect(await errorCodeAs(actor, insertSql, [title])).toBe('42501');

    expect(await countByTitle(title)).toBe(0);
    expect(await visibleIds(actor)).toEqual([publishedId]);
  });

  test('DATA-NEWS-002 DB は aal2 を求めるので、結び付いた生きた session があっても aal1 の JWT では権限があっても公開済みしか読めず、書き込みは権限の誤り（42501）で断られる（SEC-AUTH-010-AC-03）', async () => {
    const actor: Actor = { role: 'authenticated', sub: manager, aal: 'aal1' };

    expect(await visibleIds(actor)).toEqual([publishedId]);
    expect(await errorCodeAs(actor, "update public.news_articles set status = 'published' where id = $1", [privateId])).toBe('42501');
    expect(await statusOf(privateId)).toBe('private');
  });

  test('DATA-NEWS-002 admin.news.read を持つ会員でも、aal1 か結び付いた生きた session が無ければ公開済みしか読めない（SEC-AUTH-010-AC-03）', async () => {
    // 生きた aal2 session がある時は非公開も読める（対照）
    expect(await visibleIds({ role: 'authenticated', sub: reader })).toEqual([publishedId, privateId].sort((a, b) => Number(a) - Number(b)));
    // aal1 の JWT
    expect(await visibleIds({ role: 'authenticated', sub: reader, aal: 'aal1' })).toEqual([publishedId]);
    // アプリに結び付いていない session、結び付いたが失効済みの session
    for (const options of [{ bind: false }, { revoked: true }]) {
      liveSessions.set(reader, await createLiveAppSession(db(), reader, options));
      expect(await visibleIds({ role: 'authenticated', sub: reader })).toEqual([publishedId]);
    }
  });

  test('DATA-NEWS-002 service_role は全部を読み、追加・更新・削除ができる', async () => {
    const actor: Actor = { role: 'service_role' };
    const title = `${marker} service insert`;

    expect(await visibleIds(actor)).toEqual([publishedId, privateId].sort((a, b) => Number(a) - Number(b)));
    const inserted = await runAs(actor, insertSql, [title]);
    const updated = await runAs(actor, "update public.news_articles set status = 'published' where id = $1", [privateId]);
    const deleted = await runAs(actor, 'delete from public.news_articles where id = $1', [publishedId]);

    expect(inserted.rowCount).toBe(1);
    expect(await countByTitle(title)).toBe(1);
    expect(updated.rowCount).toBe(1);
    expect(await statusOf(privateId)).toBe('published');
    expect(deleted.rowCount).toBe(1);
    expect(await statusOf(publishedId)).toBeUndefined();
  });
});
