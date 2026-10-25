/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeLocalDb, connectLocalDb } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder, seedGroupG3Slip, withRolePermissions } from './helpers/group-g3-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment, setOrderStatusForFixture } from './helpers/group-g1-fixtures';
import { insertRefundRecord, insertReturnRecord, type RefundFixtureStatus, type ReturnFixtureStatus } from './helpers/order-fixtures';
import { setDeliveryTracking } from './helpers/delivery-tracking-fixtures';
import { G3C_ALLOWLIST, G3D_ALLOWLIST } from './helpers/group-g-allowlist';

jest.setTimeout(90000);
type Confirmed = { id: string; number: string; version: number; fulfillments: { orderId: string; fulfillmentId: string; number: number; completesOrder: boolean }[] };
type Cancelled = { id: string; version: number; restoredQuantity: number; replayed: boolean };
const cancelSignature = 'admin_cancel_shipment_slip(uuid,integer,uuid,uuid)';
const restoreSignature = 'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)';
const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261025100130_group_g3_shipping_slips.sql'), 'utf8');

/** One function's text from its CREATE to its ALTER ... OWNER, so statement order can be read without a database. */
function functionText(createHead: string, alterHead: string): string {
  const from = sql.indexOf(createHead);
  const to = sql.indexOf(alterHead, from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to);
}

