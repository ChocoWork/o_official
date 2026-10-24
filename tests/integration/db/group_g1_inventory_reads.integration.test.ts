/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, createShippedOrderFixture, insertOrderWithLines, insertRefundRecord,
  insertCancelRequest, insertReturnRecord, addItemVariant } from './helpers/order-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment } from './helpers/group-g1-fixtures';

describeLocalDb('G-1 inventory and compatible reads', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });
  async function order(itemId: number, variantId: number, quantity: number, status = 'paid', fulfillmentType: 'stock' | 'backorder' = 'backorder') {
    return insertOrderWithLines(db(), { status, lines: [{ itemId, variantId, quantity, fulfillmentType, reserved: false }] });
  }
  async function inventory(ids: number[] | null) {
    return (await db().query('select * from public.list_group_g_variant_inventory($1)', [ids])).rows;
  }
  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code: string; message: string };
      return { code: error.code, message: error.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }
  test('reads F, remaining A/H and waiting once, retains inactive variants, deduplicates input and handles empty input', async () => {
    const c = await createCatalogFixture(db(), { stock: 7, isActive: false });
    const paid = await order(c.itemId,c.variantId,5);
    const pending = await order(c.itemId,c.variantId,3,'pending');
    await seedGroupG1Allocation(db(), { orderItemId: paid.orderItemIds[0], quantity: 3, kind: 'paid' });
    await seedGroupG1Allocation(db(), { orderItemId: pending.orderItemIds[0], quantity: 2, kind: 'payment_hold' });
    expect(await inventory([c.variantId,c.variantId])).toEqual([{ variant_id: String(c.variantId), free: 2, paid_allocated: 3,
      payment_held: 2, on_hand: 7, waiting: 2 }]);
    expect((await db().query('select * from public.list_variant_stock_states($1)', [[c.variantId]])).rows)
      .toEqual([{ variant_id: String(c.variantId), committed: 5, backorder: 2 }]);
    expect(await inventory([])).toEqual([]);
    expect(await inventory(null)).toEqual([]);
    expect(await rejected(() => inventory(Array(501).fill(c.variantId))))
      .toEqual({ message: 'TOO_MANY_VARIANTS', code: '22023' });
    expect(await inventory(Array(500).fill(c.variantId))).toHaveLength(1);
  });
  test('reservations are remaining A+H, completion is shipped+A and public fulfillment keeps exactly twelve columns', async () => {
    const c = await createCatalogFixture(db(), { stock: 5 });
    const o = await order(c.itemId,c.variantId,6);
    await seedGroupG1Allocation(db(), { orderItemId: o.orderItemIds[0], quantity: 5, kind: 'paid' });
    await seedGroupG1Shipment(db(), { orderId: o.orderId, lines: [{ orderItemId: o.orderItemIds[0], quantity: 2 }], shippedAt: '2026-01-01' });
    await insertRefundRecord(db(), { orderId: o.orderId, status: 'succeeded',
      lines: [{ orderItemId: o.orderItemIds[0], quantity: 1, beforeShipment: true }] });
    const privateRows = (await db().query('select * from private.order_line_fulfillment($1)', [o.orderId])).rows;
    expect(privateRows).toEqual([{ order_item_id: o.orderItemIds[0], variant_id: String(c.variantId), fulfillment_type: 'backorder',
      quantity: 6, shipped: 2, completed: 5, refunded_before_shipment: 1, refunded_after_shipment: 0,
      in_production: 0, ready_unshipped: 3, unshipped: 3 }]);
    expect(Object.keys(privateRows[0])).toHaveLength(11);
    expect((await db().query('select * from public.list_order_line_fulfillment($1)', [[o.orderId]])).rows)
      .toEqual(privateRows.map(row => ({ order_id: o.orderId, ...row })));
    expect((await db().query('select * from private.order_line_reservations($1)', [o.orderId])).rows)
      .toEqual([{ order_item_id: o.orderItemIds[0], variant_id: String(c.variantId), quantity: 6, reserved: 3 }]);
    expect((await db().query('select count(*)::int as n from public.order_item_completions where order_id=$1',[o.orderId])).rows[0].n).toBe(0);
  });
  test('unpaid holds never appear as ready and old stock type without A is in production', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const unpaid = await order(c.itemId,c.variantId,3,'pending','stock');
    const paid = await order(c.itemId,c.variantId,2,'paid','stock');
    await seedGroupG1Allocation(db(), { orderItemId: unpaid.orderItemIds[0], quantity: 2, kind: 'payment_hold' });
    expect((await db().query('select completed,ready_unshipped,in_production,unshipped from private.order_line_fulfillment($1)',[unpaid.orderId])).rows[0])
      .toEqual({ completed: 0, ready_unshipped: 0, in_production: 0, unshipped: 3 });
    expect((await db().query('select completed,ready_unshipped,in_production,unshipped from private.order_line_fulfillment($1)',[paid.orderId])).rows[0])
      .toEqual({ completed: 0, ready_unshipped: 0, in_production: 2, unshipped: 2 });
  });
  test('customer ready quantity retains held A while management projection splits cancellation requests', async () => {
    const c = await createCatalogFixture(db(), { stock: 3 });
    const o = await order(c.itemId,c.variantId,4);
    await seedGroupG1Allocation(db(), { orderItemId: o.orderItemIds[0], quantity: 3, kind: 'paid' });
    await insertCancelRequest(db(), { orderId: o.orderId, lines: [{ orderItemId: o.orderItemIds[0], quantity: 2 }] });
    expect((await db().query('select ready_unshipped,in_production from private.order_line_fulfillment($1)',[o.orderId])).rows[0])
      .toEqual({ ready_unshipped: 3, in_production: 1 });
    expect((await inventory([c.variantId]))[0]).toMatchObject({ paid_allocated: 3, on_hand: 3 });
    expect((await db().query('select status,quantity from public.list_admin_order_item_states($1)',[[o.orderId]])).rows)
      .toEqual(expect.arrayContaining([{ status: 'cancel_requested', quantity: 2 }]));
  });
  test('waiting includes payment-review blocked production instead of applying FIFO eligibility filters', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const o = await order(c.itemId,c.variantId,2);
    await db().query('select private.ensure_group_g_payment_review_hold($1,$2,$3,$4,$5)',
      [o.orderId,null,null,`task5-${randomUUID()}`,null]);
    expect((await inventory([c.variantId]))[0]).toMatchObject({ waiting: 2, paid_allocated: 0 });
  });
  test('waiting also includes exchange production blocked by unpaid fees', async () => {
    const shipped = await createShippedOrderFixture(db(), { lines:[{ quantity:1 }] });
    const target = await addItemVariant(db(), { itemId:shipped.itemIds[0],colorName:'WHITE',sizeLabel:'L',stock:0 });
    const ret = await insertReturnRecord(db(), { orderId:shipped.orderId,feeDueAmount:500,
      lines:[{ orderItemId:shipped.orderItemIds[0],fulfillmentId:shipped.fulfillments[0].id,quantity:1,
        resolution:'exchange',exchangeVariantId:target.variantId,exchangeMethod:'make' }] });
    await db().query(`insert into public.order_items
      (order_id,item_id,item_name,item_price,quantity,line_total,variant_id,fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
      values($1,$2,'exchange',0,1,0,$3,'backorder','exchange',$4,5000)`,
    [shipped.orderId,shipped.itemIds[0],target.variantId,ret.lineIds[0]]);
    expect((await inventory([target.variantId]))[0]).toMatchObject({ waiting:1,free:0,paid_allocated:0,payment_held:0,on_hand:0 });
  });
  test('allocation history scopes by variant item, orders ties by UUID and preserves bigint links; stock history stays ledger-only', async () => {
    const c = await createCatalogFixture(db(), { stock: 3 });
    const other = await createCatalogFixture(db(), { stock: 1 });
    const o = await order(c.itemId,c.variantId,2,'pending');
    const foreign = await order(other.itemId,other.variantId,1);
    const allocation = await seedGroupG1Allocation(db(), { orderItemId: o.orderItemIds[0], quantity: 2, kind: 'payment_hold' });
    await seedGroupG1Allocation(db(), { orderItemId: foreign.orderItemIds[0], quantity: 1, kind: 'paid' });
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'test_promote',$2,repeat('a',64),'order',$3,'{}')`,[op,randomUUID(),o.orderId]);
    await db().query("update public.orders set status='paid' where id=$1",[o.orderId]);
    await db().query("update public.order_item_allocations set kind='paid',version=version+1 where id=$1",[allocation]);
    await db().query(`insert into public.order_item_allocation_events(allocation_id,event_type,quantity,operation_id,sequence)
      values($1,'promote',2,$2,1)`,[allocation,op]);
    const rows = (await db().query('select * from public.list_item_allocation_history($1,$2)',[c.itemId,50])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.event_id)).toEqual(rows.map(row => row.event_id).sort().reverse());
    expect(rows.every(row => row.order_id===o.orderId && row.variant_id===String(c.variantId))).toBe(true);
    expect(rows.find(row => row.event_type==='promote')).toMatchObject({ stock_movement_id: null, quantity: 2, operation_id: op });
    const hold = rows.find(row => row.event_type==='hold');
    expect(hold.stock_movement_id).toMatch(/^[1-9][0-9]*$/);
    expect(Object.keys(hold)).toHaveLength(14);
    const ledger = (await db().query('select * from public.list_item_stock_history($1,$2)',[c.itemId,50])).rows;
    expect(ledger).toHaveLength(2);
    expect(Object.keys(ledger[0])).toHaveLength(11);
    expect(ledger.map(row => row.reason)).toEqual(['purchase','restock']);
    expect(ledger.map(row => row.balance_after)).toEqual([1,3]);
    expect(ledger[0].movement_id).toBe(hold.stock_movement_id);
    expect((await db().query('select * from public.list_item_allocation_history($1,$2)',[c.itemId,0])).rows).toEqual(rows.slice(0,1));
  });
  test('allocation history uses default 50 and clamps to 200, without hiding inactive existing fulfillment', async () => {
    const c = await createCatalogFixture(db(), { stock: 201, isActive: false });
    const o = await order(c.itemId,c.variantId,201);
    for (let i=0;i<201;i++) await seedGroupG1Allocation(db(), { orderItemId: o.orderItemIds[0], quantity: 1, kind: 'paid' });
    for (const [limit,expected] of [[null,50],[0,1],[1000,200]] as const) {
      expect((await db().query('select * from public.list_item_allocation_history($1,$2)',[c.itemId,limit])).rows).toHaveLength(expected);
    }
    const shipped = await createShippedOrderFixture(db(), { lines: [{ quantity: 1, fulfillmentType: 'backorder' }] });
    expect((await db().query('select count(*)::int as n from public.order_item_completions where order_id=$1',[shipped.orderId])).rows[0].n).toBe(0);
  });
  test('new public readers/writer are service-only invoker delegates; private entry bodies are hardened', async () => {
    const signatures = ['admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)',
      'list_group_g_variant_inventory(bigint[])','list_item_allocation_history(bigint,integer)'];
    for (const signature of signatures) {
      for (const schema of ['public','private']) {
        const name = `${schema}.${signature}`;
        const row = (await db().query(`select p.prosecdef,p.proconfig,r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
          where p.oid=$1::regprocedure`,[name])).rows[0];
        expect(row).toEqual({ prosecdef: schema==='private', proconfig: ['search_path=""'], rolname: 'postgres' });
        for (const role of ['anon','authenticated','service_role']) {
          expect((await db().query('select has_function_privilege($1,$2,$3) as allowed',[role,name,'EXECUTE'])).rows[0].allowed).toBe(role==='service_role');
        }
        expect((await db().query(`select count(*)::int as n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`,[name])).rows[0].n).toBe(0);
      }
    }
  });

  test.each(['refund','return'])('FIFO preserves the same-operation %s origin in the ledger and existing history', async (cause) => {
    const shipped = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }] });
    const o = await order(shipped.itemIds[0],shipped.variantIds[0],1);
    const refund = await insertRefundRecord(db(), { orderId: shipped.orderId, status: 'failed',
      lines: [{ orderItemId: shipped.orderItemIds[0], quantity: 1, beforeShipment: false }] });
    const ret = await insertReturnRecord(db(), { orderId: shipped.orderId,
      lines: [{ orderItemId: shipped.orderItemIds[0], fulfillmentId: shipped.fulfillments[0].id, quantity: 1 }] });
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'test_origin',$2,repeat('a',64),$3,$4,'{}')`,[op,randomUUID(),cause,cause==='refund'?refund.refundId:ret.returnId]);
    await db().query('select private.lock_group_g_inventory($1,$2)',[[shipped.variantIds[0]],[o.orderId,shipped.orderId]]);
    await db().query("insert into public.stock_movements(variant_id,delta,reason) values($1,1,'restock')",[shipped.variantIds[0]]);
    expect((await db().query('select private.allocate_group_g_fifo($1,$2,$3) as n',[[shipped.variantIds[0]],op,null])).rows[0].n).toBe(1);
    const history = (await db().query('select * from public.list_item_stock_history($1,$2)',[shipped.itemIds[0],50])).rows;
    expect(history[0]).toMatchObject({ reason: 'purchase', order_id: o.orderId,
      refund_id: cause==='refund'?refund.refundId:null, return_id: cause==='return'?ret.returnId:null });
  });
});
