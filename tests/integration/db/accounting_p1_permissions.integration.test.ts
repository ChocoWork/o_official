/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import {
  ACCOUNTING_PERMISSION_CODES, ACCOUNTING_S0_FILES, ACCOUNTING_S0_SQL as sql, accountingS0PermissionBodyMd5, accountingS0Section,
  withAccountingPermissionBaseline,
} from './helpers/accounting-fixtures';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';

// Controller only for the DB suites: disposable local DB after the S0 migration is applied.
const assertion = accountingS0Section('FINAL_ASSERT');
const details = ['acc_s0_permission_catalogs', 'acc_s0_permission_seed', 'acc_s0_existing_dml_allowlist'];
const h1 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261029130000_group_h_discounts_foundation.sql'), 'utf8');
const functionText = (source: string, name: string) =>
  source.match(new RegExp(`CREATE OR REPLACE FUNCTION private\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0];
const catalogOf = (text: string | undefined) =>
  [...(text?.match(/catalog CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
type AssertFailure = { code?: string; message?: string; detail?: string };

describe('S0 source contract (no DB)', () => {
  test('FREQ-553-AC-01: S0はASCII・BOMなしLF・単一取引で、末尾assert→NOTIFY→COMMITで閉じ固定DETAILだけを持つ', () => {
    expect(ACCOUNTING_S0_FILES).toEqual(['20261107130000_accounting_p1_permissions.sql']);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/-- ACC_S0_FINAL_ASSERT_END\nNOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    expect(assertion).not.toBe('');
    expect([...new Set([...assertion.matchAll(/'(acc_s0_[a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([...details].sort());
    expect(assertion).toContain("'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000'");
    expect(assertion).not.toMatch(/ERRCODE = '(?!55000')/);
    expect(sql).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(sql).not.toMatch(/(?:GRANT|REVOKE)[^;]*USAGE\s+ON\s+SCHEMA\s+private/i);
  });

  test('FREQ-553-AC-01: S0の2本体はH1の本体に目録の6件追加だけで、末尾assertの指紋は本体の指紋と一致する', () => {
    for (const [name, signature] of [['admin_get_permissions', 'private.admin_get_permissions(uuid)'],
      ['admin_set_role_permissions', 'private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)']] as const) {
      const original = functionText(h1, name);
      const replacement = functionText(sql, name);
      expect(original).toBeDefined();
      expect(replacement).toBe(original!.replace("'admin.discounts.read', 'admin.discounts.manage'\n  ];",
        "'admin.discounts.read', 'admin.discounts.manage', 'admin.accounting.settings.manage',\n"
        + "    'admin.accounting.entries.correct', 'admin.accounting.close.manage', 'admin.accounting.inventory.manage',\n"
        + "    'admin.accounting.export.read', 'admin.accounting.integration.manage'\n  ];"));
      const body = replacement!.match(/AS \$\$([\s\S]*?)\$\$;$/)?.[1] ?? '';
      expect(accountingS0PermissionBodyMd5(signature)).toBe(createHash('md5').update(body.replace(/\r/g, '')).digest('hex'));
    }
  });

  test('FREQ-553-AC-01: SQLの両catalogと末尾assertの目録とTSの表示の目録が同じ38件にそろう', () => {
    const ts = ROLE_PERMISSION_CATALOG.map((p) => p.code).sort();
    expect(ts).toHaveLength(38);
    expect(ts).toEqual(expect.arrayContaining([...ACCOUNTING_PERMISSION_CODES]));
    for (const name of ['admin_get_permissions', 'admin_set_role_permissions']) expect(catalogOf(functionText(sql, name)).sort()).toEqual(ts);
    const expected = [...(assertion.match(/v_catalog CONSTANT text\[\] := ARRAY\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(expected).toEqual(ts);
  });

  test('FREQ-553-AC-01: S0の関数外の書き込みは権限6件の登録と店長への付与と店長の版+1だけ', () => {
    const outsideFunctions = sql.replace(/CREATE(?: OR REPLACE)? FUNCTION[\s\S]*?\n\$\$;/g, '').replace(/DO \$acc_s0_final\$[\s\S]*?\$acc_s0_final\$;/, '');
    const writes = [...outsideFunctions.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\s+((?:public|private|pg_temp)\.\w+)/g)]
      .map((m) => `${m[1]} ${m[2]}`).sort();
    expect(writes).toEqual(['INSERT INTO pg_temp.accounting_permission_baseline', 'INSERT INTO public.permissions',
      'INSERT INTO public.role_permissions', 'UPDATE public.roles'].sort());
    expect(outsideFunctions).toContain("UPDATE public.roles SET permissions_version=permissions_version+1 WHERE code='admin';");
    expect(outsideFunctions).toContain("WHERE r.code='admin' AND p.code IN (");
    const seed = accountingS0Section('PERMISSION_SEED');
    expect(seed.match(/ON CONFLICT\(code\) DO NOTHING;/g)).toHaveLength(1);
    expect(seed.match(/ON CONFLICT DO NOTHING;/g)).toHaveLength(1);
    expect(seed.indexOf('CREATE TEMP TABLE accounting_permission_baseline(payload jsonb) ON COMMIT DROP;'))
      .toBeLessThan(seed.indexOf('INSERT INTO public.permissions'));
    for (const code of ACCOUNTING_PERMISSION_CODES) expect(seed).toContain(`('${code}','`);
  });
});