describe('G-3 cancel migration (no database)', () => {
  test('FREQ-533-AC-04: restore は 台帳restock(無タグ) → 新しい割当 → 台帳(タグ付き) → restore の出来事 の順に書く', () => {
    const body = functionText('CREATE FUNCTION private.restore_group_g_shipment(', 'ALTER FUNCTION private.restore_group_g_shipment(');
    const positions = [
      'IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks',
      "AND e.event_type = 'consume' AND e.operation_id = _confirm_operation_id",
      'ORDER BY fl.order_item_id, e.id',
      "INSERT INTO public.stock_movements(variant_id, delta, reason, order_id, order_item_id, note, created_by)",
      "'restock'",
      'INSERT INTO public.order_item_allocations(',
      'INSERT INTO public.stock_movements(variant_id, delta, reason, order_id, order_item_id, allocation_operation_id, note, created_by)',
      "WHEN v_consume.exchange_return_line_id IS NULL THEN 'purchase' ELSE 'exchange'",
      'INSERT INTO public.order_item_allocation_events(',
      "'restore'",
      "'shipment_cancel'",
    ].map((statement) => {
      const position = body.indexOf(statement);
      expect({ statement, present: position >= 0 }).toEqual({ statement, present: true });
      return position;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The untagged restock names no allocation_operation_id; the second ledger row (the tagged one) does.
    const restockInsert = body.slice(positions[3], positions[5]);
    expect(restockInsert).not.toContain('allocation_operation_id');
    // The migration stays ASCII (Unicode escapes); the escapes spell the notes the database test reads back.
    const decode = (escaped: string) => escaped.replace(/\\([0-9A-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    const prefix = String.raw`\767A\9001\7968 `;
    const restockNote = String.raw` \306E\767A\9001\53D6\6D88\FF08\623B\3057\FF09`;
    const reallocationNote = String.raw` \306E\767A\9001\53D6\6D88\FF08\518D\78BA\4FDD\FF09`;
    expect([decode(prefix), decode(restockNote), decode(reallocationNote)]).toEqual(['発送票 ', ' の発送取消（戻し）', ' の発送取消（再確保）']);
    expect(restockInsert).toContain(`U&'${prefix}' || _slip_number || U&'${restockNote}'`);
    expect(body.slice(positions[6], positions[8])).toContain(`U&'${prefix}' || _slip_number || U&'${reallocationNote}'`);
    // The original allocation is never touched.
    expect(body).not.toMatch(/UPDATE\s+public\.order_item_allocations/);
  });

  test('FREQ-533-AC-04: 取消は 拒否の検査（3つ）→ 書込み の順で、書込みの前に何も書かず、発送の取消が restore より先、お客様へのメールは作らない', () => {
    const body = functionText('CREATE FUNCTION private.admin_cancel_shipment_slip(', 'ALTER FUNCTION private.admin_cancel_shipment_slip(');
    const positions = [
      'PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);',
      'private.group_g_actor_has_permissions(_actor_id,',
      "WHERE op.operation = 'shipment_slip_cancel' AND op.request_key = _request_key",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_CANCELLED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_NOT_CONFIRMED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_HAS_RETURN'",
      "RAISE EXCEPTION 'GROUP_G_SLIP_REFUNDED'",
      'v_before := private.capture_group_g_item_states(v_orders);',
      "PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);",
      'UPDATE public.order_fulfillments SET cancelled_at = pg_catalog.now(), cancelled_by = _actor_id',
      "PERFORM private.stop_fulfillment_registrations(v_shipment.fulfillment_id, 'cancelled');",
      'PERFORM private.close_delivery_attention(v_shipment.fulfillment_id);',
      'private.restore_group_g_shipment(v_shipment.fulfillment_id, v_slip.confirm_operation_id,',
      "UPDATE public.orders SET status = 'paid'::public.order_status",
      'UPDATE private.order_email_outbox AS e',
      "PERFORM pg_catalog.set_config('app.group_g_slip_change', 'cancel', true);",
      "UPDATE public.shipment_slips SET stage = 'cancelled'",
      'INSERT INTO public.shipment_slip_versions(',
      'PERFORM private.record_group_g_item_state_changes(',
      'INSERT INTO private.group_g_operations(',
    ].map((statement) => {
      const position = body.indexOf(statement);
      expect({ statement, present: position >= 0 }).toEqual({ statement, present: true });
      return position;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Nothing is written before the last refusal: no INSERT / UPDATE / DELETE statement and no set_config up to REFUNDED.
    const beforeWrites = body.slice(0, positions[10]);
    expect(beforeWrites).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public|UPDATE\s+private|DELETE\s+FROM|set_config)\b/i);
    // No customer email is created by the cancel and no new fulfillment event is written.
    expect(body).not.toContain('enqueue_order_email');
    expect(body).not.toMatch(/INSERT\s+INTO\s+private\.order_email_outbox/i);
    expect(body).not.toContain('INSERT INTO public.order_fulfillment_events');
  });

  test('FREQ-540-AC-11: restore・cancel を足した閉集合は72本で、末尾assertにも新関数を含む', () => {
    expect(G3C_ALLOWLIST).toHaveLength(72);
    expect(new Set(G3C_ALLOWLIST).size).toBe(72);
    expect(G3C_ALLOWLIST.slice(-2)).toEqual([restoreSignature, 'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)']);
    for (const name of ['restore_group_g_shipment', 'admin_cancel_shipment_slip']) {
      expect(sql).toContain(`CREATE FUNCTION private.${name}(`);
      expect(sql.slice(sql.indexOf('-- G3C_FINAL_ASSERT_BEGIN'))).toContain(name);
    }
    expect(sql.slice(sql.indexOf('-- G3C_FINAL_ASSERT_BEGIN'))).toContain('<> 72');
  });
});

describeLocalDb('G-3 shipment slip cancel', (db) => {
  const flow = createPurchaseFlow(db);
  let actor: string; let today: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = await flow.createActor(['supporter']); today = await flow.today();
  });
  afterEach(async () => { await db().query('rollback'); });

  const ready = (input: Parameters<typeof seedGroupG3ReadyOrder>[1] = {}) => seedGroupG3ReadyOrder(db(), input);
  const draft = async (lines: { orderItemId: string; quantity: number }[]) => (await db().query(
    'select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r', [JSON.stringify(lines), actor, randomUUID()],
  )).rows[0].r as { id: string; number: string; version: number };
  type ConfirmOptions = { tracking?: string | null; carrier?: string | null; notify?: boolean };
  const confirm = async (id: string, o: ConfirmOptions = {}): Promise<Confirmed> => (await db().query(
    'select public.admin_confirm_shipment_slip($1,1,$2,$3,$4::date,$5,$6,$7) as r',
    [id, o.carrier === undefined ? 'yamato' : o.carrier, o.tracking === undefined ? 'ab-123' : o.tracking, today,
      o.notify === undefined ? true : o.notify, actor, randomUUID()],
  )).rows[0].r;
  type CancelOptions = { version?: number | null; by?: string | null; key?: string | null; schema?: 'public' | 'private' };
  const cancel = async (id: string | null, o: CancelOptions = {}): Promise<Cancelled> => (await db().query(
    `select ${o.schema ?? 'public'}.admin_cancel_shipment_slip($1,$2,$3,$4) as r`,
    [id, o.version === undefined ? 2 : o.version, o.by === undefined ? actor : o.by, o.key === undefined ? randomUUID() : o.key],
  )).rows[0].r;
  /** Draft and confirm a slip over the given items (quantity per item). */
  const ship = async (lines: { orderItemId: string; quantity: number }[], o: ConfirmOptions = {}) => {
    const slip = await draft(lines);
    return { slip, confirmed: await confirm(slip.id, o) };
  };
  const tables = ['public.orders', 'public.item_variants', 'public.stock_movements', 'public.order_item_allocations',
    'public.order_item_allocation_events', 'public.order_item_state_events', 'public.order_fulfillments', 'public.order_fulfillment_lines',
    'public.order_fulfillment_events', 'public.order_fulfillment_attention', 'public.shipment_slips', 'public.shipment_slip_lines',
    'public.shipment_slip_fulfillments', 'public.shipment_slip_versions', 'public.shipment_date_history', 'private.group_g_operations',
    'private.order_email_outbox', 'private.shipment_tracking_registrations', 'private.fulfillment_tracking_registrations'];
  // Digests verify complete row content without exposing addresses or bodies in failed assertions.
  const snapshot = async () => Promise.all(tables.map(async (table) => (await db().query(
    `select md5(coalesce(string_agg(v, ',' order by v),'')) as digest from (select to_jsonb(t)::text as v from ${table} t) x`,
  )).rows[0].digest as string));
  const refused = async (id: string | null, message: string, options: CancelOptions = {}, code = '22023') => {
    const before = await snapshot();
    expect(await flow.rejected(() => cancel(id, options))).toEqual({ message, code });
    expect(await snapshot()).toEqual(before);
  };
  const stock = async (variantId: number) => (await db().query(`select
      (select stock_quantity from public.item_variants where id=$1)::int as f,
      (select coalesce(sum(remaining_quantity) filter (where kind='paid'),0) from public.order_item_allocations where variant_id=$1)::int as a,
      (select coalesce(sum(remaining_quantity) filter (where kind='payment_hold'),0) from public.order_item_allocations where variant_id=$1)::int as h`,
  [variantId])).rows[0] as { f: number; a: number; h: number };
  const orderOf = async (orderId: string) => (await db().query(
    'select status::text as status, shipped_at is not null as stamped, shipping_carrier, tracking_number from public.orders where id=$1', [orderId])).rows[0];
  const operationOf = async (key: string) => (await db().query(
    "select * from private.group_g_operations where request_key=$1 and operation='shipment_slip_cancel'", [key])).rows[0];

  test('FREQ-533-AC-04: 取消で各consumeごとに restock(+n・無タグ・order_id/order_item_id・備考)・新しい割当(paid)・purchase(-n・タグ付き)・restore(reverses_event_id・shipment_cancel)が書かれ、空き在庫Fは不変、手元はn戻り、F+A+Hが保存される。元の割当は変わらない', async () => {
    const f = await ready({ quantity: 6, allocated: 0 });
    const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'];
    const sizes = [2, 3, 1];
    for (const [index, id] of ids.entries()) {
      await seedGroupG1Allocation(db(), { orderItemId: f.orderItemId, quantity: sizes[index], kind: 'paid', id, createdAt: `2026-10-${18 + index}T00:00:00Z` });
    }
    const start = await stock(f.variantId);
    const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 4 }]);
    const shipped = await stock(f.variantId);
    expect(shipped).toEqual({ f: start.f, a: start.a - 4, h: 0 });
    const allocationRows = async () => (await db().query(`select id,quantity,remaining_quantity,kind,version::text as version,created_at,updated_at
      from public.order_item_allocations where id=any($1::uuid[]) order by id`, [ids])).rows;
    const originals = await allocationRows();
    expect(originals.map((row) => row.remaining_quantity)).toEqual([0, 1, 1]);
    const ledgerBefore = (await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [f.variantId])).rows[0].n;
    const consumes = (await db().query(`select e.id,e.quantity from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id where a.order_item_id=$1 and e.event_type='consume' order by e.id`, [f.orderItemId])).rows;
    expect(consumes.map((row) => row.quantity).sort()).toEqual([2, 2]);

    const key = randomUUID();
    const result = await cancel(slip.id, { key });
    expect(result).toEqual({ id: slip.id, version: 3, restoredQuantity: 4, replayed: false });
    const op = await operationOf(key);
    expect(op).toMatchObject({ cause_type: 'shipment_slip', cause_id: slip.id, actor_id: actor, result });
    expect(op.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const restores = (await db().query(`select allocation_id,reverses_event_id,quantity,sequence,reason,actor_id,stock_movement_id
      from public.order_item_allocation_events where operation_id=$1 and event_type='restore' order by reverses_event_id`, [op.id])).rows;
    expect(restores).toEqual(consumes.map((consume) => ({
      allocation_id: expect.any(String), reverses_event_id: consume.id, quantity: consume.quantity, sequence: 1,
      reason: 'shipment_cancel', actor_id: actor, stock_movement_id: expect.any(String),
    })));
    const created = (await db().query(`select id,order_item_id,quantity,remaining_quantity,kind,version::text as version
      from public.order_item_allocations where operation_id=$1 order by id`, [op.id])).rows;
    expect(created.map((row) => row.id).sort()).toEqual(restores.map((row) => row.allocation_id).sort());
    for (const row of created) expect(row).toMatchObject({ order_item_id: f.orderItemId, quantity: 2, remaining_quantity: 2, kind: 'paid', version: '0' });

    const restock = (await db().query(`select delta,reason,order_id,order_item_id,allocation_operation_id,note,created_by,refund_id,return_id
      from public.stock_movements where order_item_id=$1 and reason='restock'`, [f.orderItemId])).rows;
    expect(restock).toEqual([2, 2].map((delta) => ({
      delta, reason: 'restock', order_id: f.orderId, order_item_id: f.orderItemId, allocation_operation_id: null,
      note: `発送票 ${slip.number} の発送取消（戻し）`, created_by: actor, refund_id: null, return_id: null,
    })));
    const reallocated = (await db().query(`select id,delta,reason,order_id,order_item_id,note,created_by from public.stock_movements
      where allocation_operation_id=$1 order by id`, [op.id])).rows;
    expect(reallocated.map((row) => row.id)).toHaveLength(2);
    expect(reallocated.map((row) => String(row.id)).sort()).toEqual(restores.map((row) => String(row.stock_movement_id)).sort());
    for (const row of reallocated) {
      expect(row).toMatchObject({ delta: -2, reason: 'purchase', order_id: f.orderId, order_item_id: f.orderItemId,
        note: `発送票 ${slip.number} の発送取消（再確保）`, created_by: actor });
    }
    expect((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [f.variantId])).rows[0].n).toBe(ledgerBefore + 4);

    // Free stock F is unchanged by the cancel; the hand stock (F + A + H) returns by exactly the shipped quantity.
    const after = await stock(f.variantId);
    expect(after.f).toBe(shipped.f);
    expect(after).toEqual(start);
    expect(after.f + after.a + after.h).toBe(shipped.f + shipped.a + shipped.h + 4);
    // The original allocations keep their remaining quantity, version and times.
    expect(await allocationRows()).toEqual(originals);
    // The cancelled shipment is marked and keeps its lines.
    expect((await db().query('select cancelled_at is not null as cancelled,cancelled_by from public.order_fulfillments where id=$1', [confirmed.fulfillments[0].fulfillmentId])).rows[0])
      .toEqual({ cancelled: true, cancelled_by: actor });
    await db().query('set constraints all immediate');
  });

  test('FREQ-533-AC-04: 交換の品の取消は 再確保の台帳の理由が exchange になる', async () => {
    const f = await ready({ paidAt: '2026-10-20T15:00:00Z' });
    const shipment = await seedGroupG1Shipment(db(), { orderId: f.orderId, lines: [{ orderItemId: f.orderItemId, quantity: 1 }], shippedAt: '2026-10-21T00:00:00Z' });
    const returnId = (await db().query(`insert into public.order_returns
      (order_id,number,source,status,request_key,request_fingerprint,return_method,return_shipping_payer,notify_customer)
      values($1,1,'customer_request','open',$2,'fixture','customer_ships','customer',false) returning id`, [f.orderId, randomUUID()])).rows[0].id;
    const returnLine = (await db().query(`insert into public.order_return_lines
      (return_id,fulfillment_id,order_item_id,quantity,reason,resolution,exchange_variant_id,exchange_method)
      values($1,$2,$3,1,'unknown','exchange',$4,'make') returning id`, [returnId, shipment, f.orderItemId, f.variantId])).rows[0].id;
    const exchange = (await db().query(`insert into public.order_items
      (order_id,item_id,variant_id,item_name,item_price,quantity,line_total,fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
      values($1,$2,$3,'exchange',0,1,0,'backorder','exchange',$4,5000) returning id`, [f.orderId, f.itemId, f.variantId, returnLine])).rows[0].id as string;
    await seedGroupG1Allocation(db(), { orderItemId: exchange, quantity: 1, kind: 'paid' });
    const { slip } = await ship([{ orderItemId: exchange, quantity: 1 }]);
    const key = randomUUID();
    expect(await cancel(slip.id, { key })).toMatchObject({ restoredQuantity: 1, version: 3 });
    const op = await operationOf(key);
    expect((await db().query('select delta,reason from public.stock_movements where allocation_operation_id=$1', [op.id])).rows).toEqual([{ delta: -1, reason: 'exchange' }]);
    expect((await db().query("select delta,reason,allocation_operation_id from public.stock_movements where order_item_id=$1 and reason='restock'", [exchange])).rows)
      .toEqual([{ delta: 1, reason: 'restock', allocation_operation_id: null }]);
    await db().query('set constraints all immediate');
  });

  test('FREQ-533-AC-04: 戻しは1回。同じconsumeを直接もう一度戻そうとすると一意制約で断られ、同じキーの再送はreplayed:trueで何も増えず、取消済みの票への別キーはGROUP_G_SLIP_CANCELLED', async () => {
    const f = await ready();
    const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 4 }]);
    const key = randomUUID();
    const first = await cancel(slip.id, { key });
    const before = await snapshot();
    expect(await cancel(slip.id, { key, version: 999 })).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(before);
    await refused(slip.id, 'GROUP_G_SLIP_CANCELLED', {}, '55000');
    await refused(slip.id, 'GROUP_G_REQUEST_KEY_CONFLICT', { key, by: await flow.createActor(['supporter']) }, '23505');
    await refused(randomUUID(), 'GROUP_G_REQUEST_KEY_CONFLICT', { key }, '23505');
    const confirmOperation = (await db().query('select confirm_operation_id from public.shipment_slips where id=$1', [slip.id])).rows[0].confirm_operation_id;
    const second = await flow.rejected(() => db().query(`select ${restoreSignature.slice(0, restoreSignature.indexOf('('))}($1,$2,$3,$4,$5)`,
      [confirmed.fulfillments[0].fulfillmentId, confirmOperation, randomUUID(), actor, slip.number]));
    expect(second.code).toBe('23505');
    expect(second.message).toContain('order_item_allocation_events_reverses_event_id_key');
    expect(await snapshot()).toEqual(before);
    await db().query('set constraints all immediate');
  });

  test('FREQ-534-AC-03: 取消で品物状態がshipped→ready、全部送っていた注文はpaidに戻りshipped_at・運送会社・番号がNULL、一部の注文はpaidのまま。票はcancelled・版+1・cancel版が残る', async () => {
    const full = await ready(); const partial = await ready();
    const { slip, confirmed } = await ship([{ orderItemId: full.orderItemId, quantity: 4 }, { orderItemId: partial.orderItemId, quantity: 2 }]);
    expect(await orderOf(full.orderId)).toEqual({ status: 'shipped', stamped: true, shipping_carrier: 'yamato', tracking_number: 'ab-123' });
    expect((await orderOf(partial.orderId)).status).toBe('paid');
    const key = randomUUID();
    await cancel(slip.id, { key });
    expect(await orderOf(full.orderId)).toEqual({ status: 'paid', stamped: false, shipping_carrier: null, tracking_number: null });
    expect(await orderOf(partial.orderId)).toEqual({ status: 'paid', stamped: false, shipping_carrier: null, tracking_number: null });
    const op = await operationOf(key);
    expect((await db().query(`select order_item_id,from_status,to_status,unit_to-unit_from as n,reason
      from public.order_item_state_events where operation_id=$1 order by n`, [op.id])).rows).toEqual([
      { order_item_id: partial.orderItemId, from_status: 'shipped', to_status: 'ready', n: 2, reason: 'shipment_slip_cancel' },
      { order_item_id: full.orderItemId, from_status: 'shipped', to_status: 'ready', n: 4, reason: 'shipment_slip_cancel' },
    ]);
    expect((await db().query('select count(*)::int as n from public.order_fulfillments where id=any($1::uuid[]) and cancelled_at is not null and cancelled_by=$2',
      [confirmed.fulfillments.map((row) => row.fulfillmentId), actor])).rows[0].n).toBe(2);
    expect((await db().query('select stage,version,cancelled_at=now() as stamped,cancelled_by,confirmed_at is not null as confirmed,expires_at from public.shipment_slips where id=$1', [slip.id])).rows[0])
      .toEqual({ stage: 'cancelled', version: 3, stamped: true, cancelled_by: actor, confirmed: true, expires_at: null });
    expect((await db().query('select version,kind,shipping_carrier,tracking_number,tracking_version,shipment_date::text as shipment_date,actor_id,operation_id from public.shipment_slip_versions where slip_id=$1 order by version', [slip.id])).rows)
      .toEqual([
        { version: 2, kind: 'confirm', shipping_carrier: 'yamato', tracking_number: 'ab-123', tracking_version: 1, shipment_date: today, actor_id: actor, operation_id: expect.any(String) },
        { version: 3, kind: 'cancel', shipping_carrier: 'yamato', tracking_number: 'ab-123', tracking_version: 1, shipment_date: today, actor_id: actor, operation_id: op.id },
      ]);
    expect((await db().query('select count(*)::int as n from public.shipment_date_history where slip_id=$1', [slip.id])).rows[0].n).toBe(1);
    await db().query('set constraints all immediate');
  });

  test('FREQ-534-AC-03: 配達済みの票も取り消せ、delivered→ready に戻る', async () => {
    const f = await ready();
    const { slip, confirmed } = await ship([{ orderItemId: f.orderItemId, quantity: 4 }]);
    const fulfillmentId = confirmed.fulfillments[0].fulfillmentId;
    // The confirm stamped shipped_at with the transaction time (microseconds), so deliver with now() as well: the shared
    // fixture reads shipped_at through a JS Date (milliseconds) and would violate delivered_at >= shipped_at.
    await db().query("select set_config('app.fulfillment_change', 'manual', true)");
    await db().query("update public.order_fulfillments set delivery_status='delivered', delivery_status_at=now(), delivered_at=now() where id=$1", [fulfillmentId]);
    await db().query("select set_config('app.fulfillment_change', '', true)");
    expect((await db().query('select delivered_at is not null as delivered from public.order_fulfillments where id=$1', [fulfillmentId])).rows[0].delivered).toBe(true);
    const key = randomUUID();
    await cancel(slip.id, { key });
    const op = await operationOf(key);
    expect((await db().query(`select from_status,to_status,unit_to-unit_from as n,reason from public.order_item_state_events where operation_id=$1`, [op.id])).rows)
      .toEqual([{ from_status: 'delivered', to_status: 'ready', n: 4, reason: 'shipment_slip_cancel' }]);
    expect((await orderOf(f.orderId)).status).toBe('paid');
    await db().query('set constraints all immediate');
  });

  test.each([true, false])('FREQ-534-AC-03: 代表の登録がcancelledで止まり（外へ登録済み=%s の時だけ provider_stop_pending が立つ）、開いていた要対応はautoで閉じ、まだ送っていない発送メールはskipped、送信済みは変わらず、取消のお客様メールは作られない', async (everRegistered) => {
    await setDeliveryTracking(db(), true, await flow.createActor(['admin']));
    const a = await ready(); const b = await ready();
    const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
    const [leader, participant] = confirmed.fulfillments;
    expect((await db().query('select fulfillment_id from private.fulfillment_tracking_registrations where fulfillment_id=any($1::uuid[])',
      [confirmed.fulfillments.map((row) => row.fulfillmentId)])).rows).toEqual([{ fulfillment_id: leader.fulfillmentId }]);
    if (everRegistered) {
      await db().query("update private.fulfillment_tracking_registrations set state='registered',ever_registered=true,registered_at=now() where fulfillment_id=$1", [leader.fulfillmentId]);
    }
    await db().query("insert into public.order_fulfillment_attention (fulfillment_id, kind) values ($1,'delivery_failure')", [leader.fulfillmentId]);
    await db().query("update private.order_email_outbox set status='sent', sent_at=now(), finished_at=now() where fulfillment_id=$1", [leader.fulfillmentId]);
    await db().query("update private.order_email_outbox set status='retry_wait', attempts=1, next_attempt_at=now() + interval '1 minute' where fulfillment_id=$1", [participant.fulfillmentId]);
    const emailRow = async (fulfillmentId: string) => (await db().query(
      'select status,subject,body_text,last_error_code,finished_at is not null as finished,md5(to_jsonb(e)::text) as digest from private.order_email_outbox e where fulfillment_id=$1', [fulfillmentId])).rows;
    const sentBefore = await emailRow(leader.fulfillmentId);
    const waitingBefore = await emailRow(participant.fulfillmentId);
    expect(waitingBefore).toEqual([expect.objectContaining({ status: 'retry_wait' })]);
    const outboxCount = async () => (await db().query('select count(*)::int as n from private.order_email_outbox where order_id=any($1::uuid[])',
      [[a.orderId, b.orderId]])).rows[0].n;
    const emailsBefore = await outboxCount();
    const parentBefore = (await db().query('select md5(to_jsonb(p)::text) as digest from private.shipment_tracking_registrations p where slip_id=$1', [slip.id])).rows;
    expect(parentBefore).toHaveLength(1);

    await cancel(slip.id);

    expect((await db().query(`select state,stop_reason,provider_stop_pending,ever_registered,lease_token,stopped_at is not null as stopped
      from private.fulfillment_tracking_registrations where fulfillment_id=$1`, [leader.fulfillmentId])).rows)
      .toEqual([{ state: 'stopped', stop_reason: 'cancelled', provider_stop_pending: everRegistered, ever_registered: everRegistered, lease_token: null, stopped: true }]);
    expect((await db().query('select count(*)::int as n from private.fulfillment_tracking_registrations where fulfillment_id=$1', [participant.fulfillmentId])).rows[0].n).toBe(0);
    expect((await db().query('select resolved_at is not null as resolved,resolution from public.order_fulfillment_attention where fulfillment_id=$1', [leader.fulfillmentId])).rows)
      .toEqual([{ resolved: true, resolution: 'auto' }]);
    expect(await emailRow(leader.fulfillmentId)).toEqual(sentBefore);
    expect(await emailRow(participant.fulfillmentId)).toEqual([{
      status: 'skipped', subject: null, body_text: null, last_error_code: 'fulfillment_cancelled', finished: true, digest: expect.any(String),
    }]);
    expect(await outboxCount()).toBe(emailsBefore);
    expect((await db().query('select md5(to_jsonb(p)::text) as digest from private.shipment_tracking_registrations p where slip_id=$1', [slip.id])).rows).toEqual(parentBefore);
    await db().query('set constraints all immediate');
  });

  describe('拒否（返品・発送後の返金・取り消せない状態）', () => {
    /** Two orders, each shipped 2 of 4 so both stay paid; the slip has both shipments. */
    const twoOrderSlip = async () => {
      const a = await ready(); const b = await ready();
      const { slip, confirmed } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
      const fulfillmentOf = (orderId: string) => confirmed.fulfillments.find((row) => row.orderId === orderId)!.fulfillmentId;
      return { a, b, slip, fulfillmentOf };
    };
    type Slip = Awaited<ReturnType<typeof twoOrderSlip>>;
    const withReturn = (s: Slip, status: ReturnFixtureStatus) => insertReturnRecord(db(), { orderId: s.a.orderId, status,
      lines: [{ fulfillmentId: s.fulfillmentOf(s.a.orderId), orderItemId: s.a.orderItemId, quantity: 1 }] });
    const withRefund = (s: Slip, status: RefundFixtureStatus) => insertRefundRecord(db(), { orderId: s.b.orderId, status, amount: 1000,
      lines: [{ orderItemId: s.b.orderItemId, quantity: 1, beforeShipment: false }] });

    test.each(['requested', 'open', 'closed'] as const)('FREQ-534-AC-03: 返品（%s）が1つでもあればGROUP_G_SLIP_HAS_RETURNで、他の注文の発送・割当・台帳・メールを含め何も変わらない', async (status) => {
      const s = await twoOrderSlip();
      await withReturn(s, status);
      await refused(s.slip.id, 'GROUP_G_SLIP_HAS_RETURN');
    });

    test.each(['cancelled', 'declined'] as const)('FREQ-534-AC-03: 取消・お断りの返品（%s）は数えず、取消できる', async (status) => {
      const s = await twoOrderSlip();
      await withReturn(s, status);
      expect(await cancel(s.slip.id)).toMatchObject({ version: 3, restoredQuantity: 4 });
      await db().query('set constraints all immediate');
    });

    test.each(['awaiting_response', 'pending', 'succeeded'] as const)('FREQ-534-AC-03: 発送後の返金（%s）で発送数を下回るならGROUP_G_SLIP_REFUNDEDで、何も変わらない', async (status) => {
      const s = await twoOrderSlip();
      await withRefund(s, status);
      await refused(s.slip.id, 'GROUP_G_SLIP_REFUNDED');
    });

    test.each(['failed', 'error'] as const)('FREQ-534-AC-03: 数えない返金（%s）は取消を止めない', async (status) => {
      const s = await twoOrderSlip();
      await withRefund(s, status);
      expect(await cancel(s.slip.id)).toMatchObject({ version: 3, restoredQuantity: 4 });
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-03: 別の発送が返金した数を支える間は取り消せ、足りなくなる境界でREFUNDEDになる', async () => {
      const f = await ready();
      await seedGroupG1Shipment(db(), { orderId: f.orderId, lines: [{ orderItemId: f.orderItemId, quantity: 2 }], shippedAt: '2026-10-21T00:00:00Z' });
      const first = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await insertRefundRecord(db(), { orderId: f.orderId, status: 'pending', amount: 1000, lines: [{ orderItemId: f.orderItemId, quantity: 2, beforeShipment: false }] });
      // shipped 4 - this slip's 2 = 2, which still covers the 2 refunded after shipment
      expect(await cancel(first.slip.id)).toMatchObject({ version: 3, restoredQuantity: 2 });
      await db().query('set constraints all immediate');
    });

    test('FREQ-534-AC-03: 別の発送が支えきれない数の返金は REFUNDED（shipped 4 - 2 = 2 < 3）', async () => {
      const f = await ready();
      await seedGroupG1Shipment(db(), { orderId: f.orderId, lines: [{ orderItemId: f.orderItemId, quantity: 2 }], shippedAt: '2026-10-21T00:00:00Z' });
      const first = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await insertRefundRecord(db(), { orderId: f.orderId, status: 'pending', amount: 1000, lines: [{ orderItemId: f.orderItemId, quantity: 3, beforeShipment: false }] });
      await refused(first.slip.id, 'GROUP_G_SLIP_REFUNDED');
    });

    test('FREQ-534-AC-03: 取り消せない状態の注文が1つでもあればGROUP_G_SLIP_CANCEL_NOT_ALLOWEDで、何も変わらない', async () => {
      const s = await twoOrderSlip();
      await setOrderStatusForFixture(db(), [s.b.orderId], 'cancelled');
      await refused(s.slip.id, 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED');
    });

    test('FREQ-534-AC-03: 拒否の優先は CANCEL_NOT_ALLOWED → HAS_RETURN → REFUNDED', async () => {
      const s = await twoOrderSlip();
      await withRefund(s, 'pending');
      await refused(s.slip.id, 'GROUP_G_SLIP_REFUNDED');
      await withReturn(s, 'open');
      await refused(s.slip.id, 'GROUP_G_SLIP_HAS_RETURN');
      await setOrderStatusForFixture(db(), [s.b.orderId], 'cancelled');
      await refused(s.slip.id, 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED');
    });
  });

  test('FREQ-533-AC-04: 取消の後、同じ明細を新しい票に選んで再発送でき、票番号はn+1・発送番号は2、割当は復元分から消費される。取消済みの票の発送は消費の裏付けの守りを満たす', async () => {
    const f = await ready({ quantity: 4, allocated: 4 });
    const first = await ship([{ orderItemId: f.orderItemId, quantity: 4 }]);
    const key = randomUUID();
    await cancel(first.slip.id, { key });
    const op = await operationOf(key);
    const restoredAllocations = (await db().query('select id from public.order_item_allocations where operation_id=$1', [op.id])).rows.map((row) => row.id as string);
    expect(restoredAllocations).toHaveLength(1);
    expect(restoredAllocations).not.toContain(f.allocationId);
    expect((await db().query('select remaining_quantity from public.order_item_allocations where id=$1', [f.allocationId])).rows[0].remaining_quantity).toBe(0);

    const second = await draft([{ orderItemId: f.orderItemId, quantity: 4 }]);
    expect(Number(second.number.slice(-4))).toBe(Number(first.slip.number.slice(-4)) + 1);
    const again = await confirm(second.id);
    expect(again.fulfillments).toEqual([expect.objectContaining({ orderId: f.orderId, number: 2, completesOrder: true })]);
    const reconsumed = (await db().query(`select e.allocation_id,e.quantity from public.order_item_allocation_events e
      join private.group_g_operations o on o.id=e.operation_id where o.cause_id=$1 and o.operation='shipment_slip_confirm' and e.event_type='consume'`, [second.id])).rows;
    expect(reconsumed).toEqual([{ allocation_id: restoredAllocations[0], quantity: 4 }]);
    expect((await orderOf(f.orderId)).status).toBe('shipped');
    // consume − restore = active shipped lines (4), with the first shipment cancelled and the second active
    expect((await db().query(`select
      (select coalesce(sum(case e.event_type when 'consume' then e.quantity else -e.quantity end),0)::int from public.order_item_allocation_events e
        join public.order_item_allocations a on a.id=e.allocation_id where a.order_item_id=$1 and e.event_type in ('consume','restore')) as net,
      (select coalesce(sum(l.quantity),0)::int from public.order_fulfillment_lines l join public.order_fulfillments x on x.id=l.fulfillment_id
        where l.order_item_id=$1 and x.cancelled_at is null) as shipped`, [f.orderItemId])).rows[0]).toEqual({ net: 4, shipped: 4 });
    await db().query('set constraints all immediate');
  });

  test.each([
    ['版NULL', { version: null }], ['版0', { version: 0 }], ['actorNULL', { by: null }], ['keyNULL', { key: null }],
  ] as const)('FREQ-533-AC-04: 引数 %s は拒否し不変', async (_label, options) => {
    const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
    await refused(slip.id, 'GROUP_G_ARGUMENT_INVALID', options);
    await refused(null, 'GROUP_G_ARGUMENT_INVALID');
  });

  test('FREQ-533-AC-04: 票が無ければP0002、下書き・破棄済みはGROUP_G_SLIP_NOT_CONFIRMED、版違いはGROUP_G_SLIP_VERSION_CONFLICT。どれも不変', async () => {
    const f = await ready();
    const drafted = await draft([{ orderItemId: f.orderItemId, quantity: 2 }]);
    const discarded = await seedGroupG3Slip(db(), { actorId: actor, stage: 'discarded' });
    const confirmed = await ship([{ orderItemId: (await ready()).orderItemId, quantity: 2 }]);
    await refused(randomUUID(), 'GROUP_G_SLIP_NOT_FOUND', {}, 'P0002');
    await refused(drafted.id, 'GROUP_G_SLIP_NOT_CONFIRMED', { version: 1 }, '55000');
    await refused(discarded, 'GROUP_G_SLIP_NOT_CONFIRMED', { version: 1 }, '55000');
    await refused(confirmed.slip.id, 'GROUP_G_SLIP_VERSION_CONFLICT', { version: 1 }, '55000');
    await refused(confirmed.slip.id, 'GROUP_G_SLIP_VERSION_CONFLICT', { version: 3 }, '55000');
    expect((await cancel(confirmed.slip.id)).version).toBe(3);
  });

  test('FREQ-533-AC-04: 途中の失敗（最後の票のUPDATEの故障）は発送の取消・戻し・台帳・メールを含め全部を原状へ戻す', async () => {
    const a = await ready(); const b = await ready();
    const { slip } = await ship([a, b].map((f) => ({ orderItemId: f.orderItemId, quantity: 2 })));
    const items = `'${a.orderItemId}'::uuid,'${b.orderItemId}'::uuid`;
    await db().query(`create function public.g3_cancel_fault() returns trigger language plpgsql as $f$ begin
      if new.stage='cancelled' then
        if (select count(*) from public.order_fulfillments where order_id in ('${a.orderId}'::uuid,'${b.orderId}'::uuid) and cancelled_at is not null) <> 2
          or (select count(*) from public.order_item_allocation_events e join public.order_item_allocations al on al.id=e.allocation_id
            where al.order_item_id in (${items}) and e.event_type='restore') <> 2
          or (select count(*) from public.stock_movements where order_item_id in (${items}) and reason='restock') <> 2 then
          raise exception 'G3_FAULT_PROGRESS_MISSING' using errcode='P0001';
        end if;
        raise exception 'G3_INJECTED' using errcode='P0001';
      end if; return new; end $f$`);
    await db().query('create trigger g3_cancel_fault before update on public.shipment_slips for each row execute function public.g3_cancel_fault()');
    await refused(slip.id, 'G3_INJECTED', {}, 'P0001');
  });

  test.each(['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'])(
    'FREQ-540-AC-10: 取消は4権限を全て必要とする（%s が無い役割はGROUP_G_FORBIDDEN）', async (code) => {
      const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
      await withRolePermissions(db(), 'supporter', [], [code], () => refused(slip.id, 'GROUP_G_FORBIDDEN', {}, '42501'));
      expect((await cancel(slip.id)).version).toBe(3);
    },
  );
  test('FREQ-540-AC-10: 役割の無い人・無効な役割・期限切れの役割はGROUP_G_FORBIDDEN。有効な役割なら取り消せる', async () => {
    const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
    for (const by of [await flow.createActor([]), await flow.createActor(['supporter'], { inactive: ['supporter'] }), await flow.createActor(['supporter'], { expired: ['supporter'] })]) {
      await refused(slip.id, 'GROUP_G_FORBIDDEN', { by }, '42501');
    }
    expect((await cancel(slip.id)).version).toBe(3);
  });

  test('FREQ-540-AC-11: 取消はadvisory待ちの間に設定・票・注文・variant・割当の行を持たない', async () => {
    const f = await ready(); const { slip } = await ship([{ orderItemId: f.orderItemId, quantity: 2 }]);
    const other = await connectLocalDb(); let pending: Promise<unknown> | undefined;
    try {
      await other.query('begin'); await other.query("set local statement_timeout='10s'");
      const pid = (await other.query('select pg_backend_pid() pid')).rows[0].pid;
      pending = other.query('select public.admin_cancel_shipment_slip($1,2,$2,$3)', [slip.id, actor, randomUUID()]).then(() => ({ ok: true }), () => ({ ok: false }));
      let waiting = false;
      for (let i = 0; i < 300 && !waiting; i += 1) waiting = (await db().query("select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) waiting", [pid])).rows[0].waiting;
      expect(waiting).toBe(true);
      for (const [table, column, id] of [['public.shop_settings', 'id', 1], ['public.shipment_slips', 'id', slip.id], ['public.orders', 'id', f.orderId],
        ['public.item_variants', 'id', f.variantId], ['public.order_item_allocations', 'id', f.allocationId]] as const) {
        await db().query(`select ${column} from ${table} where ${column}=$1 for update nowait`, [id]);
      }
      await db().query('select pg_cancel_backend($1)', [pid]); await pending;
    } finally { if (pending) await pending; await other.query('rollback'); await other.end(); }
  });

  test('FREQ-540-AC-11: restoreは共通advisoryなしでは拒否する', async () => {
    const other = await connectLocalDb();
    try {
      await expect(other.query(`select ${restoreSignature.slice(0, restoreSignature.indexOf('('))}($1,$2,$3,$4,$5)`,
        [randomUUID(), randomUUID(), randomUUID(), actor, 'SL-20261025-0001'])).rejects.toMatchObject({ message: 'GROUP_G_INVENTORY_LOCK_REQUIRED', code: '55000' });
    } finally { await other.end(); }
  });

  test.each(['perform 1 from only "public"."orders" limit 1;', "perform private.group_g_actor_has_permissions(_actor_id,array['admin.shipping.manage']);"])(
    'FREQ-540-AC-11: 取消本体の押さえ前の参照も末尾assertが止める (%s)', async (injected) => {
      const definition = (await db().query('select pg_get_functiondef($1::regprocedure) def', [`private.${cancelSignature}`])).rows[0].def as string;
      const tampered = definition.replace('PERFORM private.lock_group_g_shipment_slips(', `${injected} PERFORM private.lock_group_g_shipment_slips(`);
      expect(tampered).not.toBe(definition);
      const start = sql.indexOf('DO $g3c_final_objects$'); const end = sql.indexOf('$g3c_final_objects$;', start) + '$g3c_final_objects$;'.length;
      expect(await flow.rejected(async () => { await db().query(tampered); await db().query(sql.slice(start, end)); }))
        .toEqual({ message: 'GROUP_G_MIGRATION_ASSERTION_FAILED', code: '55000', detail: 'shipping_slip_lock_order' });
    },
  );

  test('FREQ-540-AC-11: 公開入口はINVOKER委譲、private本体はDEFINER、restoreにEXECUTEなし、allowlist75本に2本が入る', async () => {
    const rows = (await db().query(`select n.nspname,p.proname,p.prosecdef,p.prosrc,has_function_privilege('service_role',p.oid,'EXECUTE') service,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=any($1::regprocedure[])`,
    [[`public.${cancelSignature}`, `private.${cancelSignature}`, restoreSignature]])).rows;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ anon: false, authenticated: false, public_execute: false });
    expect(rows.find((row) => row.nspname === 'public')).toMatchObject({ prosecdef: false, service: true });
    expect(rows.find((row) => row.nspname === 'public').prosrc).toContain('SELECT private.admin_cancel_shipment_slip(');
    expect(rows.find((row) => row.nspname === 'private' && row.proname === 'admin_cancel_shipment_slip')).toMatchObject({ prosecdef: true, service: true });
    expect(rows.find((row) => row.proname === 'restore_group_g_shipment')).toMatchObject({ prosecdef: true, service: false });
    const allowlist = (await db().query('select x::oid::text as oid from unnest(private.group_g_writer_allowlist()) as a(x)')).rows.map((row) => row.oid);
    expect(allowlist).toHaveLength(75);
    const expected = (await db().query('select to_regprocedure(s)::oid::text as oid from unnest($1::text[]) as s', [G3D_ALLOWLIST])).rows.map((row) => row.oid);
    expect([...allowlist].sort()).toEqual([...expected].sort());
    expect((await db().query('select cardinality(private.group_g_writer_allowlist()) n')).rows[0].n).toBe(75);
  });
});
