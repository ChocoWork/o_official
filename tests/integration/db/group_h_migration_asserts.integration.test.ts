/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { withH1PermissionBaseline } from './helpers/group-h-fixtures';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_h_discounts_foundation.sql'));
const sql = files.length === 1 ? fs.readFileSync(path.join(directory, files[0]), 'utf8') : '';
const assertion = sql.split('-- H1_FINAL_ASSERT_BEGIN\n')[1]?.split('-- H1_FINAL_ASSERT_END')[0] ?? '';
const details = ['h1_tables', 'h1_draft_columns', 'h1_constraints', 'h1_rls_acl', 'h1_immutable', 'h1_line_reader',
  'h1_permission_catalogs', 'h1_permission_seed', 'h1_existing_dml_allowlist'];
type AssertFailure = { code?: string; message?: string; detail?: string };

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
