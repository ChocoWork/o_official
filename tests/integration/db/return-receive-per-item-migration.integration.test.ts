/** @jest-environment node */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { CURRENT_ALLOWLIST, H7_ALLOWLIST, replaceAllowlistSql } from './helpers/group-g-allowlist';
import { hReceive, hRefundFixture, hReturn, H5_RETURN_FUNCTION_NAMES, installReceiveEra, withH5ReturnBaseline } from './helpers/group-h-refund-fixtures';

const directory = path.join(process.cwd(), 'supabase/migrations');
const migrationFiles = fs.readdirSync(directory).filter(name => /^\d+_return_receive_per_item\.sql$/.test(name));
const sql = migrationFiles.length === 1 ? fs.readFileSync(path.join(directory, migrationFiles[0]), 'utf8') : '';
// 2026-11-08 の直し（I-1・N-1）が4本の本文を置き換えた。今の DB の本文はこの移行の物と比べる
const dedupFiles = fs.readdirSync(directory).filter(name => /^\d+_return_receive_unit_dedup\.sql$/.test(name));
const dedupSql = dedupFiles.length === 1 ? fs.readFileSync(path.join(directory, dedupFiles[0]), 'utf8') : '';
const DEDUP_REPLACED = ['admin_receive_return', 'group_h_receiving_amount', 'group_h_return_refund_amount', 'return_receive_amounts'];
// 2026-11-10 の交換の印の移行 C（FREQ-642）が、受け取りの入口（15の引数に作り直し）と、返金の結果を書く関数の本文を置き換えた。
// 今の DB の本文はこの移行の物と比べる
const unitReceiveFiles = fs.readdirSync(directory).filter(name => /^\d+_unit_binding_receive\.sql$/.test(name));
const unitReceiveSql = unitReceiveFiles.length === 1 ? fs.readFileSync(path.join(directory, unitReceiveFiles[0]), 'utf8') : '';
const UNIT_RECEIVE_REPLACED = ['admin_receive_return', 'record_group_g_refund_result'];
// 移行 D（FREQ-642）は受け取りの本文を、返金の記録を共通のコアが書く形に置き換えた（record_group_g_refund_result は移行 C のまま）
const unitRefundsFiles = fs.readdirSync(directory).filter(name => /^\d+_unit_binding_refunds\.sql$/.test(name));
const unitRefundsSql = unitRefundsFiles.length === 1 ? fs.readFileSync(path.join(directory, unitRefundsFiles[0]), 'utf8') : '';
const receiveArgs = 'uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text';
const receiveArgs15 = `${receiveArgs},jsonb`;
const resultNames = ['receipt_id', 'return_status', 'refund_id', 'refund_amount', 'refund_status',
  'exchange_order_item_ids', 'fee_due_amount', 'shop_notice_enqueued', 'replayed'];
const inputNames = ['_return_id', '_actor_id', '_actor_can_refund', '_request_key', '_units', '_exchange_overrides',
  '_refund_choice', '_refund_amount', '_refund_shipping_amount', '_note', '_notify_customer',
  '_sent_back_message', '_sent_back_carrier', '_sent_back_tracking_number'];
