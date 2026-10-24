/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { addItemVariant, createCatalogFixture, createShippedOrderFixture, insertOrderWithLines, insertRefundRecord,
  insertCancelRequest, insertReturnRecord, variantStock } from './helpers/order-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment, withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';

describeLocalDb('G-1 FIFO, ledger and minimal synthetic fixtures', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function order(itemId: number, variantId: number | null, quantity = 2, createdAt = '2026-01-01', status = 'paid', fulfillmentType: 'stock' | 'backorder' = 'stock') {
    const o = await insertOrderWithLines(db(), { status, createdAt,
      lines: [{ itemId, variantId, quantity, fulfillmentType, reserved: false }] });
    return { id: o.orderId, line: o.orderItemIds[0] };
  }

  async function operation(client = db()) {
    const id = randomUUID();
    await client.query(`insert into private.group_g_operations
      (id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values ($1,'fifo_test',$2,repeat('b',64),'test',$3,'{}')`, [id, randomUUID(), id]);
    return id;
  }

  async function allocate(variants: number[], inflow = 0) {
    const orders = (await db().query('select private.lock_group_g_inventory($1,$2) as ids', [variants, []])).rows[0].ids;
    const before = (await db().query('select private.capture_group_g_item_states($1) as states', [orders])).rows[0].states;
    const op = await operation();
    if (inflow) await db().query(`insert into public.stock_movements (variant_id,delta,reason) values ($1,$2,'restock')`, [variants[0], inflow]);
    const count = (await db().query('select private.allocate_group_g_fifo($1,$2,$3) as n', [variants, op, null])).rows[0].n;
    await db().query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)', [JSON.stringify(before), orders, op, 'fifo', null]);
    await flush();
    return { count, op };
  }

  async function flush() {
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  async function totals(variant: number) {
    const row = (await db().query(`select v.stock_quantity as f,
      coalesce(sum(a.remaining_quantity) filter(where a.kind='paid'),0)::int as a,
      coalesce(sum(a.remaining_quantity) filter(where a.kind='payment_hold'),0)::int as h
      from public.item_variants v left join public.order_item_allocations a on a.variant_id=v.id
      where v.id=$1 group by v.id`, [variant])).rows[0];
    return { ...row, onHand: row.f + row.a + row.h };
  }

  async function quantity(line: string) {
    return (await db().query(`select coalesce(sum(remaining_quantity),0)::int as n
      from public.order_item_allocations where order_item_id=$1`, [line])).rows[0].n;
  }

  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try {
      await run();
      await flush();
      return {};
    } catch (e) {
      const error = e as { code?: string; message?: string; detail?: string };
      return { code: error.code, message: error.message, detail: error.detail };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  test('old 2 / new 2 plus receipt 2 allocates 2 / 0 and records the state change atomically', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const old = await order(c.itemId, c.variantId);
    const young = await order(c.itemId, c.variantId, 2, '2026-02-01');
    const { count, op } = await allocate([c.variantId], 2);
    expect(count).toBe(2);
    expect([await quantity(old.line), await quantity(young.line)]).toEqual([2, 0]);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 0, onHand: 2 });
    expect((await db().query(`select from_status,to_status,quantity from public.order_item_state_events where operation_id=$1`, [op])).rows)
      .toEqual([{ from_status: 'in_production', to_status: 'ready', quantity: 2 }]);
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [c.variantId])).rows).toEqual([]);
  });

  test('equal dates use order UUID and then item UUID; duplicate variant input never double allocates', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const one = await order(c.itemId, c.variantId, 1);
    const two = await order(c.itemId, c.variantId, 1);
    const sorted = [one, two].sort((a, b) => a.id.localeCompare(b.id));
    await allocate([c.variantId, c.variantId], 1);
    expect([await quantity(sorted[0].line), await quantity(sorted[1].line)]).toEqual([1, 0]);
    const extra = (await db().query(`insert into public.order_items
      (order_id,item_id,item_name,item_price,quantity,line_total,variant_id,fulfillment_type)
      values ($1,$2,'fifo',5000,1,5000,$3,'backorder') returning id`, [sorted[1].id, c.itemId, c.variantId])).rows[0].id as string;
    const lines = [sorted[1].line, extra].sort();
    await allocate([c.variantId], 1);
    expect([await quantity(lines[0]), await quantity(lines[1])]).toEqual([1, 0]);
    expect((await allocate([c.variantId])).count).toBe(0);
  });

  test('partial allocation leaves the remaining demand, surplus stays F, and inactive variants still participate', async () => {
    const c = await createCatalogFixture(db(), { stock: 0, isActive: false });
    const o = await order(c.itemId, c.variantId, 3, '2026-01-01', 'paid', 'backorder');
    expect((await allocate([c.variantId], 2)).count).toBe(2);
    expect(await quantity(o.line)).toBe(2);
    expect((await allocate([c.variantId], 4)).count).toBe(1);
    expect(await totals(c.variantId)).toEqual({ f: 3, a: 3, h: 0, onHand: 6 });
    expect((await db().query('select fulfillment_type from public.order_items where id=$1', [o.line])).rows[0].fulfillment_type).toBe('backorder');
  });

  test('exchange fee waiting is excluded, then rejoins by the original order date and uses exchange ledger reason', async () => {
    const source = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }], createdAt: '2026-01-01' });
    const target = await addItemVariant(db(), { itemId: source.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 0 });
    const normal = await order(source.itemIds[0], target.variantId, 2, '2026-02-01');
    const ret = await insertReturnRecord(db(), { orderId: source.orderId, feeDueAmount: 500,
      lines: [{ orderItemId: source.orderItemIds[0], fulfillmentId: source.fulfillments[0].id,
        quantity: 1, resolution: 'exchange', exchangeVariantId: target.variantId, exchangeMethod: 'make' }] });
    const exchangeLine = (await db().query(`insert into public.order_items
      (order_id,item_id,item_name,item_price,quantity,line_total,variant_id,fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
      values($1,$2,'exchange',0,1,0,$3,'backorder','exchange',$4,5000) returning id`, [source.orderId, source.itemIds[0], target.variantId, ret.lineIds[0]])).rows[0].id;
    expect((await allocate([target.variantId], 1)).count).toBe(1);
    expect(await quantity(exchangeLine)).toBe(0);
    expect(await quantity(normal.line)).toBe(1);
    await db().query('update public.order_returns set fee_received_at=now(),fee_received_by=$2 where id=$1', [ret.returnId, randomUUID()]);
    const { count, op } = await allocate([target.variantId], 1);
    expect(count).toBe(1);
    expect(await quantity(exchangeLine)).toBe(1);
    expect(await quantity(normal.line)).toBe(1);
    expect((await db().query('select reason,delta,order_item_id from public.stock_movements where allocation_operation_id=$1', [op])).rows)
      .toEqual([{ reason: 'exchange', delta: -1, order_item_id: exchangeLine }]);
  });

  test('H to A preserves F and on hand and the older waiting order cannot take that reservation', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const old = await order(c.itemId, c.variantId);
    const buyer = await order(c.itemId, c.variantId, 2, '2026-02-01', 'pending');
    const a = await seedGroupG1Allocation(db(), { orderItemId: buyer.line, quantity: 2, kind: 'payment_hold' });
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 2, onHand: 2 });
    expect((await allocate([c.variantId])).count).toBe(0);
    const op = await operation();
    await db().query(`update public.orders set status='paid' where id=$1`, [buyer.id]);
    await db().query(`update public.order_item_allocations set kind='paid',version=version+1 where id=$1`, [a]);
    await db().query(`insert into public.order_item_allocation_events
      (allocation_id,event_type,quantity,operation_id,sequence) values ($1,'promote',2,$2,1)`, [a, op]);
    await flush();
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 0, onHand: 2 });
    expect(await quantity(old.line)).toBe(0);
    expect((await db().query(`select count(*)::int as n from public.stock_movements where variant_id=$1`, [c.variantId])).rows[0].n).toBe(2);
  });

  test('cancel/refund quantities, unpaid, cancelled, review holds and NULL variants are excluded', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const request = await order(c.itemId, c.variantId, 3);
    await insertCancelRequest(db(), { orderId: request.id, lines: [{ orderItemId: request.line, quantity: 1 }] });
    await insertRefundRecord(db(), { orderId: request.id, status: 'pending', lines: [{ orderItemId: request.line, quantity: 1 }] });
    const unpaid = await order(c.itemId, c.variantId, 1, '2026-01-01', 'pending');
    const cancelled = await order(c.itemId, c.variantId, 1, '2026-01-01', 'cancelled');
    const missing = await order(c.itemId, null, 1);
    const held = await order(c.itemId, c.variantId, 1);
    await db().query('select private.ensure_group_g_payment_review_hold($1,$2,$3,$4,$5)', [held.id, null, null, `hold-${randomUUID()}`, null]);
    expect((await allocate([c.variantId], 8)).count).toBe(1);
    expect(await quantity(request.line)).toBe(1);
    for (const o of [unpaid, cancelled, missing, held]) expect(await quantity(o.line)).toBe(0);
    expect(await variantStock(db(), c.variantId)).toBe(7);
  });

  test('shipment consumes A without a second purchase; restoring consume adds on hand once', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const o = await order(c.itemId, c.variantId);
    await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 2, kind: 'paid' });
    const f = await seedGroupG1Shipment(db(), { orderId: o.id, lines: [{ orderItemId: o.line, quantity: 2 }], shippedAt: '2026-02-01T00:00:00Z' });
    await flush();
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 0, onHand: 0 });
    expect((await db().query(`select count(*)::int as n from public.stock_movements where variant_id=$1`, [c.variantId])).rows[0].n).toBe(2);
    const consume = (await db().query(`select e.id from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id where a.order_item_id=$1 and e.event_type='consume'`, [o.line])).rows[0].id;
    await db().query('update public.order_fulfillments set cancelled_at=now() where id=$1', [f]);
    async function restore() {
      const op = await operation();
      await db().query(`insert into public.stock_movements(variant_id,delta,reason) values($1,2,'restock')`, [c.variantId]);
      const m = (await db().query(`insert into public.stock_movements(variant_id,delta,reason,order_item_id,allocation_operation_id)
        values($1,-2,'purchase',$2,$3) returning id`, [c.variantId, o.line, op])).rows[0].id;
      const a = (await db().query(`insert into public.order_item_allocations(order_item_id,variant_id,quantity,remaining_quantity,kind,operation_id)
        values($1,$2,2,2,'paid',$3) returning id`, [o.line, c.variantId, op])).rows[0].id;
      await db().query(`insert into public.order_item_allocation_events
        (allocation_id,event_type,quantity,operation_id,sequence,stock_movement_id,reverses_event_id)
        values($1,'restore',2,$2,1,$3,$4)`, [a, op, m, consume]);
    }
    await restore();
    await flush();
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 0, onHand: 2 });
    expect(await rejected(restore)).toMatchObject({ code: '23505' });
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 0, onHand: 2 });
  });

  test('zero is inert; negative, overdraw and over-allocation are rejected without residue', async () => {
    const c = await createCatalogFixture(db(), { stock: 3 });
    const o = await order(c.itemId, c.variantId, 1);
    expect(await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 0, kind: 'paid' })).toBeNull();
    await expect(seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: -1, kind: 'paid' })).rejects.toThrow('GROUP_G_ARGUMENT_INVALID');
    expect(await rejected(() => seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 4, kind: 'paid' }))).toMatchObject({ code: '23514' });
    await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 1, kind: 'paid' });
    expect(await rejected(() => seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 1, kind: 'paid' })))
      .toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS' });
    expect(await quantity(o.line)).toBe(1);
    expect(await variantStock(db(), c.variantId)).toBe(2);
  });

  test('tagged ledger orphans and a wrong order item are rejected by deferred consistency checks', async () => {
    const c = await createCatalogFixture(db(), { stock: 4 });
    const o = await order(c.itemId, c.variantId);
    const other = await order(c.itemId, c.variantId);
    expect(await rejected(async () => {
      const op = await operation();
      await db().query(`insert into public.stock_movements(variant_id,delta,reason,allocation_operation_id)
        values($1,-1,'purchase',$2)`, [c.variantId, op]);
    })).toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS', detail: 'stock_movement' });
    expect(await rejected(async () => {
      const op = await operation();
      const m = (await db().query(`insert into public.stock_movements(variant_id,delta,reason,order_item_id,allocation_operation_id)
        values($1,-1,'purchase',$2,$3) returning id`, [c.variantId, other.line, op])).rows[0].id;
      const a = (await db().query(`insert into public.order_item_allocations(order_item_id,variant_id,quantity,remaining_quantity,kind,operation_id)
        values($1,$2,1,1,'paid',$3) returning id`, [o.line, c.variantId, op])).rows[0].id;
      await db().query(`insert into public.order_item_allocation_events(allocation_id,event_type,quantity,operation_id,sequence,stock_movement_id)
        values($1,'allocate',1,$2,1,$3)`, [a, op, m]);
    })).toMatchObject({ code: '23514', message: 'GROUP_G_ALLOCATION_BOUNDS', detail: 'stock_movement' });
  });

  test('an allocation event fault rolls back receipt, F, allocation, operation and state history together', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const o = await order(c.itemId, c.variantId);
    await db().query(`create function pg_temp.fail_g1_event() returns trigger language plpgsql as $$
      begin raise exception 'G1_TEST_EVENT_FAULT' using errcode='55000'; end $$`);
    await db().query(`create trigger g1_test_event_fault before insert on public.order_item_allocation_events
      for each row execute function pg_temp.fail_g1_event()`);
    expect(await rejected(() => withGroupG1FixtureTransaction(db(), () => allocate([c.variantId], 2))))
      .toMatchObject({ code: '55000', message: 'G1_TEST_EVENT_FAULT' });
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 0, onHand: 0 });
    for (const table of ['stock_movements', 'order_item_allocations', 'order_item_allocation_events', 'order_item_state_events']) {
      const field = table === 'stock_movements' || table === 'order_item_allocations' ? 'variant_id' : table === 'order_item_state_events' ? 'order_item_id' : null;
      const rows = field ? await db().query(`select count(*)::int as n from public.${table} where ${field}=$1`, [field === 'order_item_id' ? o.line : c.variantId])
        : await db().query(`select count(*)::int as n from public.order_item_allocation_events e
          join public.order_item_allocations a on a.id=e.allocation_id where a.variant_id=$1`, [c.variantId]);
      expect(rows.rows[0].n).toBe(0);
    }
    expect((await db().query(`select count(*)::int as n from private.group_g_operations where operation='fifo_test'`)).rows[0].n).toBe(0);
  });

  test('nested synthetic helpers do not commit their caller and failure rolls back their savepoint', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const o = await order(c.itemId, c.variantId);
    await withGroupG1FixtureTransaction(db(), () => seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 1, kind: 'paid' }));
    const observer: PgClient = await connectLocalDb();
    try {
      expect((await observer.query('select count(*)::int as n from public.orders where id=$1', [o.id])).rows[0].n).toBe(0);
    } finally { await observer.end(); }
    await expect(withGroupG1FixtureTransaction(db(), async () => {
      await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 1, kind: 'paid' });
      throw new Error('G1_TEST_FIXTURE_FAULT');
    })).rejects.toThrow('G1_TEST_FIXTURE_FAULT');
    expect(await quantity(o.line)).toBe(1);
    expect(await variantStock(db(), c.variantId)).toBe(1);
  });

  test('shared shipped material takes the advisory in a legacy caller transaction before writing, without committing it', async () => {
    await db().query('rollback');
    await db().query('begin');
    await expect(withGroupG1FixtureTransaction(db(), async () => undefined)).rejects.toThrow('GROUP_G_INVENTORY_LOCK_REQUIRED');
    const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 2 }] });
    expect((await db().query(`select exists(select 1 from pg_locks where pid=pg_backend_pid()
      and locktype='advisory' and classid=190521 and objid=1 and objsubid=2
      and mode='ExclusiveLock' and granted) as held`)).rows[0].held).toBe(true);
    expect(await totals(fx.variantIds[0])).toEqual({ f: 0, a: 0, h: 0, onHand: 0 });
    expect((await db().query(`select e.event_type,e.quantity from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id where a.order_item_id=$1 order by event_type`, [fx.orderItemIds[0]])).rows)
      .toEqual([{ event_type: 'allocate', quantity: 2 }, { event_type: 'consume', quantity: 2 }]);
    const observer = await connectLocalDb();
    try {
      expect((await observer.query('select count(*)::int as n from public.orders where id=$1', [fx.orderId])).rows[0].n).toBe(0);
    } finally { await observer.end(); }
    await flush();
  });

  test('cancelled material starts cancelled and preserves A/F; valid shipment requires existing A', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const o = await order(c.itemId, c.variantId);
    const input = { orderId: o.id, lines: [{ orderItemId: o.line, quantity: 2 }], shippedAt: '2026-02-01T00:00:00Z' };
    await expect(seedGroupG1Shipment(db(), input)).rejects.toThrow('GROUP_G_FIXTURE_ALLOCATION_REQUIRED');
    await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 2, kind: 'paid' });
    const f = await seedGroupG1Shipment(db(), { ...input, cancelledAt: '2026-02-02T00:00:00Z' });
    await flush();
    expect((await db().query('select cancelled_at is not null as cancelled from public.order_fulfillments where id=$1', [f])).rows[0].cancelled).toBe(true);
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 2, h: 0, onHand: 2 });
    expect((await db().query(`select count(*)::int as n from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id=e.allocation_id
      where a.order_item_id=$1 and e.event_type in ('consume','restore')`, [o.line])).rows[0].n).toBe(0);
    await expect(seedGroupG1Shipment(db(), { ...input, cancelledAt: '2026-02-02T00:00:00Z', deliveredAt: '2026-02-02T00:00:00Z' }))
      .rejects.toThrow('GROUP_G_ARGUMENT_INVALID');
    await seedGroupG1Shipment(db(), input);
    await flush();
    expect(await totals(c.variantId)).toEqual({ f: 0, a: 0, h: 0, onHand: 0 });
  });

  test('internal cores and the existing trigger wrapper have exact ownership, security and no role bypass', async () => {
    const signatures = ['private.lock_group_g_inventory(bigint[],uuid[],uuid)',
      'private.allocate_group_g_fifo(bigint[],uuid,uuid)', 'private.apply_group_g_stock_movement(bigint,integer)',
      'private.check_group_g_stock_movement_consistency()', 'public.apply_stock_movement()'];
    for (const signature of signatures) {
      expect((await db().query(`select pg_get_userbyid(p.proowner) as owner,p.prosecdef,p.proconfig,
        has_function_privilege('anon',p.oid,'EXECUTE') as anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service
        from pg_proc p where p.oid=$1::regprocedure`, [signature])).rows[0])
        .toEqual({ owner: 'postgres', prosecdef: signature !== 'public.apply_stock_movement()',
          proconfig: ['search_path=""'], anon: false, authenticated: false, service: false });
    }
    const wrapper = (await db().query("select prosrc from pg_proc where oid='public.apply_stock_movement()'::regprocedure")).rows[0].prosrc;
    expect(wrapper).toContain('private.apply_group_g_stock_movement(NEW.variant_id, NEW.delta)');
    for (const signature of signatures.slice(1, 4)) {
      const source = (await db().query('select prosrc from pg_proc where oid=$1::regprocedure', [signature])).rows[0].prosrc as string;
      expect(source).not.toMatch(/pg_advisory_xact_lock\s*\(|for\s+(?:update|key\s+share)|skip\s+locked|public\.admin_/i);
    }
    expect((await db().query("select count(*)::int as n from pg_trigger where tgrelid='public.stock_movements'::regclass and tgname='stock_movements_apply' and tgenabled='O'")).rows[0].n).toBe(1);
  });

  test('FIFO requires the actual advisory lock and cannot be authorized by a transaction setting', async () => {
    const other = await connectLocalDb();
    try {
      await other.query('begin');
      await other.query("select set_config('app.group_g_operation_id',$1,true)", [randomUUID()]);
      await expect(other.query('select private.allocate_group_g_fifo($1,$2,$3)', [[], randomUUID(), null]))
        .rejects.toMatchObject({ code: '55000', message: 'GROUP_G_INVENTORY_LOCK_REQUIRED' });
    } finally {
      await other.query('rollback');
      await other.end();
    }
  });
});
