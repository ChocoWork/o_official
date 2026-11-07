/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { adminTableTools } from './helpers/admin-table-grants';
import {
  ACCOUNTING_S1_FILES, ACCOUNTING_S1_SQL as sql, FINANCE_SEQUENCES, FINANCE_TABLES, accountingS1Section, japanToday,
  ownedFinanceSequences, seedAccountingPeriod,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S1 (FREQ-553 AC-02/03/04): the twelve admin_finance_* tables and their eight owned sequences give
// anon and authenticated nothing, service_role keeps reading and writing. DB suites are controller only (local DB).
const assertion = accountingS1Section('FINAL_ASSERT');
const body = accountingS1Section('BODY');
/** The body without its comment lines (comments may name catalogs; the code must not). */
const bodyCode = body.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const details = ['acc_s1_finance_table_acl', 'acc_s1_finance_seq_acl', 'acc_s1_bucket', 'acc_s1_receipt_columns', 'acc_s1_policies_unchanged'];
type AssertFailure = { code?: string; message?: string; detail?: string };

/** The names a `REVOKE|GRANT ... ON <kind>` statement of the body lists, in written order. */
function statementTargets(pattern: RegExp): string[][] {
  return [...bodyCode.matchAll(pattern)].map((m) => [...m[1].matchAll(/public\.(\w+)/g)].map((n) => n[1]));
}

describe('S1 source contract (no DB)', () => {
  test('FREQ-553-AC-02: S1はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S1_FILES).toEqual(['20261107130100_accounting_p1_grants_receipts.sql']);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S1_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertion).not.toBe('');
    expect([...new Set([...assertion.matchAll(/'(acc_s1_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect(assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-553-AC-02: S1は12表と8連番を名前で並べ、PUBLIC・anon・authenticatedから外しservice_roleへ明示で付け直す', () => {
    const tables = [...FINANCE_TABLES];
    const sequences = [...FINANCE_SEQUENCES];
    expect(statementTargets(/REVOKE ALL ON TABLE([^;]*)FROM PUBLIC, anon, authenticated;/g)).toEqual([tables]);
    expect(statementTargets(/GRANT ALL ON TABLE([^;]*)TO service_role;/g)).toEqual([tables]);
    expect(statementTargets(/REVOKE ALL ON SEQUENCE([^;]*)FROM PUBLIC, anon, authenticated;/g)).toEqual([sequences]);
    expect(statementTargets(/GRANT USAGE, SELECT ON SEQUENCE([^;]*)TO service_role;/g)).toEqual([sequences]);
    // The body never picks tables up from the catalog, never touches policies and writes only the bucket row.
    expect(bodyCode).not.toMatch(/pg_class|pg_depend|EXECUTE|DO \$/i);
    expect(bodyCode).not.toMatch(/\b(?:CREATE|ALTER|DROP) POLICY\b/i);
    expect([...bodyCode.matchAll(/(?<!DO )\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+([\w.]+)/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO storage.buckets']);
    expect(bodyCode).toContain('ON CONFLICT (id) DO UPDATE SET');
    expect(bodyCode.match(/^(?:REVOKE|GRANT|ALTER TABLE|INSERT INTO) /gm)).toEqual(['REVOKE ', 'GRANT ', 'REVOKE ', 'GRANT ', 'ALTER TABLE ', 'INSERT INTO ']);
  });
});

describeLocalDb('S1 finance grants: controller only', (db) => {
  const tools = adminTableTools(db);
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** Run as service_role inside a savepoint, then undo the role and every row written. */
  async function asService<T>(run: () => Promise<T>): Promise<T> {
    await db().query('savepoint acc_s1_service');
    try {
      await db().query('set local role service_role');
      await db().query("select set_config('request.jwt.claims', '', true)");
      const value = await run();
      await db().query('set constraints all immediate');
      return value;
    } finally {
      await db().query('rollback to savepoint acc_s1_service');
      await db().query('release savepoint acc_s1_service');
    }
  }
  const one = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows[0];
  /** A column every UPDATE probe can name; the privilege check fails before any row is touched. */
  const KEY_COLUMN: Record<string, string> = {
    admin_finance_evidence_unavailable_records: 'entry_id', admin_finance_seasons: 'season_key',
    admin_finance_year_closings: 'fiscal_year', admin_finance_years: 'fiscal_year',
  };
  const keyOf = (table: string) => KEY_COLUMN[table] ?? 'id';
  /**
   * Since S4 a manual transaction also writes its period and journal entry, so the expense day lies in the sole period
   * right after the last one (inside this ROLLBACK), which never collides with periods committed by earlier suites.
   */
  async function expenseDay(): Promise<{ periodId: string; day: string }> {
    const periodId = await seedAccountingPeriod(db(), { businessType: 'soleProprietor' });
    const day = (await one("select to_char(starts_on, 'YYYY-MM-DD') as day from public.accounting_periods where id = $1", [periodId])).day;
    return { periodId, day };
  }

  test('FREQ-553-AC-02: 12表と連番でanonもauthenticatedも表の権限を何も持たない', async () => {
    for (const table of FINANCE_TABLES) {
      for (const role of ['anon', 'authenticated']) {
        expect({ table, role, granted: await tools.privileges(role, table) }).toEqual({ table, role, granted: [] });
        const columns = (await db().query(
          `select has_any_column_privilege($1::name, $2::regclass, 'SELECT') as s, has_any_column_privilege($1::name, $2::regclass, 'INSERT') as i,
                  has_any_column_privilege($1::name, $2::regclass, 'UPDATE') as u, has_any_column_privilege($1::name, $2::regclass, 'REFERENCES') as r`,
          [role, `public.${table}`])).rows[0];
        expect({ table, role, columns }).toEqual({ table, role, columns: { s: false, i: false, u: false, r: false } });
      }
    }
    // The sequences are the ones the twelve tables own (pg_depend), not a hand-kept list only.
    const sequences = await ownedFinanceSequences(db());
    expect(sequences).toEqual([...FINANCE_SEQUENCES].sort());
    for (const sequence of sequences) {
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
          const held = (await one('select has_sequence_privilege($1::name, $2::regclass, $3::text) as held', [role, `public.${sequence}`, privilege])).held;
          expect({ sequence, role, privilege, held }).toEqual({ sequence, role, privilege, held: false });
        }
      }
      for (const privilege of ['USAGE', 'SELECT']) {
        expect((await one('select has_sequence_privilege($1::name, $2::regclass, $3::text) as held', ['service_role', `public.${sequence}`, privilege])).held).toBe(true);
      }
    }
  });

  test('FREQ-553-AC-02: anonとauthenticatedのSELECT/INSERT/UPDATE/DELETE/TRUNCATEは42501で断られる', async () => {
    const member = await tools.insertMember();
    for (const table of FINANCE_TABLES) {
      const key = keyOf(table);
      for (const [role, claims] of [['anon', null], ['authenticated', member]] as const) {
        for (const statement of [
          `select count(*) from public.${table}`,
          `insert into public.${table} default values`,
          `update public.${table} set ${key} = ${key} where false`,
          `delete from public.${table} where false`,
          `truncate table public.${table}`,
        ]) {
          const failure = await tools.failureAs(role, claims, statement);
          expect({ role, statement, denied: tools.isPermissionDenied(failure, table) }).toEqual({ role, statement, denied: true });
        }
      }
    }
    for (const sequence of FINANCE_SEQUENCES) {
      const failure = await tools.failureAs('authenticated', member, `select nextval('public.${sequence}')`);
      expect({ sequence, code: failure?.code }).toEqual({ sequence, code: '42501' });
    }
  });

  test('FREQ-553-AC-03: service_roleは12表を従来どおり読み書きできる', async () => {
    const { periodId, day } = await expenseDay();
    const touched = await asService(async () => {
      const seen: string[] = [];
      const write = async (table: string, insert: string, update: string, params: unknown[] = []) => {
        const inserted = await db().query(insert, params);
        expect({ table, inserted: inserted.rowCount }).toEqual({ table, inserted: 1 });
        const updated = await db().query(update, [inserted.rows[0].key]);
        expect({ table, updated: updated.rowCount }).toEqual({ table, updated: 1 });
        expect(Number((await one(`select count(*) as n from public.${table}`)).n)).toBeGreaterThan(0);
        seen.push(table);
        return inserted.rows[0].key;
      };
      const suffix = randomUUID().slice(0, 8);
      await write('admin_finance_years', 'insert into public.admin_finance_years(fiscal_year) values (2998) returning fiscal_year as key',
        'update public.admin_finance_years set sales_revenue = 1 where fiscal_year = $1');
      await write('admin_finance_year_closings', 'insert into public.admin_finance_year_closings(fiscal_year) values (2998) returning fiscal_year as key',
        'update public.admin_finance_year_closings set allowance_for_doubtful = 1 where fiscal_year = $1');
      await write('admin_finance_seasons', "insert into public.admin_finance_seasons(season_key) values ('2998SS') returning season_key as key",
        'update public.admin_finance_seasons set updated_at = now() where season_key = $1');
      await write('admin_finance_partners', 'insert into public.admin_finance_partners(name) values ($1) returning id as key',
        "update public.admin_finance_partners set name = name || ' 2' where id = $1", [`acc s1 partner ${suffix}`]);
      await write('admin_finance_expense_templates',
        "insert into public.admin_finance_expense_templates(name, category, item_name, payment_method) values ($1, 'cat', 'item', 'bank') returning id as key",
        "update public.admin_finance_expense_templates set memo = 'm' where id = $1", [`acc s1 template ${suffix}`]);
      await write('admin_finance_summary_options',
        "insert into public.admin_finance_summary_options(entry_type, name, normalized_name) values ('expense', $1, $1) returning id as key",
        "update public.admin_finance_summary_options set name = name || 'b', normalized_name = normalized_name || 'b' where id = $1", [`acc s1 option ${suffix}`]);
      const revisionsBefore = Number((await one('select count(*) as n from public.admin_finance_entry_revisions')).n);
      const entryId = await write('admin_finance_expenses',
        "insert into public.admin_finance_expenses(expense_date, category, item_name, amount, payment_method) values ($1::date, 'cat', 'item', 100, 'bank') returning id as key",
        "update public.admin_finance_expenses set memo = 'm' where id = $1", [day]);
      // The history is written by the trigger, not by the caller: the insert and the update each add one row.
      expect(Number((await one('select count(*) as n from public.admin_finance_entry_revisions')).n)).toBe(revisionsBefore + 2);
      // Since S4 the insert also made one journal entry in that period (the memo update makes none).
      expect((await db().query('select period_id, dedupe_key from public.accounting_journal_entries where source_id = $1::text', [entryId])).rows)
        .toEqual([{ period_id: periodId, dedupe_key: `manual_entry:${entryId}:0` }]);
      // The history table is append only since S4: service_role reads it and may insert, nothing else.
      const inserted = await db().query(
        "insert into public.admin_finance_entry_revisions(entry_id, operation, before_data, after_data) values ($1, 'update', '{}', '{}') returning id",
        [entryId]);
      expect(inserted.rowCount).toBe(1);
      expect(Number((await one('select count(*) as n from public.admin_finance_entry_revisions where entry_id = $1', [entryId])).n)).toBe(3);
      seen.push('admin_finance_entry_revisions');
      await write('admin_finance_receipts',
        "insert into public.admin_finance_receipts(entry_id, storage_path, file_name, mime_type, file_size) values ($1, $2, 'a.pdf', 'application/pdf', 1) returning id as key",
        "update public.admin_finance_receipts set file_name = 'b.pdf' where id = $1", [entryId, `acc-s1/${suffix}.pdf`]);
      await write('admin_finance_evidence_unavailable_records',
        "insert into public.admin_finance_evidence_unavailable_records(entry_id, reason) values ($1, 'not_issued') returning entry_id as key",
        "update public.admin_finance_evidence_unavailable_records set note = 'n' where entry_id = $1", [entryId]);
      await write('admin_finance_entry_review_acks',
        "insert into public.admin_finance_entry_review_acks(entry_ref, reason) values ('entry:' || $1::text, 'duplicate') returning id as key",
        "update public.admin_finance_entry_review_acks set note = 'n' where id = $1", [entryId]);
      await write('admin_finance_fixed_assets',
        "insert into public.admin_finance_fixed_assets(name, account, acquired_on, acquisition_cost, useful_life, entry_id) values ('asset', 'tools', $1::date, 100, 4, $2) returning id as key",
        "update public.admin_finance_fixed_assets set memo = 'm' where id = $1", [japanToday(), entryId]);
      return seen;
    });
    expect([...touched].sort()).toEqual([...FINANCE_TABLES].sort());
  });

  test('FREQ-553-AC-03: 手入力の経費のトリガーは権限を締めた後も履歴を書く', async () => {
    const definer = await one(`select p.prosecdef, pg_get_userbyid(p.proowner) as owner from pg_proc p
      where p.oid = 'public.record_admin_finance_entry_revision()'::regprocedure`);
    expect(definer).toEqual({ prosecdef: true, owner: 'postgres' });
    const actor = randomUUID();
    await db().query("insert into auth.users(id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [actor]);
    const { day } = await expenseDay();
    const history = await asService(async () => {
      const entry = await one(
        "insert into public.admin_finance_expenses(expense_date, category, item_name, amount, payment_method, created_by, updated_by) values ($1::date, 'cat', 'item', 100, 'bank', $2, $2) returning id",
        [day, actor]);
      await db().query("update public.admin_finance_expenses set memo = 'fixed', updated_by = $2 where id = $1", [entry.id, actor]);
      await db().query('update public.admin_finance_expenses set deleted_at = now(), deleted_by = $2 where id = $1', [entry.id, actor]);
      return (await db().query('select operation, changed_by from public.admin_finance_entry_revisions where entry_id = $1 order by id', [entry.id])).rows;
    });
    expect(history).toEqual([
      { operation: 'insert', changed_by: actor }, { operation: 'update', changed_by: actor }, { operation: 'delete', changed_by: actor },
    ]);
  });

  test('FREQ-553-AC-04: admin.finance.readを持つ利用者のJWTでも会計の表をSELECTすると42501で断られる', async () => {
    const admin = await tools.insertAdmin();
    // The same JWT passes the permission check, so the refusal comes from the table privilege, not from RLS.
    expect(await tools.rowsAs('authenticated', admin, "select public.has_permission('admin.finance.read') as ok")).toEqual([{ ok: true }]);
    for (const table of FINANCE_TABLES) {
      const failure = await tools.failureAs('authenticated', admin, `select * from public.${table} limit 1`);
      expect({ table, denied: tools.isPermissionDenied(failure, table) }).toEqual({ table, denied: true });
    }
    const embedded = await tools.failureAs('authenticated', admin,
      'select e.id, r.id from public.admin_finance_expenses e left join public.admin_finance_receipts r on r.entry_id = e.id limit 1');
    expect(embedded?.code).toBe('42501');
  });

  async function attempt(change = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s1_assert');
    let failure: AssertFailure | null = null;
    try {
      if (change) await db().query(change);
      await db().query(assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s1_assert'); await db().query('release savepoint acc_s1_assert'); }
    return failure;
  }

  test('FREQ-553-AC-02: S1末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, storage, pg_catalog')).toBeNull();
  });

  test.each([
    ['grant select on public.admin_finance_receipts to authenticated', 'acc_s1_finance_table_acl'],
    ['grant insert (memo) on public.admin_finance_expenses to anon', 'acc_s1_finance_table_acl'],
    ['grant select on public.admin_finance_years to public', 'acc_s1_finance_table_acl'],
    ['revoke delete on public.admin_finance_partners from service_role', 'acc_s1_finance_table_acl'],
    ['alter table public.admin_finance_seasons disable row level security', 'acc_s1_finance_table_acl'],
    ['create table public.admin_finance_s1_probe(id integer)', 'acc_s1_finance_table_acl'],
    ['grant update on sequence public.admin_finance_expenses_id_seq to authenticated', 'acc_s1_finance_seq_acl'],
    ['grant usage on sequence public.admin_finance_receipts_id_seq to public', 'acc_s1_finance_seq_acl'],
    ['revoke usage on sequence public.admin_finance_partners_id_seq from service_role', 'acc_s1_finance_seq_acl'],
    ['create sequence public.admin_finance_s1_probe_seq owned by public.admin_finance_years.fiscal_year', 'acc_s1_finance_seq_acl'],
    ["update storage.buckets set public = true where id = 'finance-receipts'", 'acc_s1_bucket'],
    ["update storage.buckets set file_size_limit = 5242880 where id = 'finance-receipts'", 'acc_s1_bucket'],
    [`update storage.buckets set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']
      where id = 'finance-receipts'`, 'acc_s1_bucket'],
    ['alter table public.admin_finance_receipts drop constraint admin_finance_receipts_paper_original_kept_check', 'acc_s1_receipt_columns'],
    ["alter table public.admin_finance_receipts alter column evidence_kind set default 'paper'", 'acc_s1_receipt_columns'],
    ['alter table public.admin_finance_receipts alter column evidence_kind drop not null', 'acc_s1_receipt_columns'],
    ["alter table public.admin_finance_receipts add constraint acc_s1_probe check (evidence_kind <> 'electronic')", 'acc_s1_receipt_columns'],
    ['drop policy "admin finance years read" on public.admin_finance_years', 'acc_s1_policies_unchanged'],
    ['create policy acc_s1_probe on public.admin_finance_entry_revisions for select to authenticated using (false)', 'acc_s1_policies_unchanged'],
  ])('FREQ-553-AC-02: S1改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
