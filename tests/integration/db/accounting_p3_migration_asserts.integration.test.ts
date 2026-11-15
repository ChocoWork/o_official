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
  restoreS15DetailValid,
  ACCOUNTING_S22_FILES, ACCOUNTING_S22_SQL as s22Sql, accountingS22Section, pinAccountingS22Baseline,
  ACCOUNTING_S23_FILES, ACCOUNTING_S23_SQL as s23Sql, accountingS23Section, pinAccountingS23Baseline,
  ACCOUNTING_S24_FILES, ACCOUNTING_S24_SQL as s24Sql, accountingS24Section, pinAccountingS24Baseline, restoreS23StripeReconciliation,
  ACCOUNTING_S25_FILES, ACCOUNTING_S25_SQL as s25Sql, accountingS25Section, pinAccountingS25Baseline,
  ACCOUNTING_S26_FILES, ACCOUNTING_S26_SQL as s26Sql, accountingS26Section, pinAccountingS26Baseline,
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
  /**
   * S17 が値段の直しの表に足した遅らせた制約トリガー（S15 の数の確かめの外）を、再生の savepoint の中でだけ外す。
   * S22 が作り直した detail の一覧も、同じ savepoint の中で S15 の本文へ戻す。
   */
  const dropS17Trigger = async () => {
    await db().query('drop trigger if exists accounting_unit_price_adjusts_sum on public.accounting_unit_price_adjusts');
    await restoreS15DetailValid(db());
  };

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

// Accounting plan 3 S22 (FREQ-581 / FREQ-568-AC-07 / FREQ-569-AC-01): the dispute poster of plan 2 rebuilt with the offset of
// the confirmed entry, and its three tools.
const s22Assertion = accountingS22Section('FINAL_ASSERT');
const s22Body = accountingS22Section('BODY');
const s22Details = ['acc_s22_functions', 'acc_s22_function_attrs', 'acc_s22_body_unchanged', 'acc_s22_existing_dml_allowlist'];
const disputePosterOf = (source: string) => (source.match(
  /^CREATE (?:OR REPLACE )?FUNCTION private\.accounting_post_dispute_events\(_limit integer DEFAULT 50\) RETURNS jsonb[\s\S]*?^\$\$;\n/m)?.[0] ?? '')
  .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE FUNCTION');

