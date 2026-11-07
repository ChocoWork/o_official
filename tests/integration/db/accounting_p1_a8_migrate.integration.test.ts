/** @jest-environment node */
/**
 * Accounting plan 1 S5 (FREQ-560 AC-01..AC-03): the A8 migration moves the manual transactions that exist before S4
 * into saved journal entries (migrated_entry) and leaves the transactions, their revisions and receipts as they are.
 *
 * The DB part replays the migration: the DB holds S0..S3 only, the production-like fixture (20 transactions of which
 * 2 logically deleted, 8 receipts, 25 revisions) goes in, then the S4 and S5 files run as they are. A reset with S4
 * applied would post the fixture through the S4 trigger first, so the migration could not be tried (and no trigger is
 * disabled to avoid that). The checks of the stops and of the final assert run S4 and S5 inside a transaction that is
 * rolled back; the main replay COMMITS the fixture, S4 and S5 (entries and periods cannot be deleted). Controller only,
 * on its own jest invocation:
 *   npx.cmd supabase db reset --version 20261107130300
 *   ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/accounting_p1_a8_migrate --runInBand
 *   npm run db:reset
 * Without ACCOUNTING_COMMIT_SUITE=1 the DB part skips; a non-localhost URL fails.
 */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import {
  accountingFailure, accountingS2Section, accountingS3Section, insertAccountingAdmin, pinAccountingS2Baseline,
  pinAccountingS3Baseline,
} from './helpers/accounting-fixtures';
import {
  ACCOUNTING_S3_VERSION, ACCOUNTING_S4_SQL, ACCOUNTING_S5_FILES, ACCOUNTING_S5_SQL as sql, LEGACY_RECEIPT_KEYS,
  accountingS5Section, insertLegacyFixture, pinAccountingS5Baseline, transactionBody, type LegacyFixture, type LegacyRow,
} from './helpers/accounting-legacy-fixtures';

jest.setTimeout(120000);
const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';
const body = accountingS5Section('BODY');
const assertion = accountingS5Section('FINAL_ASSERT');
const details = ['acc_s5_counts', 'acc_s5_revisions_unchanged', 'acc_s5_receipts_unchanged', 'acc_s5_numbering',
  'acc_s5_triggers_unchanged'];
const stops = ['a8_corporation_year', 'a8_legacy_opening_nonzero', 'a8_closings_exist', 'a8_startup_cost_category',
  'acc_s5_counts', 'acc_s5_triggers_unchanged'];
/** Code lines only (comment lines dropped). */
const code = (text: string) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const squash = (text: string) => code(text).replace(/\s+/g, ' ').trim();
const s4Section = (name: string) => ACCOUNTING_S4_SQL.split(`-- ${name}_BEGIN\n`)[1]?.split(`-- ${name}_END`)[0] ?? '';

