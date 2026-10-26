/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { G3A_REASON_CODES, G3D_ALLOWLIST, replaceReasonCheckSql, runWithAllowlist } from './helpers/group-g-allowlist';
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
