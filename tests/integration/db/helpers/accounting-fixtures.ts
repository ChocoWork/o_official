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

const s1Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p1_grants_receipts.sql'));
/** The accounting S1 migration text (empty when it is missing, so the source contract fails visibly). */
export const ACCOUNTING_S1_SQL = s1Files.length === 1 ? fs.readFileSync(path.join(directory, s1Files[0]), 'utf8') : '';
export const ACCOUNTING_S1_FILES = s1Files;

/** One section of S1 between `-- ACC_S1_<name>_BEGIN` and `-- ACC_S1_<name>_END`. */
export function accountingS1Section(name: 'BODY' | 'FINAL_ASSERT'): string {
  return ACCOUNTING_S1_SQL.split(`-- ACC_S1_${name}_BEGIN\n`)[1]?.split(`-- ACC_S1_${name}_END`)[0] ?? '';
}

/** The twelve accounting tables S1 tightens (FREQ-553-AC-02). */
export const FINANCE_TABLES = [
  'admin_finance_entry_review_acks', 'admin_finance_entry_revisions', 'admin_finance_evidence_unavailable_records',
  'admin_finance_expense_templates', 'admin_finance_expenses', 'admin_finance_fixed_assets', 'admin_finance_partners',
  'admin_finance_receipts', 'admin_finance_seasons', 'admin_finance_summary_options', 'admin_finance_year_closings',
  'admin_finance_years',
] as const;

/** The eight sequences the twelve tables own (the other four have natural keys). */
export const FINANCE_SEQUENCES = [
  'admin_finance_entry_review_acks_id_seq', 'admin_finance_entry_revisions_id_seq', 'admin_finance_expense_templates_id_seq',
  'admin_finance_expenses_id_seq', 'admin_finance_fixed_assets_id_seq', 'admin_finance_partners_id_seq',
  'admin_finance_receipts_id_seq', 'admin_finance_summary_options_id_seq',
] as const;

/** The sequences the twelve tables own, read from pg_depend (auto / internal), sorted by name. */
export async function ownedFinanceSequences(client: PgClient): Promise<string[]> {
  const result = await client.query(
    `select s.relname::text as name
     from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
     where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
       and d.refobjid = any (select ('public.' || t)::regclass::oid from unnest($1::text[]) as t)
     order by 1 collate "C"`,
    [[...FINANCE_TABLES]],
  );
  return result.rows.map((row) => row.name as string);
}

/** Today's date in Japan (YYYY-MM-DD). Entry dates stay inside the opening year .. this JST year + 1 window. */
export function japanToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

const s2Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p1_journal_foundation.sql'));
/** The accounting S2 migration text (empty when it is missing, so the source contract fails visibly). */
export const ACCOUNTING_S2_SQL = s2Files.length === 1 ? fs.readFileSync(path.join(directory, s2Files[0]), 'utf8') : '';
export const ACCOUNTING_S2_FILES = s2Files;

/** One section of S2: the body, the final assert, or the account rows between ACC_ACCOUNTS_BEGIN/END. */
export function accountingS2Section(name: 'BODY' | 'FINAL_ASSERT' | 'ACCOUNTS'): string {
  const marker = name === 'ACCOUNTS' ? 'ACC_ACCOUNTS' : `ACC_S2_${name}`;
  return ACCOUNTING_S2_SQL.split(`-- ${marker}_BEGIN\n`)[1]?.split(`-- ${marker}_END`)[0] ?? '';
}

export type AccountingBusinessType = 'soleProprietor' | 'corporation';

function periodName(businessType: AccountingBusinessType, startsOn: string, term: number): string {
  return businessType === 'soleProprietor' ? `${startsOn.slice(0, 4)}年（個人）` : `第${term}期`;
}

/**
 * Insert a period with explicit dates (ROLLBACK tests only: periods cannot be removed once committed with entries).
 * Inserted directly as the connection's role; S2 has no period entry point yet (S3 adds it).
 */