const details = ['rr_schema', 'rr_receive', 'rr_amounts', 'rr_acl', 'rr_writers'];
const md5 = (s: string) => createHash('md5').update(s.replaceAll('\r', '')).digest('hex');
function definition(source: string, name: string, schema = 'private') {
  const match = source.match(new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION ${schema}\\.${name}\\([\\s\\S]*?\\bAS (\\$[a-zA-Z_0-9]*\\$)([\\s\\S]*?)\\1;`, 'mi'));
  return match ? { sql: match[0], body: match[2] } : null;
}
// No marker name is imposed on the next migration: find its final guarded DO by the fixed error symbol.
const assertion = [...sql.matchAll(/^DO\s+(\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1;/gmi)]
  .find(m => m[2].includes('RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED'))?.[0] ?? '';
const baselines = sql.match(/^CREATE TEMP(?:ORARY)? TABLE[\s\S]*?;/gmi) ?? [];
/** 置き換えた本文の MD5 だけを新しい本文の物に替えた RR の末尾 assert（ほかの確かめは元のまま） */
const currentAssertion = DEDUP_REPLACED.reduce((text, name) => {
  const before = definition(sql, name), after = definition(dedupSql, name);
  return before && after ? text.replace(`'${md5(before.body)}'`, `'${md5(after.body)}'`) : text;
}, assertion);
const dedupAssertion = [...dedupSql.matchAll(/^DO\s+(\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1;/gmi)]
  .find(m => m[2].includes('RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED'))?.[0] ?? '';
type DbError = { code?: string; message?: string; detail?: string };
async function failure(db: PgClient, work: () => Promise<unknown>): Promise<DbError | null> {
  await db.query('savepoint rr_migration_failure');
  try { await work(); return null; }
  catch (caught) {
    const e = caught as DbError;
    return { code: e.code, message: e.message === 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' ? e.message : 'RR_EXPECTED_DB_REJECTION',
      ...(e.detail && details.includes(e.detail) ? { detail: e.detail } : {}) };
  } finally { await db.query('rollback to savepoint rr_migration_failure'); await db.query('release savepoint rr_migration_failure'); }
}

describe('受取明細ごとの返金の新移行の契約（DBのREDとは別）', () => {
  test('FREQ-641-AC-10: 新移行1本が5つの固定DETAILを持ち適用済み移行と公開入口を置き換えない', () => {
    expect(migrationFiles).toHaveLength(1);
    expect(migrationFiles[0] > '20261101120000_sec_password_change_challenges.sql').toBe(true);
    expect(sql.charCodeAt(0)).not.toBe(0xfeff); expect(sql).not.toContain('\r');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1); expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(assertion).not.toBe('');
    for (const d of details) expect(assertion).toContain(`'${d}'`);
    expect(assertion).toContain('P0001');
    expect(sql).not.toMatch(/DROP\s+FUNCTION|CREATE(?: OR REPLACE)? FUNCTION public\.admin_receive_return/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?order_return_receipt(?:s|_lines)\b/i);
    expect(sql).toMatch(/NOTIFY\s+pgrst,\s*'reload schema'/i);
  });
});

describeLocalDb('受取明細の列・制約・ACL・本文・書き手77本（controller）', db => {
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  test('FREQ-641-AC-10: 明細の選びはnullable textでCHECKと6列のNULL同一一意性を持つ', async () => {
    expect((await db().query(`select data_type,is_nullable from information_schema.columns
      where table_schema='public' and table_name='order_return_receipt_lines' and column_name='refund_choice'`)).rows)
      .toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    const checks = (await db().query(`select conname,pg_get_constraintdef(oid) definition from pg_constraint
      where conrelid in ('public.order_return_receipts'::regclass,'public.order_return_receipt_lines'::regclass)
      order by conname`)).rows;
    expect(checks.find(x => x.conname === 'order_return_receipt_lines_refund_choice_check')?.definition).toContain('refund_choice');
    expect(checks.find(x => x.conname === 'order_return_receipts_refund_choice_check')?.definition).toContain('mixed');
    expect(checks.find(x => x.conname === 'order_return_receipts_kind_choice_check')?.definition).toContain('receive');
    expect(checks.find(x => x.conname === 'order_return_receipt_lines_line_key')?.definition)
      .toBe('UNIQUE NULLS NOT DISTINCT (receipt_id, return_line_id, disposition, resolution, exchange_method, refund_choice)');
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f);
    for (const [kind, choice] of [['inspect', 'mixed'], ['receive', null]]) {
      expect(await failure(db(), () => db().query(`insert into public.order_return_receipts
        (return_id,request_key,request_fingerprint,kind,refund_choice) values($1,$2,'rr-kind',$3,$4)`,
      [r.returnId, randomUUID(), kind, choice]))).toMatchObject({ code: '23514' });
    }
  });

  test('FREQ-641-AC-10: 旧NULLとnowとconsultの3明細は共存し同じ選びの重複と非返金の選びを断る', async () => {
    const f = await hRefundFixture(db(), true, 4), r = await hReturn(db(), f, 4);
    // Direct INSERT represents a historical, append-only receipt. No UPDATE/backfill is permitted.
    const receiptId = randomUUID(), oldReceiptId = randomUUID();
    await db().query(`insert into public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice)
      values($1,$2,$3,'rr-schema','receive','mixed')`, [receiptId, r.returnId, randomUUID()]);
    await db().query(`insert into public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice)
      values($1,$2,$3,'rr-old-schema','receive','consult')`, [oldReceiptId, r.returnId, randomUUID()]);
    const insert = (choice: string | null, disposition = 'not_restocked', resolution: string | null = 'refund', id = receiptId) => db().query(`
      insert into public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,refund_choice)
      values($1,$2,$3,1,$4,$5)`, [id, r.lineId, disposition, resolution, choice]);
    await insert(null, 'not_restocked', 'refund', oldReceiptId);
    for (const choice of ['now', 'consult']) await insert(choice);
    for (const choice of [null, 'now', 'consult']) expect(await failure(db(), () =>
      insert(choice, 'not_restocked', 'refund', choice === null ? oldReceiptId : receiptId))).toMatchObject({ code: '23505' });
    for (const [choice, disposition, resolution] of [['mixed', 'restocked', 'refund'], ['now', 'sent_back', null],
      ['consult', 'refund_waived', null]] as const) expect(await failure(db(), () => insert(choice, disposition, resolution))).toMatchObject({ code: '23514' });
  });

  test.each(['now', 'consult'] as const)('FREQ-641-AC-10: 過去のNULL明細は親%sで読み新しい旧本文は選びを補完する', async choice => {
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2);
    const currentDefinitions = (await db().query(`select pg_get_functiondef(p.oid) definition from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname=any($1::text[]) order by p.oid`,
    [H5_RETURN_FUNCTION_NAMES])).rows;
    await withH5ReturnBaseline(db(), async () => {
      const received = await hReceive(db(), f, r, 1, choice);
      // Name the new column explicitly so pre-migration failure is column absence, not JS undefined vs NULL.
      const readRows = () => db().query('select x.*,x.refund_choice from public.order_return_receipt_lines x where receipt_id=$1 order by id', [received.receipt_id]);
      const historical = (await readRows()).rows;
      expect(historical.filter(x => x.resolution === 'refund').map(x => x.refund_choice)).toEqual([null]);
      // Keep the old append-only data, restore current bodies, and exercise the actual current readers/recovery.
      for (const d of currentDefinitions) await db().query(d.definition);
      const line = (await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j.lines[0];
      expect(line.receive_refund_amounts_by_count).toEqual([20000]);
      expect(line.refund_waiting_amount).toBe(choice === 'consult' ? 17000 : 0);
      const refundId = choice === 'now' ? received.refund_id : (await db().query(
        'select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [r.returnId, f.actor, randomUUID()])).rows[0].refund_id;
      await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [refundId]);
      await db().query("select * from public.record_order_refund_result($1,$2,'succeeded',null,null,null,'card',null,null)",
        [refundId, `re_${refundId.replaceAll('-', '')}`]);
      expect((await db().query(`select paid_amount,return_line_id from public.order_line_unit_amounts
        where refund_id=$1`, [refundId])).rows).toEqual([{ paid_amount: 17000, return_line_id: r.lineId }]);
      expect((await readRows()).rows).toEqual(historical);
    });
    const newReceipt = await hReceive(db(), f, r, 1, choice);
    expect((await db().query(`select refund_choice from public.order_return_receipt_lines
      where receipt_id=$1 and resolution='refund'`, [newReceipt.receipt_id])).rows).toEqual([{ refund_choice: choice }]);
  });

  test('FREQ-641-AC-09: publicとprivateの15引数（末尾の _pricing だけ既定値 NULL）・10列と公開入口の本文を保つ', async () => {
    // 移行 C（FREQ-642）で14の引数の入口は15の引数（値段の計画）に変わり、答えに release_refund_ids が付いた
    for (const schema of ['public', 'private']) {
      const p = (await db().query(`select pronargs,pronargdefaults,proargnames,proargmodes::text[] as proargmodes,prosecdef,provolatile,proconfig
        from pg_proc where oid=$1::regprocedure`, [`${schema}.admin_receive_return(${receiveArgs15})`])).rows[0];
      expect(p).toMatchObject({ pronargs: 15, pronargdefaults: 1, proargnames: [...inputNames, '_pricing', ...resultNames, 'release_refund_ids'] });
      expect(p.proargmodes.slice(15)).toEqual(Array(10).fill('t'));
      expect(p.proconfig).toContain('search_path=""');
      expect((await db().query('select to_regprocedure($1) is null as gone', [`${schema}.admin_receive_return(${receiveArgs})`])).rows[0].gone).toBe(true);
    }
    const original = definition(unitReceiveSql, 'admin_receive_return', 'public');
    expect(original).not.toBeNull();
    expect((await db().query(`select md5(replace(prosrc,E'\\r','')) hash from pg_proc
      where oid=$1::regprocedure`, [`public.admin_receive_return(${receiveArgs15})`])).rows[0].hash).toBe(md5(original!.body));
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f);
    expect(Object.keys(await hReceive(db(), f, r)).sort()).toEqual([...resultNames, 'release_refund_ids'].sort());
  });

  test('FREQ-641-AC-10: 新しい見込みhelperはSTABLEで旧戻り型とJSONの既存キーを保つ', async () => {
    expect((await db().query(`select provolatile,pronargs,pg_get_function_result(oid) result
      from pg_proc where oid='private.return_receive_amounts(uuid)'::regprocedure`)).rows[0])
      .toEqual({ provolatile: 's', pronargs: 1, result: 'TABLE(return_line_id uuid, receive_refund_amounts_by_count integer[])' });
    expect((await db().query(`select pg_get_function_result('private.group_h_return_amounts(uuid)'::regprocedure) result`)).rows[0].result)
      .toBe('TABLE(return_line_id uuid, refund_amounts_by_count integer[], refund_waiting_amount integer)');
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f, 2);
    const before = (await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j;
    let oldKeys: string[] = [];
    await withH5ReturnBaseline(db(), async () => {
      oldKeys = Object.keys((await db().query('select private.return_detail_json($1) j', [r.returnId])).rows[0].j.lines[0]).sort();
    });
    expect(Object.keys(before.lines[0]).filter(x => x !== 'receive_refund_amounts_by_count').sort()).toEqual(oldKeys);
    expect(before.lines[0].receive_refund_amounts_by_count).toEqual([17000, 37000]);
  });

  test('FREQ-641-AC-10: 受取親と明細は所有者でも更新・削除・TRUNCATEできない', async () => {
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f);
    const received = await hReceive(db(), f, r);
    for (const table of ['order_return_receipts', 'order_return_receipt_lines']) {
      const column = table === 'order_return_receipts' ? 'id' : 'receipt_id';
      for (const command of [`update public.${table} set ${column}=${column} where ${column}=$1`,
        `delete from public.${table} where ${column}=$1`]) expect(await failure(db(), () => db().query(command, [received.receipt_id])))
        .not.toBeNull();
      expect(await failure(db(), () => db().query(`truncate public.${table} cascade`))).not.toBeNull();
    }
  });

  test('FREQ-641-AC-09: 公開RPCはservice_roleだけが実行できprivate helperと表書込は公開しない', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const acl = (await db().query(`select has_function_privilege($1,$2,'EXECUTE') rpc,
        has_function_privilege($1,'private.return_receive_amounts(uuid)','EXECUTE') helper,
        has_table_privilege($1,'public.order_return_receipt_lines','INSERT,UPDATE,DELETE,TRUNCATE') dml`,
      [role, `public.admin_receive_return(${receiveArgs15})`])).rows[0];
      expect(acl).toEqual({ rpc: role === 'service_role', helper: false, dml: false });
    }
    const f = await hRefundFixture(db(), true), r = await hReturn(db(), f);
    for (const role of ['anon', 'authenticated']) expect(await failure(db(), async () => {
      await db().query(`set local role ${role}`); await hReceive(db(), f, r);
    })).toMatchObject({ code: '42501' });
    await db().query('set local role service_role'); expect((await hReceive(db(), f, r)).receipt_id).toBeDefined();
    await db().query('reset role');
  });

  test('FREQ-641-AC-10: 書き手は77署名と同じOID集合のまま読取helperを加えない', async () => {
    expect(CURRENT_ALLOWLIST).toHaveLength(77);
    const actual = (await db().query(`select x::oid oid from unnest(private.group_g_writer_allowlist()) x order by x::oid`)).rows;
    const expected = (await db().query(`select x::regprocedure::oid oid from unnest($1::text[]) x order by x::regprocedure::oid`, [CURRENT_ALLOWLIST])).rows;
    expect(actual).toHaveLength(77); expect(actual).toEqual(expected);
    expect(CURRENT_ALLOWLIST.some(x => x.includes('return_receive_amounts'))).toBe(false);
    const coreSource = fs.readFileSync(path.join(directory, '20261012235910_order_return_records.sql'), 'utf8');
    const core = definition(coreSource, 'order_return_line_states_core'); expect(core).not.toBeNull();
    expect((await db().query(`select md5(replace(prosrc,E'\\r','')) hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname='order_return_line_states_core'`)).rows).toEqual([{ hash: md5(core!.body) }]);
  });

  test('FREQ-641-AC-10: 新11本文と見込みhelperは移行に固定した本文・属性・ACLで過剰overloadを持たない', async () => {
    expect(sql).not.toBe('');
    for (const name of [...H5_RETURN_FUNCTION_NAMES, 'return_receive_amounts']) {
      const expected = UNIT_RECEIVE_REPLACED.includes(name) ? definition(name === 'admin_receive_return' ? unitRefundsSql : unitReceiveSql, name)
        : DEDUP_REPLACED.includes(name) ? definition(dedupSql, name) : definition(sql, name); expect(expected).not.toBeNull();
      const rows = (await db().query(`select md5(replace(p.prosrc,E'\\r','')) hash,p.provolatile,p.proconfig,
        p.proowner=(select oid from pg_roles where rolname='postgres') owned,
        coalesce((select array_agg(a.grantee::regrole::text order by a.grantee::regrole::text)
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where a.grantee<>p.proowner and a.privilege_type='EXECUTE'),'{}') other_executors
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname=$1
          and pg_get_function_identity_arguments(p.oid) !~ 'integer\\[\\]'`, [name])).rows; // the unit-list overloads of migration B are not part of RR
      // public.admin_receive_return is SECURITY INVOKER, so service_role keeps EXECUTE on this private body only.
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ hash: md5(expected!.body), owned: true,
        other_executors: name === 'admin_receive_return' ? ['service_role'] : [] });
      expect(rows[0].proconfig).toContain('search_path=""');
      expect(rows[0].provolatile).toBe(['return_detail_json', 'group_h_receiving_amount', 'group_h_return_amounts',
        'group_h_return_unit_dispositions', 'group_h_return_refund_slices', 'group_h_return_refund_amount', 'return_receive_amounts'].includes(name) ? 's' : 'v');
    }
  });

  async function attempt(change?: () => Promise<unknown>) {
    // A missing migration/assertion is a source-contract failure, never a caught database rejection.
    expect(assertion).not.toBe('');
    return failure(db(), async () => {
      // The RR assertion counts functions by name; migration B's unit-list overloads are put back by the rollback.
      await db().query('drop function if exists private.group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid); drop function if exists private.group_h_release_return_units(uuid,integer[])');
      // 移行 C が置き換えた2本は、RR・RD の時点の物に戻してから確かめる（巻き戻しで戻る）
      await installReceiveEra(db());
      for (const baseline of baselines) await db().query(baseline);
      if (change) await change(); await db().query(currentAssertion);
    });
  }
  test('FREQ-641-AC-10: 新移行の末尾assertは無改変で通る', async () => {
    for (const name of DEDUP_REPLACED) expect(currentAssertion).toContain(`'${md5(definition(dedupSql, name)!.body)}'`);
    expect(await attempt()).toBeNull();
  });
  test.each([
    { detail: 'rr_schema', change: 'alter table public.order_return_receipt_lines drop constraint order_return_receipt_lines_refund_choice_check' },
    { detail: 'rr_receive', name: 'admin_receive_return' },
    { detail: 'rr_amounts', name: 'group_h_return_refund_amount' },
    { detail: 'rr_acl', change: 'grant execute on function private.return_receive_amounts(uuid) to service_role' },
    { detail: 'rr_writers', change: replaceAllowlistSql(H7_ALLOWLIST.slice(0, -1), { stub: false }) },
  ])('FREQ-641-AC-10: 新移行の改ざんはP0001と固定DETAIL=$detailで断る', async o => {
    expect(await attempt(async () => {
      if (o.change) await db().query(o.change);
      else {
        const def = (await db().query(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='private' and p.proname=$1`, [o.name])).rows[0].d as string;
        await db().query(def.replace(/\$function\$;?\s*$/, '\n-- rr deliberate body change\n$function$;'));
      }
    })).toEqual({ code: 'P0001', message: 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED', detail: o.detail });
  });

  async function dedupAttempt(change?: string) {
    expect(dedupAssertion).not.toBe('');
    await db().query('savepoint rd_migration_failure');
    try { await installReceiveEra(db()); if (change) await db().query(change); await db().query(dedupAssertion); return null; }
    catch (caught) { const e = caught as DbError; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await db().query('rollback to savepoint rd_migration_failure'); await db().query('release savepoint rd_migration_failure'); }
  }
  test('FREQ-641-AC-07: 受け取りの数え方の直しの移行の末尾assertは無改変で通り、改ざんは固定DETAILで断る', async () => {
    expect(dedupFiles).toHaveLength(1);
    expect(dedupSql).not.toContain('\r');
    expect(dedupSql.match(/^BEGIN;$/gm)).toHaveLength(1); expect(dedupSql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(dedupSql).not.toMatch(/DROP\s+FUNCTION|CREATE(?: OR REPLACE)? FUNCTION public\./i);
    expect(dedupSql).not.toMatch(/UPDATE\s+(?:public\.)?order_return_receipt(?:s|_lines)\b/i);
    expect(await dedupAttempt()).toBeNull();
    const rejected = { code: 'P0001', message: 'RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED' };
    expect(await dedupAttempt('alter table public.order_return_receipts drop constraint order_return_receipts_consult_quantity_check'))
      .toEqual({ ...rejected, detail: 'rd_schema' });
    expect(await dedupAttempt('grant execute on function private.group_h_receiving_amount(uuid,uuid,integer,jsonb) to service_role'))
      .toEqual({ ...rejected, detail: 'rd_bodies' });
  });
});
