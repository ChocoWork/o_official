/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_S6_FILES, ACCOUNTING_S6_SQL as sql, accountingS6Section, pinAccountingS6Baseline,
  ACCOUNTING_S7_FILES, ACCOUNTING_S7_SQL as sqlS7, accountingS7Section, pinAccountingS7Baseline,
  ACCOUNTING_S8_FILES, ACCOUNTING_S8_SQL as sqlS8, accountingS8Section, pinAccountingS8Baseline,
  ACCOUNTING_S9_FILES, ACCOUNTING_S9_SQL as sqlS9, accountingS9Section, pinAccountingS9Baseline,
} from './helpers/accounting-orders-fixtures';
import { ACCOUNTING_LABELS, encodeSqlUnicodeLiteral } from '@/lib/accounting/labels';

// Accounting plan 2 S6 (FREQ-569 / FREQ-563): the shape of the migration and its final assert. The DB part is
// controller only. Tasks 2-9 add the asserts of S7-S14 below (S7: the payment posting, Task 2; S8: the shipment posting, Task 3).
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
    expect(await attempt(`create function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
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
    expect(await attempt(`create function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
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
    expect(await attempt(`create function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
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
    expect(await attempt(`create function public.accounting_run_posting(_limit integer default 50) returns jsonb language sql volatile
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
