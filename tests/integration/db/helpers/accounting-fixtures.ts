import fs from 'node:fs';
import path from 'node:path';
import type { PgClient } from './local-db';

const directory = path.join(process.cwd(), 'supabase/migrations');
const s0Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p1_permissions.sql'));
/** The accounting S0 migration text (empty when it is missing, so the source contract fails visibly). */
export const ACCOUNTING_S0_SQL = s0Files.length === 1 ? fs.readFileSync(path.join(directory, s0Files[0]), 'utf8') : '';
export const ACCOUNTING_S0_FILES = s0Files;

/** The six accounting permissions S0 adds (owner role only). */
export const ACCOUNTING_PERMISSION_CODES = [
  'admin.accounting.settings.manage', 'admin.accounting.entries.correct', 'admin.accounting.close.manage',
  'admin.accounting.inventory.manage', 'admin.accounting.export.read', 'admin.accounting.integration.manage',
] as const;

/** One section of S0 between `-- ACC_S0_<name>_BEGIN` and `-- ACC_S0_<name>_END`. */
export function accountingS0Section(name: 'BODY' | 'PERMISSION_SEED' | 'FINAL_ASSERT'): string {
  return ACCOUNTING_S0_SQL.split(`-- ACC_S0_${name}_BEGIN\n`)[1]?.split(`-- ACC_S0_${name}_END`)[0] ?? '';
}

/** Body fingerprints S0 fixes for the two permission functions, read from its final assert. */
export function accountingS0PermissionBodyMd5(signature: 'private.admin_get_permissions(uuid)'
  | 'private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)'): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\('${escaped}','\\w+','([0-9a-f]{32})'\\)`).exec(accountingS0Section('FINAL_ASSERT'))?.[1] ?? 'missing';
}

const H1_PERMISSION_BODY_MD5 = {
  'private.admin_get_permissions(uuid)': 'e74dab48011008b34e1c42f06f75efcf',
  'private.admin_set_role_permissions(uuid,text,text[],bigint,uuid)': '8dd855720e3442134a80e240e8474185',
} as const;

/**
 * S0 recreates the two permission functions H1 fingerprinted, so a replay of H1's final assert compares their
 * bodies with S0's fingerprints instead. Every other H1 check stays as written; S0's own assert fixes the bodies.
 */
export function withS0PermissionBodies(h1AssertSql: string): string {
  let sql = h1AssertSql;
  for (const [signature, md5] of Object.entries(H1_PERMISSION_BODY_MD5)) {
    if (!sql.includes(`'${md5}'`)) throw new Error('H1_PERMISSION_BODY_MD5_MISSING');
    sql = sql.replace(`'${md5}'`, `'${accountingS0PermissionBodyMd5(signature as keyof typeof H1_PERMISSION_BODY_MD5)}'`);
  }
  return sql;
}

/** Pin the pre-S0 permission state BEFORE a caller tampers with the applied catalog, then run the assert. */
export async function withAccountingPermissionBaseline(client: PgClient, assertSql: string): Promise<void> {
  // A multi-statement query cannot take bind parameters; the codes are fixed literals above.
  const codes = `array[${ACCOUNTING_PERMISSION_CODES.map((code) => `'${code}'`).join(',')}]::text[]`;
  await client.query(`create temp table accounting_permission_baseline(payload jsonb) on commit drop;
    insert into pg_temp.accounting_permission_baseline(payload) select jsonb_build_object(
      'permissions',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.permissions p
        where not (p.code=any(${codes}))),'[]'::jsonb),
      'role_permissions',coalesce((select jsonb_agg(to_jsonb(rp) order by rp.role_id,rp.permission_id)
        from public.role_permissions rp join public.permissions p on p.id=rp.permission_id
        where not (p.code=any(${codes}))),'[]'::jsonb),
      'roles',(select jsonb_agg(jsonb_build_object('id',r.id,'code',r.code,'permissions_version',
        r.permissions_version-case when r.code='admin' then 1 else 0 end) order by r.id) from public.roles r),
      'acc_permissions',0,'acc_grants',0)`);
  await client.query(assertSql);
}
