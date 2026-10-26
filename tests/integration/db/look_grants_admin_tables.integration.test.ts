/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { readMigration } from '../../helpers/staged-supabase';
import { describeLocalDb } from './helpers/local-db';
import { adminTableTools, WRITE_PRIVILEGES } from './helpers/admin-table-grants';

/**
 * 管理だけが書く表から anon・authenticated の書き込みを外した移行 sec_grants_admin_tables のうち、
 * looks・look_items の権限（DATA-LOOK-003、SEC-LOOK-003-AC-02・SEC-LOOK-004、ADR-0414）。
 * 前半は移行のファイルの形だけを見る（DB なしで流れる。5 表ぶんの検査をここに置く）。
 * 後半は手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻すので、足した行を残さない。
 */
const ADMIN_TABLES = ['looks', 'look_items', 'news_articles', 'stockists', 'item_color_presets'];

describe('DATA-LOOK-003 移行 sec_grants_admin_tables の形（DB なし）', () => {
  const sql = readMigration('sec_grants_admin_tables');
  const header = sql.slice(0, sql.indexOf('\nBEGIN;'));
  const body = sql.slice(sql.indexOf('\nBEGIN;'));

  test('DATA-LOOK-003 5 表から anon・authenticated・PUBLIC の権限を全部外してから、要る物だけ付け直す', () => {
    expect(body).toMatch(
      /REVOKE ALL ON TABLE public\.looks, public\.look_items, public\.news_articles, public\.stockists,\s+public\.item_color_presets FROM PUBLIC, anon, authenticated;/,
    );
    expect(body.indexOf('REVOKE ALL ON TABLE')).toBeLessThan(body.indexOf('GRANT SELECT ON TABLE'));
  });

  test('DATA-LOOK-003 anon・authenticated に付けるのは SELECT だけで、item_color_presets は authenticated だけ', () => {
    expect(body).toMatch(
      /GRANT SELECT ON TABLE public\.looks, public\.look_items, public\.news_articles, public\.stockists TO anon, authenticated;/,
    );
    expect(body).toMatch(/GRANT SELECT ON TABLE public\.item_color_presets TO authenticated;/);
    const grantsToApiRoles = body.match(/^GRANT [^;]*\bTO\b[^;]*\b(?:anon|authenticated)\b[^;]*;/gm) ?? [];
    expect(grantsToApiRoles).toHaveLength(2);
    for (const grant of grantsToApiRoles) {
      expect(grant).toMatch(/^GRANT SELECT ON TABLE /);
    }
  });

  test('DATA-LOOK-003 service_role の権限を 5 表に明示で付ける', () => {
    expect(body).toMatch(
      /GRANT ALL ON TABLE public\.looks, public\.look_items, public\.news_articles, public\.stockists,\s+public\.item_color_presets TO service_role;/,
    );
  });

  test('DATA-LOOK-003 連番 stockists_id_seq は anon・authenticated から外し、service_role に USAGE・SELECT を明示する', () => {
    expect(body).toMatch(/REVOKE ALL ON SEQUENCE public\.stockists_id_seq FROM PUBLIC, anon, authenticated;/);
    expect(body).toMatch(/GRANT USAGE, SELECT ON SEQUENCE public\.stockists_id_seq TO service_role;/);
  });

  test('DATA-LOOK-003 identity の連番 looks_id_seq・news_articles_id_seq・item_color_presets_id_seq も anon・authenticated・PUBLIC から外し、ヘッダーに戻す GRANT を書く', () => {
    expect(body).toMatch(
      /REVOKE ALL ON SEQUENCE public\.looks_id_seq, public\.news_articles_id_seq, public\.item_color_presets_id_seq\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(header).toMatch(
      /GRANT SELECT, UPDATE, USAGE ON SEQUENCE public\.looks_id_seq, public\.news_articles_id_seq,\s+--\s+public\.item_color_presets_id_seq TO anon, authenticated;/,
    );
  });

  test('DATA-LOOK-003 RLS の書き込み方針は消さず（二重の守り）、ALTER DEFAULT PRIVILEGES も使わない', () => {
    expect(body).not.toMatch(/DROP POLICY/);
    expect(body).not.toMatch(/^\s*ALTER DEFAULT PRIVILEGES/m);
  });

  test('DATA-LOOK-003 ヘッダーに ROLLBACK の節を持ち、5 表と連番を戻す GRANT を全部書く', () => {
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE/);
    for (const table of ADMIN_TABLES) {
      expect(header).toContain(`public.${table}`);
    }
    expect(header).toMatch(/GRANT SELECT, UPDATE, USAGE ON SEQUENCE public\.stockists_id_seq TO anon, authenticated;/);
  });

  test('DATA-LOOK-003 1 組の取引・スキーマ再読込・自己検査（55000）を持ち、5 表と連番と方針を検査する', () => {
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/NOTIFY pgrst, 'reload schema';/g)).toHaveLength(1);
    expect(sql).toContain("RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'");
    expect(sql).toMatch(/ERRCODE = '55000'/);
    for (const table of ADMIN_TABLES) {
      expect(sql).toContain(`'public.${table}'`);
    }
    for (const detail of ['write', 'column_write', 'select', 'sequence', 'service_role', 'service_role_sequence', 'policy']) {
      expect(sql).toContain(`sec_grants_admin_tables:${detail}`);
    }
  });
});

