/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import {
  createCatalogFixture,
  createDraft,
  insertOrderWithLines,
  insertOrderWithStockLine,
  movementsOf,
  uniqueSuffix,
  variantStock,
} from './helpers/order-fixtures';

/**
 * G-1 Task 6: order intake creates only H, awaiting keeps H, unpaid release/cancel releases the existing H
 * once (cancel/+n) and hands the units to the oldest waiting orders by FIFO. Payment (H -> A) is Task 7.
 */
jest.setTimeout(30000);

const SESSION_CREATED_AT = '2026-10-24T01:00:00.000Z';

type DraftRef = { draftId: string; checkoutSessionId: string; cartSessionId: string; totalAmount: number };

function place(db: PgClient, draft: DraftRef, options: { shown?: number[]; buyer?: string | null } = {}) {
  return db.query(
    `select order_id, order_status::text as order_status, created, rejection
     from public.place_order_from_checkout_draft(
       _draft_id => $1::uuid, _checkout_session_id => $2::text, _cart_session_id => $3::text,
       _stripe_amount_total => $4::integer, _stripe_amount_discount => 0, _stripe_currency => 'jpy',
       _checkout_session_created_at => $5::timestamptz, _payment_intent_id => null,
       _shown_in_stock_variant_ids => $6::bigint[], _buyer_user_id => $7::uuid)`,
    [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount, SESSION_CREATED_AT,
      options.shown ?? null, options.buyer ?? null],
  );
}

function awaiting(db: PgClient, orderId: string, eventId: string | null = null) {
  return db.query('select updated from public.mark_order_awaiting_payment($1::uuid, $2::text, $3::text)',
    [orderId, `pi_${uniqueSuffix()}`, eventId]);
}

function release(db: PgClient, orderId: string, expected: string, next: string, options: {
  reason?: string; actor?: string | null; cancelReason?: string | null; note?: string | null; event?: string | null;
} = {}) {
  return db.query(
    `select released, status::text as status from public.release_stock_for_unpaid_order(
       $1::uuid, $2::public.order_status, $3::public.order_status, $4::text, $5::uuid, $6::text, $7::text, $8::text, $9::boolean)`,
    [orderId, expected, next, options.reason ?? 'stripe_checkout_expired', options.actor ?? null, options.event ?? null,
      options.cancelReason ?? null, options.note ?? null, null],
  );
}

async function allocationsOf(db: PgClient, orderId: string) {
  return (await db.query(
    `select a.kind, a.quantity, a.remaining_quantity, a.version::int as version
     from public.order_item_allocations a join public.order_items oi on oi.id = a.order_item_id
     where oi.order_id = $1 order by oi.id, a.created_at, a.id`, [orderId],
  )).rows;
}

async function eventsOf(db: PgClient, orderId: string) {
  return (await db.query(
    `select e.event_type, e.quantity, m.reason as movement_reason, m.delta::int as delta, op.operation,
            m.allocation_operation_id = e.operation_id as tagged
     from public.order_item_allocation_events e
     join public.order_item_allocations a on a.id = e.allocation_id
     join public.order_items oi on oi.id = a.order_item_id
     left join public.stock_movements m on m.id = e.stock_movement_id
     left join private.group_g_operations op on op.id = e.operation_id
     where oi.order_id = $1 order by e.created_at, e.event_type`, [orderId],
  )).rows;
}

async function operationsOf(db: PgClient, orderId: string) {
  return (await db.query(
    `select operation, cause_type, result from private.group_g_operations
     where cause_id = $1 order by created_at, operation`, [orderId],
  )).rows;
}

async function statesOf(db: PgClient, orderId: string) {
  return (await db.query(
    'select status, quantity from public.list_admin_order_item_states($1::uuid[]) order by status', [[orderId]],
  )).rows;
}

async function stateEventsOf(db: PgClient, orderId: string) {
  return (await db.query(
    `select e.from_status, e.to_status, e.quantity::int as quantity, e.sequence, op.operation
     from public.order_item_state_events e join public.order_items oi on oi.id = e.order_item_id
     join private.group_g_operations op on op.id = e.operation_id
     where oi.order_id = $1 order by e.created_at, e.sequence, e.unit_from`, [orderId],
  )).rows;
}

async function inventoryOf(db: PgClient, variantId: number) {
  const row = (await db.query('select * from public.list_group_g_variant_inventory($1::bigint[])', [[variantId]])).rows[0];
  return {
    free: Number(row.free), paid: Number(row.paid_allocated), held: Number(row.payment_held),
    onHand: Number(row.on_hand), waiting: Number(row.waiting),
  };
}