export async function insertAccountingPeriod(client: PgClient,
  input: { businessType: AccountingBusinessType; startsOn: string; endsOn: string }): Promise<string> {
  const term = Number((await client.query('select count(*) as n from public.accounting_periods where business_type = $1',
    [input.businessType])).rows[0].n) + 1;
  const row = (await client.query(
    `insert into public.accounting_periods (business_type, name, starts_on, ends_on) values ($1, $2, $3::date, $4::date)
     returning id`, [input.businessType, periodName(input.businessType, input.startsOn, term), input.startsOn, input.endsOn])).rows[0];
  return row.id as string;
}

/**
 * Insert the period right after the last one of the business type (2026 for the first sole period, 2027-07-01 for the
 * first corporation period). For suites that must commit; the dates never collide with committed earlier runs.
 */
export async function seedAccountingPeriod(client: PgClient, input: { businessType: AccountingBusinessType }): Promise<string> {
  const next = (await client.query(
    `select to_char(s.starts_on, 'YYYY-MM-DD') as starts_on,
       to_char(case when $1 = 'soleProprietor' then make_date(extract(year from s.starts_on)::integer, 12, 31)
         else (s.starts_on + interval '1 year' - interval '1 day')::date end, 'YYYY-MM-DD') as ends_on
     from (select coalesce(max(p.ends_on) + 1, case when $1 = 'soleProprietor' then date '2026-01-01' else date '2027-07-01' end)
       as starts_on from public.accounting_periods p where p.business_type = $1) s`, [input.businessType])).rows[0];
  return insertAccountingPeriod(client, { businessType: input.businessType, startsOn: next.starts_on, endsOn: next.ends_on });
}

export type JournalLineInput = { account: string; debit?: number; credit?: number };

/** The _lines jsonb the core takes. */
export function journalLines(lines: readonly JournalLineInput[]): string {
  return JSON.stringify(lines.map((line) => ({
    account_code: line.account, debit: line.debit ?? 0, credit: line.credit ?? 0,
    sub_account: null, counterparty: null, order_id: null, memo: null,
  })));
}

/** Post through the core (no permission check) as the connection's role. */
export async function postJournal(client: PgClient, input: {
  periodId: string; entryDate: string; kind: string; parts: string[]; lines: JournalLineInput[]; sourceRecordedAt?: string;
}): Promise<{ entryId: string; entryNo: number; created: boolean }> {
  const result = (await client.query(
    `select private.accounting_post_journal_core(null, $1::uuid, $2::date, $3::text, $4::text[], 'test entry', $5::jsonb,
       _source_recorded_at => $6::timestamptz) as r`,
    [input.periodId, input.entryDate, input.kind, input.parts, journalLines(input.lines), input.sourceRecordedAt ?? null])).rows[0].r;
  return { entryId: result.entry_id, entryNo: Number(result.entry_no), created: result.created };
}

