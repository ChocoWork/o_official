/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { withH1PermissionBaseline } from './helpers/group-h-fixtures';
import { hBegin, hRefundFixture, hResult } from './helpers/group-h-refund-fixtures';
import { G4_ALLOWLIST, H4_ALLOWLIST, replaceAllowlistSql } from './helpers/group-g-allowlist';
import { MAX_AUTOMATIC_DISCOUNTS, MAX_STACKABLE_AUTOMATIC_PER_CLASS } from '@/lib/discounts/discount-types';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_h_discounts_foundation.sql'));
const sql = files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '';
const assertion = sql.split('-- H1_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H1_FINAL_ASSERT_END')[0] ?? '';
const details = ['h1_tables', 'h1_draft_columns', 'h1_constraints', 'h1_rls_acl', 'h1_immutable', 'h1_line_reader',
  'h1_permission_catalogs', 'h1_permission_seed', 'h1_existing_dml_allowlist'];
type AssertFailure = { code?: string; message?: string; detail?: string; hint?: string };

const h5Path = path.join(directory, '20261029130400_group_h_discounts_refunds.sql');
const h5 = fs.existsSync(h5Path) ? fs.readFileSync(h5Path, 'utf8') : '';
const h5Assert = h5.split('-- H5_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H5_FINAL_ASSERT_END')[0] ?? '';
const h5Baseline = h5.match(/CREATE TEMP TABLE h5_function_baseline[\s\S]*?\]::oid\[\]\);/)?.[0] ?? '';
describe('H5 source contract (controller only)', () => {
  test('FREQ-551-AC-02: H5はASCIIとLFと単一取引と６つの固定DETAILを持つ', () => {
    expect(h5).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(h5.startsWith('BEGIN;\n')).toBe(true);
    expect(h5.match(/^BEGIN;$/gm)).toHaveLength(1); expect(h5.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(h5.trimEnd()).toMatch(/-- H5_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const detail of ['h5_unit_claims','h5_refund_amounts','h5_return_amounts','h5_legacy_fallback','h5_status_amounts','h5_public_acl']) expect(h5Assert).toContain(`'${detail}'`);
    expect(h5Baseline).not.toBe('');
    expect(h5).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(h5).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\.group_h_/);
    expect(h5).not.toMatch(/(?:GRANT|REVOKE)[^;]*USAGE\s+ON\s+SCHEMA\s+private/i);
  });
});
describeLocalDb('H5 semantic assertions (controller only; fill body MD5s first)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = '', assertionSql = h5Assert): Promise<AssertFailure | null> {
    await db().query('savepoint h5_assert');
    try {
      // Owner-only tampering and the migration assertion stay inside the rollback boundary.
      await db().query('set local role postgres');
      await db().query(h5Baseline); if (change) await db().query(change); await db().query(assertionSql); return null;
    }
    catch (caught) { const e = caught as AssertFailure; return { code: e.code, message: e.message === 'GROUP_H_MIGRATION_ASSERTION_FAILED' ? e.message : 'H_UNEXPECTED_DB_ERROR', detail: e.detail, ...(e.hint ? { hint: e.hint } : {}) }; }
    finally { await db().query('rollback to savepoint h5_assert'); await db().query('release savepoint h5_assert'); }
  }
  test('FREQ-551-AC-02: H5の属性とACLとOIDと本文は無改変なら通る', async () => { expect(await attempt()).toBeNull(); });
  test.each(['h5_legacy_fallback','h5_unit_claims','h5_public_acl','h5_return_amounts','h5_status_amounts'])(
    'FREQ-551-AC-02: %sの実行時例外も現在のDETAILとSQLSTATEだけで包む', async detail => {
      const marker = `v_detail:='${detail}';`;
      expect(h5Assert).toContain(marker);
      const sqlWithRuntimeFailure = h5Assert.replace(marker, `${marker} PERFORM 1/0;`);
      expect(await attempt('', sqlWithRuntimeFailure)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail, hint: 'sqlstate=22012' });
    });
  test('FREQ-551-AC-02: claimを別返金へ付け替えるデータ改ざんは単位不一致を検出する', async () => {
    const f = await hRefundFixture(db(), true);
    const a = await hBegin(db(), f, 17000);
    await hResult(db(), a.refund_id, 'pending');
    const b = await hBegin(db(), f, 20000);
    await db().query('set constraints all immediate'); await db().query('set constraints all deferred');
    const change = `alter table public.order_line_unit_amounts disable trigger user;
      update public.order_line_unit_amounts set refund_id='${b.refund_id}' where refund_id='${a.refund_id}';
      alter table public.order_line_unit_amounts enable trigger user`;
    expect(await attempt(change)).toMatchObject({ code: 'P0001', detail: 'h5_unit_claims' });
    expect(await attempt()).toBeNull();
  });
  test('FREQ-551-AC-04: 保存単位額の総和を壊すデータ改ざんは状態金額のDETAILで検出する', async () => {
    const f = await hRefundFixture(db(), true);
    await db().query('set constraints all immediate'); await db().query('set constraints all deferred');
    const change = `alter table public.order_line_unit_amounts disable trigger user;
      update public.order_line_unit_amounts set paid_amount=paid_amount+1 where order_item_id='${f.itemId}' and unit_index=0;
      alter table public.order_line_unit_amounts enable trigger user`;
    expect(await attempt(change)).toMatchObject({ code: 'P0001', detail: 'h5_status_amounts' });
    expect(await attempt()).toBeNull();
  });
  test('FREQ-551-AC-02: INSERTでclaimを持ち込むこともimmutable guardが拒否する', async () => {
    const f = await hRefundFixture(db(), true);
    await db().query('savepoint h5_insert_claim');
    try {
      await expect(db().query(`insert into public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount,refund_before_shipment)
        values($1,$2,0,0,false)`, [f.orderId, f.itemId])).rejects.toMatchObject({ code: '55000', message: 'GROUP_H_IMMUTABLE' });
    } finally { await db().query('rollback to savepoint h5_insert_claim'); await db().query('release savepoint h5_insert_claim'); }
  });
  test.each([
    ['alter table public.order_line_unit_amounts disable trigger h1_units_immutable', 'h5_unit_claims'],
    ["alter function private.group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid) volatile; create or replace function private.group_h_claim_refund_units(_refund_id uuid,_order_item_id uuid,_quantity integer,_before_shipment boolean,_return_line_id uuid default null) returns integer language plpgsql security definer set search_path='' as $$begin return 0; end;$$", 'h5_unit_claims'],
    ["create or replace function private.return_units_amount(_order_item_id uuid,_quantity integer,_offset integer default 0) returns integer language plpgsql stable set search_path='' as $$begin return 0; end;$$", 'h5_legacy_fallback'],
    ["create or replace function private.group_h_return_line_amount(_return_line_id uuid,_quantity integer,_offset integer default 0) returns integer language plpgsql stable security definer set search_path='' as $$begin return 18500; end;$$", 'h5_return_amounts'],
    ["alter function public.load_order_refund_materials(uuid) volatile", 'h5_refund_amounts'],
    ["alter function private.group_h_order_unit_status_amounts(uuid) volatile", 'h5_status_amounts'],
    ['grant update on public.order_line_unit_amounts to service_role', 'h5_public_acl'],
    ['grant execute on function private.group_h_release_refund_units(uuid) to service_role', 'h5_public_acl'],
  ])('FREQ-551-AC-02: H5改ざん %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});

describe('H1 source contract (no DB)', () => {
  test('FREQ-542-AC-01: H1はASCII・BOMなしLF・単一取引と固定の末尾assertを持つ', () => {
    expect(files).toEqual(['20261029130000_group_h_discounts_foundation.sql']);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- H1_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const detail of details) expect(assertion).toContain(`'${detail}'`);
    expect(assertion).toContain("ERRCODE = 'P0001'");
    expect(assertion).toContain("'GROUP_H_MIGRATION_ASSERTION_FAILED'");
    expect(sql).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(sql).not.toMatch(/(?:GRANT|REVOKE)[^;]*USAGE\s+ON\s+SCHEMA\s+private/i);
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\.order_line_discounts/i);
  });

  test('FREQ-543-AC-01: G0の２本体は目録の２件追加だけで公開入口と認可を保つ', () => {
    const g0 = fs.readFileSync(path.join(directory, '20261023175712_group_g0_permissions.sql'), 'utf8');
    for (const name of ['admin_get_permissions', 'admin_set_role_permissions']) {
      const original = g0.match(new RegExp(`CREATE FUNCTION private\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0];
      const replacement = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION private\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0];
      expect(original).toBeDefined();
      expect(replacement).toBe(original!.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        .replace("'admin.permissions.manage'\n  ];", "'admin.permissions.manage',\n    'admin.discounts.read', 'admin.discounts.manage'\n  ];"));
    }
    const outsideFunctions = sql.replace(/CREATE(?: OR REPLACE)? FUNCTION[\s\S]*?\n\$\$;/g, '');
    expect(outsideFunctions).not.toMatch(/DELETE\s+FROM\s+public\.(?:permissions|role_permissions)|UPDATE\s+public\.(?:orders|order_items|checkout_drafts)/i);
    const writes = [...outsideFunctions.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+((?:public|private|pg_temp)\.\w+)/g)]
      .map((m) => `${m[1]} ${m[2]}`).sort();
    expect(writes).toEqual(['INSERT INTO pg_temp.group_h_permission_baseline', 'INSERT INTO public.permissions',
      'INSERT INTO public.role_permissions', 'UPDATE public.roles'].sort());
    expect(outsideFunctions).toContain("UPDATE public.roles SET permissions_version=permissions_version+1 WHERE code='admin';");
  });
});

const h2Path = path.join(directory, '20261029130100_group_h_discounts_admin.sql');
const h2 = fs.existsSync(h2Path) ? fs.readFileSync(h2Path, 'utf8') : '';
// H4 は get_checkout_discount_context の本文を置き換えた（初回の有料履歴の規則）。H2 の末尾 assert が持つ本文の指紋は H2 当時のものなので、
// この試験は H2 の指紋だけを「今の本文の指紋」へ置き換えて流す。今の本文の指紋そのものは H4 の末尾 assert が固定する。
const H2_CONTEXT_MD5 = 'e95df5ff839cd450e6243d4220491742';
const CURRENT_CONTEXT_MD5_SQL = "(SELECT pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\\r','')) FROM pg_catalog.pg_proc AS f "
  + "WHERE f.oid='private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)'::regprocedure)";
const h2Assert = (h2.split('-- H2_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H2_FINAL_ASSERT_END')[0] ?? '').replace(`'${H2_CONTEXT_MD5}'`, CURRENT_CONTEXT_MD5_SQL);

const h3Path = path.join(directory, '20261029130200_group_h_discounts_checkout.sql');
const h3 = fs.existsSync(h3Path) ? fs.readFileSync(h3Path, 'utf8') : '';
const h3Assert = h3.split('-- H3_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H3_FINAL_ASSERT_END')[0] ?? '';

describe('H3 source contract (controller only)', () => {
  test('FREQ-548-AC-02: H3はLFと単一取引と固定額0のCHECKと４つの末尾assertを持つ', () => {
    expect(h3).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(h3.startsWith('BEGIN;\n')).toBe(true);
    expect(h3.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(h3.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(h3.trimEnd()).toMatch(/-- H3_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(h3).toContain("CHECK (status <> 'created' OR discount_engine_version IS DISTINCT FROM 1 OR discount_amount = 0)");
    for (const detail of ['h3_draft_freeze','h3_coupon_binding','h3_public_acl','h3_amount_checks']) expect(h3Assert).toContain(`'${detail}'`);
    expect(h3Assert.split('$h3_final$')).toHaveLength(3);
    expect(h3Assert).not.toMatch(/<>\s*CASE\b/i);
    expect(h3).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(h3).not.toMatch(/(?:GRANT|REVOKE)[^;]*USAGE\s+ON\s+SCHEMA\s+private/i);
  });
});

describeLocalDb('H3 semantic final assertions (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = ''): Promise<AssertFailure | null> {
    await db().query('savepoint h3_assert');
    let failure: AssertFailure | null = null;
    try { if (change) await db().query(change); await db().query(h3Assert); }
    catch (caught) { const e = caught as AssertFailure; failure = { code: e.code, message: e.message === 'GROUP_H_MIGRATION_ASSERTION_FAILED' ? e.message : 'H_UNEXPECTED_DB_ERROR', detail: e.detail }; }
    finally { await db().query('rollback to savepoint h3_assert'); await db().query('release savepoint h3_assert'); }
    return failure;
  }
  test('FREQ-548-AC-02: H3末尾assertは無改変で通る（controllerの本文MD5補完後）', async () => { expect(h3Assert).not.toBe(''); expect(await attempt()).toBeNull(); });
  test.each([
    ['alter table public.checkout_drafts disable trigger h3_checkout_frozen','h3_draft_freeze'],
    ['grant execute on function public.claim_checkout_discount_draft(jsonb,jsonb,jsonb) to anon','h3_public_acl'],
    ['alter function public.attach_checkout_discount_coupon(uuid,text,text) security definer','h3_public_acl'],
    ['create function public.claim_checkout_discount_draft(text) returns jsonb language sql as $$select null::jsonb$$','h3_public_acl'],
    ['alter table public.checkout_drafts drop constraint checkout_drafts_h3_created_amount','h3_amount_checks'],
    ['alter table public.checkout_drafts drop constraint checkout_drafts_h3_coupon','h3_amount_checks'],
    [`do $tamper$ begin execute replace(pg_get_functiondef('private.attach_checkout_discount_coupon(uuid,text,text)'::regprocedure),
      'v_draft.discount_snapshot_hash IS DISTINCT FROM _snapshot_hash','false'); end $tamper$`,'h3_coupon_binding'],
    [`do $tamper$ begin execute replace(pg_get_functiondef('private.group_h_validate_checkout_discount(jsonb,jsonb,jsonb)'::regprocedure),
      'OR v_total<50','OR v_total<0'); end $tamper$`,'h3_amount_checks'],
  ])('FREQ-548-AC-02: H3改ざんを%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail });
  });
});
describe('H2 source contract (controller also runs this)', () => {
  test('FREQ-543-AC-01: H2末尾assertは専用dollarタグ１組で閉じIF内のCASEを括弧で囲む', () => {
    const parts = h2Assert.split('$h2_final$');
    expect(parts).toHaveLength(3);
    expect(parts[0].trim()).toBe('DO');
    expect(parts[2].trim()).toBe(';');
    // PL/pgSQL reads an IF expression until the first THEN at parentheses depth zero.
    expect(parts[1]).not.toMatch(/<>\s*CASE\b/i);
  });

  test('FREQ-543-AC-01: H2末尾assertは内部の誤りを別のDETAILとHINTで返し、h2_functionsへ潰さない', () => {
    expect(h2Assert).toContain("DETAIL='h2_internal'");
    expect(h2Assert).toContain('HINT=SQLSTATE||');
    expect(h2Assert).not.toMatch(/COALESCE\(v_detail,\s*'h2_functions'\)/);
  });

  test('FREQ-547-AC-04: SQLの保存上限はエンジンの25件と分類ごと６件に一致する', () => {
    expect(h2).toContain(`v_automatic_limit CONSTANT integer := ${MAX_AUTOMATIC_DISCOUNTS};`);
    expect(h2).toContain(`v_stackable_limit CONSTANT integer := ${MAX_STACKABLE_AUTOMATIC_PER_CLASS};`);
    expect(h2).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(h2.startsWith('BEGIN;\n')).toBe(true);
    expect(h2.match(/^BEGIN;$/gm)).toHaveLength(1); expect(h2.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(h2.trimEnd()).toMatch(/-- H2_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(h2).not.toMatch(/auth\.(?:jwt|uid)|aal|auth\.sessions|CREATE TABLE/i);
  });
});

describeLocalDb('H2 semantic final assertions (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = '', assertSql = h2Assert) {
    await db().query('savepoint h2_assert'); let result: AssertFailure | null = null;
    try { await db().query(`${change};\n${assertSql}`); }
    catch (caught) { const e = caught as AssertFailure; result = { code: e.code,
      message: e.message === 'GROUP_H_MIGRATION_ASSERTION_FAILED' ? e.message : 'H_UNEXPECTED_DB_ERROR', detail: e.detail, hint: e.hint }; }
    finally { await db().query('rollback to savepoint h2_assert'); await db().query('release savepoint h2_assert'); }
    return result;
  }
  test('FREQ-543-AC-01: H2末尾assertは無改変で通る', async () => { expect(h2Assert).not.toBe(''); expect(await attempt()).toBeNull(); });
  test('FREQ-543-AC-01: assert自身の実行時エラーはh2_internalとHINTのSQLSTATEで返りh2_functionsに見えない', async () => {
    // ローカルの postgres は役割の名前を変えられないので、assert の写しの最初の BEGIN の直後に 0 での割り算を差し込み、内側の実行時エラーを起こす
    const injected = h2Assert.replace(/\nBEGIN\n/, '\nBEGIN\n  PERFORM 1/0;\n');
    expect(injected).not.toBe(h2Assert);
    const failure = await attempt('', injected);
    expect(failure).toMatchObject({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail: 'h2_internal' });
    expect(failure?.hint).toMatch(/^22012: /);
    expect(failure?.detail).not.toBe('h2_functions');
  });
  test.each([
    ['grant execute on function public.admin_create_discount(jsonb,uuid,uuid) to anon', 'h2_public_acl'],
    ['alter function public.admin_create_discount(jsonb,uuid,uuid) security definer', 'h2_public_acl'],
    ['alter function private.get_admin_discount(uuid,integer,integer,uuid) volatile', 'h2_reads_stable'],
    ['create function public.admin_create_discount(text) returns jsonb language sql as $$select null::jsonb$$', 'h2_functions'],
    [`do $x$ begin execute replace(pg_get_functiondef('private.group_h_check_catalog()'::regprocedure),
      'v_stackable_limit CONSTANT integer := 6;', 'v_stackable_limit CONSTANT integer := 7;'); end $x$`, 'h2_stackable_cap'],
    ['alter table public.discounts disable trigger h2_discounts_catalog', 'h2_stackable_cap'],
    ['alter table public.discount_items disable trigger h2_items_catalog', 'h2_set_items_disjoint'],
    [`do $x$ begin execute replace(pg_get_functiondef('private.admin_create_discount(jsonb,uuid,uuid)'::regprocedure),
      'PERFORM private.group_h_require_permission(_actor_id,', 'PERFORM private.group_h_require_permission(NULL,'); end $x$`, 'h2_permission_checks'],
    ['grant execute on function public.record_discount_search_fallback(uuid[]) to authenticated', 'h2_public_acl'],
    ['grant update on public.discount_assignments to service_role', 'h2_public_acl'],
    ['grant select(original_user_id) on public.discount_assignments to anon', 'h2_public_acl'],
    ['grant execute on function private.group_h_random_suffix(integer) to service_role', 'h2_public_acl'],
    ['alter function private.group_h_replay(uuid,text) immutable', 'h2_reads_stable'],
    [`do $x$ begin execute replace(pg_get_functiondef('private.group_h_replay(uuid,text)'::regprocedure),
      'v_prior->>''hash''<>_hash', 'false'); end $x$`, 'h2_admin_requests'],
    ['alter table public.discount_codes drop constraint discount_codes_code_key', 'h2_code_unique'],
    [`do $x$ begin execute replace(pg_get_functiondef('private.group_h_lock(uuid[],text[])'::regprocedure),
      '190521,1', '190521,2'); end $x$`, 'h2_automatic_lock'],
    [`do $x$ begin execute replace(pg_get_functiondef('private.record_discount_search_fallback(uuid[])'::regprocedure),
      '10 minutes', '1 minute'); end $x$`, 'h2_search_attention'],
  ])('FREQ-543-AC-01: H2改ざん %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});

describeLocalDb('H1 semantic final assertions: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change = '') {
    await db().query('savepoint h_assert');
    let failure: AssertFailure | null = null;
    try {
      // The helper creates baseline first, then executes the tamper and assertion together.
      await withH1PermissionBaseline(db(), `${change};\n${assertion}`);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'GROUP_H_MIGRATION_ASSERTION_FAILED' ? e.message : 'H_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint h_assert'); await db().query('release savepoint h_assert'); }
    return failure;
  }

  test('FREQ-542-AC-01: H1末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path=pg_catalog')).toBeNull();
    expect(await attempt('set local search_path=public,private,pg_catalog')).toBeNull();
  });

  test('FREQ-542-AC-01: 本文のLFだけをCRLFへ変えた関数も同じ指紋として扱う', async () => {
    expect(await attempt(`do $crlf$ declare f record; begin
      for f in select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='private' and p.proname in ('group_h_immutable','group_h_validate_line','group_h_validate_definition',
          'group_h_validate_relation','group_h_preserve_assignment','group_h_order_has_units','order_line_discounts',
          'admin_get_permissions','admin_set_role_permissions') loop
        execute pg_catalog.replace(pg_catalog.pg_get_functiondef(f.oid),E'\\n',E'\\r\\n');
      end loop;
    end $crlf$`)).toBeNull();
  });

  test.each([
    ['drop table public.order_line_unit_amounts', 'h1_tables'],
    ['alter table public.discount_codes drop constraint discount_codes_discount_id_id_key cascade', 'h1_constraints'],
    ['alter table public.discounts disable row level security', 'h1_rls_acl'],
    ['grant select on public.discounts to anon', 'h1_rls_acl'],
    ['grant select(name) on public.discounts to authenticated', 'h1_rls_acl'],
    ['grant truncate on public.discount_codes to service_role', 'h1_rls_acl'],
    ['alter table public.discounts drop constraint discounts_value_check', 'h1_constraints'],
    ['alter table public.discounts drop constraint discounts_assigned_guest_check', 'h1_constraints'],
    ['alter table public.discount_codes drop constraint discount_codes_assigned_guest_check', 'h1_constraints'],
    ['alter table public.checkout_drafts drop constraint checkout_drafts_h_discount_check', 'h1_draft_columns'],
    ['alter table public.order_line_discount_allocations disable trigger h1_allocations_immutable', 'h1_immutable'],
    ['alter table public.order_line_unit_amounts disable trigger h1_units_immutable', 'h1_immutable'],
    ['grant execute on function private.group_h_immutable() to service_role', 'h1_immutable'],
    ['alter function private.order_line_discounts(uuid) volatile', 'h1_line_reader'],
    ['alter function private.order_line_discounts(uuid) security definer', 'h1_line_reader'],
    ['drop index public.order_line_discount_allocations_order_idx', 'h1_constraints'],
    ['drop index public.order_line_unit_amounts_order_idx', 'h1_constraints'],
    ['drop index public.discount_redemptions_user_idx', 'h1_constraints'],
    ['grant execute on function private.group_h_order_has_units(uuid) to service_role', 'h1_immutable'],
    [`drop trigger h1_order_items_sum on public.order_items;
      create constraint trigger h1_order_items_sum after update on public.order_items deferrable initially deferred
        for each row execute function private.group_h_validate_line()`, 'h1_immutable'],
    [`drop trigger h1_order_items_sum on public.order_items;
      create constraint trigger h1_order_items_sum after update of order_id,quantity,line_total,line_kind on public.order_items
        deferrable initially deferred for each row when(true) execute function private.group_h_validate_line()`, 'h1_immutable'],
    ['create function private.order_line_discounts(uuid,integer) returns integer language sql as $$select 0$$', 'h1_line_reader'],
    [`do $rewrite$ declare d text; begin select pg_get_functiondef('private.admin_get_permissions(uuid)'::regprocedure) into d;
      execute replace(d,'''admin.discounts.read'', ', ''); end $rewrite$`, 'h1_permission_catalogs'],
    [`insert into public.role_permissions(role_id,permission_id) select r.id,p.id from public.roles r cross join public.permissions p
      where r.code='supporter' and p.code='admin.discounts.read'`, 'h1_permission_seed'],
    ["update public.roles set permissions_version=permissions_version+1 where code='admin'", 'h1_permission_seed'],
    ["update public.roles set permissions_version=permissions_version+1 where code='supporter'", 'h1_existing_dml_allowlist'],
    ["update public.permissions set name='tampered' where code='admin.items.read'", 'h1_existing_dml_allowlist'],
    [`delete from public.role_permissions rp using public.roles r,public.permissions p where rp.role_id=r.id and rp.permission_id=p.id
      and r.code='supporter' and p.code='admin.orders.read'`, 'h1_existing_dml_allowlist'],
  ])('FREQ-542-AC-01: H1改ざん %s はP0001とDETAIL=%sで拒否する', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});

const h4Path = path.join(directory, '20261029130300_group_h_discounts_acceptance.sql');
const h4 = fs.existsSync(h4Path) ? fs.readFileSync(h4Path, 'utf8') : '';
// H6 は get_admin_order_detail の本文を置き換えた（割引の内訳）。H4 の末尾 assert が持つ本文の指紋は H4 当時のものなので、
// この試験は H4 の指紋だけを「今の本文の指紋」へ置き換えて流す。今の本文の指紋そのものは H6 の末尾 assert が固定する。
const H4_ADMIN_DETAIL_MD5 = '87d26678c21c1d51f9beb469f681c398';
// The pinned fingerprint comes from the H6 file (not from the live body), so tampering with the body is still detected.
const h6ForH4 = fs.existsSync(path.join(directory, '20261029130500_group_h_discounts_views.sql'))
  ? fs.readFileSync(path.join(directory, '20261029130500_group_h_discounts_views.sql'), 'utf8') : '';
const CURRENT_ADMIN_DETAIL_MD5_SQL = `'${/\('private\.get_admin_order_detail\(uuid,uuid\)'[^\n]*'([0-9a-f]{32})'\)/.exec(h6ForH4)?.[1] ?? 'missing'}'`;
const h4Assert = (h4.split('-- H4_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H4_FINAL_ASSERT_END')[0] ?? '').replace(`'${H4_ADMIN_DETAIL_MD5}'`, CURRENT_ADMIN_DETAIL_MD5_SQL);
/** 名前の関数ひとつの定義（CREATE [OR REPLACE] FUNCTION から本文の閉じ $$; まで） */
const h4Function = (name: string): string => new RegExp(`CREATE (?:OR REPLACE )?FUNCTION private\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(h4)?.[0] ?? '';

describe('H4 source contract (controller only)', () => {
  test('FREQ-549-AC-01: H4はASCII・BOMなしLF・単一取引と固定の末尾assertを持ち既存の行を書き換えない', () => {
    expect(h4).not.toBe('');
    expect(h4).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(h4.startsWith('BEGIN;\n')).toBe(true);
    expect(h4.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(h4.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(h4.trimEnd()).toMatch(/-- H4_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const detail of ['h4_acceptance', 'h4_member_lock', 'h4_redemption_lifecycle', 'h4_reconciled_recovery', 'h4_attention',
      'h4_writer_allowlist', 'h4_public_acl']) expect(h4Assert).toContain(`'${detail}'`);
    expect(h4Assert.split('$h4_final$')).toHaveLength(3);
    expect(h4Assert).toContain("ERRCODE='P0001'");
    expect(h4).not.toMatch(/DROP FUNCTION/i);
    expect(h4).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(h4).not.toMatch(/(?:GRANT|REVOKE)[^;]*USAGE\s+ON\s+SCHEMA\s+private/i);
    const outside = h4.replace(/CREATE(?: OR REPLACE)? FUNCTION[\s\S]*?\n\$\$;/g, '').replace(/DO \$h4_final\$[\s\S]*?\$h4_final\$;/, '');
    expect([...outside.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:public|private)\./g)]).toEqual([]);
  });

  test.each(['place_order_from_checkout_draft', 'place_reconciled_order_from_checkout_draft', 'mark_order_paid', 'mark_order_awaiting_payment',
    'release_stock_for_unpaid_order', 'record_cancelled_order_paid_amount'])('FREQ-549-AC-01: %sはG共通鍵の後にH目録・本人鍵・割引id鍵を取ってからGの在庫の鍵へ進む', (name) => {
    const body = h4Function(name);
    expect(body).not.toBe('');
    expect(body.indexOf('private.group_h_lock_acceptance(')).toBeGreaterThan(0);
    expect(body.indexOf('private.group_h_lock_acceptance(')).toBeLessThan(body.indexOf('private.lock_group_g_inventory('));
    // Hの鍵より前にGの共通鍵を飛ばして行を読まない
    expect(body.slice(0, body.indexOf('private.group_h_lock_acceptance(')))
      .not.toMatch(/FROM public\.(?:orders|order_items|order_item_allocations)\b[^;]*FOR UPDATE/);
  });

  test('FREQ-549-AC-01: 受付は在庫・注文を書く前に割引を再確認し、業務拒否では何も書かずに返す', () => {
    const body = h4Function('place_order_from_checkout_draft');
    const recheck = body.indexOf('private.group_h_recheck_discount_facts(');
    expect(recheck).toBeGreaterThan(body.indexOf('preview_checkout_fulfillment('));
    expect(recheck).toBeLessThan(body.indexOf('INSERT INTO public.orders'));
    expect(body.indexOf('private.group_h_copy_order_discounts(')).toBeGreaterThan(body.indexOf('INSERT INTO public.stock_movements'));
    expect(body.indexOf('private.group_h_reserve_redemptions(')).toBeGreaterThan(body.indexOf('private.group_h_copy_order_discounts('));
    // 通常の受付は照合入口の2値や fallback の印を持たない
    expect(body).not.toContain('reconciliation_fallback');
    expect(h4Function('place_reconciled_order_from_checkout_draft')).not.toContain('group_h_recheck_discount_facts');
  });

  test('FREQ-549-AC-05: 結付けはG共通鍵の後に本人キーを辞書順・割引idを昇順で取り、注文の行ロックより前に使用の本人を会員へ付け替えない', () => {
    const body = h4Function('link_guest_orders');
    const common = body.indexOf('pg_catalog.pg_advisory_xact_lock(190521, 1)');
    expect(common).toBeGreaterThan(0);
    expect(body.indexOf("private.group_h_lock(v_h_ids,ARRAY['guest:'||v_email,'member:'||_user_id::text])")).toBeGreaterThan(common);
    expect(body.indexOf('FOR UPDATE')).toBeGreaterThan(body.indexOf('private.group_h_lock('));
    expect(body.indexOf('UPDATE public.discount_redemptions')).toBeGreaterThan(body.indexOf('RETURNING o.id'));
    expect(body).not.toMatch(/usage_limit|discount_redemptions[^;]*state\s*=/);
  });
});

describeLocalDb('H4 semantic final assertions (controller only)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  /** H4 の本体が最初に G の76本を固定した temp 表を、H4 より前の許可一覧から作り直してから末尾 assert だけを流す */
  async function attempt(change = ''): Promise<AssertFailure | null> {
    await db().query('savepoint h4_assert'); let failure: AssertFailure | null = null;
    try {
      await db().query('create temp table group_h4_writer_baseline on commit drop as select to_regprocedure(s)::oid as oid from unnest($1::text[]) as s', [G4_ALLOWLIST]);
      if (change) await db().query(change);
      await db().query(h4Assert);
    } catch (caught) {
      const e = caught as AssertFailure;
      failure = { code: e.code, message: e.message === 'GROUP_H_MIGRATION_ASSERTION_FAILED' ? e.message : 'H_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint h4_assert'); await db().query('release savepoint h4_assert'); }
    return failure;
  }
  const replaceBody = (signature: string, from: string, to: string) => `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from}', '${to}'); end $x$`;

  test('FREQ-549-AC-01: H4末尾assertは無改変で通る（controllerの本文MD5補完後）', async () => { expect(h4Assert).not.toBe(''); expect(await attempt()).toBeNull(); });
  test('FREQ-549-AC-01: 許可一覧は G4 の76本 + 照合入口の1本の77本で、redemptionだけを書く helper を混ぜない', () => {
    expect(G4_ALLOWLIST).toHaveLength(76);
    expect(H4_ALLOWLIST).toHaveLength(77);
    expect(H4_ALLOWLIST.slice(0, 76)).toEqual([...G4_ALLOWLIST]);
    expect(H4_ALLOWLIST.filter((entry) => entry.includes('group_h_'))).toEqual([]);
  });
  test.each([
    [replaceBody('private.group_h_assert_acceptance_locks(uuid,uuid)', '190523', '190529'), 'h4_member_lock'],
    [replaceBody('private.group_h_lock_acceptance(uuid,uuid)', '190524', '190529'), 'h4_member_lock'],
    [replaceBody('private.group_h_recheck_discount_facts(uuid,uuid)', 'discount_first_order_changed', 'discount_first_order_x'), 'h4_member_lock'],
    [replaceBody('private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)',
      "v_h_recheck->>''kind''<>''valid''", "v_h_recheck->>''kind''<>''valid_x''"), 'h4_acceptance'],
    [replaceBody('private.group_h_copy_order_discounts(uuid,uuid,jsonb)', 'GROUP_H_ARGUMENT_INVALID', 'GROUP_H_ARGUMENT_X'), 'h4_acceptance'],
    [replaceBody('private.group_h_settle_redemptions(uuid,boolean)', "state=''cancelled''", "state=''reserved''"), 'h4_redemption_lifecycle'],
    [replaceBody('private.group_h_reserve_redemptions(uuid,uuid)', 'ON CONFLICT(order_id,discount_id) DO NOTHING', ''), 'h4_redemption_lifecycle'],
    [replaceBody('private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
      'PERFORM private.group_h_settle_redemptions(_order_id,true);', ''), 'h4_redemption_lifecycle'],
    [replaceBody('private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)',
      "NOT IN (''paid'',''awaiting_payment'')", "NOT IN (''paid'',''awaiting_payment'',''unpaid'')"), 'h4_reconciled_recovery'],
    [replaceBody('private.record_cancelled_order_paid_amount(uuid,text,integer)',
      'PERFORM private.group_h_settle_redemptions(_order_id,true);', ''), 'h4_reconciled_recovery'],
    [replaceBody('private.group_h_discount_attention_rows(uuid)', 'AND r.attention_resolved_at IS NULL', ''), 'h4_attention'],
    [replaceBody('private.get_admin_order_detail(uuid,uuid)', "''discounts'',private.group_h_discount_attention_rows(_order_id),", ''), 'h4_attention'],
    [replaceAllowlistSql(G4_ALLOWLIST), 'h4_writer_allowlist'],
    [replaceAllowlistSql([...H4_ALLOWLIST, 'private.group_h_settle_redemptions(uuid,boolean)']), 'h4_writer_allowlist'],
    ['grant execute on function private.group_h_settle_redemptions(uuid,boolean) to service_role', 'h4_public_acl'],
    ['grant execute on function public.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) to anon', 'h4_public_acl'],
    ['grant execute on function private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) to authenticated', 'h4_public_acl'],
    ['alter function public.list_admin_discount_attention(integer,uuid) security definer', 'h4_public_acl'],
    ['create function public.group_h_settle_redemptions(uuid,boolean) returns jsonb language sql as $$select null::jsonb$$', 'h4_public_acl'],
  ])('FREQ-549-AC-01: H4改ざん %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});

const h6Path = path.join(directory, '20261029130500_group_h_discounts_views.sql');
const h6 = fs.existsSync(h6Path) ? fs.readFileSync(h6Path, 'utf8') : '';
const h6Assert = h6.split('-- H6_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H6_FINAL_ASSERT_END')[0] ?? '';
const h6Baseline = h6.match(/CREATE TEMP TABLE h6_function_baseline[\s\S]*?\]::oid\[\]\);/)?.[0] ?? '';
/** 名前の関数ひとつの定義（CREATE [OR REPLACE] FUNCTION <schema>.<name>( から本文の閉じ $$; まで）。先頭は完全な定義の1つだけ */
const h6Definition = (source: string, header: string): string => {
  const start = source.indexOf(header);
  return start < 0 ? '' : source.slice(start, source.indexOf('\n$$;', start) + '\n$$;'.length);
};

describe('H6 source contract (controller only)', () => {
  test('FREQ-552-AC-02: H6はASCII・BOMなしLF・単一取引と固定の末尾assertを持ち既存の行を書き換えない', () => {
    expect(h6).not.toBe('');
    expect(h6).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(h6.startsWith('BEGIN;\n')).toBe(true);
    expect(h6.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(h6.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(h6.trimEnd()).toMatch(/-- H6_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const detail of ['h6_order_breakdown', 'h6_customer_projection', 'h6_admin_projection', 'h6_public_acl']) expect(h6Assert).toContain(`'${detail}'`);
    expect(h6Baseline).not.toBe('');
    expect(h6Assert).toContain("ERRCODE='P0001'");
    expect(h6).not.toMatch(/DROP FUNCTION/i);
    expect(h6).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(h6).not.toMatch(/(?:GRANT|REVOKE)[^;]*USAGE\s+ON\s+SCHEMA\s+private/i);
    const outside = h6.replace(/CREATE(?: OR REPLACE)? FUNCTION[\s\S]*?\n\$\$;/g, '').replace(/DO \$h6_final\$[\s\S]*?\$h6_final\$;/, '');
    expect([...outside.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+(?:public|private)\./g)]).toEqual([]);
  });

  test('FREQ-552-AC-02: 公開の状況材料はG3の本文に discounts の1か所だけを足し、名前と額以外の列を読まない', () => {
    const g3 = fs.readFileSync(path.join(directory, '20261025070821_group_g3_shipping_reads.sql'), 'utf8');
    const header = 'CREATE OR REPLACE FUNCTION public.get_order_status_public_material(_order_id uuid)';
    const before = h6Definition(g3, header);
    const after = h6Definition(h6, header);
    expect(before).not.toBe('');
    const tail = "    ), '[]'::jsonb)\n  );\nEND;\n$$;";
    expect(before.endsWith(tail)).toBe(true);
    const added = ",\n    'discounts', COALESCE((\n      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', x.value->>'name', 'amount', (x.value->>'amount')::integer)\n"
      + "        ORDER BY x.ordinality)\n      FROM pg_catalog.jsonb_array_elements(private.order_discount_breakdown(_order_id)->'rows') WITH ORDINALITY AS x(value, ordinality)\n    ), '[]'::jsonb)\n  );\nEND;\n$$;";
    expect(after).toBe(before.slice(0, before.length - tail.length) + "    ), '[]'::jsonb)" + added);
    expect(after).not.toMatch(/code_snapshot|discount_redemptions|order_line_discount_allocations|lineAllocations|discountId|identity_key|normalized_email/);
  });

  test('FREQ-552-AC-03: 管理詳細はH4の本文に discounts の1行だけを足し、権限は orders.read のまま', () => {
    const h4Text = fs.readFileSync(path.join(directory, '20261029130300_group_h_discounts_acceptance.sql'), 'utf8');
    const header = 'CREATE OR REPLACE FUNCTION private.get_admin_order_detail(_order_id uuid, _actor_id uuid) RETURNS jsonb';
    const before = h6Definition(h4Text, header);
    const after = h6Definition(h6, header);
    expect(before).not.toBe('');
    const added = "    'discounts',COALESCE(private.order_discount_breakdown(_order_id)->'rows','[]'::jsonb),\n";
    const anchor = "    'rows',COALESCE((SELECT pg_catalog.jsonb_agg(";
    expect(before.split(anchor)).toHaveLength(2);
    expect(after).toBe(before.replace(anchor, () => added + anchor));
    expect(after).toContain("private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read'])");
    expect(after).not.toMatch(/admin\.discounts\./);
  });

  test('FREQ-552-AC-02: 内部の内訳関数は誰にも EXECUTE を与えず、完全な内訳の入口は service_role だけの委譲にする', () => {
    expect(h6).toContain('REVOKE ALL ON FUNCTION private.order_discount_breakdown(uuid) FROM PUBLIC, anon, authenticated, service_role;');
    expect(h6).not.toMatch(/GRANT EXECUTE ON FUNCTION private\.order_discount_breakdown/);
    expect(h6).toContain('GRANT EXECUTE ON FUNCTION private.get_order_discount_breakdown(uuid) TO service_role;');
    expect(h6).toContain('GRANT EXECUTE ON FUNCTION public.get_order_discount_breakdown(uuid) TO service_role;');
    expect(h6).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*\bTO\b[^;]*\b(?:PUBLIC|anon|authenticated)\b/);
    expect(h6).toMatch(/CREATE FUNCTION public\.get_order_discount_breakdown\(_order_id uuid\) RETURNS jsonb\nLANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''/);
    expect(h6).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION public\.order_discount_breakdown/);
  });
});

describeLocalDb('H6 semantic final assertions (controller only; fill body MD5s first)', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change = '', assertionSql = h6Assert): Promise<AssertFailure | null> {
    await db().query('savepoint h6_assert');
    try {
      await db().query('set local role postgres');
      await db().query(h6Baseline); if (change) await db().query(change); await db().query(assertionSql); return null;
    } catch (caught) {
      const e = caught as AssertFailure;
      return { code: e.code, message: e.message === 'GROUP_H_MIGRATION_ASSERTION_FAILED' ? e.message : 'H_UNEXPECTED_DB_ERROR', detail: e.detail, ...(e.hint ? { hint: e.hint } : {}) };
    } finally { await db().query('rollback to savepoint h6_assert'); await db().query('release savepoint h6_assert'); }
  }
  const replaceBody = (signature: string, from: string, to: string) =>
    `do $x$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from}', '${to}'); end $x$`;
  const MATERIAL = 'public.get_order_status_public_material(uuid)';
  const ADMIN = 'private.get_admin_order_detail(uuid,uuid)';
  const BREAKDOWN = 'private.order_discount_breakdown(uuid)';

  test('FREQ-552-AC-02: H6末尾assertは無改変で通る（controllerの本文MD5補完後）', async () => { expect(h6Assert).not.toBe(''); expect(await attempt()).toBeNull(); });

  test.each(['h6_order_breakdown', 'h6_customer_projection', 'h6_admin_projection', 'h6_public_acl'])(
    'FREQ-552-AC-02: %sの実行時例外も現在のDETAILとSQLSTATEだけで包む', async detail => {
      const marker = `v_detail:='${detail}';`;
      expect(h6Assert).toContain(marker);
      expect(await attempt('', h6Assert.replace(marker, `${marker} PERFORM 1/0;`)))
        .toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail, hint: 'sqlstate=22012' });
    });

  test.each([
    // 旧注文の合計1行(SQLの名前の印)の欠落・改名・別の入れ替えは、内訳の本文の指紋が拒む
    [replaceBody(BREAKDOWN, "''discount''", "''discount_x''"), 'h6_order_breakdown'],
    [replaceBody(BREAKDOWN, 'AND a.amount > 0', ''), 'h6_order_breakdown'],
    [replaceBody(BREAKDOWN, "RETURN pg_catalog.jsonb_build_object(''rows'', ''[]''::jsonb, ''legacy'', true);", 'RETURN NULL;'), 'h6_order_breakdown'],
    ['alter function private.order_discount_breakdown(uuid) volatile', 'h6_order_breakdown'],
    ['alter function private.get_order_discount_breakdown(uuid) security invoker', 'h6_order_breakdown'],
    // 公開投影へのコード・配分の追加
    [replaceBody(MATERIAL, "''name'', x.value->>''name''", "''name'', x.value->>''name'', ''code'', x.value->>''code''"), 'h6_customer_projection'],
    [replaceBody(MATERIAL, "''amount'', (x.value->>''amount'')::integer", "''amount'', (x.value->>''amount'')::integer, ''lineAllocations'', x.value->''lineAllocations''"), 'h6_customer_projection'],
    ['alter function public.get_order_status_public_material(uuid) volatile', 'h6_customer_projection'],
    // 管理詳細の内訳の欠落
    [replaceBody(ADMIN, "''discounts'',COALESCE(private.order_discount_breakdown(_order_id)->''rows'',''[]''::jsonb),", ''), 'h6_admin_projection'],
    [replaceBody(ADMIN, "ARRAY[''admin.orders.read'']", "ARRAY[''admin.discounts.read'']"), 'h6_admin_projection'],
    ['alter function private.get_admin_order_detail(uuid,uuid) volatile', 'h6_admin_projection'],
    // 入口のACL
    ['grant execute on function private.order_discount_breakdown(uuid) to service_role', 'h6_public_acl'],
    ['grant execute on function public.get_order_discount_breakdown(uuid) to anon', 'h6_public_acl'],
    ['grant execute on function public.get_order_discount_breakdown(uuid) to authenticated', 'h6_public_acl'],
    ['grant execute on function private.get_order_discount_breakdown(uuid) to authenticated', 'h6_public_acl'],
    ['revoke execute on function public.get_order_discount_breakdown(uuid) from service_role', 'h6_public_acl'],
    ['grant execute on function public.get_order_status_public_material(uuid) to anon', 'h6_public_acl'],
    ['alter function public.get_order_discount_breakdown(uuid) security definer', 'h6_public_acl'],
    ['create function public.order_discount_breakdown(uuid) returns jsonb language sql as $$select null::jsonb$$', 'h6_public_acl'],
    // An extra overload of the public entry (e.g. a (text) version opened to anon) is refused too.
    ['create function public.get_order_discount_breakdown(text) returns jsonb language sql as $$select null::jsonb$$', 'h6_public_acl'],
    ['create function private.get_order_status_public_material(uuid) returns jsonb language sql as $$select null::jsonb$$', 'h6_public_acl'],
  ])('FREQ-552-AC-02: H6改ざん %s はP0001とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: 'P0001', message: 'GROUP_H_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
