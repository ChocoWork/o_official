/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb } from './helpers/local-db';
import { G2_ALLOWLIST, G3C_ALLOWLIST, G3D_ALLOWLIST, runWithAllowlist } from './helpers/group-g-allowlist';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = [
  '20261025053324_group_g3_shipping_foundation.sql',
  '20261025070821_group_g3_shipping_reads.sql',
  '20261025100130_group_g3_shipping_slips.sql',
  '20261025134538_group_g3_shipping_actions.sql',
] as const;
const migrations = files.map((file, index) => {
  const sql = fs.readFileSync(path.join(directory, file), 'utf8');
  const tag = `G3${'ABCD'[index]}`;
  const begin = `-- ${tag}_FINAL_ASSERT_BEGIN`;
  const end = `-- ${tag}_FINAL_ASSERT_END`;
  const start = sql.indexOf(begin);
  const finish = sql.indexOf(end);
  if (start < 0 || finish <= start) throw new Error('G3_FINAL_ASSERT_SECTION_MISSING');
  return { file, sql, tag, assertion: sql.slice(start + begin.length, finish) };
});

/** G2B's final assertion (the 65-entry snapshot): the shared helper swaps the allowlist to its own time's set before running it. */
const g2bFile = fs.readdirSync(directory).filter((f) => f.endsWith('_group_g2_purchasing_writers.sql'));
if (g2bFile.length !== 1) throw new Error('G2B_MIGRATION_MISSING');
const g2bSql = fs.readFileSync(path.join(directory, g2bFile[0]), 'utf8');
const g2bBegin = g2bSql.indexOf('-- G2B_FINAL_ASSERT_BEGIN');
const g2bEnd = g2bSql.indexOf('-- G2B_FINAL_ASSERT_END');
if (g2bBegin < 0 || g2bEnd <= g2bBegin) throw new Error('G2B_FINAL_ASSERT_SECTION_MISSING');
const G2B_ASSERT = g2bSql.slice(g2bBegin, g2bEnd);

