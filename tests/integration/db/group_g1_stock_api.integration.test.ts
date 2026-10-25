/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines, variantStock } from './helpers/order-fixtures';
import { isInTransaction, seedGroupG1Allocation, seedGroupG1Restock, seedGroupG1Shipment } from './helpers/group-g1-fixtures';

describeLocalDb('G-1 stock RPC', (db) => {
  let actor: string;
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = randomUUID();
    await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [actor]);
    await db().query("insert into public.user_roles(user_id,role_id) select $1,id from public.roles where code='admin'", [actor]);
  });
  afterEach(async () => { await db().query('rollback'); });
  async function flush() {
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
    await db().query('set constraints all deferred');
  }
  async function move(item: number, variant: number, delta: number, options: {
    reason?: string; note?: string | null; expected?: number | null; key?: string; actor?: string;
  } = {}) {
    const result = (await db().query('select public.admin_record_stock_movement($1,$2,$3,$4,$5,$6,$7,$8) as result',
      [item, variant, delta, options.reason ?? 'adjustment', options.note ?? null, options.actor ?? actor,
        options.key ?? randomUUID(), options.expected ?? null])).rows[0].result;
    await flush();
    return result as { movementId: string; releasedQuantity: number; allocatedQuantity: number; replayed: boolean };
  }
  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code: string; message: string; detail?: string };
      return { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }
  async function order(itemId: number, variantId: number, quantity: number, createdAt: string, status = 'paid') {
    const o = await insertOrderWithLines(db(), { status, createdAt,
      lines: [{ itemId, variantId, quantity, fulfillmentType: 'backorder', reserved: false }] });
    return { id: o.orderId, line: o.orderItemIds[0] };
  }
  async function inventory(variant: number) {
    return (await db().query('select * from public.list_group_g_variant_inventory($1)', [[variant]])).rows[0];
  }
  async function counts() {
    return (await db().query(`select (select count(*) from public.stock_movements)::int as movements,
      (select count(*) from public.order_item_allocations)::int as allocations,
      (select count(*) from public.order_item_allocation_events)::int as events,
      (select count(*) from public.order_item_state_events)::int as states,
      (select count(*) from private.group_g_operations)::int as operations`)).rows[0];
  }

  test('restock calls FIFO once, records state/history, and same-key replay has zero increments', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const old = await order(c.itemId, c.variantId, 2, '2026-01-01');
    const young = await order(c.itemId, c.variantId, 2, '2026-02-01');
    const key = randomUUID();
    await db().query("select set_config('app.group_g_operation_id','prior-context',true)");
    const result = await move(c.itemId, c.variantId, 3, { reason: 'restock', key, note: ' 入荷 ' });
    expect(result).toEqual({ movementId: expect.stringMatching(/^[1-9][0-9]*$/), releasedQuantity: 0, allocatedQuantity: 3, replayed: false });
    const before = await counts();
    expect(await move(c.itemId, c.variantId, 3, { reason: 'restock', key, note: '入荷' })).toEqual({ ...result, replayed: true });
    expect(await counts()).toEqual(before);
    expect((await db().query(`select operation,cause_type,actor_id,fingerprint ~ '^[0-9a-f]{64}$' as valid_fingerprint,result
      from private.group_g_operations where operation='stock_move' and request_key=$1`,[key])).rows[0])
      .toEqual({ operation:'stock_move',cause_type:'variant',actor_id:actor,valid_fingerprint:true,result });
    expect((await db().query("select current_setting('app.group_g_operation_id') as value")).rows[0].value).toBe('prior-context');
    expect((await db().query(`select order_item_id,remaining_quantity from public.order_item_allocations
      where order_item_id=any($1) order by order_item_id`, [[old.line, young.line]])).rows)
      .toEqual([{ order_item_id: old.line, remaining_quantity: 2 }, { order_item_id: young.line, remaining_quantity: 1 }].sort((a,b) => a.order_item_id.localeCompare(b.order_item_id)));
    expect(await inventory(c.variantId)).toMatchObject({ free: 0, paid_allocated: 3, payment_held: 0, on_hand: 3, waiting: 1 });
    expect((await db().query(`select count(*)::int as n from public.order_item_state_events e join private.group_g_operations op on op.id=e.operation_id
      where op.operation='stock_move' and op.request_key=$1 and e.from_status='in_production' and e.to_status='ready'`, [key])).rows[0].n).toBe(2);
    expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [c.variantId])).rows).toEqual([]);
  });

  test('negative adjustment consumes F first and releases newest remaining A; H and consumed shipments stay intact', async () => {
    const c = await createCatalogFixture(db(), { stock: 9 });
    const old = await order(c.itemId, c.variantId, 3, '2026-01-01');
    const young = await order(c.itemId, c.variantId, 3, '2026-02-01');
    const held = await order(c.itemId, c.variantId, 2, '2026-03-01', 'pending');
    const oldA = await seedGroupG1Allocation(db(), { orderItemId: old.line, quantity: 3, kind: 'paid' });
    const youngA = await seedGroupG1Allocation(db(), { orderItemId: young.line, quantity: 3, kind: 'paid' });
    const h = await seedGroupG1Allocation(db(), { orderItemId: held.line, quantity: 2, kind: 'payment_hold' });
    await seedGroupG1Shipment(db(), { orderId: young.id, lines: [{ orderItemId: young.line, quantity: 1 }], shippedAt: '2026-04-01' });
    const before = await counts();
    const confirmation = await rejected(() => move(c.itemId, c.variantId, -4));
    expect(confirmation).toEqual({ message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', detail: '{"releasedQuantity": 3}' });
    expect(await counts()).toEqual(before);
    for (const note of [null,'','   ','\t\n']) {
      expect(await rejected(() => move(c.itemId, c.variantId, -4, { expected: 3, note })))
        .toEqual({ message: 'GROUP_G_STOCK_RELEASE_REASON_REQUIRED', code: '22023' });
    }
    expect(await rejected(() => move(c.itemId, c.variantId, -4, { expected: 2, note: '棚卸' }))).toEqual(confirmation);
    expect(await counts()).toEqual(before);
    const result = await move(c.itemId, c.variantId, -4, { expected: 3, note: '棚卸' });
    expect(result).toMatchObject({ releasedQuantity: 3, allocatedQuantity: 0 });
    expect((await db().query(`select id,remaining_quantity from public.order_item_allocations where id=any($1) order by id`, [[oldA, youngA, h]])).rows)
      .toEqual([{ id: oldA, remaining_quantity: 2 }, { id: youngA, remaining_quantity: 0 }, { id: h, remaining_quantity: 2 }].sort((a,b) => String(a.id).localeCompare(String(b.id))));
    expect(await inventory(c.variantId)).toMatchObject({ free: 0, paid_allocated: 2, payment_held: 2, on_hand: 4 });
    const release = (await db().query(`select e.quantity,m.reason,m.delta,e.actor_id,m.note,e.reason as event_reason
      from public.order_item_allocation_events e
      join public.stock_movements m on m.id=e.stock_movement_id join private.group_g_operations op on op.id=e.operation_id
      where op.operation='stock_move' and e.event_type='release' and m.variant_id=$1 order by e.quantity`, [c.variantId])).rows;
    // The admin memo stays on the ledger only; the allocation history holds the fixed code.
    expect(release).toEqual([1,2].map(quantity => ({ quantity, reason: 'allocation_release', delta: quantity, actor_id: actor, note: '棚卸',
      event_reason: 'stock_adjustment' })));
    expect((await db().query('select shipped,completed,ready_unshipped from private.order_line_fulfillment($1)', [young.id])).rows[0])
      .toEqual({ shipped: 1, completed: 1, ready_unshipped: 0 });
  });

  test('free-only decrease needs no release confirmation, and H cannot cover shortages', async () => {
    const c = await createCatalogFixture(db(), { stock: 4 });
    const o = await order(c.itemId, c.variantId, 3, '2026-01-01', 'pending');
    await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 3, kind: 'payment_hold' });
    expect(await move(c.itemId, c.variantId, -1)).toMatchObject({ releasedQuantity: 0 });
    const before = await counts();
    expect(await rejected(() => move(c.itemId, c.variantId, -1))).toEqual({ code: '23514', message: 'GROUP_G_STOCK_INSUFFICIENT' });
    expect(await counts()).toEqual(before);
    expect(await inventory(c.variantId)).toMatchObject({ free: 0, paid_allocated: 0, payment_held: 3, on_hand: 3 });
  });

  test('equal order times release by order UUID descending', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const orders = [await order(c.itemId,c.variantId,1,'2026-01-01'), await order(c.itemId,c.variantId,1,'2026-01-01')]
      .sort((a,b) => b.id.localeCompare(a.id));
    for (const o of orders) await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 1, kind: 'paid' });
    await move(c.itemId,c.variantId,-1,{ expected: 1, note: '棚卸' });
    expect((await db().query(`select remaining_quantity from public.order_item_allocations where order_item_id=$1`,[orders[0].line])).rows[0].remaining_quantity).toBe(0);
    expect((await db().query(`select remaining_quantity from public.order_item_allocations where order_item_id=$1`,[orders[1].line])).rows[0].remaining_quantity).toBe(1);
  });

  test('an intervening stock change recomputes confirmation and writes nothing on the stale confirmed request', async () => {
    const c = await createCatalogFixture(db(), { stock: 4 });
    const o = await order(c.itemId,c.variantId,2,'2026-01-01');
    await seedGroupG1Allocation(db(), { orderItemId: o.line, quantity: 2, kind: 'paid' });
    expect(await rejected(() => move(c.itemId,c.variantId,-3))).toEqual({ code: '55000',
      message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', detail: '{"releasedQuantity": 1}' });
    await move(c.itemId,c.variantId,-1);
    const before = await counts();
    expect(await rejected(() => move(c.itemId,c.variantId,-3,{ expected:1,note:'棚卸' }))).toEqual({ code:'55000',
      message:'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED',detail:'{"releasedQuantity": 2}' });
    expect(await counts()).toEqual(before);
    expect(await inventory(c.variantId)).toMatchObject({ free:1,paid_allocated:2,payment_held:0,on_hand:3 });
  });

  test('within an order releases by item UUID then allocation UUID descending', async () => {
    const c = await createCatalogFixture(db(), { stock: 8 });
    const o = await insertOrderWithLines(db(), { status: 'paid', lines: [1,2].map(() => ({
      itemId: c.itemId, variantId: c.variantId, quantity: 4, fulfillmentType: 'backorder', reserved: false,
    })) });
    const allocations: { line: string; id: string }[] = [];
    for (const line of o.orderItemIds) for (let i=0;i<2;i++) {
      const id = await seedGroupG1Allocation(db(), { orderItemId: line, quantity: 2, kind: 'paid' });
      if (!id) throw new Error('missing fixture allocation');
      allocations.push({ line, id });
    }
    allocations.sort((a,b) => b.line.localeCompare(a.line) || b.id.localeCompare(a.id));
    await move(c.itemId,c.variantId,-1,{ expected: 1, note: '棚卸' });
    for (const [index,a] of allocations.entries()) {
      expect((await db().query('select remaining_quantity from public.order_item_allocations where id=$1',[a.id])).rows[0].remaining_quantity).toBe(index===0 ? 1 : 2);
    }
  });

  test.each(['delta','reason','note','expected','actor','variant','item'])('same key with changed %s conflicts', async (field) => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const other = await createCatalogFixture(db(), { stock: 0 });
    const key = randomUUID();
    await move(c.itemId, c.variantId, 2, { key });
    const before = await counts();
    const changed = { key, ...(field === 'reason' ? { reason: 'restock' } : {}), ...(field === 'note' ? { note: 'different' } : {}),
      ...(field === 'expected' ? { expected: 0 } : {}) };
    let otherActor = actor;
    if (field === 'actor') {
      otherActor = randomUUID();
      await db().query("insert into auth.users(id,raw_app_meta_data,raw_user_meta_data) values($1,'{}','{}')", [otherActor]);
      await db().query("insert into public.user_roles(user_id,role_id) select $1,id from public.roles where code='admin'", [otherActor]);
    }
    expect(await rejected(() => move(field === 'item' || field === 'variant' ? other.itemId : c.itemId,
      field === 'item' || field === 'variant' ? other.variantId : c.variantId, field === 'delta' ? 3 : 2,
      { ...changed, actor: otherActor }))).toEqual({ code: '23505', message: 'GROUP_G_REQUEST_KEY_CONFLICT' });
    expect(await counts()).toEqual(before);
  });

  // G-2: the stock entry needs admin.stock.manage AND admin.stock.read (was admin.items.manage in G-1)
  test.each(['inactive','expired','admin.stock.manage','admin.stock.read'])('requires the current actor ACL: %s', async (change) => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    if (change === 'inactive') await db().query('update public.user_roles set active=false where user_id=$1', [actor]);
    if (change === 'expired') await db().query("update public.user_roles set expires_at=now()-interval '1 second' where user_id=$1", [actor]);
    if (change.startsWith('admin.stock.')) await db().query(`delete from public.role_permissions where role_id=(select id from public.roles where code='admin')
      and permission_id=(select id from public.permissions where code=$1)`, [change]);
    expect(await rejected(() => move(c.itemId,c.variantId,1))).toEqual({ message: 'GROUP_G_FORBIDDEN', code: '42501' });
    expect(await variantStock(db(),c.variantId)).toBe(0);
  });

  test('validates item ownership, nonzero quantity, and restock sign inside the RPC', async () => {
    const c = await createCatalogFixture(db(), { stock: 1 });
    const other = await createCatalogFixture(db(), { stock: 0 });
    for (const run of [() => move(other.itemId,c.variantId,1), () => move(c.itemId,c.variantId,0),
      () => move(c.itemId,c.variantId,-1,{ reason: 'restock' }), () => move(c.itemId,c.variantId,1,{ reason: 'purchase' })]) {
      expect(await rejected(run)).toEqual({ message: 'GROUP_G_ARGUMENT_INVALID', code: '22023' });
    }
  });

  test('a failing state event rolls back movement, allocation, operation and F together', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    await order(c.itemId,c.variantId,2,'2026-01-01');
    await db().query(`create function pg_temp.reject_g1_state() returns trigger language plpgsql as $$
      begin raise exception 'TEST_EVENT_FAILURE' using errcode='P0001'; end $$`);
    await db().query('create trigger task5_event_failure before insert on public.order_item_state_events for each row execute function pg_temp.reject_g1_state()');
    const before = await counts();
    expect(await rejected(() => move(c.itemId,c.variantId,2))).toEqual({ message: 'TEST_EVENT_FAILURE', code: 'P0001' });
    expect(await counts()).toEqual(before);
    expect(await variantStock(db(),c.variantId)).toBe(0);
  });

  test('local restock helper uses the public RPC, returns decimal movement id and leaves the caller transaction open', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const o = await order(c.itemId,c.variantId,1,'2026-01-01');
    const id = await seedGroupG1Restock(db(), { itemId: c.itemId, variantId: c.variantId, quantity: 1, actorId: actor, requestKey: randomUUID() });
    expect(id).toMatch(/^[1-9][0-9]*$/);
    expect((await db().query('select reason,note from public.stock_movements where id=$1',[id])).rows[0])
      .toEqual({ reason: 'restock', note: 'E2E fixture restock' });
    expect((await db().query('select remaining_quantity from public.order_item_allocations where order_item_id=$1',[o.line])).rows[0].remaining_quantity).toBe(1);
    expect(await isInTransaction(db())).toBe(true);
  });

  test('service_role uses the public delegate and anonymous/authenticated callers cannot execute either entry', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    await db().query('set local role service_role');
    const result = (await db().query('select public.admin_record_stock_movement($1,$2,$3,$4,$5,$6,$7,$8) as result',
      [c.itemId,c.variantId,1,'restock',null,actor,randomUUID(),null])).rows[0].result;
    await db().query('reset role');
    await flush();
    expect(result).toMatchObject({ releasedQuantity:0,allocatedQuantity:0,replayed:false });
    for (const role of ['anon','authenticated']) for (const schema of ['public','private']) {
      expect(await rejected(async () => {
        await db().query(`set local role ${role}`);
        await db().query(`select ${schema}.admin_record_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.itemId,c.variantId,1,'restock',null,actor,randomUUID(),null]);
      })).toMatchObject({ code:'42501' });
    }
  });
});
