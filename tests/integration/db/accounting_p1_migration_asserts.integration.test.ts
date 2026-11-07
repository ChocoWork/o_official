/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_S2_ACCOUNT_CODES, ACCOUNTING_S2_FILES, ACCOUNTING_S2_SQL as sql, accountingS2Section, pinAccountingS2Baseline,
  seedAccountingPeriod,
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
  });

  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  /** A period no other test or commit suite uses (direct insert; S2 checks the layout only inside the core). */
  const farPeriod = "insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'p', '2090-01-01', '2090-12-31')";

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
