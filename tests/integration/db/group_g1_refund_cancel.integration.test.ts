/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb } from './helpers/local-db';
import {
  PRICE, createCatalogFixture, insertOrderWithLines, insertRefundRecord, movementsOf, reserveFixtureAllocation,
  shipFixtureOrder, uniqueSuffix, variantStock,
} from './helpers/order-fixtures';

/**
 * G-1 Task 8: refund begin / result / external / error under the common lock, connected to the real allocations.
 * awaiting_response covers units (cancelled / not shippable) but keeps every A; the first pending/succeeded releases
 * only the A the remaining units no longer need (refund/+n, then FIFO; no_restock pairs refund/+n with
 * adjustment/-n and runs no FIFO in between); a failure restores only the released units through the normal FIFO by
 * the original order date and never takes another order's A. Each test runs in one transaction and rolls back.
 */
jest.setTimeout(30000);

type Row = Record<string, any>;

describeLocalDb('G-1 Task 8: refunds and the FIFO allocations', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function actor(): Promise<string> {
    return (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-refund-${uniqueSuffix()}@example.com`])).rows[0].id;
  }

  /** A paid order with one stock line; reserved=true makes the whole quantity a real paid A. */
  async function paidOrder(options: {
    stock: number; quantity: number; reserved?: boolean; createdAt?: string; variant?: { itemId: number; variantId: number };
  }) {
    const fx = options.variant ?? await createCatalogFixture(db(), { stock: options.stock });
    const order = await insertOrderWithLines(db(), {
      status: 'paid', paidAmount: PRICE * options.quantity, createdAt: options.createdAt,
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: options.quantity, fulfillmentType: 'stock',
        reserved: options.reserved ?? true }],
    });
    return { orderId: order.orderId, itemId: order.orderItemIds[0], fx };
  }

  async function paidAllocated(orderItemId: string): Promise<number> {
    return Number((await db().query(`select coalesce(sum(remaining_quantity), 0)::int as n from public.order_item_allocations
      where order_item_id = $1 and kind = 'paid'`, [orderItemId])).rows[0].n);
  }

  async function states(orderId: string): Promise<Record<string, number>> {
    const rows = (await db().query('select status, quantity from public.list_admin_order_item_states(array[$1::uuid])', [orderId])).rows;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = (out[row.status] ?? 0) + Number(row.quantity);
    return out;
  }

  async function record(refundId: string, status: string): Promise<Row> {
    return (await db().query(`select * from public.record_order_refund_result($1::uuid, $2::text, $3::text, null, null, null,
      'card', null, null)`, [refundId, `re_${refundId.replaceAll('-', '')}`, status])).rows[0];
  }

  async function line(refundId: string): Promise<Row> {
    return (await db().query(`select released_quantity, restocked_quantity, rereserved_quantity, rereserve_shortage
      from public.order_refund_lines where refund_id = $1`, [refundId])).rows[0];
  }

  async function operations(operation: string, causeId: string): Promise<string[]> {
    return (await db().query('select id from private.group_g_operations where operation = $1 and cause_id = $2 order by created_at, id',
      [operation, causeId])).rows.map((row) => row.id as string);
  }

  async function stateEventCount(orderId: string): Promise<number> {
    return Number((await db().query(`select count(*)::int as n from public.order_item_state_events e
      join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [orderId])).rows[0].n);
  }

  test('q=2/A=2/返金1: 返事待ちは取消済み1・準備中1で物理A=2、pendingで1解放、succeededと再送は増分0。同キー再送も増分0', async () => {
    const who = await actor();
    const { orderId, itemId, fx } = await paidOrder({ stock: 2, quantity: 2 });
    const requestKey = randomUUID();
    const beginParams = [orderId, requestKey, JSON.stringify([{ order_item_id: itemId, quantity: 1, before_shipment: true }]), who];
    const BEGIN = `select * from public.begin_order_refund($1::uuid,'admin',$2::uuid,$3::jsonb,true,0,${PRICE},null,null,null,false,$4::uuid,null)`;

    const began = (await db().query(BEGIN, beginParams)).rows[0];
    expect(began).toMatchObject({ amount: PRICE, status: 'awaiting_response', replayed: false });
    const refundId = began.refund_id as string;
    expect(await states(orderId)).toEqual({ cancelled: 1, ready: 1 });
    expect(await paidAllocated(itemId)).toBe(2);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    const beginOps = await operations('begin_order_refund', refundId);
    expect(beginOps).toHaveLength(1);
    const cancelledEvents = (await db().query(`select from_status, to_status, unit_to - unit_from as n from public.order_item_state_events
      where operation_id = $1`, [beginOps[0]])).rows;
    expect(cancelledEvents).toEqual([{ from_status: 'ready', to_status: 'cancelled', n: 1 }]);

    // The same request key: the earlier record, no new operation or history.
    const events = await stateEventCount(orderId);
    expect((await db().query(BEGIN, beginParams)).rows[0]).toMatchObject({ refund_id: refundId, replayed: true });
    expect(await operations('begin_order_refund', refundId)).toHaveLength(1);
    expect(await stateEventCount(orderId)).toBe(events);

    const pending = await record(refundId, 'pending');
    expect(pending).toMatchObject({ status: 'pending', newly_accepted: true });
    expect(await paidAllocated(itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await line(refundId)).toMatchObject({ released_quantity: 1, restocked_quantity: 1 });
    expect(await states(orderId)).toEqual({ cancelled: 1, ready: 1 });
    const release = (await db().query(`select e.reason, e.quantity, m.delta, m.reason as movement_reason, m.refund_id,
        m.allocation_operation_id = e.operation_id as same_operation
      from public.order_item_allocation_events e join public.stock_movements m on m.id = e.stock_movement_id
      join public.order_item_allocations a on a.id = e.allocation_id
      where a.order_item_id = $1 and e.event_type = 'release'`, [itemId])).rows;
    expect(release).toEqual([{ reason: 'refund_restock', quantity: 1, delta: 1, movement_reason: 'refund', refund_id: refundId,
      same_operation: true }]);

    const ledger = await movementsOf(db(), fx.variantId);
    expect((await record(refundId, 'succeeded'))).toMatchObject({ status: 'succeeded', newly_accepted: false });
    expect((await record(refundId, 'succeeded'))).toMatchObject({ status: 'succeeded', newly_accepted: false });
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await paidAllocated(itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    // One operation per transition; the repeated succeeded report reuses its operation.
    expect(await operations('record_order_refund_result', refundId)).toHaveLength(3);
  });

  test('no_restock は refund/+n と adjustment/-n を同じ返金で対にし、間で FIFO を動かさない（古い待ち注文は A 0 のまま）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const waiting = await paidOrder({ stock: 0, quantity: 1, reserved: false, createdAt: '2026-01-01', variant: fx });
    const target = await paidOrder({ stock: 0, quantity: 2, createdAt: '2026-02-01', variant: fx });
    const { refundId } = await insertRefundRecord(db(), {
      orderId: target.orderId, lines: [{ orderItemId: target.itemId, quantity: 1, restockType: 'no_restock' }],
    });

    await record(refundId, 'pending');

    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 1, reason: 'refund' }, { delta: -1, reason: 'adjustment' },
    ]);
    const tagged = (await db().query(`select reason, refund_id, allocation_operation_id is not null as tagged
      from public.stock_movements where variant_id = $1 and reason in ('refund', 'adjustment') order by id`, [fx.variantId])).rows;
    expect(tagged).toEqual([
      { reason: 'refund', refund_id: refundId, tagged: true }, { reason: 'adjustment', refund_id: refundId, tagged: false },
    ]);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    expect(await paidAllocated(target.itemId)).toBe(1);
    expect(await paidAllocated(waiting.itemId)).toBe(0);
    expect(await line(refundId)).toMatchObject({ released_quantity: 1, restocked_quantity: 0 });
  });

  test('受注生産の行が FIFO で受けた A は、発送前の返金で在庫に戻り（調整で消さない）、次に古い待ち注文へ渡る。A の無い受注生産の行は何も足さない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const made = await insertOrderWithLines(db(), { status: 'paid', paidAmount: PRICE, createdAt: '2026-02-01',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'backorder' }] });
    const waiting = await paidOrder({ stock: 0, quantity: 1, reserved: false, createdAt: '2026-03-01', variant: fx });
    // The made unit arrives and FIFO gives it to the older backorder line.
    const orders = (await db().query('select private.lock_group_g_inventory($1,$2) as ids', [[fx.variantId], []])).rows[0].ids;
    const before = (await db().query('select private.capture_group_g_item_states($1) as s', [orders])).rows[0].s;
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'task8_test_receipt',$2,repeat('e',64),'test',$3,'{}')`, [op, randomUUID(), op]);
    await db().query(`insert into public.stock_movements (variant_id, delta, reason, note) values ($1, 1, 'restock', 'fixture')`, [fx.variantId]);
    expect((await db().query('select private.allocate_group_g_fifo($1,$2,null) as n', [[fx.variantId], op])).rows[0].n).toBe(1);
    await db().query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,null)', [JSON.stringify(before), orders, op, 'fifo']);
    expect(await paidAllocated(made.orderItemIds[0])).toBe(1);
    expect(await paidAllocated(waiting.itemId)).toBe(0);
    const ledger = await movementsOf(db(), fx.variantId);
    // The refund start records a backorder line as no_restock; the allocated unit is still physical stock.
    const { refundId } = await insertRefundRecord(db(), {
      orderId: made.orderId, lines: [{ orderItemId: made.orderItemIds[0], quantity: 1, restockType: 'no_restock' }],
    });

    await record(refundId, 'pending');

    expect(await movementsOf(db(), fx.variantId)).toEqual([...ledger, { delta: 1, reason: 'refund' }, { delta: -1, reason: 'purchase' }]);
    expect(await line(refundId)).toMatchObject({ released_quantity: 1, restocked_quantity: 1 });
    expect(await paidAllocated(made.orderItemIds[0])).toBe(0);
    expect(await paidAllocated(waiting.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(0);

    // A backorder line that never received A: the refund adds nothing to stock.
    const other = await createCatalogFixture(db(), { stock: 0 });
    const unmade = await insertOrderWithLines(db(), { status: 'paid', paidAmount: PRICE,
      lines: [{ itemId: other.itemId, variantId: other.variantId, quantity: 1, fulfillmentType: 'backorder' }] });
    const { refundId: unmadeRefund } = await insertRefundRecord(db(), {
      orderId: unmade.orderId, lines: [{ orderItemId: unmade.orderItemIds[0], quantity: 1, restockType: 'no_restock' }],
    });
    await record(unmadeRefund, 'pending');
    expect(await movementsOf(db(), other.variantId)).toEqual([]);
    expect(await line(unmadeRefund)).toMatchObject({ released_quantity: 0, restocked_quantity: 0 });
  });

  test('発送後の返金は在庫も割当も増やさない', async () => {
    const who = await actor();
    const { orderId, itemId, fx } = await paidOrder({ stock: 2, quantity: 2 });
    await shipFixtureOrder(db(), { orderId, actorId: who, lines: [{ order_item_id: itemId, quantity: 2 }] });
    const ledger = await movementsOf(db(), fx.variantId);
    const { refundId } = await insertRefundRecord(db(), {
      orderId, lines: [{ orderItemId: itemId, quantity: 1, beforeShipment: false }],
    });

    expect(await record(refundId, 'succeeded')).toMatchObject({ newly_accepted: true });

    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    expect(await paidAllocated(itemId)).toBe(0);
    expect(await line(refundId)).toMatchObject({ released_quantity: 0, restocked_quantity: 0 });
  });

  test('pending→failed: 解放した1点は古い待ち注文へ渡り、失敗はその A を奪わず不足と要確認に残す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const older = await paidOrder({ stock: 0, quantity: 1, reserved: false, createdAt: '2026-01-01', variant: fx });
    const target = await paidOrder({ stock: 0, quantity: 2, createdAt: '2026-02-01', variant: fx });
    const { refundId } = await insertRefundRecord(db(), { orderId: target.orderId, lines: [{ orderItemId: target.itemId, quantity: 1 }] });

    await record(refundId, 'pending');
    expect(await paidAllocated(older.itemId)).toBe(1);
    expect(await paidAllocated(target.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    const fifo = (await db().query(`select m.refund_id from public.stock_movements m where m.order_item_id = $1 and m.reason = 'purchase'
      and m.allocation_operation_id is not null order by m.id desc limit 1`, [older.itemId])).rows;
    expect(fifo).toEqual([{ refund_id: refundId }]);

    const failed = await record(refundId, 'failed');

    expect(failed).toMatchObject({ status: 'failed', newly_failed: true, rereserve_shortage: 1, exception_id: expect.any(String) });
    expect(await paidAllocated(older.itemId)).toBe(1);
    expect(await paidAllocated(target.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    expect(await line(refundId)).toMatchObject({ released_quantity: 1, rereserved_quantity: 0, rereserve_shortage: 1 });
    expect(await states(target.orderId)).toEqual({ in_production: 1, ready: 1 });
    expect((await db().query('select review_reason from public.orders where id = $1', [target.orderId])).rows[0].review_reason)
      .toBe('stock_not_reserved');
  });

  test('失敗の復元は元の注文日の通常 FIFO: 新しい待ち注文より先に元の注文へ割り当て、新しい注文の A は変えない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const target = await paidOrder({ stock: 0, quantity: 2, createdAt: '2026-02-01', variant: fx });
    const newer = await paidOrder({ stock: 0, quantity: 2, reserved: false, createdAt: '2026-03-01', variant: fx });
    const { refundId } = await insertRefundRecord(db(), { orderId: target.orderId, lines: [{ orderItemId: target.itemId, quantity: 1 }] });
    await record(refundId, 'pending');
    expect(await paidAllocated(newer.itemId)).toBe(1);
    await db().query(`insert into public.stock_movements (variant_id, delta, reason, note) values ($1, 1, 'restock', 'fixture')`, [fx.variantId]);

    const failed = await record(refundId, 'failed');

    expect(failed).toMatchObject({ newly_failed: true, rereserve_shortage: 0 });
    expect(await paidAllocated(target.itemId)).toBe(2);
    expect(await paidAllocated(newer.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    expect(await line(refundId)).toMatchObject({ released_quantity: 1, rereserved_quantity: 1, rereserve_shortage: 0 });
    const rereserved = (await db().query(`select refund_id from public.stock_movements where order_item_id = $1 and reason = 'purchase'
      order by id desc limit 1`, [target.itemId])).rows;
    expect(rereserved).toEqual([{ refund_id: refundId }]);
    expect((await db().query('select review_reason from public.orders where id = $1', [target.orderId])).rows[0].review_reason).toBeNull();
  });

  test('返事待ち→エラーは覆いを外すだけで、未解放の A を増やさず FIFO も動かさない', async () => {
    const full = await paidOrder({ stock: 2, quantity: 2 });
    const { refundId: first } = await insertRefundRecord(db(), { orderId: full.orderId, lines: [{ orderItemId: full.itemId, quantity: 1 }] });
    expect(await states(full.orderId)).toEqual({ cancelled: 1, ready: 1 });
    expect((await db().query(`select outcome from public.mark_order_refund_error($1::uuid,'not_found_in_stripe',false)`, [first])).rows)
      .toEqual([{ outcome: 'errored' }]);
    expect(await states(full.orderId)).toEqual({ ready: 2 });
    expect(await paidAllocated(full.itemId)).toBe(2);
    expect(await operations('mark_order_refund_error', first)).toHaveLength(1);

    // An order whose line is mostly unallocated: free stock is available, yet the error allocates nothing.
    const fx = await createCatalogFixture(db(), { stock: 6 });
    const partial = await paidOrder({ stock: 0, quantity: 3, reserved: false, variant: fx });
    await reserveFixtureAllocation(db(), { orderId: partial.orderId, orderItemId: partial.itemId, variantId: fx.variantId, quantity: 1, status: 'paid' });
    const { refundId: second } = await insertRefundRecord(db(), { orderId: partial.orderId, lines: [{ orderItemId: partial.itemId, quantity: 2 }] });
    const ledger = await movementsOf(db(), fx.variantId);
    await db().query(`select outcome from public.mark_order_refund_error($1::uuid,'stripe_rejected',true)`, [second]);
    expect(await paidAllocated(partial.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(5);
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await states(partial.orderId)).toEqual({ in_production: 2, ready: 1 });
  });

  test('結果の途中で失敗すると、返金の状態・注文の額・メールの予定・割当・台帳・操作・状態の履歴が全部戻る', async () => {
    const { orderId, itemId, fx } = await paidOrder({ stock: 2, quantity: 2 });
    const refundId = (await db().query(`insert into public.order_refunds
        (order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, notify_customer)
      values ($1, 'admin', gen_random_uuid(), 'fixture', 'awaiting_response', $2, 0, true) returning id`, [orderId, PRICE])).rows[0].id as string;
    await db().query(`insert into public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
      values ($1, $2, 1, true, 'cancel', $3)`, [refundId, itemId, PRICE]);
    const ledger = await movementsOf(db(), fx.variantId);
    const events = await stateEventCount(orderId);

    await db().query('savepoint inject');
    await db().query(`create function public.g1_task8_injected_failure() returns trigger language plpgsql as $$
      begin raise exception 'G1_TASK8_INJECTED'; end $$`);
    await db().query(`create trigger g1_task8_injected_failure before insert on public.order_item_allocation_events
      for each row execute function public.g1_task8_injected_failure()`);
    await db().query('savepoint call');
    await expect(record(refundId, 'succeeded')).rejects.toMatchObject({ message: 'G1_TASK8_INJECTED' });
    await db().query('rollback to savepoint call');
    await db().query('rollback to savepoint inject');

    expect((await db().query('select status, stock_applied_at, email_enqueued_at from public.order_refunds where id = $1', [refundId])).rows)
      .toEqual([{ status: 'awaiting_response', stock_applied_at: null, email_enqueued_at: null }]);
    expect((await db().query('select status::text as status, refunded_amount from public.orders where id = $1', [orderId])).rows)
      .toEqual([{ status: 'paid', refunded_amount: 0 }]);
    expect(Number((await db().query('select count(*)::int as n from private.order_email_outbox where order_id = $1', [orderId])).rows[0].n)).toBe(0);
    expect(await paidAllocated(itemId)).toBe(2);
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await operations('record_order_refund_result', refundId)).toEqual([]);
    expect(await stateEventCount(orderId)).toBe(events);
    expect(await line(refundId)).toMatchObject({ released_quantity: 0, restocked_quantity: 0 });

    // Without the fault the same result succeeds once.
    expect(await record(refundId, 'succeeded')).toMatchObject({ newly_accepted: true, refunded_amount: PRICE, email_enqueued: true });
    expect(await paidAllocated(itemId)).toBe(1);
  });

  test('外からの全額の返金は、未発送の割当を外して在庫に戻し、同じ返金の再送は増分0', async () => {
    const { orderId, itemId, fx } = await paidOrder({ stock: 2, quantity: 2 });
    const stripeRefundId = `re_${uniqueSuffix()}`;
    const EXTERNAL = `select * from public.record_external_order_refund($1::uuid,$2::text,$3::integer,'succeeded',null,null,null,'card',
      null,null,null,now())`;

    const first = (await db().query(EXTERNAL, [orderId, stripeRefundId, PRICE * 2])).rows[0];
    expect(first).toMatchObject({ created: true, newly_accepted: true, order_status: 'cancelled' });
    expect(await paidAllocated(itemId)).toBe(0);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
    expect(await states(orderId)).toEqual({ cancelled: 2 });
    const ledger = await movementsOf(db(), fx.variantId);

    const again = (await db().query(EXTERNAL, [orderId, stripeRefundId, PRICE * 2])).rows[0];
    expect(again).toMatchObject({ created: false, refund_id: first.refund_id, newly_accepted: false });
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await operations('record_external_order_refund', first.refund_id)).toHaveLength(2);
  });

  test('内部の core は共通の lock を持たない呼出しを断り、入れ子で公開 RPC や lock helper を呼ばない', async () => {
    // A fresh connection (owner, no advisory): every internal core refuses before reading any row.
    const fresh = await connectLocalDb();
    try {
      for (const sql of [
        'select * from private.apply_order_refund_state($1::uuid)',
        `select private.apply_return_refund_outcome($1::uuid, 'awaiting_response')`,
        `select * from private.record_group_g_refund_result($1::uuid,'re_x1','succeeded',null,null,null,'card',null,null,
          'record_order_refund_result',array[]::uuid[],'[]'::jsonb)`,
        `select * from private.record_group_g_payment_exception_row($1::text,'refund_failed',null,null,null,null,null)`,
        `select private.resolve_group_g_payment_exception_row($1::uuid, null)`,
      ]) {
        await expect(fresh.query(sql, [randomUUID()])).rejects.toMatchObject({ code: '55000', message: 'GROUP_G_INVENTORY_LOCK_REQUIRED' });
      }
    } finally {
      await fresh.end();
    }
    // Public bodies never call a public RPC or re-run the lock helper from inside the refund cores.
    const nested = (await db().query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = any($1::text[])
        and (p.prosrc ~ 'public\\.(record_payment_exception|resolve_payment_exception_by_system|record_order_refund_result|begin_order_refund)\\('
          or (p.proname <> all($2::text[]) and p.prosrc like '%lock_group_g_inventory%'))`,
    [['begin_order_refund', 'begin_order_refund_core', 'apply_order_refund_state', 'apply_return_refund_outcome',
      'record_group_g_refund_result', 'record_order_refund_result', 'record_external_order_refund', 'mark_order_refund_error'],
    ['begin_order_refund', 'record_order_refund_result', 'record_external_order_refund', 'mark_order_refund_error']])).rows;
    expect(nested).toEqual([]);
  });
});
