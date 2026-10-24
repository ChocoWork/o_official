import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';

type FixtureClient = PgClient & { host?: string };
/** Nesting of this helper is tracked here (per connection), never by node-pg internals or a failing statement. */
const contexts = new WeakMap<PgClient, { depth: number; sequence: number }>();

function assertLocal(client: PgClient): asserts client is FixtureClient {
  if (!['localhost', '127.0.0.1'].includes((client as FixtureClient).host ?? '')) {
    throw new Error('GROUP_G_FIXTURE_LOCAL_DB_REQUIRED');
  }
}

/**
 * Whether the caller already opened a transaction block on this connection. PostgreSQL defines
 * statement_timestamp() = transaction_timestamp() only for the first command of a transaction, so a
 * statement sent after the caller's BEGIN differs, while an autocommit statement does not. Read-only; it does
 * not depend on node-pg internals and never probes with a failing statement. An aborted transaction makes it
 * throw (the caller's state is already broken).
 * Limit (review M8): BEGIN must be its own query. If a caller sent `BEGIN; select ...` in one simple-protocol message,
 * the check statement could start in the same microsecond as the transaction and report false; the suites always
 * send `begin` as a separate query.
 */
export async function isInTransaction(client: PgClient): Promise<boolean> {
  return (await client.query(
    'select pg_catalog.statement_timestamp() <> pg_catalog.transaction_timestamp() as in_transaction',
  )).rows[0].in_transaction as boolean;
}

/** Whether this connection holds the common advisory (190521,1) now. Read-only. */
export async function holdsCommonLock(client: PgClient): Promise<boolean> {
  return (await client.query(`select exists(select 1 from pg_catalog.pg_locks
    where pid=pg_backend_pid() and locktype='advisory' and classid=190521 and objid=1
      and objsubid=2 and mode='ExclusiveLock' and granted) as held`)).rows[0].held as boolean;
}

/**
 * Synthetic data only. Without a caller transaction: BEGIN -> common advisory (before any row lock) -> run -> COMMIT.
 * Inside the caller's transaction: the caller must already hold the common advisory before its first row lock
 * (checked, never taken late here); SAVEPOINT -> run -> RELEASE, and the caller's transaction is never committed.
 * A failure rolls back only this helper's transaction or savepoint. Callers lock the complete existing target set
 * before writing; newly inserted rows are already owned.
 */
export async function withGroupG1FixtureTransaction<T>(client: PgClient, run: () => Promise<T>): Promise<T> {
  return runGroupG1Fixture(client, () => run());
}

