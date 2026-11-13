/** @jest-environment node */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import {
  H7_ALLOWLIST, P3_ALLOWLIST, RECEIVE_RETURN_16, RECEIVE_RETURN_17, replaceAllowlistSql, UB_REFUNDS_ALLOWLIST,
} from './helpers/group-g-allowlist';
import {
  ACCOUNTING_S15_FILES, ACCOUNTING_S15_SQL as sql, ACCOUNTING_S16_FILES, ACCOUNTING_S16_SQL as s16Sql, accountingS15Section,
  accountingS16Section, ACCOUNTING_S17_FILES, ACCOUNTING_S17_SQL as s17Sql, accountingS17Section, pinAccountingS15Baseline,
  pinAccountingS17Baseline, seedReturnRefundParents, ACCOUNTING_S18_FILES, ACCOUNTING_S18_SQL as s18Sql, accountingS18Section,
  pinAccountingS18Baseline, restorePreS18Receive, ACCOUNTING_S19_FILES, ACCOUNTING_S19_SQL as s19Sql, accountingS19Section,
  pinAccountingS19Baseline, ACCOUNTING_S20_FILES, ACCOUNTING_S20_SQL as s20Sql, accountingS20Section, pinAccountingS20Baseline,
  ACCOUNTING_S21_FILES, ACCOUNTING_S21_SQL as s21Sql, accountingS21Section, pinAccountingS21Baseline, restoreS20RunPosting,
} from './helpers/accounting-returns-fixtures';
import { ACCOUNTING_LABELS, encodeSqlUnicodeLiteral } from '@/lib/accounting/labels';
import { PENDING_REASONS } from '@/lib/accounting/posting-types';
import { REFUND_EVENT_STATES } from '@/lib/accounting/return-refund-types';

// Accounting plan 3 S15 (FREQ-576 / FREQ-575 / FREQ-569): the shape of the migration and its final assert. Tasks 2-9 add
// the asserts of S16-S23 below.
jest.setTimeout(120000);
const assertion = accountingS15Section('FINAL_ASSERT');
const body = accountingS15Section('BODY');
const details = ['acc_s15_tables', 'acc_s15_constraints', 'acc_s15_immutable', 'acc_s15_rls_acl', 'acc_s15_receipt_column',
  'acc_s15_receipt_backfill', 'acc_s15_pending_reason_check', 'acc_s15_pending_detail_valid', 'acc_s15_hold_tools',
  'acc_s15_existing_dml_allowlist'];
type AssertFailure = { code?: string; message?: string; detail?: string };
const statements = body.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').replace(/\$acc_s15_precheck\$[\s\S]*?\$acc_s15_precheck\$/g, '')
  .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const precheck = body.split('DO $acc_s15_precheck$')[1]?.split('$acc_s15_precheck$;')[0] ?? '';