/** An actor with the owner role (admin), which holds admin.finance.manage. */
export async function insertAccountingAdmin(client: PgClient): Promise<string> {
  const id = (await client.query('select gen_random_uuid() as id')).rows[0].id as string;
  await client.query("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [id]);
  await client.query(`insert into public.user_roles (user_id, role_id, active)
    select $1::uuid, r.id, true from public.roles r where r.code = 'admin'`, [id]);
  return id;
}

/** The 163 account codes S2 seeds (read from its ACC_ACCOUNTS block; later migrations may add other codes). */
export const ACCOUNTING_S2_ACCOUNT_CODES: readonly string[] = [...accountingS2Section('ACCOUNTS').matchAll(/^ {2}\('(\d{4})',/gm)]
  .map((match) => match[1]);

/**
 * Pin the current state as the S2 baseline BEFORE a caller tampers, so a replay of the S2 final assert compares with
 * what exists now (the periods, numbers, entries and lines counts, and the accounts later migrations added) instead of
 * the empty state at apply time. Then the caller runs the assert.
 */
export async function pinAccountingS2Baseline(client: PgClient): Promise<void> {
  if (ACCOUNTING_S2_ACCOUNT_CODES.length !== 163) throw new Error('ACC_S2_ACCOUNT_CODES_MISSING');
  // A multi-statement query cannot take bind parameters; the codes are four digits read from the migration.
  const codes = `array[${ACCOUNTING_S2_ACCOUNT_CODES.map((code) => `'${code}'`).join(',')}]::text[]`;
  await client.query(`create temp table accounting_s2_baseline(payload jsonb) on commit drop;
    insert into pg_temp.accounting_s2_baseline(payload) select jsonb_build_object(
      'periods', (select count(*) from public.accounting_periods),
      'sequences', (select count(*) from public.accounting_period_sequences),
      'entries', (select count(*) from public.accounting_journal_entries),
      'lines', (select count(*) from public.accounting_journal_lines),
      'other_accounts', coalesce((select jsonb_agg(to_jsonb(a) order by a.code collate "C") from public.accounting_accounts a
        where not (a.code = any(${codes}))), '[]'::jsonb))`);
}

const s3Files = fs.readdirSync(directory).filter((name) => name.endsWith('_accounting_p1_period_reads.sql'));
/** The accounting S3 migration text (empty when it is missing, so the source contract fails visibly). */
export const ACCOUNTING_S3_SQL = s3Files.length === 1 ? fs.readFileSync(path.join(directory, s3Files[0]), 'utf8') : '';
export const ACCOUNTING_S3_FILES = s3Files;

/** One section of S3 between `-- ACC_S3_<name>_BEGIN` and `-- ACC_S3_<name>_END`. */
export function accountingS3Section(name: 'BODY' | 'FINAL_ASSERT'): string {
  return ACCOUNTING_S3_SQL.split(`-- ACC_S3_${name}_BEGIN\n`)[1]?.split(`-- ACC_S3_${name}_END`)[0] ?? '';
}

/**
 * Pin the current state as the S3 baseline BEFORE a caller tampers: the settings row as it is now and the number of
 * stored opening rows, instead of the fresh row and no opening row of apply time. Then the caller runs the assert.
 */
export async function pinAccountingS3Baseline(client: PgClient): Promise<void> {
  await client.query(`create temp table accounting_s3_baseline(payload jsonb) on commit drop;
    insert into pg_temp.accounting_s3_baseline(payload) select jsonb_build_object(
      'settings', (select to_jsonb(s) from public.accounting_settings s),
      'opening_rows', (select count(*) from public.accounting_opening_balances))`);
}

export type AccountingFailure = { code?: string; message?: string; detail?: string };

/**
 * Run inside a savepoint, then SET CONSTRAINTS ALL IMMEDIATE (so deferred checks fire too); return the fixed error
 * (DB text other than ACCOUNTING_* becomes DATABASE_ERROR) or null. Everything the run wrote is undone either way.
 */
export async function accountingFailure(client: PgClient, run: () => Promise<unknown>): Promise<AccountingFailure | null> {
  await client.query('savepoint acc_failure');
  try {
    await run();
    await client.query('set constraints all immediate');
    return null;
  } catch (caught) {
    const e = caught as AccountingFailure;
    const fixed = /^ACCOUNTING_[A-Z_]+$/.test(e.message ?? '');
    const message = fixed ? e.message : 'DATABASE_ERROR';
    return fixed && e.detail ? { code: e.code, message, detail: e.detail } : { code: e.code, message };
  } finally {
    await client.query('rollback to savepoint acc_failure');
    await client.query('release savepoint acc_failure');
  }
}

/** The period jsonb of public.admin_create_accounting_period (S3), called as the connection's role. */
export type AccountingPeriodJson = {
  id: string; business_type: AccountingBusinessType; name: string; starts_on: string; ends_on: string;
  corporate_tax_extension_months: number; consumption_tax_extension_months: number;
  consumption_tax_status: 'exempt' | 'taxable'; consumption_taxable_from: string | null; version: string;
  legacy_fiscal_year: number | null;
};

/** Create a period through the S3 entry (ROLLBACK tests; explicit dates). */
export async function createAccountingPeriod(client: PgClient, actorId: string | null, input: {
  businessType: AccountingBusinessType; startsOn: string; endsOn: string; name?: string | null; requestKey?: string;
}): Promise<AccountingPeriodJson> {
  return (await client.query(
    `select public.admin_create_accounting_period($1::uuid, $2::text, $3::date, $4::date, $5::text,
       coalesce($6::uuid, gen_random_uuid())) as r`,
    [actorId, input.businessType, input.startsOn, input.endsOn, input.name ?? null, input.requestKey ?? null])).rows[0].r;
}