describeLocalDb('S0 permissions: controller only', (db) => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_catalog.pg_advisory_xact_lock(190519,0)'); });
  afterEach(async () => { await db().query('rollback'); });

  async function reject(run: () => Promise<unknown>, code: string, message?: string) {
    await db().query('savepoint acc_expected');
    let caught: { code?: string; message?: string } | undefined;
    try { await run(); } catch (error) { caught = error as typeof caught; }
    finally { await db().query('rollback to savepoint acc_expected'); await db().query('release savepoint acc_expected'); }
    expect(caught?.code).toBe(code);
    if (message) expect(caught?.message === message).toBe(true);
  }
  async function actor(role: 'admin' | 'supporter' | 'user') {
    const id = randomUUID();
    await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [id]);
    await db().query('insert into public.user_roles(user_id,role_id) select $1,id from public.roles where code=$2', [id, role]);
    return id;
  }
  async function service<T>(run: () => Promise<T>) {
    await db().query('set local role service_role');
    const value = await run();
    await db().query('reset role');
    return value;
  }
  const codes = [...ACCOUNTING_PERMISSION_CODES];

  test('FREQ-553-AC-01: 38コードの初期登録は店長だけへ6件を付与し店長の版だけを1増やす', async () => {
    expect(accountingS0Section('PERMISSION_SEED')).not.toBe('');
    const admin = await actor('admin');
    // Reconstruct pre-S0 in this disposable transaction, then apply the actual S0 seed and its unmodified assert.
    await db().query(`delete from public.role_permissions rp using public.permissions p where rp.permission_id=p.id and p.code=any($1::text[])`, [codes]);
    await db().query('delete from public.permissions where code=any($1::text[])', [codes]);
    await db().query("update public.roles set permissions_version=permissions_version-1 where code='admin'");
    const before = (await db().query('select id,code,permissions_version::text as version from public.roles order by id')).rows;
    const grants = (await db().query('select * from public.role_permissions order by role_id,permission_id')).rows;
    const permissions = (await db().query('select * from public.permissions order by id')).rows;
    await db().query(accountingS0Section('PERMISSION_SEED'));
    await db().query('savepoint s0_rerun');
    await db().query(assertion);
    await db().query('rollback to savepoint s0_rerun');
    await db().query('release savepoint s0_rerun');
    const after = (await db().query('select id,code,permissions_version::text as version from public.roles order by id')).rows;
    expect(after).toEqual(before.map((r) => ({ ...r, version: (BigInt(r.version) + (r.code === 'admin' ? BigInt(1) : BigInt(0))).toString() })));
    expect((await db().query(`select rp.* from public.role_permissions rp join public.permissions p on p.id=rp.permission_id
      where not (p.code=any($1::text[])) order by rp.role_id,rp.permission_id`, [codes])).rows).toEqual(grants);
    expect((await db().query('select * from public.permissions where not (code=any($1::text[])) order by id', [codes])).rows).toEqual(permissions);
    expect((await db().query(`select r.code,p.code as permission from public.role_permissions rp join public.roles r on r.id=rp.role_id
      join public.permissions p on p.id=rp.permission_id where p.code=any($1::text[]) order by p.code`, [codes])).rows)
      .toEqual([...codes].sort().map((permission) => ({ code: 'admin', permission })));
    const matrix = await service(async () => (await db().query('select public.admin_get_permissions($1) as r', [admin])).rows[0].r);
    expect(matrix.permissionCodes).toHaveLength(38);
    expect(matrix.permissionCodes).toEqual(ROLE_PERMISSION_CATALOG.map((p) => p.code).sort());
    const supporterState = matrix.roles.find((r: { code: string }) => r.code === 'supporter');
    expect(supporterState.permissionCodes.filter((code: string) => codes.includes(code as typeof codes[number]))).toEqual([]);
    const prior = before.find((r) => r.code === 'admin')!.version;
    await reject(() => service(() => db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5)',
      [admin, 'admin', matrix.permissionCodes, prior, randomUUID()])), 'P0001', 'ROLE_PERMISSION_VERSION_CONFLICT');
    const version = after.find((r) => r.code === 'admin')!.version;
    // 38 codes are accepted (no change), 39 are refused before writing.
    const saved = await service(async () => (await db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5) as r',
      [admin, 'admin', matrix.permissionCodes, version, randomUUID()])).rows[0].r);
    expect(saved.changedCount).toBe(0);
    expect(saved.role.permissionCodes).toEqual(matrix.permissionCodes);
    await reject(() => service(() => db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5)',
      [admin, 'admin', [...matrix.permissionCodes, 'other'], version, randomUUID()])), '22023', 'ROLE_PERMISSION_ARGUMENT_INVALID');
  });

  test('FREQ-553-AC-01: DBは無効な役割と期限切れの割り当てと足りない権限を42501で拒む', async () => {
    const admin = await actor('admin');
    const inactive = await actor('admin');
    const expired = await actor('admin');
    const supporter = await actor('supporter');
    await db().query('update public.user_roles set active=false where user_id=$1', [inactive]);
    await db().query("update public.user_roles set expires_at=now()-interval '1 second' where user_id=$1", [expired]);
    // Deliberately no JWT/aal/session: service_role delegates only the trusted actor id.
    expect((await service(async () => (await db().query('select public.admin_get_permissions($1) as r', [admin])).rows[0].r)).permissionCodes).toHaveLength(38);
    for (const id of [inactive, expired, supporter, await actor('user'), randomUUID()]) {
      await reject(() => service(() => db().query('select public.admin_get_permissions($1)', [id])), '42501', 'ROLE_PERMISSION_FORBIDDEN');
      await reject(() => service(() => db().query('select public.admin_set_role_permissions($1,$2,$3,$4,$5)',
        [id, 'supporter', [], '0', randomUUID()])), '42501', 'ROLE_PERMISSION_FORBIDDEN');
    }
    expect((await db().query('select private.group_g_actor_has_permissions($1,$2::text[]) as ok', [admin, codes])).rows[0].ok).toBe(true);
    for (const code of codes) {
      expect((await db().query('select private.group_g_actor_has_permissions($1,$2::text[]) as ok', [supporter, [code]])).rows[0].ok).toBe(false);
      for (const id of [inactive, expired]) {
        expect((await db().query('select private.group_g_actor_has_permissions($1,$2::text[]) as ok', [id, [code]])).rows[0].ok).toBe(false);
      }
    }
  });

  async function attempt(change = ''): Promise<AssertFailure | null> {
    await db().query('savepoint acc_assert');
    let failure: AssertFailure | null = null;
    try {
      // The helper pins the pre-S0 baseline first, then executes the tamper and the assertion together.
      await withAccountingPermissionBaseline(db(), `${change};\n${assertion}`);
    } catch (error) {
      const e = error as AssertFailure;
      failure = { code: e.code, message: e.message === 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' ? e.message : 'ACC_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally { await db().query('rollback to savepoint acc_assert'); await db().query('release savepoint acc_assert'); }
    return failure;
  }

  test('FREQ-553-AC-01: S0末尾assertは適用後の状態と呼出元search_pathを許す', async () => {
    expect(assertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('set local search_path=pg_catalog')).toBeNull();
    expect(await attempt('set local search_path=public,private,pg_catalog')).toBeNull();
  });

  test('FREQ-553-AC-01: 本文のLFだけをCRLFへ変えた2関数も同じ指紋として扱う', async () => {
    expect(await attempt(`do $crlf$ declare f record; begin
      for f in select p.oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
        where n.nspname='private' and p.proname in ('admin_get_permissions','admin_set_role_permissions') loop
        execute pg_catalog.replace(pg_catalog.pg_get_functiondef(f.oid),E'\\n',E'\\r\\n');
      end loop;
    end $crlf$`)).toBeNull();
  });

  test.each([
    ['alter table public.permissions disable row level security', 'acc_s0_permission_catalogs'],
    ['alter table public.role_permissions disable row level security', 'acc_s0_permission_catalogs'],
    ['grant select on public.roles to anon', 'acc_s0_permission_catalogs'],
    ['grant insert on public.role_permissions to authenticated', 'acc_s0_permission_catalogs'],
    ['create function private.admin_get_permissions(text) returns jsonb language sql as $$select null::jsonb$$', 'acc_s0_permission_catalogs'],
    ['create function public.admin_set_role_permissions(text) returns jsonb language sql as $$select null::jsonb$$', 'acc_s0_permission_catalogs'],
    [`do $rewrite$ declare d text; begin select pg_get_functiondef('private.admin_get_permissions(uuid)'::regprocedure) into d;
      execute replace(d,', ''admin.accounting.integration.manage''',''); end $rewrite$`, 'acc_s0_permission_catalogs'],
    [`do $rewrite$ declare d text; begin select pg_get_functiondef('private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)'::regprocedure) into d;
      execute replace(d,', ''admin.accounting.integration.manage''',''); end $rewrite$`, 'acc_s0_permission_catalogs'],
    ['alter function private.admin_set_role_permissions(uuid,text,text[],bigint,uuid) security invoker', 'acc_s0_permission_catalogs'],
    ['grant execute on function private.admin_get_permissions(uuid) to authenticated', 'acc_s0_permission_catalogs'],
    ['revoke execute on function private.admin_get_permissions(uuid) from service_role', 'acc_s0_permission_catalogs'],
    ['alter function public.admin_get_permissions(uuid) security definer', 'acc_s0_permission_catalogs'],
    ['grant execute on function public.admin_set_role_permissions(uuid,text,text[],bigint,uuid) to anon', 'acc_s0_permission_catalogs'],
    ["delete from public.role_permissions rp using public.permissions p where rp.permission_id=p.id and p.code='admin.accounting.export.read'", 'acc_s0_permission_seed'],
    [`insert into public.role_permissions(role_id,permission_id) select r.id,p.id from public.roles r cross join public.permissions p
      where r.code='supporter' and p.code='admin.accounting.export.read'`, 'acc_s0_permission_seed'],
    ["update public.permissions set name='tampered' where code='admin.accounting.close.manage'", 'acc_s0_permission_seed'],
    ["update public.roles set permissions_version=permissions_version+1 where code='admin'", 'acc_s0_permission_seed'],
    ['drop table pg_temp.accounting_permission_baseline', 'acc_s0_permission_seed'],
    ["update public.roles set permissions_version=permissions_version+1 where code='supporter'", 'acc_s0_existing_dml_allowlist'],
    ["update public.permissions set name='tampered' where code='admin.items.read'", 'acc_s0_existing_dml_allowlist'],
    [`delete from public.role_permissions rp using public.roles r,public.permissions p where rp.role_id=r.id and rp.permission_id=p.id
      and r.code='supporter' and p.code='admin.orders.read'`, 'acc_s0_existing_dml_allowlist'],
    [`insert into public.role_permissions(role_id,permission_id) select r.id,p.id from public.roles r cross join public.permissions p
      where r.code='supporter' and p.code='admin.finance.read'`, 'acc_s0_existing_dml_allowlist'],
  ])('FREQ-553-AC-01: S0改ざん %s は55000とDETAIL=%sで拒む', async (change, detail) => {
    expect(await attempt(change)).toEqual({ code: '55000', message: 'ACCOUNTING_MIGRATION_ASSERTION_FAILED', detail });
    expect(await attempt()).toBeNull();
  });
});