/** Keep DO bodies visible. Only CREATE FUNCTION bodies (including named dollar quotes) may write data. */
function dataStatementsOutsideFunctions(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b[\s\S]*?\bAS\s+(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)[\s\S]*?\1/gi, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  return (code.match(/\bINSERT\s+INTO\s+[\w."]+|\bUPDATE\s+(?:ONLY\s+)?[\w."]+\s+(?:(?:AS\s+)?\w+\s+)?SET\b|\bDELETE\s+FROM\s+[\w."]+|\bMERGE\s+INTO\s+[\w."]+|\bTRUNCATE\s+(?!ON\b)(?:TABLE\s+)?[\w."]+/gi) ?? [])
    .map((s) => s.replace(/\s+/g, ' ').trim());
}

describe('G-3 Task 10: four migration files (no DB)', () => {
  test('FREQ-540-AC-12: the four timestamps follow G2B in order; unrelated later migrations are not inputs', () => {
    expect(fs.readdirSync(directory).filter((f) => /_group_g3_shipping_.*\.sql$/.test(f)).sort()).toEqual(files);
    const versions = files.map((f) => f.slice(0, 14));
    expect(versions).toEqual([...versions].sort());
    expect(new Set(versions).size).toBe(4);
    for (const version of versions) expect(version > '20261024180500').toBe(true);
    expect(G2_ALLOWLIST).toHaveLength(65);
    expect(G3C_ALLOWLIST).toHaveLength(72);
    expect(G3D_ALLOWLIST).toHaveLength(75);
    expect(G3D_ALLOWLIST.slice(0, 65)).toEqual(G2_ALLOWLIST);
    expect(G3D_ALLOWLIST.slice(0, 72)).toEqual(G3C_ALLOWLIST);
  });

  test.each(migrations)('FREQ-540-AC-12: $file has clean UTF-8/LF, one envelope and no top-level data writes', ({ sql, tag }) => {
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/[\r\u3000\u00a0\u200b-\u200d\ufeff]/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.split('\n').indexOf('BEGIN;')).toBeLessThan(10);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const marker of ['BODY_BEGIN', 'BODY_END', 'FINAL_ASSERT_BEGIN', 'FINAL_ASSERT_END']) {
      expect(sql.split(`-- ${tag}_${marker}`)).toHaveLength(2);
    }
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bUSAGE\s+ON\s+SCHEMA\s+private\b/i);
    expect(sql).not.toMatch(/proacl\s*::\s*text/i);
    expect(dataStatementsOutsideFunctions(sql)).toEqual([]);
    // No byte limit: the measured bytes / MD5 belong in the report, including >150 KB.
  });

  test('FREQ-540-AC-12: the scanner detects writes inside DO and outside functions, including tagged bodies', () => {
    expect(dataStatementsOutsideFunctions('CREATE TRIGGER guard BEFORE TRUNCATE ON public.shipment_slips EXECUTE FUNCTION private.guard();')).toEqual([]);
    for (const write of ['INSERT INTO public.shipment_slips DEFAULT VALUES', 'UPDATE public.shipment_slips SET version=1',
      'UPDATE public.shipment_slips s SET version=1', 'UPDATE public.shipment_slips AS s SET version=1',
      'UPDATE ONLY public.shipment_slips SET version=1', 'UPDATE ONLY public.shipment_slips s SET version=1',
      'MERGE INTO public.shipment_slips AS t USING public.orders AS o ON t.id = o.id WHEN MATCHED THEN DELETE',
      'DELETE FROM public.shipment_slips', 'TRUNCATE TABLE public.shipment_slips']) {
      expect(dataStatementsOutsideFunctions(`DO $check$ BEGIN ${write}; END $check$;`)).toHaveLength(1);
      expect(dataStatementsOutsideFunctions(`${write};`)).toHaveLength(1);
      for (const quote of ['$$', '$writer$']) {
        expect(dataStatementsOutsideFunctions(`CREATE OR REPLACE FUNCTION private.probe() RETURNS void LANGUAGE plpgsql AS ${quote} BEGIN ${write}; END ${quote};`)).toEqual([]);
      }
    }
  });

  test.each([2, 3])('FREQ-540-AC-11: file %s pins the exact writer signatures, order, uniqueness and count', (index) => {
    const sql = migrations[index].sql;
    const tail = sql.slice(sql.indexOf('v_writers text[] := ARRAY['));
    const entries = [...tail.slice(0, tail.indexOf('];')).matchAll(/^\s*'(private\.[^']+|public\.[^']+)'[,]?\s*$/gm)].map((m) => m[1]);
    const expected = index === 2 ? G3C_ALLOWLIST : G3D_ALLOWLIST;
    expect(entries).toEqual(expected);
    expect(new Set(entries).size).toBe(expected.length);
  });

  test.each([
    [0, ['shipping_tables', 'shipping_table_acl', 'shipping_table_triggers', 'shipping_consumption_triggers', 'shipping_table_rows',
      'shipping_fulfillment_columns', 'shipping_guard_functions', 'shipping_reason_codes', 'shipping_delete_blockers']],
    [1, ['shipping_read_functions', 'shipping_internal_functions', 'shipping_replaced_readers']],
    [2, ['shipping_slip_functions', 'shipping_slip_lock_order', 'shipping_slip_allowlist', 'shipping_slip_function_set', 'shipping_slip_table_acl']],
    [3, ['shipping_action_functions', 'shipping_action_allowlist', 'shipping_action_function_set', 'shipping_action_replaced', 'shipping_action_table_acl']],
  ] as const)('FREQ-540-AC-12: file %s has the brief detail names and semantic assertions', (index, details) => {
    const assertion = migrations[index].assertion;
    for (const detail of details) expect(assertion).toContain(`'${detail}'`);
    for (const raise of assertion.match(/RAISE EXCEPTION [^;]+;/g) ?? []) {
      expect(raise).toMatch(/^RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = (?:v_\w+|'[a-z_]+');$/);
    }
    if (index === 0 || index >= 2) {
      expect(assertion).toContain(`$g3${'abcd'[index]}_final_table_acl$`);
      expect(assertion).toContain('MAINTAIN');
      expect(assertion).toContain('170000');
    }
  });
});

type Failure = { code?: string; message?: string; detail?: string };
const failed = (detail: string) => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
const LOCK = 'private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)';
const SAVE = 'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)';
const DISCARD = 'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)';
const CONFIRM = 'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)';
const CANCEL = 'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)';
const TRACK = 'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)';
const DELIVERED = 'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)';
const DATE = 'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)';
const READ_RESULT = 'private.record_delivery_read_result(uuid,integer,uuid,jsonb)';

