/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';
import {
  isInTransaction, seedGroupG1Allocation, seedGroupG1Restock, seedGroupG1Shipment, withGroupG1FixtureTransaction,
} from './helpers/group-g1-fixtures';

/**
 * G-1 Task 16: the synthetic DB materials follow the G-1 conservation rules (F/A/H, ledger, events, state history)
 * and the transaction contract: without a caller transaction they BEGIN -> advisory -> COMMIT; inside one they need the
 * caller's advisory, use a SAVEPOINT and never commit the caller; a failure rolls back everything they wrote.
 * Most cases run in the caller's transaction and roll back; the commit/rollback cases use their own connections.
 */
jest.setTimeout(60000);

type Row = Record<string, any>;

describeLocalDb('G-1 Task 16: synthetic allocation / shipment / restock materials', (db) => {
  let actor: string;

  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-fixture-${randomUUID()}@example.com`])).rows[0].id;
    // seedGroupG1Restock goes through the real stock entry, which needs a local admin (admin.items.manage).
    await db().query("insert into public.user_roles (user_id, role_id) select $1, id from public.roles where code = 'admin'", [actor]);
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function inventory(variantId: number): Promise<Row> {
    return (await db().query('select free, paid_allocated, payment_held, on_hand from public.list_group_g_variant_inventory($1)',
      [[variantId]])).rows[0];
  }

  async function integrity(variantId: number) {
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id = $1', [variantId])).rows).toEqual([]);
    const i = await inventory(variantId);
    expect(Number(i.on_hand)).toBe(Number(i.free) + Number(i.paid_allocated) + Number(i.payment_held));
  }

  async function order(variant: { itemId: number; variantId: number }, quantity: number, status = 'paid', createdAt?: string) {
    const o = await insertOrderWithLines(db(), { status, createdAt, lines: [{ itemId: variant.itemId, variantId: variant.variantId,
      quantity, fulfillmentType: 'stock', reserved: false }] });
    return { orderId: o.orderId, itemId: o.orderItemIds[0] };
  }

  async function allocationRows(orderItemId: string): Promise<Row[]> {
    return (await db().query(`select a.kind, a.quantity, a.remaining_quantity, e.event_type, e.reason, m.delta, m.reason as movement_reason,
        op.operation, op.cause_type, op.cause_id, op.actor_id
      from public.order_item_allocations a join public.order_item_allocation_events e on e.allocation_id = a.id
      left join public.stock_movements m on m.id = e.stock_movement_id
      join private.group_g_operations op on op.id = e.operation_id
      where a.order_item_id = $1 order by e.created_at, e.sequence, e.event_type`, [orderItemId])).rows;
  }

  async function failure(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try {
      await run();
      return null;
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code, message: e.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  test('paid は A・未入金は H。数は1組の operation / purchase(-n) / 割当 / event / 状態の履歴で、保存則を保つ', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const paid = await order(fx, 2);
    const unpaid = await order(fx, 1, 'pending');

    const a = await seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity: 2, kind: 'paid' });
    const h = await seedGroupG1Allocation(db(), { orderItemId: unpaid.itemId, quantity: 1, kind: 'payment_hold' });

    expect(a).toEqual(expect.any(String));
    expect(h).toEqual(expect.any(String));
    expect(await allocationRows(paid.itemId)).toEqual([{ kind: 'paid', quantity: 2, remaining_quantity: 2, event_type: 'allocate',
      reason: 'fixture_allocation', delta: -2, movement_reason: 'purchase', operation: 'fixture_allocation', cause_type: 'order_item',
      cause_id: paid.itemId, actor_id: null }]);
    expect(await allocationRows(unpaid.itemId)).toEqual([{ kind: 'payment_hold', quantity: 1, remaining_quantity: 1, event_type: 'hold',
      reason: 'fixture_allocation', delta: -1, movement_reason: 'purchase', operation: 'fixture_allocation', cause_type: 'order_item',
      cause_id: unpaid.itemId, actor_id: null }]);
    expect(await inventory(fx.variantId)).toMatchObject({ free: 2, paid_allocated: 2, payment_held: 1, on_hand: 5 });
    const history = (await db().query(`select from_status, to_status, unit_to - unit_from as n, reason from public.order_item_state_events
      where order_item_id = $1`, [paid.itemId])).rows;
    expect(history).toEqual([{ from_status: 'in_production', to_status: 'ready', n: 2, reason: 'fixture_allocation' }]);
    await integrity(fx.variantId);
  });

  test('数0は何も作らず null、色・サイズの無い行・負や小数の数は断る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const paid = await order(fx, 1);
    const counts = async () => (await db().query(`select (select count(*)::int from public.order_item_allocations where order_item_id=$1) as a,
      (select count(*)::int from public.stock_movements where variant_id=$2) as m,
      (select count(*)::int from private.group_g_operations where cause_id=$1::text) as op`, [paid.itemId, fx.variantId])).rows[0];
    const before = await counts();
    expect(await seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity: 0, kind: 'paid' })).toBeNull();
    expect(await counts()).toEqual(before);
    for (const quantity of [-1, 1.5]) {
      expect(await failure(() => seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity, kind: 'paid' })))
        .toEqual({ code: undefined, message: 'GROUP_G_ARGUMENT_INVALID' });
    }
    const nullVariant = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: fx.itemId, variantId: null, quantity: 1,
      fulfillmentType: 'stock', reserved: false }] });
    expect(await failure(() => seedGroupG1Allocation(db(), { orderItemId: nullVariant.orderItemIds[0], quantity: 1, kind: 'paid' })))
      .toEqual({ code: undefined, message: 'GROUP_G_ARGUMENT_INVALID' });
    expect(await counts()).toEqual(before);
  });

  test('割当の履歴の理由は決まった値だけ（管理者のメモのような文は CHECK が断る）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const paid = await order(fx, 1);
    const allocation = await seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity: 1, kind: 'paid' });
    const op = (await db().query('select operation_id from public.order_item_allocations where id = $1', [allocation])).rows[0].operation_id;
    expect(await failure(() => db().query(`insert into public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, reason) values ($1, 'consume', 1, $2, 9, '棚卸で数え直した')`,
    [allocation, op]))).toEqual({ code: '23514', message: expect.stringContaining('order_item_allocation_events_reason_check') });
  });

  test('有効な発送は A を消費して発送・明細・consume・状態の履歴を作り、在庫と台帳は動かさない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const paid = await order(fx, 3);
    await seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity: 3, kind: 'paid' });
    const movements = Number((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n);

    const fulfillmentId = await seedGroupG1Shipment(db(), { orderId: paid.orderId, lines: [{ orderItemId: paid.itemId, quantity: 2 }],
      shippedAt: '2026-10-20T01:00:00.000Z', actorId: actor });

    const f = (await db().query(`select number, shipping_carrier, tracking_number ~ '^G1-[0-9a-f]{32}$' as tracking_ok, notify_customer,
      cancelled_at, delivered_at, created_by, delivery_status, shipped_at from public.order_fulfillments where id = $1`, [fulfillmentId])).rows[0];
    expect(f).toMatchObject({ number: 1, shipping_carrier: 'yamato', tracking_ok: true, notify_customer: false, cancelled_at: null,
      delivered_at: null, created_by: actor, delivery_status: 'confirmed' });
    expect(new Date(f.shipped_at).toISOString()).toBe('2026-10-20T01:00:00.000Z');
    expect((await db().query('select order_item_id, quantity from public.order_fulfillment_lines where fulfillment_id=$1', [fulfillmentId])).rows)
      .toEqual([{ order_item_id: paid.itemId, quantity: 2 }]);
    const consume = (await allocationRows(paid.itemId)).filter((r) => r.event_type === 'consume');
    expect(consume).toEqual([expect.objectContaining({ remaining_quantity: 1, reason: 'fixture_shipment', delta: null,
      operation: 'fixture_shipment', cause_type: 'order', cause_id: paid.orderId, actor_id: actor })]);
    expect(await inventory(fx.variantId)).toMatchObject({ free: 0, paid_allocated: 1, payment_held: 0, on_hand: 1 });
    expect(Number((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n)).toBe(movements);
    const states = (await db().query('select status, quantity from public.list_admin_order_item_states($1) order by status', [[paid.orderId]])).rows;
    expect(states).toEqual([{ status: 'ready', quantity: 1 }, { status: 'shipped', quantity: 2 }]);
    await integrity(fx.variantId);
  });

  test('cancelledAt の発送は取り消した行だけで、A・F・台帳・割当の履歴は0件の変化。後の有効な発送はその A を使える', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const paid = await order(fx, 2);
    await seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity: 2, kind: 'paid' });
    const before = { inventory: await inventory(fx.variantId), events: (await allocationRows(paid.itemId)).length,
      movements: Number((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n),
      states: Number((await db().query('select count(*)::int as n from public.order_item_state_events where order_item_id=$1', [paid.itemId])).rows[0].n) };

    const cancelled = await seedGroupG1Shipment(db(), { orderId: paid.orderId, lines: [{ orderItemId: paid.itemId, quantity: 2 }],
      shippedAt: '2026-10-20T01:00:00.000Z', cancelledAt: '2026-10-20T02:00:00.000Z', actorId: actor });

    expect((await db().query('select cancelled_at is not null as cancelled, cancelled_by from public.order_fulfillments where id=$1', [cancelled])).rows)
      .toEqual([{ cancelled: true, cancelled_by: actor }]);
    expect(await inventory(fx.variantId)).toEqual(before.inventory);
    expect((await allocationRows(paid.itemId)).length).toBe(before.events);
    expect(Number((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n)).toBe(before.movements);
    expect(Number((await db().query('select count(*)::int as n from public.order_item_state_events where order_item_id=$1', [paid.itemId])).rows[0].n)).toBe(before.states);
    expect((await db().query(`select count(*)::int as n from public.order_item_allocation_events where event_type = 'restore'
      and allocation_id in (select id from public.order_item_allocations where order_item_id = $1)`, [paid.itemId])).rows[0].n).toBe(0);

    const live = await seedGroupG1Shipment(db(), { orderId: paid.orderId, lines: [{ orderItemId: paid.itemId, quantity: 2 }],
      shippedAt: '2026-10-21T01:00:00.000Z' });
    expect((await db().query('select number from public.order_fulfillments where id=$1', [live])).rows[0].number).toBe(2);
    expect(await inventory(fx.variantId)).toMatchObject({ free: 0, paid_allocated: 0, on_hand: 0 });
    await integrity(fx.variantId);
  });

  test('deliveredAt と cancelledAt の同時指定・不正な日時・A の不足は材料の失敗で、2回目の purchase で補わない', async () => {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const paid = await order(fx, 2);
    await seedGroupG1Allocation(db(), { orderItemId: paid.itemId, quantity: 1, kind: 'paid' });
    const ledger = Number((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n);
    const line = [{ orderItemId: paid.itemId, quantity: 1 }];
    expect(await failure(() => seedGroupG1Shipment(db(), { orderId: paid.orderId, lines: line, shippedAt: '2026-10-20T01:00:00Z',
      deliveredAt: '2026-10-21T01:00:00Z', cancelledAt: '2026-10-21T02:00:00Z' }))).toEqual({ code: undefined, message: 'GROUP_G_ARGUMENT_INVALID' });
    expect(await failure(() => seedGroupG1Shipment(db(), { orderId: paid.orderId, lines: line, shippedAt: 'not a date' })))
      .toEqual({ code: undefined, message: 'GROUP_G_ARGUMENT_INVALID' });
    expect(await failure(() => seedGroupG1Shipment(db(), { orderId: paid.orderId, lines: [{ orderItemId: paid.itemId, quantity: 2 }],
      shippedAt: '2026-10-20T01:00:00Z' }))).toEqual({ code: undefined, message: 'GROUP_G_FIXTURE_ALLOCATION_REQUIRED' });
    expect(Number((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n)).toBe(ledger);
    expect((await db().query('select count(*)::int as n from public.order_fulfillments where order_id=$1', [paid.orderId])).rows[0].n).toBe(0);
    await integrity(fx.variantId);
  });

  test('入荷は本物の在庫の入口を通り、最古の待ち注文へ FIFO で割り当てる。同じキーの再送は同じ番号で増分0', async () => {
    const fx = await createCatalogFixture(db(), { stock: 0 });
    const older = await order(fx, 1, 'paid', '2026-01-01T00:00:00Z');
    const newer = await order(fx, 1, 'paid', '2026-02-01T00:00:00Z');
    const requestKey = randomUUID();

    const movementId = await seedGroupG1Restock(db(), { itemId: fx.itemId, variantId: fx.variantId, quantity: 1, actorId: actor, requestKey });

    expect(movementId).toMatch(/^[1-9][0-9]*$/);
    expect((await db().query('select reason, delta, note from public.stock_movements where id = $1', [movementId])).rows)
      .toEqual([{ reason: 'restock', delta: 1, note: 'E2E fixture restock' }]);
    expect((await allocationRows(older.itemId)).map((r) => [r.event_type, r.reason, r.operation])).toEqual([['allocate', 'fifo', 'stock_move']]);
    expect(await allocationRows(newer.itemId)).toEqual([]);
    const ledger = (await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n;
    expect(await seedGroupG1Restock(db(), { itemId: fx.itemId, variantId: fx.variantId, quantity: 1, actorId: actor, requestKey })).toBe(movementId);
    expect((await db().query('select count(*)::int as n from public.stock_movements where variant_id=$1', [fx.variantId])).rows[0].n).toBe(ledger);
    expect(await inventory(fx.variantId)).toMatchObject({ free: 0, paid_allocated: 1, on_hand: 1 });
    await integrity(fx.variantId);
  });

  test('呼び手の取引が共通の押さえを持たなければ、行に触る前に断る。localhost 以外の接続は使わない', async () => {
    const fresh = await connectLocalDb();
    try {
      await fresh.query('begin');
      await expect(withGroupG1FixtureTransaction(fresh, async () => 'never')).rejects.toThrow('GROUP_G_INVENTORY_LOCK_REQUIRED');
      expect((await fresh.query(`select count(*)::int as n from pg_locks where pid = pg_backend_pid() and locktype = 'relation'
        and relation in ('public.orders'::regclass, 'public.order_items'::regclass, 'public.item_variants'::regclass)`)).rows[0].n).toBe(0);
      await fresh.query('rollback');
    } finally {
      await fresh.end();
    }
    const remote = { host: 'db.example.com', query: async () => ({ rows: [], rowCount: 0 }), end: async () => undefined } as unknown as PgClient;
    await expect(withGroupG1FixtureTransaction(remote, async () => 'never')).rejects.toThrow('GROUP_G_FIXTURE_LOCAL_DB_REQUIRED');
  });
});

describeLocalDb('G-1 Task 16: material transactions (own connections)', (db) => {
  async function counts(c: PgClient, orderIds: string[]): Promise<Row> {
    return (await c.query(`select
      (select count(*)::int from public.orders where id = any($1::uuid[])) as orders,
      (select count(*)::int from public.order_items where order_id = any($1::uuid[])) as items,
      (select count(*)::int from public.order_item_allocations a join public.order_items oi on oi.id = a.order_item_id
        where oi.order_id = any($1::uuid[])) as allocations,
      (select count(*)::int from public.order_item_allocation_events e join public.order_item_allocations a on a.id = e.allocation_id
        join public.order_items oi on oi.id = a.order_item_id where oi.order_id = any($1::uuid[])) as events,
      (select count(*)::int from public.stock_movements where order_id = any($1::uuid[])) as movements,
      (select count(*)::int from private.group_g_operations op where op.cause_id in
        (select id::text from public.order_items where order_id = any($1::uuid[]))) as operations`, [orderIds])).rows[0];
  }

  test('故障の注入: 注文と明細を作った後・割当の event の直後に失敗すると、材料の取引ごと全部戻る', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    for (const point of ['after_order', 'after_allocation'] as const) {
      const seen: string[] = [];
      await expect(withGroupG1FixtureTransaction(db(), async () => {
        const o = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1,
          fulfillmentType: 'stock', reserved: false }] });
        seen.push(o.orderId);
        if (point === 'after_order') throw new Error('G1_FIXTURE_INJECTED');
        await seedGroupG1Allocation(db(), { orderItemId: o.orderItemIds[0], quantity: 1, kind: 'paid' });
        throw new Error('G1_FIXTURE_INJECTED');
      })).rejects.toThrow('G1_FIXTURE_INJECTED');
      expect(await isInTransaction(db())).toBe(false);
      const other = await connectLocalDb();
      try {
        expect(await counts(other, seen)).toEqual({ orders: 0, items: 0, allocations: 0, events: 0, movements: 0, operations: 0 });
        expect((await other.query('select stock_quantity from public.item_variants where id = $1', [fx.variantId])).rows[0].stock_quantity).toBe(2);
      } finally {
        await other.end();
      }
    }
  });

  test('呼び手の取引の中の材料は SAVEPOINT で、呼び手を COMMIT しない（別の接続から見えない）。失敗は材料の分だけ戻す', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const caller = await connectLocalDb();
    const other = await connectLocalDb();
    try {
      await caller.query('begin');
      await caller.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const o = await insertOrderWithLines(caller, { status: 'paid', lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 2,
        fulfillmentType: 'stock', reserved: false }] });
      const allocation = await seedGroupG1Allocation(caller, { orderItemId: o.orderItemIds[0], quantity: 1, kind: 'paid' });
      expect(allocation).toEqual(expect.any(String));
      expect(await isInTransaction(caller)).toBe(true);
      expect(await counts(other, [o.orderId])).toEqual({ orders: 0, items: 0, allocations: 0, events: 0, movements: 0, operations: 0 });
      await expect(seedGroupG1Shipment(caller, { orderId: o.orderId, lines: [{ orderItemId: o.orderItemIds[0], quantity: 2 }],
        shippedAt: '2026-10-20T01:00:00Z' })).rejects.toThrow('GROUP_G_FIXTURE_ALLOCATION_REQUIRED');
      expect(await counts(caller, [o.orderId])).toMatchObject({ orders: 1, items: 1, allocations: 1, events: 1, movements: 1, operations: 1 });
      expect((await caller.query('select count(*)::int as n from public.order_fulfillments where order_id = $1', [o.orderId])).rows[0].n).toBe(0);
      await caller.query('rollback');
      expect(await counts(other, [o.orderId])).toEqual({ orders: 0, items: 0, allocations: 0, events: 0, movements: 0, operations: 0 });
    } finally {
      await caller.query('rollback').catch(() => undefined);
      await Promise.all([caller.end(), other.end()]);
    }
  });
});
