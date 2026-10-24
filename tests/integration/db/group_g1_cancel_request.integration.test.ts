/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  PRICE, createCatalogFixture, insertOrderWithLines, movementsOf, reserveFixtureAllocation, uniqueSuffix, variantStock,
} from './helpers/order-fixtures';

/**
 * G-1 Task 9: the cancel request intake / decline / close / resolve under the common lock.
 * A request moves only the requested units to cancel_requested and keeps every A/H (FIFO skips those units).
 * Decline/close return the units to waiting (the kept A is ready again) and the unallocated units rejoin FIFO.
 * Resolve releases nothing: the refund/cancel body released the A once. Each test runs in one transaction and rolls back.
 */
jest.setTimeout(30000);

type Row = Record<string, any>;
type Fx = { itemId: number; variantId: number };

const REQUEST = 'select * from public.customer_request_cancel($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::text)';

describeLocalDb('G-1 Task 9: cancel requests and the FIFO allocations', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('delete from private.order_email_outbox');
    await db().query(`update public.shop_return_settings set requests_enabled = true,
      request_types = 'returns_and_cancellations' where id = 1`);
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function user(label: string): Promise<string> {
    return (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-cancel-${label}-${uniqueSuffix()}@example.com`])).rows[0].id;
  }

  /** A paid stock line with `allocated` units of real paid A (taken from the variant's free stock). */
  async function paidOrder(options: { variant: Fx; quantity: number; allocated: number; createdAt?: string; owner?: string }) {
    const order = await insertOrderWithLines(db(), {
      status: 'paid', paidAmount: PRICE * options.quantity, createdAt: options.createdAt,
      lines: [{ itemId: options.variant.itemId, variantId: options.variant.variantId, quantity: options.quantity,
        fulfillmentType: 'stock', reserved: false }],
    });
    const itemId = order.orderItemIds[0];
    if (options.allocated > 0) {
      await reserveFixtureAllocation(db(), { orderId: order.orderId, orderItemId: itemId, variantId: options.variant.variantId,
        quantity: options.allocated, status: 'paid' });
    }
    if (options.owner) await db().query('update public.orders set user_id = $1 where id = $2', [options.owner, order.orderId]);
    return { orderId: order.orderId, itemId };
  }

  async function request(owner: string, order: { orderId: string; itemId: string }, quantity: number, key = randomUUID()) {
    return (await db().query(REQUEST, [order.orderId, owner, key,
      JSON.stringify([{ order_item_id: order.itemId, quantity }]), null])).rows[0];
  }

  async function allocated(orderItemId: string, kind = 'paid'): Promise<number> {
    return Number((await db().query(`select coalesce(sum(remaining_quantity), 0)::int as n from public.order_item_allocations
      where order_item_id = $1 and kind = $2`, [orderItemId, kind])).rows[0].n);
  }

  async function states(orderId: string): Promise<Record<string, number>> {
    const rows = (await db().query('select status, quantity from public.list_admin_order_item_states(array[$1::uuid])', [orderId])).rows;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = (out[row.status] ?? 0) + Number(row.quantity);
    return out;
  }

  async function operations(operation: string, causeId: string): Promise<Row[]> {
    return (await db().query(`select id, request_key, actor_id, result from private.group_g_operations
      where operation = $1 and cause_id = $2 order by created_at, id`, [operation, causeId])).rows;
  }

  async function stateEvents(operationId: string, orderItemId: string): Promise<Row[]> {
    return (await db().query(`select sequence, from_status, to_status, unit_to - unit_from as n, reason
      from public.order_item_state_events where operation_id = $1 and order_item_id = $2 order by sequence, unit_from`,
    [operationId, orderItemId])).rows;
  }

  async function stateEventCount(orderId: string): Promise<number> {
    return Number((await db().query(`select count(*)::int as n from public.order_item_state_events e
      join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [orderId])).rows[0].n);
  }

  async function outbox(orderId: string): Promise<string[]> {
    return (await db().query('select kind from private.order_email_outbox where order_id = $1 order by kind', [orderId]))
      .rows.map((row) => row.kind as string);
  }

  /** Receipt material: +n restock of one variant and the FIFO under the common lock (as the stock entry does). */
  async function receipt(variantId: number, quantity: number): Promise<number> {
    const orders = (await db().query('select private.lock_group_g_inventory($1,$2) as ids', [[variantId], []])).rows[0].ids;
    const before = (await db().query('select private.capture_group_g_item_states($1) as s', [orders])).rows[0].s;
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'task9_test_receipt',$2,repeat('e',64),'test',$3,'{}')`, [op, randomUUID(), op]);
    await db().query(`insert into public.stock_movements (variant_id, delta, reason, note) values ($1, $2, 'restock', 'fixture')`,
      [variantId, quantity]);
    const n = (await db().query('select private.allocate_group_g_fifo($1,$2,null) as n', [[variantId], op])).rows[0].n as number;
    await db().query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,null)', [JSON.stringify(before), orders, op, 'fifo']);
    return n;
  }

  async function refusal(work: () => Promise<unknown>) {
    await db().query('savepoint expected_refusal');
    try {
      return await work().then(() => null, (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
    } finally {
      await db().query('rollback to savepoint expected_refusal');
    }
  }

  test('申請は申請数量だけ cancel_requested にし A を保持する。入荷の FIFO は申請中の数を飛ばし、同じキーの再送は増分0', async () => {
    const owner = await user('owner');
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const older = await paidOrder({ variant: fx, quantity: 2, allocated: 1, createdAt: '2026-01-01', owner });
    const newer = await paidOrder({ variant: fx, quantity: 1, allocated: 0, createdAt: '2026-02-01' });
    expect(await states(older.orderId)).toEqual({ in_production: 1, ready: 1 });
    const key = randomUUID();

    const created = await request(owner, older, 2, key);

    expect(created).toEqual({ cancel_request_id: expect.any(String), status: 'requested', replayed: false });
    const cancelId = created.cancel_request_id as string;
    expect(await states(older.orderId)).toEqual({ cancel_requested: 2 });
    expect(await allocated(older.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    const ops = await operations('customer_request_cancel', cancelId);
    expect(ops).toEqual([{ id: expect.any(String), request_key: key, actor_id: owner,
      result: { cancel_request_id: cancelId, order_id: older.orderId } }]);
    expect(await stateEvents(ops[0].id, older.itemId)).toEqual([
      { sequence: 1, from_status: 'in_production', to_status: 'cancel_requested', n: 1, reason: 'customer_request_cancel' },
      { sequence: 1, from_status: 'ready', to_status: 'cancel_requested', n: 1, reason: 'customer_request_cancel' },
    ]);
    expect(await outbox(older.orderId)).toEqual(['cancel_request_received', 'cancel_request_shop']);

    // The same key and input: the earlier request, no new operation, history or mail.
    const events = await stateEventCount(older.orderId);
    expect(await request(owner, older, 2, key)).toEqual({ cancel_request_id: cancelId, status: 'requested', replayed: true });
    expect(await operations('customer_request_cancel', cancelId)).toHaveLength(1);
    expect(await stateEventCount(older.orderId)).toBe(events);
    expect(await outbox(older.orderId)).toEqual(['cancel_request_received', 'cancel_request_shop']);

    // Stock arrives while the request is open: the requested units of the older order are skipped.
    expect(await receipt(fx.variantId, 2)).toBe(1);
    expect(await allocated(newer.itemId)).toBe(1);
    expect(await allocated(older.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await states(older.orderId)).toEqual({ cancel_requested: 2 });
  });

  test('未入金の注文の申請は H を保持し、在庫も動かさない', async () => {
    const owner = await user('owner');
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const order = await insertOrderWithLines(db(), { status: 'pending',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'stock' }] });
    await db().query('update public.orders set user_id = $1 where id = $2', [owner, order.orderId]);
    const ledger = await movementsOf(db(), fx.variantId);
    expect(await allocated(order.orderItemIds[0], 'payment_hold')).toBe(2);

    await request(owner, { orderId: order.orderId, itemId: order.orderItemIds[0] }, 1);

    expect(await states(order.orderId)).toEqual({ cancel_requested: 1, unpaid: 1 });
    expect(await allocated(order.orderItemIds[0], 'payment_hold')).toBe(2);
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
  });

  test.each(['decline', 'close'])('%s は保持した A を準備中へ戻し、未割当の数を元の注文日の FIFO に戻す。再実行は増分0', async (op) => {
    const owner = await user('owner');
    const actor = await user('actor');
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const older = await paidOrder({ variant: fx, quantity: 2, allocated: 1, createdAt: '2026-01-01', owner });
    const newer = await paidOrder({ variant: fx, quantity: 1, allocated: 0, createdAt: '2026-02-01' });
    const cancelId = (await request(owner, older, 2)).cancel_request_id as string;
    expect(await receipt(fx.variantId, 2)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    await db().query('delete from private.order_email_outbox');
    const operation = op === 'decline' ? 'admin_decline_cancel_request' : 'admin_close_cancel_request';
    const run = () => op === 'decline'
      ? db().query('select * from public.admin_decline_cancel_request($1::uuid,$2::uuid,$3::text,$4::text)',
        [cancelId, actor, 'other', '受付できません。'])
      : db().query('select * from public.admin_close_cancel_request($1::uuid,$2::uuid)', [cancelId, actor]);

    expect((await run()).rows).toEqual([{ cancel_request_id: cancelId, status: op === 'decline' ? 'declined' : 'closed' }]);

    expect(await states(older.orderId)).toEqual({ ready: 2 });
    expect(await allocated(older.itemId)).toBe(2);
    expect(await allocated(newer.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(0);
    const ops = await operations(operation, cancelId);
    expect(ops).toHaveLength(1);
    expect(ops[0].actor_id).toBe(actor);
    expect(ops[0].result).toMatchObject({ cancel_request_id: cancelId, order_id: older.orderId, allocated_quantity: 1 });
    expect(await stateEvents(ops[0].id, older.itemId)).toEqual([
      { sequence: 1, from_status: 'cancel_requested', to_status: 'in_production', n: 1, reason: operation },
      { sequence: 1, from_status: 'cancel_requested', to_status: 'ready', n: 1, reason: operation },
      { sequence: 2, from_status: 'in_production', to_status: 'ready', n: 1, reason: 'fifo' },
    ]);
    const allocation = (await db().query(`select e.event_type, e.quantity, e.reason, m.delta, m.reason as movement_reason
      from public.order_item_allocation_events e join public.order_item_allocations a on a.id = e.allocation_id
      join public.stock_movements m on m.id = e.stock_movement_id
      where a.order_item_id = $1 and e.operation_id = $2`, [older.itemId, ops[0].id])).rows;
    expect(allocation).toEqual([{ event_type: 'allocate', quantity: 1, reason: 'fifo', delta: -1, movement_reason: 'purchase' }]);
    expect(await outbox(older.orderId)).toEqual(op === 'decline' ? ['cancel_request_declined'] : []);

    // The repeated call keeps the old CAS answer and writes nothing.
    const ledger = await movementsOf(db(), fx.variantId);
    const events = await stateEventCount(older.orderId);
    expect(await refusal(run)).toEqual({ code: '22023', message: 'CANCEL_REQUEST_STATE_CONFLICT' });
    expect(await operations(operation, cancelId)).toHaveLength(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await stateEventCount(older.orderId)).toBe(events);
  });

  test('承認（返金で解決）: A を外すのは返金の1回だけで、解決は台帳も割当も動かさず残りを準備中へ戻す', async () => {
    const owner = await user('owner');
    const actor = await user('actor');
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const order = await paidOrder({ variant: fx, quantity: 2, allocated: 2, owner });
    const cancelId = (await request(owner, order, 1)).cancel_request_id as string;
    expect(await states(order.orderId)).toEqual({ cancel_requested: 1, ready: 1 });
    const refundId = (await db().query(`select refund_id from public.begin_order_refund($1::uuid,'admin',$2::uuid,$3::jsonb,true,0,
      ${PRICE},null,null,null,false,$4::uuid,null)`, [order.orderId, randomUUID(),
      JSON.stringify([{ order_item_id: order.itemId, quantity: 1, before_shipment: true }]), actor])).rows[0].refund_id as string;
    await db().query(`select * from public.record_order_refund_result($1::uuid,$2::text,'pending',null,null,null,'card',null,null)`,
      [refundId, `re_${refundId.replaceAll('-', '')}`]);
    expect(await allocated(order.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await states(order.orderId)).toEqual({ cancelled: 1, cancel_requested: 1 });
    const ledger = await movementsOf(db(), fx.variantId);

    const resolved = (await db().query('select * from public.admin_resolve_cancel_request($1::uuid,$2::uuid,$3::uuid,false)',
      [cancelId, actor, refundId])).rows;

    expect(resolved).toEqual([{ cancel_request_id: cancelId, status: 'resolved' }]);
    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await allocated(order.itemId)).toBe(1);
    expect(await variantStock(db(), fx.variantId)).toBe(1);
    expect(await states(order.orderId)).toEqual({ cancelled: 1, ready: 1 });
    const releases = (await db().query(`select count(*)::int as n from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id = e.allocation_id where a.order_item_id = $1 and e.event_type = 'release'`,
    [order.itemId])).rows[0].n;
    expect(releases).toBe(1);
    const ops = await operations('admin_resolve_cancel_request', cancelId);
    expect(ops).toHaveLength(1);
    expect(await stateEvents(ops[0].id, order.itemId)).toEqual([
      { sequence: 1, from_status: 'cancel_requested', to_status: 'ready', n: 1, reason: 'admin_resolve_cancel_request' },
    ]);
    expect(await refusal(() => db().query('select * from public.admin_resolve_cancel_request($1::uuid,$2::uuid,$3::uuid,false)',
      [cancelId, actor, refundId]))).toEqual({ code: '22023', message: 'CANCEL_REQUEST_STATE_CONFLICT' });
    expect(await operations('admin_resolve_cancel_request', cancelId)).toHaveLength(1);
  });

  test('承認（取消で解決）: 全額の返金で A を外した後の解決は在庫を足さない', async () => {
    const owner = await user('owner');
    const actor = await user('actor');
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const order = await paidOrder({ variant: fx, quantity: 2, allocated: 2, owner });
    const cancelId = (await request(owner, order, 2)).cancel_request_id as string;
    const external = (await db().query(`select * from public.record_external_order_refund($1::uuid,$2::text,$3::integer,'succeeded',
      null,null,null,'card',null,null,null,now())`, [order.orderId, `re_${uniqueSuffix()}`, PRICE * 2])).rows[0];
    expect(external).toMatchObject({ order_status: 'cancelled' });
    expect(await allocated(order.itemId)).toBe(0);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
    const ledger = await movementsOf(db(), fx.variantId);

    expect((await db().query('select status from public.admin_resolve_cancel_request($1::uuid,$2::uuid,null,true)',
      [cancelId, actor])).rows).toEqual([{ status: 'resolved' }]);

    expect(await movementsOf(db(), fx.variantId)).toEqual(ledger);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
    expect(await states(order.orderId)).toEqual({ cancelled: 2 });
  });

  test('内部の申請の鍵は共通の lock の無い呼出しを断り、本体は公開 RPC を呼ばず共通の lock を一度だけ取る', async () => {
    const fresh = await connectLocalDb();
    try {
      await expect(fresh.query('select * from private.lock_order_cancel_request($1::uuid)', [randomUUID()]))
        .rejects.toMatchObject({ code: '55000', message: 'GROUP_G_INVENTORY_LOCK_REQUIRED' });
    } finally {
      await fresh.end();
    }
    // A nested public RPC would re-enter a wrapper; the bodies call only private cores on the rows they hold.
    const rpc = 'public\\.(customer_request_cancel|admin_(decline|close|resolve)_cancel_request|begin_order_refund'
      + '|record_order_refund_result|record_external_order_refund|mark_order_refund_error|admin_record_stock_movement'
      + '|release_stock_for_unpaid_order|record_payment_exception|resolve_payment_exception)\\s*\\(';
    const bodies = (await db().query(`select p.proname, p.prosecdef, p.prosrc ~ $2 as calls_public,
        (length(p.prosrc) - length(replace(p.prosrc, 'lock_group_g_inventory', ''))) / length('lock_group_g_inventory') as locks,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') as client
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname = any($1::text[]) order by p.proname`,
    [['customer_request_cancel', 'admin_decline_cancel_request', 'admin_close_cancel_request', 'admin_resolve_cancel_request',
      'customer_order_for_request', 'lock_order_cancel_request'], rpc])).rows;
    expect(bodies).toEqual([
      { proname: 'admin_close_cancel_request', prosecdef: true, calls_public: false, locks: 1, service_role: true, client: false },
      { proname: 'admin_decline_cancel_request', prosecdef: true, calls_public: false, locks: 1, service_role: true, client: false },
      { proname: 'admin_resolve_cancel_request', prosecdef: true, calls_public: false, locks: 1, service_role: true, client: false },
      { proname: 'customer_order_for_request', prosecdef: false, calls_public: false, locks: 1, service_role: false, client: false },
      { proname: 'customer_request_cancel', prosecdef: true, calls_public: false, locks: 1, service_role: true, client: false },
      { proname: 'lock_order_cancel_request', prosecdef: false, calls_public: false, locks: 0, service_role: false, client: false },
    ]);
    const wrappers = (await db().query(`select p.proname, p.prosecdef, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`,
    [['customer_request_cancel', 'admin_decline_cancel_request', 'admin_close_cancel_request', 'admin_resolve_cancel_request']])).rows;
    expect(wrappers).toEqual(['admin_close_cancel_request', 'admin_decline_cancel_request', 'admin_resolve_cancel_request',
      'customer_request_cancel'].map((proname) => ({ proname, prosecdef: false, service_role: true })));
  });
});

describeLocalDb('G-1 Task 9: the customer helper follows the common lock across connections', (db) => {
  let holder: PgClient;
  let caller: PgClient;
  let observer: PgClient;
  let material: { orderId: string; itemId: string; owner: string; stranger: string };

  beforeAll(async () => {
    holder = await connectLocalDb();
    caller = await connectLocalDb();
    observer = await connectLocalDb();
    for (const c of [holder, caller, observer]) await c.query("set statement_timeout='10s'");
    // Committed material (left for the next db reset): a paid order of its own variant with an owner.
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const order = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: fx.itemId, variantId: fx.variantId,
      quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    const ids: string[] = [];
    for (const label of ['owner', 'stranger']) {
      ids.push((await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
        values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-cancel-lock-${label}-${uniqueSuffix()}@example.com`])).rows[0].id);
    }
    await db().query('update public.orders set user_id = $1 where id = $2', [ids[0], order.orderId]);
    material = { orderId: order.orderId, itemId: order.orderItemIds[0], owner: ids[0], stranger: ids[1] };
  });

  afterAll(async () => {
    await Promise.all([holder.end(), caller.end(), observer.end()]);
  });

  async function pid(c: PgClient) { return (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number; }

  async function waitForAdvisory(waiter: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waiting = (await observer.query(`select exists(select 1 from pg_catalog.pg_locks where pid=$1::int and locktype='advisory'
        and classid=190521 and objid=1 and objsubid=2 and not granted) as waiting`, [waiter])).rows[0].waiting;
      if (waiting) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G1_ADVISORY_WAIT_NOT_OBSERVED');
  }

  test('持ち主でない呼出しは共通の lock を待たずに ORDER_NOT_FOUND。持ち主の更新経路は advisory を先に待ち、その後に注文の行を持つ', async () => {
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock(190521,1)');
    let pending: Promise<unknown> | undefined;
    try {
      const lines = JSON.stringify([{ order_item_id: material.itemId, quantity: 1 }]);
      for (const [sql, params] of [
        ['select (private.customer_order_for_request($1::uuid,$2::uuid,true)).id', [material.orderId, material.stranger]],
        [REQUEST, [material.orderId, material.stranger, randomUUID(), lines, null]],
      ] as Array<[string, unknown[]]>) {
        const started = Date.now();
        await expect(caller.query(sql, params)).rejects.toMatchObject({ code: 'P0002', message: 'ORDER_NOT_FOUND' });
        expect(Date.now() - started).toBeLessThan(3000);
      }

      // The owner's update path (the legacy return request until Task 10) waits for the advisory first.
      await caller.query('begin');
      const waiter = await pid(caller);
      pending = caller.query('select (private.customer_order_for_request($1::uuid,$2::uuid,true)).id as id',
        [material.orderId, material.owner]);
      void pending.catch(() => {});
      await waitForAdvisory(waiter);
      await observer.query('begin');
      expect((await observer.query('select id from public.orders where id=$1 for update nowait', [material.orderId])).rowCount).toBe(1);
      await observer.query('rollback');
      await holder.query('rollback');
      await expect(pending).resolves.toMatchObject({ rows: [{ id: material.orderId }] });
      await observer.query('begin');
      await expect(observer.query('select id from public.orders where id=$1 for update nowait', [material.orderId]))
        .rejects.toMatchObject({ code: '55P03' });
    } finally {
      await observer.query('rollback');
      await holder.query('rollback');
      if (pending) await pending.catch(() => {});
      await caller.query('rollback');
    }
  });
});
