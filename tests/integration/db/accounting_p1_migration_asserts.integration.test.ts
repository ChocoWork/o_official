/** @jest-environment node */
import { formatPeriodName } from '@/lib/accounting/period';
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_S2_ACCOUNT_CODES, ACCOUNTING_S2_FILES, ACCOUNTING_S2_SQL as sql, ACCOUNTING_S3_FILES, ACCOUNTING_S3_SQL,
  accountingS2Section, accountingS3Section, createAccountingPeriod, insertAccountingAdmin, pinAccountingS2Baseline,
  pinAccountingS3Baseline, seedAccountingPeriod,
} from './helpers/accounting-fixtures';

// Accounting plan 1 S2 (FREQ-554): the shape of the migration and its final assert. The DB part is controller only.
const assertion = accountingS2Section('FINAL_ASSERT');
const body = accountingS2Section('BODY');
const details = ['acc_s2_tables', 'acc_s2_constraints', 'acc_s2_triggers', 'acc_s2_rls_acl', 'acc_s2_immutable',
  'acc_s2_event_kinds', 'acc_s2_accounts_seed', 'acc_s2_function_attrs', 'acc_s2_existing_dml_allowlist'];
type AssertFailure = { code?: string; message?: string; detail?: string };

/** The body without comment lines and without function bodies ($$ ... $$), i.e. the statements the migration runs. */
/** The two baseline statements the migration runs first (zero rows, no other account). */
const baselineStart = body.indexOf('CREATE TEMP TABLE accounting_s2_baseline');
const applyBaseline = body.slice(baselineStart, body.indexOf('::jsonb);', baselineStart) + '::jsonb);'.length);
const statements =body.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('S2 source contract (no DB)', () => {
  test('FREQ-554-AC-02: S2はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S2_FILES).toEqual(['20261107130200_accounting_p1_journal_foundation.sql']);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S2_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertion).not.toBe('');
    expect([...new Set([...assertion.matchAll(/'(acc_s2_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect(assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    // The reject-function body is compared as a doubled-quote literal; drop those before looking at the raised codes.
    expect(assertion.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-554-AC-03: S2の鍵は (190521,1)→(190525,0)→(190525,期間) の順で、190524を使わない', () => {
    expect(sql).not.toContain('190524');
    const lock = body.split('CREATE FUNCTION private.accounting_lock_all')[1]?.split('$$;')[0] ?? '';
    const order = ['pg_advisory_xact_lock(190521, 1)', 'pg_advisory_xact_lock(190525, 0)',
      'pg_advisory_xact_lock(190525, pg_catalog.hashtext(_period_id::text))'].map((text) => lock.indexOf(text));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Both cores take the locks first.
    for (const name of ['accounting_post_journal_core', 'accounting_reverse_journal_core']) {
      const fn = body.split(`CREATE FUNCTION private.${name}(`)[1]?.split('\n$$;')[0] ?? '';
      expect({ name, locks: fn.includes('PERFORM private.accounting_lock_all(') }).toEqual({ name, locks: true });
    }
  });

  test('FREQ-554-AC-06: S2の実行時のDMLは比べる元の控えと勘定の一覧のINSERTだけ', () => {
    expect([...statements.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s2_baseline', 'INSERT INTO public.accounting_accounts']);
    expect(statements).not.toMatch(/\bDO \$/);
    // At apply time the baseline is empty: no period, number, entry, line or other account may exist.
    expect(applyBaseline).toBe('CREATE TEMP TABLE accounting_s2_baseline(payload jsonb) ON COMMIT DROP;\n'
      + 'INSERT INTO pg_temp.accounting_s2_baseline(payload)\n'
      + `VALUES ('{"periods": 0, "sequences": 0, "entries": 0, "lines": 0, "other_accounts": []}'::jsonb);`);
    expect(body.indexOf(applyBaseline)).toBeLessThan(body.indexOf('CREATE TABLE public.accounting_accounts'));
    expect(ACCOUNTING_S2_ACCOUNT_CODES).toHaveLength(163);
  });
});

describeLocalDb('S2 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** pin: the replay baseline (the current state); apply: the migration's own empty baseline. */
  async function attempt(change = '', baseline: 'pin' | 'apply' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s2_assert');
    let failure: AssertFailure | null = null;
    try {
      // The baseline is taken first, then the tamper and the assertion run against it.
      // The posting entry point public.accounting_run_posting (plan 2 Task 6) is public on purpose; this assert (plan 1) says that nothing named
      // accounting_* is public, so the replay runs without it. The statement is undone with the savepoint.
      await db().query('drop function if exists public.accounting_run_posting(integer)');
      if (baseline === 'pin') await pinAccountingS2Baseline(db()); else await db().query(applyBaseline);
      if (change) await db().query(change);
      await db().query(assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s2_assert'); await db().query('release savepoint acc_s2_assert'); }
    return failure;
  }

  test('FREQ-554-AC-07: S2末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    // The assert pins an empty search_path only while it runs and gives the caller's back.
    await db().query('savepoint acc_s2_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    // The posting entry point public.accounting_run_posting (plan 2 Task 6) is public on purpose; this assert (plan 1) says that nothing named
    // accounting_* is public, so the replay runs without it. The statement is undone with the savepoint.
    await db().query('drop function if exists public.accounting_run_posting(integer)');
    await pinAccountingS2Baseline(db());
    await db().query(assertion);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s2_search_path');
  });

  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  /**
   * A period no other test or commit suite uses (direct insert): the year after the last sole period, or 2090 when
   * there is none. It keeps the sole layout gap-free, because a test may already have made the deferred layout check
   * immediate and A8 (S5) commits the sole periods of the moved transactions.
   */
  const farPeriod = `insert into public.accounting_periods (business_type, name, starts_on, ends_on)
    select 'soleProprietor', 'p', s.d, make_date(extract(year from s.d)::integer, 12, 31)
    from (select coalesce(max(ends_on) + 1, date '2090-01-01') as d from public.accounting_periods
      where business_type = 'soleProprietor') s`;

  test('FREQ-554-AC-07: S2末尾assertは後の移行が足した期間・仕訳・勘定があっても再生で通り、適用の時の空の控えなら断る', async () => {
    // What later migrations (S3-S5, plans 2-7) and commit suites leave behind: an added account, a period, an entry.
    await db().query("insert into public.accounting_accounts values ('8801', 'expense', 'debit', 'common', 'pl_zero')");
    const period = await seedAccountingPeriod(db(), { businessType: 'corporation' });
    await db().query(`select private.accounting_post_journal_core(null, p.id, p.starts_on, 'payment_confirmed', array['pi_replay'], 'd',
      '[{"account_code":"8801","debit":5},{"account_code":"4010","credit":5}]'::jsonb) from public.accounting_periods p where p.id = $1`, [period]);
    await db().query('set constraints all immediate');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'apply')).toEqual(failed('acc_s2_accounts_seed'));
    // The pinned baseline still catches a change made after it.
    expect(await attempt("insert into public.accounting_accounts values ('8802', 'expense', 'debit', 'common', 'pl_zero')"))
      .toEqual(failed('acc_s2_accounts_seed'));
    expect(await attempt(farPeriod)).toEqual(failed('acc_s2_existing_dml_allowlist'));
  });

  test('FREQ-554-AC-07: 適用の時の空の控えでは期間が1つでもあると断る', async () => {
    // Only a database that never held a period (a fresh reset) matches the apply-time baseline as it is.
    const fresh = Number((await db().query('select count(*) as n from public.accounting_periods')).rows[0].n) === 0;
    if (fresh) expect(await attempt('', 'apply')).toBeNull();
    expect(await attempt(farPeriod, 'apply')).toEqual(failed('acc_s2_existing_dml_allowlist'));
  });

  const lines = 'public.accounting_journal_lines';
  const entries = 'public.accounting_journal_entries';
  const core = 'private.accounting_post_journal_core(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text,timestamptz,text,timestamptz)';
  test.each([
    [`alter table ${lines} add column acc_probe text`, 'acc_s2_tables'],
    ['alter table public.accounting_periods alter column name drop not null', 'acc_s2_tables'],
    [`alter table ${entries} alter column recorded_at drop default`, 'acc_s2_tables'],
    [`alter table ${lines} drop constraint accounting_journal_lines_debit_check`, 'acc_s2_constraints'],
    ['alter table public.accounting_periods drop constraint accounting_periods_length_check', 'acc_s2_constraints'],
    [`alter table ${entries} drop constraint accounting_journal_entries_reverses_entry_id_key`, 'acc_s2_constraints'],
    [`alter table ${entries} drop constraint accounting_journal_entries_dedupe_key_key`, 'acc_s2_constraints'],
    [`alter table ${entries} add constraint acc_probe check (entry_no < 1000000)`, 'acc_s2_constraints'],
    ['drop index public.accounting_journal_entries_source_idx', 'acc_s2_constraints'],
    [`alter table ${lines} disable trigger accounting_journal_lines_balance`, 'acc_s2_triggers'],
    [`drop trigger accounting_journal_entries_balance on ${entries}`, 'acc_s2_triggers'],
    [`alter table ${entries} disable row level security`, 'acc_s2_rls_acl'],
    ['grant select on public.accounting_periods to authenticated', 'acc_s2_rls_acl'],
    [`grant insert on ${lines} to service_role`, 'acc_s2_rls_acl'],
    [`grant select (memo) on ${lines} to anon`, 'acc_s2_rls_acl'],
    ['create policy acc_probe on public.accounting_accounts for select to authenticated using (true)', 'acc_s2_rls_acl'],
    [`alter table ${entries} disable trigger accounting_journal_entries_no_update_delete`, 'acc_s2_immutable'],
    ['drop trigger accounting_accounts_no_truncate on public.accounting_accounts', 'acc_s2_immutable'],
    [`create trigger acc_probe before insert on ${lines} for each row execute function private.reject_accounting_mutation()`, 'acc_s2_immutable'],
    [`create or replace function private.reject_accounting_mutation() returns trigger language plpgsql set search_path = ''
      as $$ begin return null; end; $$`, 'acc_s2_immutable'],
    [`create or replace function private.accounting_event_arity(_kind text) returns integer language sql immutable security definer
      set search_path = '' as $$ select case when _kind = 'reversal' then 2 when _kind = any (private.accounting_event_kinds()) then 1 end $$`, 'acc_s2_event_kinds'],
    ["insert into public.accounting_accounts values ('8888', 'expense', 'debit', 'common', 'pl_zero')", 'acc_s2_accounts_seed'],
    [`grant execute on function ${core} to service_role`, 'acc_s2_function_attrs'],
    ['alter function private.accounting_lock_all(uuid) security invoker', 'acc_s2_function_attrs'],
    ['alter function private.accounting_jst_date(timestamptz) volatile', 'acc_s2_function_attrs'],
    [`create function private.accounting_period_for(_date date) returns uuid language sql stable security definer set search_path = ''
      as $$ select null::uuid $$`, 'acc_s2_function_attrs'],
    [`create or replace function public.admin_reverse_accounting_journal(_actor_id uuid, _entry_id uuid, _reason text, _entry_date date default null)
      returns jsonb language sql volatile security invoker set search_path = ''
      as $$ select private.admin_reverse_accounting_journal(_actor_id, _entry_id, 'fixed', _entry_date) $$`, 'acc_s2_function_attrs'],
    [`create function public.accounting_lock_all(_period_id uuid) returns void language sql set search_path = '' as $$ select $$`, 'acc_s2_function_attrs'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('corporation', 'p', '2030-04-01', '2031-03-31')", 'acc_s2_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s2_baseline', 'acc_s2_existing_dml_allowlist'],
    ["update pg_temp.accounting_s2_baseline set payload = payload - 'other_accounts'", 'acc_s2_existing_dml_allowlist'],
    ["update pg_temp.accounting_s2_baseline set payload = jsonb_set(payload, '{entries}', '5')", 'acc_s2_existing_dml_allowlist'],
    [`alter table ${entries} enable trigger accounting_journal_entries_no_update_delete`, 'acc_s2_immutable'],
    [`alter table ${lines} enable replica trigger accounting_journal_lines_no_truncate`, 'acc_s2_immutable'],
  ])('FREQ-554-AC-07: S2改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 1 S3 (FREQ-555): the shape of the migration and its final assert.
const s3Assertion = accountingS3Section('FINAL_ASSERT');
const s3Body = accountingS3Section('BODY');
const s3Details = ['acc_s3_settings_row', 'acc_s3_period_layout_trigger', 'acc_s3_functions', 'acc_s3_rls_acl', 'acc_s3_reads_stable'];
const s3BaselineStart = s3Body.indexOf('CREATE TEMP TABLE accounting_s3_baseline');
const s3ApplyBaseline = s3Body.slice(s3BaselineStart, s3Body.indexOf('::jsonb);', s3BaselineStart) + '::jsonb);'.length);
const s3Statements = s3Body.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
/** The body of one CREATE FUNCTION of S3 (up to its closing $$;). */
const s3Function = (name: string) => s3Body.split(`CREATE FUNCTION ${name}(`)[1]?.split('\n$$;')[0] ?? '';

describe('S3 source contract (no DB)', () => {
  test('FREQ-555-AC-01: S3はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S3_FILES).toEqual(['20261107130300_accounting_p1_period_reads.sql']);
    expect(ACCOUNTING_S3_SQL).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(ACCOUNTING_S3_SQL.startsWith('BEGIN;\n')).toBe(true);
    expect(ACCOUNTING_S3_SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(ACCOUNTING_S3_SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(ACCOUNTING_S3_SQL.trimEnd()).toMatch(/-- ACC_S3_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s3Assertion.matchAll(/'(acc_s3_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s3Details].sort());
    expect(s3Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s3Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(ACCOUNTING_S3_SQL).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-555-AC-01: S3の実行時のDMLは比べる元の控えと設定の1行のINSERTだけ', () => {
    expect([...s3Statements.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s3_baseline', 'INSERT INTO public.accounting_settings']);
    expect(s3Statements).not.toMatch(/\bDO \$/);
    expect(s3ApplyBaseline).toBe('CREATE TEMP TABLE accounting_s3_baseline(payload jsonb) ON COMMIT DROP;\n'
      + 'INSERT INTO pg_temp.accounting_s3_baseline(payload)\n'
      + `VALUES ('{"settings": null, "opening_rows": 0}'::jsonb);`);
    expect(s3Body.indexOf(s3ApplyBaseline)).toBeLessThan(s3Body.indexOf('CREATE TABLE public.accounting_settings'));
    expect(s3Body).toContain('INSERT INTO public.accounting_settings (id, cutover_on) VALUES (1, private.accounting_jst_date(pg_catalog.now()));');
  });

  test('FREQ-555-AC-07: S3の書く関数は状態を読む前に (190521,1)→(190525,0)→(190525,期間) の鍵を取り、取り消しのcoreはS2の1つだけ', () => {
    expect(ACCOUNTING_S3_SQL).not.toContain('190524');
    for (const [name, lock] of [
      ['private.admin_create_accounting_period', 'PERFORM private.accounting_lock_all(NULL);'],
      ['private.admin_shorten_final_sole_period', 'PERFORM private.accounting_lock_all(_period_id);'],
      ['private.admin_update_accounting_settings', 'PERFORM private.accounting_lock_all(NULL);'],
      ['private.admin_update_accounting_period_filing', 'PERFORM private.accounting_lock_all(_period_id);'],
      ['private.accounting_ensure_individual_periods', 'PERFORM private.accounting_lock_all(NULL);'],
      ['private.accounting_store_opening', 'PERFORM private.accounting_lock_all(_period_id);'],
    ]) {
      const fn = s3Function(name);
      const firstRead = fn.search(/FROM public\.accounting_(periods|settings|opening_balances)|accounting_request_replay\(/);
      expect({ name, locked: fn.includes(lock), before: fn.indexOf(lock) < firstRead }).toEqual({ name, locked: true, before: true });
    }
    // D6: the reversal core has one body, in S2; S3 does not recreate it.
    expect(ACCOUNTING_S3_SQL).not.toMatch(/CREATE (OR REPLACE )?FUNCTION private\.accounting_reverse_journal_core/);
    expect(sql.match(/CREATE (OR REPLACE )?FUNCTION private\.accounting_reverse_journal_core/g)).toHaveLength(1);
    expect(sql).toContain('PERFORM private.accounting_ensure_individual_periods(EXTRACT(year FROM v_date)::integer, _actor_id);');
    // T7-b: the length is checked before the period is written.
    const create = s3Function('private.admin_create_accounting_period');
    expect(create.indexOf('private.accounting_period_length_ok(_starts_on, _ends_on)'))
      .toBeLessThan(create.indexOf('INSERT INTO public.accounting_periods'));
  });

  test('FREQ-555-AC-01: S3のU&形の期間の名前はTSのformatPeriodNameと同じ文字', () => {
    const fn = s3Function('private.accounting_default_period_name');
    const decode = (text: string) => text.replace(/\\([0-9A-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const literals = [...fn.matchAll(/U&'((?:\\[0-9A-F]{4})+)'/g)].map((m) => decode(m[1]));
    const sole = formatPeriodName({ businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    const corporation = formatPeriodName({ businessType: 'corporation', startsOn: '2030-01-01', endsOn: '2030-12-31', termNumber: 7 });
    expect([`2026${literals[0]}`, `${literals[1]}7${literals[2]}`]).toEqual([sole, corporation]);
  });
});

describeLocalDb('S3 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const s2Assertion = accountingS2Section('FINAL_ASSERT');
  /** pin: the replay baseline (the current state); apply: the migration's own baseline. s2: the S2 assert, pinned. */
  async function attempt(change = '', baseline: 'pin' | 'apply' | 's2' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s3_assert');
    let failure: AssertFailure | null = null;
    try {
      // The posting entry point public.accounting_run_posting (plan 2 Task 6) is public on purpose; this assert (plan 1) says that nothing named
      // accounting_* is public, so the replay runs without it. The statement is undone with the savepoint.
      await db().query('drop function if exists public.accounting_run_posting(integer)');
      if (baseline === 'pin') await pinAccountingS3Baseline(db());
      else if (baseline === 'apply') await db().query(s3ApplyBaseline);
      else await pinAccountingS2Baseline(db());
      if (change) await db().query(change);
      await db().query(baseline === 's2' ? s2Assertion : s3Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s3_assert'); await db().query('release savepoint acc_s3_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });

  test('FREQ-555-AC-01: S3末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(s3Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    // The S2 assert replayed after S3, under the same caller paths.
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog', 's2')).toBeNull();
    expect(await attempt("set local search_path = ''", 's2')).toBeNull();
  });

  test('FREQ-555-AC-01: S3の後に期間・設定・期首の行があってもS2とS3の末尾assertは再生で通り、適用の時の空の控えなら断る', async () => {
    const admin = await insertAccountingAdmin(db());
    // The two terms follow the last committed corporation period, if a commit suite left one (order independent).
    const next = async () => (await db().query(`select to_char(s.d, 'YYYY-MM-DD') as "startsOn",
        to_char((s.d + interval '1 year' - interval '1 day')::date, 'YYYY-MM-DD') as "endsOn"
      from (select coalesce(max(ends_on) + 1, date '2070-01-01') as d from public.accounting_periods
        where business_type = 'corporation') s`)).rows[0];
    const term1 = await createAccountingPeriod(db(), admin, { businessType: 'corporation', ...(await next()) });
    const term2 = await createAccountingPeriod(db(), admin, { businessType: 'corporation', ...(await next()) });
    const settings = (await db().query('select public.get_accounting_settings() as r')).rows[0].r;
    await db().query("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, gen_random_uuid())",
      [admin, settings.version]);
    await db().query(`select private.accounting_store_opening($1::uuid, $2::uuid,
      '[{"account_code":"1010","signed_amount":10},{"account_code":"3040","signed_amount":-10}]', 1, 'closing_carryover', $3::uuid)`,
      [admin, term2.id, term1.id]);
    await db().query('set constraints all immediate');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 's2')).toBeNull();
    expect(await attempt('', 'apply')).toEqual(failed('acc_s3_settings_row'));
    // The pinned baseline still catches a change made after it.
    expect(await attempt('update public.accounting_settings set version = version + 1')).toEqual(failed('acc_s3_settings_row'));
    expect(await attempt(`insert into public.accounting_opening_balances (period_id, account_code, signed_amount, closing_version, source,
      source_period_id) values ('${term2.id}', '1010', 0, 2, 'closing_carryover', '${term1.id}')`)).toEqual(failed('acc_s3_settings_row'));
  });

  const settingsTable = 'public.accounting_settings';
  const opening = 'public.accounting_opening_balances';
  const periods = 'public.accounting_periods';
  test.each([
    [`alter table ${settingsTable} add column acc_probe text`, 'acc_s3_settings_row'],
    [`alter table ${settingsTable} alter column current_business_type drop default`, 'acc_s3_settings_row'],
    [`alter table ${settingsTable} drop constraint accounting_settings_id_check`, 'acc_s3_settings_row'],
    [`alter table ${opening} drop constraint accounting_opening_balances_source_period_id_fkey`, 'acc_s3_settings_row'],
    [`alter table ${opening} add constraint acc_probe check (signed_amount < 1000000000000)`, 'acc_s3_settings_row'],
    ['drop table pg_temp.accounting_s3_baseline', 'acc_s3_settings_row'],
    ["update pg_temp.accounting_s3_baseline set payload = jsonb_set(payload, '{opening_rows}', '3')", 'acc_s3_settings_row'],
    [`drop trigger accounting_periods_layout on ${periods}`, 'acc_s3_period_layout_trigger'],
    [`alter table ${periods} disable trigger accounting_periods_guard_update`, 'acc_s3_period_layout_trigger'],
    [`alter table ${periods} enable trigger accounting_periods_no_delete`, 'acc_s3_period_layout_trigger'],
    [`alter table ${settingsTable} disable trigger accounting_settings_sole_end`, 'acc_s3_period_layout_trigger'],
    [`drop trigger accounting_opening_balances_no_truncate on ${opening}`, 'acc_s3_period_layout_trigger'],
    [`create trigger acc_probe before insert on ${settingsTable} for each row execute function private.reject_accounting_mutation()`, 'acc_s3_period_layout_trigger'],
    [`create or replace function private.accounting_check_period_layout() returns trigger language plpgsql security definer
      set search_path = '' as $$ begin return null; end; $$`, 'acc_s3_period_layout_trigger'],
    [`create or replace function private.accounting_guard_period_update() returns trigger language plpgsql security definer
      set search_path = '' as $$ begin return new; end; $$`, 'acc_s3_period_layout_trigger'],
    [`create or replace function private.accounting_guard_settings_update() returns trigger language plpgsql security definer
      set search_path = '' as $$ begin return new; end; $$`, 'acc_s3_period_layout_trigger'],
    [`alter table ${settingsTable} disable row level security`, 'acc_s3_rls_acl'],
    [`grant select on ${opening} to authenticated`, 'acc_s3_rls_acl'],
    [`grant insert on ${settingsTable} to service_role`, 'acc_s3_rls_acl'],
    [`grant select (version) on ${settingsTable} to anon`, 'acc_s3_rls_acl'],
    [`create policy acc_probe on ${opening} for select to service_role using (true)`, 'acc_s3_rls_acl'],
    ['grant execute on function private.accounting_period_for_event(date,uuid) to service_role', 'acc_s3_functions'],
    ['alter function private.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid) security invoker', 'acc_s3_functions'],
    ['revoke execute on function private.admin_create_accounting_period(uuid,text,date,date,text,uuid) from service_role', 'acc_s3_functions'],
    [`create function private.admin_create_accounting_period(_actor_id uuid) returns jsonb language sql security definer
      set search_path = '' as $$ select null::jsonb $$`, 'acc_s3_functions'],
    [`create or replace function public.admin_update_accounting_settings(_actor_id uuid, _business_start_date date,
      _current_business_type text, _expected_version bigint, _request_key uuid) returns jsonb language sql volatile security invoker
      set search_path = '' as $$ select private.admin_update_accounting_settings(_actor_id, null, _current_business_type,
      _expected_version, _request_key) $$`, 'acc_s3_functions'],
    [`create or replace function private.accounting_reverse_journal_core(_actor_id uuid, _entry_id uuid, _reason text,
      _entry_date date default null, _source_recorded_at timestamptz default null) returns jsonb language plpgsql security definer
      set search_path = '' as $$ begin return null; end; $$`, 'acc_s3_functions'],
    [`create function public.accounting_probe() returns void language sql set search_path = '' as $$ select $$`, 'acc_s3_functions'],
    ['alter function public.list_accounting_journal(uuid,date,date,integer,date,bigint) volatile', 'acc_s3_reads_stable'],
    ['grant execute on function private.accounting_opening_balances(uuid) to service_role', 'acc_s3_reads_stable'],
    ['alter function private.get_accounting_settings() security invoker', 'acc_s3_reads_stable'],
    ['revoke execute on function public.get_accounting_settings() from service_role', 'acc_s3_reads_stable'],
    [`create or replace function public.get_accounting_trial_balance(_period_id uuid, _through date default null)
      returns table(account_code text, debit_total bigint, credit_total bigint, opening_signed bigint) language sql stable
      security invoker set search_path = '' as $$ select * from private.get_accounting_trial_balance(_period_id, null) $$`, 'acc_s3_reads_stable'],
  ])('FREQ-555-AC-01: S3改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});