async function countOperations(db: PgClient, operation: string) {
  return Number((await db.query('select count(*) as n from private.group_g_operations where operation = $1', [operation])).rows[0].n);
}

async function placedOrder(db: PgClient, stock: number, quantity: number) {
  const fx = await createCatalogFixture(db, { stock });
  const draft = await createDraft(db, { itemId: fx.itemId, quantity });
  const res = await place(db, draft);
  expect(res.rows[0]).toMatchObject({ created: true, rejection: null });
  return { fx, draft, orderId: res.rows[0].order_id as string };
}

describeLocalDb('G-1 checkout: H only at intake', (db) => {
  test('the stock line takes purchase/-n and exactly one H; no A, nothing is ready before payment', async () => {
    const fx = await createCatalogFixture(db(), { stock: 5 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });

    const res = await place(db(), draft, { shown: [fx.variantId] });
    const orderId = res.rows[0].order_id as string;

    expect(res.rows[0]).toEqual({ order_id: orderId, order_status: 'payment_in_progress', created: true, rejection: null });
    expect(await allocationsOf(db(), orderId)).toEqual([{ kind: 'payment_hold', quantity: 2, remaining_quantity: 2, version: 0 }]);
    expect(await eventsOf(db(), orderId)).toEqual([{
      event_type: 'hold', quantity: 2, movement_reason: 'purchase', delta: -2,
      operation: 'place_order_from_checkout_draft', tagged: true,
    }]);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 5, reason: 'restock' }, { delta: -2, reason: 'purchase' }]);
    expect(await inventoryOf(db(), fx.variantId)).toEqual({ free: 3, paid: 0, held: 2, onHand: 5, waiting: 0 });
    expect((await operationsOf(db(), orderId)).map((op) => [op.operation, op.cause_type, op.result])).toEqual([
      ['place_order_from_checkout_draft', 'order', { order_id: orderId, held_quantity: 2 }],
    ]);
    // payment_in_progress is not displayed; the compatible reads show no ready quantity for an unpaid order.
    expect(await statesOf(db(), orderId)).toEqual([]);
    const lines = (await db().query(
      'select fulfillment_type, ready_unshipped, in_production from private.order_line_fulfillment($1)', [orderId],
    )).rows;
    expect(lines).toEqual([{ fulfillment_type: 'stock', ready_unshipped: 0, in_production: 0 }]);
    expect((await db().query("select count(*)::int as n from public.orders where id = $1 and paid_at is null", [orderId])).rows[0].n).toBe(1);
  });

  test('stock is judged on the variant total; a short variant stays backorder with no H and no ledger row', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, lines: [{ quantity: 1 }, { quantity: 2 }] });

    const res = await place(db(), draft);
    const orderId = res.rows[0].order_id as string;

    expect((await db().query('select fulfillment_type from public.order_items where order_id = $1 order by id', [orderId]))
      .rows.map((row) => row.fulfillment_type)).toEqual(['backorder', 'backorder']);
    expect(await allocationsOf(db(), orderId)).toEqual([]);
    expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 2, reason: 'restock' }]);
    expect(await variantStock(db(), fx.variantId)).toBe(2);
  });

  test('rejections (shown stock, retired variant, owner) keep the original class and write no H, ledger or operation', async () => {
    const short = await createCatalogFixture(db(), { stock: 1 });
    const shortDraft = await createDraft(db(), { itemId: short.itemId, quantity: 2 });
    const retired = await createCatalogFixture(db(), { stock: 5, isActive: false });
    const retiredDraft = await createDraft(db(), { itemId: retired.itemId, quantity: 1 });
    const owned = await createCatalogFixture(db(), { stock: 5 });
    const ownedDraft = await createDraft(db(), { itemId: owned.itemId, quantity: 1, buyerUserId: randomUUID() });
    const before = await countOperations(db(), 'place_order_from_checkout_draft');

    expect((await place(db(), shortDraft, { shown: [short.variantId] })).rows[0])
      .toEqual({ order_id: null, order_status: null, created: false, rejection: 'stock_changed' });
    expect((await place(db(), retiredDraft, { shown: [] })).rows[0])
      .toEqual({ order_id: null, order_status: null, created: false, rejection: 'item_unavailable' });
    expect((await place(db(), ownedDraft, { shown: [owned.variantId], buyer: randomUUID() })).rows[0])
      .toEqual({ order_id: null, order_status: null, created: false, rejection: 'login_changed' });

    expect(await countOperations(db(), 'place_order_from_checkout_draft')).toBe(before);
    for (const fx of [short, retired, owned]) {
      expect((await movementsOf(db(), fx.variantId)).filter((m) => m.reason !== 'restock')).toEqual([]);
      expect(await inventoryOf(db(), fx.variantId)).toMatchObject({ held: 0, paid: 0 });
    }
  });

  test('awaiting payment keeps the H and shows the unpaid quantity once', async () => {
    const { fx, orderId } = await placedOrder(db(), 3, 2);

    expect((await awaiting(db(), orderId, `evt_${uniqueSuffix()}`)).rows[0].updated).toBe(true);
    expect((await awaiting(db(), orderId)).rows[0].updated).toBe(false);

    expect(await allocationsOf(db(), orderId)).toEqual([{ kind: 'payment_hold', quantity: 2, remaining_quantity: 2, version: 0 }]);
    expect(await statesOf(db(), orderId)).toEqual([{ status: 'unpaid', quantity: 2 }]);
    expect(await stateEventsOf(db(), orderId)).toEqual([
      { from_status: null, to_status: 'unpaid', quantity: 2, sequence: 1, operation: 'mark_order_awaiting_payment' },
    ]);
    expect((await operationsOf(db(), orderId)).map((op) => op.operation))
      .toEqual(['place_order_from_checkout_draft', 'mark_order_awaiting_payment']);
    expect(await inventoryOf(db(), fx.variantId)).toEqual({ free: 1, paid: 0, held: 2, onHand: 3, waiting: 0 });
  });
});