describe('S22 source contract (no DB)', () => {
  test('FREQ-581-AC-01: S22はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S22_FILES).toHaveLength(1);
    expect(ACCOUNTING_S22_FILES[0] > ACCOUNTING_S21_FILES[0]).toBe(true);
    expect(s22Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s22Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s22Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s22Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s22Sql.trimEnd()).toMatch(/-- ACC_S22_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s22Assertion.matchAll(/'(acc_s22_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s22Details].sort());
    expect(s22Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    // The original texts kept for the restore (dollar quoted) hold the plan-2 RAISE of the L part; the assert itself raises only 55000.
    expect(s22Assertion.replace(/\$acc_s22_o\d\$[\s\S]*?\$acc_s22_o\d\$/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s22Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    // Nothing is granted and no public function is made or rebuilt.
    expect(s22Body).not.toMatch(/\bGRANT\b/);
    expect(s22Body).not.toMatch(/FUNCTION public\./);
  });

  test('FREQ-581-AC-01: 取り消しの係の本文は計画2の最新の定義の写しに、囲み2つと置き換え4つを足しただけで、引かれた時の止め2つを外し、理由の字は確定の待ちに残る', () => {
    const latest = disputePosterOf(fs.readFileSync(p2DisputePath, 'utf8'));
    const rebuilt = disputePosterOf(s22Body);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    const replaced = [...rebuilt.matchAll(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/g)];
    expect(replaced).toHaveLength(4);
    // Each marker names the md5 of a run of whole lines of the plan-2 body that is there once; putting them back and dropping the
    // added blocks gives that body.
    const latestLines = [...latest.matchAll(/^.*\n/gm)].map((x) => x[0]);
    const originalOf = (hash: string) => {
      for (let i = 0; i < latestLines.length; i += 1) {
        let text = '';
        for (let j = i; j < latestLines.length; j += 1) {
          text += latestLines[j];
          if (createHash('md5').update(text).digest('hex') === hash) return text;
        }
      }
      return null;
    };
    let restored = rebuilt;
    const originals: string[] = [];
    for (const m of replaced) {
      const found = originalOf(m[1]);
      expect(found).not.toBeNull();
      expect(latest.split(found as string)).toHaveLength(2);
      originals.push(found as string);
      restored = restored.replace(m[0], () => found as string);
    }
    const added = [...restored.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]);
    expect(added).toHaveLength(2);
    for (const block of added) restored = restored.replace(block, '');
    expect(restored).toBe(latest);
    // The withdrawal holds are gone (the first marker replaces them with nothing) and the reason strings stay in the C wait.
    expect(replaced[0][2]).toBe('');
    expect(originals[0]).toContain("v_reason := 'dispute_refund_overlap';");
    expect(originals[0]).toContain("v_reason := 'dispute_return_refund_pending';");
    expect(rebuilt).not.toContain('public.stripe_refunds');
    expect(added[1]).toContain("v_reason := CASE v_why WHEN 'dispute_refund_overlap' THEN 'dispute_refund_overlap' ELSE 'dispute_return_refund_pending' END;");
    expect(rebuilt).toContain('private.accounting_dispute_offset_ready(v_dispute_id, v_order_id, v_date)');
    expect(rebuilt).toContain('private.accounting_dispute_offset_amounts(v_order_id, v_date, v_amount)');
    expect(rebuilt).toContain('private.accounting_dispute_reversal_targets(v_dispute_id, v_shipped)');
    expect(added[1]).toContain("v_detail := pg_catalog.jsonb_build_object('reason', 'return_closed_after_lost');");
  });

  test('FREQ-581-AC-05: detail の一覧と返品の係は最新の定義（S15・S21）の写しに、取り消しの確定の後の0円の終わりの理由2つを足しただけ', () => {
    const fnOf = (text: string, name: string) =>
      text.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;\\n`, 'm'))?.[0] ?? '';
    const s15Fn = fnOf(sql, 'accounting_pending_detail_valid');
    const s21Fn = fnOf(s21Sql, 'accounting_post_return_events');
    const detail = fnOf(s22Body, 'accounting_pending_detail_valid');
    const ret = fnOf(s22Body, 'accounting_post_return_events');
    expect([s15Fn, s21Fn, detail, ret].every((x) => x !== '')).toBe(true);
    // The detail list: one replaced line (md5 of the S15 line on the marker) that adds the two reasons.
    const m = [...detail.matchAll(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/g)];
    expect(m).toHaveLength(1);
    const original = "      IF (v_value #>> '{}') NOT IN ('shipping', 'units_sum', 'units_missing') THEN RETURN false; END IF;\n";
    expect(createHash('md5').update(original).digest('hex')).toBe(m[0][1]);
    expect(m[0][2]).toContain("'units_missing', 'dispute_lost', 'return_closed_after_lost'");
    expect(detail.replace(m[0][0], () => original)).toBe(s15Fn);
    expect(detail).not.toContain('-- ACC_P3_BEGIN');
    // The return poster: one added block, the dispute_lost park of a 0 yen close.
    const blocks = [...ret.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((x) => x[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("v_detail := pg_catalog.jsonb_build_object('reason', 'dispute_lost');");
    expect(ret).not.toContain('-- ACC_P3_REPLACE_BEGIN');
    expect(ret.replace(blocks[0], '').replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')).toBe(s21Fn);
  });
});

describeLocalDb('S22 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** 適用後の状態から控えを取り直し、改ざんと末尾の確かめを流す。 */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s22_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await pinAccountingS22Baseline(db());
      if (change) await db().query(change);
      await db().query(s22Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s22_assert'); await db().query('release savepoint acc_s22_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;
  const POSTER = 'private.accounting_post_dispute_events(integer)';
  const DETAIL_VALID = 'private.accounting_pending_detail_valid(text,jsonb)';
  const RETURN_POSTER = 'private.accounting_post_return_events(integer)';

  test('FREQ-581-AC-01: 適用後の状態で S22 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s22Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s22_baseline', 'acc_s22_existing_dml_allowlist'],
    ["update pg_temp.accounting_s22_baseline set payload = payload - 'attrs'", 'acc_s22_existing_dml_allowlist'],
    ["update pg_temp.accounting_s22_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s22_existing_dml_allowlist'],
    ["update pg_temp.accounting_s22_baseline set payload = jsonb_set(payload, '{counts,pending_events}', '999999')", 'acc_s22_existing_dml_allowlist'],
    ["update pg_temp.accounting_s22_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s22_existing_dml_allowlist'],
    ['grant execute on function private.accounting_dispute_offset_ready(text,uuid,date) to service_role', 'acc_s22_functions'],
    ['alter function private.accounting_dispute_offset_amounts(uuid,date,bigint) security invoker', 'acc_s22_functions'],
    ['alter function private.accounting_dispute_reversal_targets(text,bigint) volatile', 'acc_s22_functions'],
    ['alter function private.accounting_dispute_offset_ready(text,uuid,date) set search_path = public', 'acc_s22_functions'],
    [redefine('private.accounting_dispute_offset_amounts(uuid,date,bigint)', '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s22_functions'],
    [`alter function ${POSTER} set search_path = public`, 'acc_s22_function_attrs'],
    [`grant execute on function ${POSTER} to service_role`, 'acc_s22_function_attrs'],
    [redefine(POSTER, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s22_body_unchanged'],
    [redefine(POSTER, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_BEGIN\\n-- ACC_P3_END\\n-- ACC_P3_BEGIN\\n'), 'acc_s22_body_unchanged'],
    [redefine(POSTER, '-- ACC_P3_REPLACE_BEGIN [0-9a-f]{32}\\n', '-- ACC_P3_REPLACE_BEGIN 00000000000000000000000000000000\\n'), 'acc_s22_body_unchanged'],
    [redefine(POSTER, 'accounting_dispute_offset_ready\\\\(v_dispute_id, v_order_id, v_date\\\\)', 'accounting_dispute_offset_ready(v_dispute_id, NULL, v_date)'),
      'acc_s22_body_unchanged'],
    [redefine(POSTER, 'THEN\\n            SELECT r\\\\.ready', 'THEN\\n            PERFORM 1 FROM public.stripe_refunds;\\n            SELECT r.ready'), 'acc_s22_body_unchanged'],
    [redefine(POSTER, '.reason., .return_closed_after_lost.', "''reason'', ''units_missing''"), 'acc_s22_body_unchanged'],
    [`alter function ${DETAIL_VALID} volatile`, 'acc_s22_function_attrs'],
    [`grant execute on function ${DETAIL_VALID} to service_role`, 'acc_s22_function_attrs'],
    [`alter function ${RETURN_POSTER} set search_path = public`, 'acc_s22_function_attrs'],
    [redefine(DETAIL_VALID, ', .return_closed_after_lost.\\\\)', ')'), 'acc_s22_body_unchanged'],
    [redefine(DETAIL_VALID, '\\nBEGIN\\n', '\\nBEGIN\\n  v_number := 0;\\n'), 'acc_s22_body_unchanged'],
    [redefine(RETURN_POSTER, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_X\\n'), 'acc_s22_body_unchanged'],
    [redefine(RETURN_POSTER, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s22_body_unchanged'],
    [redefine(RETURN_POSTER, 'private\\\\.accounting_dispute_key\\\\(d\\\\.id, .confirmed., .lost.\\\\)', 'NULL'), 'acc_s22_body_unchanged'],
    ["update pg_temp.accounting_s22_baseline set payload = jsonb_set(payload, '{counts,lines}', '999999')", 'acc_s22_existing_dml_allowlist'],
    ['drop function private.accounting_dispute_reversal_targets(text,bigint)', 'acc_s22_functions'],
  ])('FREQ-581-AC-01: S22改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S23 (FREQ-582 / FREQ-583 / FREQ-578-AC-09): the intake, reconciliation, Stripe reconciliation and anomaly
// readers of plan 2 rebuilt to count the plan-3 entries, and the consumption tax refund reads.
const s23Assertion = accountingS23Section('FINAL_ASSERT');
const s23Body = accountingS23Section('BODY');
const s23Details = ['acc_s23_functions', 'acc_s23_function_attrs', 'acc_s23_body_unchanged', 'acc_s23_reads_stable',
  'acc_s23_existing_dml_allowlist'];
const p2IntakePath = path.join(process.cwd(), 'supabase/migrations/20261108210000_accounting_p2_intake_reads.sql');
const p2StripePath = path.join(process.cwd(), 'supabase/migrations/20261108180000_accounting_p2_stripe_posting.sql');
const s23FnOf = (text: string, name: string) =>
  (text.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;\\n`, 'm'))?.[0] ?? '')
    .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE FUNCTION');
/** [name, source path, replaced parts, added blocks] of the five rebuilt readers. */
const S23_REBUILT: Array<[string, string, number, number]> = [
  ['accounting_intake_events', p2IntakePath, 1, 2],
  ['get_intake_breakdown', p2IntakePath, 0, 3],
  ['get_intake_reconciliation', p2IntakePath, 3, 0],
  ['list_deferred_revenue_anomalies', p2IntakePath, 0, 1],
  ['get_stripe_balance_reconciliation', p2StripePath, 0, 1],
];

describe('S23 source contract (no DB)', () => {
  test('FREQ-582-AC-05: S23はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S23_FILES).toHaveLength(1);
    expect(ACCOUNTING_S23_FILES[0] > ACCOUNTING_S22_FILES[0]).toBe(true);
    expect(s23Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s23Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s23Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s23Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s23Sql.trimEnd()).toMatch(/-- ACC_S23_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s23Assertion.matchAll(/'(acc_s23_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s23Details].sort());
    expect(s23Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s23Assertion.replace(/\$acc_s23_o\d\$[\s\S]*?\$acc_s23_o\d\$/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s23Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    // The public entries of the rebuilt readers are not touched; only the two new reads get a public entry and a grant.
    expect([...s23Body.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)\(/gm)].map((m) => m[1]).sort())
      .toEqual(['get_consumption_tax_refund_totals', 'list_consumption_tax_refunds']);
    expect(s23Body.match(/^GRANT\b/gm)).toHaveLength(1);
    // No row is written by the body (the baseline pin is the only INSERT).
    expect(s23Body.replace(/\$\$[\s\S]*?\$\$/g, '').match(/^\s*(INSERT|UPDATE|DELETE)\b/gim)?.map((x) => x.trim())).toEqual(['INSERT']);
  });

  test.each(S23_REBUILT)('FREQ-582-AC-05: 作り直した %s の本文は計画2の最新の定義の写しに、置き換えと囲みを足しただけ', (name, source, replacedCount, addedCount) => {
    const latest = s23FnOf(fs.readFileSync(source, 'utf8'), name);
    const rebuilt = s23FnOf(s23Body, name);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    // No migration before S23 but the plan-2 one defines it (the plan-2 text is the latest definition).
    const dir = path.join(process.cwd(), 'supabase/migrations');
    const defining = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f < ACCOUNTING_S23_FILES[0])
      .filter((f) => new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\(`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(defining).toEqual([path.basename(source)]);
    const replaced = [...rebuilt.matchAll(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/g)];
    expect(replaced).toHaveLength(replacedCount);
    const latestLines = [...latest.matchAll(/^.*\n/gm)].map((x) => x[0]);
    const originalOf = (hash: string) => {
      for (let i = 0; i < latestLines.length; i += 1) {
        let text = '';
        for (let j = i; j < latestLines.length; j += 1) {
          text += latestLines[j];
          if (createHash('md5').update(text).digest('hex') === hash) return text;
        }
      }
      return null;
    };
    let restored = rebuilt;
    for (const m of replaced) {
      const found = originalOf(m[1]);
      expect(found).not.toBeNull();
      expect(latest.split(found as string)).toHaveLength(2);
      restored = restored.replace(m[0], () => found as string);
    }
    const added = [...restored.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]);
    expect(added).toHaveLength(addedCount);
    for (const block of added) restored = restored.replace(block, '');
    expect(restored).toBe(latest);
  });

  test('FREQ-582-AC-06: Stripe の照合の足した囲みは計画2の読み口の確かめが断る字（INSERT・UPDATE・DELETE・PERFORM・EXECUTE・TRUNCATE）を含まない', () => {
    const rebuilt = s23FnOf(s23Body, 'get_stripe_balance_reconciliation');
    const blocks = [...rebuilt.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("WHEN 'refund_principal' THEN");
    expect(rebuilt.slice(rebuilt.indexOf('AS $$'))).not.toMatch(/(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)/i);
  });
});

describeLocalDb('S23 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /** 適用後の状態から控えを取り直し、改ざんと末尾の確かめを流す。 */
  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s23_assert');
    let failure: AssertFailure | null = null;
    try {
      // S24 が Stripe の照合を作り直したので、S23 の確かめの前に S23 の本文へ戻す（この savepoint の中だけ）。
      await restoreS23StripeReconciliation(db());
      if (before) await db().query(before);
      await pinAccountingS23Baseline(db());
      if (change) await db().query(change);
      await db().query(s23Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s23_assert'); await db().query('release savepoint acc_s23_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;
  const INTAKE = 'private.accounting_intake_events(date,date)';
  const RECON = 'private.get_intake_reconciliation(date,date)';
  const BREAKDOWN = 'private.get_intake_breakdown(date,date)';
  const ANOMALIES = 'private.list_deferred_revenue_anomalies()';
  const STRIPE = 'private.get_stripe_balance_reconciliation(date)';
  const ROWS = 'private.accounting_tax_refund_rows(date,date)';
  const LIST = 'private.list_consumption_tax_refunds(date,date,integer,date,text)';
  const TOTALS = 'public.get_consumption_tax_refund_totals(date,date)';

  test('FREQ-582-AC-05: 適用後の状態で S23 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s23Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s23_baseline', 'acc_s23_existing_dml_allowlist'],
    ["update pg_temp.accounting_s23_baseline set payload = payload - 'attrs'", 'acc_s23_existing_dml_allowlist'],
    ["update pg_temp.accounting_s23_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s23_existing_dml_allowlist'],
    ["update pg_temp.accounting_s23_baseline set payload = jsonb_set(payload, '{counts,periods}', '999999')", 'acc_s23_existing_dml_allowlist'],
    ["update pg_temp.accounting_s23_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s23_existing_dml_allowlist'],
    [`grant execute on function ${ROWS} to service_role`, 'acc_s23_functions'],
    [`revoke execute on function ${LIST} from service_role`, 'acc_s23_functions'],
    [`grant execute on function ${TOTALS} to authenticated`, 'acc_s23_functions'],
    [`alter function ${LIST} security invoker`, 'acc_s23_functions'],
    [`alter function ${ROWS} set search_path = public`, 'acc_s23_functions'],
    ['drop function public.list_consumption_tax_refunds(date,date,integer,date,text)', 'acc_s23_functions'],
    [`alter function ${INTAKE} volatile`, 'acc_s23_function_attrs'],
    [`grant execute on function ${STRIPE} to anon`, 'acc_s23_function_attrs'],
    [`alter function ${ANOMALIES} set search_path = public`, 'acc_s23_function_attrs'],
    [`do $x$ begin execute regexp_replace(pg_get_functiondef('${INTAKE}'::regprocedure), 'refund_moves', 'moves_r', 'g'); end $x$`,
      'acc_s23_body_unchanged'],
    [redefine(INTAKE, '-- ACC_P3_REPLACE_BEGIN [0-9a-f]{32}\\n', '-- ACC_P3_REPLACE_BEGIN 00000000000000000000000000000000\\n'), 'acc_s23_body_unchanged'],
    [redefine(RECON, '\\nBEGIN\\n', '\\nBEGIN\\n  v_fee := 0;\\n'), 'acc_s23_body_unchanged'],
    [redefine(BREAKDOWN, "''post_shipment_refund'', v_post_refund", "''post_shipment_refund'', 0"), 'acc_s23_body_unchanged'],
    [redefine(BREAKDOWN, 'v_intake := v_payment', 'v_intake := 0 + v_payment'), 'acc_s23_body_unchanged'],
    [redefine(RECON, '-- ACC_P3_REPLACE_END\\n', '-- ACC_P3_REPLACE_END\\n-- ACC_P3_BEGIN\\n-- ACC_P3_END\\n'), 'acc_s23_body_unchanged'],
    [redefine(ANOMALIES, '.negative_balance.', "''negative''"), 'acc_s23_body_unchanged'],
    [redefine(STRIPE, 'WHEN .payout. THEN', "WHEN ''payout_x'' THEN"), 'acc_s23_body_unchanged'],
    [redefine(ROWS, 'l.order_id IS NOT NULL\\n', 'l.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.orders AS u WHERE u.user_id IS NULL AND false)\\n'),
      'acc_s23_reads_stable'],
    [`alter function ${ROWS} volatile`, 'acc_s23_functions'],
    [redefine(LIST, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s23_reads_stable'],
  ])('FREQ-582-AC-05: S23改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S24 (Ruling P3-T11a / P3-T11b; FREQ-569 / FREQ-581 / FREQ-582): a pending row closed by linking a manual entry,
// the wait of C that skips a 0 yen close parked for a person, and the Stripe reconciliation mark of a closed refund row.
const s24Assertion = accountingS24Section('FINAL_ASSERT');
const s24Body = accountingS24Section('BODY');
const s24Details = ['acc_s24_functions', 'acc_s24_function_attrs', 'acc_s24_body_unchanged', 'acc_s24_existing_dml_allowlist'];
const s24FnOf = (text: string, name: string) =>
  (text.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;\\n`, 'm'))?.[0] ?? '')
    .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE FUNCTION');
/** [name, source (the latest definition before S24), replaced parts, added blocks of S24 on top of the source]. */
const S24_REBUILT: Array<[string, string, number, number]> = [
  ['accounting_dispute_offset_ready', 'supabase/migrations/20261113090000_accounting_p3_dispute_offset.sql', 1, 0],
  ['get_stripe_balance_reconciliation', 'supabase/migrations/20261113100000_accounting_p3_intake_tax_reads.sql', 0, 1],
];

describe('S24 source contract (no DB)', () => {
  test('FREQ-569-AC-07: S24はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S24_FILES).toHaveLength(1);
    expect(ACCOUNTING_S24_FILES[0] > ACCOUNTING_S23_FILES[0]).toBe(true);
    expect(s24Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s24Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s24Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s24Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s24Sql.trimEnd()).toMatch(/-- ACC_S24_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s24Assertion.matchAll(/'(acc_s24_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s24Details].sort());
    expect(s24Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s24Assertion.replace(/\$acc_s24_o\d\$[\s\S]*?\$acc_s24_o\d\$/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s24Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    // Only the link function gets a public entry and a grant (service_role, private and public).
    expect([...s24Body.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)\(/gm)].map((m) => m[1])).toEqual(['admin_link_accounting_pending_entry']);
    expect(s24Body.match(/^GRANT\b/gm)).toHaveLength(1);
  });

  test.each(S24_REBUILT)('FREQ-569-AC-07: 作り直した %s の本文は最新の定義の写しに、置き換えと囲みを足しただけ', (name, source, replacedCount, addedCount) => {
    const latest = s24FnOf(fs.readFileSync(path.join(process.cwd(), source), 'utf8'), name);
    const rebuilt = s24FnOf(s24Body, name);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    // No migration between the source and S24 defines it again.
    const dir = path.join(process.cwd(), 'supabase/migrations');
    const defining = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f > path.basename(source) && f <= ACCOUNTING_S24_FILES[0])
      .filter((f) => new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\(`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(defining).toEqual([ACCOUNTING_S24_FILES[0]]);
    const replaced = [...rebuilt.matchAll(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/g)];
    expect(replaced).toHaveLength(replacedCount);
    const latestLines = [...latest.matchAll(/^.*\n/gm)].map((x) => x[0]);
    const originalOf = (hash: string) => {
      for (let i = 0; i < latestLines.length; i += 1) {
        let text = '';
        for (let j = i; j < latestLines.length; j += 1) {
          text += latestLines[j];
          if (createHash('md5').update(text).digest('hex') === hash) return text;
        }
      }
      return null;
    };
    let restored = rebuilt;
    for (const m of replaced) {
      const found = originalOf(m[1]);
      expect(found).not.toBeNull();
      expect(latest.split(found as string)).toHaveLength(2);
      restored = restored.replace(m[0], () => found as string);
    }
    // The blocks of the source stay; the blocks S24 adds are the ones that are not in the source.
    const blocks = (text: string) => [...text.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]);
    const added = blocks(restored).filter((b) => !latest.includes(b));
    expect(added).toHaveLength(addedCount);
    for (const block of added) restored = restored.replace(block, '');
    expect(restored).toBe(latest);
    expect(rebuilt.slice(rebuilt.indexOf('AS $$'))).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM|EXECUTE)\b|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
  });
});

describeLocalDb('S24 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s24_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await pinAccountingS24Baseline(db());
      if (change) await db().query(change);
      await db().query(s24Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s24_assert'); await db().query('release savepoint acc_s24_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;
  const LINK = 'private.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid)';
  const LINK_PUBLIC = 'public.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid)';
  const READY = 'private.accounting_dispute_offset_ready(text,uuid,date)';
  const STRIPE = 'private.get_stripe_balance_reconciliation(date)';

  test('FREQ-569-AC-07: 適用後の状態で S24 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s24Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s24_baseline', 'acc_s24_existing_dml_allowlist'],
    ["update pg_temp.accounting_s24_baseline set payload = payload - 'attrs'", 'acc_s24_existing_dml_allowlist'],
    ["update pg_temp.accounting_s24_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s24_existing_dml_allowlist'],
    ["update pg_temp.accounting_s24_baseline set payload = jsonb_set(payload, '{counts,pending_events}', '999999')", 'acc_s24_existing_dml_allowlist'],
    ["update pg_temp.accounting_s24_baseline set payload = jsonb_set(payload, '{counts,lines}', '999999')", 'acc_s24_existing_dml_allowlist'],
    ["update pg_temp.accounting_s24_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s24_existing_dml_allowlist'],
    [`grant execute on function ${LINK} to authenticated`, 'acc_s24_functions'],
    [`grant execute on function ${LINK_PUBLIC} to anon`, 'acc_s24_functions'],
    [`revoke execute on function ${LINK_PUBLIC} from service_role`, 'acc_s24_functions'],
    [`alter function ${LINK} security invoker`, 'acc_s24_functions'],
    [`alter function ${LINK} set search_path = public`, 'acc_s24_functions'],
    [`alter function ${LINK_PUBLIC} stable`, 'acc_s24_functions'],
    [`drop function ${LINK_PUBLIC}`, 'acc_s24_functions'],
    [`alter function ${READY} set search_path = public`, 'acc_s24_function_attrs'],
    [`grant execute on function ${READY} to service_role`, 'acc_s24_function_attrs'],
    [`grant execute on function ${STRIPE} to anon`, 'acc_s24_function_attrs'],
    [`alter function ${STRIPE} volatile`, 'acc_s24_function_attrs'],
    [redefine(READY, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s24_body_unchanged'],
    [redefine(READY, "p\\.detail ->> .reason. = .dispute_lost.", "p.detail ->> ''reason'' = ''dispute_lost_x''"), 'acc_s24_body_unchanged'],
    [redefine(READY, '-- ACC_P3_REPLACE_BEGIN [0-9a-f]{32}\\n', '-- ACC_P3_REPLACE_BEGIN 00000000000000000000000000000000\\n'), 'acc_s24_body_unchanged'],
    [redefine(READY, 'AND p\\.reason = .order_not_postable. ', 'AND true '), 'acc_s24_body_unchanged'],
    [redefine(READY, 'ready := true;', 'ready := false;'), 'acc_s24_body_unchanged'],
    [redefine(STRIPE, "pm\\.event_kind = .refund_failed.", "pm.event_kind = ''refund_failedx''"), 'acc_s24_body_unchanged'],
    [redefine(STRIPE, 'WHERE pm\\.resolved_at IS NOT NULL', 'WHERE true'), 'acc_s24_body_unchanged'],
    // 人の操作に限る印（resolved_by）が外されても、自動の閉じ（resolved_by が無い）を数える形に戻るので拒む
    [redefine(STRIPE, ' AND pm\\.resolved_by IS NOT NULL', ''), 'acc_s24_body_unchanged'],
    [redefine(STRIPE, '-- ACC_P3_BEGIN\\n          OR EXISTS', '-- ACC_P3_X\\n          OR EXISTS'), 'acc_s24_body_unchanged'],
    [redefine(STRIPE, 'WHEN .payout. THEN', "WHEN ''payout_x'' THEN"), 'acc_s24_body_unchanged'],
  ])('FREQ-569-AC-07: S24改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S25 (Ruling P3-T11e / P3-T11f; FREQ-579-AC-04 / FREQ-579-AC-05): the debt read with the unit event and the
// plain return debt, and the read of the refunds that can settle an owed refund.
const s25Assertion = accountingS25Section('FINAL_ASSERT');
const s25Body = accountingS25Section('BODY');
const s25Details = ['acc_s25_functions', 'acc_s25_function_attrs', 'acc_s25_body_unchanged', 'acc_s25_reads_stable', 'acc_s25_existing_dml_allowlist'];
const S25_SOURCE = 'supabase/migrations/20261112214341_accounting_p3_refund_posting.sql';
const s25FnOf = (text: string, name: string) =>
  (text.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;\n`, 'm'))?.[0] ?? '')
    .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE FUNCTION');

describe('S25 source contract (no DB)', () => {
  test('FREQ-579-AC-05: S25はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S25_FILES).toHaveLength(1);
    expect(ACCOUNTING_S25_FILES[0] > ACCOUNTING_S24_FILES[0]).toBe(true);
    expect(s25Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s25Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s25Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s25Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s25Sql.trimEnd()).toMatch(/-- ACC_S25_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s25Assertion.matchAll(/'(acc_s25_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s25Details].sort());
    expect(s25Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s25Assertion.replace(/\$acc_s25_o\d\$[\s\S]*?\$acc_s25_o\d\$/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s25Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    // Only the candidate read gets a public entry and a grant (service_role, private and public); the debt read keeps its own.
    expect([...s25Body.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)\(/gm)].map((m) => m[1])).toEqual(['list_refund_settle_candidates']);
    expect(s25Body.match(/^GRANT\b/gm)).toHaveLength(1);
    expect([...s25Body.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION ([a-z_.]+)\(/gm)].map((m) => m[1]))
      .toEqual(['private.list_refund_accounting_states', 'private.admin_record_refund_bank_transfer', 'private.list_refund_settle_candidates',
        'public.list_refund_settle_candidates']);
  });

  test.each([
    ['list_refund_accounting_states', 2, 1, true],
    ['admin_record_refund_bank_transfer', 0, 1, false],
  ])('FREQ-579-AC-04: 作り直した %s の本文は S20 の写しに、置き換え%i つと囲み%i つを足しただけ', (name, replacedCount, addedCount, readOnly) => {
    const latest = s25FnOf(fs.readFileSync(path.join(process.cwd(), S25_SOURCE), 'utf8'), name);
    const rebuilt = s25FnOf(s25Body, name);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    // No migration between S20 and S25 defines it again.
    const dir = path.join(process.cwd(), 'supabase/migrations');
    const defining = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f > path.basename(S25_SOURCE) && f <= ACCOUNTING_S25_FILES[0])
      .filter((f) => new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\(`, 'm').test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(defining).toEqual([ACCOUNTING_S25_FILES[0]]);
    const replaced = [...rebuilt.matchAll(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/g)];
    expect(replaced).toHaveLength(replacedCount);
    const latestLines = [...latest.matchAll(/^.*\n/gm)].map((x) => x[0]);
    const originalOf = (hash: string) => {
      for (let i = 0; i < latestLines.length; i += 1) {
        let text = '';
        for (let j = i; j < latestLines.length; j += 1) {
          text += latestLines[j];
          if (createHash('md5').update(text).digest('hex') === hash) return text;
        }
      }
      return null;
    };
    let restored = rebuilt;
    for (const m of replaced) {
      const found = originalOf(m[1]);
      expect(found).not.toBeNull();
      expect(latest.split(found as string)).toHaveLength(2);
      restored = restored.replace(m[0], () => found as string);
    }
    const blocks = [...restored.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)].map((m) => m[0]);
    expect(blocks).toHaveLength(addedCount);
    for (const block of blocks) restored = restored.replace(block, '');
    expect(restored).toBe(latest);
    if (readOnly) expect(rebuilt.slice(rebuilt.indexOf('AS $$'))).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM|EXECUTE)\b|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
  });
});

describeLocalDb('S25 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s25_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await pinAccountingS25Baseline(db());
      if (change) await db().query(change);
      await db().query(s25Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s25_assert'); await db().query('release savepoint acc_s25_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;
  const CAND = 'private.list_refund_settle_candidates(uuid)';
  const CAND_PUBLIC = 'public.list_refund_settle_candidates(uuid)';
  const STATES = 'private.list_refund_accounting_states(integer,timestamptz,uuid)';
  const STATES_PUBLIC = 'public.list_refund_accounting_states(integer,timestamptz,uuid)';
  const BANK = 'private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid)';
  const BANK_PUBLIC = 'public.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid)';

  test('FREQ-579-AC-05: 適用後の状態で S25 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s25Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s25_baseline', 'acc_s25_existing_dml_allowlist'],
    ["update pg_temp.accounting_s25_baseline set payload = payload - 'attrs'", 'acc_s25_existing_dml_allowlist'],
    ["update pg_temp.accounting_s25_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s25_existing_dml_allowlist'],
    ["update pg_temp.accounting_s25_baseline set payload = jsonb_set(payload, '{counts,pending_events}', '999999')", 'acc_s25_existing_dml_allowlist'],
    ["update pg_temp.accounting_s25_baseline set payload = jsonb_set(payload, '{counts,lines}', '999999')", 'acc_s25_existing_dml_allowlist'],
    ["update pg_temp.accounting_s25_baseline set payload = jsonb_set(payload, '{counts,settlements}', '999999')", 'acc_s25_existing_dml_allowlist'],
    ["update pg_temp.accounting_s25_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s25_existing_dml_allowlist'],
    [`grant execute on function ${CAND} to authenticated`, 'acc_s25_functions'],
    [`grant execute on function ${CAND_PUBLIC} to anon`, 'acc_s25_functions'],
    [`revoke execute on function ${CAND_PUBLIC} from service_role`, 'acc_s25_functions'],
    [`alter function ${CAND} security invoker`, 'acc_s25_functions'],
    [`alter function ${CAND} set search_path = public`, 'acc_s25_functions'],
    [`alter function ${CAND_PUBLIC} volatile`, 'acc_s25_functions'],
    [`alter function ${CAND} volatile`, 'acc_s25_functions'],
    [`drop function ${CAND_PUBLIC}`, 'acc_s25_functions'],
    [`alter function ${STATES} set search_path = public`, 'acc_s25_function_attrs'],
    [`grant execute on function ${STATES_PUBLIC} to anon`, 'acc_s25_function_attrs'],
    [`alter function ${STATES} volatile`, 'acc_s25_function_attrs'],
    [`alter function ${STATES_PUBLIC} volatile`, 'acc_s25_function_attrs'],
    [redefine(STATES, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s25_body_unchanged'],
    [redefine(STATES, '-- ACC_P3_REPLACE_BEGIN [0-9a-f]{32}\\n', '-- ACC_P3_REPLACE_BEGIN 00000000000000000000000000000000\\n'), 'acc_s25_body_unchanged'],
    [redefine(STATES, 'OR s\\.owed_return > 0', ''), 'acc_s25_body_unchanged'],
    [redefine(STATES, "\\'event_kind\\', q\\.event_kind, ", ''), 'acc_s25_body_unchanged'],
    [redefine(STATES, "\\'owed\\', \\'failed\\'", "\\'owed\\'"), 'acc_s25_body_unchanged'],
    [redefine(STATES, "\\'holdback_release\\', ", ''), 'acc_s25_body_unchanged'],
    [redefine(STATES, "\\'2130\\', \\'return_refund\\'", "\\'2130\\', \\'refund_owed_post\\'"), 'acc_s25_body_unchanged'],
    [redefine(STATES, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_X\\n'), 'acc_s25_body_unchanged'],
    [redefine(STATES, 'post_shipment_amount., 0.', 'pre_shipment_amount), 0)'), 'acc_s25_body_unchanged'],
    [redefine(STATES, "x2\\.source = \\'return\\'", "x2.source = \\'admin\\'"), 'acc_s25_body_unchanged'],
    [`alter function ${BANK} set search_path = public`, 'acc_s25_function_attrs'],
    [`grant execute on function ${BANK_PUBLIC} to anon`, 'acc_s25_function_attrs'],
    [`alter function ${BANK} stable`, 'acc_s25_function_attrs'],
    [redefine(BANK, "\\'ACCOUNTING_REFUND_IN_FLIGHT\\'", "\\'ACCOUNTING_REFUND_IN_FLIGHT_X\\'"), 'acc_s25_body_unchanged'],
    [redefine(BANK, "r\\.source = \\'return\\'", "r.source = \\'admin\\'"), 'acc_s25_body_unchanged'],
    [redefine(BANK, "IF _origin = \\'return\\'", "IF _origin = \\'post_shipment\\'"), 'acc_s25_body_unchanged'],
    [redefine(BANK, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_X\\n'), 'acc_s25_body_unchanged'],
    [redefine(BANK, 'v_hash := ', 'v_hash := null; v_hash := '), 'acc_s25_body_unchanged'],
    [redefine(STATES, 'ORDER BY s\\.created_at DESC', 'ORDER BY s.created_at ASC'), 'acc_s25_body_unchanged'],
    [redefine(CAND, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s25_reads_stable'],
    [redefine(CAND, 'WHERE s\\.owed_refund_id = _owed_refund_id', "WHERE s.owed_refund_id = _owed_refund_id AND s.request_hash <> \\'email\\'"), 'acc_s25_reads_stable'],
  ])('FREQ-579-AC-05: S25改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});

// Accounting plan 3 S26 (Ruling P3-F1, P3-F2, P3-F3; FREQ-579-AC-01 / FREQ-579-AC-05 / FREQ-578-AC-09): the final review fixes.
// Seven function bodies are rebuilt; no table, row, public entry or grant changes.
const s26Assertion = accountingS26Section('FINAL_ASSERT');
const s26Body = accountingS26Section('BODY');
const s26Details = ['acc_s26_function_attrs', 'acc_s26_body_unchanged', 'acc_s26_reads_stable', 'acc_s26_existing_dml_allowlist'];
const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationText = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
const s26FnOf = (text: string, name: string) =>
  (text.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\([\\s\\S]*?^\\$\\$;\n`, 'm'))?.[0] ?? '')
    .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE FUNCTION');

describe('S26 source contract (no DB)', () => {
  test('FREQ-579-AC-01: S26はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持ち、行を書かず公開の入口も権限も足さない', () => {
    expect(ACCOUNTING_S26_FILES).toHaveLength(1);
    expect(ACCOUNTING_S26_FILES[0] > ACCOUNTING_S25_FILES[0]).toBe(true);
    expect(s26Sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(s26Sql.startsWith('BEGIN;\n')).toBe(true);
    expect(s26Sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(s26Sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(s26Sql.trimEnd()).toMatch(/-- ACC_S26_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect([...new Set([...s26Assertion.matchAll(/'(acc_s26_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...s26Details].sort());
    expect(s26Assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(s26Assertion.replace(/\$acc_s26_o\d\$[\s\S]*?\$acc_s26_o\d\$/g, '')).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(s26Sql).not.toMatch(/(?:proacl|relacl|attacl)\s*::\s*text/i);
    expect([...s26Body.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION ([a-z_.]+)\(/gm)].map((m) => m[1])).toEqual([
      'private.accounting_record_return_arrival', 'private.accounting_record_return_decision', 'private.accounting_post_refund_events',
      'private.admin_settle_owed_by_refund', 'private.list_refund_settle_candidates', 'private.list_refund_accounting_states',
      'private.list_deferred_revenue_anomalies']);
    // No grant, no new table and no new function: the body is the rebuilt bodies and the baseline copy only.
    expect(s26Body).not.toMatch(/^(GRANT|REVOKE|ALTER FUNCTION|CREATE FUNCTION|CREATE TABLE|ALTER TABLE)\b/m);
    const statements26 = s26Body.replace(/\$\$[\s\S]*?\$\$/g, '$$$$').split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(statements26).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/);
    expect(statements26.match(/\bINSERT INTO\b/g)).toHaveLength(1);
  });

  test.each([
    ['accounting_record_return_arrival', 0, 1, '20261112200809_accounting_p3_return_writers.sql'],
    ['accounting_record_return_decision', 0, 1, '20261112200809_accounting_p3_return_writers.sql'],
    ['accounting_post_refund_events', 1, 0, '20261112214341_accounting_p3_refund_posting.sql'],
    ['admin_settle_owed_by_refund', 0, 1, '20261112214341_accounting_p3_refund_posting.sql'],
    ['list_refund_settle_candidates', 0, 2, '20261114100000_accounting_p3_refund_debt_reads.sql'],
    ['list_refund_accounting_states', 2, 1, '20261114100000_accounting_p3_refund_debt_reads.sql'],
    ['list_deferred_revenue_anomalies', 0, 1, '20261113100000_accounting_p3_intake_tax_reads.sql'],
  ])('FREQ-579-AC-01: 作り直した %s の本文は最新の定義の写しに、置き換え%i つと囲み%i つを足しただけ（S26）', (name, replacedCount, addedCount, source) => {
    const latest = s26FnOf(migrationText(source), name);
    const rebuilt = s26FnOf(s26Body, name);
    expect(latest).not.toBe('');
    expect(rebuilt).not.toBe('');
    // No migration between that definition and S26 defines it again.
    const defining = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > source && f <= ACCOUNTING_S26_FILES[0])
      .filter((f) => new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\(`, 'm').test(migrationText(f)));
    expect(defining).toEqual([ACCOUNTING_S26_FILES[0]]);
    const replaced = [...rebuilt.matchAll(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})\n([\s\S]*?)-- ACC_P3_REPLACE_END\n/g)];
    expect(replaced).toHaveLength(replacedCount);
    const latestLines = [...latest.matchAll(/^.*\n/gm)].map((x) => x[0]);
    const originalOf = (hash: string) => {
      for (let i = 0; i < latestLines.length; i += 1) {
        let text = '';
        for (let j = i; j < latestLines.length; j += 1) {
          text += latestLines[j];
          if (createHash('md5').update(text).digest('hex') === hash) return text;
        }
      }
      return null;
    };
    const stripBlocks = (text: string) => text.replace(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g, '');
    let restored = rebuilt;
    for (const m of replaced) {
      // A replaced part the latest definition already carries as the same marker stays; a new one is put back from the latest text.
      if (latest.includes(m[0])) continue;
      const found = originalOf(m[1]);
      expect(found).not.toBeNull();
      expect(latest.split(found as string)).toHaveLength(2);
      restored = restored.replace(m[0], () => found as string);
    }
    // The debt read and the anomalies keep the one block they had (edited inside); the others get the one new block.
    expect([...rebuilt.matchAll(/-- ACC_P3_BEGIN\n[\s\S]*?-- ACC_P3_END\n/g)]).toHaveLength(addedCount);
    expect(stripBlocks(restored)).toBe(stripBlocks(latest));
    if (['list_refund_settle_candidates', 'list_refund_accounting_states', 'list_deferred_revenue_anomalies'].includes(name)) {
      expect(rebuilt.slice(rebuilt.indexOf('AS $$'))).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM|EXECUTE)\b|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)/i);
    }
  });

  test('FREQ-579-AC-01: S26 の確かめに書いた md5 は、写した元の本文（囲みと空白を除く）の md5 と合い、置き換えの元の字の md5 も合う', () => {
    const digestOf = (text: string) => {
      const src = text.slice(text.indexOf('AS $$') + 'AS $$'.length, text.lastIndexOf('$$;'));
      return createHash('md5').update(src.replace(/-- ACC_P[0-9]_BEGIN[\s\S]*?-- ACC_P[0-9]_END/g, '').replace(/\s+/g, '')).digest('hex');
    };
    const originals = Object.fromEntries([...s26Assertion.matchAll(/\('([0-9a-f]{32})', \$acc_s26_o\d\$([\s\S]*?)\$acc_s26_o\d\$\)/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(originals)).toHaveLength(3);
    for (const [hash, text] of Object.entries(originals)) expect(createHash('md5').update(text).digest('hex')).toBe(hash);
    const restore = (text: string) =>
      text.replace(/-- ACC_P3_REPLACE_BEGIN ([0-9a-f]{32})[\s\S]*?-- ACC_P3_REPLACE_END/g, (_all, h: string) => originals[h].replace(/\n$/, ''));
    const rows = [...s26Assertion.matchAll(/\('(private\.[a-z_]+)\([^)]*\)', \d, \d, '([0-9a-f]{32})', (?:true|false),/g)];
    expect(rows).toHaveLength(7);
    for (const [, signature, digest] of rows) {
      expect(digestOf(restore(s26FnOf(s26Body, signature.replace('private.', ''))))).toBe(digest);
    }
  });
});

describeLocalDb('S26 final assert: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '', before = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_s26_assert');
    let failure: AssertFailure | null = null;
    try {
      if (before) await db().query(before);
      await pinAccountingS26Baseline(db());
      if (change) await db().query(change);
      await db().query(s26Assertion);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_s26_assert'); await db().query('release savepoint acc_s26_assert'); }
    return failure;
  }
  const failed = (detail: string) => ({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
  const redefine = (sig: string, from: string, to: string) =>
    `do $x$ begin execute regexp_replace(pg_get_functiondef('${sig}'::regprocedure), E'${from}', E'${to}'); end $x$`;
  const ARRIVAL = 'private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer)';
  const DECISION = 'private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer)';
  const POSTER = 'private.accounting_post_refund_events(integer)';
  const SETTLE = 'private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid)';
  const SETTLE_PUBLIC = 'public.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid)';
  const STATES = 'private.list_refund_accounting_states(integer,timestamptz,uuid)';
  const CAND = 'private.list_refund_settle_candidates(uuid)';
  const CAND_PUBLIC = 'public.list_refund_settle_candidates(uuid)';
  const ANOM = 'private.list_deferred_revenue_anomalies()';
  const NOT_REQUIRED = "return_method = \\'not_required\\'";
  const NOT_REQUIRED_X = "return_method = \\'zzz\\'";

  test('FREQ-579-AC-01: 適用後の状態で S26 の末尾の確かめが通る（呼出元のsearch_pathを問わない）', async () => {
    expect(s26Assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', 'set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('', 'set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt('', "set local search_path = ''")).toBeNull();
  });

  test.each([
    ['drop table pg_temp.accounting_s26_baseline', 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = payload - 'attrs'", 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = jsonb_set(payload, '{counts,entries}', '999999')", 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = jsonb_set(payload, '{counts,lines}', '999999')", 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = jsonb_set(payload, '{counts,pending_events}', '999999')", 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = jsonb_set(payload, '{counts,settlements}', '999999')", 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = jsonb_set(payload, '{counts,return_facts}', '999999')", 'acc_s26_existing_dml_allowlist'],
    ["update pg_temp.accounting_s26_baseline set payload = jsonb_set(payload, '{allowlist,0}', '1')", 'acc_s26_existing_dml_allowlist'],
    [`alter function ${ARRIVAL} set search_path = public`, 'acc_s26_function_attrs'],
    [`alter function ${DECISION} security invoker`, 'acc_s26_function_attrs'],
    [`alter function ${POSTER} stable`, 'acc_s26_function_attrs'],
    [`grant execute on function ${SETTLE_PUBLIC} to anon`, 'acc_s26_function_attrs'],
    [`alter function ${SETTLE} set search_path = public`, 'acc_s26_function_attrs'],
    [`grant execute on function ${CAND_PUBLIC} to authenticated`, 'acc_s26_function_attrs'],
    [`alter function ${STATES} volatile`, 'acc_s26_function_attrs'],
    [`alter function ${ANOM} volatile`, 'acc_s26_function_attrs'],
    [redefine(ARRIVAL, NOT_REQUIRED, NOT_REQUIRED_X), 'acc_s26_body_unchanged'],
    [redefine(ARRIVAL, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_X\\n'), 'acc_s26_body_unchanged'],
    [redefine(ARRIVAL, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s26_body_unchanged'],
    [redefine(DECISION, NOT_REQUIRED, NOT_REQUIRED_X), 'acc_s26_body_unchanged'],
    [redefine(DECISION, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s26_body_unchanged'],
    [redefine(POSTER, NOT_REQUIRED, NOT_REQUIRED_X), 'acc_s26_body_unchanged'],
    [redefine(POSTER, '-- ACC_P3_REPLACE_BEGIN [0-9a-f]{32}\\n', '-- ACC_P3_REPLACE_BEGIN 00000000000000000000000000000000\\n'), 'acc_s26_body_unchanged'],
    [redefine(POSTER, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s26_body_unchanged'],
    [redefine(POSTER, "\\'holdback_release\\', ", ''), 'acc_s26_body_unchanged'],
    [redefine(SETTLE, "\\'settle_plain_return\\'", "\\'settle_x\\'"), 'acc_s26_body_unchanged'],
    [redefine(SETTLE, NOT_REQUIRED, NOT_REQUIRED_X), 'acc_s26_body_unchanged'],
    [redefine(SETTLE, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_X\\n'), 'acc_s26_body_unchanged'],
    [redefine(SETTLE, 'v_hash := ', 'v_hash := null; v_hash := '), 'acc_s26_body_unchanged'],
    [redefine(CAND, NOT_REQUIRED, NOT_REQUIRED_X), 'acc_s26_body_unchanged'],
    [redefine(CAND, "pf.return_id", "pf.order_id"), 'acc_s26_body_unchanged'],
    [redefine(CAND, "pf.event_kind", "pf.event_x"), 'acc_s26_body_unchanged'],
    [redefine(SETTLE, "\\'settle_plain_return_payer\\'", "\\'settle_x\\'"), 'acc_s26_body_unchanged'],
    [redefine(SETTLE, "v_pay_fact.return_id", "v_owed_fact.return_id"), 'acc_s26_body_unchanged'],
    [redefine(CAND, '\\nBEGIN\\n', '\\nBEGIN\\n  PERFORM 1;\\n'), 'acc_s26_body_unchanged'],
    [redefine(STATES, NOT_REQUIRED, NOT_REQUIRED_X), 'acc_s26_body_unchanged'],
    [redefine(STATES, '-- ACC_P3_REPLACE_BEGIN [0-9a-f]{32}\\n', '-- ACC_P3_REPLACE_BEGIN 00000000000000000000000000000000\\n'), 'acc_s26_body_unchanged'],
    [redefine(STATES, 'OR s\\.owed_return > 0', ''), 'acc_s26_body_unchanged'],
    [redefine(STATES, "\\'owed\\', \\'failed\\'", "\\'owed\\'"), 'acc_s26_body_unchanged'],
    [redefine(ANOM, "\\'return_refund_negative_balance\\'", "\\'return_refund_negative_x\\'"), 'acc_s26_body_unchanged'],
    [redefine(ANOM, '-- ACC_P3_BEGIN\\n', '-- ACC_P3_X\\n'), 'acc_s26_body_unchanged'],
    [redefine(CAND_PUBLIC, 'SELECT private', 'SELECT /* email */ private'), 'acc_s26_reads_stable'],
  ])('FREQ-579-AC-01: S26改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });
});
