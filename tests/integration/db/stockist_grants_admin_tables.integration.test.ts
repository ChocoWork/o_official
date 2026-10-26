/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { adminTableTools, WRITE_PRIVILEGES } from './helpers/admin-table-grants';

/**
 * 管理だけが書く表から anon・authenticated の書き込みを外した移行 sec_grants_admin_tables のうち、
 * stockists と連番 stockists_id_seq の権限（DATA-STOCKIST-002、SEC-STOCKIST-003-AC-02・AC-03・SEC-STOCKIST-008、ADR-0414）。
 * 手元の使い捨て DB でだけ流し、各試験は取引の中で動かして最後に巻き戻すので、足した行を残さない。
 */
describeLocalDb('integration: stockists の権限（書き込みは service role だけ）', (db) => {
  const { failureAs, rowsAs, privileges, columnWritePrivileges, insertAdmin, insertMember, isPermissionDenied } = adminTableTools(db);
  let marker: string;
  let publishedId: string;
  let privateId: string;

  beforeEach(async () => {
    await db().query('begin');
    marker = `integration-stockist-grants-${randomUUID()}`;
    publishedId = await insertStockist('published');
    privateId = await insertStockist('private');
  });

  afterEach(async () => {
    await db().query('rollback');
  });

  async function insertStockist(status: 'private' | 'published'): Promise<string> {
    const result = await db().query(
      `insert into public.stockists (type, name, address, phone, time, holiday, status)
       values ('STORE', $1, 'a', 'p', 't', 'h', $2) returning id::text as id`,
      [`${marker} ${status}`, status],
    );
    return result.rows[0].id;
  }

  const insertSql = `insert into public.stockists (type, name, address, phone, time, holiday, status)
    values ('STORE', $1, 'a', 'p', 't', 'h', 'private')`;
  const updateSql = `update public.stockists set name = 'tampered' where id = $1`;
  const deleteSql = 'delete from public.stockists where id = $1';

  test.each(['anon', 'authenticated'])('DATA-STOCKIST-002 %s の stockists は SELECT だけを持ち、書き込み系の 7 権限を表単位でも列単位でも持たない', async (role) => {
    expect(await privileges(role, 'stockists')).toEqual(['SELECT']);
    expect(await privileges(role, 'stockists', WRITE_PRIVILEGES)).toEqual([]);
    expect(await columnWritePrivileges(role, 'stockists')).toEqual({
      column_insert: false,
      column_update: false,
      column_references: false,
    });
  });

  test('DATA-STOCKIST-002 service_role の stockists は 4 つの行の操作を持つ', async () => {
    expect(await privileges('service_role', 'stockists', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  test('DATA-STOCKIST-002 追加・更新・削除・全消しは、anon も、aal2 の管理者の JWT の authenticated も、RLS の違反でなく権限の誤り（42501）で断られる', async () => {
    const admin = await insertAdmin();

    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      expect(isPermissionDenied(await failureAs(role, claims, insertSql, [`${marker} new`]), 'stockists')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, updateSql, [publishedId]), 'stockists')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, deleteSql, [publishedId]), 'stockists')).toBe(true);
      expect(isPermissionDenied(await failureAs(role, claims, 'truncate public.stockists'), 'stockists')).toBe(true);
    }
    const left = await db().query('select name from public.stockists where id = $1', [publishedId]);
    expect(left.rows).toEqual([{ name: `${marker} published` }]);
  });

  test('DATA-STOCKIST-002 service_role は stockists を追加（連番を使う）・更新・削除できる', async () => {
    expect(await failureAs('service_role', null, insertSql, [`${marker} svc`])).toBeNull();
    expect(await failureAs('service_role', null, updateSql, [publishedId])).toBeNull();
    expect(await failureAs('service_role', null, deleteSql, [publishedId])).toBeNull();
  });

  test('DATA-STOCKIST-002 連番 stockists_id_seq は anon・authenticated が USAGE・SELECT・UPDATE を持たず、service_role は USAGE・SELECT を持つ', async () => {
    const result = await db().query(
      `select r.role,
              has_sequence_privilege(r.role, 'public.stockists_id_seq', 'USAGE') as usage,
              has_sequence_privilege(r.role, 'public.stockists_id_seq', 'SELECT') as "select",
              has_sequence_privilege(r.role, 'public.stockists_id_seq', 'UPDATE') as "update"
       from unnest(array['anon', 'authenticated', 'service_role']) as r(role) order by r.role`,
    );
    expect(result.rows).toEqual([
      { role: 'anon', usage: false, select: false, update: false },
      { role: 'authenticated', usage: false, select: false, update: false },
      { role: 'service_role', usage: true, select: true, update: false },
    ]);
  });

  test('DATA-STOCKIST-002 anon・authenticated が連番を直に進める（nextval）と権限の誤り（42501）で断られ、service_role は進められる', async () => {
    const admin = await insertAdmin();

    for (const [role, claims] of [['anon', null], ['authenticated', admin]] as const) {
      const failure = await failureAs(role, claims, "select nextval('public.stockists_id_seq')");
      expect(failure?.code).toBe('42501');
      expect(failure?.message).toBe('permission denied for sequence stockists_id_seq');
    }
    expect(await failureAs('service_role', null, "select nextval('public.stockists_id_seq')")).toBeNull();
  });

  test('DATA-STOCKIST-002 公開の読みは変わらない: anon も会員も公開済みだけを読み、管理者の読み方針（admin.stockists.read）は働き続ける', async () => {
    const admin = await insertAdmin();
    const member = await insertMember();
    const sql = 'select id::text as id from public.stockists where id = any($1::bigint[]) order by id';
    const ids = [publishedId, privateId];

    expect(await rowsAs('anon', null, sql, [ids])).toEqual([{ id: publishedId }]);
    expect(await rowsAs('authenticated', member, sql, [ids])).toEqual([{ id: publishedId }]);
    const adminRows = await rowsAs('authenticated', admin, sql, [ids]);
    expect(adminRows.map((row) => row.id).sort()).toEqual([publishedId, privateId].sort());
  });

  test('DATA-STOCKIST-002 書き込みの RLS 方針（admin stockists manage by permission）は二重の守りとして残っている', async () => {
    const result = await db().query(
      `select cmd from pg_policies
       where schemaname = 'public' and tablename = 'stockists' and policyname like 'admin % manage by permission %'
       order by cmd`,
    );
    expect(result.rows).toEqual([{ cmd: 'DELETE' }, { cmd: 'INSERT' }, { cmd: 'UPDATE' }]);
  });

  test('DATA-STOCKIST-002 二重の守りが働く: 表の権限を付け直しても、権限の無い会員の書き込みは RLS が断り、manage を持つ管理者の書き込みは通る', async () => {
    // 取引の中で付け直す。afterEach の rollback で元に戻る
    await db().query('grant insert, update, delete on public.stockists to authenticated');
    // 移行の前の付与（remote_schema.sql の stockists_id_seq）も戻す。戻さないと insert は既定値の nextval で RLS より先に権限の誤りになる
    await db().query('grant usage, select on sequence public.stockists_id_seq to authenticated');
    const admin = await insertAdmin();
    const member = await insertMember();

    const memberInsert = await failureAs('authenticated', member, insertSql, [`${marker} member`]);
    expect(memberInsert?.code).toBe('42501');
    expect(memberInsert?.message).toMatch(/row-level security/);
    expect(await rowsAs('authenticated', member, `update public.stockists set name = 'tampered' where id = $1 returning id`, [publishedId])).toEqual([]);
    expect(await rowsAs('authenticated', member, 'delete from public.stockists where id = $1 returning id', [publishedId])).toEqual([]);

    expect(await failureAs('authenticated', admin, insertSql, [`${marker} admin`])).toBeNull();
    expect(await rowsAs('authenticated', admin, `${updateSql} returning id`, [publishedId])).toEqual([{ id: publishedId }]);
    expect(await rowsAs('authenticated', admin, `${deleteSql} returning id`, [publishedId])).toEqual([{ id: publishedId }]);
  });
});