describeLocalDb('G-1 checkout: unpaid release', (db) => {
  let actor: string;

  beforeAll(async () => {
    actor = (await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
      [`g1-checkout-${uniqueSuffix()}@example.com`],
    )).rows[0].id as string;
  });

  test.each([
    ['payment_in_progress', 'abandoned', 'stripe_checkout_expired', []],
    ['pending', 'failed', 'stripe_voucher_expired', [{ status: 'payment_expired', quantity: 2 }]],
    ['pending', 'cancelled', 'admin_cancel', [{ status: 'cancelled', quantity: 2 }]],
  ])('%s -> %s releases the H once (cancel/+n) and a replay adds nothing', async (expected, next, reason, states) => {
    const { fx, orderId } = await placedOrder(db(), 3, 2);
    if (expected === 'pending') await awaiting(db(), orderId);
    const cancel = next === 'cancelled' ? { actor, cancelReason: 'customer_request' } : {};

    expect((await release(db(), orderId, expected, next, { reason, ...cancel })).rows[0]).toEqual({ released: true, status: next });
    const replay = await release(db(), orderId, expected, next, { reason, ...cancel });
    expect(replay.rows[0]).toEqual({ released: false, status: next });

    expect(await allocationsOf(db(), orderId)).toEqual([{ kind: 'payment_hold', quantity: 2, remaining_quantity: 0, version: 1 }]);
    expect((await eventsOf(db(), orderId)).map((e) => [e.event_type, e.quantity, e.movement_reason, e.delta, e.operation, e.tagged]))
      .toEqual([
        ['hold', 2, 'purchase', -2, 'place_order_from_checkout_draft', true],
        ['release', 2, 'cancel', 2, 'release_stock_for_unpaid_order', true],
      ]);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 3, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 2, reason: 'cancel' },
    ]);
    expect(await inventoryOf(db(), fx.variantId)).toEqual({ free: 3, paid: 0, held: 0, onHand: 3, waiting: 0 });
    const releases = (await operationsOf(db(), orderId)).filter((op) => op.operation === 'release_stock_for_unpaid_order');
    expect(releases.map((op) => op.result)).toEqual([
      { order_id: orderId, status: next, released_quantity: 2, allocated_quantity: 0 },
    ]);
    expect(await statesOf(db(), orderId)).toEqual(states);
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id = $1', [fx.variantId])).rows).toEqual([]);
  });

  test('released units go to the oldest waiting order of the same variant by FIFO, in the same operation', async () => {
    const fx = await createCatalogFixture(db(), { stock: 2 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 2 });
    const placed = await place(db(), draft);
    const orderId = placed.rows[0].order_id as string;
    const line = { itemId: fx.itemId, variantId: fx.variantId, quantity: 2, fulfillmentType: 'backorder' as const };
    const newer = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-02-01T00:00:00Z', lines: [line] });
    const older = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-01-01T00:00:00Z', lines: [line] });
    expect(await statesOf(db(), older.orderId)).toEqual([{ status: 'in_production', quantity: 2 }]);

    expect((await release(db(), orderId, 'payment_in_progress', 'abandoned')).rows[0]).toEqual({ released: true, status: 'abandoned' });

    expect(await allocationsOf(db(), older.orderId)).toEqual([{ kind: 'paid', quantity: 2, remaining_quantity: 2, version: 0 }]);
    expect(await allocationsOf(db(), newer.orderId)).toEqual([]);
    expect((await eventsOf(db(), older.orderId)).map((e) => [e.event_type, e.movement_reason, e.operation, e.tagged]))
      .toEqual([['allocate', 'purchase', 'release_stock_for_unpaid_order', true]]);
    expect(await statesOf(db(), older.orderId)).toEqual([{ status: 'ready', quantity: 2 }]);
    expect(await stateEventsOf(db(), older.orderId)).toEqual([
      { from_status: 'in_production', to_status: 'ready', quantity: 2, sequence: 2, operation: 'release_stock_for_unpaid_order' },
    ]);
    expect(await stateEventsOf(db(), newer.orderId)).toEqual([]);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 2, reason: 'restock' }, { delta: -2, reason: 'purchase' }, { delta: 2, reason: 'cancel' }, { delta: -2, reason: 'purchase' },
    ]);
    expect(await inventoryOf(db(), fx.variantId)).toEqual({ free: 0, paid: 2, held: 0, onHand: 2, waiting: 2 });
    const releaseOp = (await operationsOf(db(), orderId)).find((op) => op.operation === 'release_stock_for_unpaid_order');
    expect(releaseOp?.result).toEqual({ order_id: orderId, status: 'abandoned', released_quantity: 2, allocated_quantity: 2 });
  });

  test('a backorder-only order releases nothing, but its state change is recorded under the operation', async () => {
    const { fx, orderId } = await placedOrder(db(), 0, 1);
    await awaiting(db(), orderId);

    expect((await release(db(), orderId, 'pending', 'failed', { reason: 'stripe_voucher_expired' })).rows[0])
      .toEqual({ released: true, status: 'failed' });
    expect(await movementsOf(db(), fx.variantId)).toEqual([]);
    expect(await stateEventsOf(db(), orderId)).toEqual([
      { from_status: null, to_status: 'unpaid', quantity: 1, sequence: 1, operation: 'mark_order_awaiting_payment' },
      { from_status: 'unpaid', to_status: 'payment_expired', quantity: 1, sequence: 1, operation: 'release_stock_for_unpaid_order' },
    ]);
  });

  test('admin cancel of a failed order keeps the 6 reasons and note rule, records the state change once', async () => {
    const { fx, orderId } = await placedOrder(db(), 2, 1);
    await awaiting(db(), orderId);
    await release(db(), orderId, 'pending', 'failed', { reason: 'stripe_voucher_expired' });
    const cancelSql = 'select id, status::text as status from public.admin_cancel_failed_order($1::uuid, $2::uuid, $3::text, $4::text)';

    await expect(db().query(cancelSql, [orderId, actor, 'other', '  '])).rejects.toMatchObject({ code: '22023', message: 'CANCEL_NOTE_REQUIRED' });
    await expect(db().query(cancelSql, [orderId, actor, 'unknown', null])).rejects.toMatchObject({ code: '22023', message: 'CANCEL_REASON_REQUIRED' });
    expect((await db().query(cancelSql, [orderId, actor, 'shop_error', null])).rows).toEqual([{ id: orderId, status: 'cancelled' }]);
    expect((await db().query(cancelSql, [orderId, actor, 'shop_error', null])).rows).toEqual([]);

    expect(await statesOf(db(), orderId)).toEqual([{ status: 'cancelled', quantity: 1 }]);
    expect((await stateEventsOf(db(), orderId)).slice(-1)).toEqual([
      { from_status: 'payment_expired', to_status: 'cancelled', quantity: 1, sequence: 1, operation: 'admin_cancel_failed_order' },
    ]);
    expect((await operationsOf(db(), orderId)).filter((op) => op.operation === 'admin_cancel_failed_order')).toHaveLength(1);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 2, reason: 'restock' }, { delta: -1, reason: 'purchase' }, { delta: 1, reason: 'cancel' },
    ]);
    expect((await db().query('select count(*)::int as n from private.order_email_outbox where order_id = $1 and kind = $2',
      [orderId, 'payment_expired'])).rows[0].n).toBe(1);
  });
});

