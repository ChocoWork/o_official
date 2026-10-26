/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { adminTableTools, WRITE_PRIVILEGES } from './helpers/admin-table-grants';

/**
 * 管理だけが書く表から anon・authenticated の書き込みを外した移行 sec_grants_admin_tables のうち、
 * news_articles の権限（DATA-NEWS-002、SEC-NEWS-002-AC-02・SEC-NEWS-022、ADR-0414）。
 * 手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻すので、足した行を残さない。
 */
describeLocalDb('integration: news_articles の権限（書き込みは service role だけ）', (db) => {
  const { failureAs, rowsAs, privileges, columnWritePrivileges, insertAdmin, insertMember, isPermissionDenied } = adminTableTools(db);
  let marker: string;
  let publishedId: string;
  let privateId: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-news-grants-${randomUUID()}`;
    publishedId = await insertArticle('published');
    privateId = await insertArticle('private');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertArticle(status: 'private' | 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.news_articles
         (title, category, published_date, image_url, content, detailed_content, status)
       values ($1, 'EVENT', '2026-05-01', 'news/e2e/grants.png', 'summary', 'body', $2)
       returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  const insertSql = `insert into public.news_articles
      (title, category, published_date, image_url, content, detailed_content, status)
    values ($1, 'STORE', '2026-05-02', 'news/e2e/grants-new.png', 'summary', 'body', 'private')`;
  const updateSql = `update public.news_articles set title = 'tampered' where id = $1`;
  const deleteSql = 'delete from public.news_articles where id = $1';

  test.each(['anon', 'authenticated'])('DATA-NEWS-002 %s の news_articles は SELECT だけを持ち、書き込み系の 7 権限を表単位でも列単位でも持たない', async (role) => {
    expect(await privileges(role, 'news_articles')).toEqual(['SELECT']);
    expect(await privileges(role, 'news_articles', WRITE_PRIVILEGES)).toEqual([]);
    expect(await columnWritePrivileges(role, 'news_articles')).toEqual({
      column_insert: false,
      column_update: false,
      column_references: false,
    });
  });

  test('DATA-NEWS-002 service_role の news_articles は 4 つの行の操作を持つ', async () => {
    expect(await privileges('service_role', 'news_articles', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  test('DATA-NEWS-002 追加・更新・削除・全消しは、anon も、aal2 の管理者の JWT の authenticated も、RLS の違反でなく権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();

    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      expect(isPermissionDenied(await failureAs(role, claims, insertSql, [`${marker} new`]), 'news_articles')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, updateSql, [publishedId]), 'news_articles')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, deleteSql, [publishedId]), 'news_articles')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, 'truncate public.news_articles'), 'news_articles')).toBe(true);
    }
    const left = await db().query('select title from public.news_articles where id = $1', [publishedId]);
    expect(left.rows).toEqual([{ title: `${marker} published` }]);
  });

  test('DATA-NEWS-002 service_role は news_articles を追加・更新・削除できる', async () => {
    expect(await failureAs('service_role', null, insertSql, [`${marker} svc`])).toBeNull();
    expect(await failureAs('service_role', null, updateSql, [publishedId])).toBeNull();
    expect(await failureAs('service_role', null, deleteSql, [publishedId])).toBeNull();
  });

  test('DATA-NEWS-002 連番 news_articles_id_seq は anon・authenticated が USAGE・SELECT・UPDATE を持たず、直に進める（nextval）と権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();
    const result = await db().query(
      `select r.role,
              has_sequence_privilege(r.role, 'public.news_articles_id_seq', 'USAGE') as usage,
              has_sequence_privilege(r.role, 'public.news_articles_id_seq', 'SELECT') as "select",
              has_sequence_privilege(r.role, 'public.news_articles_id_seq', 'UPDATE') as "update"
       from unnest(array['anon', 'authenticated']) as r(role) order by r.role`,
    );
    expect(result.rows).toEqual([
      { role: 'anon', usage: false, select: false, update: false },
      { role: 'authenticated', usage: false, select: false, update: false },
    ]);
    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      const failure = await failureAs(role, claims, "select nextval('public.news_articles_id_seq')");
      expect(failure?.code).toBe('42501');
      expect(failure?.message).toBe('permission denied for sequence news_articles_id_seq');
    }
    // identity の既定値は連番の権限を見ないので、service_role の追加は連番を外した後も通る
    expect(await failureAs('service_role', null, insertSql, [`${marker} seq`])).toBeNull();
  });

  test('DATA-NEWS-002 公開の読みは変わらない: anon も会員も公開済みだけを読み、管理者の読み方針（admin.news.read）は働き続ける', async () => {
    const admin = await insertAdmin();
    const member = await insertMember();
    const sql = 'select id::text as id from public.news_articles where id = any($1::bigint[]) order by id';
    const ids = [publishedId, privateId];

    expect(await rowsAs('anon', null, sql, [ids])).toEqual([{ id: publishedId }]);
    expect(await rowsAs('authenticated', member, sql, [ids])).toEqual([{ id: publishedId }]);
    const adminRows = await rowsAs('authenticated', admin, sql, [ids]);
    expect(adminRows.map((row) => row.id).sort()).toEqual([publishedId, privateId].sort());
  });

  test('DATA-NEWS-002 書き込みの RLS 方針（admin news manage by permission）は二重の守りとして残っている', async () => {
    const result = await db().query(
      `select cmd from pg_policies
       where schemaname = 'public' and tablename = 'news_articles' and policyname like 'admin % manage by permission %'
       order by cmd`,
    );
    expect(result.rows).toEqual([{ cmd: 'DELETE' }, { cmd: 'INSERT' }, { cmd: 'UPDATE' }]);
  });
});
