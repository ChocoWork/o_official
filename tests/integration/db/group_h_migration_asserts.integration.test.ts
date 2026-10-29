/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { withH1PermissionBaseline } from './helpers/group-h-fixtures';
import { MAX_AUTOMATIC_DISCOUNTS, MAX_STACKABLE_AUTOMATIC_PER_CLASS } from '@/lib/discounts/discount-types';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_h_discounts_foundation.sql'));
const sql = files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '';
const assertion = sql.split('-- H1_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H1_FINAL_ASSERT_END')[0] ?? '';
const details = ['h1_tables', 'h1_draft_columns', 'h1_constraints', 'h1_rls_acl', 'h1_immutable', 'h1_line_reader',
  'h1_permission_catalogs', 'h1_permission_seed', 'h1_existing_dml_allowlist'];
type AssertFailure = { code?: string; message?: string; detail?: string; hint?: string };

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
const h2Assert = h2.split('-- H2_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H2_FINAL_ASSERT_END')[0] ?? '';

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