describeLocalDb('G-1 checkout: failed-order cancel leak guard', (db) => {
  test('a failed order still holding H releases it once on cancel and hands it to the oldest waiting order', async () => {
    const actor = (await db().query(
      `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
       values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`,
      [`g1-cancel-leak-${uniqueSuffix()}@example.com`],
    )).rows[0].id as string;
    const fx = await createCatalogFixture(db(), { stock: 1 });
    // Material only: a failed order that kept its H (the normal failure path releases it).
    const leaked = await insertOrderWithStockLine(db(), {
      status: 'failed', itemId: fx.itemId, variantId: fx.variantId, quantity: 1, reserved: true,
    });
    const waiting = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-01-01T00:00:00Z', lines: [
      { itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'backorder' },
    ] });
    const cancelSql = 'select id, status::text as status from public.admin_cancel_failed_order($1::uuid, $2::uuid, $3::text, null)';

    expect((await db().query(cancelSql, [leaked.orderId, actor, 'shop_error'])).rows).toEqual([{ id: leaked.orderId, status: 'cancelled' }]);
    expect((await db().query(cancelSql, [leaked.orderId, actor, 'shop_error'])).rows).toEqual([]);

    expect(await allocationsOf(db(), leaked.orderId)).toEqual([{ kind: 'payment_hold', quantity: 1, remaining_quantity: 0, version: 1 }]);
    expect((await eventsOf(db(), leaked.orderId)).filter((e) => e.event_type === 'release')
      .map((e) => [e.quantity, e.movement_reason, e.delta, e.operation, e.tagged]))
      .toEqual([[1, 'cancel', 1, 'admin_cancel_failed_order', true]]);
    expect(await allocationsOf(db(), waiting.orderId)).toEqual([{ kind: 'paid', quantity: 1, remaining_quantity: 1, version: 0 }]);
    expect(await movementsOf(db(), fx.variantId)).toEqual([
      { delta: 1, reason: 'restock' }, { delta: -1, reason: 'purchase' }, { delta: 1, reason: 'cancel' }, { delta: -1, reason: 'purchase' },
    ]);
    const op = (await operationsOf(db(), leaked.orderId)).filter((o) => o.operation === 'admin_cancel_failed_order');
    expect(op.map((o) => o.result)).toEqual([{ order_id: leaked.orderId, status: 'cancelled', released_quantity: 1, allocated_quantity: 1 }]);
  });
});

