/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_S6_FILES, ACCOUNTING_S6_SQL as sql, accountingS6Section, pinAccountingS6Baseline,
  ACCOUNTING_S7_FILES, ACCOUNTING_S7_SQL as sqlS7, accountingS7Section, pinAccountingS7Baseline,
  ACCOUNTING_S8_FILES, ACCOUNTING_S8_SQL as sqlS8, accountingS8Section, pinAccountingS8Baseline,
  ACCOUNTING_S9_FILES, ACCOUNTING_S9_SQL as sqlS9, accountingS9Section, pinAccountingS9Baseline,
  ACCOUNTING_S10_FILES, ACCOUNTING_S10_SQL as sqlS10, accountingS10Section, pinAccountingS10Baseline,
  ACCOUNTING_S11_FILES, ACCOUNTING_S11_SQL as sqlS11, accountingS11Section, pinAccountingS11Baseline,
  ACCOUNTING_S12_FILES, ACCOUNTING_S12_SQL as sqlS12, accountingS12Section, pinAccountingS12Baseline,
  ACCOUNTING_S13_FILES, ACCOUNTING_S13_SQL as sqlS13, accountingS13Section, pinAccountingS13Baseline,
} from './helpers/accounting-orders-fixtures';
import { ACCOUNTING_LABELS, encodeSqlUnicodeLiteral } from '@/lib/accounting/labels';
import { MONTHLY_KPI_FORMULAS, SOURCE_METRIC_KEYS, isValidStorageKey, kpiOverrideStorageKey, sourceStorageKey } from '@/lib/kpi/monthly-metrics';

// Accounting plan 2 S6 (FREQ-569 / FREQ-563): the shape of the migration and its final assert. The DB part is
// controller only. Tasks 2-9 add the asserts of S7-S14 below (S7: the payment posting, Task 2; S8: the shipment posting, Task 3; S11: the dispute posting, Task 6; S12: the intake reads, Task 7).
const assertion = accountingS6Section('FINAL_ASSERT');
const body = accountingS6Section('BODY');
const details = ['acc_s6_tables', 'acc_s6_constraints', 'acc_s6_immutable', 'acc_s6_rls_acl', 'acc_s6_function_attrs',
  'acc_s6_heartbeat_check', 'acc_s6_seq_acl', 'acc_s6_slip_fact_backfill', 'acc_s6_g_body_unchanged', 'acc_s6_g_function_attrs',
  'acc_s6_g_allowlist_unchanged', 'acc_s6_existing_dml_allowlist'];