describeLocalDb('integration: looks・look_items の権限（書き込みは service role だけ）', (db) => {
  const { failureAs, rowsAs, privileges, columnWritePrivileges, insertAdmin, insertMember, isPermissionDenied } = adminTableTools(db);
  let marker: string;
  let publishedLook: string;
  let privateLook: string;
  let itemId: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-look-grants-${randomUUID()}`;
    publishedLook = await insertLook('published');
    privateLook = await insertLook('private');
    const item = await db().query(
      `insert into public.items (name, description, price, category, image_url, status)
       values ($1, 'integration item', 1000, 'TOPS', 'items/e2e/look-grants.png', 'published') returning id::text as id`,
      [marker],
    );
    itemId = item.rows[0].id;
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [publishedLook, itemId]);
    await db().query('insert into public.look_items (look_id, item_id) values ($1, $2)', [privateLook, itemId]);
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

  const insertLookSql = `insert into public.looks (season_year, season_type, theme, status) values (2026, 'SS', $1, 'private')`;
  const updateLookSql = `update public.looks set theme = 'tampered' where id = $1`;
  const deleteLookSql = 'delete from public.looks where id = $1';
  const insertLinkSql = 'insert into public.look_items (look_id, item_id) values ($1, $2)';
  const updateLinkSql = `update public.look_items set created_at = '2020-01-01T00:00:00Z' where look_id = $1`;
  const deleteLinkSql = 'delete from public.look_items where look_id = $1';

  test.each(['looks', 'look_items'])('DATA-LOOK-003 anon・authenticated の %s は SELECT だけを持ち、書き込み系の 7 権限を表単位でも列単位でも持たない', async (table) => {
    for (const role of ['anon', 'authenticated']) {
      expect(await privileges(role, table)).toEqual(['SELECT']);
      expect(await privileges(role, table, WRITE_PRIVILEGES)).toEqual([]);
      expect(await columnWritePrivileges(role, table)).toEqual({
        column_insert: false,
        column_update: false,
        column_references: false,
      });
    }
  });

  test.each(['looks', 'look_items'])('DATA-LOOK-003 service_role の %s は 4 つの行の操作を持つ', async (table) => {
    expect(await privileges('service_role', table, ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  test('DATA-LOOK-003 looks への追加・更新・削除・全消しは、anon も、aal2 の管理者の JWT の authenticated も、RLS の違反でなく権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();

    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      expect(isPermissionDenied(await failureAs(role, claims, insertLookSql, [`${marker} new`]), 'looks')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, updateLookSql, [publishedLook]), 'looks')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, deleteLookSql, [publishedLook]), 'looks')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, 'truncate public.looks'), 'looks')).toBe(true);
    }
    const left = await db().query('select theme from public.looks where id = $1', [publishedLook]);
    expect(left.rows).toEqual([{ theme: `${marker} published` }]);
  });

  test('DATA-LOOK-003 look_items への追加・更新・削除・全消しは、anon も、aal2 の管理者の JWT の authenticated も、権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();
    const spare = await insertLook('private');

    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      expect(isPermissionDenied(await failureAs(role, claims, insertLinkSql, [spare, itemId]), 'look_items')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, updateLinkSql, [publishedLook]), 'look_items')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, deleteLinkSql, [publishedLook]), 'look_items')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, 'truncate public.look_items'), 'look_items')).toBe(true);
    }
    const left = await db().query('select count(*)::int as count from public.look_items where look_id = $1', [publishedLook]);
    expect(left.rows[0].count).toBe(1);
  });

  test('DATA-LOOK-003 service_role は looks・look_items を追加・更新・削除できる', async () => {
    const spare = await insertLook('private');

    expect(await failureAs('service_role', null, insertLookSql, [`${marker} svc`])).toBeNull();
    expect(await failureAs('service_role', null, updateLookSql, [publishedLook])).toBeNull();
    expect(await failureAs('service_role', null, insertLinkSql, [spare, itemId])).toBeNull();
    expect(await failureAs('service_role', null, updateLinkSql, [publishedLook])).toBeNull();
    expect(await failureAs('service_role', null, deleteLinkSql, [publishedLook])).toBeNull();
    expect(await failureAs('service_role', null, deleteLookSql, [publishedLook])).toBeNull();
  });

  test('DATA-LOOK-003 連番 looks_id_seq は anon・authenticated が USAGE・SELECT・UPDATE を持たず、直に進める（nextval）と権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();
    const result = await db().query(
      `select r.role,
              has_sequence_privilege(r.role, 'public.looks_id_seq', 'USAGE') as usage,
              has_sequence_privilege(r.role, 'public.looks_id_seq', 'SELECT') as "select",
              has_sequence_privilege(r.role, 'public.looks_id_seq', 'UPDATE') as "update"
       from unnest(array['anon', 'authenticated']) as r(role) order by r.role`,
    );
    expect(result.rows).toEqual([
      { role: 'anon', usage: false, select: false, update: false },
      { role: 'authenticated', usage: false, select: false, update: false },
    ]);
    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      const failure = await failureAs(role, claims, "select nextval('public.looks_id_seq')");
      expect(failure?.code).toBe('42501');
      expect(failure?.message).toBe('permission denied for sequence looks_id_seq');
    }
    // identity の既定値は連番の権限を見ないので、service_role の追加は連番を外した後も通る
    expect(await failureAs('service_role', null, insertLookSql, [`${marker} seq`])).toBeNull();
  });

  test('DATA-LOOK-003 公開の読みは変わらない: anon は公開済みの LOOK と関連だけを読み、authenticated の会員も同じ', async () => {
    const admin = await insertAdmin();
    const member = await insertMember();
    const ids = [publishedLook, privateLook];

    // authenticated は権限の無い会員（sub があり aal1）の JWT で読む
    for (const [role, claims] of [['anon', null], ['authenticated', member]] as const) {
      const looks = await rowsAs(role, claims, 'select id::text as id from public.looks where id = any($1::bigint[])', [ids]);
      const links = await rowsAs(role, claims, 'select look_id::text as look_id from public.look_items where look_id = any($1::bigint[])', [ids]);
      expect(looks).toEqual([{ id: publishedLook }]);
      expect(links).toEqual([{ look_id: publishedLook }]);
    }
    // 管理者の読み方針（admin.looks.read）は SELECT を残したので働き続ける
    const adminLooks = await rowsAs('authenticated', admin, 'select id::text as id from public.looks where id = any($1::bigint[]) order by id', [ids]);
    expect(adminLooks.map((row) => row.id).sort()).toEqual([publishedLook, privateLook].sort());
  });

  test('DATA-LOOK-003 書き込みの RLS 方針（admin looks / look_items manage by permission）は二重の守りとして残っている', async () => {
    const result = await db().query(
      `select tablename, cmd from pg_policies
       where schemaname = 'public' and tablename in ('looks', 'look_items') and policyname like 'admin % manage by permission %'
       order by tablename, cmd`,
    );
    expect(result.rows).toEqual([
      { tablename: 'look_items', cmd: 'DELETE' },
      { tablename: 'look_items', cmd: 'INSERT' },
      { tablename: 'look_items', cmd: 'UPDATE' },
      { tablename: 'looks', cmd: 'DELETE' },
      { tablename: 'looks', cmd: 'INSERT' },
      { tablename: 'looks', cmd: 'UPDATE' },
    ]);
  });
});
