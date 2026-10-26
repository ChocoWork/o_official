/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { G3A_REASON_CODES, G3D_ALLOWLIST, G4_ALLOWLIST, replaceAllowlistSql, replaceReasonCheckSql, runWithAllowlist } from './helpers/group-g-allowlist';
import { seedGroupG3ReadyOrder, seedGroupG3Slip } from './helpers/group-g3-fixtures';

const directory = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g4_orders_foundation.sql'));
if (files.length !== 1) throw new Error('G4A_MIGRATION_MISSING');
const sql = fs.readFileSync(path.join(directory, files[0]), 'utf8');
const begin = '-- G4A_FINAL_ASSERT_BEGIN';
const end = '-- G4A_FINAL_ASSERT_END';
const start = sql.indexOf(begin);
const finish = sql.indexOf(end);
if (start < 0 || finish <= start) throw new Error('G4A_FINAL_ASSERT_MISSING');
const assertion = sql.slice(start + begin.length, finish);
const signature = 'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)';
const reasons = [...G3A_REASON_CODES, 'allocation_swap'];
// Keep existing multi-slip orders intact while changing only the stand-in index's uniqueness.
const standInTable = `alter index public.shipment_slip_fulfillments_order_idx rename to g4_old_idx;
  alter table public.shipment_slip_fulfillments rename to g4_old_ssf;
  create table public.shipment_slip_fulfillments(order_id uuid);`;

describe('G-4 Task 1: migration source (no DB)', () => {
  test('FREQ-540-AC-14: G4A は後続のUTC版・ASCII/LF・1組の取引と通知・4つの節印を持つ', () => {
    expect(files[0]).toMatch(/^\d{14}_group_g4_orders_foundation\.sql$/);
    expect(files[0].slice(0, 14) > '20261026010000').toBe(true);
    expect(sql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql.match(/NOTIFY pgrst, 'reload schema';/g)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const marker of ['BODY_BEGIN', 'BODY_END', 'FINAL_ASSERT_BEGIN', 'FINAL_ASSERT_END']) {
      expect(sql.split(`-- G4A_${marker}`)).toHaveLength(2);
    }
    expect(sql).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(sql).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bUSAGE\s+ON\s+SCHEMA\s+private\b/i);
    expect(sql).not.toMatch(/\bauth_return_intents\b/i);
  });

  test('FREQ-540-AC-14: 本体外にはDMLがなく、末尾assertは5つの項目名と55000だけを返す', () => {
    const outside = sql.replace(/--[^\n]*/g, ' ')
      .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''");
    expect(outside).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[\w.]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?[\w.]+)/i);
    for (const detail of ['orders_foundation_index', 'orders_foundation_confirm', 'orders_foundation_reasons',
      'orders_foundation_rows', 'orders_foundation_allowlist']) expect(assertion).toContain(`'${detail}'`);
    const raises = assertion.match(/RAISE EXCEPTION [^;]+;/g) ?? [];
    expect(raises).toHaveLength(1);
    expect(raises[0]).toBe("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;");
  });
});

const readsFiles = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g4_orders_reads.sql'));
if (readsFiles.length !== 1) throw new Error('G4B_MIGRATION_MISSING');
const readsSql = fs.readFileSync(path.join(directory, readsFiles[0]), 'utf8');
const readsAssertion = readsSql.split('-- G4B_FINAL_ASSERT_BEGIN')[1]?.split('-- G4B_FINAL_ASSERT_END')[0];
if (!readsAssertion) throw new Error('G4B_FINAL_ASSERT_MISSING');

const swapFiles = fs.readdirSync(directory).filter(name=>name.endsWith('_group_g4_orders_swap.sql'));
const swapSql = swapFiles.length === 1 ? fs.readFileSync(path.join(directory,swapFiles[0]),'utf8') : '';
const swapAssertion = swapSql.split('-- G4C_FINAL_ASSERT_BEGIN')[1]?.split('-- G4C_FINAL_ASSERT_END')[0] ?? '';

