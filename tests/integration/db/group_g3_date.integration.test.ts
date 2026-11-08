/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { attachGroupG3SlipShipment, seedGroupG3ReadyOrder, seedGroupG3Slip, withRolePermissions } from './helpers/group-g3-fixtures';
import { seedGroupG1Shipment } from './helpers/group-g1-fixtures';
import { G3D_ALLOWLIST, CURRENT_ALLOWLIST } from './helpers/group-g-allowlist';

const signature = 'admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)';
const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261025134538_group_g3_shipping_actions.sql'), 'utf8');
const start = sql.indexOf('CREATE FUNCTION private.admin_correct_shipment_date(');
const body = sql.slice(start, sql.indexOf('ALTER FUNCTION private.admin_correct_shipment_date(', start));
const permissions = ['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read'];
jest.setTimeout(90000);

describe('G-3 date migration (no database)', () => {
  test('FREQ-535-AC-03: 検証→lock(false)→権限→再送→存在→段階→版→同日→範囲→配達→日付・履歴・版→操作', () => {
    expect(start).toBeGreaterThan(0);
    const statements = ["RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID'", "RAISE EXCEPTION 'GROUP_G_SLIP_REASON_REQUIRED'",
      'PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], false);',
      'private.group_g_actor_has_permissions(_actor_id,', "WHERE op.operation = 'shipment_date_correct' AND op.request_key = _request_key",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND'", "RAISE EXCEPTION 'GROUP_G_SLIP_CANCELLED'", "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_CONFIRMED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT'", "RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_UNCHANGED'",
      "RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_INVALID'", "RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY'",
      'UPDATE public.shipment_slips', 'UPDATE public.order_fulfillments', 'INSERT INTO public.shipment_date_history',
      'INSERT INTO public.shipment_slip_versions', 'INSERT INTO private.group_g_operations'];
    const positions = statements.map((statement) => { expect(body).toContain(statement); return body.indexOf(statement); });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const beforeLock = body.slice(body.indexOf('AS $$'), positions[2]);
    expect(beforeLock).not.toMatch(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?(?:public|private)\./i);
    expect(beforeLock).not.toMatch(/\b(?:public|private)\.[a-z_]+\(/i);
    expect(body).toContain("ARRAY['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read']");
    expect(body).not.toMatch(/enqueue_|capture_group_g_item_states|record_group_g_item_state_changes|SET\s+(?:shipped_at|confirmed_at|delivered_at|tracking_version)/i);
  });
  test('FREQ-540-AC-11: 新writerを共有75本・末尾assert・private/publicのACLと属性の集合へ追加', () => {
    expect(G3D_ALLOWLIST).toHaveLength(75);
    expect(G3D_ALLOWLIST.at(-1)).toBe(`private.${signature}`);
    expect(new Set(G3D_ALLOWLIST).size).toBe(75);
    expect(sql.slice(sql.indexOf('-- G3D_FINAL_ASSERT_BEGIN'))).toContain('<> 75');
    for (const schema of ['public', 'private']) {
      expect(sql).toContain(`ALTER FUNCTION ${schema}.${signature} OWNER TO postgres;`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${schema}.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${schema}.${signature} TO service_role;`);
    }
  });
  test('FREQ-540-AC-11: regprocedure一覧のSQL関数を定義する前に新writerを作る', () => {
    expect(sql.indexOf(`ALTER FUNCTION private.${signature}`)).toBeLessThan(sql.indexOf('CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist()'));
  });
});

describeLocalDb('G-3 date correction (local DB only)', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string; let today: string; let yesterday: string;
  beforeEach(async () => {
    await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['admin']); today = await flow.today();
    yesterday = (await db().query("select to_char((now() at time zone 'Asia/Tokyo')::date-1,'YYYY-MM-DD') d")).rows[0].d;
  });
  afterEach(async () => { await db().query('rollback'); });
  type Options = { version?: number | null; date?: string | null; reason?: string | null; actor?: string | null; key?: string | null };
  const correct = async (id: string | null, o: Options = {}) => (await db().query(`select public.admin_correct_shipment_date($1,$2,$3::date,$4,$5,$6) r`,
    [id, o.version === undefined ? 2 : o.version, o.date === undefined ? yesterday : o.date, o.reason === undefined ? '記録の訂正' : o.reason,
      o.actor === undefined ? actor : o.actor, o.key === undefined ? randomUUID() : o.key])).rows[0].r;
  const ship = async (paidDates: string[] = ['2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z'], shipmentDate?: string) => {
    const orders = [];
    for (const paidAt of paidDates) orders.push(await seedGroupG3ReadyOrder(db(), { paidAt }));
    const slip = (await db().query('select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) r',
      [JSON.stringify(orders.map((o) => ({ orderItemId: o.orderItemId, quantity: 2 }))), actor, randomUUID()])).rows[0].r as { id: string; number: string; version: number };
    const confirmed = (await db().query('select public.admin_confirm_shipment_slip($1,1,null,null,$2::date,true,$3,$4) r',
      [slip.id, shipmentDate ?? today, actor, randomUUID()])).rows[0].r;
    return { ...slip, orders, confirmed };
  };
  const digestTables = ['public.orders', 'public.order_items', 'public.item_variants', 'public.stock_movements', 'public.order_item_allocations',
    'public.order_item_allocation_events', 'public.order_item_state_events', 'public.order_fulfillment_lines', 'public.order_fulfillment_events',
    'private.order_email_outbox', 'private.shipment_tracking_registrations', 'private.fulfillment_tracking_registrations'];
  const snapshot = async (tables = digestTables) => Promise.all(tables.map(async (table) => (await db().query(
    `select md5(coalesce(string_agg(v,',' order by v),'')) d from (select to_jsonb(t)::text v from ${table} t) x`)).rows[0].d));
  const allTables = [...digestTables, 'public.shipment_slips', 'public.order_fulfillments', 'public.shipment_date_history', 'public.shipment_slip_versions', 'private.group_g_operations'];
  const reject = async (id: string | null, message: string, o: Options = {}, code = '22023') => {
    const before = await snapshot(allTables);
    expect(await flow.rejected(() => correct(id, o))).toEqual({ message, code });
    expect(await snapshot(allTables)).toEqual(before);
  };
  const rows = async (id: string) => (await db().query(`select to_jsonb(f)-'shipment_date' preserved, f.shipment_date::text d from public.shipment_slip_fulfillments sf
    join public.order_fulfillments f on f.id=sf.fulfillment_id where sf.slip_id=$1 order by sf.order_id`, [id])).rows;
  const deadlines = async (orderIds: string[]) => (await db().query(`select o.id,r.fulfillment_id,r.order_item_id,r.deadline_date::text from unnest($1::uuid[]) o(id)
    cross join lateral private.fulfillment_line_returnable(o.id) r order by o.id,r.fulfillment_id,r.order_item_id`, [orderIds])).rows;

  test('FREQ-535-AC-03: 全有効発送と票の日付・版・理由つき履歴を追記し、メール・品物・割当・在庫は不変', async () => {
    const slip = await ship(); const before = await snapshot(); const shipments = await rows(slip.id);
    const deadlineBefore = await deadlines(slip.orders.map((o) => o.orderId));
    expect(deadlineBefore.length).toBeGreaterThan(0);
    const confirmedAt = (await db().query('select confirmed_at from public.shipment_slips where id=$1', [slip.id])).rows[0].confirmed_at;
    const key = randomUUID(); const result = await correct(slip.id, { reason: ' 記録の訂正 ', key });
    expect(result).toEqual({ id: slip.id, version: 3, shipmentDate: yesterday, replayed: false });
    expect(await snapshot()).toEqual(before);
    expect((await rows(slip.id)).map((f) => f.preserved)).toEqual(shipments.map((f) => f.preserved));
    expect((await rows(slip.id)).map((f) => f.d)).toEqual([yesterday, yesterday]);
    expect(await deadlines(slip.orders.map((o) => o.orderId))).toEqual(deadlineBefore);
    expect((await db().query('select shipment_date::text d,version,confirmed_at from public.shipment_slips where id=$1', [slip.id])).rows[0])
      .toEqual({ d: yesterday, version: 3, confirmed_at: confirmedAt });
    const op = (await db().query("select id,fingerprint,result from private.group_g_operations where operation='shipment_date_correct' and request_key=$1", [key])).rows[0];
    expect(op.fingerprint).toMatch(/^[0-9a-f]{64}$/); expect(op.result).toEqual(result);
    expect((await db().query("select version,kind,previous_date::text,new_date::text,reason,actor_id,operation_id from public.shipment_date_history where slip_id=$1 and kind='correction'", [slip.id])).rows)
      .toEqual([{ version: 3, kind: 'correction', previous_date: today, new_date: yesterday, reason: '記録の訂正', actor_id: actor, operation_id: op.id }]);
    expect((await db().query("select version,kind,reason,actor_id from public.shipment_slip_versions where slip_id=$1 and kind='date_correction'", [slip.id])).rows)
      .toEqual([{ version: 3, kind: 'date_correction', reason: '記録の訂正', actor_id: actor }]);
    await db().query('set constraints all immediate');
  });
  test('FREQ-540-AC-10: 初期supporter/manageだけを拒否し、店長の付与で通る', async () => {
    const slip = await ship(); const supporter = await flow.createActor(['supporter']);
    await reject(slip.id, 'GROUP_G_FORBIDDEN', { actor: supporter }, '42501');
    await withRolePermissions(db(), 'supporter', ['admin.shipping.correct_date'], [], async () => {
      expect((await correct(slip.id, { actor: supporter })).version).toBe(3);
    });
  });
  test.each(['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read'])('FREQ-540-AC-10: %sなしはDBも拒否', async (missing) => {
    const slip = await ship();
    await withRolePermissions(db(), 'admin', permissions.filter((p) => p !== missing), [missing], async () => {
      await reject(slip.id, 'GROUP_G_FORBIDDEN', {}, '42501');
    });
  });
  test.each(['inactive', 'expired'] as const)('FREQ-540-AC-10: %sの役割を拒否', async (state) => {
    const slip = await ship(); const by = await flow.createActor(['admin'], { [state]: ['admin'] });
    await reject(slip.id, 'GROUP_G_FORBIDDEN', { actor: by }, '42501');
  });
  test.each([null, '', '   ', '\t\r\n', '\u3000\u00a0\ufeff', '\u000b\u000c\u1680\u2000\u2028\u2029\u202f\u205f'])('FREQ-535-AC-03: 空の理由%jは専用エラー', async (reason) => {
    const slip = await ship(); await reject(slip.id, 'GROUP_G_SLIP_REASON_REQUIRED', { reason });
  });
  test('FREQ-535-AC-03: 理由の201字と他引数を先に検査し、trim後200字は通る', async () => {
    const slip = await ship();
    await reject(slip.id, 'GROUP_G_ARGUMENT_INVALID', { reason: 'あ'.repeat(201) });
    await reject(slip.id, 'GROUP_G_ARGUMENT_INVALID', { reason: '', version: 0 });
    await reject(null, 'GROUP_G_ARGUMENT_INVALID', { reason: '' });
    await reject(slip.id, 'GROUP_G_ARGUMENT_INVALID', { date: null });
    expect((await correct(slip.id, { reason: `\u3000\t${'あ'.repeat(200)}\r\n\ufeff` })).version).toBe(3);
    expect((await db().query("select reason from public.shipment_date_history where slip_id=$1 and kind='correction'", [slip.id])).rows)
      .toEqual([{ reason: 'あ'.repeat(200) }]);
  });
  test('FREQ-535-AC-03: 同日・全注文の最遅paid_atのJST日・今日JST上限', async () => {
    const slip = await ship(['2026-10-20T14:59:59Z', '2026-10-20T15:00:00Z']);
    await reject(slip.id, 'GROUP_G_SHIPMENT_DATE_UNCHANGED', { date: today });
    await reject(slip.id, 'GROUP_G_SHIPMENT_DATE_INVALID', { date: '2026-10-20' });
    const tomorrow = (await db().query("select to_char((now() at time zone 'Asia/Tokyo')::date+1,'YYYY-MM-DD') d")).rows[0].d;
    await reject(slip.id, 'GROUP_G_SHIPMENT_DATE_INVALID', { date: tomorrow });
    expect((await correct(slip.id, { date: '2026-10-21' })).shipmentDate).toBe('2026-10-21');
    expect((await correct(slip.id, { version: 3, date: today })).shipmentDate).toBe(today);
  });
  test.each(['manual', 'tracking'])('FREQ-535-AC-03 / FREQ-535-AC-04: %s配達日のJST境界と返品期限の起点は不変', async (mark) => {
    // Backdated fixture keeps delivered_at >= shipped_at; all guards and consumption checks remain enabled.
    const order = await seedGroupG3ReadyOrder(db());
    const fulfillmentId = await seedGroupG1Shipment(db(), { orderId: order.orderId, actorId: actor,
      lines: [{ orderItemId: order.orderItemId, quantity: 2 }], shippedAt: '2026-10-22T00:00:00Z' });
    const slipId = await seedGroupG3Slip(db(), { stage: 'confirmed', actorId: actor, shipmentDate: '2026-10-22' });
    await attachGroupG3SlipShipment(db(), { slipId, fulfillmentId, orderId: order.orderId, orderItemId: order.orderItemId, quantity: 2, actorId: actor });
    await db().query("select set_config('app.fulfillment_change',$1,true)", [mark]);
    await db().query("update public.order_fulfillments set delivery_status='delivered', delivery_status_at='2026-10-23T15:00:00Z', delivered_at='2026-10-23T15:00:00Z' where id=$1", [fulfillmentId]);
    await db().query("select set_config('app.fulfillment_change','',true)");
    const before = await rows(slipId); const deadlineBefore = await deadlines([order.orderId]);
    expect(deadlineBefore.length).toBeGreaterThan(0);
    await reject(slipId, 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY', { version: 1, date: '2026-10-25' });
    expect((await correct(slipId, { version: 1, date: '2026-10-24' })).version).toBe(2);
    expect((await correct(slipId, { version: 2, date: '2026-10-23' })).version).toBe(3);
    expect((await rows(slipId)).map((f) => f.preserved)).toEqual(before.map((f) => f.preserved));
    expect(await deadlines([order.orderId])).toEqual(deadlineBefore);
  });
  test('FREQ-535-AC-05: 会計入力は訂正後の日付と最新履歴id、取消済みの時刻を返す', async () => {
    const slip = await ship();
    const accounting = async () => (await db().query('select shipment_date::text,revision_id,cancelled_at from public.list_shipment_accounting_inputs($1::date,$2::date,100) where slip_id=$3', ['2026-10-01', today, slip.id])).rows;
    const initial = await accounting();
    await correct(slip.id); const first = await accounting();
    expect(first).toHaveLength(2);
    const history = (await db().query('select id from public.shipment_date_history where slip_id=$1 order by version desc limit 1', [slip.id])).rows[0].id;
    for (const row of first) expect(row).toEqual({ shipment_date: yesterday, revision_id: history, cancelled_at: null });
    expect(first[0].revision_id).not.toBe(initial[0].revision_id);
    await correct(slip.id, { version: 3, date: today });
    expect((await accounting())[0].revision_id).not.toBe(history);
    await db().query('select public.admin_cancel_shipment_slip($1,4,$2,$3)', [slip.id, actor, randomUUID()]);
    for (const row of await accounting()) expect(row.cancelled_at).not.toBeNull();
  });
  test('FREQ-535-AC-03: 再送は履歴と版を増やさず同キー異内容/actorは衝突、再送にも現在の権限が要る', async () => {
    const slip = await ship(); const key = randomUUID(); const result = await correct(slip.id, { key }); const before = await snapshot(allTables);
    expect(await correct(slip.id, { key, version: 999, reason: ' 記録の訂正 ' })).toEqual({ ...result, replayed: true });
    expect(await snapshot(allTables)).toEqual(before);
    for (const patch of [{ reason: '別の理由' }, { date: today }, { actor: await flow.createActor(['admin']) }]) {
      await reject(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { ...patch, key }, '23505');
    }
    await withRolePermissions(db(), 'admin', [], ['admin.shipping.correct_date'], async () => {
      await reject(slip.id, 'GROUP_G_FORBIDDEN', { key }, '42501');
    });
  });
  test('FREQ-535-AC-03: 不存在・下書き・取消・版競合は日付を変えない', async () => {
    await reject(randomUUID(), 'GROUP_G_SLIP_NOT_FOUND', {}, 'P0002');
    await reject(await seedGroupG3Slip(db()), 'GROUP_G_SLIP_NOT_CONFIRMED', {}, '55000');
    const slip = await ship(); await reject(slip.id, 'GROUP_G_SLIP_VERSION_CONFLICT', { version: 1 }, '55000');
    await db().query('select public.admin_cancel_shipment_slip($1,2,$2,$3)', [slip.id, actor, randomUUID()]);
    await reject(slip.id, 'GROUP_G_SLIP_CANCELLED', { version: 3 }, '55000');
  });
  test('FREQ-535-AC-03: 履歴INSERTへの故障注入で票・全発送の日付もロールバック', async () => {
    const slip = await ship();
    await db().query("select set_config('app.fulfillment_change','manual',true)");
    await db().query(`create function pg_temp.fail_date_history() returns trigger language plpgsql as $$ begin
      if current_setting('app.fulfillment_change',true) is distinct from 'manual' then
        raise exception 'FULFILLMENT_MARK_LEAKED' using errcode='P0001';
      end if;
      raise exception 'INJECTED_DATE_FAILURE' using errcode='P0001'; end $$`);
    await db().query('create trigger task9_fail before insert on public.shipment_date_history for each row execute function pg_temp.fail_date_history()');
    await reject(slip.id, 'INJECTED_DATE_FAILURE', {}, 'P0001');
    expect((await db().query("select current_setting('app.fulfillment_change',true) mark")).rows[0].mark).toBe('manual');
  });
  test('FREQ-540-AC-11: 公開入口は同signatureのSQL INVOKER、実効EXECUTEはservice_roleだけ・今の一覧（76本）', async () => {
    for (const schema of ['public', 'private']) {
      const p = (await db().query(`select p.prosecdef,l.lanname,p.proconfig,p.proargnames,p.prorettype::regtype::text ret,
        pg_get_userbyid(p.proowner) owner,has_function_privilege('service_role',p.oid,'execute') service,
        has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated
        from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure($1)`, [`${schema}.${signature}`])).rows[0];
      expect(p).toEqual({ prosecdef: schema === 'private', lanname: schema === 'private' ? 'plpgsql' : 'sql', proconfig: ['search_path=""'],
        proargnames: ['_slip_id', '_expected_version', '_shipment_date', '_reason', '_actor_id', '_request_key'], ret: 'jsonb', owner: 'postgres', service: true, anon: false, authenticated: false });
    }
    expect((await db().query('select cardinality(private.group_g_writer_allowlist()) n')).rows[0].n).toBe(CURRENT_ALLOWLIST.length);
  });
  test('FREQ-535-AC-04: shipment_dateを持つprosrcはG-3の関数と会計の出荷の係の5関数だけで、KPIなどほかの関数に広がらない', async () => {
    const actual = (await db().query(`select n.nspname||'.'||p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and strpos(p.prosrc,'shipment_date')>0 order by 1`)).rows.map((p) => p.name);
    // Accounting plan 2 S8 reads the shipment day on purpose (design 6-a): its five functions are listed with the G-3 ones; S14 (6-d, 6-d2) adds its two reads.
    expect(actual).toEqual([
      'private.accounting_post_shipment_events', 'private.accounting_shipment_date_reason',
      'private.admin_cancel_shipment_slip', 'private.admin_confirm_shipment_slip', 'private.admin_correct_shipment_date',
      'private.admin_mark_shipment_slip_delivered', 'private.admin_update_shipment_slip_tracking', 'private.get_admin_shipment_slip',
      'private.get_shipment_journal_trace', 'private.group_g_writer_allowlist', 'private.guard_group_g_shipment_slip_change', 'private.list_admin_shipment_slips',
      'private.list_carrier_date_gaps', 'private.list_journal_shipment_meta', 'private.list_shipment_accounting_inputs', 'private.list_year_end_shipments',
      'private.restrict_fulfillment_record_update',
      'public.admin_confirm_shipment_slip', 'public.admin_correct_shipment_date', 'public.list_journal_shipment_meta',
    ]);
  });
  test.each(['PERFORM 1 FROM public.shipment_slips;', 'PERFORM private.group_g_actor_has_permissions(_actor_id, ARRAY[]::text[]);'])('FREQ-540-AC-11: 新writerのlock前参照%sをG3D最終assertが拒否', async (injected) => {
    const definition = (await db().query('select pg_get_functiondef(to_regprocedure($1)) d', [`private.${signature}`])).rows[0].d as string;
    const altered = definition.replace('PERFORM private.lock_group_g_shipment_slips(', `${injected}\n  PERFORM private.lock_group_g_shipment_slips(`);
    expect(altered).not.toBe(definition);
    const from = sql.indexOf('DO $g3d_final_objects$');
    const final = sql.slice(from, sql.indexOf('$g3d_final_objects$;', from) + '$g3d_final_objects$;'.length);
    expect(await flow.rejected(async () => { await db().query(altered); await db().query(final); }))
      .toEqual({ code: '55000', message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', detail: 'shipping_action_functions' });
  });
});