describe('S5 source contract (no DB)', () => {
  test('FREQ-560-AC-02: S5はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S5_FILES).toEqual(['20261107130500_accounting_p1_a8_migrate_manual.sql']);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S5_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...assertion.matchAll(/'(acc_s5_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect([...new Set([...body.matchAll(/DETAIL = '([a-z0-9_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...stops].sort());
    expect(sql).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(assertion).toContain("PERFORM pg_catalog.set_config('search_path', '', true);");
    expect(assertion).toContain("PERFORM pg_catalog.set_config('search_path', v_search_path, true);");
  });

  test('FREQ-560-AC-02: S5の実行時のDMLは控えのINSERTだけで、admin_finance_*は読むだけ、トリガーを止めず仕訳はcoreだけで入れる', () => {
    const statements = code(sql);
    expect([...statements.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+([\w.]+)/gi)]
      .map((m) => `${m[1]} ${m[2]}`)).toEqual(['INSERT INTO pg_temp.accounting_s5_baseline']);
    expect(statements).not.toMatch(/\b(ALTER|DROP|CREATE)\s+(TABLE|TRIGGER|FUNCTION|POLICY|INDEX)\b/i);
    expect(statements).not.toMatch(/session_replication_role|DISABLE\s+TRIGGER|ENABLE\s+(ALWAYS|REPLICA)/i);
    expect(statements).not.toMatch(/\bGRANT\b|\bREVOKE\b/);
    expect(statements.match(/private\.accounting_post_journal_core\(/g)).toHaveLength(1);
    expect(squash(body)).toContain("v_result := private.accounting_post_journal_core(v_row.created_by, v_period_id, v_row.expense_date, 'migrated_entry', ARRAY[v_row.id::text], v_row.item_name, v_lines, NULL, NULL, 'admin_finance_expenses', v_row.id::text, v_row.created_at, 'admin_finance_expenses', NULL);");
    expect(squash(body)).toContain('FOR v_row IN SELECT * FROM public.admin_finance_expenses AS x WHERE x.deleted_at IS NULL ORDER BY x.expense_date, x.id');
    expect(squash(body)).toContain('v_period_id := private.accounting_period_for_event(v_row.expense_date, v_row.created_by);');
    expect(squash(body)).toContain('PERFORM private.accounting_ensure_individual_periods(v_first, NULL); PERFORM private.accounting_ensure_individual_periods(v_last, NULL);');
  });

  test('FREQ-560-AC-02: S5は何かを読む前に (190521,1)→(190525,0) の鍵を取り、190524を使わない', () => {
    expect(sql).not.toContain('190524');
    const migrate = code(body).split('DO $acc_s5_migrate$')[1] ?? '';
    const order = ['pg_advisory_xact_lock(190521, 1)', 'pg_advisory_xact_lock(190525, 0)'].map((text) => migrate.indexOf(text));
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(migrate.search(/FROM (public|pg_catalog)\./));
  });

  test('FREQ-560-AC-01: 借貸はS4のトリガーと同じ文で決まる（開業費1810へは移さない）', () => {
    const s4Function = ACCOUNTING_S4_SQL.split('CREATE FUNCTION private.accounting_manual_entry_after_write()')[1] ?? '';
    const start = s4Function.indexOf('v_counter := ');
    const endText = 'ELSE pg_catalog.jsonb_build_array(v_funds_line, v_counter_line) END;';
    const s4Lines = s4Function.slice(start, s4Function.indexOf(endText) + endText.length).replace(/\bNEW\./g, 'v_row.');
    expect(start).toBeGreaterThan(0);
    expect(squash(accountingS5Section('LINES'))).toBe(squash(s4Lines));
    // 1810 appears only in the stop right after the lines, never as an account the body writes.
    const stop = "IF '1810' IN (v_counter, v_funds) THEN RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'a8_startup_cost_category'; END IF;";
    const flat = squash(body);
    expect(flat.indexOf(stop)).toBeGreaterThan(flat.indexOf('v_lines := CASE'));
    expect(flat.indexOf(stop)).toBeLessThan(flat.indexOf('private.accounting_post_journal_core('));
    expect(code(sql).match(/1810/g)).toHaveLength(1);
  });
});

type Failure = { code?: string; message?: string; detail?: string } | null;
type MigratedEntry = {
  id: string; period_id: string; entry_no: number; entry_date: string; dedupe_key: string; source_table: string;
  source_id: string; recorded_at: Date; recorded_by: string | null; description: string; migrated_from: string | null;
  migrated_at: Date | null; is_late: boolean; period_start: string; lines: { account_code: string; debit: string; credit: string; counterparty: string | null; memo: string | null }[];
};

describeLocalDb('S5 A8 replay: controller only, commits rows', (db) => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }
  const s4Inner = transactionBody(ACCOUNTING_S4_SQL);
  const s5Inner = transactionBody(sql);
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const one = async (text: string, params: unknown[] = []) => (await db().query(text, params)).rows[0];
  const count = async (text: string, params: unknown[] = []) => Number((await one(text, params)).n);
  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await db().query("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [id]);
    return id;
  }
  const atS3 = async () => one(`select (select max(version) from supabase_migrations.schema_migrations) as version,
      to_regclass('public.accounting_manual_category_map') is null as no_s4,
      (select count(*)::int from public.admin_finance_expenses) as expenses,
      (select count(*)::int from public.accounting_periods) as periods,
      (select count(*)::int from public.accounting_journal_entries) as entries`);
  let ready = false;
  beforeAll(async () => {
    // The replay needs the DB at S3 with no transaction yet: npx.cmd supabase db reset --version 20261107130300.
    expect(await atS3()).toEqual({ version: ACCOUNTING_S3_VERSION, no_s4: true, expenses: 0, periods: 0, entries: 0 });
    ready = true;
  });
  const migrated = async (): Promise<MigratedEntry[]> => (await db().query(`select e.id, e.period_id, e.entry_no::int as entry_no,
      to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.dedupe_key, e.source_table, e.source_id, e.recorded_at, e.recorded_by,
      e.description, e.migrated_from, e.migrated_at, e.is_late, to_char(p.starts_on, 'YYYY-MM-DD') as period_start,
      (select jsonb_agg(jsonb_build_object('account_code', l.account_code, 'debit', l.debit::text, 'credit', l.credit::text,
        'counterparty', l.counterparty, 'memo', l.memo) order by l.line_no) from public.accounting_journal_lines l where l.entry_id = e.id) as lines
    from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id
    where e.event_kind = 'migrated_entry' order by e.entry_date, e.source_id::bigint`)).rows;

  describe('stops and the final assert (S4 and S5 run inside a rolled-back transaction)', () => {
    let fixture: LegacyFixture;
    beforeEach(async () => {
      if (!ready) throw new Error('ACC_S5_REPLAY_NEEDS_DB_AT_S3');
      await db().query('begin');
      fixture = await insertLegacyFixture(db(), { admin: await insertAccountingAdmin(db()), staff: await insertUser() });
    });
    afterEach(async () => { await db().query('rollback'); });
    const migrate = (before = '') => accountingFailure(db(), async () => {
      if (before) await db().query(before);
      await db().query(s4Inner);
      await db().query(s5Inner);
    });

    test('FREQ-560-AC-01: 期首の欄が0でない年があるときは移さず止まる', async () => {
      for (const column of ['opening_cash', 'accounts_receivable', 'fixed_assets', 'accounts_payable', 'opening_capital']) {
        expect({ column, failure: await migrate(`update public.admin_finance_years set ${column} = 1 where fiscal_year = 2025`) })
          .toEqual({ column, failure: failed('a8_legacy_opening_nonzero') });
      }
      // The control: with every opening column at 0 (sales_revenue is not an opening column) the same run passes.
      expect(await migrate()).toBeNull();
    });

    test('FREQ-560-AC-01: 法人の年があるときは移さず止まる', async () => {
      expect(await migrate("update public.admin_finance_years set business_type = 'corporation' where fiscal_year = 2026"))
        .toEqual(failed('a8_corporation_year'));
    });

    test('FREQ-560-AC-01: 締めの記録が1行でもあれば移さず止まる', async () => {
      expect(await migrate('insert into public.admin_finance_year_closings (fiscal_year) values (2025)'))
        .toEqual(failed('a8_closings_exist'));
    });

    test('FREQ-560-AC-02: S4の後に手入力の仕訳ができた行があればacc_s5_countsで止まり1つの行に2本目の仕訳を作らない', async () => {
      const edited = fixture.live[0];
      // A route write between S4 and S5: an edit of a moved-to-be row, or a new row (the S4 trigger posts it).
      expect(await accountingFailure(db(), async () => {
        await db().query(s4Inner);
        await db().query('update public.admin_finance_expenses set amount = amount + 1 where id = $1', [edited.id]);
        expect(await count("select count(*) as n from public.accounting_journal_entries where dedupe_key = $1", [`manual_entry:${edited.id}:0`])).toBe(1);
        await db().query(s5Inner);
      })).toEqual(failed('acc_s5_counts'));
      expect(await accountingFailure(db(), async () => {
        await db().query(s4Inner);
        await db().query(`insert into public.admin_finance_expenses (expense_date, category, item_name, amount, payment_method)
          values ('2026-10-25', '消耗品費', 'テープ', 300, '現金')`);
        await db().query(s5Inner);
      })).toEqual(failed('acc_s5_counts'));
    });

    test('FREQ-560-AC-01: S4の規則で開業費1810に入る取引があるときは移さずa8_startup_cost_categoryで止まる', async () => {
      const target = fixture.live[3].id;
      for (const assignment of ["category = '開業費'", "payment_method = '開業費'"]) {
        expect({ assignment, failure: await migrate(`update public.admin_finance_expenses set ${assignment} where id = ${target}`) })
          .toEqual({ assignment, failure: failed('a8_startup_cost_category') });
      }
      // A logically deleted row is not moved, so its category does not stop the migration.
      const deleted = fixture.rows.find((r) => r.deleted)?.id;
      expect(await migrate(`update public.admin_finance_expenses set category = '開業費' where id = ${deleted}`)).toBeNull();
    });

    test('FREQ-560-AC-02: S4を当てずにS5だけを流すとacc_s5_triggers_unchangedで止まる', async () => {
      expect(await accountingFailure(db(), async () => { await db().query(s5Inner); })).toEqual(failed('acc_s5_triggers_unchanged'));
    });

    test('FREQ-560-AC-01: 移す前に期間へ別の仕訳が先に番号を取っていればacc_s5_numberingで止まる', async () => {
      expect(await accountingFailure(db(), async () => {
        await db().query(s4Inner);
        await db().query(`select private.accounting_post_journal_core(null, private.accounting_period_for_event('2026-01-05', null),
          '2026-01-05', 'payment_confirmed', array['pi_a8_first'], 'd',
          '[{"account_code":"1130","debit":5},{"account_code":"4010","credit":5}]'::jsonb)`);
        await db().query(s5Inner);
      })).toEqual(failed('acc_s5_numbering'));
    });

    // admin_finance_receipts.entry_id references admin_finance_expenses, so the probe receipt uses an existing row.
    const receipt = `insert into public.admin_finance_receipts (entry_id, storage_path, file_name, mime_type, file_size)
      select min(id), 'probe/acc-s5.jpg', 'p.jpg', 'image/jpeg', 1 from public.admin_finance_expenses`;
    test.each([
      ["insert into public.admin_finance_entry_revisions (entry_id, operation) values (1, 'insert')", 'acc_s5_revisions_unchanged'],
      [receipt, 'acc_s5_receipts_unchanged'],
      ['alter table public.admin_finance_expenses disable trigger trigger_admin_finance_entry_revisions', 'acc_s5_triggers_unchanged'],
      ['alter table public.admin_finance_expenses enable always trigger trigger_admin_finance_entry_revisions', 'acc_s5_triggers_unchanged'],
      ['alter table public.admin_finance_expenses disable trigger accounting_manual_entry_journal', 'acc_s5_triggers_unchanged'],
      ['drop table pg_temp.accounting_s5_baseline', 'acc_s5_counts'],
      ["update pg_temp.accounting_s5_baseline set payload = jsonb_set(payload, '{live}', (payload->'live') - 0)", 'acc_s5_counts'],
      ["update pg_temp.accounting_s5_baseline set payload = jsonb_set(payload, '{expenses}', '21')", 'acc_s5_counts'],
      ["update pg_temp.accounting_s5_baseline set payload = jsonb_set(payload, '{live,0,recorded_at}', to_jsonb(now()))", 'acc_s5_counts'],
      [`update public.admin_finance_expenses set deleted_at = now() where id = (select min(id) from public.admin_finance_expenses
        where deleted_at is null)`, 'acc_s5_counts'],
    ])('FREQ-560-AC-02: S5末尾assert改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
      const run = (tamper: string) => accountingFailure(db(), async () => {
        await db().query(s4Inner);
        await db().query(body);
        if (tamper) await db().query(tamper);
        await db().query(assertion);
      });
      expect(await run(change)).toEqual(failed(detail));
      expect(await run('')).toBeNull();
    });
  });

  describe('after the fixture, S4 and S5 are committed', () => {
    let fixture: LegacyFixture;
    let admin: string;
    const notices: string[] = [];
    let before: Record<string, unknown>;
    const legacyState = async () => one(`select (select count(*)::int from public.admin_finance_entry_revisions) as revisions,
        (select count(*)::int from public.admin_finance_receipts) as receipts,
        (select count(*)::int from public.admin_finance_expenses) as expenses,
        (select md5(string_agg(to_jsonb(r)::text, ';' order by r.id)) from public.admin_finance_entry_revisions r) as revisions_md5,
        (select md5(string_agg(to_jsonb(r)::text, ';' order by r.id)) from public.admin_finance_receipts r) as receipts_md5,
        (select md5(string_agg(to_jsonb(x)::text, ';' order by x.id)) from public.admin_finance_expenses x) as expenses_md5,
        (select tgenabled::text from pg_trigger where tgrelid = 'public.admin_finance_expenses'::regclass
          and tgname = 'trigger_admin_finance_entry_revisions') as history_trigger`);
    beforeAll(async () => {
      if (!ready) throw new Error('ACC_S5_REPLAY_NEEDS_DB_AT_S3');
      await db().query('begin');
      admin = await insertAccountingAdmin(db());
      fixture = await insertLegacyFixture(db(), { admin, staff: await insertUser() });
      await db().query('commit');
      before = await legacyState();
      (db() as unknown as { on: (event: string, listener: (n: { message: string }) => void) => void })
        .on('notice', (n) => notices.push(n.message));
      // The two files as they are, each in its own transaction (what db push does on production).
      await db().query(ACCOUNTING_S4_SQL);
      await db().query(sql);
    });
    const rollbackAfter = async (run: () => Promise<void>) => {
      await db().query('begin');
      try { await run(); } finally { await db().query('rollback'); }
    };

    test('FREQ-560-AC-01: 取引18件を取引の日の順に仕訳へ移し日付は元の取引の日で登録した日時は元の作成日時になる', async () => {
      const entries = await migrated();
      expect(fixture.live).toHaveLength(18);
      expect(fixture.rows.filter((r) => r.deleted)).toHaveLength(2);
      expect(entries.map((e) => ({ id: e.source_id, date: e.entry_date, at: e.recorded_at.toISOString(), by: e.recorded_by,
        description: e.description, key: e.dedupe_key, source: e.source_table })))
        .toEqual(fixture.live.map((r) => ({ id: r.id, date: r.date, at: r.createdAt, by: r.actorId, description: r.item,
          key: `migrated_entry:${r.id}`, source: 'admin_finance_expenses' })));
      // The 2 logically deleted rows are not moved, and nothing else was posted.
      const deletedIds = fixture.rows.filter((r) => r.deleted).map((r) => r.id);
      expect(await count("select count(*) as n from public.accounting_journal_entries where source_id = any($1::text[])", [deletedIds])).toBe(0);
      expect(await count('select count(*) as n from public.accounting_journal_entries')).toBe(18);
      // The S5 NOTICE reports the moved and the skipped counts.
      expect(notices).toContain('acc_s5_counts moved=18 deleted_not_moved=2 revisions=25 receipts=8');
    });

    test('FREQ-560-AC-01: 通し番号は期間ごとに取引日の順で欠番なく振られ移した印と移した日が付く', async () => {
      const entries = await migrated();
      const byPeriod = (start: string) => entries.filter((e) => e.period_start === start);
      expect(byPeriod('2025-01-01').map((e) => [fixture.rows.find((r) => r.id === e.source_id)?.key, e.entry_no]))
        .toEqual([['a02', 1], ['a04', 2], ['a08', 3], ['a13', 4]]);
      expect(byPeriod('2026-01-01').map((e) => [fixture.rows.find((r) => r.id === e.source_id)?.key, e.entry_no]))
        .toEqual([['a01', 1], ['a06', 2], ['a03', 3], ['a05', 4], ['a07', 5], ['a09', 6], ['a11', 7], ['a12', 8], ['a14', 9],
          ['a15', 10], ['a17', 11], ['a18', 12], ['a19', 13], ['a20', 14]]);
      expect(entries.every((e) => e.migrated_from === 'admin_finance_expenses' && e.migrated_at instanceof Date && !e.is_late)).toBe(true);
      expect((await db().query(`select to_char(p.starts_on, 'YYYY-MM-DD') as start, s.last_entry_no::int as last
        from public.accounting_period_sequences s join public.accounting_periods p on p.id = s.period_id order by p.starts_on`)).rows)
        .toEqual([{ start: '2025-01-01', last: 4 }, { start: '2026-01-01', last: 14 }]);
    });

    test('FREQ-560-AC-01: 2025年の日付の取引があれば2025年の期間も作られる', async () => {
      expect((await db().query(`select business_type, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
          legacy_fiscal_year from public.accounting_periods order by starts_on`)).rows).toEqual([
        { business_type: 'soleProprietor', starts_on: '2025-01-01', ends_on: '2025-12-31', legacy_fiscal_year: 2025 },
        { business_type: 'soleProprietor', starts_on: '2026-01-01', ends_on: '2026-12-31', legacy_fiscal_year: 2026 },
      ]);
      expect((await migrated()).filter((e) => e.entry_date < '2026-01-01').map((e) => e.period_start))
        .toEqual(['2025-01-01', '2025-01-01', '2025-01-01', '2025-01-01']);
    });

    test('FREQ-560-AC-01: 経費は元の取引の日の年分のまま移り開業費1810は使わない', async () => {
      const entries = await migrated();
      expect(entries.every((e) => e.period_start.slice(0, 4) === e.entry_date.slice(0, 4))).toBe(true);
      expect(await count("select count(*) as n from public.accounting_journal_lines where account_code = '1810'")).toBe(0);
      const line = (account: string, debit: number, credit: number, counterparty: string | null = null, memo: string | null = null) =>
        ({ account_code: account, debit: String(debit), credit: String(credit), counterparty, memo });
      const linesOf = (key: string) => entries.find((e) => e.source_id === fixture.byKey.get(key)?.id)?.lines;
      expect(linesOf('a02')).toEqual([line('6020', 3300, 0), line('1010', 0, 3300)]);
      expect(linesOf('a03')).toEqual([line('6050', 1750, 0), line('2130', 0, 1750)]);
      expect(linesOf('a06')).toEqual([line('1040', 10000, 0), line('4040', 0, 10000)]);
      expect(linesOf('a09')).toEqual([line('6040', 640, 0), line('2920', 0, 640)]);
      expect(linesOf('a12')).toEqual([line('9999', 500, 0, null, '登録されていない科目'), line('1010', 0, 500)]);
      expect(linesOf('a15')).toEqual([line('1910', 300, 0), line('4040', 0, 300)]);
      expect(linesOf('a20')).toEqual([line('5020', 6600, 0, '資材店'), line('1040', 0, 6600, '資材店')]);
      // The same content entered now through the S4 trigger gets the same lines (the S4 rules, row by row).
      await rollbackAfter(async () => {
        for (const r of fixture.live) {
          const copy = (await one(`insert into public.admin_finance_expenses (expense_date, category, item_name, amount, payment_method,
              entry_type, partner, created_by) select expense_date, category, item_name, amount, payment_method, entry_type, partner, created_by
            from public.admin_finance_expenses where id = $1 returning id`, [r.id])).id;
          const lines = (await one(`select jsonb_agg(jsonb_build_object('account_code', l.account_code, 'debit', l.debit::text,
              'credit', l.credit::text, 'counterparty', l.counterparty, 'memo', l.memo) order by l.line_no) as lines
            from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
            where e.dedupe_key = $1`, [`manual_entry:${copy}:0`])).lines;
          expect({ key: r.key, lines }).toEqual({ key: r.key, lines: entries.find((e) => e.source_id === r.id)?.lines });
        }
      });
    });

    test('FREQ-560-AC-02: 移しかえの前後で直しの履歴の行数と領収書の行数と取引の行数が変わらず履歴のトリガーが有効のまま', async () => {
      expect(before).toMatchObject({ revisions: 25, receipts: 8, expenses: 20, history_trigger: 'O' });
      expect(await legacyState()).toEqual(before);
      expect(await count("select count(*) as n from public.admin_finance_receipts where evidence_kind <> 'unconfirmed'")).toBe(0);
    });

    test('FREQ-560-AC-02: 2回目の流しはacc_s5_countsで止まり、仕訳も期間も増えない', async () => {
      const counts = async () => one(`select (select count(*)::int from public.accounting_journal_entries) as entries,
        (select count(*)::int from public.accounting_periods) as periods,
        (select coalesce(sum(last_entry_no), 0)::int from public.accounting_period_sequences) as numbers`);
      const start = await counts();
      await db().query('begin');
      try {
        expect(await accountingFailure(db(), async () => { await db().query(s5Inner); })).toEqual(failed('acc_s5_counts'));
      } finally { await db().query('rollback'); }
      expect(await counts()).toEqual(start);
    });

    test('FREQ-560-AC-03: 移した取引を後で直すと取り消しと正しい仕訳が足され残高が合う', async () => {
      const edited = fixture.byKey.get('a03') as LegacyRow;
      const removed = fixture.byKey.get('a05') as LegacyRow;
      const keysOf = async (id: string) => (await db().query(`select e.dedupe_key, e.reverses_entry_id from public.accounting_journal_entries e
        where e.source_table = 'admin_finance_expenses' and e.source_id = $1`, [id])).rows;
      const net = async (id: string) => (await db().query(`select l.account_code, sum(l.debit - l.credit)::int as signed
        from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
        where e.source_table = 'admin_finance_expenses' and e.source_id = $1 group by l.account_code
        having sum(l.debit - l.credit) <> 0 order by l.account_code`, [id])).rows;
      await rollbackAfter(async () => {
        const migratedId = (await one('select id from public.accounting_journal_entries where dedupe_key = $1', [`migrated_entry:${edited.id}`])).id;
        const revisionsBefore = await count('select count(*) as n from public.admin_finance_entry_revisions where entry_id = $1', [edited.id]);
        await db().query('set local role service_role');
        await db().query('update public.admin_finance_expenses set amount = 1850, updated_by = $2 where id = $1', [edited.id, admin]);
        await db().query('update public.admin_finance_expenses set deleted_at = now(), deleted_by = $2 where id = $1', [removed.id, admin]);
        await db().query('reset role');
        await db().query('set constraints all immediate');
        // The migrated entry is reversed on its own day and the correct entry is manual_entry:<id>:0 (S4 counts
        // manual_entry only); the deleted row gets the reversal only.
        const keys = await keysOf(edited.id);
        expect(keys.map((k: { dedupe_key: string }) => k.dedupe_key).sort())
          .toEqual([`manual_entry:${edited.id}:0`, `migrated_entry:${edited.id}`, `reversal:${migratedId}`].sort());
        expect(await net(edited.id)).toEqual([{ account_code: '2130', signed: -1850 }, { account_code: '6050', signed: 1850 }]);
        expect(await net(removed.id)).toEqual([]);
        expect((await keysOf(removed.id)).map((k: { dedupe_key: string }) => k.dedupe_key)).toHaveLength(2);
        expect(await count('select count(*) as n from public.admin_finance_entry_revisions where entry_id = $1', [edited.id]))
          .toBe(revisionsBefore + 1);
        // The whole journal still balances, period by period.
        expect((await db().query(`select p.starts_on, sum(t.debit_total)::bigint = sum(t.credit_total)::bigint as balanced
          from public.accounting_periods p cross join lateral public.get_accounting_trial_balance(p.id) t group by p.starts_on`)).rows
          .every((r: { balanced: boolean }) => r.balanced)).toBe(true);
      });
    });

    test('FREQ-560-AC-03: 移した仕訳のsource_idから元の直しの履歴と領収書を引ける', async () => {
      const entries = await migrated();
      for (const e of entries) {
        const r = fixture.rows.find((x) => x.id === e.source_id) as LegacyRow;
        const revisions = (await db().query('select operation from public.admin_finance_entry_revisions where entry_id = $1::bigint order by id',
          [e.source_id])).rows.map((x: { operation: string }) => x.operation);
        const receipts = await count('select count(*) as n from public.admin_finance_receipts where entry_id = $1::bigint', [e.source_id]);
        expect({ key: r.key, revisions, receipts })
          .toEqual({ key: r.key, revisions: r.edited ? ['insert', 'update'] : ['insert'], receipts: LEGACY_RECEIPT_KEYS.filter((k) => k === r.key).length });
      }
      // The journal read (S3) carries the same counts as legacy.
      for (const start of ['2025-01-01', '2026-01-01']) {
        const page = (await one(`select public.list_accounting_journal(p.id, null, null, 200) as r from public.accounting_periods p
          where p.starts_on = $1::date`, [start])).r;
        for (const item of page.entries as { source_id: string; legacy: { revision_count: number; receipt_count: number } }[]) {
          const r = fixture.rows.find((x) => x.id === item.source_id) as LegacyRow;
          expect({ key: r.key, legacy: item.legacy }).toEqual({ key: r.key, legacy: {
            revision_count: r.edited ? 2 : 1, receipt_count: LEGACY_RECEIPT_KEYS.filter((k) => k === r.key).length } });
        }
      }
    });

    test('FREQ-560-AC-02: 移しかえの後もS2・S3・S4・S5の末尾assertは再生で通り、改ざんはacc_s5_*で止まる', async () => {
      const s4Baseline = s4Section('ACC_S4_BASELINE');
      const s4Assertion = s4Section('ACC_S4_FINAL_ASSERT');
      const attempt = async (pin: () => Promise<unknown>, check: string, change = ''): Promise<Failure> => {
        await db().query('begin');
        try {
          await pin();
          if (change) await db().query(change);
          await db().query(check);
          return null;
        } catch (error) {
          const e = error as { code?: string; message?: string; detail?: string };
          return { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
        } finally { await db().query('rollback'); }
      };
      const s5 = () => pinAccountingS5Baseline(db());
      for (const path of ['', 'set local search_path = pg_catalog', 'set local search_path = public, private, extensions, pg_catalog',
        "set local search_path = ''"]) {
        expect({ path, s2: await attempt(() => pinAccountingS2Baseline(db()), accountingS2Section('FINAL_ASSERT'), path) }).toEqual({ path, s2: null });
        expect({ path, s3: await attempt(() => pinAccountingS3Baseline(db()), accountingS3Section('FINAL_ASSERT'), path) }).toEqual({ path, s3: null });
        expect({ path, s4: await attempt(() => db().query(s4Baseline), s4Assertion, path) }).toEqual({ path, s4: null });
        expect({ path, s5: await attempt(s5, assertion, path) }).toEqual({ path, s5: null });
      }
      // The assert gives the caller's search_path back.
      await db().query('begin');
      try {
        await db().query('set local search_path = public, private, extensions, pg_catalog');
        await pinAccountingS5Baseline(db());
        await db().query(assertion);
        expect(await one("select current_setting('search_path') as path")).toEqual({ path: 'public, private, extensions, pg_catalog' });
      } finally { await db().query('rollback'); }
      expect(await attempt(s5, assertion, "insert into public.admin_finance_entry_revisions (entry_id, operation) values (1, 'insert')"))
        .toEqual(failed('acc_s5_revisions_unchanged'));
      expect(await attempt(s5, assertion, 'alter table public.admin_finance_expenses disable trigger trigger_admin_finance_entry_revisions'))
        .toEqual(failed('acc_s5_triggers_unchanged'));
      expect(await attempt(s5, assertion, `insert into public.admin_finance_receipts (entry_id, storage_path, file_name, mime_type, file_size)
        select min(id), 'probe/acc-s5-replay.jpg', 'p.jpg', 'image/jpeg', 1 from public.admin_finance_expenses`))
        .toEqual(failed('acc_s5_receipts_unchanged'));
    });
  });
});