describe('G4C source', () => {
  test('FREQ-540-AC-14: 第3移行が存在し、ASCII/LFと取引・通知・節印の契約を持つ', () => {
    expect(swapFiles).toHaveLength(1);
    expect(swapFiles[0]?.slice(0,14) > '20261026054705').toBe(true);
    expect(swapSql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(swapSql.startsWith('BEGIN;\n')).toBe(true);
    for (const statement of [/^BEGIN;$/gm,/^COMMIT;$/gm,/NOTIFY pgrst, 'reload schema';/g])
      expect(swapSql.match(statement)).toHaveLength(1);
    expect(swapSql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const marker of ['BODY_BEGIN','BODY_END','FINAL_ASSERT_BEGIN','FINAL_ASSERT_END'])
      expect(swapSql.split(`-- G4C_${marker}`)).toHaveLength(2);
    expect(swapSql).not.toMatch(/(?:proacl|relacl)\s*::\s*text|\bauth_return_intents\b/i);
    expect(swapSql).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bUSAGE\s+ON\s+SCHEMA\s+private\b/i);
  });

  test('FREQ-540-AC-14: G4C は本体外にDMLがなく、末尾assertは5つの項目名と55000だけを返し、許可一覧は76本の固定集合', () => {
    const outside = swapSql.replace(/--[^\n]*/g, ' ')
      .replace(/CREATE (?:OR REPLACE )?FUNCTION[\s\S]*?\n\$\$;/g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''");
    expect(outside).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[\w.]+\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?[\w.]+)/i);
    expect(swapAssertion).not.toBe('');
    for (const detail of ['orders_swap_functions','orders_swap_lock_order','orders_swap_allowlist','orders_swap_function_set','orders_swap_table_acl'])
      expect(swapAssertion).toContain(`'${detail}'`);
    const raises = swapAssertion.match(/RAISE EXCEPTION [^;]+;/g) ?? [];
    expect(raises).toHaveLength(2);
    expect(raises[0]).toBe("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;");
    expect(raises[1]).toBe("RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'orders_swap_table_acl';");
    // The writer set pinned by the file equals the shared 76-entry constant, in order, once each.
    const tail = swapSql.slice(swapSql.indexOf('v_writers text[] := ARRAY['));
    const entries = [...tail.slice(0, tail.indexOf('];')).matchAll(/^\s*'(private\.[^']+|public\.[^']+)'[,]?\s*$/gm)].map((m) => m[1]);
    expect(entries).toEqual([...G4_ALLOWLIST]);
    expect(new Set(entries).size).toBe(76);
    const body = swapSql.slice(swapSql.indexOf('CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()'), swapSql.indexOf('-- G4C_BODY_END'));
    const listed = [...body.matchAll(/^\s*'((?:private|public)\.[^']+)',?\s*$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...G4_ALLOWLIST]);
  });
});

