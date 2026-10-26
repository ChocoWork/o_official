/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from '../helpers/local-db';
import { adminTableTools, WRITE_PRIVILEGES } from '../helpers/admin-table-grants';

/**
 * 管理だけが書く表から anon・authenticated の書き込みを外した移行 sec_grants_admin_tables のうち、
 * 色見本の表 item_color_presets の権限（DATA-ADMIN-005、SEC-ADMIN-002-AC-01、ADR-0414）。
 * anon には SELECT も付けない（読む方針が authenticated 向けの 1 本だけで、anon が読める行は元から 0 件）。
 * 手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻すので、足した行を残さない。
 */
describeLocalDb('integration: 色見本の表 item_color_presets の権限（書き込みは service role だけ）', (db) => {
  const { failureAs, rowsAs, privileges, columnWritePrivileges, insertAdmin, insertMember, isPermissionDenied } = adminTableTools(db);
  let marker: string;
  let presetId: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-color-grants-${randomUUID()}`;
    const result = await db().query(
      `insert into public.item_color_presets (name, hex) values ($1, '#123456') returning id::text as id`,
      [marker],
    );
    presetId = result.rows[0].id;
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  const insertSql = 'insert into public.item_color_presets (name, hex) values ($1, $2)';
  const updateSql = 'update public.item_color_presets set hex = $2 where id = $1::bigint';
  const deleteSql = 'delete from public.item_color_presets where id = $1::bigint';

  test('DATA-ADMIN-005 anon は item_color_presets の権限を 1 つも持たず、列単位でも持たない', async () => {
    expect(await privileges('anon', 'item_color_presets')).toEqual([]);
    expect(await columnWritePrivileges('anon', 'item_color_presets')).toEqual({
      column_insert: false,
      column_update: false,
      column_references: false,
    });
    const columnSelect = await db().query(`select has_any_column_privilege('anon', 'public.item_color_presets', 'SELECT') as allowed`);
    expect(columnSelect.rows[0].allowed).toBe(false);
  });

  test('DATA-ADMIN-005 authenticated は item_color_presets の SELECT だけを持ち、書き込み系の 7 権限を表単位でも列単位でも持たない', async () => {
    expect(await privileges('authenticated', 'item_color_presets')).toEqual(['SELECT']);
    expect(await privileges('authenticated', 'item_color_presets', WRITE_PRIVILEGES)).toEqual([]);
    expect(await columnWritePrivileges('authenticated', 'item_color_presets')).toEqual({
      column_insert: false,
      column_update: false,
      column_references: false,
    });
  });

  test('DATA-ADMIN-005 service_role の item_color_presets は 4 つの行の操作を持つ', async () => {
    expect(await privileges('service_role', 'item_color_presets', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  test('DATA-ADMIN-005 連番 item_color_presets_id_seq は anon・authenticated が USAGE・SELECT・UPDATE を持たず、直に進める（nextval）と権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();
    const result = await db().query(
      `select r.role,
              has_sequence_privilege(r.role, 'public.item_color_presets_id_seq', 'USAGE') as usage,
              has_sequence_privilege(r.role, 'public.item_color_presets_id_seq', 'SELECT') as "select",
              has_sequence_privilege(r.role, 'public.item_color_presets_id_seq', 'UPDATE') as "update"
       from unnest(array['anon', 'authenticated']) as r(role) order by r.role`,
    );
    expect(result.rows).toEqual([
      { role: 'anon', usage: false, select: false, update: false },
      { role: 'authenticated', usage: false, select: false, update: false },
    ]);
    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      const failure = await failureAs(role, claims, "select nextval('public.item_color_presets_id_seq')");
      expect(failure?.code).toBe('42501');
      expect(failure?.message).toBe('permission denied for sequence item_color_presets_id_seq');
    }
    // identity の既定値は連番の権限を見ないので、service_role の追加は連番を外した後も通る
    expect(await failureAs('service_role', null, insertSql, [`${marker} seq`, '#0a0b0c'])).toBeNull();
  });

  test('DATA-ADMIN-005 anon の読み・追加・更新・削除・全消しは、権限の誤り（42501）で断られる（0 件の成功ではない）', async () => {
    const relation = 'item_color_presets';

    expect(isPermissionDenied(await failureAs('anon', null, 'select id from public.item_color_presets'), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('anon', null, insertSql, [`${marker} new`, '#abcdef']), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('anon', null, updateSql, [presetId, '#654321']), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('anon', null, deleteSql, [presetId]), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('anon', null, 'truncate public.item_color_presets'), relation)).toBe(true);
  });

  test('DATA-ADMIN-005 aal2 の管理者の JWT の authenticated は読めるが、追加・更新・削除・全消しは権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();
    const relation = 'item_color_presets';

    const rows = await rowsAs('authenticated', admin, 'select name from public.item_color_presets where id = $1::bigint', [presetId]);
    expect(rows).toEqual([{ name: marker }]);
    expect(isPermissionDenied(await failureAs('authenticated', admin, insertSql, [`${marker} new`, '#abcdef']), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('authenticated', admin, updateSql, [presetId, '#654321']), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('authenticated', admin, deleteSql, [presetId]), relation)).toBe(true);
    expect(isPermissionDenied(await failureAs('authenticated', admin, 'truncate public.item_color_presets'), relation)).toBe(true);

    const left = await db().query('select hex from public.item_color_presets where id = $1::bigint', [presetId]);
    expect(left.rows).toEqual([{ hex: '#123456' }]);
  });

  test('DATA-ADMIN-005 商品の権限が無い会員の読みは 0 件のままで（読む方針 admin.items.read が絞る）、service_role は追加・更新・削除できる', async () => {
    const member = await insertMember();
    expect(await rowsAs('authenticated', member, 'select id from public.item_color_presets where id = $1::bigint', [presetId])).toEqual([]);

    expect(await failureAs('service_role', null, insertSql, [`${marker} svc`, '#abcdef'])).toBeNull();
    expect(await failureAs('service_role', null, updateSql, [presetId, '#654321'])).toBeNull();
    expect(await failureAs('service_role', null, deleteSql, [presetId])).toBeNull();
  });

  test('DATA-ADMIN-005 書き込みの RLS 方針（admin item_color_presets manage by permission）は二重の守りとして残っている', async () => {
    const result = await db().query(
      `select cmd from pg_policies
       where schemaname = 'public' and tablename = 'item_color_presets' and policyname like 'admin % manage by permission %'
       order by cmd`,
    );
    expect(result.rows).toEqual([{ cmd: 'DELETE' }, { cmd: 'INSERT' }, { cmd: 'UPDATE' }]);
  });
});