describe('S15 source contract (no DB)', () => {
  test('FREQ-576-AC-04: S15はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S15_FILES).toHaveLength(1);
    expect(ACCOUNTING_S15_FILES[0] > '20261112064013_unit_binding_refund_retry.sql').toBe(true);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S15_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertion).not.toBe('');
    expect([...new Set([...assertion.matchAll(/'(acc_s15_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect(assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertion.replace(/''55000''/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    // S15 writes no Japanese (the labels go into S17 and later).
    expect(sql).not.toMatch(/U&'/);
    expect(Object.keys(ACCOUNTING_LABELS).every((key) => encodeSqlUnicodeLiteral(ACCOUNTING_LABELS[key as keyof typeof ACCOUNTING_LABELS]).startsWith("U&'"))).toBe(true);
  });

  test('FREQ-575-AC-01: S15の最初の確かめは受け取りの行が0件で、0でなければ固定DETAILで止め、列を足す前に流れる', () => {
    expect(precheck).toContain('EXISTS (SELECT 1 FROM public.order_return_receipts)');
    expect(precheck).toContain("DETAIL = 'acc_s15_receipt_backfill'");
    expect(body.indexOf('DO $acc_s15_precheck$')).toBeLessThan(body.indexOf('ALTER TABLE public.order_return_receipts'));
    expect(body.indexOf('DO $acc_s15_precheck$')).toBeLessThan(body.indexOf('CREATE TABLE'));
  });

  test('FREQ-576-AC-04: S15の実行時のDMLは比べる元の控えと設定の1行のINSERTだけ', () => {
    expect([...statements.matchAll(/^\s*(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?)\s+([\w.]+)/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['INSERT INTO pg_temp.accounting_s15_baseline', 'INSERT INTO public.accounting_return_options']);
    expect(statements).not.toMatch(/\bDO \$/);
    expect(body).not.toMatch(/GRANT EXECUTE/i);
    expect(body).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\./);
    // S15 takes no number itself: the writers of the facts come in Task 3 and Task 4.
    expect(body).not.toContain('accounting_take_g_fact_seq');
  });

  test('FREQ-569-AC-01: S15の理由のCHECKはTSの理由の一覧と同じ20個を同じ順で持ち、状態のCHECKはTSの9つ', () => {
    const reasons = /accounting_pending_events_reason_check CHECK \(reason IN \(([^)]*)\)\)/.exec(body)?.[1] ?? '';
    expect([...reasons.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...PENDING_REASONS]);
    const states = /accounting_refund_events_state_check CHECK \(state = ANY \(ARRAY\[([^\]]*)\]\)\)/.exec(body)?.[1] ?? '';
    expect([...states.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...REFUND_EVENT_STATES]);
  });

  test('FREQ-569-AC-01: S15の detail の一覧の md5 は本文の字（空白を除く）の md5', () => {
    const fn = body.match(/CREATE OR REPLACE FUNCTION private\.accounting_pending_detail_valid[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1] ?? '';
    expect(fn).not.toBe('');
    const digest = createHash('md5').update(fn.replace(/\s+/g, ''), 'utf8').digest('hex');
    expect(assertion).toContain(`= '${digest}'`);
    // The function header (arguments, attributes) is the one of plan 2; no ALTER / REVOKE / GRANT repeats it.
    expect(body).toContain('CREATE OR REPLACE FUNCTION private.accounting_pending_detail_valid(_reason text, _detail jsonb) RETURNS boolean\n'
      + "LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''");
    expect(body).not.toMatch(/(?:ALTER|REVOKE|GRANT)[^;]*FUNCTION private\.accounting_pending_detail_valid/i);
  });
});

describeLocalDb('S15 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** The baseline is pinned first, then the tamper and the assertion run against it. */
  async function attempt(change = '', baseline: 'pin' | 'none' = 'pin'): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s15_assert');
    let failure: AssertFailure | null = null;
    try {
      await dropS17Trigger();
      if (baseline === 'pin') await pinAccountingS15Baseline(db());
      if (change) await db().query(change);
      await db().query(assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s15_assert'); await db().query('release savepoint acc_s15_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  /** S17 が値段の直しの表に足した遅らせた制約トリガー（S15 の数の確かめの外）を、再生の savepoint の中でだけ外す。 */
  const dropS17Trigger = () => db().query('drop trigger if exists accounting_unit_price_adjusts_sum on public.accounting_unit_price_adjusts');

  test('FREQ-576-AC-04: S15末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s15_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
    await dropS17Trigger();
    await pinAccountingS15Baseline(db());
    await db().query(assertion);
    expect((await db().query('show search_path')).rows[0].search_path).toBe('public, private, extensions, pg_catalog');
    await db().query('rollback to savepoint acc_s15_search_path');
  });

  test('FREQ-575-AC-01: S15の最初の確かめは受け取りの行があると55000とDETAIL=acc_s15_receipt_backfillで止める', async () => {
    const run = async (): Promise<AssertFailure | null> => {
      await db().query('savepoint acc_s15_precheck');
      try { await db().query(`DO $acc_s15_precheck$${precheck}$acc_s15_precheck$`); return null; }
      catch (error) { const e = error as AssertFailure; return { code: e.code, message: e.message, detail: e.detail }; }
      finally { await db().query('rollback to savepoint acc_s15_precheck'); await db().query('release savepoint acc_s15_precheck'); }
    };
    // Earlier suites in a full run may have committed receipts (append-only, so they cannot be removed here);
    // the passing case is checked only while the table is empty.
    const existing = Number((await db().query('select count(*)::int as n from public.order_return_receipts')).rows[0].n);
    expect(await run()).toEqual(existing === 0 ? null : failed('acc_s15_receipt_backfill'));
    await seedReturnRefundParents(db());
    expect(await run()).toEqual(failed('acc_s15_receipt_backfill'));
  });

  test('FREQ-576-AC-04: S15末尾assertは後の試験が足した行があっても再生で通り、足したままの比べる元の控えが無いと断る', async () => {
    await seedReturnRefundParents(db());
    await db().query("select private.accounting_park_event('return_refund', 'order_refunds', 'replay_1', null, 'refund_prior_unposted', '{}')");
    expect(await attempt()).toBeNull();
    expect(await attempt("select private.accounting_park_event('return_refund', 'order_refunds', 'replay_2', null, 'no_order', '{}')"))
      .toEqual(failed('acc_s15_existing_dml_allowlist'));
    expect(await attempt('', 'none')).toEqual(failed('acc_s15_existing_dml_allowlist'));
    expect(await attempt('create temp table accounting_s15_baseline(payload jsonb) on commit drop', 'none')).toEqual(failed('acc_s15_existing_dml_allowlist'));
  });

  test('FREQ-575-AC-01: S15末尾assertは比べる元の後に受け取りの行が増えると55000とDETAIL=acc_s15_receipt_backfillで拒む', async () => {
    const p = await seedReturnRefundParents(db());
    await db().query('set constraints all immediate');
    expect(await attempt()).toBeNull();
    expect(await attempt(`insert into public.order_return_receipts (return_id, request_key, request_fingerprint, kind)
      values ('${p.returnId}', gen_random_uuid(), 'f', 'reopen')`)).toEqual(failed('acc_s15_receipt_backfill'));
  });

  const replaceBody = (signature: string, from: string, to: string) =>
    `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), ${from}, ${to}); end $x$`;
  const detailValid = 'private.accounting_pending_detail_valid(text,jsonb)';
  test.each([
    ['alter table public.accounting_refund_events add column acc_probe text', 'acc_s15_tables'],
    ['alter table public.accounting_refund_facts alter column fee_amount drop default', 'acc_s15_tables'],
    // S18 から受け取りが届いた日の事実（decided_on は空）を書き、コミットする試験の行が残るので、行に関わらず通る NOT NULL を外す改ざんにする
    ['alter table public.accounting_return_facts alter column seq drop not null', 'acc_s15_tables'],
    ['alter table public.order_return_arrival_corrections rename column new_on to new_on_x', 'acc_s15_tables'],
    ['alter table public.accounting_return_options alter column use_carrier_delivery_date set default true', 'acc_s15_tables'],
    ['alter table public.accounting_refund_events drop constraint accounting_refund_events_refund_state_key', 'acc_s15_constraints'],
    ['alter table public.accounting_refund_events drop constraint accounting_refund_events_decided_check', 'acc_s15_constraints'],
    ['alter table public.accounting_refund_events drop constraint accounting_refund_events_fact_seq_key', 'acc_s15_constraints'],
    ['alter table public.accounting_refund_facts drop constraint accounting_refund_facts_return_pre_shipment_check', 'acc_s15_constraints'],
    ['alter table public.accounting_refund_facts drop constraint accounting_refund_facts_event_id_fkey', 'acc_s15_constraints'],
    ['alter table public.accounting_return_facts drop constraint accounting_return_facts_decision_check', 'acc_s15_constraints'],
    ['alter table public.accounting_return_facts drop constraint accounting_return_facts_return_seq_key', 'acc_s15_constraints'],
    ['drop index public.accounting_return_facts_decision_receipt_key', 'acc_s15_constraints'],
    ['drop index public.accounting_return_facts_arrival_receipt_key', 'acc_s15_constraints'],
    ['alter table public.order_return_arrival_corrections drop constraint order_return_arrival_corrections_receipt_version_key', 'acc_s15_constraints'],
    ['alter table public.order_return_arrival_corrections drop constraint order_return_arrival_corrections_new_on_check', 'acc_s15_constraints'],
    ['alter table public.accounting_return_options drop constraint accounting_return_options_id_check', 'acc_s15_constraints'],
    ['alter table public.accounting_refund_transfer_adjusts drop constraint accounting_refund_transfer_adjusts_unit_fkey', 'acc_s15_constraints'],
    ['alter table public.accounting_unit_price_adjusts drop constraint accounting_unit_price_adjusts_amount_check', 'acc_s15_constraints'],
    ['alter table public.accounting_unit_price_adjusts add constraint acc_probe check (amount < 1000000000)', 'acc_s15_constraints'],
    ['alter table public.accounting_refund_events disable trigger accounting_refund_events_no_update_delete', 'acc_s15_immutable'],
    ['drop trigger accounting_return_facts_no_truncate on public.accounting_return_facts', 'acc_s15_immutable'],
    ['alter table public.accounting_unit_price_adjusts enable replica trigger accounting_unit_price_adjusts_no_update_delete', 'acc_s15_immutable'],
    ['create trigger acc_probe before update on public.accounting_return_options for each row execute function private.reject_accounting_mutation()', 'acc_s15_immutable'],
    ['alter table public.accounting_refund_facts disable row level security', 'acc_s15_rls_acl'],
    ['grant select on public.accounting_return_facts to authenticated', 'acc_s15_rls_acl'],
    ['grant insert on public.accounting_refund_events to service_role', 'acc_s15_rls_acl'],
    ['grant update (use_carrier_delivery_date) on public.accounting_return_options to service_role', 'acc_s15_rls_acl'],
    ['create policy acc_probe on public.order_return_arrival_corrections for select to authenticated using (true)', 'acc_s15_rls_acl'],
    ['revoke select on public.accounting_unit_price_adjusts from service_role', 'acc_s15_rls_acl'],
    ['alter table public.order_return_receipts alter column arrived_on drop not null', 'acc_s15_receipt_column'],
    ['alter table public.order_return_receipts alter column arrived_on set default current_date', 'acc_s15_receipt_column'],
    ['grant select (arrived_on) on public.order_return_receipts to anon', 'acc_s15_receipt_column'],
    ['alter table public.order_return_receipts disable trigger order_return_receipts_no_change', 'acc_s15_receipt_column'],
    [`alter table public.accounting_pending_events drop constraint accounting_pending_events_reason_check,
      add constraint accounting_pending_events_reason_check check (reason in ('no_order'))`, 'acc_s15_pending_reason_check'],
    ['alter table public.accounting_pending_events drop constraint accounting_pending_events_reason_check', 'acc_s15_pending_reason_check'],
    [replaceBody(detailValid, `'''unit_value_left'''`, `'''unit_value_gone'''`), 'acc_s15_pending_detail_valid'],
    [replaceBody(detailValid, `'''return_prior'', ''original'''`, `'''return_prior'''`), 'acc_s15_pending_detail_valid'],
    [`alter function ${detailValid} volatile`, 'acc_s15_pending_detail_valid'],
    [`grant execute on function ${detailValid} to service_role`, 'acc_s15_pending_detail_valid'],
    [`alter function ${detailValid} security invoker`, 'acc_s15_pending_detail_valid'],
    ['grant execute on function private.accounting_dispute_holds(uuid[]) to service_role', 'acc_s15_hold_tools'],
    ['alter function private.accounting_assert_no_dispute_hold(uuid[]) volatile', 'acc_s15_hold_tools'],
    [`create or replace function private.accounting_dispute_holds(_order_ids uuid[]) returns table(order_id uuid, dispute_id text)
      language sql stable security definer set search_path = '' as $$ select null::uuid, null::text where false $$`, 'acc_s15_hold_tools'],
    [`create function public.accounting_assert_no_dispute_hold(_order_ids uuid[]) returns void language sql set search_path = ''
      as $$ select $$`, 'acc_s15_hold_tools'],
    ['drop function private.accounting_assert_no_dispute_hold(uuid[])', 'acc_s15_hold_tools'],
    ['delete from public.accounting_return_options', 'acc_s15_existing_dml_allowlist'],
    ["select private.accounting_park_event('return_refund', 'order_refunds', 'tamper_1', null, 'no_order', '{}')", 'acc_s15_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s15_baseline', 'acc_s15_existing_dml_allowlist'],
    ["update pg_temp.accounting_s15_baseline set payload = payload - 'return_facts'", 'acc_s15_existing_dml_allowlist'],
    ["update pg_temp.accounting_s15_baseline set payload = jsonb_set(payload, '{refund_events}', '5')", 'acc_s15_existing_dml_allowlist'],
  ])('FREQ-576-AC-04: S15改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S16 (FREQ-578-AC-05): the fixed return fees are held at 0 by two CHECKs; no row is written.
const s16Assertion = accountingS16Section('FINAL_ASSERT');
const s16Body = accountingS16Section('BODY');
const s16Details = ['acc_s16_settings_checks', 'acc_s16_returns_checks', 'acc_s16_existing_dml_allowlist'];

describe('S16 source contract (no DB)', () => {
  test('FREQ-578-AC-05: S16はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S16_FILES).toHaveLength(1);
    expect(ACCOUNTING_S16_FILES[0] > ACCOUNTING_S15_FILES[0]).toBe(true);
    expect(s16Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s16Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s16Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s16Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s16Sql.trimEnd()).toMatch(/-- ACC_S16_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(s16Assertion).not.toBe('');
    expect([...new Set([...s16Assertion.matchAll(/'(acc_s16_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s16Details].sort());
    expect(s16Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s16Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
  });

  test('FREQ-578-AC-05: S16の本文は制約2つを足すだけで、行を書かず関数に触れず、割合の手数料を縛らない', () => {
    const statements = s16Body.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect([...statements.matchAll(/^ALTER TABLE ([\w.]+)\s+ADD CONSTRAINT (\w+) CHECK/gm)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['public.shop_return_settings acc_p3_fee_lock_settings', 'public.order_returns acc_p3_fee_lock_returns']);
    expect(statements.match(/;/g)).toHaveLength(2);
    expect(statements).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|FUNCTION|GRANT|REVOKE|DO)\b/);
    expect(statements).not.toContain('restocking');
    expect(statements).toMatch(/acc_p3_fee_lock_returns CHECK \([^;]*\) NOT VALID;/);
    expect(statements).not.toMatch(/acc_p3_fee_lock_settings CHECK \([^;]*\) NOT VALID;/);
  });
});

describeLocalDb('S16 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s16_assert');
    let failure: AssertFailure | null = null;
    try {
      if (change) await db().query(change);
      await db().query(s16Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s16_assert'); await db().query('release savepoint acc_s16_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });

  test('FREQ-578-AC-05: S16末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(s16Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
  });

  test.each([
    ['alter table public.shop_return_settings drop constraint acc_p3_fee_lock_settings', 'acc_s16_settings_checks'],
    [`alter table public.shop_return_settings drop constraint acc_p3_fee_lock_settings,
      add constraint acc_p3_fee_lock_settings check (shop_label_fee = 0 and exchange_fee = 0 and exchange_shipping_fee = 0)`, 'acc_s16_settings_checks'],
    [`alter table public.shop_return_settings drop constraint acc_p3_fee_lock_settings,
      add constraint acc_p3_fee_lock_settings check (shop_label_fee = 0 and exchange_fees_enabled = false and exchange_fee = 0
        and exchange_shipping_fee = 0) not valid`, 'acc_s16_settings_checks'],
    ['alter table public.shop_return_settings add constraint acc_probe check (restocking_fee_percent = 0) not valid', 'acc_s16_settings_checks'],
    ['alter table public.order_returns drop constraint acc_p3_fee_lock_returns', 'acc_s16_returns_checks'],
    [`alter table public.order_returns drop constraint acc_p3_fee_lock_returns,
      add constraint acc_p3_fee_lock_returns check (return_shipping_fee = 0 and exchange_fee = 0) not valid`, 'acc_s16_returns_checks'],
    ['alter table public.order_refunds add constraint acc_p3_fee_lock_probe check (true)', 'acc_s16_returns_checks'],
    ['delete from public.shop_return_settings', 'acc_s16_existing_dml_allowlist'],
  ])('FREQ-578-AC-05: S16改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S17 (FREQ-576-AC-05): the refund writers are rebuilt from their latest definitions; the final assert
// pins the new tools, the rebuilt functions' attributes and bodies, the group G writer list and the row counts.
const s17Assertion = accountingS17Section('FINAL_ASSERT');
const s17Details = ['acc_s17_functions', 'acc_s17_function_attrs', 'acc_s17_body_unchanged', 'acc_s17_g_allowlist_unchanged',
  'acc_s17_existing_dml_allowlist'];
const decideSig = '(uuid,uuid,text,text,uuid)';

describe('S17 source contract (no DB)', () => {
  test('FREQ-576-AC-05: S17はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S17_FILES).toHaveLength(1);
    expect(ACCOUNTING_S17_FILES[0] > ACCOUNTING_S16_FILES[0]).toBe(true);
    expect(s17Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s17Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s17Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s17Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s17Sql.trimEnd()).toMatch(/-- ACC_S17_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s17Assertion.matchAll(/'(acc_s17_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s17Details].sort());
    expect(s17Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s17Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s17Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });
});

describeLocalDb('S17 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** The baseline is pinned first, then the tamper and the assertion run against it. */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s17_assert');
    let failure: AssertFailure | null = null;
    try {
      // The migration reads the baseline and runs the assert under one search_path (the caller's).
      if (before) await db().query(before);
      // S17 の時点の書き手の一覧（H7）の中で流す（S18 が受け取りの署名を入れ替えた後も、その時点の一覧で比べる）
      await db().query(replaceAllowlistSql(H7_ALLOWLIST));
      await pinAccountingS17Baseline(db());
      if (change) await db().query(change);
      await db().query(s17Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s17_assert'); await db().query('release savepoint acc_s17_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;

  test('FREQ-576-AC-05: 作り直した関数の本文は囲みを除いて最新の定義と同じで、属性とACLが前と同じ（S17末尾assertは適用後の状態と呼出元search_pathを許す）', async () => {
    expect(s17Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['grant execute on function private.accounting_split_refund(uuid) to service_role', 'acc_s17_functions'],
    ['alter function private.accounting_record_refund_facts(uuid) security invoker', 'acc_s17_functions'],
    ['alter function private.accounting_release_allocations(text,integer) reset search_path', 'acc_s17_functions'],
    [`revoke execute on function private.admin_decide_refund_cancellation${decideSig} from service_role`, 'acc_s17_functions'],
    [`grant execute on function public.admin_decide_refund_cancellation${decideSig} to authenticated`, 'acc_s17_functions'],
    [`drop function public.admin_decide_refund_cancellation${decideSig}`, 'acc_s17_functions'],
    ['drop trigger accounting_unit_price_adjusts_sum on public.accounting_unit_price_adjusts', 'acc_s17_functions'],
    ['alter table public.accounting_unit_price_adjusts disable trigger accounting_unit_price_adjusts_sum', 'acc_s17_functions'],
    ['grant execute on function private.order_unit_shipped_slots(uuid) to service_role', 'acc_s17_function_attrs'],
    ['alter function private.accounting_unit_values(uuid,bigint) volatile', 'acc_s17_function_attrs'],
    ['alter function private.mark_order_refund_error(uuid,text,boolean) set search_path = public', 'acc_s17_function_attrs'],
    [redefine('private.mark_order_refund_error(uuid,text,boolean)', '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s17_body_unchanged'],
    [redefine('private.accounting_check_unit_allocation_sum()', 'ACC_P3_REPLACE_BEGIN 6', 'ACC_P3_REPLACE_BEGIN 0'), 'acc_s17_body_unchanged'],
    [redefine('private.record_group_g_refund_result(uuid,text,text,text,text,timestamp with time zone,text,text,text,text,uuid[],jsonb)',
      '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s17_body_unchanged'],
    ["update pg_temp.accounting_s17_baseline set payload = jsonb_set(payload, '{allowlist_md5}', '\"x\"')", 'acc_s17_g_allowlist_unchanged'],
    ['drop table pg_temp.accounting_s17_baseline', 'acc_s17_existing_dml_allowlist'],
    ["update pg_temp.accounting_s17_baseline set payload = payload - 'counts'", 'acc_s17_existing_dml_allowlist'],
    ["select private.accounting_park_event('return_refund', 'order_refunds', 's17_tamper', null, 'no_order', '{}')", 'acc_s17_existing_dml_allowlist'],
  ])('FREQ-576-AC-05: S17改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S18 (FREQ-576-AC-05): the receive writer gets the arrival date (17 arguments; the 16 argument form is
// dropped), admin_refund_return and the G writer list are rebuilt, and the arrival tools, writers and readers are added.
const s18Assertion = accountingS18Section('FINAL_ASSERT');
const s18Body = accountingS18Section('BODY');
const s18Details = ['acc_s18_functions', 'acc_s18_function_attrs', 'acc_s18_body_unchanged', 'acc_s18_receive_signature',
  'acc_s18_g_allowlist_replaced', 'acc_s18_rls_acl', 'acc_s18_existing_dml_allowlist'];
const RECEIVE_SIG_16 = RECEIVE_RETURN_16.slice('private.admin_receive_return'.length);
const RECEIVE_SIG_17 = RECEIVE_RETURN_17.slice('private.admin_receive_return'.length);
const REFUND_SIG = '(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)';

describe('S18 source contract (no DB)', () => {
  test('FREQ-576-AC-05: S18はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S18_FILES).toHaveLength(1);
    expect(ACCOUNTING_S18_FILES[0] > ACCOUNTING_S17_FILES[0]).toBe(true);
    expect(s18Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s18Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s18Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s18Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s18Sql.trimEnd()).toMatch(/-- ACC_S18_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s18Assertion.matchAll(/'(acc_s18_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s18Details].sort());
    expect(s18Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s18Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s18Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-576-AC-05: 新しい形の受け取りを作り、書き手の一覧を作り直してから、16の引数の古い形（public と private）を DROP する', () => {
    const create17 = s18Body.indexOf('CREATE FUNCTION private.admin_receive_return(');
    const createPublic17 = s18Body.indexOf('CREATE FUNCTION public.admin_receive_return(');
    const allowlist = s18Body.indexOf('CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()');
    const dropPublic = s18Body.indexOf(`DROP FUNCTION public.admin_receive_return${RECEIVE_SIG_16};`);
    const dropPrivate = s18Body.indexOf(`DROP FUNCTION private.admin_receive_return${RECEIVE_SIG_16};`);
    for (const index of [create17, createPublic17, allowlist, dropPublic, dropPrivate]) expect(index).toBeGreaterThan(0);
    expect(create17).toBeLessThan(allowlist);
    expect(createPublic17).toBeLessThan(allowlist);
    expect(allowlist).toBeLessThan(dropPublic);
    expect(dropPublic).toBeLessThan(dropPrivate);
    expect(s18Body).toContain('_restocking_fee_waived boolean DEFAULT false, _arrived_on date DEFAULT NULL');
    // 再送の指紋は、届いた日が NULL でない時だけ作り直す（NULL の時は前と同じ文字列）
    expect(s18Body).toContain("IF _arrived_on IS NOT NULL THEN\n    v_fp:=pg_catalog.md5(v_fp||':'||pg_catalog.to_char(_arrived_on,'YYYY-MM-DD'));\n  END IF;");
    // 書き手の一覧で置き換えるのは受け取りの1行だけ
    expect(s18Body.match(/-- ACC_P3_REPLACE_BEGIN /g)).toHaveLength(1);
    expect(s18Body).toContain(`'${RECEIVE_RETURN_17}',`);
    expect(P3_ALLOWLIST).toHaveLength(77);
    expect(P3_ALLOWLIST.filter((entry, i) => entry !== UB_REFUNDS_ALLOWLIST[i])).toEqual([RECEIVE_RETURN_17]);
  });
});

describeLocalDb('S18 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const s18Allowlist = s18Body.match(/^CREATE OR REPLACE FUNCTION private\.group_g_writer_allowlist\(\)[\s\S]*?^\$\$;/m)?.[0] ?? '';
  const s18Drops = (s18Body.match(/^DROP FUNCTION (?:public|private)\.admin_receive_return\(.*\);$/gm) ?? []).join('\n');

  /**
   * S18 の前の形（16の引数の受け取りの組と移行 D の一覧）を17の引数の組の横に立てて控えを取り、移行の本文の一覧の作り直しと
   * 古い形の DROP を流してから、改ざんと末尾の確かめを流す。
   */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s18_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await restorePreS18Receive(db(), { dropNew: false });
      await pinAccountingS18Baseline(db());
      await db().query(s18Allowlist);
      await db().query(s18Drops);
      if (change) await db().query(change);
      await db().query(s18Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s18_assert'); await db().query('release savepoint acc_s18_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;

  test('FREQ-576-AC-05: 作り直した2本の本文は囲みを除いて最新の定義と同じで、属性とACLが前と同じ（受け取りの引数は1つ増えた期待。S18末尾assertは適用後の状態と呼出元search_pathを許す）', async () => {
    expect(s18Assertion).not.toBe('');
    expect(s18Allowlist).not.toBe('');
    expect(s18Drops.split('\n')).toHaveLength(2);
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test('FREQ-576-AC-05: G の書き手の一覧の admin_receive_return は新しい形で、本数は77のまま、古い形の関数は private にも public にも無い', async () => {
    const same = (await db().query('select private.group_g_writer_allowlist() = $1::text[]::regprocedure[] as same, cardinality(private.group_g_writer_allowlist()) as n',
      [P3_ALLOWLIST])).rows[0];
    expect(same).toEqual({ same: true, n: 77 });
    const forms = (await db().query(`select n.nspname, p.pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'admin_receive_return' order by n.nspname`)).rows;
    expect(forms.map((f) => [f.nspname, f.pronargs])).toEqual([['private', 17], ['public', 17]]);
    expect((await db().query(`select to_regprocedure('private.admin_receive_return${RECEIVE_SIG_16}') is null
      and to_regprocedure('public.admin_receive_return${RECEIVE_SIG_16}') is null as gone`)).rows[0].gone).toBe(true);
  });

  test.each([
    ['grant execute on function private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer) to service_role', 'acc_s18_functions'],
    ['alter function private.accounting_assert_arrival_date(uuid,uuid,date) security invoker', 'acc_s18_functions'],
    ['alter function private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer) reset search_path', 'acc_s18_functions'],
    ['revoke execute on function public.get_return_arrival_info(uuid[]) from service_role', 'acc_s18_functions'],
    ['grant execute on function public.admin_correct_return_arrival_date(uuid,uuid,date,text,integer,uuid) to authenticated', 'acc_s18_functions'],
    ['drop function public.get_return_carrier_arrival(uuid)', 'acc_s18_functions'],
    [`create function public.admin_receive_return${RECEIVE_SIG_16} returns void language sql set search_path = '' as $f$ select null::void $f$`, 'acc_s18_receive_signature'],
    [`alter function private.admin_receive_return${RECEIVE_SIG_17} rename to admin_receive_return_x`, 'acc_s18_receive_signature'],
    [`alter function public.admin_receive_return${RECEIVE_SIG_17} stable`, 'acc_s18_function_attrs'],
    [`revoke execute on function private.admin_receive_return${RECEIVE_SIG_17} from service_role`, 'acc_s18_function_attrs'],
    [`alter function private.admin_refund_return${REFUND_SIG} set search_path = public`, 'acc_s18_function_attrs'],
    [redefine(`private.admin_refund_return${REFUND_SIG}`, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s18_body_unchanged'],
    [redefine(`private.admin_receive_return${RECEIVE_SIG_17}`, 'v_free_by_variant jsonb;', 'v_free_by_variant jsonb; v_probe integer;'), 'acc_s18_body_unchanged'],
    [redefine('private.group_g_writer_allowlist()', 'ACC_P3_REPLACE_BEGIN b', 'ACC_P3_REPLACE_BEGIN 0'), 'acc_s18_body_unchanged'],
    ["update pg_temp.accounting_s18_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s18_g_allowlist_replaced'],
    ["update pg_temp.accounting_s18_baseline set payload = jsonb_set(payload, '{receive16}', '1')", 'acc_s18_g_allowlist_replaced'],
    ['alter table public.accounting_return_facts disable row level security', 'acc_s18_rls_acl'],
    ['grant select on public.order_return_arrival_corrections to authenticated', 'acc_s18_rls_acl'],
    ['update public.accounting_return_options set version = version + 1', 'acc_s18_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s18_baseline', 'acc_s18_existing_dml_allowlist'],
  ])('FREQ-576-AC-05: S18改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S19 (FREQ-576-AC-05 / FREQ-580-AC-02): the shipment slip confirm gets one dispute hold line; nothing else changes.
const s19Assertion = accountingS19Section('FINAL_ASSERT');
const s19Body = accountingS19Section('BODY');
const s19Details = ['acc_s19_function_attrs', 'acc_s19_body_unchanged', 'acc_s19_g_allowlist_unchanged', 'acc_s19_existing_dml_allowlist'];
const CONFIRM_SIG = '(uuid,integer,text,text,date,boolean,uuid,uuid)';
const p2Path = path.join(process.cwd(), 'supabase/migrations/20261108150000_accounting_p2_posting_tables.sql');
const confirmOf = (source: string) => source.match(/^CREATE OR REPLACE FUNCTION private\.admin_confirm_shipment_slip\([\s\S]*?^\$\$;/m)?.[0] ?? '';
const withoutBlocks = (source: string) => source.replace(/ *-- ACC_P[0-9]_BEGIN[\s\S]*?-- ACC_P[0-9]_END\n/g, '');

describe('S19 source contract (no DB)', () => {
  test('FREQ-576-AC-05: S19はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S19_FILES).toHaveLength(1);
    expect(ACCOUNTING_S19_FILES[0] > ACCOUNTING_S18_FILES[0]).toBe(true);
    expect(s19Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s19Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s19Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s19Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s19Sql.trimEnd()).toMatch(/-- ACC_S19_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s19Assertion.matchAll(/'(acc_s19_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s19Details].sort());
    expect(s19Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s19Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s19Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-576-AC-05: 確定の関数の本文は計画2の定義の写しに、囲み1つ（判断待ちの止め1行）を足しただけ', () => {
    const latest = confirmOf(fs.readFileSync(p2Path, 'utf8'));
    const rebuilt = confirmOf(s19Body);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    const marker = '  -- (1) every order is paid\n';
    expect(rebuilt.split(marker)).toHaveLength(2);
    const added = '  -- ACC_P3_BEGIN\n  PERFORM private.accounting_assert_no_dispute_hold(v_orders);\n  -- ACC_P3_END\n';
    expect(rebuilt).toBe(latest.replace(marker, added + marker));
    // 止めは再送の枝（v_existing）より後で、注文の存在の確かめの後、「(1) every order is paid」の前
    expect(rebuilt.indexOf('RETURN v_existing.result')).toBeGreaterThan(0);
    expect(rebuilt.indexOf('RETURN v_existing.result')).toBeLessThan(rebuilt.indexOf(added));
    expect(rebuilt).toContain(`<> pg_catalog.cardinality(v_items) THEN\n    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';\n  END IF;\n${added}${marker}`);
    expect(withoutBlocks(rebuilt)).toBe(withoutBlocks(latest));
    // 作り直すのは確定の関数1本だけ（公開の入口も取り消しの関数も触らない）
    expect(s19Body.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(s19Body).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });
});

describeLocalDb('S19 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** 適用後の状態から控えを取り直し、改ざんと末尾の確かめを流す。 */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s19_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await pinAccountingS19Baseline(db());
      if (change) await db().query(change);
      await db().query(s19Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s19_assert'); await db().query('release savepoint acc_s19_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;

  test('FREQ-576-AC-05: 確定の関数の本文は囲みを除いて最新の定義と同じで、属性とACLが前と同じ（呼出元のsearch_pathを問わない）', async () => {
    expect(s19Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test('FREQ-576-AC-05: G の書き手の一覧は S18 の後の一覧（77本）のまま', async () => {
    const same = (await db().query('select private.group_g_writer_allowlist() = $1::text[]::regprocedure[] as same, cardinality(private.group_g_writer_allowlist()) as n',
      [P3_ALLOWLIST])).rows[0];
    expect(same).toEqual({ same: true, n: 77 });
  });

  test.each([
    [`alter function public.admin_confirm_shipment_slip${CONFIRM_SIG} security definer`, 'acc_s19_function_attrs'],
    [`alter function private.admin_confirm_shipment_slip${CONFIRM_SIG} set search_path = public`, 'acc_s19_function_attrs'],
    [`alter function private.admin_confirm_shipment_slip${CONFIRM_SIG} stable`, 'acc_s19_function_attrs'],
    [`grant execute on function private.admin_confirm_shipment_slip${CONFIRM_SIG} to authenticated`, 'acc_s19_function_attrs'],
    [`revoke execute on function public.admin_confirm_shipment_slip${CONFIRM_SIG} from service_role`, 'acc_s19_function_attrs'],
    [redefine(`private.admin_confirm_shipment_slip${CONFIRM_SIG}`, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s19_body_unchanged'],
    [redefine(`private.admin_confirm_shipment_slip${CONFIRM_SIG}`, 'PERFORM private.accounting_assert_no_dispute_hold\\\\(v_orders\\\\);', 'NULL;'), 'acc_s19_body_unchanged'],
    [redefine(`private.admin_confirm_shipment_slip${CONFIRM_SIG}`, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_BEGIN\\n  -- ACC_P3_END\\n  -- ACC_P3_BEGIN\\n'), 'acc_s19_body_unchanged'],
    [redefine(`private.admin_confirm_shipment_slip${CONFIRM_SIG}`, 'v_verdict text;', 'v_verdict text; v_probe integer;'), 'acc_s19_body_unchanged'],
    ["update pg_temp.accounting_s19_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s19_g_allowlist_unchanged'],
    ["update pg_temp.accounting_s19_baseline set payload = payload - 'allowlist'", 'acc_s19_existing_dml_allowlist'],
    ["update pg_temp.accounting_s19_baseline set payload = jsonb_set(payload, '{counts,slips}', '999999')", 'acc_s19_existing_dml_allowlist'],
    ["update pg_temp.accounting_s19_baseline set payload = jsonb_set(payload, '{counts,operations}', '999999')", 'acc_s19_existing_dml_allowlist'],
    ['drop table pg_temp.accounting_s19_baseline', 'acc_s19_existing_dml_allowlist'],
  ])('FREQ-576-AC-05: S19改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S20 (FREQ-562-AC-05 / FREQ-577 / FREQ-579): the refund posting, the bank transfer, the settle table and the
// rebuilt posting entry point.
const s20Assertion = accountingS20Section('FINAL_ASSERT');
const s20Body = accountingS20Section('BODY');
const s20Details = ['acc_s20_tables', 'acc_s20_functions', 'acc_s20_function_attrs', 'acc_s20_run_posting', 'acc_s20_reads_stable',
  'acc_s20_rls_acl', 'acc_s20_existing_dml_allowlist'];
const p2DisputePath = path.join(process.cwd(), 'supabase/migrations/20261108200000_accounting_p2_dispute_posting.sql');
const runPostingOf = (source: string) => ([...source.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION private\.accounting_run_posting\([\s\S]*?^\$\$;/gm)].at(-1)?.[0] ?? '')
  .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE FUNCTION');
const SETTLE_SIG = '(uuid,uuid,uuid,uuid)';

describe('S20 source contract (no DB)', () => {
  test('FREQ-562-AC-05: S20はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S20_FILES).toHaveLength(1);
    expect(ACCOUNTING_S20_FILES[0] > ACCOUNTING_S19_FILES[0]).toBe(true);
    expect(s20Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s20Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s20Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s20Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s20Sql.trimEnd()).toMatch(/-- ACC_S20_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s20Assertion.matchAll(/'(acc_s20_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s20Details].sort());
    expect(s20Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s20Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s20Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-562-AC-05: 係の入口の本文は計画2の最新の定義の写しに、囲み2つ（返金の係の変数と呼び出し）と戻りの置き換え1つを足しただけ', () => {
    const latest = runPostingOf(fs.readFileSync(p2DisputePath, 'utf8'));
    const rebuilt = runPostingOf(s20Body);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    const replaced = rebuilt.match(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/);
    expect(replaced).not.toBeNull();
    const original = latest.match(/^ {2}RETURN pg_catalog\.jsonb_build_object\([\s\S]*?>= _limit\);\n/m)?.[0] ?? '';
    expect(createHash('md5').update(original).digest('hex')).toBe(replaced![1]);
    const restored = rebuilt.replace(replaced![0], original).replace(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g, '');
    expect(restored).toBe(latest);
    expect(rebuilt.match(/-- ACC_P3_BEGIN\n/g)).toHaveLength(2);
    // 返金の係は Stripe の後・取り消し（dispute）の前に呼び、戻りに refunds と returns（0）が入る
    expect(rebuilt.indexOf('accounting_post_stripe_events(_limit)')).toBeLessThan(rebuilt.indexOf('accounting_post_refund_events(_limit)'));
    expect(rebuilt.indexOf('accounting_post_refund_events(_limit)')).toBeLessThan(rebuilt.indexOf('accounting_post_dispute_events(_limit)'));
    expect(replaced![2]).toContain("'refunds', (v_refunds ->> 'posted')::integer, 'returns', 0,");
    expect(s20Body).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });
});

describeLocalDb('S20 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** 適用後の状態から控えを取り直し、改ざんと末尾の確かめを流す。 */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s20_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      // S21 rebuilt the entry point; the S20 assert checks the S20 body, so put it back inside this savepoint first.
      await restoreS20RunPosting(db());
      await pinAccountingS20Baseline(db());
      if (change) await db().query(change);
      await db().query(s20Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s20_assert'); await db().query('release savepoint acc_s20_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;

  test('FREQ-562-AC-05: 適用後の状態で S20 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s20Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s20_baseline', 'acc_s20_existing_dml_allowlist'],
    ["update pg_temp.accounting_s20_baseline set payload = payload - 'attrs'", 'acc_s20_existing_dml_allowlist'],
    ["update pg_temp.accounting_s20_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s20_existing_dml_allowlist'],
    ["update pg_temp.accounting_s20_baseline set payload = jsonb_set(payload, '{counts,period_requests}', '999999')", 'acc_s20_existing_dml_allowlist'],
    ["update pg_temp.accounting_s20_baseline set payload = jsonb_set(payload, '{counts,settlements}', '999999')", 'acc_s20_existing_dml_allowlist'],
    ["update pg_temp.accounting_s20_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s20_existing_dml_allowlist'],
    ['alter table public.accounting_refund_settlements disable trigger accounting_refund_settlements_no_update_delete', 'acc_s20_tables'],
    ['alter table public.accounting_refund_settlements add column probe integer', 'acc_s20_tables'],
    ['alter table public.accounting_refund_settlements drop constraint accounting_refund_settlements_paying_refund_id_key', 'acc_s20_tables'],
    ['grant select on public.accounting_refund_settlements to authenticated', 'acc_s20_rls_acl'],
    ['grant insert on public.accounting_refund_settlements to service_role', 'acc_s20_rls_acl'],
    ['create policy acc_s20_probe on public.accounting_refund_settlements for select using (true)', 'acc_s20_rls_acl'],
    ['grant execute on function private.accounting_post_refund_events(integer) to service_role', 'acc_s20_functions'],
    [`alter function private.admin_settle_owed_by_refund${SETTLE_SIG} security invoker`, 'acc_s20_functions'],
    [`grant execute on function public.admin_settle_owed_by_refund${SETTLE_SIG} to authenticated`, 'acc_s20_functions'],
    ['alter function private.accounting_refund_wait(uuid,text) set search_path = public', 'acc_s20_functions'],
    ['alter function private.accounting_run_posting(integer) set search_path = public', 'acc_s20_function_attrs'],
    ['revoke execute on function public.accounting_run_posting(integer) from service_role', 'acc_s20_function_attrs'],
    [redefine('private.accounting_run_posting(integer)', '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s20_run_posting'],
    [redefine('private.accounting_run_posting(integer)', "''returns'', 0,", "''returns'', 1,"), 'acc_s20_run_posting'],
    [redefine('private.accounting_run_posting(integer)', '-- ACC_P3_BEGIN\\n', '-- ACC_P3_BEGIN\\n-- ACC_P3_END\\n-- ACC_P3_BEGIN\\n'), 'acc_s20_run_posting'],
    ['alter function private.list_refund_accounting_states(integer,timestamptz,uuid) volatile', 'acc_s20_reads_stable'],
  ])('FREQ-562-AC-05: S20改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S21 (FREQ-578 / FREQ-576-AC-03 / FREQ-562-AC-05 / FREQ-569-AC-01): the return poster, the trace read and
// the posting entry point that now calls the return poster.
const s21Assertion = accountingS21Section('FINAL_ASSERT');
const s21Body = accountingS21Section('BODY');
const s21Details = ['acc_s21_functions', 'acc_s21_function_attrs', 'acc_s21_run_posting', 'acc_s21_reads_stable',
  'acc_s21_existing_dml_allowlist'];

describe('S21 source contract (no DB)', () => {
  test('FREQ-562-AC-05: S21はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S21_FILES).toHaveLength(1);
    expect(ACCOUNTING_S21_FILES[0] > ACCOUNTING_S20_FILES[0]).toBe(true);
    expect(s21Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s21Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s21Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s21Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s21Sql.trimEnd()).toMatch(/-- ACC_S21_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s21Assertion.matchAll(/'(acc_s21_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s21Details].sort());
    expect(s21Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s21Assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s21Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
  });

  test('FREQ-562-AC-05: 係の入口の本文は S20 の定義の写しに、囲み2つ（返品の係の変数と呼び出し）を足し、置き換えの中を返品の係を数える形に変えただけ', () => {
    const s20 = runPostingOf(s20Body);
    const rebuilt = runPostingOf(s21Body);
    expect(s20).not.toBe('');
    expect(rebuilt).not.toBe('');
    const replaceOf = (text: string) => text.match(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n[\s\S]*?-- ACC_P3_REPLACE_END\n/);
    const s20Replace = replaceOf(s20);
    const s21Replace = replaceOf(rebuilt);
    expect(s21Replace![1]).toBe(s20Replace![1]);
    const added = [...rebuilt.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]).filter((b) => b.includes('v_returns'));
    expect(added).toEqual(['-- ACC_P3_BEGIN\n  v_returns jsonb;\n-- ACC_P3_END\n',
      '-- ACC_P3_BEGIN\n  v_returns := private.accounting_post_return_events(_limit);\n-- ACC_P3_END\n']);
    let restored = rebuilt.replace(s21Replace![0], () => s20Replace![0]);
    for (const block of added) restored = restored.replace(block, '');
    expect(restored).toBe(s20);
    expect(rebuilt.match(/-- ACC_P3_BEGIN\n/g)).toHaveLength(4);
    // 返品の係は Stripe の後・返金の前に呼び、戻りの returns は返品の係の posted
    expect(rebuilt.indexOf('accounting_post_stripe_events(_limit)')).toBeLessThan(rebuilt.indexOf('accounting_post_return_events(_limit)'));
    expect(rebuilt.indexOf('accounting_post_return_events(_limit)')).toBeLessThan(rebuilt.indexOf('accounting_post_refund_events(_limit)'));
    expect(s21Replace![0]).toContain("'refunds', (v_refunds ->> 'posted')::integer, 'returns', (v_returns ->> 'posted')::integer,");
    // The S21 replaced text differs from S20's only by the v_returns terms.
    const strip = (text: string) => text.replace(/\+ \(v_returns ->> '[a-z_]+'\)::integer/g, '').replace(/\s+/g, '');
    expect(strip(s21Replace![0].replace("'returns', (v_returns ->> 'posted')::integer,", "'returns', 0,"))).toBe(strip(s20Replace![0]));
    expect(s21Body).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });
});

describeLocalDb('S21 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** 適用後の状態から控えを取り直し、改ざんと末尾の確かめを流す。 */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s21_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await pinAccountingS21Baseline(db());
      if (change) await db().query(change);
      await db().query(s21Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s21_assert'); await db().query('release savepoint acc_s21_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;

  test('FREQ-562-AC-05: 適用後の状態で S21 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s21Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s21_baseline', 'acc_s21_existing_dml_allowlist'],
    ["update pg_temp.accounting_s21_baseline set payload = payload - 'attrs'", 'acc_s21_existing_dml_allowlist'],
    ["update pg_temp.accounting_s21_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s21_existing_dml_allowlist'],
    ["update pg_temp.accounting_s21_baseline set payload = jsonb_set(payload, '{counts,return_facts}', '999999')", 'acc_s21_existing_dml_allowlist'],
    ["update pg_temp.accounting_s21_baseline set payload = jsonb_set(payload, '{counts,corrections}', '999999')", 'acc_s21_existing_dml_allowlist'],
    ["update pg_temp.accounting_s21_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s21_existing_dml_allowlist'],
    ['grant execute on function private.accounting_post_return_events(integer) to service_role', 'acc_s21_functions'],
    ['alter function private.accounting_return_lines(text,uuid,bigint,bigint) security invoker', 'acc_s21_functions'],
    ['alter function private.accounting_post_return_events(integer) set search_path = public', 'acc_s21_functions'],
    ['grant execute on function public.get_return_journal_trace(uuid) to authenticated', 'acc_s21_functions'],
    ['revoke execute on function public.get_return_journal_trace(uuid) from service_role', 'acc_s21_functions'],
    ['alter function private.accounting_run_posting(integer) set search_path = public', 'acc_s21_function_attrs'],
    ['revoke execute on function public.accounting_run_posting(integer) from service_role', 'acc_s21_function_attrs'],
    [redefine('private.accounting_run_posting(integer)', '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s21_run_posting'],
    [redefine('private.accounting_run_posting(integer)', "''returns'', \\\\(v_returns ->> ''posted''\\\\)::integer,", "''returns'', 0,"), 'acc_s21_run_posting'],
    [redefine('private.accounting_run_posting(integer)', '-- ACC_P3_BEGIN\\n', '-- ACC_P3_BEGIN\\n-- ACC_P3_END\\n-- ACC_P3_BEGIN\\n'), 'acc_s21_run_posting'],
    [redefine('private.accounting_run_posting(integer)', '  v_returns := private.accounting_post_return_events\\\\(_limit\\\\);\\n', ''), 'acc_s21_run_posting'],
    ['alter function public.get_return_journal_trace(uuid) volatile', 'acc_s21_reads_stable'],
  ])('FREQ-562-AC-05: S21改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});