describe('G-4 Task 2: migration source (no DB)', () => {
  test('FREQ-540-AC-13: G4B はTask 1より後・ASCII/LF・1組の取引と通知・4つの節印を持つ', () => {
    expect(readsFiles[0]).toMatch(/^\d{14}_group_g4_orders_reads\.sql$/);
    expect(readsFiles[0].slice(0,14) > files[0].slice(0,14)).toBe(true);
    expect(readsSql).not.toMatch(/[^\x00-\x7f]|\r/);
    expect(readsSql.startsWith('BEGIN;\n')).toBe(true);
    expect(readsSql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(readsSql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(readsSql.match(/NOTIFY pgrst, 'reload schema';/g)).toHaveLength(1);
    expect(readsSql.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';\nCOMMIT;$/);
    for (const marker of ['BODY_BEGIN','BODY_END','FINAL_ASSERT_BEGIN','FINAL_ASSERT_END'])
      expect(readsSql.split(`-- G4B_${marker}`)).toHaveLength(2);
    expect(readsSql).not.toMatch(/(?:proacl|relacl)\s*::\s*text/i);
    expect(readsSql).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bUSAGE\s+ON\s+SCHEMA\s+private\b/i);
    expect(readsSql).not.toMatch(/\bauth_return_intents\b|generate_series|CREATE(?: OR REPLACE)? FUNCTION private\.group_g_item_state_ranges/i);
    expect(readsSql.match(/CREATE FUNCTION /g)).toHaveLength(11);
    expect(readsSql.match(/LANGUAGE (?:sql|plpgsql) STABLE SECURITY (?:DEFINER|INVOKER) SET search_path = ''/g)).toHaveLength(11);
  });

  test('FREQ-540-AC-13: 4つの末尾assert項目、非空の探索、DMLなしを契約に持つ', () => {
    for (const detail of ['orders_reads_internal','orders_reads_functions','orders_reads_public','orders_reads_no_write'])
      expect(readsAssertion).toContain(`'${detail}'`);
    expect(readsAssertion).toContain('v_scanned <> 11');
    const body = readsSql.split('-- G4B_BODY_BEGIN')[1].split('-- G4B_BODY_END')[0];
    expect(body.replace(/--[^\n]*/g,' ')).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+\w+\.|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i);
    expect(readsSql).toContain('WITH orders AS MATERIALIZED');
    expect(readsSql).toContain('LEAST(t.n, CASE WHEN t.t = 0 THEN t.q ELSE t.t END)');
  });
});

describeLocalDb('G-4 G4B: semantic final assertions / tampering', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });
  async function attempt(change: string | (() => Promise<unknown>) = ''): Promise<Failure | null> {
    await db().query('savepoint g4b_assert');
    try {
      if (typeof change === 'function') await change(); else if (change) await db().query(change);
      await db().query(readsAssertion);
      return null;
    } catch (error) {
      const e = error as Failure;
      return { code: e.code,message: e.message === 'GROUP_G_MIGRATION_ASSERTION_FAILED' ? e.message : 'G4_UNEXPECTED_DB_ERROR',detail: e.detail };
    } finally {
      await db().query('rollback to savepoint g4b_assert');
      await db().query('release savepoint g4b_assert');
    }
  }
  const helper = 'private.group_g_order_attention_ids(uuid[])';
  const reader = 'private.get_admin_order_detail(uuid,uuid)';
  const entry = 'public.get_admin_order_detail(uuid,uuid)';

  test('FREQ-540-AC-13: 通常形と呼出し元search_pathの違いで末尾assertが通る', async () => {
    expect(await attempt()).toBeNull();
    for (const searchPath of ['pg_catalog','public,private,pg_catalog'])
      expect(await attempt(`set local search_path to ${searchPath}`)).toBeNull();
  });

  test.each([
    [`grant execute on function ${helper} to service_role`,'orders_reads_internal'],
    [`grant execute on function ${helper} to public`,'orders_reads_internal'],
    [`alter function ${helper} security invoker`,'orders_reads_internal'],
    [`alter function ${helper} set search_path=public`,'orders_reads_internal'],
    [`grant execute on function ${entry} to anon`,'orders_reads_public'],
    [`grant execute on function ${entry} to authenticated`,'orders_reads_public'],
    [`revoke execute on function ${entry} from service_role`,'orders_reads_public'],
    [`alter function ${entry} security definer`,'orders_reads_public'],
    [`alter function ${reader} volatile`,'orders_reads_functions'],
    [`alter function ${reader} security invoker`,'orders_reads_functions'],
    [`grant execute on function ${reader} to public`,'orders_reads_functions'],
    [`drop function ${entry}`,'orders_reads_public'],
    [`create function public.get_admin_order_detail(uuid) returns jsonb language sql stable as 'select null::jsonb'`,'orders_reads_public'],
    [`create function private.get_admin_order_detail(uuid) returns jsonb language sql stable as 'select null::jsonb'`,'orders_reads_functions'],
    [`create function private.group_g_order_attention_ids(uuid) returns uuid[] language sql stable as 'select array[]::uuid[]'`,'orders_reads_internal'],
    [`create function public.group_g_order_attention_ids(uuid[]) returns uuid[] language sql stable as 'select array[]::uuid[]'`,'orders_reads_internal'],
  ])('FREQ-540-AC-13: G4B改ざん %s はDETAIL=%sで拒否、rollbackで復元', async (change,detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });

  test.each(['INSERT\n INTO public.orders DEFAULT VALUES','UPDATE\n public.orders SET updated_at=updated_at',
    'DELETE\n FROM public.orders','TRUNCATE public.orders',
    'MERGE\n INTO public.orders USING public.orders s ON false WHEN MATCHED THEN DO NOTHING'])
  ('FREQ-540-AC-13: 読取本体に書込み文 %s があれば正規化したprosrcから拒否する', async (statement) => {
    expect(await attempt(async () => {
      const definition = (await db().query('select pg_get_functiondef($1::regprocedure) as d',[reader])).rows[0].d as string;
      const header = definition.slice(0,definition.indexOf('AS $function$'));
      await db().query(`${header} AS $function$ BEGIN ${statement}; RETURN null; END $function$`);
    })).toEqual(failed('orders_reads_no_write'));
    expect(await attempt()).toBeNull();
  });

  test('FREQ-540-AC-13: 公開入口の委譲先差し替えを拒否する', async () => {
    expect(await attempt(`create or replace function ${entry.replace('(uuid,uuid)','(_order_id uuid,_actor_id uuid)')}
      returns jsonb language sql stable security invoker set search_path='' as 'select null::jsonb'`))
      .toEqual(failed('orders_reads_public'));
  });

  test('FREQ-540-AC-13: 一時ロールへ所有者を変える改ざんを拒否し、rollbackで所有者が戻る', async () => {
    const role = `g4b_owner_${randomUUID().replaceAll('-','')}`;
    expect(await attempt(`set local createrole_self_grant='set';create role ${role} nologin;
      grant create on schema private to ${role};alter function ${reader} owner to ${role}`))
      .toEqual(failed('orders_reads_functions'));
    expect((await db().query('select proowner::regrole::text as owner from pg_proc where oid=$1::regprocedure',[reader])).rows[0].owner).toBe('postgres');
    expect((await db().query('select exists(select 1 from pg_roles where rolname=$1) as present',[role])).rows[0].present).toBe(false);
    expect(await attempt()).toBeNull();
  });
});

