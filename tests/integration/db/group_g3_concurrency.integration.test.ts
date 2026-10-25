/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft, insertOrderWithLines } from './helpers/order-fixtures';
import { seedGroupG1Allocation, setOrderStatusForFixture, withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';
import { setGroupG3PaidAt } from './helpers/group-g3-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { leaseDeliveryRegistration, patchDeliveryRegistration, type DeliveryLease } from './helpers/delivery-tracking-fixtures';

/**
 * Committed fresh material per scenario; all observations are scoped to its IDs (settings to id=1).
 * No worker, provider, mail or clock sleeps. pg_blocking_pids AND the ungranted common advisory
 * in pg_locks must be observed while the contender is still waiting, before any blocker is released.
 * This file is independent of the assertions / PostgREST commit and can be committed separately.
 */
jest.setTimeout(120000);
type Op = (client: PgClient) => ReturnType<PgClient['query']>;
type Rows = Awaited<ReturnType<PgClient['query']>>['rows'];
type Outcome = { ok: true; rows: Rows } | { ok: false; code?: string; message?: string };
type Catalog = Awaited<ReturnType<typeof createCatalogFixture>>;
type Ready = Catalog & { orderId: string; orderItemId: string; allocationId?: string | null };
type Slip = { id: string; version: number };
type Confirmed = Slip & { fulfillments: Array<{ orderId: string; fulfillmentId: string }> };
const quantityError = { code: '22023', message: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' };

describeLocalDb('G-3 Task 10: all shipping writers and interacting G-1/G-2 entries', (db) => {
  const flow = createPurchaseFlow(db);
  const committed = <T>(run: () => Promise<T>) => withGroupG1FixtureTransaction(db(), run);
  const connections: PgClient[] = [];
  let priorTracking: { enabled: boolean; at: unknown; by: unknown } | undefined;

  async function client() {
    const c = await connectLocalDb();
    connections.push(c);
    await c.query("set statement_timeout='20s'");
    return c;
  }
  afterEach(async () => {
    // Gate first, then contenders: even a failed assertion releases their blockers before closing.
    for (const c of connections.splice(0)) {
      await c.query('rollback').catch(() => undefined);
      await c.end().catch(() => undefined);
    }
    await db().query('rollback');
    if (priorTracking) {
      const prior = priorTracking;
      await committed(async () => {
        await db().query("select set_config('app.delivery_tracking_setting','toggle',true)");
        await db().query(`update public.shop_settings set delivery_tracking_enabled=$1,
          delivery_tracking_updated_at=$2,delivery_tracking_updated_by=$3 where id=1`, [prior.enabled, prior.at, prior.by]);
      });
      priorTracking = undefined;
    }
  });
  const pid = async (c: PgClient) => Number((await c.query('select pg_backend_pid() as pid')).rows[0].pid);
  async function waitBlocked(waiter: number, blockers: number[]) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const row = (await db().query(`select
        exists(select 1 from unnest(pg_catalog.pg_blocking_pids($1::int)) b(pid) where b.pid=any($2::int[])) as blocked,
        exists(select 1 from pg_catalog.pg_locks where pid=$1 and locktype='advisory'
          and classid=190521 and objid=1 and objsubid=2 and mode='ExclusiveLock' and not granted) as advisory`, [waiter, blockers])).rows[0];
      if (row.blocked && row.advisory) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G3_ADVISORY_WAIT_NOT_OBSERVED');
  }
  /** Capture only error identifiers, recovering expected errors with SAVEPOINT. */
  async function invoke(c: PgClient, op: Op): Promise<Outcome> {
    await c.query('savepoint g3_operation');
    try {
      const result = await op(c);
      await c.query('release savepoint g3_operation');
      return { ok: true, rows: result.rows };
    } catch (caught) {
      const e = caught as { code?: string; message?: string };
      await c.query('rollback to savepoint g3_operation');
      await c.query('release savepoint g3_operation');
      return { ok: false, code: e.code, message: /^[A-Z_]+$/.test(e.message ?? '') ? e.message : 'DATABASE_ERROR' };
    }
  }
  async function finish(c: PgClient, outcome: Outcome) {
    if (outcome.ok) {
      await c.query('set constraints all immediate');
      await c.query('commit');
    } else await c.query('rollback');
  }
  const resultOf = (o: Outcome) => o.ok ? 'ok' : { code: o.code, message: o.message };
  const noDeadlock = (...outcomes: Outcome[]) => expect(outcomes.map((o) => o.ok ? 'ok' : o.code)).not.toContain('40P01');
  function successful(o: Outcome): Rows {
    expect(resultOf(o)).toBe('ok');
    if (!o.ok) throw new Error('G3_EXPECTED_SUCCESS');
    return o.rows;
  }

  /** First RPC has run but is uncommitted; second is demonstrably waiting on its common advisory. */
  async function serial(first: Op, second: Op) {
    const a = await client(); const b = await client();
    const [ap, bp] = [await pid(a), await pid(b)];
    await a.query('begin'); await b.query('begin');
    const firstResult = await invoke(a, first);
    successful(firstResult);
    const pending = invoke(b, second);
    await waitBlocked(bp, [ap]);
    await finish(a, firstResult);
    const secondResult = await pending;
    await finish(b, secondResult);
    noDeadlock(firstResult, secondResult);
    return [firstResult, secondResult] as const;
  }

  /** Queue both live contenders behind a gate; also observe the loser waiting on the winner. */
  async function race(first: Op, second: Op) {
    const gate = await client(); const a = await client(); const b = await client();
    const [gp, ap, bp] = [await pid(gate), await pid(a), await pid(b)];
    await gate.query('begin'); await gate.query('select pg_advisory_xact_lock(190521,1)');
    await a.query('begin'); await b.query('begin');
    const pa = invoke(a, first); await waitBlocked(ap, [gp]);
    const pb = invoke(b, second); await waitBlocked(bp, [gp, ap]);
    await gate.query('rollback');
    const aWon = await Promise.race([pa.then(() => true), pb.then(() => false)]);
    const [winner, loser, wc, lc, wp, lp] = aWon ? [pa, pb, a, b, ap, bp] : [pb, pa, b, a, bp, ap];
    await waitBlocked(lp, [wp]);
    await finish(wc, await winner);
    await finish(lc, await loser);
    const outcomes = [await pa, await pb] as const;
    noDeadlock(...outcomes);
    return outcomes;
  }

  async function ready(catalog: Catalog, quantity = 4, allocated = quantity, age = -4): Promise<Ready> {
    const order = await insertOrderWithLines(db(), { status: 'pending', createdAt: `${await flow.today(age)}T00:00:00Z`,
      lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, fulfillmentType: 'stock', reserved: false }] });
    await setGroupG3PaidAt(db(), order.orderId, `${await flow.today(-3)}T00:00:00Z`);
    await setOrderStatusForFixture(db(), [order.orderId], 'paid', { paidAmount: 5000 * quantity });
    const allocationId = allocated ? await seedGroupG1Allocation(db(), { orderItemId: order.orderItemIds[0], quantity: allocated, kind: 'paid' }) : undefined;
    return { ...catalog, orderId: order.orderId, orderItemId: order.orderItemIds[0], allocationId };
  }
  const save = (actor: string, lines: Array<{ orderItemId: string; quantity: number }>, slip?: Slip, key = randomUUID()): Op => (c) => c.query(
    'select public.admin_save_shipment_slip_draft($1,$2,$3::jsonb,$4,$5) as r', [slip?.id ?? null, slip?.version ?? null, JSON.stringify(lines), actor, key]);
  const confirm = (actor: string, slip: Slip, date: string, key = randomUUID(), number: string | null = null): Op => (c) => c.query(
    'select public.admin_confirm_shipment_slip($1,$2,$3,$4,$5::date,true,$6,$7) as r', [slip.id, slip.version, number ? 'yamato' : null, number, date, actor, key]);
  const cancel = (actor: string, slip: Slip): Op => (c) => c.query('select public.admin_cancel_shipment_slip($1,$2,$3,$4) as r', [slip.id, slip.version, actor, randomUUID()]);
  const tracking = (actor: string, slip: Slip): Op => (c) => c.query('select public.admin_update_shipment_slip_tracking($1,$2,\'sagawa\',$3,false,$4,$5) as r',
    [slip.id, slip.version, `G3-${randomUUID().replaceAll('-', '')}`, actor, randomUUID()]);
  const delivered = (actor: string, slip: Slip, date: string): Op => (c) => c.query('select public.admin_mark_shipment_slip_delivered($1,$2,$3::date,false,$4,$5) as r', [slip.id, slip.version, date, actor, randomUUID()]);
  const correctDate = (actor: string, slip: Slip, date: string): Op => (c) => c.query('select public.admin_correct_shipment_date($1,$2,$3::date,\'fixture correction\',$4,$5) as r', [slip.id, slip.version, date, actor, randomUUID()]);
  async function draft(actor: string, orders: Ready[], quantity = 2): Promise<Slip> {
    return (await save(actor, orders.map((o) => ({ orderItemId: o.orderItemId, quantity })))(db())).rows[0].r as Slip;
  }
  async function material(shipped = false, count = 1, quantity = 4, selected = 2) {
    return committed(async () => {
      const actor = await flow.manager();
      const orders: Ready[] = [];
      for (let i = 0; i < count; i++) orders.push(await ready(await createCatalogFixture(db(), { stock: 50 }), quantity));
      let slip = await draft(actor, orders, selected);
      let shipment: Confirmed | undefined;
      if (shipped) {
        shipment = (await confirm(actor, slip, await flow.today(-1))(db())).rows[0].r as Confirmed;
        slip = shipment;
      }
      return { actor, orders, slip, shipment, date: await flow.today(-1), today: await flow.today() };
    });
  }
  async function totals(variantId: number) {
    return (await db().query(`select v.stock_quantity::int as f,
      coalesce(sum(a.remaining_quantity) filter(where a.kind='paid'),0)::int as a,
      coalesce(sum(a.remaining_quantity) filter(where a.kind='payment_hold'),0)::int as h
      from public.item_variants v left join public.order_item_allocations a on a.variant_id=v.id
      where v.id=$1 group by v.id`, [variantId])).rows[0] as { f: number; a: number; h: number };
  }
  const hand = async (id: number) => { const s = await totals(id); return s.f + s.a + s.h; };
  async function sane(orders: Ready[]) {
    for (const o of orders) {
      expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [o.variantId])).rows).toEqual([]);
      expect((await totals(o.variantId)).f).toBeGreaterThanOrEqual(0);
      expect((await db().query(`select count(*)::int as n from public.order_item_allocations where variant_id=$1
        and (remaining_quantity<0 or remaining_quantity>quantity)`, [o.variantId])).rows[0].n).toBe(0);
    }
  }
  const activeShipped = async (itemId: string) => Number((await db().query(`select coalesce(sum(fl.quantity),0)::int as n
    from public.order_fulfillment_lines fl join public.order_fulfillments f on f.id=fl.fulfillment_id
    where fl.order_item_id=$1 and f.cancelled_at is null`, [itemId])).rows[0].n);
  const consumes = async (itemId: string) => Number((await db().query(`select coalesce(sum(e.quantity),0)::int as n
    from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
    where a.order_item_id=$1 and e.event_type='consume'`, [itemId])).rows[0].n);

  // Every operation gets fresh, committed targets including an existing fulfillment for the NOWAIT probe.
  test.each(['save', 'discard', 'confirm', 'cancel', 'tracking', 'delivered', 'date'] as const)(
    'FREQ-540-AC-11: %s waits on advisory before holding any target row lock', async (entry) => {
      const fx = await material(!['save', 'discard', 'confirm'].includes(entry));
      // A previous, distinct shipment makes the fulfillment NOWAIT probe nonempty even for draft operations.
      if (!fx.shipment) await committed(async () => {
        const other = await draft(fx.actor, fx.orders, 1);
        await confirm(fx.actor, other, fx.date)(db());
      });
      const before = await hand(fx.orders[0].variantId);
      const ops: Record<typeof entry, Op> = {
        save: save(fx.actor, [{ orderItemId: fx.orders[0].orderItemId, quantity: 1 }], fx.slip),
        discard: (c) => c.query('select public.admin_discard_shipment_slip_draft($1,$2,$3,$4) as r', [fx.slip.id, fx.slip.version, fx.actor, randomUUID()]),
        confirm: confirm(fx.actor, fx.slip, fx.date), cancel: cancel(fx.actor, fx.slip),
        tracking: tracking(fx.actor, fx.slip), delivered: delivered(fx.actor, fx.slip, fx.today), date: correctDate(fx.actor, fx.slip, fx.today),
      };
      const a = await client(); const b = await client(); const c = await client();
      const [ap, bp] = [await pid(a), await pid(b)];
      await a.query('begin'); await a.query('select pg_advisory_xact_lock(190521,1)');
      await b.query('begin');
      const pending = invoke(b, ops[entry]);
      await waitBlocked(bp, [ap]);
      await c.query('begin');
      const orderIds = fx.orders.map((o) => o.orderId);
      const probes: Array<[string, unknown[]]> = [
        ['select id from public.shipment_slips where id=$1 for update nowait', [fx.slip.id]],
        ['select id from public.orders where id=any($1::uuid[]) for update nowait', [orderIds]],
        ['select id from public.order_items where order_id=any($1::uuid[]) for update nowait', [orderIds]],
        ['select a.id from public.order_item_allocations a join public.order_items oi on oi.id=a.order_item_id where oi.order_id=any($1::uuid[]) for update of a nowait', [orderIds]],
        ['select id from public.item_variants where id=any($1::bigint[]) for update nowait', [fx.orders.map((o) => o.variantId)]],
        ['select id from public.order_fulfillments where order_id=any($1::uuid[]) for update nowait', [orderIds]],
      ];
      for (const [sql, params] of probes) expect((await c.query(sql, params)).rows.length).toBeGreaterThan(0);
      await c.query('rollback'); await a.query('rollback');
      const outcome = await pending; successful(outcome); await finish(b, outcome); noDeadlock(outcome);
      expect(await hand(fx.orders[0].variantId)).toBe(before + (entry === 'confirm' ? -2 : entry === 'cancel' ? 2 : 0));
      expect(await activeShipped(fx.orders[0].orderItemId)).toBe(entry === 'confirm' ? 3 : entry === 'cancel' ? 0 : fx.shipment ? 2 : 1);
      await sane(fx.orders);
    },
  );

  test('FREQ-533-AC-03: overlapping drafts confirm once, consume once, and enqueue one email per order; no deadlock', async () => {
    // 3 of 4 per order in both drafts: the order stays paid after the first confirmation (a fully shipped order would be
    // refused earlier as GROUP_G_SLIP_ORDER_NOT_SHIPPABLE), so the loser meets the shortage of ready quantity (1 left < 3).
    const fx = await material(false, 2, 4, 3);
    const other = await committed(() => draft(fx.actor, fx.orders, 3));
    const outcomes = await race(confirm(fx.actor, fx.slip, fx.date), confirm(fx.actor, other, fx.date));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map(resultOf)).toEqual([quantityError]);
    for (const o of fx.orders) {
      expect(await consumes(o.orderItemId)).toBe(3);
      expect(await activeShipped(o.orderItemId)).toBe(3);
      expect(await hand(o.variantId)).toBe(47);
      expect((await db().query("select count(*)::int as n from private.order_email_outbox where order_id=$1 and kind='shipped'", [o.orderId])).rows[0].n).toBe(1);
    }
    await sane(fx.orders);
  });

  test('FREQ-533-AC-03: simultaneous same-key confirmation returns the same result with exactly one execution', async () => {
    const fx = await material(); const key = randomUUID();
    const outcomes = await race(confirm(fx.actor, fx.slip, fx.date, key), confirm(fx.actor, fx.slip, fx.date, key));
    const results = outcomes.map((o) => successful(o)[0].r);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect({ ...results[0], replayed: false }).toEqual({ ...results[1], replayed: false });
    expect((await db().query('select count(*)::int as n from private.group_g_operations where request_key=$1 and operation=\'shipment_slip_confirm\'', [key])).rows[0].n).toBe(1);
    expect(await consumes(fx.orders[0].orderItemId)).toBe(2);
    expect(await activeShipped(fx.orders[0].orderItemId)).toBe(2);
    expect(await hand(fx.orders[0].variantId)).toBe(48);
    await sane(fx.orders);
  });

  test('FREQ-540-AC-11: reverse order inputs [o1,o2] / [o2,o1] both confirm without deadlock', async () => {
    const fx = await material(false, 2, 4, 2);
    const other = await committed(() => draft(fx.actor, [...fx.orders].reverse(), 2));
    for (const outcome of await race(confirm(fx.actor, fx.slip, fx.date), confirm(fx.actor, other, fx.date))) successful(outcome);
    for (const o of fx.orders) { expect(await consumes(o.orderItemId)).toBe(4); expect(await hand(o.variantId)).toBe(46); }
    await sane(fx.orders);
  });

  const stock = (o: Ready, actor: string, delta: number, expected: number): Op => (c) => c.query(
    'select public.admin_record_stock_movement($1,$2,$3,\'adjustment\',\'fixture count\',$4,$5,$6) as r', [o.itemId, o.variantId, delta, actor, randomUUID(), expected]);
  async function receiptMaterial() {
    return committed(async () => {
      const actor = await flow.manager(); const catalog = await createCatalogFixture(db(), { stock: 0 });
      const order = await ready(catalog, 4, 0);
      const po = await flow.create(actor, [flow.lineOf(catalog.variantId, 4)]);
      const lines = await flow.linesOf(po.id); const version = await flow.confirmQuantities(actor, po.id, lines, [4]);
      const receipt = await flow.receive({ orderId: po.id, version, actor, lines: [{ lineId: lines[0].id, quantity: 4 }] });
      const receiptLine = (await db().query('select id from public.purchase_order_receipt_lines where receipt_id=$1', [receipt.receiptId])).rows[0].id as string;
      return { actor, order, po, receipt, receiptLine, slip: await draft(actor, [order], 4), date: await flow.today() };
    });
  }
  const reverse = (fx: Awaited<ReturnType<typeof receiptMaterial>>, quantity: number): Op => (c) => c.query(
    'select public.admin_reverse_purchase_order_receipt($1,$2,$3,$4::jsonb,\'fixture reversal\',$5,$6,$7) as r',
    [fx.po.id, fx.receipt.version, fx.receipt.receiptId, JSON.stringify([{ receiptLineId: fx.receiptLine, quantity }]), quantity, fx.actor, randomUUID()]);

  test.each(['receipt reversal', 'stock decrease'] as const)('FREQ-533-AC-04: confirmation waits on %s; insufficient ready quantity is rejected and F+A+H is conserved', async (kind) => {
    if (kind === 'receipt reversal') {
      const fx = await receiptMaterial();
      const [removed, shipped] = await serial(reverse(fx, 1), confirm(fx.actor, fx.slip, fx.date));
      successful(removed); expect(resultOf(shipped)).toEqual(quantityError);
      expect(await totals(fx.order.variantId)).toEqual({ f: 0, a: 3, h: 0 });
      expect(await consumes(fx.order.orderItemId)).toBe(0);
      await sane([fx.order]);
    } else {
      const fx = await material(false, 1, 4, 4); const o = fx.orders[0];
      const [removed, shipped] = await serial(stock(o, fx.actor, -47, 1), confirm(fx.actor, fx.slip, fx.date));
      successful(removed); expect(resultOf(shipped)).toEqual(quantityError);
      expect(await totals(o.variantId)).toEqual({ f: 0, a: 3, h: 0 });
      expect(await consumes(o.orderItemId)).toBe(0); await sane(fx.orders);
    }
  });

  test('FREQ-533-AC-04: receipt reversal cannot release the allocation already consumed by a concurrent confirmation', async () => {
    const fx = await receiptMaterial();
    const slip = await committed(() => draft(fx.actor, [fx.order], 2));
    const [shipped, removed] = await serial(confirm(fx.actor, slip, fx.date), reverse(fx, 2));
    successful(shipped); successful(removed);
    expect(await consumes(fx.order.orderItemId)).toBe(2);
    expect(await activeShipped(fx.order.orderItemId)).toBe(2);
    expect(await totals(fx.order.variantId)).toEqual({ f: 0, a: 0, h: 0 });
    const events = (await db().query(`select e.event_type,sum(e.quantity)::int as n from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id where a.order_item_id=$1 and e.event_type in ('consume','release') group by e.event_type order by e.event_type`, [fx.order.orderItemId])).rows;
    expect(events).toEqual([{ event_type: 'consume', n: 2 }, { event_type: 'release', n: 2 }]);
    await sane([fx.order]);
  });

  test('FREQ-533-AC-04: a stock decrease cannot release the allocation already consumed by a concurrent confirmation', async () => {
    const fx = await material(false, 1, 4, 2); const o = fx.orders[0];
    // F 46 + A 4. The confirmation consumes 2 first; the decrease of 47 then takes all of F and only 1 of the 2 unshipped units of A.
    const [shipped, removed] = await serial(confirm(fx.actor, fx.slip, fx.date), stock(o, fx.actor, -47, 1));
    successful(shipped); successful(removed);
    expect(await consumes(o.orderItemId)).toBe(2);
    expect(await activeShipped(o.orderItemId)).toBe(2);
    expect(await totals(o.variantId)).toEqual({ f: 0, a: 1, h: 0 });
    await sane(fx.orders);
  });

  const refund = (actor: string, o: Ready): Op => (c) => c.query(`select refund_id,status,replayed from public.begin_order_refund(
    $1,'admin',$2,$3::jsonb,true,0,5000,'fixture refund',null,null,false,$4,null)`,
  [o.orderId, randomUUID(), JSON.stringify([{ order_item_id: o.orderItemId, quantity: 1, before_shipment: true, restock_type: 'cancel' }]), actor]);

  test.each(['refund first', 'confirm first'] as const)('FREQ-533-AC-04: confirmation / refund begin (%s) exclude pre-shipment refund units consistently', async (order) => {
    const fx = await material(false, 1, 4, 4); const o = fx.orders[0];
    const shipOp = confirm(fx.actor, fx.slip, fx.date); const refundOp = refund(fx.actor, o);
    const outcomes = order === 'refund first' ? await serial(refundOp, shipOp) : await serial(shipOp, refundOp);
    successful(outcomes[0]);
    expect(resultOf(outcomes[1])).toEqual(order === 'refund first' ? quantityError : { code: '22023', message: 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED' });
    expect(await activeShipped(o.orderItemId)).toBe(order === 'refund first' ? 0 : 4);
    expect((await db().query(`select coalesce(sum(l.quantity),0)::int as n from public.order_refund_lines l
      join public.order_refunds r on r.id=l.refund_id where l.order_item_id=$1 and l.before_shipment
      and r.status in ('awaiting_response','pending','succeeded')`, [o.orderItemId])).rows[0].n).toBe(order === 'refund first' ? 1 : 0);
    await sane(fx.orders);
  });

  /**
   * The shop has no return address by default, and the return RPC then refuses with RETURN_ADDRESS_REQUIRED. The settings are set
   * only inside this connection's own transaction, before the RPC, and put back (same transaction) right after it, so that nothing
   * global is committed or left behind even when the return commits. A refusal rolls the whole savepoint back instead.
   */
  const createReturn = (actor: string, o: Ready, fulfillment: string): Op => async (c) => {
    const before = (await c.query(`select requests_enabled,request_types,return_address_name,return_address_postal_code,
      return_address_line,return_address_phone from public.shop_return_settings where id=1 for update`)).rows[0];
    const reason = (await c.query(`select shown,photo,resolutions,out_of_stock_exchange from public.shop_return_reason_settings
      where reason='defective' for update`)).rows[0];
    await c.query(`update public.shop_return_settings set requests_enabled=true,request_types='returns_and_cancellations',
      return_address_name='fixture',return_address_postal_code='1000001',return_address_line='fixture',
      return_address_phone='0312345678' where id=1`);
    await c.query(`update public.shop_return_reason_settings set shown=true,photo='optional',resolutions='refund_and_exchange',
      out_of_stock_exchange='make' where reason='defective'`);
    const result = await c.query(`select return_id,status,replayed from public.admin_create_return(
      $1,$2,$3,$4::jsonb,'customer_ships','shop',null,null,0,0,0,0,null,false)`, [o.orderId, actor, randomUUID(), JSON.stringify([
      { fulfillment_id: fulfillment, order_item_id: o.orderItemId, quantity: 1, reason: 'defective', reason_note: null,
        resolution: 'refund', exchange_variant_id: null, exchange_method: null },
    ])]);
    await c.query(`update public.shop_return_settings set requests_enabled=$1,request_types=$2,return_address_name=$3,
      return_address_postal_code=$4,return_address_line=$5,return_address_phone=$6 where id=1`,
    [before.requests_enabled, before.request_types, before.return_address_name, before.return_address_postal_code,
      before.return_address_line, before.return_address_phone]);
    await c.query(`update public.shop_return_reason_settings set shown=$1,photo=$2,resolutions=$3,out_of_stock_exchange=$4
      where reason='defective'`, [reason.shown, reason.photo, reason.resolutions, reason.out_of_stock_exchange]);
    return result;
  };
  test.each(['cancel first', 'return first'] as const)('FREQ-534-AC-03: cancel / return creation (%s) serialize with the required refusal', async (order) => {
    const fx = await material(true); const o = fx.orders[0];
    const cancelOp = cancel(fx.actor, fx.slip); const returnOp = createReturn(fx.actor, o, fx.shipment!.fulfillments[0].fulfillmentId);
    const outcomes = order === 'cancel first' ? await serial(cancelOp, returnOp) : await serial(returnOp, cancelOp);
    successful(outcomes[0]);
    expect(resultOf(outcomes[1])).toEqual(order === 'cancel first' ? { code: '22023', message: 'RETURN_QUANTITY_EXCEEDS' } : { code: '22023', message: 'GROUP_G_SLIP_HAS_RETURN' });
    expect(await activeShipped(o.orderItemId)).toBe(order === 'cancel first' ? 0 : 2);
    expect(await hand(o.variantId)).toBe(order === 'cancel first' ? 50 : 48);
    expect((await db().query('select count(*)::int as n from public.order_returns where order_id=$1', [o.orderId])).rows[0].n).toBe(order === 'cancel first' ? 0 : 1);
    await sane(fx.orders);
  });

  test.each(['payment first', 'confirmation first', 'race'] as const)('FREQ-540-AC-11: confirmation / mark_order_paid FIFO (%s) allocate once in oldest order', async (order) => {
    const fx = await committed(async () => {
      const actor = await flow.manager(); const catalog = await createCatalogFixture(db(), { stock: 6 });
      const old = await ready(catalog, 2, 2, -6);
      const checkout = await createDraft(db(), { itemId: catalog.itemId, quantity: 1 });
      const held = (await db().query(`select order_id from public.place_order_from_checkout_draft($1,$2,$3,$4,0,'jpy',now(),null::text)`,
        [checkout.draftId, checkout.checkoutSessionId, checkout.cartSessionId, checkout.totalAmount])).rows[0].order_id as string;
      const waitingOld = await ready(catalog, 2, 0, -5);
      const newer = await ready(catalog, 2, 0, -2);
      return { actor, old, waitingOld, newer, held, checkout, slip: await draft(actor, [old], 2), date: await flow.today() };
    });
    const pay: Op = (c) => c.query(`select updated,amount_matches from public.mark_order_paid($1,'payment_in_progress',$2,$3,'jpy',true,'order_confirmed',null)`,
      [fx.held, `pi_${randomUUID().replaceAll('-', '')}`, fx.checkout.totalAmount]);
    const ship = confirm(fx.actor, fx.slip, fx.date);
    const outcomes = order === 'race' ? await race(ship, pay) : order === 'payment first' ? await serial(pay, ship) : await serial(ship, pay);
    outcomes.forEach(successful);
    expect(await totals(fx.old.variantId)).toEqual({ f: 0, a: 4, h: 0 });
    expect(await consumes(fx.old.orderItemId)).toBe(2);
    expect(await flow.allocated(fx.waitingOld.orderItemId)).toBe(2);
    expect(await flow.allocated(fx.newer.orderItemId)).toBe(1);
    expect((await db().query(`select a.kind,sum(a.remaining_quantity)::int as n from public.order_item_allocations a
      join public.order_items oi on oi.id=a.order_item_id where oi.order_id=$1 and a.remaining_quantity>0 group by a.kind`, [fx.held])).rows)
      .toEqual([{ kind: 'paid', n: 1 }]);
    await sane([fx.old]);
  });

  async function trackedMaterial() {
    return committed(async () => {
      const actor = await flow.manager();
      priorTracking = (await db().query(`select delivery_tracking_enabled as enabled,delivery_tracking_updated_at as at,
        delivery_tracking_updated_by as by from public.shop_settings where id=1`)).rows[0];
      await db().query("select set_config('app.delivery_tracking_setting','toggle',true)");
      await db().query('update public.shop_settings set delivery_tracking_enabled=true where id=1');
      const o = await ready(await createCatalogFixture(db(), { stock: 50 }));
      const slip = await draft(actor, [o]);
      const shipped = (await confirm(actor, slip, await flow.today(), randomUUID(), `G3-${randomUUID().replaceAll('-', '')}`)(db())).rows[0].r as Confirmed;
      const fid = shipped.fulfillments[0].fulfillmentId;
      await patchDeliveryRegistration(db(), fid, "state='registered',ever_registered=true,registered_at=now()");
      const lease = await leaseDeliveryRegistration(db(), fid);
      return { actor, o, slip: shipped, lease, date: await flow.today() };
    });
  }
  const readResult = (lease: DeliveryLease): Op => (c) => c.query('select * from public.record_delivery_read_result($1,$2,$3,$4::jsonb)',
    [lease.fulfillment_id, lease.tracking_version, lease.lease_token, JSON.stringify({ outcome: 'ok', status: 'in_transit', provider_status: 'InTransit',
      provider_sub_status: null, happened_at: new Date().toISOString(), delivered_at: null, read_at: new Date().toISOString(), error_code: null })]);
  test('FREQ-534-AC-01: tracking correction / old leased read serialize; old result is applied=false without deadlock', async () => {
    const fx = await trackedMaterial();
    const [updated, read] = await serial(tracking(fx.actor, fx.slip), readResult(fx.lease));
    successful(updated);
    expect(successful(read)).toEqual([{ applied: false, changed: false, stopped: false }]);
    expect((await db().query('select tracking_version,delivery_status from public.order_fulfillments where id=$1', [fx.lease.fulfillment_id])).rows)
      .toEqual([{ tracking_version: 2, delivery_status: 'confirmed' }]);
    await sane([fx.o]);
  });

  test.each(['delivered', 'date'] as const)('FREQ-534-AC-03: cancel / %s on the same version have exactly one successful operation', async (action) => {
    const fx = await material(true);
    const peer = action === 'delivered' ? delivered(fx.actor, fx.slip, fx.today) : correctDate(fx.actor, fx.slip, fx.today);
    const outcomes = await race(cancel(fx.actor, fx.slip), peer);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const refused = outcomes.find((o) => !o.ok)!;
    expect(['GROUP_G_SLIP_CANCELLED', 'GROUP_G_SLIP_VERSION_CONFLICT']).toContain(refused.ok ? '' : refused.message);
    const row = (await db().query('select stage,version from public.shipment_slips where id=$1', [fx.slip.id])).rows[0];
    expect(row.version).toBe(3);
    expect(row.stage).toBe(outcomes[0].ok ? 'cancelled' : 'confirmed');
    expect(await activeShipped(fx.orders[0].orderItemId)).toBe(outcomes[0].ok ? 0 : 2);
    expect(await hand(fx.orders[0].variantId)).toBe(outcomes[0].ok ? 50 : 48);
    await sane(fx.orders);
  });

  test('FREQ-540-AC-11: replaced delivery result / confirmation of the same order complete with consistent quantities and no deadlock', async () => {
    const fx = await trackedMaterial();
    const other = await committed(() => draft(fx.actor, [fx.o], 2));
    const outcomes = await race(readResult(fx.lease), confirm(fx.actor, other, fx.date));
    expect(successful(outcomes[0])).toEqual([{ applied: true, changed: true, stopped: false }]);
    successful(outcomes[1]);
    expect(await activeShipped(fx.o.orderItemId)).toBe(4);
    expect(await consumes(fx.o.orderItemId)).toBe(4);
    expect(await hand(fx.o.variantId)).toBe(46);
    expect((await db().query('select delivery_status from public.order_fulfillments where id=$1', [fx.lease.fulfillment_id])).rows[0].delivery_status).toBe('in_transit');
    await sane([fx.o]);
  });
});
