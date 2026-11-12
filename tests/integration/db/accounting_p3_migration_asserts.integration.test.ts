/** @jest-environment node */
import { createHash } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_S15_FILES, ACCOUNTING_S15_SQL as sql, ACCOUNTING_S16_FILES, ACCOUNTING_S16_SQL as s16Sql, accountingS15Section,
  accountingS16Section, pinAccountingS15Baseline, seedReturnRefundParents,
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

  test('FREQ-576-AC-04: S15末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path = pg_catalog')).toBeNull();
    expect(await attempt('set local search_path = public, private, extensions, pg_catalog')).toBeNull();
    expect(await attempt("set local search_path = ''")).toBeNull();
    await db().query('savepoint acc_s15_search_path');
    await db().query('set local search_path = public, private, extensions, pg_catalog');
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
    ['alter table public.accounting_return_facts alter column decided_on set not null', 'acc_s15_tables'],
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
