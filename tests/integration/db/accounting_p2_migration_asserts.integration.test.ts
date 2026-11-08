/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_S6_FILES, ACCOUNTING_S6_SQL as sql, accountingS6Section, pinAccountingS6Baseline,
  ACCOUNTING_S7_FILES, ACCOUNTING_S7_SQL as sqlS7, accountingS7Section, pinAccountingS7Baseline,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 S6 (FREQ-569 / FREQ-563): the shape of the migration and its final assert. The DB part is
// controller only. Tasks 2-9 add the asserts of S7-S14 below (S7: the payment posting, Task 2).
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
    // The message of the exception is never stored: SQLERRM only feeds a fixed-code test.
    expect(fn).not.toMatch(/PG_EXCEPTION_CONTEXT/);
    expect(fn).not.toMatch(/'(?:message|detail|context)'/);
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
  const edit = (from: string, to: string) => `do $x$ declare d text; begin
    d := pg_get_functiondef('${signatureS7}'::regprocedure);
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