describeLocalDb('G-3 Task 10: final assertions reject catalog / ACL tampering', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  /**
   * Both expected SQL errors and catalog mutations are contained in this savepoint. The final DB holds 75 writers, so a file whose
   * assertion fixes an earlier set is run after the shared helper swaps the allowlist, inside this transaction, to the set that
   * existed when the file was applied (G3C: 72; G3D and the earlier files: the real 75). `swap` overrides that default.
   */
  async function attempt(assertion: string, change: string, swap: readonly string[] | undefined): Promise<Failure | null> {
    await db().query('savepoint g3_assert_tamper');
    try {
      if (change) await db().query(change);
      if (swap) await runWithAllowlist(db(), swap, assertion);
      else await db().query(assertion);
      return null;
    } catch (caught) {
      const { code, message, detail } = caught as Failure;
      return { code, message, detail };
    } finally {
      await db().query('rollback to savepoint g3_assert_tamper');
      await db().query('release savepoint g3_assert_tamper');
    }
  }
  const run = (index: number, change = '', entries?: readonly string[]) =>
    attempt(migrations[index].assertion, change, entries ?? (index === 2 ? G3C_ALLOWLIST : undefined));
  /** Re-creates a function from its own catalog definition with one textual change (the savepoint undoes it). */
  const rewrite = (signature: string, from: string, to: string) => `do $rewrite$
declare v_def text := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($sig$${signature}$sig$));
begin
  if pg_catalog.strpos(v_def, $from$${from}$from$) = 0 then raise exception 'G3_TAMPER_TEXT_NOT_FOUND'; end if;
  execute pg_catalog.replace(v_def, $from$${from}$from$, $to$${to}$to$);
end
$rewrite$`;
  const READ_FIRST = 'PERFORM 1 FROM public.orders LIMIT 1;\n  PERFORM private.lock_group_g_shipment_slips(';

  test.each([0, 1, 2, 3])('FREQ-540-AC-12: unmodified file %s passes; G3C uses its 72-entry transaction snapshot', async (index) => {
    expect(await run(index)).toBeNull();
    expect((await db().query('select cardinality(private.group_g_writer_allowlist()) as n')).rows[0].n).toBe(75);
  });

  test.each([0, 1, 2, 3])('FREQ-540-AC-12: file %s is independent of the caller search_path', async (index) => {
    for (const searchPath of ['pg_catalog', 'public, private, pg_catalog']) {
      expect(await run(index, `set local search_path to ${searchPath}`)).toBeNull();
    }
  });

  const cases: Array<[number, string, string]> = [
    [0, 'alter trigger shipment_slips_change_guard on public.shipment_slips rename to g3_tampered_guard', 'shipping_table_triggers'],
    [0, 'alter table public.shipment_slip_versions disable trigger shipment_slip_versions_no_update', 'shipping_table_triggers'],
    [0, 'drop trigger group_g_shipment_consumption on public.order_fulfillment_lines', 'shipping_consumption_triggers'],
    [0, 'alter table public.shipment_slips disable row level security', 'shipping_tables'],
    [0, 'alter table public.order_fulfillments drop constraint order_fulfillments_shipment_date_check', 'shipping_fulfillment_columns'],
    [0, `alter table public.order_item_allocation_events drop constraint order_item_allocation_events_reason_check;
      alter table public.order_item_allocation_events add constraint order_item_allocation_events_reason_check check(reason is null or reason in
      ('fifo','checkout','stripe_payment_paid','stock_adjustment','refund_restock','refund_release','stripe_checkout_expired','stripe_voucher_expired',
       'admin_cancel','admin_cancel_failed_order','resolve_payment_exception','status_change','fixture_allocation','fixture_release','fixture_shipment')
       or created_at < transaction_timestamp())`, 'shipping_reason_codes'],
    [0, 'grant execute on function private.guard_group_g_shipment_slip_change() to service_role', 'shipping_guard_functions'],
    [0, `drop function public.item_delete_blockers(bigint[]);
      create function public.item_delete_blockers(_item_ids bigint[]) returns table(item_id bigint,has_orders boolean,has_stock_movements boolean,has_open_checkouts boolean)
      language sql stable security definer set search_path='' as $$ select null::bigint,false,false,false where false $$`, 'shipping_delete_blockers'],
    [1, 'drop function public.get_admin_shipment_slip(uuid,uuid)', 'shipping_read_functions'],
    [1, 'grant execute on function public.list_admin_packing(uuid,integer,integer,uuid) to anon', 'shipping_read_functions'],
    [1, 'grant execute on function private.get_admin_shipment_slip(uuid,uuid) to authenticated', 'shipping_read_functions'],
    [1, 'grant execute on function private.tracking_registration_owner(uuid,integer) to service_role', 'shipping_internal_functions'],
    [1, 'alter function private.delivery_tracking_backfill_targets() volatile', 'shipping_replaced_readers'],
    [1, 'grant execute on function public.get_order_delivery_detail(uuid) to authenticated', 'shipping_replaced_readers'],
    [1, 'create function private.tracking_registration_owner(uuid) returns uuid language sql as $$ select $1 $$', 'shipping_internal_functions'],
    [2, `drop function ${SAVE.replace('private.', 'public.')}`, 'shipping_slip_functions'],
    [2, `grant execute on function ${LOCK} to service_role`, 'shipping_slip_functions'],
    [2, `grant execute on function ${SAVE.replace('private.', 'public.')} to anon`, 'shipping_slip_functions'],
    [2, `revoke execute on function ${SAVE} from service_role`, 'shipping_slip_functions'],
    [2, 'create function private.admin_confirm_shipment_slip(uuid) returns integer language sql as $$ select 1 $$', 'shipping_slip_function_set'],
    [3, `drop function ${TRACK.replace('private.', 'public.')}`, 'shipping_action_functions'],
    [3, `grant execute on function ${TRACK} to authenticated`, 'shipping_action_functions'],
    [3, `revoke execute on function ${TRACK.replace('private.', 'public.')} from service_role`, 'shipping_action_functions'],
    [3, 'create function private.admin_correct_shipment_date(uuid) returns integer language sql as $$ select 1 $$', 'shipping_action_function_set'],
    [3, 'alter function private.record_delivery_read_result(uuid,integer,uuid,jsonb) security invoker', 'shipping_action_replaced'],
    [3, 'grant execute on function public.record_delivery_read_result(uuid,integer,uuid,jsonb) to anon', 'shipping_action_replaced'],
  ];
  test.each(cases)('FREQ-540-AC-12: file %s rejects %s with detail %s', async (index, change, detail) => {
    expect(await run(index, change)).toEqual(failed(detail));
    expect(await run(index)).toBeNull();
  });

  test.each([[2, SAVE], [2, DISCARD], [2, CONFIRM], [2, CANCEL], [3, TRACK], [3, DELIVERED], [3, DATE]] as const)(
    'FREQ-540-AC-11: file %s rejects %s once it reads a table before the common lock helper', async (index, signature) => {
      const detail = index === 2 ? 'shipping_slip_lock_order' : 'shipping_action_functions';
      expect(await run(index, rewrite(signature, 'PERFORM private.lock_group_g_shipment_slips(', READ_FIRST))).toEqual(failed(detail));
      expect(await run(index)).toBeNull();
    });

  test('FREQ-540-AC-11: file 2 rejects a lock helper whose first statement is not the common advisory', async () => {
    const advisory = 'PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);';
    expect(await run(2, rewrite(LOCK, advisory, `PERFORM 1;\n  ${advisory}`))).toEqual(failed('shipping_slip_lock_order'));
    expect(await run(2)).toBeNull();
  });

  test.each([
    ['takes the common advisory twice', 'PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);',
      'PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);\n  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);'],
    ['names the shared inventory lock helper', 'PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);',
      'PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);\n  -- lock_group_g_inventory'],
    ['no longer fans the result out through the targets', 'v_targets', 'v_fanout'],
    ['locks a row (written in lower case) before the advisory', 'PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);',
      'PERFORM 1 FROM public.orders LIMIT 1 for update;\n  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);'],
    ['has no FOR UPDATE clause at all', 'FOR UPDATE', 'FOR  UPDATE'],
    ['has no FOR SHARE clause at all', 'FOR SHARE', 'FOR  SHARE'],
  ])('FREQ-540-AC-12: file 3 rejects a replaced delivery read result that %s', async (_name, from, to) => {
    expect(await run(3, rewrite(READ_RESULT, from, to))).toEqual(failed('shipping_action_replaced'));
    expect(await run(3)).toBeNull();
  });

  test('FREQ-540-AC-11: each file accepts exactly the writer set of its own time, swapped in by the shared helper (65 / 72 / 75)', async () => {
    expect(await attempt(G2B_ASSERT, '', G2_ALLOWLIST)).toBeNull();
    expect(await run(2, '', G3C_ALLOWLIST)).toBeNull();
    expect(await run(3, '', G3D_ALLOWLIST)).toBeNull();
    expect(await attempt(G2B_ASSERT, '', G3C_ALLOWLIST)).toEqual(failed('purchase_writer_allowlist_missing'));
    expect(await attempt(G2B_ASSERT, '', G3D_ALLOWLIST)).toEqual(failed('purchase_writer_allowlist_missing'));
    expect(await run(2, '', G2_ALLOWLIST)).toEqual(failed('shipping_slip_allowlist'));
    expect(await run(2, '', G3D_ALLOWLIST)).toEqual(failed('shipping_slip_allowlist'));
    expect(await run(3, '', G3C_ALLOWLIST)).toEqual(failed('shipping_action_allowlist'));
    expect(await run(3, '', G2_ALLOWLIST)).toEqual(failed('shipping_action_allowlist'));
    // the swaps stay inside the savepoints: the DB still holds the 75 writers of G3D
    const ids = (await db().query('select private.group_g_writer_allowlist()::oid[] as ids')).rows[0].ids as number[];
    const expected = (await db().query('select array_agg(to_regprocedure(s)::oid) as ids from unnest($1::text[]) as s', [G3D_ALLOWLIST])).rows[0].ids as number[];
    expect(ids).toHaveLength(75);
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  test.each([2, 3])('FREQ-540-AC-11: file %s rejects missing, additional, substituted and duplicate writer OIDs', async (index) => {
    const entries = index === 2 ? G3C_ALLOWLIST : G3D_ALLOWLIST;
    const detail = index === 2 ? 'shipping_slip_allowlist' : 'shipping_action_allowlist';
    for (const changed of [entries.slice(0, -1), [...entries, LOCK], [LOCK, ...entries.slice(1)], [entries[1], ...entries.slice(1)]]) {
      expect(await run(index, '', changed)).toEqual(failed(detail));
    }
  });

  test.each([0, 2, 3])('FREQ-540-AC-12: file %s rejects table / column / PUBLIC grants and missing owner ACL privileges', async (index) => {
    const detail = ['shipping_table_acl', '', 'shipping_slip_table_acl', 'shipping_action_table_acl'][index];
    for (const change of ['grant select on public.shipment_slips to service_role', 'grant insert on public.shipment_slip_lines to anon',
      'grant select(id) on public.shipment_slips to authenticated', 'grant select(id) on public.shipment_slips to public',
      'revoke truncate on public.shipment_slip_versions from postgres']) {
      expect(await run(index, change)).toEqual(failed(detail));
    }
    const version = Number((await db().query("select current_setting('server_version_num') as n")).rows[0].n);
    if (version >= 170000) expect(await run(index, 'grant maintain on public.shipment_slips to anon')).toEqual(failed(detail));
  });

  test('FREQ-540-AC-12: only rows written by this transaction fail, older rows do not make a replay environment-dependent', async () => {
    const insert = (created: string) => `insert into public.shipment_slips(number,stage,customer_kind,customer_email,ship_to_full_name,
      ship_to_postal_code,ship_to_prefecture,ship_to_city,ship_to_address,ship_to_phone,draft_lines,expires_at,created_by,created_at)
      values('SL-29991230-9999','draft','guest','fixture@example.invalid','Fixture','0000000','Fixture','Fixture','Fixture','0000000000',
        '[]',now()+interval '7 days',gen_random_uuid(),${created})`;
    expect(await run(0, insert('transaction_timestamp()'))).toEqual(failed('shipping_table_rows'));
    expect(await run(0, insert("transaction_timestamp()-interval '1 day'"))).toBeNull();
  });
});