type Failure = { code?: string; message?: string; detail?: string };
const failed = (detail: string): Failure => ({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail });
const rewrite = (from: string, to: string) => `do $rewrite$
declare v_def text := pg_catalog.pg_get_functiondef('${signature}'::regprocedure);
begin
  if pg_catalog.strpos(v_def,$from$${from}$from$)=0 then raise exception 'G4_TAMPER_TEXT_NOT_FOUND'; end if;
  execute pg_catalog.replace(v_def,$from$${from}$from$,$to$${to}$to$);
end $rewrite$`;

describeLocalDb('G-4 G4A: semantic final assertions / tampering', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function attempt(change: string | (() => Promise<unknown>) = '', writers: readonly string[] = G3D_ALLOWLIST): Promise<Failure | null> {
    await db().query('savepoint g4_assert');
    try {
      if (typeof change === 'function') await change();
      else if (change) await db().query(change);
      await runWithAllowlist(db(), writers, assertion);
      return null;
    } catch (error) {
      const e = error as Failure;
      return { code: e.code, message: e.message === 'GROUP_G_MIGRATION_ASSERTION_FAILED' ? e.message : 'G4_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally {
      await db().query('rollback to savepoint g4_assert');
      await db().query('release savepoint g4_assert');
    }
  }

  test('FREQ-540-AC-14: 通常のG4Aは通り、呼出し元search_pathと無関係なgranteeに依存しない', async () => {
    expect(await attempt()).toBeNull();
    expect(await attempt(`${standInTable}
      create index shipment_slip_fulfillments_order_idx on public.shipment_slip_fulfillments(order_id)`)).toBeNull();
    for (const searchPath of ['pg_catalog', 'public, private, pg_catalog']) {
      expect(await attempt(`set local search_path to ${searchPath}`)).toBeNull();
    }
    expect(await attempt(`create role g4_unrelated nologin; grant execute on function ${signature} to g4_unrelated`)).toBeNull();
  });

  test.each([
    ['drop index public.shipment_slip_fulfillments_order_idx', 'orders_foundation_index'],
    [`${standInTable} create unique index shipment_slip_fulfillments_order_idx on public.shipment_slip_fulfillments(order_id)`, 'orders_foundation_index'],
    ['drop index public.shipment_slip_fulfillments_order_idx; create index shipment_slip_fulfillments_order_idx on public.shipment_slip_fulfillments(fulfillment_id)', 'orders_foundation_index'],
    ['drop index public.shipment_slip_fulfillments_order_idx; create index shipment_slip_fulfillments_order_idx on public.shipment_slip_fulfillments(order_id) where order_id is not null', 'orders_foundation_index'],
    [rewrite('v_slip.expires_at <= pg_catalog.now()', 'v_slip.expires_at < pg_catalog.now()'), 'orders_foundation_confirm'],
    [`grant execute on function ${signature} to anon`, 'orders_foundation_confirm'],
    [rewrite('PERFORM private.lock_group_g_shipment_slips(', 'PERFORM 1 FROM public.orders LIMIT 1;\n  PERFORM private.lock_group_g_shipment_slips('), 'orders_foundation_confirm'],
    [rewrite('PERFORM private.lock_group_g_shipment_slips(', 'PERFORM 1 FROM pg_catalog.pg_class LIMIT 1;\n  PERFORM private.lock_group_g_shipment_slips('), 'orders_foundation_confirm'],
    [replaceReasonCheckSql(G3A_REASON_CODES), 'orders_foundation_reasons'],
    [replaceReasonCheckSql([...reasons, 'unknown_reason']), 'orders_foundation_reasons'],
    [replaceReasonCheckSql(reasons).replace('reason IS NULL OR ', ''), 'orders_foundation_reasons'],
    [replaceReasonCheckSql(reasons).replace('reason IS NULL OR ', "created_at < transaction_timestamp() OR reason IS NULL OR "), 'orders_foundation_reasons'],
  ])('FREQ-540-AC-14: %s を拒否し DETAIL=%s、rollback後に通常形へ戻る', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });

  test('FREQ-540-AC-14: 変更可能な一時ロールへの所有者変更をassertが拒否し、rollbackで所有者とロールを復元する', async () => {
    const role = `g4_owner_${randomUUID().replaceAll('-', '')}`;
    const snapshot = async () => (await db().query(
      `select oid,proowner,current_setting('createrole_self_grant') as self_grant
        from pg_catalog.pg_proc where oid=$1::regprocedure`, [signature],
    )).rows[0];
    const before = await snapshot();
    // Create the target with SET membership; ALTER OWNER also requires its schema CREATE privilege.
    expect(await attempt(`set local createrole_self_grant = 'set';
      create role ${role} nologin;
      grant create on schema private to ${role};
      alter function ${signature} owner to ${role}`)).toEqual(failed('orders_foundation_confirm'));
    expect(await snapshot()).toEqual(before);
    expect((await db().query('select exists(select 1 from pg_catalog.pg_roles where rolname=$1) as present', [role])).rows[0].present).toBe(false);
    expect(await attempt()).toBeNull();
  });

  test('FREQ-540-AC-14: この取引の発送票と割当イベントの行作成をそれぞれ拒否する', async () => {
    expect(await attempt(() => seedGroupG3Slip(db()))).toEqual(failed('orders_foundation_rows'));
    expect(await attempt(() => seedGroupG3ReadyOrder(db()))).toEqual(failed('orders_foundation_rows'));
    expect(await attempt()).toBeNull();
  });

  test('FREQ-540-AC-14: 過去の発送票は許し、この取引の行だけを検査する', async () => {
    expect(await attempt(`insert into public.shipment_slips(number,stage,customer_kind,customer_email,ship_to_full_name,
      ship_to_postal_code,ship_to_prefecture,ship_to_city,ship_to_address,ship_to_phone,expires_at,created_by,created_at)
      values('SL-29991230-9998','draft','guest','fixture@example.invalid','Fixture','0','Fixture','Fixture','Fixture','0',
        now()+interval '7 days',gen_random_uuid(),transaction_timestamp()-interval '1 day')`)).toBeNull();
  });

  test('FREQ-540-AC-14: G4A 時点の75本を要求し、74本と76本を拒否する', async () => {
    expect(await attempt('', G3D_ALLOWLIST.slice(1))).toEqual(failed('orders_foundation_allowlist'));
    expect(await attempt('', [...G3D_ALLOWLIST, signature])).toEqual(failed('orders_foundation_allowlist'));
    expect(await attempt()).toBeNull();
  });
});

