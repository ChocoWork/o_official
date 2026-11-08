/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder, seedGroupG3Slip } from './helpers/group-g3-fixtures';
import { G3A_REASON_CODES, G3D_ALLOWLIST, runWithAllowlist } from './helpers/group-g-allowlist';

const directory = path.join(process.cwd(), 'supabase/migrations');
const names = fs.readdirSync(directory).filter((name) => name.endsWith('_group_g4_orders_foundation.sql'));
if (names.length !== 1) throw new Error('G4A_MIGRATION_MISSING');
const sql = fs.readFileSync(path.join(directory, names[0]), 'utf8');
const g3 = fs.readFileSync(path.join(directory, '20261025100130_group_g3_shipping_slips.sql'), 'utf8');
const signature = 'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)';
const statement = sql.match(/CREATE OR REPLACE FUNCTION private\.admin_confirm_shipment_slip\([\s\S]*?\n\$\$;/)?.[0];
const original = g3.match(/CREATE FUNCTION private\.admin_confirm_shipment_slip\([\s\S]*?\n\$\$;/)?.[0];
if (!statement || !original) throw new Error('G4A_CONFIRM_STATEMENT_MISSING');
const replacement = statement;
const expected = original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
  .replace('IF v_slip.expires_at < pg_catalog.now() THEN', 'IF v_slip.expires_at <= pg_catalog.now() THEN');
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
type ReasonFailure = { code?: string; constraint?: string };
const assertion = sql.slice(sql.indexOf('-- G4A_FINAL_ASSERT_BEGIN') + '-- G4A_FINAL_ASSERT_BEGIN'.length,
  sql.indexOf('-- G4A_FINAL_ASSERT_END'));

describe('G-4 foundation source contract (no DB)', () => {
  test('FREQ-540-AC-14: confirm の置換文は G-3 から CREATE OR REPLACE と期限比較の2箇所だけを変える', () => {
    expect(Buffer.from(replacement)).toEqual(Buffer.from(expected));
    expect(sql).not.toMatch(/(?:ALTER|REVOKE|GRANT)[^;]*FUNCTION private\.admin_confirm_shipment_slip/i);
  });
});

describeLocalDb('G-4 foundation: controller reset required', (db) => {
  const flow = createPurchaseFlow(db);
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  test('FREQ-540-AC-14: 注文別索引は通常の非一意 btree(order_id) で、order_id だけの検索に使われる', async () => {
    const row = (await db().query(`select i.indisvalid,i.indisready,i.indisunique,i.indnatts,i.indnkeyatts,
      am.amname,a.attname,i.indexprs is null as plain,i.indpred is null as full_index
      from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
      join pg_catalog.pg_am am on am.oid=c.relam
      join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
      where i.indexrelid=pg_catalog.to_regclass('public.shipment_slip_fulfillments_order_idx')
        and i.indrelid='public.shipment_slip_fulfillments'::regclass`)).rows[0];
    expect(row).toEqual({ indisvalid: true, indisready: true, indisunique: false, indnatts: 1, indnkeyatts: 1,
      amname: 'btree', attname: 'order_id', plain: true, full_index: true });
    await db().query('set local enable_seqscan=off');
    const plan = (await db().query('explain (format json) select * from public.shipment_slip_fulfillments where order_id=$1', [randomUUID()])).rows;
    expect(JSON.stringify(plan)).toContain('shipment_slip_fulfillments_order_idx');
  });

  test('FREQ-540-AC-14: DB の confirm 本体は G-3 の < を <= に置き換えた本体と一致する', async () => {
    const body = (await db().query('select prosrc from pg_catalog.pg_proc where oid=$1::regprocedure', [signature])).rows[0].prosrc as string;
    // 会計の計画が足す `-- ACC_P<数字>_BEGIN` 〜 `-- ACC_P<数字>_END` の囲みは両側から全部除いて比べる（番号は1桁。後の計画が別の番号の囲みを足しても直さずに通る）。
    const withoutAccountingBlocks = (value: string) => value.replace(/-- ACC_P\d_BEGIN[\s\S]*?-- ACC_P\d_END/g, '');
    expect(normalize(withoutAccountingBlocks(body))).toBe(normalize(withoutAccountingBlocks(
      expected.slice(expected.indexOf('AS $$') + 'AS $$'.length, expected.lastIndexOf('$$;')))));
  });

  test('FREQ-540-AC-14: CREATE OR REPLACE は OID・所有者・ACL・属性と書き手の OID 集合を保つ', async () => {
    const snapshot = async () => (await db().query(`select oid,proowner,proacl,prosecdef,proconfig,prorettype,
      prolang,provolatile,proparallel,proisstrict,proretset,proargtypes
      from pg_catalog.pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
    const writers = async () => (await db().query(`select array_agg(distinct w::oid order by w::oid) as ids
      from unnest(private.group_g_writer_allowlist()) as w`)).rows[0].ids as number[];
    const before = await snapshot();
    const ids = await writers();
    expect(ids).toContain(before.oid);
    await db().query(replacement);
    expect(await snapshot()).toEqual(before);
    expect(await writers()).toEqual(ids); // No fixed count: G4C will add a writer.
  });

  test.each([
    ['now()', true, 'GROUP_G_SLIP_DRAFT_EXPIRED', '55000'],
    ["now()+interval '1 second'", false, 'GROUP_G_SLIP_EMPTY', '22023'],
  ] as const)('FREQ-540-AC-14: expires_at=%s は読取 expired=%s、確定は次の正確な判定へ進む', async (expiry, expired, message, code) => {
    const actor = await flow.createActor(['supporter']);
    const id = await seedGroupG3Slip(db(), { actorId: actor });
    await db().query("select set_config('app.group_g_slip_change','draft',true)");
    const { version } = (await db().query(`update public.shipment_slips set expires_at=${expiry},version=version+1,updated_at=now()
      where id=$1 returning version`, [id])).rows[0];
    const result = (await db().query('select public.get_admin_shipment_slip($1,$2) as r', [id, actor])).rows[0].r;
    expect(result.expired).toBe(expired);
    await db().query('savepoint g4_expiry');
    try {
      let caught: { code?: string; message?: string } = {};
      try {
        await db().query(`select public.admin_confirm_shipment_slip($1,$2,null,null,
          (now() at time zone 'Asia/Tokyo')::date,false,$3,$4)`, [id, version, actor, randomUUID()]);
      } catch (error) {
        const e = error as typeof caught;
        caught = { code: e.code, message: e.message === message ? message : 'G4_UNEXPECTED_DB_ERROR' };
      }
      expect(caught).toEqual({ code, message });
    } finally {
      await db().query('rollback to savepoint g4_expiry');
      await db().query('release savepoint g4_expiry');
    }
  });

  test('FREQ-523-AC-03: allocation_swap と従来17値とNULLは書け、未知・綴り違いは理由CHECKで断る', async () => {
    const fixture = await seedGroupG3ReadyOrder(db());
    const event = (await db().query('select operation_id from public.order_item_allocation_events where allocation_id=$1 limit 1', [fixture.allocationId])).rows[0];
    for (const reason of [...G3A_REASON_CODES, 'allocation_swap', null, 'unknown_reason', 'allocation_swpa', 'shipment_confrim']) {
      await db().query('savepoint g4_reason');
      try {
        // Probe only the CHECK on an actual event INSERT; roll back before deferred consumption validation.
        const accepted = reason === null || [...G3A_REASON_CODES, 'allocation_swap'].includes(reason);
        let failure: ReasonFailure | null = null;
        let written: string | null | undefined;
        try {
          written = (await db().query(`insert into public.order_item_allocation_events
            (allocation_id,event_type,quantity,operation_id,sequence,reason) values($1,'consume',1,$2,999,$3) returning reason`,
          [fixture.allocationId, event.operation_id, reason])).rows[0].reason;
        } catch (error) {
          const e = error as ReasonFailure;
          failure = { code: e.code, constraint: e.constraint };
        }
        expect(failure).toEqual(accepted ? null : { code: '23514', constraint: 'order_item_allocation_events_reason_check' });
        if (accepted) expect(written).toBe(reason);
      } finally {
        await db().query('rollback to savepoint g4_reason');
        await db().query('release savepoint g4_reason');
      }
    }
    await db().query('set constraints all immediate');
  });

  test('FREQ-540-AC-14: 末尾assertはG3Dの75本を取引内で再現して現在DBを通す', async () => {
    await runWithAllowlist(db(), G3D_ALLOWLIST, assertion);
  });
});
