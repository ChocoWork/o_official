/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { VALID_STORAGE_KEYS } from '@/lib/kpi/monthly-metrics';

// Accounting plan 2 S13 (FREQ-573-AC-01, AC-02): the monthly KPI table admin_kpi_monthly_records and its writers / reader.
// Every test runs inside a transaction that is rolled back (the table and the writers are checked as the roles that use them).
const TABLE = 'public.admin_kpi_monthly_records';
type Failure = { code?: string; message: string };

describeLocalDb('S13 monthly KPI records (rollback)', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** Run one statement inside a savepoint as `role`; return the error (code and message) or null. The role and the writes are undone. */
  async function attempt(sql: string, params: unknown[] = [], role = 'postgres'): Promise<Failure | null> {
    await db().query('savepoint acc_s13_try');
    try {
      await db().query(`set local role ${role}`);
      await db().query(sql, params);
      return null;
    } catch (caught) {
      const e = caught as { code?: string; message: string };
      return { code: e.code, message: e.message };
    } finally {
      await db().query('rollback to savepoint acc_s13_try');
      await db().query('release savepoint acc_s13_try');
    }
  }
  /** Run as service_role and return the rows; the role goes back to postgres afterwards (the writes stay for the rest of the test). */
  async function asService<T = Record<string, unknown>>(client: PgClient, sql: string, params: unknown[] = []): Promise<T[]> {
    await client.query('set local role service_role');
    try { return (await client.query(sql, params)).rows as T[]; } finally { await client.query('reset role'); }
  }
  const stored = async (month: string, metric: string): Promise<number | null> => {
    const rows = (await db().query(`select value from ${TABLE} where month_key = $1 and metric_key = $2`, [month, metric])).rows;
    return rows.length === 0 ? null : Number(rows[0].value);
  };
  const set = (actor: string, updates: unknown[]) =>
    asService<{ n: number }>(db(), 'select public.admin_set_kpi_monthly_records($1::uuid, $2::jsonb) as n', [actor, JSON.stringify(updates)]);

  test('FREQ-573-AC-01: 表は移行にあり、anonとauthenticatedに権限が無くservice_roleはSELECTだけ', async () => {
    const table = (await db().query(
      `select c.relkind, c.relowner::regrole::text as owner, c.relrowsecurity as rls,
         (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
       from pg_class c where c.oid = to_regclass($1)`, [TABLE])).rows[0];
    expect(table).toEqual({ relkind: 'r', owner: 'postgres', rls: true, policies: 0 });
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect([role, privilege, (await db().query('select has_table_privilege($1, $2, $3) as ok', [role, TABLE, privilege])).rows[0].ok])
          .toEqual([role, privilege, false]);
      }
    }
    expect((await db().query("select has_table_privilege('public', $1, 'SELECT') as ok", [TABLE])).rows[0].ok).toBe(false);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect([privilege, (await db().query('select has_table_privilege($1, $2, $3) as ok', ['service_role', TABLE, privilege])).rows[0].ok])
        .toEqual([privilege, false]);
    }
    expect((await db().query("select has_table_privilege('service_role', $1, 'SELECT') as ok", [TABLE])).rows[0].ok).toBe(true);
    // The writers are the only way in: a direct insert as service_role is refused.
    expect((await attempt(`insert into ${TABLE}(month_key, metric_key, value) values ('2026-07', 'kpi:sales', 1)`, [], 'service_role'))?.code).toBe('42501');
    expect((await attempt(`insert into ${TABLE}(month_key, metric_key, value) values ('2026-07', 'kpi:sales', 1)`, [], 'authenticated'))?.code).toBe('42501');
  });

  test('FREQ-573-AC-01: 月と指標の鍵の形が違う行を断る', async () => {
    const insert = `insert into ${TABLE}(month_key, metric_key, value) values ($1, $2, 1)`;
    expect(await attempt(insert, ['2026-07', 'src:reach'])).toBeNull();
    expect(await attempt(insert, ['2026-07', `kpi:${'a'.repeat(64)}`])).toBeNull();
    for (const month of ['2026-13', '2026-00', '2026-7', '26-07', ' 2026-07', '2026-07 ', '2026-07\n', '']) {
      expect([month, (await attempt(insert, [month, 'src:reach']))?.code]).toEqual([month, '23514']);
    }
    for (const metric of ['sales', 'foo:reach', 'src:', 'src:a-b', 'src:a b', 'kpi:', `kpi:${'a'.repeat(65)}`, 'SRC:reach', 'src:reach\n', '']) {
      expect([metric, (await attempt(insert, ['2026-07', metric]))?.code]).toEqual([metric, '23514']);
    }
    expect((await attempt(`insert into ${TABLE}(month_key, metric_key, value) values ('2026-07', 'src:reach', null)`))?.code).toBe('23502');
  });

  test('FREQ-573-AC-01: 保存の鍵として画面が許す全部の指標の鍵を表が受ける', async () => {
    const keys = [...VALID_STORAGE_KEYS];
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect([key, await attempt(`insert into ${TABLE}(month_key, metric_key, value) values ('2026-07', $1, 1)`, [key])]).toEqual([key, null]);
    }
  });

  test('FREQ-573-AC-02: 保存と、値NULLでの削除が通り、同じ月・指標は1行のまま更新される', async () => {
    const admin = await insertAccountingAdmin(db());
    expect((await set(admin, [
      { month_key: '2026-07', metric_key: 'kpi:sales', value: 123.4 },
      { month_key: '2026-07', metric_key: 'src:reach', value: 10 },
      { month_key: '2026-08', metric_key: 'src:reach', value: 0 },
    ]))[0].n).toBe(3);
    expect(await stored('2026-07', 'kpi:sales')).toBe(123.4);
    expect(await stored('2026-08', 'src:reach')).toBe(0);
    // Same month and metric: one row, the new value.
    expect((await set(admin, [{ month_key: '2026-07', metric_key: 'kpi:sales', value: 200 }]))[0].n).toBe(1);
    expect(await stored('2026-07', 'kpi:sales')).toBe(200);
    expect(Number((await db().query(`select count(*) as n from ${TABLE} where month_key = '2026-07' and metric_key = 'kpi:sales'`)).rows[0].n)).toBe(1);
    // Value null (or no value key) deletes; a delete of a row that is not there is not an error.
    expect((await set(admin, [
      { month_key: '2026-07', metric_key: 'src:reach', value: null },
      { month_key: '2026-08', metric_key: 'src:reach' },
      { month_key: '2026-09', metric_key: 'src:reach', value: null },
    ]))[0].n).toBe(3);
    expect(await stored('2026-07', 'src:reach')).toBeNull();
    expect(await stored('2026-08', 'src:reach')).toBeNull();
    expect(await stored('2026-07', 'kpi:sales')).toBe(200);
    // An empty list writes nothing; the same key twice in a list keeps the last one.
    expect((await set(admin, []))[0].n).toBe(0);
    expect((await set(admin, [
      { month_key: '2026-10', metric_key: 'kpi:sales', value: 1 },
      { month_key: '2026-10', metric_key: 'kpi:sales', value: 2 },
    ]))[0].n).toBe(1);
    expect(await stored('2026-10', 'kpi:sales')).toBe(2);
  });

  test('FREQ-573-AC-02: 更新時刻が更新で進む', async () => {
    const admin = await insertAccountingAdmin(db());
    await set(admin, [{ month_key: '2026-07', metric_key: 'kpi:sales', value: 1 }]);
    const first = (await db().query(`select created_at, updated_at from ${TABLE} where month_key = '2026-07'`)).rows[0];
    expect(first.updated_at.getTime()).toBe(first.created_at.getTime());
    await set(admin, [{ month_key: '2026-07', metric_key: 'kpi:sales', value: 2 }]);
    const second = (await db().query(`select created_at, updated_at from ${TABLE} where month_key = '2026-07'`)).rows[0];
    expect(second.created_at.getTime()).toBe(first.created_at.getTime());
    expect(second.updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime());
  });

  test('FREQ-573-AC-02: 書き口は権限なしを42501で断り、201件は断る', async () => {
    const admin = await insertAccountingAdmin(db());
    const nobody = randomUUID();
    const call = (actor: string | null, updates: unknown, role = 'service_role') =>
      attempt('select public.admin_set_kpi_monthly_records($1::uuid, $2::jsonb)', [actor, JSON.stringify(updates)], role);
    const row = { month_key: '2026-07', metric_key: 'kpi:sales', value: 1 };
    expect(await call(admin, [row])).toBeNull();
    // No permission: a user with no role, an unknown id, and no actor at all.
    for (const actor of [nobody, null]) {
      expect([actor, (await call(actor, [row]))?.code, (await call(actor, [row]))?.message]).toEqual([actor, '42501', 'ACCOUNTING_FORBIDDEN']);
    }
    // The permission check comes before the shape check.
    expect((await call(nobody, 'not-a-list'))?.code).toBe('42501');
    // 200 pass, 201 are refused (ACCOUNTING_ARGUMENT_INVALID / 22023) and nothing is written.
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ month_key: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}`, metric_key: 'kpi:sales', value: i }));
    expect(await call(admin, many(200))).toBeNull();
    expect(await call(admin, many(201))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    // Bad shapes are refused as a whole: not a list, not an object, a bad key, a text value, a missing key.
    for (const bad of [
      'x', { month_key: '2026-07' }, null, [1], [{ ...row, month_key: '2026-13' }], [{ ...row, metric_key: 'sales' }],
      [{ ...row, value: '5' }], [{ ...row, value: true }], [{ metric_key: 'kpi:sales', value: 1 }], [{ month_key: '2026-07', value: 1 }],
      [{ ...row, month_key: 202607 }], [row, { ...row, metric_key: 'src:a-b' }],
    ]) {
      expect([JSON.stringify(bad), await call(admin, bad)]).toEqual([JSON.stringify(bad), { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' }]);
    }
    // anon and authenticated cannot call the writers at all.
    for (const role of ['anon', 'authenticated']) {
      expect([role, (await call(admin, [row], role))?.code]).toEqual([role, '42501']);
    }
  });

  test('FREQ-573-AC-02: Metaの同期の書き口は権限の確認なしでupsertできる', async () => {
    const rows = [
      { month_key: '2026-07', metric_key: 'src:ad_spend', value: 1500.5 },
      { month_key: '2026-07', metric_key: 'src:ad_clicks', value: 20 },
    ];
    const run = (list: unknown) => asService<{ n: number }>(db(), 'select public.system_upsert_kpi_monthly_records($1::jsonb) as n', [JSON.stringify(list)]);
    expect((await run(rows))[0].n).toBe(2);
    expect(await stored('2026-07', 'src:ad_spend')).toBe(1500.5);
    expect((await run([{ ...rows[0], value: 2000 }]))[0].n).toBe(1);
    expect(await stored('2026-07', 'src:ad_spend')).toBe(2000);
    expect(Number((await db().query(`select count(*) as n from ${TABLE}`)).rows[0].n)).toBe(2);
    expect((await run([]))[0].n).toBe(0);
    // It only upserts: a null value is not a delete here, and 201 rows, bad keys, and non-lists are refused.
    const refused = (list: unknown) => attempt('select public.system_upsert_kpi_monthly_records($1::jsonb)', [JSON.stringify(list)], 'service_role');
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await refused([{ ...rows[0], value: null }])).toEqual(invalid);
    expect(await refused(Array.from({ length: 201 }, () => rows[0]))).toEqual(invalid);
    expect(await refused([{ ...rows[0], month_key: '2026-1' }])).toEqual(invalid);
    expect(await refused('x')).toEqual(invalid);
    expect(await refused(Array.from({ length: 200 }, () => rows[0]))).toBeNull();
    for (const role of ['anon', 'authenticated']) {
      expect([role, (await attempt('select public.system_upsert_kpi_monthly_records($1::jsonb)', [JSON.stringify(rows)], role))?.code]).toEqual([role, '42501']);
    }
  });

  test('FREQ-573-AC-02: 読み口は指定した月の値だけを返し、表が空でも空を返す', async () => {
    const admin = await insertAccountingAdmin(db());
    const list = (months: unknown) => asService<{ month_key: string; metric_key: string; value: string }>(
      db(), 'select * from public.list_kpi_monthly_records($1::text[])', [months]);
    expect(await list(['2026-07', '2026-08'])).toEqual([]);
    await set(admin, [
      { month_key: '2026-08', metric_key: 'src:reach', value: 5 },
      { month_key: '2026-07', metric_key: 'kpi:sales', value: 123.4 },
      { month_key: '2026-07', metric_key: 'src:reach', value: 10 },
      { month_key: '2026-09', metric_key: 'src:reach', value: 99 },
    ]);
    expect((await list(['2026-07', '2026-08'])).map((r) => [r.month_key, r.metric_key, Number(r.value)])).toEqual([
      ['2026-07', 'kpi:sales', 123.4], ['2026-07', 'src:reach', 10], ['2026-08', 'src:reach', 5]]);
    expect(await list([])).toEqual([]);
    // Up to 24 months; more than that, or no list, is refused.
    const months = (n: number) => Array.from({ length: n }, (_, i) => `20${String(20 + Math.floor(i / 12))}-${String((i % 12) + 1).padStart(2, '0')}`);
    expect(await list(months(24))).toEqual([]);
    const refused = (value: unknown) => attempt('select * from public.list_kpi_monthly_records($1::text[])', [value], 'service_role');
    expect(await refused(months(25))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await refused(null)).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    for (const role of ['anon', 'authenticated']) {
      expect([role, (await attempt('select * from public.list_kpi_monthly_records($1::text[])', [['2026-07']], role))?.code]).toEqual([role, '42501']);
    }
  });
});