const swapWriter = 'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)';
const swapEntry = 'public.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)';
const swapHelper = 'private.lock_group_g_allocation_swap(uuid,uuid,uuid)';
const candidatesBody = 'private.list_admin_allocation_swap_candidates(uuid,uuid,uuid)';
const candidatesEntry = 'public.list_admin_allocation_swap_candidates(uuid,uuid,uuid)';
const lockCall = 'PERFORM private.lock_group_g_allocation_swap(_order_id, _taker_order_item_id, _donor_order_item_id);';
const advisoryCall = 'PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);';
const rewriteFunction = (target: string, from: string, to: string) => `do $rewrite$
declare v_def text := pg_catalog.pg_get_functiondef('${target}'::regprocedure);
begin
  if pg_catalog.strpos(v_def,$from$${from}$from$)=0 then raise exception 'G4_TAMPER_TEXT_NOT_FOUND'; end if;
  execute pg_catalog.replace(v_def,$from$${from}$from$,$to$${to}$to$);
end $rewrite$`;

describeLocalDb('G-4 G4C: semantic final assertions / tampering', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  /** For a dropped writer, pin G4C before the tamper; resolving the list after DROP would fail before the assertion. */
  async function attempt(change: string | (() => Promise<unknown>) = '', writers: readonly string[] | null = G4_ALLOWLIST): Promise<Failure | null> {
    await db().query('savepoint g4c_assert');
    try {
      if (writers === null) await db().query(replaceAllowlistSql(G4_ALLOWLIST));
      if (typeof change === 'function') await change(); else if (change) await db().query(change);
      if (writers === null) await db().query(swapAssertion); else await runWithAllowlist(db(), writers, swapAssertion);
      return null;
    } catch (error) {
      const e = error as Failure;
      return { code: e.code, message: e.message === 'GROUP_G_MIGRATION_ASSERTION_FAILED' ? e.message : 'G4_UNEXPECTED_DB_ERROR', detail: e.detail };
    } finally {
      await db().query('rollback to savepoint g4c_assert');
      await db().query('release savepoint g4c_assert');
    }
  }

  test('FREQ-540-AC-14: G4C時点の一覧で通り、呼出し元search_pathと無関係なgranteeに依存しない', async () => {
    expect(swapAssertion).not.toBe('');
    expect(await attempt()).toBeNull();
    expect(await attempt('', null)).toBeNull();
    for (const searchPath of ['pg_catalog', 'public, private, pg_catalog']) {
      expect(await attempt(`set local search_path to ${searchPath}`)).toBeNull();
    }
    expect(await attempt(`create role g4c_unrelated nologin; grant execute on function ${swapHelper} to g4c_unrelated`)).toBeNull();
  });

  test.each([
    [`grant execute on function ${swapHelper} to service_role`, 'orders_swap_functions'],
    [`grant execute on function ${swapHelper} to public`, 'orders_swap_functions'],
    [`grant execute on function ${swapEntry} to anon`, 'orders_swap_functions'],
    [`grant execute on function ${swapEntry} to authenticated`, 'orders_swap_functions'],
    [`grant execute on function ${swapWriter} to public`, 'orders_swap_functions'],
    [`revoke execute on function ${swapEntry} from service_role`, 'orders_swap_functions'],
    [`revoke execute on function ${candidatesBody} from service_role`, 'orders_swap_functions'],
    [`grant execute on function ${candidatesEntry} to anon`, 'orders_swap_functions'],
    [`alter function ${swapWriter} security invoker`, 'orders_swap_functions'],
    [`alter function ${swapWriter} set search_path = public`, 'orders_swap_functions'],
    [`alter function ${swapEntry} security definer`, 'orders_swap_functions'],
    [`alter function ${candidatesBody} volatile`, 'orders_swap_functions'],
    [`drop function ${swapEntry}`, 'orders_swap_functions'],
    [`drop function ${candidatesEntry}`, 'orders_swap_functions'],
    [`drop function ${candidatesBody}`, 'orders_swap_functions'],
    [`create or replace function public.admin_swap_order_allocations(_order_id uuid,_taker_order_item_id uuid,_donor_order_item_id uuid,
      _quantity integer,_reason text,_actor_id uuid,_request_key uuid) returns jsonb language sql security invoker set search_path=''
      as 'select null::jsonb'`, 'orders_swap_functions'],
    [`create or replace function public.list_admin_allocation_swap_candidates(_order_id uuid,_taker_order_item_id uuid,_actor_id uuid)
      returns table(donor_order_id uuid,donor_order_item_id uuid,order_created_at timestamptz,swappable_quantity integer,taker_quantity integer)
      language sql stable security invoker set search_path='' as 'select null::uuid,null::uuid,null::timestamptz,0,0 where false'`, 'orders_swap_functions'],
    [`create function private.admin_swap_order_allocations(uuid) returns integer language sql as $$ select 1 $$`, 'orders_swap_function_set'],
    [`create function public.admin_swap_order_allocations(uuid) returns integer language sql as $$ select 1 $$`, 'orders_swap_function_set'],
    [`create function public.list_admin_allocation_swap_candidates(uuid) returns integer language sql as $$ select 1 $$`, 'orders_swap_function_set'],
    [`create function public.lock_group_g_allocation_swap(uuid) returns integer language sql as $$ select 1 $$`, 'orders_swap_function_set'],
    [rewriteFunction(swapWriter, lockCall, `PERFORM 1 FROM public.orders LIMIT 1;\n  ${lockCall}`), 'orders_swap_lock_order'],
    [rewriteFunction(swapWriter, lockCall, `PERFORM 1 FROM public.order_item_allocations LIMIT 1;\n  ${lockCall}`), 'orders_swap_lock_order'],
    [rewriteFunction(swapWriter, lockCall, 'NULL;'), 'orders_swap_lock_order'],
    [rewriteFunction(swapHelper, advisoryCall, `PERFORM 1;\n  ${advisoryCall}`), 'orders_swap_lock_order'],
    [rewriteFunction(swapHelper, advisoryCall, `PERFORM 1;\n  BEGIN\n    ${advisoryCall}\n  END;`), 'orders_swap_lock_order'],
    [rewriteFunction(swapHelper, 'RETURN private.lock_group_g_inventory(v_variants, v_orders, NULL);', 'RETURN v_orders;'), 'orders_swap_lock_order'],
  ])('FREQ-540-AC-14: G4C改ざん %s はDETAIL=%sで拒否、rollbackで復元', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });

  test('FREQ-540-AC-14: 書込みの本体を落とすと、一覧を入れ替えずに流しても項目名つきで拒否する', async () => {
    expect(await attempt(`drop function ${swapWriter}`, null)).toEqual(failed('orders_swap_functions'));
    expect(await attempt(`drop function ${swapHelper}`, null)).toEqual(failed('orders_swap_functions'));
    expect(await attempt('', null)).toBeNull();
  });

  test('FREQ-540-AC-14: 一覧は76本の固定集合とOIDまで一致し、1本外す・1本足す・別の関数に替える・重複させるを拒否する', async () => {
    expect(G4_ALLOWLIST).toHaveLength(76);
    for (const changed of [
      G4_ALLOWLIST.slice(1), G4_ALLOWLIST.slice(0, -1), G3D_ALLOWLIST,
      [...G4_ALLOWLIST, swapHelper], [...G4_ALLOWLIST, swapEntry],
      [swapHelper, ...G4_ALLOWLIST.slice(1)], [...G4_ALLOWLIST.slice(0, -1), swapEntry],
      [G4_ALLOWLIST[1], ...G4_ALLOWLIST.slice(1)],
    ]) expect(await attempt('', changed)).toEqual(failed('orders_swap_allowlist'));
    expect(await attempt()).toBeNull();
  });

  test.each([
    ['grant select on public.order_item_allocations to anon', 'orders_swap_table_acl'],
    ['grant select on public.order_item_allocation_events to authenticated', 'orders_swap_table_acl'],
    ['grant insert on public.order_item_allocations to service_role', 'orders_swap_table_acl'],
    ['grant update on public.order_item_state_events to service_role', 'orders_swap_table_acl'],
    ['grant update (remaining_quantity) on public.order_item_allocations to service_role', 'orders_swap_table_acl'],
    ['grant select on private.group_g_operations to service_role', 'orders_swap_table_acl'],
    ['grant select (id) on private.group_g_operations to anon', 'orders_swap_table_acl'],
    ['grant select (id) on public.order_item_allocations to public', 'orders_swap_table_acl'],
    ['revoke select on public.order_item_allocation_events from service_role', 'orders_swap_table_acl'],
    ['revoke truncate on public.order_item_state_events from postgres', 'orders_swap_table_acl'],
  ])('FREQ-540-AC-14: 書込み先の表の権限の改ざん %s はDETAIL=%sで拒否、rollbackで復元', async (change, detail) => {
    expect(await attempt(change)).toEqual(failed(detail));
    expect(await attempt()).toBeNull();
  });

  test('FREQ-540-AC-14: PostgreSQL 17 以降は MAINTAIN も書込み先の表の「無い」の一覧に入る', async () => {
    const hasMaintain = (await db().query("select current_setting('server_version_num')::int >= 170000 as has")).rows[0].has as boolean;
    if (!hasMaintain) return;
    expect(await attempt('grant maintain on public.order_item_allocations to anon')).toEqual(failed('orders_swap_table_acl'));
  });

  test('FREQ-540-AC-14: 一時ロールへ所有者を変える改ざんを拒否し、rollbackで所有者とロールが戻る', async () => {
    const role = `g4c_owner_${randomUUID().replaceAll('-', '')}`;
    expect(await attempt(`set local createrole_self_grant='set';create role ${role} nologin;
      grant create on schema private to ${role};alter function ${swapWriter} owner to ${role}`)).toEqual(failed('orders_swap_functions'));
    expect((await db().query('select proowner::regrole::text as owner from pg_proc where oid=$1::regprocedure', [swapWriter])).rows[0].owner).toBe('postgres');
    expect((await db().query('select exists(select 1 from pg_roles where rolname=$1) as present', [role])).rows[0].present).toBe(false);
    expect(await attempt()).toBeNull();
  });
});