describeLocalDb('G-1 checkout: concurrent intake', (db) => {
  async function waitForAdvisory(observer: PgClient, waiter: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = (await observer.query(`select exists(select 1 from pg_catalog.pg_locks where pid=$1::int and locktype='advisory'
        and classid=190521 and objid=1 and objsubid=2 and not granted) as waiting`, [waiter])).rows[0];
      if (r.waiting) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G1_ADVISORY_WAIT_NOT_OBSERVED');
  }

  async function pidOf(c: PgClient) { return (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number; }

  test('the same Session placed twice at once gives one order, one ledger pair and no negative stock', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    try {
      const bPid = await pidOf(b);
      await a.query('begin');
      const first = await place(a, draft);
      const second = place(b, draft);
      void second.catch(() => undefined);
      await waitForAdvisory(db(), bPid);
      await a.query('commit');
      expect((await second).rows[0]).toEqual({ ...first.rows[0], created: false });
      const orderId = first.rows[0].order_id as string;
      expect((await db().query('select count(*)::int as n from public.orders where checkout_session_id = $1', [draft.checkoutSessionId])).rows[0].n).toBe(1);
      expect(await allocationsOf(db(), orderId)).toEqual([{ kind: 'payment_hold', quantity: 1, remaining_quantity: 1, version: 0 }]);
      expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }, { delta: -1, reason: 'purchase' }]);
      expect(await variantStock(db(), fx.variantId)).toBe(0);
    } finally {
      await a.query('rollback').catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
    }
  });

  test('two Sessions for the last unit serialize: one H, the other backorder, stock never negative', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const first = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const second = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    try {
      const bPid = await pidOf(b);
      await a.query('begin');
      const placedA = await place(a, first);
      const pendingB = place(b, second);
      void pendingB.catch(() => undefined);
      await waitForAdvisory(db(), bPid);
      await a.query('commit');
      const placedB = await pendingB;
      expect(placedB.rows[0]).toMatchObject({ created: true, rejection: null });
      expect(await allocationsOf(db(), placedA.rows[0].order_id)).toHaveLength(1);
      expect(await allocationsOf(db(), placedB.rows[0].order_id)).toEqual([]);
      expect((await db().query('select fulfillment_type from public.order_items where order_id = $1', [placedB.rows[0].order_id]))
        .rows).toEqual([{ fulfillment_type: 'backorder' }]);
      expect(await movementsOf(db(), fx.variantId)).toEqual([{ delta: 1, reason: 'restock' }, { delta: -1, reason: 'purchase' }]);
      expect(await variantStock(db(), fx.variantId)).toBe(0);
    } finally {
      await a.query('rollback').catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
    }
  });
});