type AssertFailure = { code?: string; message?: string; detail?: string };
const statements = body.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').replace(/\$acc_s6_precheck\$[\s\S]*?\$acc_s6_precheck\$/g, '')
  .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('S6 source contract (no DB)', () => {
  test('FREQ-569-AC-01: S6はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S6_FILES).toHaveLength(1);
    expect(ACCOUNTING_S6_FILES[0] > '20261108063711').toBe(true);
    expect(ACCOUNTING_S6_FILES).toEqual(['20261108150000_accounting_p2_posting_tables.sql']);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S6_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertion).not.toBe('');
    expect([...new Set([...assertion.matchAll(/'(acc_s6_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect(assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertion.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    expect(sql).not.toContain('190524');
  });

  test('FREQ-569-AC-01: S6の最初の確かめは確定・取り消し済みの発送票が0件で、0でなければ固定DETAILで止める', () => {
    const precheck = body.split('DO $acc_s6_precheck$')[1]?.split('$acc_s6_precheck$;')[0] ?? '';
    expect(precheck).toContain("s.stage IN ('confirmed', 'cancelled')");
    expect(precheck).toContain("DETAIL = 'acc_s6_slip_fact_backfill'");
    // It runs before anything is created.
    expect(body.indexOf('DO $acc_s6_precheck$')).toBeLessThan(body.indexOf('CREATE TABLE'));
    expect(body.indexOf('DO $acc_s6_precheck$')).toBeLessThan(body.indexOf('CREATE SEQUENCE'));
  });

  test('FREQ-569-AC-01: S6の実行時のDMLは比べる元の控えのINSERTだけ（行を書く文も消す文も無い）', () => {
    expect([...statements.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s6_baseline']);
    expect(statements).not.toMatch(/\bDO \$/);
  });

  test('FREQ-563-AC-03: S6の鍵は (190521,1) の中でだけ番号を取り、書く関数は accounting_lock_all で順に取る', () => {
    const take = body.split('CREATE FUNCTION private.accounting_take_g_fact_seq()')[1]?.split('\n$$;')[0] ?? '';
    expect(take).toContain('PERFORM private.group_h_assert_unit_lock();');
    expect(take.indexOf('group_h_assert_unit_lock')).toBeLessThan(take.indexOf('nextval'));
    expect(take).toContain('clock_timestamp()');
    expect(take).not.toMatch(/\bnow\(\)/);
    const resolve = body.split('CREATE FUNCTION private.admin_resolve_accounting_pending_event(')[1]?.split('\n$$;')[0] ?? '';
    expect(resolve.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeGreaterThan(0);
    expect(resolve.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(resolve.indexOf('FROM public.accounting_pending_events'));
    for (const name of ['accounting_record_slip_fact', 'accounting_record_unit_refund']) {
      const fn = body.split(`CREATE FUNCTION private.${name}(`)[1]?.split('\n$$;')[0] ?? '';
      expect({ name, takesNumberFirst: fn.indexOf('accounting_take_g_fact_seq()') > 0
        && fn.indexOf('accounting_take_g_fact_seq()') < fn.search(/INSERT INTO|RAISE EXCEPTION/) }).toEqual({ name, takesNumberFirst: true });
    }
  });

  test('FREQ-563-AC-03: S6の2本のGの関数は最新の定義を一字も変えず、足すのは ACC_P2 の囲みの1行だけ', () => {
    const g4 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261026045859_group_g4_orders_foundation.sql'), 'utf8');
    const g3 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261025100130_group_g3_shipping_slips.sql'), 'utf8');
    const confirmLatest = g4.match(/CREATE OR REPLACE FUNCTION private\.admin_confirm_shipment_slip\([\s\S]*?\n\$\$;/)?.[0] as string;
    const cancelLatest = (g3.match(/CREATE FUNCTION private\.admin_cancel_shipment_slip\([\s\S]*?\n\$\$;/)?.[0] as string)
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    const confirmNew = body.match(/CREATE OR REPLACE FUNCTION private\.admin_confirm_shipment_slip\([\s\S]*?\n\$\$;/)?.[0] as string;
    const cancelNew = body.match(/CREATE OR REPLACE FUNCTION private\.admin_cancel_shipment_slip\([\s\S]*?\n\$\$;/)?.[0] as string;
    // With the block lines removed the new text is the old text, character for character.
    expect(confirmNew.replace(/\n    -- ACC_P2_BEGIN\n    PERFORM private\.accounting_record_slip_fact\(_slip_id, 'confirm'\);\n    -- ACC_P2_END/, '')).toBe(confirmLatest);
    expect(cancelNew.replace(/\n    -- ACC_P2_BEGIN\n    PERFORM private\.accounting_record_slip_fact\(_slip_id, 'cancel'\);\n    -- ACC_P2_END/, '')).toBe(cancelLatest);
    // The md5 in the assert is the md5 of that text with the white space removed.
    const crypto = jest.requireActual('node:crypto') as typeof import('node:crypto');
    const md5 = (fn: string) => crypto.createHash('md5').update(
      fn.slice(fn.indexOf('AS $$') + 5, fn.lastIndexOf('$$;')).replace(/-- ACC_P\d_BEGIN[\s\S]*?-- ACC_P\d_END/g, '').replace(/\s+/g, ''), 'utf8').digest('hex');
    expect(assertion).toContain(`IS DISTINCT FROM '${md5(confirmLatest)}'`);
    expect(assertion).toContain(`IS DISTINCT FROM '${md5(cancelLatest)}'`);
    // The header, arguments, attributes and ACL statements of the two functions are not repeated here.
    expect(body).not.toMatch(/(?:ALTER|REVOKE|GRANT)[^;]*FUNCTION (?:private|public)\.admin_(?:confirm|cancel)_shipment_slip/i);
    expect(body).not.toContain('group_g_writer_allowlist() RETURNS');
  });
});

describeLocalDb('S6 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** The baseline is pinned first, then the tamper and the assertion run against it. */
  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s6_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS6Baseline(db());
      if (change) await db().query(change);
      await db().query(assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s6_assert'); await db().query('release savepoint acc_s6_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });

  test('FREQ-569-AC-01: S6末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    // The assert pins an empty search_path only while it runs and gives the caller's back.
    await db().query('savepoint acc_s6_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS6Baseline(db());
    await db().query(assertion);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s6_search_path');
  });

  test('FREQ-569-AC-01: 後の Task が足す public の accounting_* 関数（accounting_run_posting など）があっても S6 末尾assertは再生で通る', async () => {
    expect(await attempt(`create or replace function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select '{}'::jsonb $$`)).toBeNull();
  });

  test('FREQ-569-AC-01: S6末尾assertは後の移行・試験が足した行があっても再生で通り、足したままの比べる元の控えが無いと断る', async () => {
    // What later plans and commit suites leave behind: parked rows, a fact, a unit refund.
    await db().query("select private.accounting_park_event('payment_confirmed', 'orders', 'replay_1', null, 'no_order', '{}')");
    expect(await attempt()).toBeNull();
    // The pinned baseline still catches a change made after it.
    expect(await attempt("select private.accounting_park_event('payment_confirmed', 'orders', 'replay_2', null, 'no_order', '{}')"))
      .toEqual(failed('acc_s6_existing_dml_allowlist'));
    // Without the baseline (or with a broken one) the assert fails closed.
    expect(await attempt('', 'none')).toEqual(failed('acc_s6_existing_dml_allowlist'));
    expect(await attempt('create temp table accounting_s6_baseline(payload jsonb) on commit drop', 'none')).toEqual(failed('acc_s6_existing_dml_allowlist'));
  });

  const confirm = 'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)';
  const cancel = 'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)';
  const replaceBody = (signature: string, from: string, to: string) =>
    `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), ${from}, ${to}); end $x$`;
  // A confirmed slip that has no confirm fact (the group G functions would have written one).
  const UNFACTED_SLIP = `do $x$ declare op uuid := gen_random_uuid(); sid uuid := gen_random_uuid(); begin
    perform pg_catalog.pg_advisory_xact_lock(190521,1);
    insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,actor_id,result)
      values (op,'shipment_slip_confirm',gen_random_uuid(),repeat('a',64),'shipment_slip',sid::text,gen_random_uuid(),'{}');
    insert into public.shipment_slips (id,number,stage,customer_kind,customer_email,ship_to_full_name,ship_to_postal_code,ship_to_prefecture,
      ship_to_city,ship_to_address,ship_to_phone,draft_lines,notify_customer,shipment_date,confirm_request_key,confirm_operation_id,
      confirmed_at,confirmed_by,created_by)
      values (sid,'SL-29991231-'||lpad((1000+floor(random()*8000))::text,4,'0'),'confirmed','guest','x@example.invalid','x','0000000','x','x','x',
      '0000000000','[]',false,current_date,gen_random_uuid(),op,now(),gen_random_uuid(),gen_random_uuid());
    end $x$`;
  test.each([
    ['alter table public.accounting_pending_events add column acc_probe text', 'acc_s6_tables'],
    ['alter table public.accounting_shipment_units alter column refunded_amount drop default', 'acc_s6_tables'],
    ['alter table public.accounting_g_slip_facts alter column locked_at drop not null', 'acc_s6_tables'],
    ['alter table public.accounting_unit_refund_allocations rename column amount to amount_x', 'acc_s6_tables'],
    ['alter table public.accounting_pending_events drop constraint accounting_pending_events_source_key', 'acc_s6_constraints'],
    ['alter table public.accounting_pending_events drop constraint accounting_pending_events_reason_check', 'acc_s6_constraints'],
    ['alter table public.accounting_pending_events drop constraint accounting_pending_events_resolution_request_key_key', 'acc_s6_constraints'],
    ['alter table public.accounting_unit_refund_allocations drop constraint accounting_unit_refund_allocations_fact_seq_key', 'acc_s6_constraints'],
    ['alter table public.accounting_unit_refund_allocations drop constraint accounting_unit_refund_allocations_unit_fkey', 'acc_s6_constraints'],
    ['alter table public.accounting_unit_refund_allocations drop constraint accounting_unit_refund_allocations_amount_check', 'acc_s6_constraints'],
    ['alter table public.accounting_shipment_units add constraint acc_probe check (paid_amount < 1000000000)', 'acc_s6_constraints'],
    ['alter table public.accounting_g_slip_facts drop constraint accounting_g_slip_facts_kind_check', 'acc_s6_constraints'],
    ['alter table public.accounting_g_slip_facts drop constraint accounting_g_slip_facts_slip_id_fkey', 'acc_s6_constraints'],
    ['drop trigger accounting_unit_refund_allocations_sum on public.accounting_unit_refund_allocations', 'acc_s6_constraints'],
    ['alter table public.accounting_unit_refund_allocations disable trigger accounting_unit_refund_allocations_sum', 'acc_s6_constraints'],
    ['drop index public.accounting_journal_lines_order_account_idx', 'acc_s6_constraints'],
    ['drop index public.accounting_pending_events_open_idx', 'acc_s6_constraints'],
    ['alter table public.accounting_shipment_units disable trigger accounting_shipment_units_no_update_delete', 'acc_s6_immutable'],
    ['drop trigger accounting_unit_refund_allocations_no_truncate on public.accounting_unit_refund_allocations', 'acc_s6_immutable'],
    ['alter table public.accounting_g_slip_facts enable replica trigger accounting_g_slip_facts_no_update_delete', 'acc_s6_immutable'],
    ['create trigger acc_probe before insert on public.accounting_g_slip_facts for each row execute function private.reject_accounting_mutation()', 'acc_s6_immutable'],
    ['alter table public.accounting_pending_events disable row level security', 'acc_s6_rls_acl'],
    ['grant select on public.accounting_shipment_units to authenticated', 'acc_s6_rls_acl'],
    ['grant insert on public.accounting_pending_events to service_role', 'acc_s6_rls_acl'],
    ['grant select (reason) on public.accounting_pending_events to anon', 'acc_s6_rls_acl'],
    ['create policy acc_probe on public.accounting_g_slip_facts for select to authenticated using (true)', 'acc_s6_rls_acl'],
    ['revoke select on public.accounting_unit_refund_allocations from service_role', 'acc_s6_rls_acl'],
    ['grant execute on function private.accounting_take_g_fact_seq() to service_role', 'acc_s6_function_attrs'],
    ['grant execute on function private.accounting_park_event(text,text,text,uuid,text,jsonb) to service_role', 'acc_s6_function_attrs'],
    ['alter function private.accounting_shipped_units(uuid,bigint) volatile', 'acc_s6_function_attrs'],
    ['alter function private.accounting_allocate_amount(bigint,bigint[]) security invoker', 'acc_s6_function_attrs'],
    ['revoke execute on function public.list_accounting_pending_events(boolean,integer,timestamptz,uuid) from service_role', 'acc_s6_function_attrs'],
    [`create or replace function public.get_accounting_pending_summary() returns jsonb language sql stable security invoker
      set search_path = '' as $$ select '{}'::jsonb $$`, 'acc_s6_function_attrs'],
    [`create function public.accounting_shipped_units(_a uuid, _b bigint) returns void language sql set search_path = '' as $$ select $$`, 'acc_s6_function_attrs'],
    [`create function public.accounting_park_event() returns void language sql set search_path = '' as $$ select $$`, 'acc_s6_function_attrs'],
    [`create function private.accounting_cutover_on(_x integer) returns date language sql stable security definer
      set search_path = '' as $$ select null::date $$`, 'acc_s6_function_attrs'],
    [`alter table public.ops_job_heartbeats drop constraint ops_job_heartbeats_job_check,
      add constraint ops_job_heartbeats_job_check check (job in ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking'))`, 'acc_s6_heartbeat_check'],
    [`alter table public.ops_job_heartbeats drop constraint ops_job_heartbeats_job_check,
      add constraint ops_job_heartbeats_job_check check (job in ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking', 'accounting_post', 'other_job'))`, 'acc_s6_heartbeat_check'],
    ['grant usage on sequence private.accounting_g_fact_seq to service_role', 'acc_s6_seq_acl'],
    ['grant select on sequence private.accounting_g_fact_seq to authenticated', 'acc_s6_seq_acl'],
    ['alter sequence private.accounting_g_fact_seq as integer', 'acc_s6_seq_acl'],
    [UNFACTED_SLIP, 'acc_s6_slip_fact_backfill'],
    [replaceBody(confirm, `'v_slip.expires_at <= pg_catalog.now()'`, `'v_slip.expires_at < pg_catalog.now()'`), 'acc_s6_g_body_unchanged'],
    [replaceBody(cancel, `'GROUP_G_SLIP_CANCELLED'`, `'GROUP_G_SLIP_CANCELLEX'`), 'acc_s6_g_body_unchanged'],
    [replaceBody(confirm, `'PERFORM private.accounting_record_slip_fact(_slip_id, ''confirm'');'`, `'PERFORM 1;'`), 'acc_s6_g_body_unchanged'],
    [replaceBody(cancel, `'-- ACC_P2_BEGIN'`, `'-- ACC_P2_BEGINX'`), 'acc_s6_g_body_unchanged'],
    ['alter function private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) security invoker', 'acc_s6_g_function_attrs'],
    ['revoke execute on function private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) from service_role', 'acc_s6_g_function_attrs'],
    ['grant execute on function public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) to anon', 'acc_s6_g_function_attrs'],
    ['alter function private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) set search_path = public', 'acc_s6_g_function_attrs'],
    [`create or replace function private.group_g_writer_allowlist() returns regprocedure[] language sql stable security definer set search_path = ''
      as $$ select array(select unnest(array[]::regprocedure[])) $$`, 'acc_s6_g_allowlist_unchanged'],
    [`create or replace function private.group_g_writer_allowlist() returns regprocedure[] language sql stable security definer set search_path = ''
      as $$ select ('{' || concat_ws(',', 'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
      'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)', 'private.accounting_cutover_on()') || '}')::regprocedure[] $$`, 'acc_s6_g_allowlist_unchanged'],
    ["select private.accounting_park_event('payment_confirmed', 'orders', 'tamper_1', null, 'no_order', '{}')", 'acc_s6_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s6_baseline', 'acc_s6_existing_dml_allowlist'],
    ["update pg_temp.accounting_s6_baseline set payload = payload - 'allowlist_md5'", 'acc_s6_existing_dml_allowlist'],
    ["update pg_temp.accounting_s6_baseline set payload = jsonb_set(payload, '{g_slip_facts}', '5')", 'acc_s6_existing_dml_allowlist'],
  ])('FREQ-569-AC-01: S6改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });

  test('FREQ-563-AC-03: S6末尾assertは囲みの外の1字の改ざんを断り、別の番号の囲み（ACC_P3）を足した本文は通す', async () => {
    const addP3 = `do $x$ declare d text; begin
      d := pg_get_functiondef('${confirm}'::regprocedure);
      d := replace(d, E'v_previous_change text;\\nBEGIN\\n', E'v_previous_change text;\\nBEGIN\\n  -- ACC_P3_BEGIN\\n  PERFORM 1;\\n  -- ACC_P3_END\\n');
      execute d; end $x$`;
    expect(await attempt(addP3)).toBeNull();
    // One character of the original text between two blocks is not hidden by the removal.
    const addP3AndTamper = `do $x$ declare d text; begin
      d := pg_get_functiondef('${confirm}'::regprocedure);
      d := replace(d, E'v_previous_change text;\\nBEGIN\\n', E'v_previous_change text;\\nBEGIN\\n  -- ACC_P3_BEGIN\\n  PERFORM 1;\\n  -- ACC_P3_END\\n');
      d := replace(d, 'v_slip.expires_at <= pg_catalog.now()', 'v_slip.expires_at < pg_catalog.now()');
      d := replace(d, E'PERFORM private.lock_group_g_shipment_slips(', E'-- ACC_P4_BEGIN\\n  PERFORM 2;\\n  -- ACC_P4_END\\n  PERFORM private.lock_group_g_shipment_slips(');
      execute d; end $x$`;
    expect(await attempt(addP3AndTamper)).toEqual(failed('acc_s6_g_body_unchanged'));
  });
});

// ---- S7 (Task 2): the payment posting -------------------------------------------------------------------------------
const assertionS7 = accountingS7Section('FINAL_ASSERT');
const bodyS7 = accountingS7Section('BODY');
const detailsS7 = ['acc_s7_functions', 'acc_s7_function_attrs', 'acc_s7_existing_dml_allowlist'];
const statementsS7 = bodyS7.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const signatureS7 = 'private.accounting_post_payment_events(integer)';
const signatureFailureS7 = 'private.accounting_park_failure(text,text,text,uuid,text,text,text,date)';

describe('S7 source contract (no DB)', () => {
  test('FREQ-562-AC-01: S7はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S7_FILES).toEqual(['20261108160000_accounting_p2_payment_posting.sql']);
    expect(ACCOUNTING_S7_FILES[0] > ACCOUNTING_S6_FILES[0]).toBe(true);
    expect(sqlS7).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS7.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS7.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS7.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS7.trimEnd()).toMatch(/-- ACC_S7_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS7).not.toBe('');
    expect([...new Set([...assertionS7.matchAll(/'(acc_s7_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS7].sort());
    expect(assertionS7).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS7.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS7).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-562-AC-05: S7の実行時のDMLは比べる元の控えのINSERTだけで、関数は入口を持たず service_role にも渡さない', () => {
    expect([...statementsS7.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s7_baseline']);
    expect(bodyS7).toContain('REVOKE ALL ON FUNCTION private.accounting_post_payment_events(integer) FROM PUBLIC, anon, authenticated, service_role;');
    expect(bodyS7).not.toMatch(/GRANT EXECUTE/i);
    expect(bodyS7).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\./);
  });

  test('FREQ-562-AC-05: 係の本文は最初に accounting_lock_all(NULL) を取り、行ロックと orders.paid_at を使わず、出来事ごとの例外処理で包む', () => {
    const fn = bodyS7.split('CREATE FUNCTION private.accounting_post_payment_events(')[1]?.split('\n$$;')[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeGreaterThan(0);
    expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(fn.indexOf('FOR v_tx IN'));
    expect(fn).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
    expect(fn).not.toMatch(/paid_at/i);
    expect(fn.indexOf('EXCEPTION WHEN OTHERS')).toBeGreaterThan(fn.indexOf('private.accounting_period_for_event(v_date)'));
    expect(fn.indexOf('private.accounting_post_journal_core(')).toBeLessThan(fn.indexOf('EXCEPTION WHEN OTHERS'));
    // The mapping from the exception to the parked row is the shared helper; the text of the exception is only handed to it.
    expect(fn).toContain('v_parked := private.accounting_park_failure(');
    expect(fn).toContain('IF v_parked THEN');
    expect(fn).not.toMatch(/PG_EXCEPTION_CONTEXT/);
    expect(fn).not.toMatch(/'(?:message|detail|context)'/);
    expect(fn).toContain('_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())');
    expect(fn).toContain("private.accounting_event_key('payment_confirmed', ARRAY[t.payment_intent_id])");
    expect(fn).not.toContain("'payment_confirmed:' ||");
  });

  test('FREQ-569-AC-06: 失敗の保留の道具は例外を出す文を持たず、例外の文を保存せず、owner だけが呼べる', () => {
    const fn = bodyS7.split('CREATE FUNCTION private.accounting_park_failure(')[1]?.split('\n$$;')[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).not.toMatch(/RAISE|SQLERRM|PG_EXCEPTION_CONTEXT|PG_EXCEPTION_DETAIL/);
    expect(fn).toContain('EXCEPTION WHEN OTHERS');
    // _message is compared twice and only handed on when it is a fixed code (declaration, one comparison, the regex test, the value).
    expect(fn.match(/_message/g)).toHaveLength(4);
    expect(bodyS7).toContain('REVOKE ALL ON FUNCTION private.accounting_park_failure(text,text,text,uuid,text,text,text,date) FROM PUBLIC, anon, authenticated, service_role;');
    // The comment above it says it must not raise (an error there aborts the whole batch).
    expect(bodyS7).toMatch(/MUST NOT RAISE[\s\S]*CREATE FUNCTION private\.accounting_park_failure/);
  });

  test('FREQ-562-AC-01: S7の説明の日本語は ACCOUNTING_LABELS の語の出力と同じ', () => {
    const literals = [...bodyS7.matchAll(/U&'(?:[^']|'')*'/g)].map((m) => m[0]);
    expect(literals).toEqual(["U&'\\652F\\6255\\3044\\306E\\53D7\\3051\\53D6\\308A\\FF08\\524D\\53D7\\91D1\\FF09'"]);
  });
});

describeLocalDb('S7 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s7_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS7Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS7);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s7_assert'); await db().query('release savepoint acc_s7_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature = signatureS7) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;

  test('FREQ-562-AC-05: S7末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS7).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s7_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS7Baseline(db());
    await db().query(assertionS7);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s7_search_path');
  });

  test('FREQ-562-AC-05: 後の Task が足す public の accounting_run_posting があっても S7 末尾assertは再生で通る', async () => {
    expect(await attempt(`create or replace function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select '{}'::jsonb $$`)).toBeNull();
  });

  test('FREQ-562-AC-05: S7末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s7_existing_dml_allowlist'));
  });

  test.each([
    ['drop function private.accounting_post_payment_events(integer)', 'acc_s7_functions'],
    ['create function private.accounting_post_payment_events(a integer, b integer) returns jsonb language sql as $$ select null::jsonb $$', 'acc_s7_functions'],
    [edit('PERFORM private.accounting_lock_all(NULL);', 'PERFORM 1;'), 'acc_s7_functions'],
    [edit("'2150'", "'2151'"), 'acc_s7_functions'],
    [edit("'1160'", "'1161'"), 'acc_s7_functions'],
    [edit('private.accounting_period_for_event(v_date)', "private.accounting_period_for(v_date, 'soleProprietor')"), 'acc_s7_functions'],
    [edit('private.accounting_jst_date(v_tx.stripe_created_at)', '(SELECT o.paid_at::date FROM public.orders AS o WHERE o.id = v_order_id)'), 'acc_s7_functions'],
    [edit('FROM public.orders AS o WHERE o.id = v_tx.order_id;', 'FROM public.orders AS o WHERE o.id = v_tx.order_id FOR SHARE;'), 'acc_s7_functions'],
    [edit('EXCEPTION WHEN OTHERS THEN', 'EXCEPTION WHEN no_data_found THEN'), 'acc_s7_functions'],
    [edit('_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())', '_source_recorded_at => NULL'), 'acc_s7_functions'],
    [edit("private.accounting_park_failure('payment_confirmed',", "private.accounting_park_event('payment_confirmed',"), 'acc_s7_functions'],
    [edit('IF v_parked THEN', 'IF true THEN'), 'acc_s7_functions'],
    [`drop function ${signatureFailureS7}; create function private.accounting_park_failure(_kind text, _source_table text, _source_id text, _order_id uuid, _sqlstate text, _message text, _pg_detail text, _entry_date date) returns void language plpgsql security definer set search_path = '' as $$ begin null; end $$`, 'acc_s7_functions'],
    [`drop function ${signatureFailureS7}`, 'acc_s7_functions'],
    [edit('EXCEPTION WHEN OTHERS THEN', 'EXCEPTION WHEN no_data_found THEN', signatureFailureS7), 'acc_s7_functions'],
    [edit('RETURN false;\n    END;', 'RAISE EXCEPTION \'X\';\n    END;', signatureFailureS7), 'acc_s7_functions'],
    [edit("_message ~ '^(ACCOUNTING", "SQLERRM ~ '^(ACCOUNTING", signatureFailureS7), 'acc_s7_functions'],
    [`grant execute on function ${signatureFailureS7} to service_role`, 'acc_s7_function_attrs'],
    [`grant execute on function ${signatureFailureS7} to public`, 'acc_s7_function_attrs'],
    [`alter function ${signatureFailureS7} security invoker`, 'acc_s7_function_attrs'],
    [`alter function ${signatureFailureS7} set search_path = public`, 'acc_s7_function_attrs'],
    ['grant execute on function private.accounting_post_payment_events(integer) to service_role', 'acc_s7_function_attrs'],
    ['grant execute on function private.accounting_post_payment_events(integer) to anon', 'acc_s7_function_attrs'],
    ['grant execute on function private.accounting_post_payment_events(integer) to authenticated', 'acc_s7_function_attrs'],
    ['grant execute on function private.accounting_post_payment_events(integer) to public', 'acc_s7_function_attrs'],
    ['alter function private.accounting_post_payment_events(integer) security invoker', 'acc_s7_function_attrs'],
    ['alter function private.accounting_post_payment_events(integer) stable', 'acc_s7_function_attrs'],
    ['alter function private.accounting_post_payment_events(integer) set search_path = public', 'acc_s7_function_attrs'],
    ['alter function private.accounting_post_payment_events(integer) reset search_path', 'acc_s7_function_attrs'],
    ['alter function private.accounting_post_payment_events(integer) strict', 'acc_s7_function_attrs'],
    [`create function public.accounting_post_payment_events(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select private.accounting_post_payment_events(_limit) $$`, 'acc_s7_function_attrs'],
    ["select private.accounting_park_event('payment_confirmed', 'orders', 'tamper_s7_1', null, 'no_order', '{}')", 'acc_s7_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s7_baseline', 'acc_s7_existing_dml_allowlist'],
    ["update pg_temp.accounting_s7_baseline set payload = payload - 'periods'", 'acc_s7_existing_dml_allowlist'],
    ["update pg_temp.accounting_s7_baseline set payload = jsonb_set(payload, '{entries}', '5')", 'acc_s7_existing_dml_allowlist'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'tamper', '2026-01-01', '2026-12-31')", 'acc_s7_existing_dml_allowlist'],
  ])('FREQ-562-AC-05: S7改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// ---- S8 (Task 3): the shipment posting ------------------------------------------------------------------------------
const assertionS8 = accountingS8Section('FINAL_ASSERT');
const bodyS8 = accountingS8Section('BODY');
const baselineS8 = accountingS8Section('BASELINE');
const detailsS8 = ['acc_s8_functions', 'acc_s8_function_attrs', 'acc_s8_reads_stable', 'acc_s8_g_untouched', 'acc_s8_existing_dml_allowlist'];
const statementsS8 = bodyS8.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const signaturePost = 'private.accounting_post_shipment_events(integer)';
const signaturePlan = 'private.accounting_shipment_plan(uuid,bigint)';
const signatureReason = 'private.accounting_shipment_date_reason(uuid,date)';
const functionBody = (name: string) => bodyS8.split(`CREATE FUNCTION ${name}(`)[1]?.split('\n$$;')[0] ?? '';

describe('S8 source contract (no DB)', () => {
  test('FREQ-563-AC-04: S8はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S8_FILES).toEqual(['20261108170000_accounting_p2_shipment_posting.sql']);
    expect(ACCOUNTING_S8_FILES[0] > ACCOUNTING_S7_FILES[0]).toBe(true);
    expect(sqlS8).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS8.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS8.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS8.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS8.trimEnd()).toMatch(/-- ACC_S8_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS8).not.toBe('');
    expect([...new Set([...assertionS8.matchAll(/'(acc_s8_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS8].sort());
    expect(assertionS8).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS8.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS8).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-563-AC-06: S8の実行時のDMLは比べる元の控えのINSERTだけで、係・計画・日の検査は入口を持たず service_role にも渡さない', () => {
    expect([...statementsS8.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s8_baseline']);
    expect(bodyS8).toContain('private.accounting_shipment_date_reason(uuid,date), private.accounting_shipment_plan(uuid,bigint),\n  private.accounting_shipment_single_order(uuid), private.accounting_post_shipment_events(integer),');
    // The only EXECUTE for service_role is on the two reads, private and public.
    const grants = [...bodyS8.matchAll(/GRANT EXECUTE ON FUNCTION([\s\S]*?)TO service_role;/g)];
    expect(grants).toHaveLength(1);
    expect(grants[0][1].replace(/\([^)]*\)/g, '').split(',').map((name) => name.trim()).sort()).toEqual([
      'private.get_shipment_journal_trace', 'private.list_journal_shipment_meta',
      'public.get_shipment_journal_trace', 'public.list_journal_shipment_meta']);
    expect(bodyS8).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.accounting_/);
    // No group G object is changed by this file.
    expect(statementsS8).not.toMatch(/(?:CREATE OR REPLACE FUNCTION|ALTER FUNCTION)\s+\S*(?:admin_confirm_shipment_slip|admin_cancel_shipment_slip|admin_correct_shipment_date|list_shipment_accounting_inputs)/);
    expect(statementsS8).not.toMatch(/ALTER TABLE\s+public\.(?:shipment_|order_fulfillment)/i);
    expect(statementsS8).not.toMatch(/(?:CREATE|DROP)\s+TRIGGER/i);
  });

  test('FREQ-563-AC-06: 係の本文は最初に accounting_lock_all(NULL) を取り、行ロックと注文の状態・支払いの時刻を使わず、出来事ごとの例外処理で包む', () => {
    const fn = functionBody('private.accounting_post_shipment_events');
    expect(fn).not.toBe('');
    expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeGreaterThan(0);
    expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(fn.indexOf('FOR v_swept IN'));
    expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(fn.indexOf('FOR v_job IN'));
    expect(fn).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
    expect(fn).not.toMatch(/paid_at|public\.orders\b/i);
    // The date correction checks the new day before it touches the live entry, and both halves sit in the one block.
    const redate = fn.slice(fn.indexOf("ELSIF v_job.task = 'redate' THEN"), fn.lastIndexOf('EXCEPTION WHEN OTHERS'));
    expect(redate.indexOf('private.accounting_shipment_date_reason(')).toBeLessThan(redate.indexOf('private.accounting_reverse_journal_core('));
    expect(redate.indexOf('private.accounting_reverse_journal_core(')).toBeLessThan(redate.indexOf("private.accounting_post_journal_core(NULL, v_period, v_date, 'shipment_redated',"));
    // One block per event, and one around each closing of a parked row in the sweep (a row that cannot be closed is skipped).
    expect(fn.match(/EXCEPTION WHEN OTHERS/g)).toHaveLength(2);
    expect(fn.indexOf('EXCEPTION WHEN OTHERS')).toBeLessThan(fn.indexOf('FOR v_job IN'));
    // New events: cancellations first, so a re-shipment in the same call finds the deferred revenue back.
    expect(fn).toContain("(SELECT 'cancel'::text, 0, 1, s.id");
    expect(fn).toContain('0 AS lane, 2 AS phase');
    expect(fn).toContain("(SELECT 'redate'::text, 0, 3, s.id");
    expect(fn).toContain('v_parked := private.accounting_park_failure(v_kind, v_table, v_source_id, v_order_id,');
    expect(fn).toContain('IF v_parked THEN');
    expect(fn).not.toMatch(/PG_EXCEPTION_CONTEXT/);
    expect(fn).not.toMatch(/'(?:message|context)'/);
    expect(fn).toContain('_source_recorded_at => LEAST(v_slip.confirmed_at, pg_catalog.clock_timestamp())');
    expect(fn).toContain('LEAST(v_slip.cancelled_at, pg_catalog.clock_timestamp())');
    expect(fn).toContain('_source_recorded_at => LEAST(v_hist.created_at, pg_catalog.clock_timestamp())');
    expect(fn).toContain("private.accounting_event_key('shipment_confirmed', ARRAY[s.number])");
    expect(fn).toContain("private.accounting_event_key('shipment_redated', ARRAY[h.id::text])");
    expect(fn).not.toContain("'shipment_confirmed:' ||");
  });

  test('FREQ-563-AC-01: 着の選び方と額の計算は計画の関数の1か所にあり、確定だけがそれを使う（日の直しは元の行と着を写す）', () => {
    const plan = functionBody('private.accounting_shipment_plan');
    expect(plan).toContain('private.accounting_shipped_units(v_item.order_item_id, _confirm_seq)');
    expect(plan).toContain('a.fact_seq < _confirm_seq');
    expect(plan).toContain("v_item.line_kind <> 'order'");
    expect(plan).not.toMatch(/paid_at|public\.orders\b/i);
    const post = functionBody('private.accounting_post_shipment_events');
    expect(post.match(/private\.accounting_shipment_plan\(/g)).toHaveLength(1);
    expect(post).not.toContain('private.accounting_shipped_units(');
    // The date correction copies the units of the entry it replaces.
    expect(post).toContain('FROM public.accounting_shipment_units AS u WHERE u.entry_id = v_entry.id');
  });

  test('FREQ-563-AC-04: 比べる元の控えの指紋と末尾assertの指紋は同じ文（文が離れていかない）', () => {
    const digest = (text: string) => text.match(/SELECT 'tab:'[\s\S]*?\)\s*AS x/)?.[0].replace(/\s+/g, ' ') ?? '';
    expect(digest(baselineS8)).not.toBe('');
    expect(digest(assertionS8)).toBe(digest(baselineS8));
    expect(bodyS8).toContain('-- ACC_S8_BASELINE_BEGIN\n');
  });

  test('FREQ-564-AC-01: S8の説明の日本語は ACCOUNTING_LABELS の語の出力と同じ', () => {
    const literals = [...bodyS8.matchAll(/U&'(?:[^']|'')*'/g)].map((m) => m[0]);
    expect([...new Set(literals)].sort()).toEqual([
      "U&' \\00D7 '",
      "U&'\\51FA\\8377\\306B\\3088\\308B\\58F2\\4E0A'",
      "U&'\\51FA\\8377\\306E\\53D6\\308A\\6D88\\3057'"].sort());
  });
});

describeLocalDb('S8 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s8_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS8Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS8);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s8_assert'); await db().query('release savepoint acc_s8_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature = signaturePost) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;

  test('FREQ-563-AC-04: S8末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS8).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    // The fingerprint does not depend on the search_path of the session that took the baseline.
    await db().query('savepoint acc_s8_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS8Baseline(db());
    await db().query("set local search_path = ''");
    await db().query(assertionS8);
    await db().query('rollback to savepoint acc_s8_search_path');
  });

  test('FREQ-563-AC-04: 後の Task が足す public の accounting_run_posting と accounting_* の関数があっても S8 末尾assertは再生で通る', async () => {
    expect(await attempt(`create or replace function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select '{}'::jsonb $$`)).toBeNull();
    expect(await attempt(`create function private.accounting_post_stripe_shipment_events(_limit integer) returns jsonb language sql volatile
      security definer set search_path = '' as $$ select '{}'::jsonb $$`)).toBeNull();
  });

  test('FREQ-563-AC-04: S8末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s8_existing_dml_allowlist'));
  });

  test.each([
    ['drop function private.accounting_post_shipment_events(integer)', 'acc_s8_functions'],
    ['create function private.accounting_post_shipment_events(a integer, b integer) returns jsonb language sql as $$ select null::jsonb $$', 'acc_s8_functions'],
    [edit('PERFORM private.accounting_lock_all(NULL);', 'PERFORM 1;'), 'acc_s8_functions'],
    [edit('private.accounting_reverse_journal_core(NULL, v_entry.id,', 'private.accounting_reverse_journal_core(NULL, v_existing,'), 'acc_s8_functions'],
    [edit("private.accounting_post_journal_core(NULL, v_period, v_date, 'shipment_redated',", "private.accounting_post_journal_core(NULL, v_period, v_date, 'shipment_confirmed',"), 'acc_s8_functions'],
    [edit('private.accounting_shipment_plan(v_slip.id, v_seq)', 'private.accounting_shipment_plan(v_slip.id, 0)'), 'acc_s8_functions'],
    [edit("v_reason := 'dispute_withdrawal_missing';", 'v_reason := NULL;'), 'acc_s8_functions'],
    [edit("'waiting_on', 'dispute_withdrawn'", "'waiting_on', 'x'"), 'acc_s8_functions'],
    [edit("pb.reason = 'before_cutover'", "pb.reason = 'no_order'"), 'acc_s8_functions'],
    [edit('private.accounting_g_fact_seq_at(t.stripe_created_at) < v_seq', 'private.accounting_g_fact_seq_at(t.stripe_created_at) <= v_seq'), 'acc_s8_functions'],
    [edit('private.accounting_period_for_event(v_date)', "private.accounting_period_for(v_date, 'soleProprietor')"), 'acc_s8_functions'],
    [edit('_source_recorded_at => LEAST(v_slip.confirmed_at, pg_catalog.clock_timestamp())', '_source_recorded_at => NULL'), 'acc_s8_functions'],
    [edit('LEAST(v_slip.cancelled_at, pg_catalog.clock_timestamp())', 'NULL'), 'acc_s8_functions'],
    [edit('_source_recorded_at => LEAST(v_hist.created_at, pg_catalog.clock_timestamp())', '_source_recorded_at => NULL'), 'acc_s8_functions'],
    [edit('EXCEPTION WHEN OTHERS THEN', 'EXCEPTION WHEN no_data_found THEN'), 'acc_s8_functions'],
    [edit('IF v_parked THEN', 'IF true THEN'), 'acc_s8_functions'],
    [edit('v_parked := private.accounting_park_failure(v_kind,', "v_parked := private.accounting_park_failure('shipment_confirmed',"), 'acc_s8_functions'],
    [edit('FROM public.shipment_slips AS s WHERE s.id = v_job.slip_id;', 'FROM public.shipment_slips AS s WHERE s.id = v_job.slip_id FOR UPDATE;'), 'acc_s8_functions'],
    [edit('v_date := v_slip.shipment_date;', 'v_date := (SELECT o.paid_at::date FROM public.orders AS o LIMIT 1);'), 'acc_s8_functions'],
    [edit('private.accounting_shipped_units(v_item.order_item_id, _confirm_seq)', 'private.accounting_shipped_units(v_item.order_item_id, NULL)', signaturePlan), 'acc_s8_functions'],
    [edit('a.fact_seq < _confirm_seq', 'a.fact_seq <= _confirm_seq', signaturePlan), 'acc_s8_functions'],
    [edit("'4010'", "'4011'", signaturePlan), 'acc_s8_functions'],
    [edit("v_item.line_kind <> 'order'", 'false', signaturePlan), 'acc_s8_functions'],
    [edit('v_order_count := 0;', "v_order_count := (SELECT pg_catalog.count(*) FROM public.orders AS o WHERE o.status = 'paid')::integer;", signaturePlan), 'acc_s8_functions'],
    [edit("'before_cutover'", "'before_cut'", signatureReason), 'acc_s8_functions'],
    [`drop function ${signatureReason}`, 'acc_s8_functions'],
    ['grant execute on function private.accounting_post_shipment_events(integer) to service_role', 'acc_s8_function_attrs'],
    ['grant execute on function private.accounting_post_shipment_events(integer) to anon', 'acc_s8_function_attrs'],
    ['grant execute on function private.accounting_post_shipment_events(integer) to authenticated', 'acc_s8_function_attrs'],
    ['grant execute on function private.accounting_post_shipment_events(integer) to public', 'acc_s8_function_attrs'],
    ['alter function private.accounting_post_shipment_events(integer) security invoker', 'acc_s8_function_attrs'],
    ['alter function private.accounting_post_shipment_events(integer) stable', 'acc_s8_function_attrs'],
    ['alter function private.accounting_post_shipment_events(integer) set search_path = public', 'acc_s8_function_attrs'],
    ['alter function private.accounting_post_shipment_events(integer) strict', 'acc_s8_function_attrs'],
    [`grant execute on function ${signaturePlan} to service_role`, 'acc_s8_function_attrs'],
    [`alter function ${signaturePlan} volatile`, 'acc_s8_function_attrs'],
    [`grant execute on function ${signatureReason} to authenticated`, 'acc_s8_function_attrs'],
    ['grant execute on function private.accounting_shipment_single_order(uuid) to service_role', 'acc_s8_function_attrs'],
    ['drop function private.accounting_shipment_single_order(uuid)', 'acc_s8_function_attrs'],
    ["create function public.accounting_shipment_plan(a uuid, b bigint) returns jsonb language sql security invoker set search_path = '' as $$ select private.accounting_shipment_plan(a, b) $$", 'acc_s8_function_attrs'],
    ['revoke execute on function public.get_shipment_journal_trace(uuid) from service_role', 'acc_s8_function_attrs'],
    ['revoke execute on function private.list_journal_shipment_meta(uuid[]) from service_role', 'acc_s8_function_attrs'],
    ['grant execute on function public.get_shipment_journal_trace(uuid) to anon', 'acc_s8_function_attrs'],
    ['grant execute on function public.list_journal_shipment_meta(uuid[]) to authenticated', 'acc_s8_function_attrs'],
    ['grant execute on function private.get_shipment_journal_trace(uuid) to public', 'acc_s8_function_attrs'],
    ['alter function public.list_journal_shipment_meta(uuid[]) security definer', 'acc_s8_function_attrs'],
    ['alter function public.get_shipment_journal_trace(uuid) volatile', 'acc_s8_function_attrs'],
    ['alter function private.get_shipment_journal_trace(uuid) set search_path = public', 'acc_s8_function_attrs'],
    [edit('RETURN pg_catalog.jsonb_build_object(', 'PERFORM 1; RETURN pg_catalog.jsonb_build_object(', 'private.get_shipment_journal_trace(uuid)'), 'acc_s8_reads_stable'],
    [edit('RETURN QUERY', 'DELETE FROM public.accounting_pending_events WHERE false; RETURN QUERY', 'private.list_journal_shipment_meta(uuid[])'), 'acc_s8_reads_stable'],
    ['alter table public.shipment_slips add column tamper_s8 integer', 'acc_s8_g_untouched'],
    ['alter table public.order_fulfillments alter column notify_customer drop not null', 'acc_s8_g_untouched'],
    ['alter table public.shipment_slip_lines drop constraint shipment_slip_lines_quantity_check', 'acc_s8_g_untouched'],
    ['alter table public.shipment_slips disable trigger user', 'acc_s8_g_untouched'],
    ['create trigger tamper_s8 before insert on public.shipment_slip_lines for each row execute function private.reject_accounting_mutation()', 'acc_s8_g_untouched'],
    [`do $x$ declare d text; begin d := pg_get_functiondef('private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)'::regprocedure);
      execute replace(d, 'GROUP_G_SLIP_REASON_REQUIRED', 'GROUP_G_SLIP_REASON_NEEDED'); end $x$`, 'acc_s8_g_untouched'],
    [`do $x$ declare d text; begin d := pg_get_functiondef('private.list_shipment_accounting_inputs(date,date,integer)'::regprocedure);
      execute replace(d, 'LIMIT _limit', 'LIMIT _limit + 1'); end $x$`, 'acc_s8_g_untouched'],
    ['drop function private.list_shipment_accounting_inputs(date,date,integer)', 'acc_s8_g_untouched'],
    ["create function public.tamper_shipment_s8() returns integer language sql as 'select 1'", 'acc_s8_g_untouched'],
    ["select private.accounting_park_event('shipment_confirmed', 'shipment_slips', 'tamper_s8_1', null, 'no_order', '{}')", 'acc_s8_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s8_baseline', 'acc_s8_existing_dml_allowlist'],
    ["update pg_temp.accounting_s8_baseline set payload = payload - 'shipment_units'", 'acc_s8_existing_dml_allowlist'],
    ["update pg_temp.accounting_s8_baseline set payload = payload - 'g_digest'", 'acc_s8_existing_dml_allowlist'],
    ["update pg_temp.accounting_s8_baseline set payload = jsonb_set(payload, '{entries}', '5')", 'acc_s8_existing_dml_allowlist'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'tamper', '2026-01-01', '2026-12-31')", 'acc_s8_existing_dml_allowlist'],
  ])('FREQ-563-AC-04: S8改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// ---- S9 (Task 4): the Stripe fee, tax adjustment, payout, arrival, payout failure, top-up and reconciliation ---------------
const assertionS9 = accountingS9Section('FINAL_ASSERT');
const bodyS9 = accountingS9Section('BODY');
const detailsS9 = ['acc_s9_tables', 'acc_s9_functions', 'acc_s9_function_attrs', 'acc_s9_rls_acl', 'acc_s9_reads_stable', 'acc_s9_category_map',
  'acc_s9_existing_dml_allowlist'];
const statementsS9 = bodyS9.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const lanes = ['fee', 'tax_adjustment', 'payout', 'bank', 'payout_failure'];
const laneSignature = (lane: string) => `private.accounting_post_stripe_${lane}_events(integer)`;
const runnerS9 = 'private.accounting_post_stripe_events(integer)';
const topupS9 = 'private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid)';
const invoiceS9 = 'private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid)';
const feeReadS9 = 'private.get_stripe_fee_reconciliation(text)';
const balanceReadS9 = 'private.get_stripe_balance_reconciliation(date)';
const kindMapS9 = 'private.accounting_stripe_category_kind(text,text)';
const functionBodyS9 = (name: string) => bodyS9.split(`CREATE FUNCTION ${name}(`)[1]?.split('\n$$;')[0] ?? '';

describe('S9 source contract (no DB)', () => {
  test('FREQ-565-AC-01: S9はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S9_FILES).toEqual(['20261108180000_accounting_p2_stripe_posting.sql']);
    expect(ACCOUNTING_S9_FILES[0] > ACCOUNTING_S8_FILES[0]).toBe(true);
    expect(sqlS9).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS9.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS9.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS9.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS9.trimEnd()).toMatch(/-- ACC_S9_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS9).not.toBe('');
    expect([...new Set([...assertionS9.matchAll(/'(acc_s9_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS9].sort());
    expect(assertionS9).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS9.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS9).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-565-AC-01: S9の実行時のDMLは比べる元の控えのINSERTだけで、係は入口を持たず、service_role に渡すのは書き口2つと読み口2つ（private と public）だけ', () => {
    expect([...statementsS9.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s9_baseline']);
    const grant = bodyS9.split('GRANT EXECUTE ON FUNCTION')[1]?.split(';')[0] ?? '';
    expect(grant.match(/(private|public)\.[a-z_]+\(/g)?.sort()).toEqual([
      'private.admin_record_balance_topup(', 'private.admin_set_stripe_invoice_record(', 'private.get_stripe_balance_reconciliation(',
      'private.get_stripe_fee_reconciliation(', 'public.admin_record_balance_topup(', 'public.admin_set_stripe_invoice_record(',
      'public.get_stripe_balance_reconciliation(', 'public.get_stripe_fee_reconciliation(']);
    expect(grant).toContain('TO service_role');
    expect([...bodyS9.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]).sort()).toEqual([
      'admin_record_balance_topup', 'admin_set_stripe_invoice_record', 'get_stripe_balance_reconciliation', 'get_stripe_fee_reconciliation']);
  });

  test('FREQ-565-AC-01: 5つの係とその親は最初に accounting_lock_all(NULL) を取り、行ロックと orders.paid_at を使わず、出来事ごとに例外処理で包んで共通の保留の道具で止める', () => {
    for (const lane of lanes) {
      const fn = functionBodyS9(`private.accounting_post_stripe_${lane}_events`);
      expect(fn).not.toBe('');
      expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeGreaterThan(0);
      expect(fn.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(fn.indexOf('FOR v_'));
      expect(fn).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
      expect(fn).not.toMatch(/public\.orders|orders\.paid_at/);
      expect(fn.indexOf('EXCEPTION WHEN OTHERS')).toBeGreaterThan(fn.indexOf('private.accounting_period_for_event(v_date)'));
      expect(fn.indexOf('private.accounting_post_journal_core(')).toBeLessThan(fn.indexOf('EXCEPTION WHEN OTHERS'));
      expect(fn.match(/v_parked := private\.accounting_park_failure\(/g)).toHaveLength(1);
      expect(fn).toContain('IF v_parked THEN');
      expect(fn).not.toMatch(/PG_EXCEPTION_CONTEXT/);
      expect(fn).not.toMatch(/'(?:message|detail|context)'/);
      expect(fn).toContain('_source_recorded_at => LEAST(');
      // The key is always built by the one function (never by hand).
      expect(fn).toContain('private.accounting_event_key(');
      expect(fn).not.toMatch(/'(?:stripe:fee|payout_started|bank_arrived|payout_failed|stripe_tax_adjustment|stripe_fee)' \|\|/);
    }
    const runner = functionBodyS9('private.accounting_post_stripe_events');
    expect(runner.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeGreaterThan(0);
    expect(runner.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(runner.indexOf('v_fee := '));
    expect(runner).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
  });

  test('FREQ-565-AC-03: 手数料の係の候補は「手数料のある種類」と「種類が無い物」を1つの条件で拾い、飛ばす取引を条件で除いて古い順に_limit件まで取る', () => {
    const fee = functionBodyS9('private.accounting_post_stripe_fee_events');
    expect(fee).toContain("(k.kind IS NULL OR (k.kind <> 'tax_adjustment' AND private.accounting_stripe_fee_amount(k.kind, t.fee, t.net) <> 0))");
    expect(fee).toContain('ORDER BY t.stripe_created_at, t.id\n        LIMIT _limit)');
    expect(fee).toContain('LIMIT 10)');
    const failure = functionBodyS9('private.accounting_post_stripe_payout_failure_events');
    expect(failure).toContain("private.accounting_stripe_category_kind(t.type, t.reporting_category) = 'payout_failure' AND t.amount <> 0");
    const tax = functionBodyS9('private.accounting_post_stripe_tax_adjustment_events');
    expect(tax).toContain("private.accounting_stripe_category_kind(t.type, t.reporting_category) = 'tax_adjustment' AND t.net <> 0");
  });

  test('FREQ-565-AC-01: S9の説明の日本語は ACCOUNTING_LABELS の語の出力と同じ', () => {
    const wanted = ['stripeJapan', 'feePayment', 'feeDispute', 'feeFx', 'taxAdjustment', 'payoutStarted', 'bankArrived', 'payoutFailed', 'balanceTopup']
      .map((key) => encodeSqlUnicodeLiteral(ACCOUNTING_LABELS[key as keyof typeof ACCOUNTING_LABELS]));
    const code = bodyS9.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    const literals = [...new Set([...code.matchAll(/U&'(?:[^']|'')*'/g)].map((m) => m[0]))];
    expect(literals.sort()).toEqual([...wanted].sort());
  });

  test('FREQ-565-AC-03: 種類の対応は本文の中の `ACC_S9_CATEGORY_MAP` の印の間にあり、読み口は書き込みの文を持たない', () => {
    expect(accountingS9Section('CATEGORY_MAP')).toMatch(/^CREATE FUNCTION private\.accounting_stripe_category_kind\(_type text, _reporting_category text\) RETURNS text\n/);
    for (const read of ['private.get_stripe_fee_reconciliation', 'private.get_stripe_balance_reconciliation']) {
      expect(functionBodyS9(read)).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM|EXECUTE)\b/);
    }
  });
});

describeLocalDb('S9 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s9_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS9Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS9);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s9_assert'); await db().query('release savepoint acc_s9_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature: string) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;
  const zeroResult = '\'{"posted":0,"parked_new":0,"reparked":0,"resolved":0}\'::jsonb';

  test('FREQ-565-AC-01: S9末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS9).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s9_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS9Baseline(db());
    await db().query(assertionS9);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s9_search_path');
  });

  test('FREQ-565-AC-01: 後の Task が足す public の accounting_run_posting があっても S9 末尾assertは再生で通る', async () => {
    expect(await attempt(`create or replace function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select '{}'::jsonb $$`)).toBeNull();
  });

  test('FREQ-565-AC-01: S9末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s9_existing_dml_allowlist'));
  });

  test.each([
    // functions: existence and text
    ...lanes.map((lane) => [`drop function ${laneSignature(lane)}`, 'acc_s9_functions']),
    ...lanes.map((lane) => [`create function private.accounting_post_stripe_${lane}_events(a integer, b integer) returns jsonb language sql as $$ select null::jsonb $$`, 'acc_s9_functions']),
    [edit('PERFORM private.accounting_lock_all(NULL);', 'PERFORM 1;', laneSignature('fee')), 'acc_s9_functions'],
    [edit('PERFORM private.accounting_lock_all(NULL);', 'PERFORM 1;', laneSignature('payout_failure')), 'acc_s9_functions'],
    [edit('PERFORM private.accounting_lock_all(NULL);', 'PERFORM 1;', runnerS9), 'acc_s9_functions'],
    [edit("'6280'", "'6281'", laneSignature('fee')), 'acc_s9_functions'],
    [edit('tax_default_10', 'tax_default', laneSignature('fee')), 'acc_s9_functions'],
    [edit("'unknown_category'", "'posting_error'", laneSignature('fee')), 'acc_s9_functions'],
    [edit('private.accounting_period_for_event(v_date)', "private.accounting_period_for(v_date, 'soleProprietor')", laneSignature('tax_adjustment')), 'acc_s9_functions'],
    [edit("'1480'", "'1481'", laneSignature('tax_adjustment')), 'acc_s9_functions'],
    [edit('private.accounting_jst_date(v_row.paid_at)', "(v_row.paid_at AT TIME ZONE 'UTC')::date", laneSignature('payout')), 'acc_s9_functions'],
    [edit('v_date := v_row.bank_arrival_date;', 'v_date := CURRENT_DATE;', laneSignature('bank')), 'acc_s9_functions'],
    [edit('payout_net_zero', 'payout_netzero', laneSignature('payout_failure')), 'acc_s9_functions'],
    [edit('IF v_parked THEN', 'IF true THEN', laneSignature('payout_failure')), 'acc_s9_functions'],
    [edit('EXCEPTION WHEN OTHERS THEN', 'EXCEPTION WHEN no_data_found THEN', laneSignature('bank')), 'acc_s9_functions'],
    [edit('_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())', '_source_recorded_at => NULL', laneSignature('fee')), 'acc_s9_functions'],
    [edit("private.accounting_park_failure('payout_started',", "private.accounting_park_event('payout_started',", laneSignature('payout')), 'acc_s9_functions'],
    [edit('ORDER BY t.stripe_created_at, t.id\n        LIMIT _limit)', 'ORDER BY t.stripe_created_at, t.id\n        FOR UPDATE\n        LIMIT _limit)', laneSignature('fee')), 'acc_s9_functions'],
    [edit('v_payout := private.accounting_post_stripe_payout_events(_limit);', `v_payout := ${zeroResult};`, runnerS9), 'acc_s9_functions'],
    [edit("ARRAY['admin.finance.manage']", "ARRAY['admin.finance.view']", topupS9), 'acc_s9_functions'],
    [edit("'1040'", "'1030'", topupS9), 'acc_s9_functions'],
    [edit('ACCOUNTING_VERSION_CONFLICT', 'ACCOUNTING_VERSION_CHANGED', invoiceS9), 'acc_s9_functions'],
    [edit('private.accounting_entry_live(', 'private.accounting_entry_dead(', balanceReadS9), 'acc_s9_functions'],
    [edit("private.accounting_entry_live('payout_started', o.id)", 'true', laneSignature('bank')), 'acc_s9_functions'],
    // attributes and EXECUTE
    ...lanes.map((lane) => [`grant execute on function ${laneSignature(lane)} to service_role`, 'acc_s9_function_attrs']),
    [`grant execute on function ${runnerS9} to anon`, 'acc_s9_function_attrs'],
    [`grant execute on function ${runnerS9} to authenticated`, 'acc_s9_function_attrs'],
    [`grant execute on function ${runnerS9} to public`, 'acc_s9_function_attrs'],
    [`alter function ${runnerS9} security invoker`, 'acc_s9_function_attrs'],
    [`alter function ${runnerS9} stable`, 'acc_s9_function_attrs'],
    [`alter function ${runnerS9} set search_path = public`, 'acc_s9_function_attrs'],
    [`alter function ${laneSignature('fee')} reset search_path`, 'acc_s9_function_attrs'],
    [`alter function ${laneSignature('fee')} strict`, 'acc_s9_function_attrs'],
    [`create function public.accounting_post_stripe_events(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select private.accounting_post_stripe_events(_limit) $$`, 'acc_s9_function_attrs'],
    [`alter function ${kindMapS9} stable`, 'acc_s9_function_attrs'],
    ['alter function private.accounting_stripe_fee_amount(text,integer,integer) volatile', 'acc_s9_function_attrs'],
    ['grant execute on function private.accounting_entry_live(text,text) to service_role', 'acc_s9_function_attrs'],
    [`revoke execute on function ${topupS9} from service_role`, 'acc_s9_function_attrs'],
    ['revoke execute on function public.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid) from service_role', 'acc_s9_function_attrs'],
    ['grant execute on function public.get_stripe_fee_reconciliation(text) to anon', 'acc_s9_function_attrs'],
    ['grant execute on function public.get_stripe_balance_reconciliation(date) to authenticated', 'acc_s9_function_attrs'],
    ['alter function public.get_stripe_fee_reconciliation(text) security definer', 'acc_s9_function_attrs'],
    ['alter function public.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid) set search_path = public', 'acc_s9_function_attrs'],
    [`alter function ${feeReadS9} volatile`, 'acc_s9_function_attrs'],
    // reads stay reads
    [edit('v_diff := v_jst_total - v_utc_total;', 'PERFORM 1; v_diff := v_jst_total - v_utc_total;', feeReadS9), 'acc_s9_reads_stable'],
    [edit('v_has_invoice := FOUND;', 'v_has_invoice := FOUND; DELETE FROM public.accounting_pending_events WHERE false;', feeReadS9), 'acc_s9_reads_stable'],
    [edit('RETURN pg_catalog.jsonb_build_object(\'through\'', 'PERFORM 1; RETURN pg_catalog.jsonb_build_object(\'through\'', balanceReadS9), 'acc_s9_reads_stable'],
    // the map
    [edit("'tax_fee'", "'tax_feex'", kindMapS9), 'acc_s9_category_map'],
    [edit("'topup_reversal'", "'topup_reversal2'", kindMapS9), 'acc_s9_category_map'],
    [edit("_reporting_category IN ('charge')", "_reporting_category IN ('charge', 'other')", kindMapS9), 'acc_s9_category_map'],
    [edit('ELSE NULL', "ELSE 'unknown'", kindMapS9), 'acc_s9_category_map'],
    // the invoice table and its ACL
    ['alter table public.accounting_stripe_invoice_records add column tamper_s9 integer', 'acc_s9_tables'],
    ['alter table public.accounting_stripe_invoice_records drop constraint accounting_stripe_invoice_records_invoice_total_check', 'acc_s9_tables'],
    ['alter table public.accounting_stripe_invoice_records alter column document_ref set not null', 'acc_s9_tables'],
    ['alter table public.accounting_stripe_invoice_records alter column invoice_tax drop default', 'acc_s9_tables'],
    ['alter table public.accounting_stripe_invoice_records add constraint tamper_s9 check (invoice_total < 1000000)', 'acc_s9_tables'],
    ['alter table public.accounting_stripe_invoice_records disable row level security', 'acc_s9_rls_acl'],
    ['create policy tamper_s9 on public.accounting_stripe_invoice_records for select using (true)', 'acc_s9_rls_acl'],
    ['grant select on public.accounting_stripe_invoice_records to anon', 'acc_s9_rls_acl'],
    ['grant select on public.accounting_stripe_invoice_records to authenticated', 'acc_s9_rls_acl'],
    ['grant select on public.accounting_stripe_invoice_records to public', 'acc_s9_rls_acl'],
    ['grant insert on public.accounting_stripe_invoice_records to service_role', 'acc_s9_rls_acl'],
    ['grant update on public.accounting_stripe_invoice_records to service_role', 'acc_s9_rls_acl'],
    ['grant delete on public.accounting_stripe_invoice_records to service_role', 'acc_s9_rls_acl'],
    ['revoke select on public.accounting_stripe_invoice_records from service_role', 'acc_s9_rls_acl'],
    // no row written
    ["select private.accounting_park_event('stripe_fee', 'stripe_balance_transactions', 'tamper_s9_1', null, 'unknown_category', '{}')", 'acc_s9_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s9_baseline', 'acc_s9_existing_dml_allowlist'],
    ["update pg_temp.accounting_s9_baseline set payload = payload - 'invoice_records'", 'acc_s9_existing_dml_allowlist'],
    ["update pg_temp.accounting_s9_baseline set payload = jsonb_set(payload, '{entries}', '5')", 'acc_s9_existing_dml_allowlist'],
    ["insert into public.accounting_stripe_invoice_records (invoice_month, invoice_total) values ('2026-01', 1)", 'acc_s9_existing_dml_allowlist'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'tamper', '2026-01-01', '2026-12-31')", 'acc_s9_existing_dml_allowlist'],
  ] as Array<[string, string]>)('FREQ-565-AC-01: S9改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// ---- S10 (Task 5): the dispute intake (stripe_disputes, stripe_dispute_events, record_stripe_dispute) -----------------------
const assertionS10 = accountingS10Section('FINAL_ASSERT');
const bodyS10 = accountingS10Section('BODY');
const detailsS10 = ['acc_s10_tables', 'acc_s10_constraints', 'acc_s10_immutable', 'acc_s10_rls_acl', 'acc_s10_function_attrs',
  'acc_s10_existing_dml_allowlist'];
const statementsS10 = bodyS10.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const writerS10 = 'private.record_stripe_dispute(jsonb,jsonb)';
const publicWriterS10 = 'public.record_stripe_dispute(jsonb,jsonb)';
const guardS10 = 'private.stripe_disputes_guard_update()';

describe('S10 source contract (no DB)', () => {
  test('FREQ-567-AC-01: S10はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S10_FILES).toEqual(['20261108190000_accounting_p2_dispute_intake.sql']);
    expect(ACCOUNTING_S10_FILES[0] > ACCOUNTING_S9_FILES[0]).toBe(true);
    expect(sqlS10).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS10.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS10.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS10.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS10.trimEnd()).toMatch(/-- ACC_S10_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS10).not.toBe('');
    expect([...new Set([...assertionS10.matchAll(/'(acc_s10_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS10].sort());
    expect(assertionS10).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS10.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS10).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-567-AC-03: S10の実行時のDMLは比べる元の控えのINSERTだけで、service_role に渡す関数は書き口（private と public）の2つだけ', () => {
    expect([...statementsS10.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s10_baseline']);
    const grant = bodyS10.split('GRANT EXECUTE ON FUNCTION')[1]?.split(';')[0] ?? '';
    expect(grant.match(/(private|public)\.[a-z_]+\(/g)?.sort()).toEqual(['private.record_stripe_dispute(', 'public.record_stripe_dispute(']);
    expect(grant).toContain('TO service_role');
    expect([...bodyS10.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1])).toEqual(['record_stripe_dispute']);
    // The only table grant is SELECT to service_role; nothing is granted to anon or authenticated.
    const tableGrants = [...statementsS10.matchAll(/GRANT ([A-Z, ]+) ON TABLE ([\w., ]+) TO ([\w, ]+);/g)].map((m) => `${m[1]} ${m[3]}`);
    expect(tableGrants).toEqual(['SELECT service_role']);
    expect([...statementsS10.matchAll(/GRANT[^;]*;/g)].some((m) => /\b(anon|authenticated)\b/.test(m[0]))).toBe(false);
  });

  test('FREQ-567-AC-03: 書き口は会計の鍵も仕訳も触らず、履歴は鍵の重複を無視して足し、注文の番号を消さない', () => {
    const writer = bodyS10.split('CREATE FUNCTION private.record_stripe_dispute(')[1]?.split('\n$$;')[0] ?? '';
    expect(writer).not.toBe('');
    expect(writer).not.toMatch(/accounting_lock_all|accounting_post_journal|accounting_journal|accounting_pending|PG_EXCEPTION_CONTEXT/);
    expect(writer).toContain('ON CONFLICT (stripe_event_id) DO NOTHING');
    expect(writer).toContain('order_id = COALESCE(EXCLUDED.order_id, public.stripe_disputes.order_id)');
    // The columns that never change are not in the update list.
    const update = writer.split('DO UPDATE SET')[1]?.split(';')[0] ?? '';
    expect(update).not.toMatch(/\b(amount|reason|charge_id|payment_intent_id|currency|stripe_created_at)\b/);
  });

  test('FREQ-567-AC-03: S10に日本語の文字列は無い（画面の語は後の Task が ACCOUNTING_LABELS から出す）', () => {
    const code = bodyS10.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/U&'/);
  });
});

describeLocalDb('S10 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s10_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS10Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS10);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s10_assert'); await db().query('release savepoint acc_s10_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature: string) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;

  test('FREQ-567-AC-03: S10末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS10).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s10_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS10Baseline(db());
    await db().query(assertionS10);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s10_search_path');
  });

  test('FREQ-567-AC-03: 後の Task が足す public の accounting_run_posting があっても S10 末尾assertは再生で通る', async () => {
    expect(await attempt(`create or replace function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
      security invoker set search_path = '' as $$ select '{}'::jsonb $$`)).toBeNull();
  });

  test('FREQ-567-AC-03: S10末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s10_existing_dml_allowlist'));
  });

  test.each([
    // tables
    ['alter table public.stripe_disputes add column tamper_s10 integer', 'acc_s10_tables'],
    ['alter table public.stripe_disputes alter column evidence_details drop default', 'acc_s10_tables'],
    ['alter table public.stripe_disputes alter column order_id set not null', 'acc_s10_tables'],
    ['alter table public.stripe_disputes alter column amount type integer', 'acc_s10_tables'],
    ['alter table public.stripe_dispute_events alter column balance_transaction_ids drop default', 'acc_s10_tables'],
    ['alter table public.stripe_dispute_events alter column stripe_event_created_at set not null', 'acc_s10_tables'],
    ['alter table public.stripe_dispute_events drop column created_at', 'acc_s10_tables'],
    ['alter table public.stripe_dispute_events rename column raw_payload to payload', 'acc_s10_tables'],
    // constraints
    ['alter table public.stripe_disputes drop constraint stripe_disputes_amount_check', 'acc_s10_constraints'],
    ['alter table public.stripe_disputes drop constraint stripe_disputes_id_check', 'acc_s10_constraints'],
    ['alter table public.stripe_disputes drop constraint stripe_disputes_status_check, add constraint stripe_disputes_status_check check (char_length(status) between 1 and 99)', 'acc_s10_constraints'],
    ['alter table public.stripe_disputes add constraint tamper_s10 check (amount < 100000000)', 'acc_s10_constraints'],
    ['alter table public.stripe_dispute_events drop constraint stripe_dispute_events_stripe_event_id_key', 'acc_s10_constraints'],
    ['alter table public.stripe_dispute_events drop constraint stripe_dispute_events_dispute_id_fkey, add constraint stripe_dispute_events_dispute_id_fkey foreign key (dispute_id) references public.stripe_disputes (id) on delete cascade', 'acc_s10_constraints'],
    ["alter table public.stripe_dispute_events add constraint tamper_s10 check (event_type <> 'x')", 'acc_s10_constraints'],
    ['drop index public.stripe_dispute_events_dispute_idx', 'acc_s10_constraints'],
    // immutable
    ['alter table public.stripe_dispute_events disable trigger stripe_dispute_events_no_update_delete', 'acc_s10_immutable'],
    ['alter table public.stripe_dispute_events enable trigger stripe_dispute_events_no_truncate', 'acc_s10_immutable'],
    ['alter table public.stripe_disputes disable trigger stripe_disputes_guard_update', 'acc_s10_immutable'],
    ['alter table public.stripe_disputes enable replica trigger stripe_disputes_no_delete', 'acc_s10_immutable'],
    ['drop trigger stripe_disputes_no_truncate on public.stripe_disputes', 'acc_s10_immutable'],
    ['drop trigger stripe_dispute_events_no_update_delete on public.stripe_dispute_events', 'acc_s10_immutable'],
    ['create trigger tamper_s10 before insert on public.stripe_disputes for each row execute function private.reject_accounting_mutation()', 'acc_s10_immutable'],
    [edit('NEW.amount IS DISTINCT FROM OLD.amount', 'false', guardS10), 'acc_s10_immutable'],
    [edit('NEW.stripe_created_at IS DISTINCT FROM OLD.stripe_created_at', 'false', guardS10), 'acc_s10_immutable'],
    [edit('NEW.reason IS DISTINCT FROM OLD.reason', 'NEW.reason IS DISTINCT FROM OLD.reason OR NEW.status IS DISTINCT FROM OLD.status', guardS10), 'acc_s10_immutable'],
    // rls and acl
    ['alter table public.stripe_disputes disable row level security', 'acc_s10_rls_acl'],
    ['alter table public.stripe_dispute_events disable row level security', 'acc_s10_rls_acl'],
    ['create policy tamper_s10 on public.stripe_disputes for select using (true)', 'acc_s10_rls_acl'],
    ['grant select on public.stripe_disputes to anon', 'acc_s10_rls_acl'],
    ['grant select on public.stripe_dispute_events to authenticated', 'acc_s10_rls_acl'],
    ['grant select on public.stripe_dispute_events to public', 'acc_s10_rls_acl'],
    ['grant insert on public.stripe_disputes to service_role', 'acc_s10_rls_acl'],
    ['grant update on public.stripe_dispute_events to service_role', 'acc_s10_rls_acl'],
    ['grant delete on public.stripe_disputes to service_role', 'acc_s10_rls_acl'],
    ['revoke select on public.stripe_disputes from service_role', 'acc_s10_rls_acl'],
    ['grant select (evidence_details) on public.stripe_disputes to authenticated', 'acc_s10_rls_acl'],
    // functions
    [`drop function ${publicWriterS10}`, 'acc_s10_function_attrs'],
    [`grant execute on function ${guardS10} to service_role`, 'acc_s10_function_attrs'],
    [`grant execute on function ${writerS10} to anon`, 'acc_s10_function_attrs'],
    [`grant execute on function ${writerS10} to authenticated`, 'acc_s10_function_attrs'],
    [`grant execute on function ${writerS10} to public`, 'acc_s10_function_attrs'],
    [`grant execute on function ${publicWriterS10} to anon`, 'acc_s10_function_attrs'],
    [`revoke execute on function ${writerS10} from service_role`, 'acc_s10_function_attrs'],
    [`revoke execute on function ${publicWriterS10} from service_role`, 'acc_s10_function_attrs'],
    [`alter function ${writerS10} security invoker`, 'acc_s10_function_attrs'],
    [`alter function ${publicWriterS10} security definer`, 'acc_s10_function_attrs'],
    [`alter function ${writerS10} stable`, 'acc_s10_function_attrs'],
    [`alter function ${writerS10} set search_path = public`, 'acc_s10_function_attrs'],
    [`alter function ${writerS10} strict`, 'acc_s10_function_attrs'],
    ['create function private.record_stripe_dispute(a jsonb) returns jsonb language sql as $$ select a $$', 'acc_s10_function_attrs'],
    [edit('ON CONFLICT (stripe_event_id) DO NOTHING', 'ON CONFLICT DO NOTHING', writerS10), 'acc_s10_function_attrs'],
    [edit('COALESCE(EXCLUDED.order_id, public.stripe_disputes.order_id)', 'EXCLUDED.order_id', writerS10), 'acc_s10_function_attrs'],
    [edit('is_charge_refundable = EXCLUDED.is_charge_refundable,', 'is_charge_refundable = EXCLUDED.is_charge_refundable,\n    amount = EXCLUDED.amount,', writerS10), 'acc_s10_function_attrs'],
    [edit('ACCOUNTING_ARGUMENT_INVALID', 'ACCOUNTING_ARGUMENT_BAD', writerS10), 'acc_s10_function_attrs'],
    [edit('WHERE public.stripe_disputes.synced_at <= EXCLUDED.synced_at', 'WHERE true', writerS10), 'acc_s10_function_attrs'],
    [edit('WHERE public.stripe_disputes.synced_at <= EXCLUDED.synced_at', 'WHERE public.stripe_disputes.synced_at >= EXCLUDED.synced_at', writerS10), 'acc_s10_function_attrs'],
    [edit('RETURN pg_catalog.jsonb_build_object', 'PERFORM private.accounting_lock_all(NULL); RETURN pg_catalog.jsonb_build_object', writerS10), 'acc_s10_function_attrs'],
    [edit('SELECT private.record_stripe_dispute(_dispute, _event)', 'SELECT private.record_stripe_dispute(_dispute, NULL)', publicWriterS10), 'acc_s10_function_attrs'],
    // no row written
    ["insert into public.stripe_disputes (id, amount, currency, reason, status, stripe_created_at) values ('dp_tamper', 1, 'jpy', 'general', 'x', now())", 'acc_s10_existing_dml_allowlist'],
    ["select private.accounting_park_event('stripe_fee', 'stripe_balance_transactions', 'tamper_s10_1', null, 'unknown_category', '{}')", 'acc_s10_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s10_baseline', 'acc_s10_existing_dml_allowlist'],
    ["update pg_temp.accounting_s10_baseline set payload = payload - 'dispute_events'", 'acc_s10_existing_dml_allowlist'],
    ["update pg_temp.accounting_s10_baseline set payload = jsonb_set(payload, '{disputes}', '5')", 'acc_s10_existing_dml_allowlist'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'tamper', '2026-01-01', '2026-12-31')", 'acc_s10_existing_dml_allowlist'],
  ] as Array<[string, string]>)('FREQ-567-AC-03: S10改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// ---- S11 (Task 6): the dispute posting, the settings, the holds and the posting entry point ---------------------------------------
const assertionS11 = accountingS11Section('FINAL_ASSERT');
const bodyS11 = accountingS11Section('BODY');
const detailsS11 = ['acc_s11_tables', 'acc_s11_functions', 'acc_s11_function_attrs', 'acc_s11_rls_acl', 'acc_s11_reads_stable',
  'acc_s11_run_posting', 'acc_s11_existing_dml_allowlist'];
const statementsS11 = bodyS11.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const posterS11 = 'private.accounting_post_dispute_events(integer)';
const runnerPrivateS11 = 'private.accounting_run_posting(integer)';
const runnerPublicS11 = 'public.accounting_run_posting(integer)';
const settingS11 = 'private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid)';
const assignS11 = 'private.admin_assign_dispute_confirmed(uuid,text,uuid)';
const functionBodyS11 = (name: string) => bodyS11.split(`CREATE FUNCTION ${name}(`)[1]?.split('\n$$;')[0] ?? '';

describe('S11 source contract (no DB)', () => {
  test('FREQ-568-AC-01: S11はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S11_FILES).toEqual(['20261108200000_accounting_p2_dispute_posting.sql']);
    expect(ACCOUNTING_S11_FILES[0] > ACCOUNTING_S10_FILES[0]).toBe(true);
    expect(sqlS11).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS11.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS11.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS11.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS11.trimEnd()).toMatch(/-- ACC_S11_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS11).not.toBe('');
    expect([...new Set([...assertionS11.matchAll(/'(acc_s11_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS11].sort());
    expect(assertionS11).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS11.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS11).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-568-AC-05: S11の実行時のDMLは比べる元の控えのINSERTだけで、service_role に渡す関数は書き口・読み口・入口の private と public だけ', () => {
    expect([...statementsS11.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s11_baseline']);
    const grant = bodyS11.split('GRANT EXECUTE ON FUNCTION')[1]?.split(';')[0] ?? '';
    const names = ['accounting_run_posting', 'admin_assign_dispute_confirmed', 'admin_set_dispute_account_setting', 'get_order_dispute_holds',
      'get_slip_dispute_holds', 'list_accounting_disputes', 'list_dispute_account_settings'];
    expect(grant.match(/(private|public)\.[a-z_]+\(/g)?.sort()).toEqual(
      [...names.map((n) => `private.${n}(`), ...names.map((n) => `public.${n}(`)].sort());
    expect(grant).toContain('TO service_role');
    expect([...bodyS11.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]).sort()).toEqual(names);
    const tableGrants = [...statementsS11.matchAll(/GRANT ([A-Z, ]+) ON TABLE ([\w., ]+) TO ([\w, ]+);/g)].map((m) => `${m[1]} ${m[3]}`);
    expect(tableGrants).toEqual(['SELECT service_role']);
    expect([...statementsS11.matchAll(/GRANT[^;]*;/g)].some((m) => /\b(anon|authenticated)\b/.test(m[0]))).toBe(false);
  });

  test('FREQ-568-AC-04: 係は最初に会計の鍵を取り、行の鍵を使わず、出来事ごとの失敗を共通の道具で保留にして、数えるのは保留できた時だけ', () => {
    const poster = functionBodyS11('private.accounting_post_dispute_events');
    expect(poster).not.toBe('');
    expect(poster.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeGreaterThan(0);
    expect(poster.indexOf('PERFORM private.accounting_lock_all(NULL);')).toBeLessThan(poster.indexOf('FOR v_job IN'));
    expect(poster).not.toMatch(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/);
    expect(poster).not.toMatch(/PG_EXCEPTION_CONTEXT/);
    expect(poster).toContain("private.accounting_park_failure('dispute_event', v_table, v_source_id, v_order_id, v_sqlstate, SQLERRM,");
    expect(poster).toContain('IF v_parked THEN');
    // The failure mapping is Task 2's: this file defines no mapping of its own.
    expect(statementsS11).not.toMatch(/CREATE FUNCTION private\.accounting_park_failure/);
    expect(poster).not.toMatch(/raw_payload|evidence_details/);
  });

  test('FREQ-568-AC-04: lostの時刻はStripeの時刻の最も古い物で、無い時だけ受けた時刻の最も古い物。Cが済んだ後の戻りは全部L', () => {
    const lostAt = functionBodyS11('private.accounting_dispute_lost_at');
    expect(lostAt).toContain('COALESCE(pg_catalog.min(e.stripe_event_created_at), pg_catalog.min(e.occurred_at))');
    expect(lostAt).toContain("e.status = 'lost'");
    const kind = functionBodyS11('private.accounting_dispute_reversal_kind');
    expect(kind.indexOf('accounting_dispute_confirmed_done')).toBeGreaterThan(0);
    expect(kind.indexOf('accounting_dispute_confirmed_done')).toBeLessThan(kind.indexOf('accounting_dispute_lost_at'));
    expect(kind).toContain('_created_at > v_lost');
  });

  test('FREQ-568-AC-03: 引かれた時の分け方と戻りの分け方は1つずつの関数で、割り振りと累計の式を使う', () => {
    expect(functionBodyS11('private.accounting_dispute_split_withdrawn')).toContain('private.accounting_allocate_amount(_amount, v_values)');
    const reversal = functionBodyS11('private.accounting_dispute_split_reversal');
    expect(reversal).toContain('pg_catalog.floor(v_s::numeric * v_bc / v_a)::bigint - pg_catalog.floor(v_s::numeric * v_bp / v_a)::bigint');
    expect(reversal).toContain('OVER (ORDER BY t.stripe_created_at, t.id)');
    const poster = functionBodyS11('private.accounting_post_dispute_events');
    expect((poster.match(/accounting_dispute_split_withdrawn\(/g) ?? []).length).toBe(1);
    expect((poster.match(/accounting_dispute_split_reversal\(/g) ?? []).length).toBe(1);
  });

  test('FREQ-568-AC-06: 読み口は申し立ての資料の写し・名前・住所を一切書かない', () => {
    for (const name of ['private.list_dispute_account_settings', 'private.accounting_dispute_json', 'private.list_accounting_disputes',
      'private.get_order_dispute_holds', 'private.get_slip_dispute_holds']) {
      const text = functionBodyS11(name);
      expect(text).not.toBe('');
      expect(text).not.toMatch(/raw_payload|evidence_details|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address/);
    }
  });

  test('FREQ-562-AC-05: 入口は4つの係を支払い・出荷・Stripe・取り消しの順に呼び、上限は1〜200、has_more は入れた件数と新しく止めた件数の合計', () => {
    const runner = functionBodyS11('private.accounting_run_posting');
    const order = ['accounting_post_payment_events(_limit)', 'accounting_post_shipment_events(_limit)', 'accounting_post_stripe_events(_limit)',
      'accounting_post_dispute_events(_limit)'].map((needle) => runner.indexOf(needle));
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(runner).toContain('_limit IS NULL OR _limit < 1 OR _limit > 200');
    expect(runner).not.toContain('accounting_lock_all');
    expect(bodyS11).toContain('CREATE FUNCTION public.accounting_run_posting(_limit integer DEFAULT 50) RETURNS jsonb\nLANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = \'\'');
  });

  test('FREQ-568-AC-05: 日本語の文字列は ACCOUNTING_LABELS の4語だけ（U&の形）で、移行にチャージバックの語は無い', () => {
    const code = bodyS11.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    const literals = [...code.matchAll(/U&'((?:[^']|'')*)'/g)].map((m) => m[0]);
    const allowed = new Set([ACCOUNTING_LABELS.disputeWithdrawn, ACCOUNTING_LABELS.disputeConfirmed, ACCOUNTING_LABELS.disputeReversal, ACCOUNTING_LABELS.disputeAssigned]
      .map((label) => encodeSqlUnicodeLiteral(label)));
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.every((literal) => allowed.has(literal))).toBe(true);
    expect(sqlS11).not.toMatch(/chargeback/i);
  });
});

describeLocalDb('S11 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s11_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS11Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS11);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s11_assert'); await db().query('release savepoint acc_s11_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature: string) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;

  test('FREQ-568-AC-05: S11末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS11).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s11_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS11Baseline(db());
    await db().query(assertionS11);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s11_search_path');
  });

  test('FREQ-568-AC-05: S11末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s11_existing_dml_allowlist'));
  });

  test('FREQ-562-AC-05: 入口は service_role だけが呼べ、anon と authenticated は呼べない', async () => {
    for (const signature of [runnerPrivateS11, runnerPublicS11, settingS11, assignS11, 'public.list_accounting_disputes(integer,timestamptz,text)',
      'public.get_order_dispute_holds(uuid[])', 'public.get_slip_dispute_holds(uuid)', 'public.list_dispute_account_settings()']) {
      const row = (await db().query(
        `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role, has_function_privilege('public', $1::regprocedure, 'EXECUTE') as public`,
        [signature])).rows[0];
      expect([signature, row]).toEqual([signature, { anon: false, authenticated: false, service_role: true, public: false }]);
    }
    for (const signature of [posterS11, 'private.accounting_dispute_lost_at(text)', 'private.accounting_dispute_split_withdrawn(uuid,bigint,bigint)']) {
      const row = (await db().query(
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role", [signature])).rows[0];
      expect([signature, row.service_role]).toEqual([signature, false]);
    }
  });

  test.each([
    // tables and triggers
    ['alter table public.accounting_dispute_account_settings add column tamper_s11 integer', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_account_settings alter column version drop default', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_account_settings drop constraint accounting_dispute_account_settings_reason_check', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_account_settings add constraint tamper_s11 check (version < 1000)', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_account_settings drop constraint accounting_dispute_account_settings_account_code_fkey', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_assignments drop constraint accounting_dispute_assignments_request_key_key', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_assignments drop constraint accounting_dispute_assignments_entry_id_fkey', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_assignments alter column request_hash drop not null', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_assignments disable trigger accounting_dispute_assignments_no_update_delete', 'acc_s11_tables'],
    ['alter table public.accounting_dispute_assignments enable replica trigger accounting_dispute_assignments_no_truncate', 'acc_s11_tables'],
    ['drop trigger accounting_dispute_assignments_no_truncate on public.accounting_dispute_assignments', 'acc_s11_tables'],
    ['create trigger tamper_s11 before insert on public.accounting_dispute_account_settings for each row execute function private.reject_accounting_mutation()', 'acc_s11_tables'],
    // rls and acl
    ['alter table public.accounting_dispute_account_settings disable row level security', 'acc_s11_rls_acl'],
    ['create policy tamper_s11 on public.accounting_dispute_assignments for select using (true)', 'acc_s11_rls_acl'],
    ['grant select on public.accounting_dispute_account_settings to anon', 'acc_s11_rls_acl'],
    ['grant select on public.accounting_dispute_assignments to authenticated', 'acc_s11_rls_acl'],
    ['grant insert on public.accounting_dispute_account_settings to service_role', 'acc_s11_rls_acl'],
    ['grant update on public.accounting_dispute_assignments to service_role', 'acc_s11_rls_acl'],
    ['revoke select on public.accounting_dispute_assignments from service_role', 'acc_s11_rls_acl'],
    // functions: owner, security, volatility, arguments, ACL
    [`grant execute on function ${posterS11} to service_role`, 'acc_s11_function_attrs'],
    [`grant execute on function ${runnerPrivateS11} to anon`, 'acc_s11_function_attrs'],
    [`grant execute on function ${runnerPublicS11} to authenticated`, 'acc_s11_function_attrs'],
    [`grant execute on function ${runnerPublicS11} to public`, 'acc_s11_function_attrs'],
    [`revoke execute on function ${runnerPublicS11} from service_role`, 'acc_s11_function_attrs'],
    [`revoke execute on function ${settingS11} from service_role`, 'acc_s11_function_attrs'],
    [`alter function ${runnerPublicS11} security definer`, 'acc_s11_function_attrs'],
    [`alter function ${runnerPrivateS11} security invoker`, 'acc_s11_function_attrs'],
    ['alter function public.list_accounting_disputes(integer,timestamptz,text) volatile', 'acc_s11_function_attrs'],
    ['alter function private.get_order_dispute_holds(uuid[]) volatile', 'acc_s11_function_attrs'],
    [`alter function ${assignS11} set search_path = public`, 'acc_s11_function_attrs'],
    [`alter function ${posterS11} strict`, 'acc_s11_function_attrs'],
    ['alter function public.get_slip_dispute_holds(uuid) security definer', 'acc_s11_function_attrs'],
    ['drop function public.get_slip_dispute_holds(uuid)', 'acc_s11_function_attrs'],
    ['create function public.accounting_dispute_cause(_r text) returns text language sql as $$ select _r $$', 'acc_s11_function_attrs'],
    // functions: the text keeps the rules
    [edit('PERFORM private.accounting_lock_all(NULL);', 'NULL;', posterS11), 'acc_s11_functions'],
    [edit('private.accounting_dispute_withdrawn_all_posted(', 'private.accounting_dispute_settled(', posterS11), 'acc_s11_functions'],
    [edit("p.reason = 'before_cutover'", "p.reason = 'no_revenue'", posterS11), 'acc_s11_functions'],
    ['alter function private.accounting_dispute_withdrawn_all_posted(text) volatile', 'acc_s11_function_attrs'],
    [`grant execute on function private.accounting_dispute_withdrawn_all_posted(text) to service_role`, 'acc_s11_function_attrs'],
    [edit('IF v_parked THEN', 'IF true THEN', posterS11), 'acc_s11_functions'],
    [edit('private.accounting_dispute_reversal_kind(', 'private.accounting_dispute_settled(', posterS11), 'acc_s11_functions'],
    [edit("'dispute_shipment_pending'", "'dispute_withdrawal_missing'", posterS11), 'acc_s11_functions'],
    [edit('LEAST(v_bt.synced_at, pg_catalog.clock_timestamp())', 'pg_catalog.clock_timestamp()', posterS11), 'acc_s11_functions'],
    [edit('v_cutover := private.accounting_cutover_on();', 'v_cutover := private.accounting_cutover_on(); PERFORM 1 FROM public.accounting_pending_events FOR UPDATE;', posterS11), 'acc_s11_functions'],
    [edit('COALESCE(pg_catalog.min(e.stripe_event_created_at), pg_catalog.min(e.occurred_at))', 'pg_catalog.min(e.occurred_at)', 'private.accounting_dispute_lost_at(text)'), 'acc_s11_functions'],
    [edit('private.accounting_dispute_confirmed_done(_dispute_id)', 'false', 'private.accounting_dispute_reversal_kind(text,timestamptz)'), 'acc_s11_functions'],
    [edit('pg_catalog.floor(v_s::numeric * v_bp / v_a)', 'pg_catalog.floor(v_s::numeric * v_bp / v_a) * 1', 'private.accounting_dispute_split_reversal(text,text)'), 'acc_s11_functions'],
    [edit("'won', 'lost', 'warning_closed'", "'won', 'lost'", 'private.accounting_dispute_settled(text)'), 'acc_s11_functions'],
    [edit("ARRAY['admin.accounting.entries.correct']", "ARRAY['admin.finance.manage']", assignS11), 'acc_s11_functions'],
    [edit("IN ('expense', 'revenue')", "IN ('expense', 'revenue', 'asset')", settingS11), 'acc_s11_functions'],
    [edit('ACCOUNTING_DISPUTE_ACCOUNT_INVALID', 'ACCOUNTING_ARGUMENT_INVALID', settingS11), 'acc_s11_functions'],
    // reads
    [edit('ORDER BY o.id, d.id', 'ORDER BY o.id, d.id, (SELECT t.raw_payload::text FROM public.stripe_balance_transactions AS t LIMIT 1)', 'private.get_order_dispute_holds(uuid[])'), 'acc_s11_reads_stable'],
    [edit("'withdrawn_on'", "'evidence_details', d.evidence_details, 'withdrawn_on'", 'private.accounting_dispute_json(text)'), 'acc_s11_reads_stable'],
    // the entry point
    [edit('v_payments := private.accounting_post_payment_events(_limit);\n  v_shipments := private.accounting_post_shipment_events(_limit);',
      'v_shipments := private.accounting_post_shipment_events(_limit);\n  v_payments := private.accounting_post_payment_events(_limit);', runnerPrivateS11), 'acc_s11_run_posting'],
    [edit(') >= _limit);', ') > _limit);', runnerPrivateS11), 'acc_s11_run_posting'],
    [edit("(v_disputes ->> 'parked_new')::integer) >= _limit", "(v_disputes ->> 'resolved')::integer) >= _limit", runnerPrivateS11), 'acc_s11_run_posting'],
    [edit('SELECT private.accounting_run_posting(_limit)', 'SELECT private.accounting_run_posting(50)', runnerPublicS11), 'acc_s11_run_posting'],
    // no row written
    ["insert into public.accounting_dispute_account_settings (reason, account_code) values ('fraudulent', '7530')", 'acc_s11_existing_dml_allowlist'],
    ["select private.accounting_park_event('dispute_event', 'stripe_disputes', 'dp_tamper', null, 'no_order', '{}')", 'acc_s11_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s11_baseline', 'acc_s11_existing_dml_allowlist'],
    ["update pg_temp.accounting_s11_baseline set payload = payload - 'assignments'", 'acc_s11_existing_dml_allowlist'],
    ["update pg_temp.accounting_s11_baseline set payload = jsonb_set(payload, '{settings}', '5')", 'acc_s11_existing_dml_allowlist'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'tamper', '2026-01-01', '2026-12-31')", 'acc_s11_existing_dml_allowlist'],
  ] as Array<[string, string]>)('FREQ-568-AC-05: S11改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// ---- S12 (Task 7): the order intake / backlog / reconciliation reads and the deferred revenue lists ----------------------------------
const assertionS12 = accountingS12Section('FINAL_ASSERT');
const bodyS12 = accountingS12Section('BODY');
const detailsS12 = ['acc_s12_functions', 'acc_s12_function_attrs', 'acc_s12_reads_stable', 'acc_s12_existing_dml_allowlist'];
const statementsS12 = bodyS12.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const readsS12 = ['list_order_intake_events', 'get_intake_breakdown', 'get_order_backlog', 'get_intake_reconciliation', 'list_deferred_revenue',
  'list_deferred_revenue_anomalies'];
const functionBodyS12 = (name: string) => bodyS12.split(`CREATE FUNCTION ${name}(`)[1]?.split('\n$$;')[0] ?? '';
const eventsS12 = 'private.accounting_intake_events(date,date)';
const linesS12 = 'private.accounting_effective_lines(date,date)';
const intakePrivateS12 = 'private.list_order_intake_events(date,date,integer,date,text)';
const intakePublicS12 = 'public.list_order_intake_events(date,date,integer,date,text)';
const breakdownS12 = 'private.get_intake_breakdown(date,date)';
const backlogS12 = 'private.get_order_backlog(date)';
const reconciliationS12 = 'private.get_intake_reconciliation(date,date)';
const deferredS12 = 'private.list_deferred_revenue(date,integer,uuid)';
const anomaliesS12 = 'private.list_deferred_revenue_anomalies()';

describe('S12 source contract (no DB)', () => {
  test('FREQ-571-AC-01: S12はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S12_FILES).toEqual(['20261108210000_accounting_p2_intake_reads.sql']);
    expect(ACCOUNTING_S12_FILES[0] > ACCOUNTING_S11_FILES[0]).toBe(true);
    expect(sqlS12).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS12.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS12.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS12.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS12.trimEnd()).toMatch(/-- ACC_S12_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS12).not.toBe('');
    expect([...new Set([...assertionS12.matchAll(/'(acc_s12_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS12].sort());
    expect(assertionS12).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS12.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS12).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-571-AC-05: S12は読むだけ。実行時のDMLは比べる元の控えのINSERTだけで、表も権限付きの表もトリガーも足さず、service_role に渡すのは6つの読み口（private と public）だけ', () => {
    expect([...statementsS12.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s12_baseline']);
    expect(statementsS12).not.toMatch(/CREATE (TABLE|TRIGGER|POLICY|SEQUENCE|INDEX)|GRANT [A-Z, ]+ ON TABLE/);
    const grant = bodyS12.split('GRANT EXECUTE ON FUNCTION')[1]?.split(';')[0] ?? '';
    expect(grant.match(/(private|public)\.[a-z_]+\(/g)?.sort()).toEqual(
      [...readsS12.map((n) => `private.${n}(`), ...readsS12.map((n) => `public.${n}(`)].sort());
    expect(grant).toContain('TO service_role');
    expect([...bodyS12.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(/g)].map((m) => m[1]).sort()).toEqual([...readsS12].sort());
    expect([...statementsS12.matchAll(/GRANT[^;]*;/g)].some((m) => /\b(anon|authenticated)\b/.test(m[0]))).toBe(false);
    // The tools are named accounting_*, and no public function is: the plan 1 asserts that nothing named accounting_* is public keep holding.
    expect([...bodyS12.matchAll(/CREATE FUNCTION public\.accounting_/g)]).toHaveLength(0);
  });

  test('FREQ-571-AC-01: 取り消しの仕訳は元の仕訳の種類と鍵で数え、読み口の始まりは期間の始まり（無ければ切り替えの日）', () => {
    const lines = functionBodyS12('private.accounting_effective_lines');
    expect(lines).toContain('COALESCE(o.event_kind, e.event_kind)');
    expect(lines).toContain('COALESCE(o.dedupe_key, e.dedupe_key)');
    expect(lines).toContain('LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id');
    expect(lines).toContain('GREATEST(_from, private.accounting_read_start())');
    const start = functionBodyS12('private.accounting_read_start');
    expect(start).toContain('pg_catalog.min(p.starts_on)');
    expect(start).toContain('s.cutover_on');
    // The "drop the reversed original" way is not mixed in: no read looks at reverses_entry_id except the one tool.
    for (const name of ['private.accounting_intake_events', 'private.get_intake_reconciliation', 'private.list_deferred_revenue',
      'private.list_deferred_revenue_anomalies', 'private.get_order_backlog', 'private.accounting_order_balances']) {
      expect(functionBodyS12(name)).not.toContain('reverses_entry_id');
    }
  });

  test('FREQ-571-AC-04: カード会社の取り消しの確定の日は、確定の仕訳の日か、解決済みの行の lost_on で、道具を読み直さない。早い戻りと遅い戻りは1160のメモで分ける', () => {
    const events = functionBodyS12('private.accounting_intake_events');
    expect(events).toContain("'dispute_event:' || pd.dispute_id || ':confirmed:lost'");
    expect(events).toContain("p.source_table = 'stripe_disputes'");
    expect(events).toContain("p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL");
    expect(events).toContain("(p.detail ->> 'lost_on')::date");
    expect(events).toContain("m.memo = 'dispute_reversal_kind:R'");
    expect(events).toContain("m.memo = 'dispute_reversal_kind:L'");
    expect(events).not.toMatch(/accounting_dispute_|stripe_dispute_events|stripe_disputes AS/);
  });

  test('FREQ-571-AC-05: 照らし合わせの例外は、判断待ち・2130・その他（種類ごと）の3種類で、説明のつかない差と2段目の差は式のとおり', () => {
    const text = functionBodyS12('private.get_intake_reconciliation');
    expect(text).toContain("'dispute_pending'");
    expect(text).toContain("'return_refund_2130'");
    expect(text).toContain("'other'");
    expect(text).toContain('v_pending := v_pending_move - v_deducted;');
    expect(text).toContain("'unexplained', v_closing - (v_opening + v_intake - v_sales + v_pending + v_refund_2130 + v_other_sum)");
    expect(text).toContain("'unexplained2', (v_sales - v_returns) - v_booked");
    expect(text).toContain("'book_sales_total', v_booked + v_other_4010 - v_other_4020");
    // 4050 is a row of its own: it is not in the sales total.
    expect(text).toContain("l.account_code = '4050'");
    expect(text).not.toMatch(/book_sales_total[^\n]*v_fee/);
  });

  test('FREQ-569-AC-04: 前受金の一覧は未出荷の状態を G の関数から読み（order の行だけ）、異常の一覧は着の値の道具を使う。名前・メール・住所・利用者の番号を書かない', () => {
    const deferred = functionBodyS12('private.list_deferred_revenue');
    expect(deferred).toContain('private.list_admin_order_item_states(v_ids)');
    expect(deferred).toContain("oi.line_kind = 'order'");
    expect(functionBodyS12('private.list_deferred_revenue_anomalies')).toContain('private.accounting_unit_values(b.order_id, NULL::bigint)');
    for (const name of ['private.accounting_intake_events', 'private.list_order_intake_events', 'private.get_intake_breakdown',
      'private.get_order_backlog', 'private.get_intake_reconciliation', 'private.list_deferred_revenue', 'private.list_deferred_revenue_anomalies']) {
      const text = functionBodyS12(name);
      expect(text).not.toBe('');
      expect(text).not.toMatch(/raw_payload|evidence_details|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address|user_id|session_id/);
    }
  });

  test('FREQ-571-AC-01: S12に日本語の文字列は無い（画面の語は Task 13 が持つ）', () => {
    const code = bodyS12.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/U&'/);
    expect(sqlS12).not.toMatch(/chargeback/i);
  });
});

describeLocalDb('S12 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s12_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS12Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS12);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s12_assert'); await db().query('release savepoint acc_s12_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature: string) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;

  test('FREQ-571-AC-05: S12末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS12).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s12_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS12Baseline(db());
    await db().query(assertionS12);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s12_search_path');
  });

  test('FREQ-571-AC-05: S12末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s12_existing_dml_allowlist'));
  });

  test('FREQ-571-AC-05: 読み口は service_role だけが呼べ、道具は誰も呼べない', async () => {
    for (const name of readsS12) {
      const row = (await db().query(
        `select p.oid::regprocedure::text as signature,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role, has_function_privilege('public', p.oid, 'EXECUTE') as public
         from pg_proc p where p.proname = $1 and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by p.pronamespace`, [name])).rows;
      expect(row).toHaveLength(2);
      for (const entry of row) expect([entry.signature, entry.anon, entry.authenticated, entry.service_role, entry.public]).toEqual([entry.signature, false, false, true, false]);
    }
    for (const signature of [eventsS12, linesS12, 'private.accounting_order_balances(date)', 'private.accounting_read_start()']) {
      const row = (await db().query(
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role, has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon",
        [signature])).rows[0];
      expect([signature, row]).toEqual([signature, { service_role: false, anon: false }]);
    }
  });

  test.each([
    // functions: owner, security, volatility, arguments, ACL
    [`grant execute on function ${eventsS12} to service_role`, 'acc_s12_function_attrs'],
    [`grant execute on function ${linesS12} to authenticated`, 'acc_s12_function_attrs'],
    ['grant execute on function private.accounting_order_balances(date) to anon', 'acc_s12_function_attrs'],
    ['grant execute on function private.accounting_read_start() to public', 'acc_s12_function_attrs'],
    [`grant execute on function ${intakePrivateS12} to anon`, 'acc_s12_function_attrs'],
    [`grant execute on function ${intakePublicS12} to authenticated`, 'acc_s12_function_attrs'],
    [`grant execute on function ${intakePublicS12} to public`, 'acc_s12_function_attrs'],
    [`revoke execute on function ${intakePublicS12} from service_role`, 'acc_s12_function_attrs'],
    [`revoke execute on function ${reconciliationS12} from service_role`, 'acc_s12_function_attrs'],
    [`alter function ${intakePublicS12} security definer`, 'acc_s12_function_attrs'],
    [`alter function ${backlogS12} security invoker`, 'acc_s12_function_attrs'],
    [`alter function ${breakdownS12} volatile`, 'acc_s12_function_attrs'],
    ['alter function public.get_order_backlog(date) volatile', 'acc_s12_function_attrs'],
    [`alter function ${eventsS12} volatile`, 'acc_s12_function_attrs'],
    [`alter function ${deferredS12} set search_path = public`, 'acc_s12_function_attrs'],
    [`alter function ${anomaliesS12} strict`, 'acc_s12_function_attrs'],
    ['drop function public.get_intake_reconciliation(date,date)', 'acc_s12_function_attrs'],
    ['create function public.accounting_read_start() returns date language sql as $$ select current_date $$', 'acc_s12_function_attrs'],
    // functions: the text keeps the rules
    ['create function private.get_order_backlog(_as_of integer) returns integer language sql as $$ select 1 $$', 'acc_s12_functions'],
    ['drop function private.accounting_order_balances(date) cascade', 'acc_s12_functions'],
    [edit('COALESCE(o.event_kind, e.event_kind)', 'e.event_kind', linesS12), 'acc_s12_functions'],
    [edit('COALESCE(o.dedupe_key, e.dedupe_key)', 'e.dedupe_key', linesS12), 'acc_s12_functions'],
    [edit('GREATEST(_from, private.accounting_read_start())', '_from', linesS12), 'acc_s12_functions'],
    [edit('s.cutover_on', 'DATE \'2000-01-01\'', 'private.accounting_read_start()'), 'acc_s12_functions'],
    [edit("p.resolved_at IS NOT NULL", "true", eventsS12), 'acc_s12_functions'],
    [edit("'dispute_reversal_kind:L'", "'dispute_reversal_kind:Q'", eventsS12), 'acc_s12_functions'],
    [edit("'dispute_reversal_kind:R'", "'dispute_reversal_kind:Q'", eventsS12), 'acc_s12_functions'],
    [edit('cf.pending <> 0', 'true', eventsS12), 'acc_s12_functions'],
    [edit("'pre_shipment_refund'", "'pre_shipment_refunds'", eventsS12), 'acc_s12_functions'],
    [edit('_limit > 5000', '_limit > 6000', intakePrivateS12), 'acc_s12_functions'],
    [edit('LIMIT _limit + 1', 'LIMIT _limit', intakePrivateS12), 'acc_s12_functions'],
    [edit('COLLATE "C"', 'COLLATE "default"', intakePrivateS12), 'acc_s12_functions'],
    [edit('v_subtotal - v_discount + v_shipping + v_cancel + v_deducted + v_restored = v_intake', 'true', breakdownS12), 'acc_s12_functions'],
    [edit('pg_catalog.sign(pg_catalog.sum(e.amount))', 'pg_catalog.sum(e.amount)', breakdownS12), 'acc_s12_functions'],
    [edit('HAVING pg_catalog.sum(e.amount) <> 0', 'HAVING true', breakdownS12), 'acc_s12_functions'],
    [edit('b.balance <> 0', 'true', backlogS12), 'acc_s12_functions'],
    [edit('v_pending_move - v_deducted', 'v_pending_move', reconciliationS12), 'acc_s12_functions'],
    [edit('v_closing - (v_opening + v_intake - v_sales + v_pending + v_refund_2130 + v_other_sum)', '0', reconciliationS12), 'acc_s12_functions'],
    [edit('(v_sales - v_returns) - v_booked', '0', reconciliationS12), 'acc_s12_functions'],
    [edit("'return_refund_2130'", "'return_refund'", reconciliationS12), 'acc_s12_functions'],
    [edit('_from - 1', '_from', reconciliationS12), 'acc_s12_functions'],
    [edit("oi.line_kind = 'order'", 'true', deferredS12), 'acc_s12_functions'],
    [edit('b.balance > 0', 'b.balance <> 0', deferredS12), 'acc_s12_functions'],
    [edit('_limit > 200', '_limit > 300', deferredS12), 'acc_s12_functions'],
    [edit('NOT v.shipped AND v.value > 0', 'true', anomaliesS12), 'acc_s12_functions'],
    [edit("'negative_balance'", "'negative'", anomaliesS12), 'acc_s12_functions'],
    // reads: no write, no personal column
    [edit('pg_catalog.count(*) FILTER (WHERE b.balance <> 0)', 'pg_catalog.count(*) FILTER (WHERE b.balance <> 0 AND EXISTS (SELECT 1 FROM public.orders AS o WHERE o.user_id IS NULL))', backlogS12), 'acc_s12_reads_stable'],
    [edit("'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(f.order_id::text, 8))", "'order_number', (SELECT o.shipping_email FROM public.orders AS o WHERE o.id = f.order_id)", anomaliesS12), 'acc_s12_reads_stable'],
    [edit('IF _as_of IS NULL THEN', '-- FOR UPDATE\n  IF _as_of IS NULL THEN', backlogS12), 'acc_s12_reads_stable'],
    [edit('v_total := COALESCE(', 'PERFORM 1; v_total := COALESCE(', deferredS12), 'acc_s12_reads_stable'],
    // no row written
    ["select private.accounting_park_event('payment_confirmed', 'stripe_balance_transactions', 'txn_tamper', null, 'no_order', '{}')", 'acc_s12_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s12_baseline', 'acc_s12_existing_dml_allowlist'],
    ["update pg_temp.accounting_s12_baseline set payload = payload - 'periods'", 'acc_s12_existing_dml_allowlist'],
    ["update pg_temp.accounting_s12_baseline set payload = jsonb_set(payload, '{lines}', '5')", 'acc_s12_existing_dml_allowlist'],
    ["insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ('soleProprietor', 'tamper', '2026-01-01', '2026-12-31')", 'acc_s12_existing_dml_allowlist'],
  ] as Array<[string, string]>)('FREQ-571-AC-05: S12改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// ---- S13 (Task 8): the monthly KPI table admin_kpi_monthly_records and its writers / reader ---------------------------------------
const assertionS13 = accountingS13Section('FINAL_ASSERT');
const bodyS13 = accountingS13Section('BODY');
const detailsS13 = ['acc_s13_table', 'acc_s13_constraints', 'acc_s13_rls_acl', 'acc_s13_function_attrs', 'acc_s13_existing_dml_allowlist'];
const statementsS13 = bodyS13.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const functionBodyS13 = (name: string) => bodyS13.split(`CREATE FUNCTION ${name}(`)[1]?.split('\n$$;')[0] ?? '';
const kpiTable = 'public.admin_kpi_monthly_records';
const applyS13 = 'private.kpi_monthly_records_apply(jsonb,boolean)';
const adminSetPrivate = 'private.admin_set_kpi_monthly_records(uuid,jsonb)';
const adminSetPublic = 'public.admin_set_kpi_monthly_records(uuid,jsonb)';
const upsertPrivate = 'private.system_upsert_kpi_monthly_records(jsonb)';
const upsertPublic = 'public.system_upsert_kpi_monthly_records(jsonb)';
const listPrivate = 'private.list_kpi_monthly_records(text[])';
const listPublic = 'public.list_kpi_monthly_records(text[])';

describe('S13 source contract (no DB)', () => {
  test('FREQ-573-AC-01: S13はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S13_FILES).toEqual(['20261108220000_accounting_p2_kpi_monthly_records.sql']);
    expect(ACCOUNTING_S13_FILES[0] > ACCOUNTING_S12_FILES[0]).toBe(true);
    expect(sqlS13).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sqlS13.startsWith('BEGIN;\n')).toBe(true);
    expect(sqlS13.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sqlS13.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sqlS13.trimEnd()).toMatch(/-- ACC_S13_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertionS13).not.toBe('');
    expect([...new Set([...assertionS13.matchAll(/'(acc_s13_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...detailsS13].sort());
    expect(assertionS13).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertionS13.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sqlS13).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-573-AC-01: 表は IF NOT EXISTS なしで作り（既にあれば適用が止まる）、実行時のDMLは比べる元の控えのINSERTだけ', () => {
    expect(statementsS13).toContain('CREATE TABLE public.admin_kpi_monthly_records');
    expect(statementsS13).not.toMatch(/IF NOT EXISTS|CREATE OR REPLACE|DROP /);
    expect([...statementsS13.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s13_baseline']);
    // The only CREATE TABLE is the KPI table, and nothing of group G / H / returns / refund is altered.
    expect([...statementsS13.matchAll(/CREATE TABLE ([\w.]+)/g)].map((m) => m[1])).toEqual([kpiTable]);
    expect([...statementsS13.matchAll(/ALTER TABLE ([\w.]+)/g)].map((m) => m[1]).filter((name) => name !== kpiTable)).toEqual([]);
  });

  test('FREQ-573-AC-01: 表の権限は service_role の SELECT だけで、anon・authenticated・PUBLIC には渡さない。書き口と読み口は service_role だけ', () => {
    const grants = [...statementsS13.matchAll(/GRANT[^;]*;/g)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(grants.filter((g) => /ON TABLE|ON public\./.test(g))).toEqual(['GRANT SELECT ON TABLE public.admin_kpi_monthly_records TO service_role;']);
    expect(grants.some((g) => /\b(anon|authenticated|PUBLIC)\b/.test(g))).toBe(false);
    const grant = bodyS13.split('GRANT EXECUTE ON FUNCTION')[1]?.split(';')[0] ?? '';
    const names = [...grant.matchAll(/(?:private|public)\.[a-z_]+\(/g)].map((m) => m[0]).sort();
    expect(names).toEqual([adminSetPrivate, adminSetPublic, upsertPrivate, upsertPublic, listPrivate, listPublic]
      .map((signature) => signature.replace(/\(.*/, '(')).sort());
    expect(bodyS13).toMatch(/ALTER TABLE public\.admin_kpi_monthly_records ENABLE ROW LEVEL SECURITY;/);
    expect(statementsS13).not.toMatch(/CREATE POLICY/);
  });

  test('FREQ-573-AC-01: 月と指標の鍵のCHECKは、画面が保存に使う全部の鍵（src:とkpi:）を受け、それ以外を断る', () => {
    const check = (column: string) => bodyS13.match(new RegExp(`${column} text NOT NULL CONSTRAINT \\w+ CHECK \\(${column} ~ '([^']+)'\\)`))?.[1] ?? '';
    expect(check('month_key')).toBe('^[0-9]{4}-(0[1-9]|1[0-2])$');
    expect(check('metric_key')).toBe('^(src|kpi):[A-Za-z0-9_]{1,64}$');
    const monthPattern = new RegExp(check('month_key'));
    const metricPattern = new RegExp(check('metric_key'));
    const keys = [...SOURCE_METRIC_KEYS.map(sourceStorageKey), ...MONTHLY_KPI_FORMULAS.map((formula) => kpiOverrideStorageKey(formula.key))];
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect([key, isValidStorageKey(key), metricPattern.test(key)]).toEqual([key, true, true]);
    for (const key of ['reach', 'foo:reach', 'src:', 'src:a-b', `kpi:${'a'.repeat(65)}`]) expect([key, metricPattern.test(key)]).toEqual([key, false]);
    for (const month of ['2026-01', '2026-12']) expect(monthPattern.test(month)).toBe(true);
    for (const month of ['2026-00', '2026-13', '2026-1']) expect(monthPattern.test(month)).toBe(false);
  });

  test('FREQ-573-AC-02: 書き口は最初に admin.orders.read の確認、上限は200件（読み口は月24件）、同じ月・指標はON CONFLICTで1行', () => {
    const adminSet = functionBodyS13('private.admin_set_kpi_monthly_records');
    expect(adminSet).toContain("private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read'])");
    expect(adminSet).toContain("RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501'");
    expect(adminSet.indexOf('group_g_actor_has_permissions')).toBeLessThan(adminSet.indexOf('kpi_monthly_records_apply'));
    expect(functionBodyS13('private.system_upsert_kpi_monthly_records')).not.toContain('group_g_actor_has_permissions');
    const apply = functionBodyS13('private.kpi_monthly_records_apply');
    expect(apply).toContain('> 200');
    expect(apply).toContain('ON CONFLICT (month_key, metric_key) DO UPDATE');
    expect(apply).toContain('DELETE FROM public.admin_kpi_monthly_records');
    expect(apply).toContain("'^[0-9]{4}-(0[1-9]|1[0-2])$'");
    expect(apply).toContain("'^(src|kpi):[A-Za-z0-9_]{1,64}$'");
    expect(functionBodyS13('private.list_kpi_monthly_records')).toContain('> 24');
    expect(functionBodyS13('private.list_kpi_monthly_records')).not.toMatch(/INSERT|UPDATE|DELETE|FOR (SHARE|UPDATE)/);
  });

  test('FREQ-573-AC-01: S13に日本語の文字列は無く、G・H・返品・返金の表を名指ししない', () => {
    const code = bodyS13.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/U&'/);
    expect(code).not.toMatch(/public\.(orders|order_\w+|shipment_\w+|\w*refund\w*|stripe_\w+)\b/i);
  });
});

describeLocalDb('S13 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s13_assert');
    let failure: AssertFailure | null = null;
    try {
      if (baseline === 'pin') await pinAccountingS13Baseline(db());
      if (change) await db().query(change);
      await db().query(assertionS13);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s13_assert'); await db().query('release savepoint acc_s13_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  /** Re-create the function with a changed text (owner, ACL and attributes stay). */
  const edit = (from: string, to: string, signature: string) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signature}'::regprocedure);
    if position(${quote(from)} in d) = 0 then raise exception 'TAMPER_TARGET_MISSING'; end if;
    d := replace(d, ${quote(from)}, ${quote(to)});
    execute d; end $x$`;

  test('FREQ-573-AC-01: S13末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertionS13).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s13_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await pinAccountingS13Baseline(db());
    await db().query(assertionS13);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s13_search_path');
  });

  test('FREQ-573-AC-01: S13末尾assertは比べる元の控えが無いと断る', async () => {
    expect(await attempt('', 'none')).toEqual(failed('acc_s13_existing_dml_allowlist'));
  });

  test('FREQ-573-AC-01: 書き口と読み口は service_role だけが呼べ、道具は誰も呼べない', async () => {
    for (const name of ['admin_set_kpi_monthly_records', 'system_upsert_kpi_monthly_records', 'list_kpi_monthly_records']) {
      const rows = (await db().query(
        `select p.oid::regprocedure::text as signature,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role, has_function_privilege('public', p.oid, 'EXECUTE') as public
         from pg_proc p where p.proname = $1 and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)`, [name])).rows;
      expect(rows).toHaveLength(2);
      for (const entry of rows) expect([entry.signature, entry.anon, entry.authenticated, entry.service_role, entry.public]).toEqual([entry.signature, false, false, true, false]);
    }
    for (const signature of [applyS13, 'private.admin_kpi_monthly_records_touch()']) {
      const row = (await db().query(
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role, has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon",
        [signature])).rows[0];
      expect([signature, row]).toEqual([signature, { service_role: false, anon: false }]);
    }
  });

  test.each([
    // table
    [`alter table ${kpiTable} add column note text`, 'acc_s13_table'],
    [`alter table ${kpiTable} alter column value type bigint`, 'acc_s13_table'],
    [`alter table ${kpiTable} alter column value drop not null`, 'acc_s13_table'],
    [`alter table ${kpiTable} alter column created_at drop default`, 'acc_s13_table'],
    [`alter table ${kpiTable} alter column id drop identity`, 'acc_s13_table'],
    [`alter table ${kpiTable} rename column value to amount`, 'acc_s13_table'],
    [`drop table ${kpiTable} cascade`, 'acc_s13_table'],
    // constraints, index, trigger
    [`alter table ${kpiTable} drop constraint admin_kpi_monthly_records_month_key_check`, 'acc_s13_constraints'],
    [`alter table ${kpiTable} drop constraint admin_kpi_monthly_records_metric_key_check`, 'acc_s13_constraints'],
    [`alter table ${kpiTable} drop constraint admin_kpi_monthly_records_month_key_metric_key_key`, 'acc_s13_constraints'],
    [`alter table ${kpiTable} drop constraint admin_kpi_monthly_records_metric_key_check, add constraint admin_kpi_monthly_records_metric_key_check check (metric_key ~ '^(src|kpi):.*$')`, 'acc_s13_constraints'],
    [`alter table ${kpiTable} drop constraint admin_kpi_monthly_records_month_key_check, add constraint admin_kpi_monthly_records_month_key_check check (month_key ~ '^[0-9]{4}-[0-9]{2}$')`, 'acc_s13_constraints'],
    [`alter table ${kpiTable} add constraint admin_kpi_monthly_records_value_check check (value >= 0)`, 'acc_s13_constraints'],
    ['drop index public.admin_kpi_monthly_records_month_key_idx', 'acc_s13_constraints'],
    [`alter table ${kpiTable} disable trigger admin_kpi_monthly_records_touch`, 'acc_s13_constraints'],
    [`drop trigger admin_kpi_monthly_records_touch on ${kpiTable}`, 'acc_s13_constraints'],
    [`create trigger tamper_after after insert on ${kpiTable} for each row execute function private.admin_kpi_monthly_records_touch()`, 'acc_s13_constraints'],
    // RLS and ACL
    [`alter table ${kpiTable} disable row level security`, 'acc_s13_rls_acl'],
    [`create policy tamper on ${kpiTable} for select using (true)`, 'acc_s13_rls_acl'],
    [`grant select on ${kpiTable} to anon`, 'acc_s13_rls_acl'],
    [`grant select on ${kpiTable} to authenticated`, 'acc_s13_rls_acl'],
    [`grant select on ${kpiTable} to public`, 'acc_s13_rls_acl'],
    [`grant insert on ${kpiTable} to service_role`, 'acc_s13_rls_acl'],
    [`grant update on ${kpiTable} to service_role`, 'acc_s13_rls_acl'],
    [`grant delete on ${kpiTable} to service_role`, 'acc_s13_rls_acl'],
    [`grant select (value) on ${kpiTable} to authenticated`, 'acc_s13_rls_acl'],
    [`revoke select on ${kpiTable} from service_role`, 'acc_s13_rls_acl'],
    // functions: ACL, attributes, text
    [`grant execute on function ${adminSetPublic} to anon`, 'acc_s13_function_attrs'],
    [`grant execute on function ${upsertPublic} to authenticated`, 'acc_s13_function_attrs'],
    [`grant execute on function ${listPublic} to public`, 'acc_s13_function_attrs'],
    [`grant execute on function ${applyS13} to service_role`, 'acc_s13_function_attrs'],
    ['grant execute on function private.admin_kpi_monthly_records_touch() to service_role', 'acc_s13_function_attrs'],
    [`revoke execute on function ${adminSetPublic} from service_role`, 'acc_s13_function_attrs'],
    [`revoke execute on function ${listPrivate} from service_role`, 'acc_s13_function_attrs'],
    [`alter function ${adminSetPublic} security definer`, 'acc_s13_function_attrs'],
    [`alter function ${adminSetPrivate} security invoker`, 'acc_s13_function_attrs'],
    [`alter function ${listPublic} volatile`, 'acc_s13_function_attrs'],
    [`alter function ${listPrivate} volatile`, 'acc_s13_function_attrs'],
    [`alter function ${upsertPrivate} stable`, 'acc_s13_function_attrs'],
    [`alter function ${applyS13} set search_path = public`, 'acc_s13_function_attrs'],
    [`drop function ${listPublic}`, 'acc_s13_function_attrs'],
    ['create function public.list_kpi_monthly_records(_month_keys text[], _extra integer) returns integer language sql as $$ select 1 $$', 'acc_s13_function_attrs'],
    [edit("ARRAY['admin.orders.read']", "ARRAY['admin.orders.manage']", adminSetPrivate), 'acc_s13_function_attrs'],
    [edit('> 200', '> 300', applyS13), 'acc_s13_function_attrs'],
    [edit('DO UPDATE SET value = EXCLUDED.value', 'DO UPDATE SET value = t.value', applyS13), 'acc_s13_function_attrs'],
    [edit('> 24', '> 36', listPrivate), 'acc_s13_function_attrs'],
    [edit("USING ERRCODE = '42501'", "USING ERRCODE = '22023'", adminSetPrivate), 'acc_s13_function_attrs'],
    // no row written
    [`insert into ${kpiTable}(month_key, metric_key, value) values ('2026-07', 'kpi:sales', 1)`, 'acc_s13_existing_dml_allowlist'],
    ["select private.accounting_park_event('payment_confirmed', 'stripe_balance_transactions', 'txn_tamper', null, 'no_order', '{}')", 'acc_s13_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s13_baseline', 'acc_s13_existing_dml_allowlist'],
    ["update pg_temp.accounting_s13_baseline set payload = payload - 'periods'", 'acc_s13_existing_dml_allowlist'],
    ["update pg_temp.accounting_s13_baseline set payload = jsonb_set(payload, '{lines}', '5')", 'acc_s13_existing_dml_allowlist'],
  ] as Array<[string, string]>)('FREQ-573-AC-01: S13改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});