/** Same as withGroupG1FixtureTransaction; `owns` tells the body whether this call opened the transaction. */
async function runGroupG1Fixture<T>(client: PgClient, run: (owns: boolean) => Promise<T>): Promise<T> {
  assertLocal(client);
  const prior = contexts.get(client);
  const ownsTransaction = !prior && !(await isInTransaction(client));
  const context = prior ?? { depth: 0, sequence: 0 };
  const savepoint = `g1_fixture_${++context.sequence}`;
  if (ownsTransaction) {
    await client.query('begin');
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  } else {
    if (!prior && !(await holdsCommonLock(client))) throw new Error('GROUP_G_INVENTORY_LOCK_REQUIRED');
    await client.query(`savepoint ${savepoint}`);
  }
  context.depth++;
  contexts.set(client, context);
  try {
    const result = await run(ownsTransaction);
    await client.query(ownsTransaction ? 'commit' : `release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(ownsTransaction ? 'rollback' : `rollback to savepoint ${savepoint}`);
    if (!ownsTransaction) await client.query(`release savepoint ${savepoint}`);
    throw error;
  } finally {
    context.depth--;
    if (!context.depth) contexts.delete(client);
  }
}

/**
 * Test scaffolding that moves orders to a status directly, inside the caller's transaction. It always gives the
 * change reason that J-19 (supabase/pending/harden_order_state_transitions.sql) requires, so suites pass with or
 * without that pending SQL, and restores the previous reason afterwards. Transitions J-19 forbids are refused there
 * as they would be in production; use a real RPC or an allowed transition instead.
 */
export async function setOrderStatusForFixture(
  client: PgClient, orderIds: string[], status: string, extra: { paidAmount?: number } = {},
): Promise<void> {
  assertLocal(client);
  if (!(await isInTransaction(client))) throw new Error('GROUP_G_FIXTURE_TRANSACTION_REQUIRED');
  const previous = (await client.query(
    "select coalesce(pg_catalog.current_setting('app.order_change_reason', true), '') as reason")).rows[0].reason as string;
  await client.query("select pg_catalog.set_config('app.order_change_reason', 'fixture_status_change', true)");
  // A refused update aborts the caller's transaction, so the reason is restored only after success.
  await client.query(
    `update public.orders set status=$2::public.order_status, paid_amount=coalesce($3::integer, paid_amount)
     where id = any($1::uuid[])`, [orderIds, status, extra.paidAmount ?? null]);
  await client.query("select pg_catalog.set_config('app.order_change_reason', $1, true)", [previous]);
}

async function operation(client: PgClient, name: string, causeId: string, input: object, actorId: string | null = null) {
  const id = randomUUID();
  await client.query(`insert into private.group_g_operations
    (id,operation,request_key,fingerprint,cause_type,cause_id,actor_id,result)
    values($1,$2,$3,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($4::jsonb::text,'UTF8')),'hex'),
      case when $2::text='fixture_allocation' then 'order_item' else 'order' end,$5,$6,'{}')`,
  [id, name, randomUUID(), JSON.stringify(input), causeId, actorId]);
  return id;
}

function validQuantity(quantity: number, zero = false) {
  if (!Number.isInteger(quantity) || quantity < (zero ? 0 : 1) || quantity > 2147483647) {
    throw new Error('GROUP_G_ARGUMENT_INVALID');
  }
}

/** Local preparation follows the real stock entry, including its ACL, FIFO and state history. */
export async function seedGroupG1Restock(client: PgClient, input: {
  itemId: number; variantId: number; quantity: number; actorId: string; requestKey: string;
}): Promise<string> {
  assertLocal(client);
  validQuantity(input.quantity);
  return withGroupG1FixtureTransaction(client, async () => {
    const result = (await client.query(`select public.admin_record_stock_movement(
      $1,$2,$3,'restock','E2E fixture restock',$4,$5,NULL) as result`,
    [input.itemId, input.variantId, input.quantity, input.actorId, input.requestKey])).rows[0].result as { movementId?: unknown };
    if (typeof result?.movementId !== 'string' || !/^[1-9][0-9]*$/.test(result.movementId)) {
      throw new Error('GROUP_G_FIXTURE_STOCK_RESULT_INVALID');
    }
    return result.movementId;
  });
}

export async function seedGroupG1Allocation(
  client: PgClient, input: { orderItemId: string; quantity: number; kind: 'payment_hold' | 'paid' },
): Promise<string | null> {
  assertLocal(client);
  validQuantity(input.quantity, true);
  if (!['payment_hold', 'paid'].includes(input.kind)) throw new Error('GROUP_G_ARGUMENT_INVALID');
  if (!input.quantity) return null;
  return runGroupG1Fixture(client, async (standalone) => {
    const item = (await client.query('select order_id,variant_id from public.order_items where id=$1', [input.orderItemId])).rows[0];
    if (!item?.variant_id) throw new Error('GROUP_G_ARGUMENT_INVALID');
    if (standalone) await client.query('select private.lock_group_g_inventory($1,$2)', [[item.variant_id], [item.order_id]]);
    const before = (await client.query('select private.capture_group_g_item_states($1) as states', [[item.order_id]])).rows[0].states;
    const op = await operation(client, 'fixture_allocation', input.orderItemId,
      { operation: 'fixture_allocation', orderItemId: input.orderItemId, quantity: input.quantity, kind: input.kind, actorId: null });
    const movement = (await client.query(`insert into public.stock_movements
      (variant_id,delta,reason,order_id,order_item_id,allocation_operation_id)
      values($1,$2,'purchase',$3,$4,$5) returning id`, [item.variant_id, -input.quantity, item.order_id, input.orderItemId, op])).rows[0].id;
    const allocation = (await client.query(`insert into public.order_item_allocations
      (order_item_id,variant_id,quantity,remaining_quantity,kind,operation_id)
      values($1,$2,$3,$3,$4,$5) returning id`, [input.orderItemId, item.variant_id, input.quantity, input.kind, op])).rows[0].id as string;
    await client.query(`insert into public.order_item_allocation_events
      (allocation_id,event_type,quantity,operation_id,sequence,stock_movement_id,reason)
      values($1,$2,$3,$4,1,$5,'fixture_allocation')`, [allocation, input.kind === 'paid' ? 'allocate' : 'hold', input.quantity, op, movement]);
    await client.query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)',
      [JSON.stringify(before), [item.order_id], op, 'fixture_allocation', null]);
    return allocation;
  });
}

export async function seedGroupG1Shipment(client: PgClient, input: {
  orderId: string;
  lines: { orderItemId: string; quantity: number }[];
  shippedAt: string;
  deliveredAt?: string;
  cancelledAt?: string;
  actorId?: string;
  carrier?: 'yamato' | 'sagawa' | 'japanpost';
  trackingNumber?: string;
  notifyCustomer?: boolean;
  requestKey?: string;
  /** Legacy shipping material copies the order on its last unit; synthetic shipments default to false. */
  completesOrder?: boolean;
}): Promise<string> {
  assertLocal(client);
  if (!input.lines.length || (input.deliveredAt && input.cancelledAt)
    || [input.shippedAt, input.deliveredAt, input.cancelledAt].some((date) => date !== undefined && !Number.isFinite(Date.parse(date)))
    || new Set(input.lines.map((l) => l.orderItemId)).size !== input.lines.length) throw new Error('GROUP_G_ARGUMENT_INVALID');
  for (const line of input.lines) validQuantity(line.quantity);
  return runGroupG1Fixture(client, async (standalone) => {
    if (standalone) await client.query('select private.lock_group_g_inventory($1,$2)', [[], [input.orderId]]);
    const before = (await client.query('select private.capture_group_g_item_states($1) as states', [[input.orderId]])).rows[0].states;
    const lines = [...input.lines].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
    const op = input.cancelledAt ? null : await operation(client, 'fixture_shipment', input.orderId,
      { ...input, lines, actorId: input.actorId ?? null }, input.actorId ?? null);
    let sequence = 0;
    for (const line of lines) {
      const item = (await client.query('select order_id from public.order_items where id=$1', [line.orderItemId])).rows[0];
      if (item?.order_id !== input.orderId) throw new Error('GROUP_G_ARGUMENT_INVALID');
      if (input.cancelledAt) continue;
      const allocations = (await client.query(`select id,remaining_quantity from public.order_item_allocations
        where order_item_id=$1 and kind='paid' and remaining_quantity>0 order by id`, [line.orderItemId])).rows;
      if (allocations.reduce((sum, a) => sum + a.remaining_quantity, 0) < line.quantity) throw new Error('GROUP_G_FIXTURE_ALLOCATION_REQUIRED');
      let remaining = line.quantity;
      for (const a of allocations) {
        if (!remaining) break;
        const n = Math.min(remaining, a.remaining_quantity);
        await client.query(`update public.order_item_allocations
          set remaining_quantity=remaining_quantity-$2,version=version+1,updated_at=now() where id=$1`, [a.id, n]);
        await client.query(`insert into public.order_item_allocation_events
          (allocation_id,event_type,quantity,operation_id,sequence,reason,actor_id)
          values($1,'consume',$2,$3,$4,'fixture_shipment',$5)`, [a.id, n, op, ++sequence, input.actorId ?? null]);
        remaining -= n;
      }
    }
    const f = (await client.query(`insert into public.order_fulfillments
      (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,
       shipped_at,delivered_at,cancelled_at,cancelled_by,created_by,delivery_status,delivery_status_at)
      values($1,(select coalesce(max(number),0)+1 from public.order_fulfillments where order_id=$2),$3,$4,$5,$6,$14,
        $7,$8,$9,$10,$11,$12,$13) returning id`, [input.orderId, input.orderId, input.requestKey ?? randomUUID(),
      input.carrier ?? 'yamato', input.trackingNumber ?? `G1-${randomUUID().replaceAll('-', '')}`, input.notifyCustomer ?? false,
      input.shippedAt, input.deliveredAt ?? null, input.cancelledAt ?? null, input.cancelledAt ? input.actorId ?? null : null,
      input.actorId ?? null, input.deliveredAt ? 'delivered' : 'confirmed', input.deliveredAt ?? input.shippedAt,
      input.completesOrder ?? false])).rows[0].id as string;
    for (const line of lines) await client.query(`insert into public.order_fulfillment_lines
      (fulfillment_id,order_item_id,quantity) values($1,$2,$3)`, [f, line.orderItemId, line.quantity]);
    if (op) await client.query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)',
      [JSON.stringify(before), [input.orderId], op, 'fixture_shipment', input.actorId ?? null]);
    return f;
  });
}
