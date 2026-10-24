/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';
import { setOrderStatusForFixture } from './helpers/group-g1-fixtures';

type Fx = { orderId: string; itemId: string; variantId: number; catalogId: number; quantity: number };
type Range = { status: string; unit_from: number; unit_to: number; blocked_reasons: string[] };

/** Controller only: reset + both real PostgREST pre-request smoke requests precede this suite. */
describeLocalDb('G-1 exclusive item states and interval history', (db) => {
  // The test transaction takes the common advisory first, before any material locks a row (FK checks included).
  beforeEach(async () => { await db().query('begin'); await db().query('select pg_advisory_xact_lock(190521,1)'); });
  afterEach(async () => { await db().query('rollback'); });

  async function fixture(status = 'paid', quantity = 6): Promise<Fx> {
    const c = await createCatalogFixture(db(), { stock: 50 });
    const o = await insertOrderWithLines(db(), { status, paidAmount: status === 'paid' ? 5000 * quantity : null,
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity, fulfillmentType: 'stock', reserved: false }] });
    return { orderId: o.orderId, itemId: o.orderItemIds[0], variantId: c.variantId, catalogId: c.itemId, quantity };
  }

  async function operation() {
    const id = randomUUID();
    await db().query(`insert into private.group_g_operations
      (id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values ($1,'item_state_test',$2,repeat('a',64),'order',$3,'{}')`, [id, randomUUID(), id]);
    return id;
  }

  async function allocate(f: Fx, quantity: number, kind = 'paid') {
    // G-1 Task 14: the ledger trigger requires the common advisory (the material writes in the test's transaction)
    await db().query('select pg_advisory_xact_lock(190521,1)');
    const op = await operation();
    const m = (await db().query(`insert into public.stock_movements
      (variant_id,delta,reason,order_item_id,allocation_operation_id) values ($1,$2,'purchase',$3,$4) returning id`,
    [f.variantId, -quantity, f.itemId, op])).rows[0].id;
    const a = (await db().query(`insert into public.order_item_allocations
      (order_item_id,variant_id,quantity,remaining_quantity,kind,operation_id) values ($1,$2,$3,$3,$4,$5) returning id`,
    [f.itemId, f.variantId, quantity, kind, op])).rows[0].id;
    await db().query(`insert into public.order_item_allocation_events
      (allocation_id,event_type,quantity,operation_id,sequence,stock_movement_id) values ($1,$2,$3,$4,1,$5)`,
    [a, kind === 'paid' ? 'allocate' : 'hold', quantity, op, m]);
  }

  async function ship(f: Fx, quantity: number, number = 1, delivered = false, cancelled = false) {
    const id = (await db().query(`insert into public.order_fulfillments
      (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at,
       delivered_at,cancelled_at,delivery_status)
      values ($1,$2,$3,'yamato','G1-TEST',false,false,'2026-10-20'::timestamptz + $6::int * interval '1 hour',
        case when $4 then '2026-10-21'::timestamptz end,case when $5 then now() end,
        case when $4 then 'delivered' else 'confirmed' end) returning id`,
    [f.orderId, number, randomUUID(), delivered, cancelled, number])).rows[0].id as string;
    await db().query('insert into public.order_fulfillment_lines values ($1,$2,$3)', [id, f.itemId, quantity]);
    return id;
  }

  async function cancelRequest(f: Fx, quantity: number) {
    const id = (await db().query(`insert into public.order_cancel_requests
      (order_id,status,request_key,request_fingerprint,requested_by) values ($1,'requested',$2,'fixture',$3) returning id`,
    [f.orderId, randomUUID(), randomUUID()])).rows[0].id;
    await db().query(`insert into public.order_cancel_request_lines (cancel_request_id,order_item_id,quantity)
      values ($1,$2,$3)`, [id, f.itemId, quantity]);
    return id as string;
  }

  async function refund(f: Fx, quantity: number, status: string, before = true, returnId: string | null = null) {
    const id = (await db().query(`insert into public.order_refunds
      (order_id,source,request_key,request_fingerprint,status,amount,notify_customer,return_id)
      values ($1,$2,$3,'fixture',$4,$5,false,$6) returning id`,
    [f.orderId, returnId ? 'return' : 'admin', randomUUID(), status, quantity * 5000, returnId])).rows[0].id as string;
    await db().query(`insert into public.order_refund_lines
      (refund_id,order_item_id,quantity,before_shipment,restock_type,amount) values ($1,$2,$3,$4,'no_restock',$5)`,
    [id, f.itemId, quantity, before, quantity * 5000]);
    return id;
  }

  async function returned(f: Fx, fulfillment: string, quantity: number, status = 'open', number = 1) {
    const id = (await db().query(`insert into public.order_returns
      (order_id,number,source,status,request_key,request_fingerprint,return_method,return_shipping_payer,notify_customer,
       declined_at,decline_reason,decline_message)
      values ($1,$2,'customer_request',$3,$4,'fixture','customer_ships','customer',false,
        case when $3='declined' then now() end,case when $3='declined' then 'other' end,
        case when $3='declined' then 'fixture' end) returning id`,
    [f.orderId, number, status, randomUUID()])).rows[0].id as string;
    const line = (await db().query(`insert into public.order_return_lines
      (return_id,fulfillment_id,order_item_id,quantity,reason,resolution)
      values ($1,$2,$3,$4,'unknown','refund') returning id`, [id, fulfillment, f.itemId, quantity])).rows[0].id as string;
    return { id, line };
  }

  async function receive(r: { id: string; line: string }, quantity: number, disposition = 'not_restocked', choice = 'consult', exchange = false) {
    const kind = disposition === 'missing' ? 'close_missing' : 'receive';
    const id = (await db().query(`insert into public.order_return_receipts
      (return_id,request_key,request_fingerprint,kind,refund_choice)
      values ($1,$2,'fixture',$3,$4) returning id`, [r.id, randomUUID(), kind, kind === 'receive' ? choice : null])).rows[0].id;
    const resolution = ['missing', 'sent_back'].includes(disposition) ? null : exchange ? 'exchange' : 'refund';
    await db().query(`insert into public.order_return_receipt_lines
      (receipt_id,return_line_id,disposition,quantity,resolution,exchange_method) values ($1,$2,$3,$4,$5,$6)`,
    [id, r.line, disposition, quantity, resolution, exchange ? 'make' : null]);
  }

  const ranges = async (f: Fx): Promise<Range[]> => (await db().query(`select status,unit_from,unit_to,blocked_reasons
    from private.group_g_item_state_ranges($1) where order_item_id=$2 order by unit_from`, [[f.orderId], f.itemId])).rows;

  async function assertStates(f: Fx, counts: Record<string, number>) {
    const rs = await ranges(f);
    let end = 0;
    const actual: Record<string, number> = {};
    for (const r of rs) {
      expect(r.unit_from).toBe(end); // no gaps, no intersections
      expect(r.unit_to).toBeGreaterThan(r.unit_from);
      actual[r.status] = (actual[r.status] ?? 0) + r.unit_to - r.unit_from;
      end = r.unit_to;
    }
    expect(end).toBe(f.quantity);
    expect(actual).toEqual(counts);
    const aggregated = (await db().query(`select status,sum(quantity)::int as quantity
      from public.list_admin_order_item_states($1) where order_item_id=$2 group by status`, [[f.orderId], f.itemId])).rows;
    expect(Object.fromEntries(aggregated.map((r) => [r.status, r.quantity]))).toEqual(counts);
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  test.each(['unpaid', 'payment_expired', 'in_production', 'ready', 'shipped', 'delivered', 'cancel_requested',
    'cancelled', 'return_requested', 'return_in_progress', 'refund_waiting', 'returned'])('single state %s', async (state) => {
    const f = await fixture(state === 'unpaid' ? 'pending' : state === 'payment_expired' ? 'failed' : 'paid');
    if (state === 'payment_expired') await revision(f, 'stripe_voucher_expired', ['status'], 'failed');
    if (state === 'ready') await allocate(f, 6);
    if (state === 'cancel_requested') await cancelRequest(f, 6);
    if (state === 'cancelled') await refund(f, 6, 'succeeded');
    if (['shipped', 'delivered', 'return_requested', 'return_in_progress', 'refund_waiting', 'returned'].includes(state)) {
      const s = await ship(f, 6, 1, state === 'delivered');
      if (state.startsWith('return_') || state === 'refund_waiting' || state === 'returned') {
        const r = await returned(f, s, 6, state === 'return_requested' ? 'requested' : 'open');
        if (['refund_waiting', 'returned'].includes(state)) await receive(r, 6);
        if (state === 'returned') await refund(f, 6, 'succeeded', false, r.id);
      }
    }
    await assertStates(f, { [state]: 6 });
  });

  async function revision(f: Fx, reason: string, fields: string[], status: string, changedAt = '2026-10-24T00:00:00Z') {
    await db().query(`insert into public.order_revisions
      (order_id,operation,before_data,after_data,changed_fields,reason,changed_at)
      values ($1,'status_update','{}',$2::jsonb,$3,$4,$5)`,
    [f.orderId, JSON.stringify({ status }), fields, reason, changedAt]);
  }

  test('expiry uses latest actual failed status revision, including equal timestamp id order', async () => {
    const f = await fixture('failed');
    await assertStates(f, { unpaid: 6 });
    await revision(f, 'stripe_voucher_expired', ['status'], 'failed');
    await revision(f, 'irrelevant', ['review_reason'], 'failed');
    await revision(f, 'irrelevant', ['status'], 'pending');
    await assertStates(f, { payment_expired: 6 });
    await revision(f, 'ordinary_failure', ['status'], 'failed');
    await assertStates(f, { unpaid: 6 });
    await revision(f, 'stripe_voucher_expired', ['status'], 'failed', '2026-10-23T00:00:00Z');
    await assertStates(f, { unpaid: 6 });
  });

  test.each(['payment_in_progress', 'abandoned'])('%s is hidden', async (status) => {
    const f = await fixture(status);
    expect(await ranges(f)).toEqual([]);
    expect((await db().query('select * from public.list_admin_order_item_states($1)', [[f.orderId]])).rows).toEqual([]);
  });

  test('partial shipment/delivery/cancel/request/A/unallocated are exclusive and H is not ready', async () => {
    const f = await fixture('paid', 10);
    await ship(f, 2, 1, true); await ship(f, 2, 2); await ship(f, 1, 3, false, true);
    await allocate(f, 3); await refund(f, 1, 'pending'); await cancelRequest(f, 1);
    await assertStates(f, { delivered: 2, shipped: 2, cancelled: 1, cancel_requested: 1, in_production: 1, ready: 3 });
    const held = await fixture('pending'); await allocate(held, 6, 'payment_hold');
    await assertStates(held, { unpaid: 6 });
  });

  test.each(['awaiting_response', 'pending', 'succeeded', 'error', 'failed'])('before shipment refund %s', async (status) => {
    const f = await fixture(); await allocate(f, 2); await refund(f, 3, status);
    const covered = ['awaiting_response', 'pending', 'succeeded'].includes(status);
    await assertStates(f, covered ? { cancelled: 3, in_production: 1, ready: 2 } : { in_production: 4, ready: 2 });
    expect((await ranges(f)).filter((r) => r.status === 'cancelled').every((r) =>
      r.blocked_reasons.includes('refund_processing') === ['awaiting_response', 'pending'].includes(status))).toBe(true);
  });

  test('aggregation separates identical statuses with different blocked reasons', async () => {
    const f = await fixture(); await refund(f, 1, 'pending'); await refund(f, 1, 'succeeded');
    await assertStates(f, { cancelled: 2, in_production: 4 });
    const rows = (await db().query(`select quantity,blocked_reasons from public.list_admin_order_item_states($1)
      where order_item_id=$2 and status='cancelled' order by cardinality(blocked_reasons)`, [[f.orderId], f.itemId])).rows;
    expect(rows).toEqual([{ quantity: 1, blocked_reasons: [] }, { quantity: 1, blocked_reasons: ['refund_processing'] }]);
  });

  test('cancel request covers A without releasing it, decline restores actual A', async () => {
    const f = await fixture(); await allocate(f, 6); const id = await cancelRequest(f, 2);
    await assertStates(f, { cancel_requested: 2, ready: 4 });
    expect((await db().query('select sum(remaining_quantity)::int n from public.order_item_allocations where order_item_id=$1', [f.itemId])).rows[0].n).toBe(6);
    const before = await capture(f); const op = await operation();
    await db().query(`update public.order_cancel_requests set status='declined',declined_at=now(),decline_reason='other',
      decline_message='fixture' where id=$1`, [id]);
    expect(await record(f, before, op, 1)).toBe(1);
    await assertStates(f, { ready: 6 });
    expect((await events(f))[0]).toMatchObject({ from_status: 'cancel_requested', to_status: 'ready', quantity: 2 });
  });

  test('full refund cancelled order still derives shipped and actual delivered units', async () => {
    const f = await fixture('cancelled'); await ship(f, 3, 1, true); await ship(f, 3, 2);
    await refund(f, 6, 'succeeded', false);
    await assertStates(f, { delivered: 3, shipped: 3 });
    const unpaid = await fixture('cancelled'); await assertStates(unpaid, { cancelled: 6 });
  });

  test('mixed returns within each shipment, no processed/refundCovered double count', async () => {
    const f = await fixture('paid', 10); const s = await ship(f, 10, 1, true);
    const done = await returned(f, s, 2, 'open', 1); await receive(done, 2); await refund(f, 2, 'succeeded', false, done.id);
    const waiting = await returned(f, s, 2, 'open', 2); await receive(waiting, 2);
    await returned(f, s, 2, 'open', 3); await returned(f, s, 1, 'requested', 4);
    await assertStates(f, { returned: 2, refund_waiting: 2, return_in_progress: 2, return_requested: 1, delivered: 3 });
  });

  test.each(['pending', 'awaiting_response', 'succeeded', 'failed', 'error'])('received refund %s is not manager consultation when amount fixed', async (status) => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 6, 'not_restocked', 'now'); await refund(f, 6, status, false, r.id);
    await assertStates(f, { [status === 'succeeded' ? 'returned' : 'return_in_progress']: 6 });
    expect((await ranges(f))[0].blocked_reasons.includes('refund_processing')).toBe(['pending', 'awaiting_response'].includes(status));
  });

  test('failed amount decision stays in progress, only still undecided consultation is waiting', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 6); await assertStates(f, { refund_waiting: 6 });
    await refund(f, 2, 'failed', false, r.id);
    await assertStates(f, { refund_waiting: 4, return_in_progress: 2 });
    // Retrying the same failed quantity does not grow the amount-decided subset.
    await refund(f, 2, 'error', false, r.id);
    await assertStates(f, { refund_waiting: 4, return_in_progress: 2 });
    expect((await ranges(f)).every((r) => !r.blocked_reasons.includes('refund_processing'))).toBe(true);
  });

  test('inspection remains in progress, missing and sent back are completed', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 2, 'pending_inspection'); await receive(r, 2, 'missing'); await receive(r, 2, 'sent_back', 'none');
    await assertStates(f, { returned: 4, return_in_progress: 2 });
  });

  test.each(['pending', 'awaiting_response'])('inspection waiting with refund %s keeps quantities and marks refund_processing', async (status) => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 6, 'pending_inspection', 'now');
    await assertStates(f, { return_in_progress: 6 });
    expect((await ranges(f))[0].blocked_reasons).toEqual([]);
    await refund(f, 6, status, false, r.id);
    await assertStates(f, { return_in_progress: 6 });
    expect(await ranges(f)).toEqual([{ status: 'return_in_progress', unit_from: 0, unit_to: 6,
      blocked_reasons: ['refund_processing'] }]);
    expect((await db().query(`select status,quantity,blocked_reasons from public.list_admin_order_item_states($1)
      where order_item_id=$2`, [[f.orderId], f.itemId])).rows)
      .toEqual([{ status: 'return_in_progress', quantity: 6, blocked_reasons: ['refund_processing'] }]);
  });

  test('only the pending-refund portion of inspection waiting is marked, without changing status quantities', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 4);
    await receive(r, 4, 'pending_inspection', 'now');
    await assertStates(f, { return_in_progress: 4, shipped: 2 });
    await refund(f, 2, 'pending', false, r.id);
    await assertStates(f, { return_in_progress: 4, shipped: 2 });
    expect(await ranges(f)).toEqual([
      { status: 'return_in_progress', unit_from: 0, unit_to: 2, blocked_reasons: ['refund_processing'] },
      { status: 'return_in_progress', unit_from: 2, unit_to: 4, blocked_reasons: [] },
      { status: 'shipped', unit_from: 4, unit_to: 6, blocked_reasons: [] },
    ]);
  });

  test('inspection waiting after a succeeded refund remains in progress without refund_processing', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 6, 'pending_inspection', 'now'); await refund(f, 6, 'succeeded', false, r.id);
    await assertStates(f, { return_in_progress: 6 });
    expect((await ranges(f))[0].blocked_reasons).toEqual([]);
  });

  test('inspection of exchange units does not subtract consultation of refund units', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 2, 'pending_inspection', 'none', true);
    await receive(r, 4);
    await assertStates(f, { refund_waiting: 4, return_in_progress: 2 });
  });

  test('exchange completion and refund waiver finish only their own quantities', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 6);
    await receive(r, 2, 'not_restocked', 'none', true); await receive(r, 2);
    const id = (await db().query(`insert into public.order_return_receipts
      (return_id,request_key,request_fingerprint,kind) values ($1,$2,'fixture','waive_refund') returning id`,
    [r.id, randomUUID()])).rows[0].id;
    await db().query(`insert into public.order_return_receipt_lines
      (receipt_id,return_line_id,disposition,quantity) values ($1,$2,'refund_waived',2)`, [id, r.line]);
    await assertStates(f, { returned: 4, return_in_progress: 2 });
  });

  test('NULL variant, review hold and exchange fee blockers; independent exchange item', async () => {
    const f = await fixture(); const s = await ship(f, 1); const r = await returned(f, s, 1);
    await db().query('update public.order_returns set fee_due_amount=100 where id=$1', [r.id]);
    const before = await capture(f);
    const itemId = (await db().query(`insert into public.order_items
      (order_id,item_id,variant_id,item_name,item_price,quantity,line_total,fulfillment_type,line_kind,
       exchange_return_line_id,exchange_paid_amount)
      values ($1,$2,null,'fixture',0,2,0,'backorder','exchange',$3,5000) returning id`,
    [f.orderId, f.catalogId, r.line])).rows[0].id as string;
    await assertStates({ ...f, itemId, quantity: 2 }, { in_production: 2 });
    expect((await ranges({ ...f, itemId }))[0].blocked_reasons).toEqual(['variant_missing', 'exchange_fee_waiting']);
    expect(await record(f, before, await operation(), 1)).toBe(1);
    expect((await events({ ...f, itemId }))[0]).toMatchObject({ from_status: null, to_status: 'in_production', quantity: 2 });
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await db().query(`select private.ensure_group_g_payment_review_hold($1,'g1-test',null,null,null)`, [f.orderId]);
    expect((await ranges(f)).every((r) => r.blocked_reasons.includes('payment_review'))).toBe(true);
  });

  // Task 3 M4: closed and cancelled returns, adjacent intervals that differ only by blocked reason, non-exchange NULL variant.
  test('cancelled return gives its units back to the shipment state; a closed return keeps only what it finished', async () => {
    const f = await fixture(); const s = await ship(f, 6, 1, true);
    const cancelled = await returned(f, s, 2, 'open', 1);
    await assertStates(f, { return_in_progress: 2, delivered: 4 });
    await db().query(`update public.order_returns set status='cancelled', cancelled_at=now() where id=$1`, [cancelled.id]);
    await assertStates(f, { delivered: 6 });
    const closed = await returned(f, s, 3, 'open', 2);
    await receive(closed, 2); await receive(closed, 1, 'missing');
    await refund(f, 2, 'succeeded', false, closed.id);
    await db().query(`update public.order_returns set status='closed', closed_at=now() where id=$1`, [closed.id]);
    await assertStates(f, { returned: 3, delivered: 3 });
  });

  test('adjacent intervals that differ only by blocked reason stay separate, and a reason-only change records no event', async () => {
    const f = await fixture('paid', 2);
    const pending = await refund(f, 1, 'pending'); await refund(f, 1, 'succeeded');
    const split = await ranges(f);
    expect(split).toHaveLength(2);
    expect(split.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect(split[0].unit_to).toBe(split[1].unit_from);
    expect(split.map((r) => r.blocked_reasons).sort((a, b) => a.length - b.length)).toEqual([[], ['refund_processing']]);
    const before = await capture(f); const op = await operation();
    await db().query(`update public.order_refunds set status='succeeded', succeeded_at=now() where id=$1`, [pending]);
    expect(await ranges(f)).toEqual([{ status: 'cancelled', unit_from: 0, unit_to: 2, blocked_reasons: [] }]);
    expect(await record(f, before, op, 1)).toBe(0);
    expect(await events(f)).toEqual([]);
  });

  test('a non-exchange line without a variant waits as variant_missing (never stock_shortage) and FIFO skips it', async () => {
    const c = await createCatalogFixture(db(), { stock: 5 });
    const o = await insertOrderWithLines(db(), { status: 'paid', paidAmount: 10000,
      lines: [{ itemId: c.itemId, variantId: null, quantity: 2, fulfillmentType: 'stock', reserved: false }] });
    const f: Fx = { orderId: o.orderId, itemId: o.orderItemIds[0], variantId: c.variantId, catalogId: c.itemId, quantity: 2 };
    expect((await db().query(`select line_kind <> 'exchange' as ordinary, exchange_return_line_id, variant_id
      from public.order_items where id=$1`, [f.itemId])).rows).toEqual([{ ordinary: true, exchange_return_line_id: null, variant_id: null }]);
    await assertStates(f, { in_production: 2 });
    expect(await ranges(f)).toEqual([{ status: 'in_production', unit_from: 0, unit_to: 2, blocked_reasons: ['variant_missing'] }]);
    const op = await operation();
    expect((await db().query('select private.allocate_group_g_fifo($1,$2,null) as n', [[c.variantId], op])).rows[0].n).toBe(0);
    expect((await db().query('select stock_quantity from public.item_variants where id=$1', [c.variantId])).rows[0].stock_quantity).toBe(5);
  });

  test('payment-review hold on an unallocated non-NULL variant yields payment_review without stock_shortage', async () => {
    await db().query('select pg_advisory_xact_lock(190521,1)');
    const f = await fixture();
    expect((await ranges(f))[0].blocked_reasons).toEqual(['stock_shortage']);
    await db().query(`select private.ensure_group_g_payment_review_hold($1,'g1-test',null,null,null)`, [f.orderId]);
    await assertStates(f, { in_production: 6 });
    const rows = await ranges(f);
    expect(rows).toEqual([{ status: 'in_production', unit_from: 0, unit_to: 6, blocked_reasons: ['payment_review'] }]);
    expect(rows.every((r) => !r.blocked_reasons.includes('stock_shortage'))).toBe(true);
    expect((await db().query(`select blocked_reasons from public.list_admin_order_item_states($1)
      where order_item_id=$2`, [[f.orderId], f.itemId])).rows).toEqual([{ blocked_reasons: ['payment_review'] }]);
  });

  const capture = async (f: Fx) => (await db().query('select private.capture_group_g_item_states($1) as value', [[f.orderId]])).rows[0].value;
  const record = async (f: Fx, before: unknown, op: string, sequence: number, reason = 'test') =>
    (await db().query('select private.record_group_g_item_state_changes($1::jsonb,$2,$3,$4,$5,$6) as n',
      [JSON.stringify(before), [f.orderId], op, sequence, reason, null])).rows[0].n as number;
  const events = async (f: Fx) => (await db().query(`select unit_from,unit_to,quantity,from_status,to_status,
    sequence,version::int,reason from public.order_item_state_events where order_item_id=$1 order by version`, [f.itemId])).rows;

  test('projection and capture/record accept 201 real orders; only the read entry points retain the 200-order limit', async () => {
    await db().query('select pg_advisory_xact_lock(190521,1)');
    const catalog = await createCatalogFixture(db(), { stock: 0 });
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) {
      const o = await insertOrderWithLines(db(), { status: 'pending', lines: [{ itemId: catalog.itemId,
        variantId: catalog.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
      ids.push(o.orderId);
    }
    const locked = (await db().query('select private.lock_group_g_inventory($1,$2) as ids', [[catalog.variantId], ids])).rows[0].ids;
    expect(locked).toEqual([...ids].sort());
    expect((await db().query('select count(*)::int as n from private.group_g_item_state_ranges($1)', [ids])).rows[0].n).toBe(201);
    const before = (await db().query('select private.capture_group_g_item_states($1) as states', [ids])).rows[0].states;
    expect(before).toHaveLength(201);
    expect(before.every((r: { status: string }) => r.status === 'unpaid')).toBe(true);
    const op = await operation();
    await setOrderStatusForFixture(db(), ids, 'paid');
    const params = [JSON.stringify(before), ids, op, 1, 'payment_201_test', null];
    const recordSql = 'select private.record_group_g_item_state_changes($1::jsonb,$2,$3,$4,$5,$6) as n';
    expect((await db().query(recordSql, params)).rows[0].n).toBe(201);
    expect((await db().query(recordSql, params)).rows[0].n).toBe(0);
    expect((await db().query(`select from_status,to_status,count(*)::int as n,sum(quantity)::int as quantity,
      count(distinct order_item_id)::int as items,min(version)::int as first_version,max(version)::int as last_version
      from public.order_item_state_events where operation_id=$1 group by from_status,to_status`, [op])).rows)
      .toEqual([{ from_status: 'unpaid', to_status: 'in_production', n: 201, quantity: 201, items: 201, first_version: 1, last_version: 1 }]);
    const after = (await db().query('select private.capture_group_g_item_states($1) as states', [ids])).rows[0].states;
    expect(after).toHaveLength(201);
    expect(after.every((r: { status: string }) => r.status === 'in_production')).toBe(true);
    expect((await db().query('select count(*)::int as n from public.list_admin_order_item_states($1)', [ids.slice(0, 200)])).rows[0].n).toBe(200);
    for (const sql of ['select * from private.list_admin_order_item_states($1)', 'select * from public.list_admin_order_item_states($1)']) {
      await db().query('savepoint read_limit');
      try { await expect(db().query(sql, [ids])).rejects.toMatchObject({ code: '22023', message: 'TOO_MANY_ORDERS' }); }
      finally {
        await db().query('rollback to savepoint read_limit');
        await db().query('release savepoint read_limit');
      }
    }
    await db().query('set constraints all immediate');
  }, 20000);

  test('no backfill, no-op zero, changed intersections only, adjacent transitions merged, retry zero', async () => {
    const f = await fixture(); const before = await capture(f); const op = await operation();
    expect(await events(f)).toEqual([]);
    expect(await record(f, before, op, 1)).toBe(0);
    await allocate(f, 2);
    expect(await record(f, before, op, 2)).toBe(1);
    expect(await record(f, before, op, 2)).toBe(0);
    expect(await events(f)).toEqual([{ unit_from: 4, unit_to: 6, quantity: 2, from_status: 'in_production',
      to_status: 'ready', sequence: 2, version: 1, reason: 'test' }]);
    // Blockers may change without a status change; the state table cannot encode that as a transition.
    const unchanged = await capture(f); await db().query('select pg_advisory_xact_lock(190521,1)');
    await db().query(`select private.ensure_group_g_payment_review_hold($1,'g1-test',null,null,null)`, [f.orderId]);
    expect(await record(f, unchanged, op, 3)).toBe(0);
  });

  test('one operation records payment then FIFO separately; versions increment for each item event', async () => {
    const f = await fixture('pending'); const op = await operation(); const unpaid = await capture(f);
    await setOrderStatusForFixture(db(), [f.orderId], 'paid', { paidAmount: 30000 });
    expect(await record(f, unpaid, op, 1)).toBe(1);
    const paid = await capture(f); await allocate(f, 2); expect(await record(f, paid, op, 2)).toBe(1);
    expect((await events(f)).map((r) => [r.from_status, r.to_status, r.sequence, r.version])).toEqual([
      ['unpaid', 'in_production', 1, 1], ['in_production', 'ready', 2, 2],
    ]);
  });

  test('multiple changed intervals increment versions, preserving unchanged middle units', async () => {
    const f = await fixture(); await allocate(f, 2); const before = await capture(f); const op = await operation();
    await refund(f, 1, 'pending'); await allocate(f, 1);
    expect(await record(f, before, op, 1)).toBe(2);
    expect((await events(f)).map((r) => [r.unit_from, r.unit_to, r.from_status, r.to_status, r.version])).toEqual([
      [0, 1, 'in_production', 'cancelled', 1], [3, 4, 'in_production', 'ready', 2],
    ]);
  });

  test('refund failure removes overlay and records the actual remaining A and shortage', async () => {
    const f = await fixture(); await allocate(f, 2); const id = await refund(f, 5, 'pending');
    const before = await capture(f); const op = await operation();
    await db().query(`update public.order_refunds set status='failed' where id=$1`, [id]);
    expect(await record(f, before, op, 1)).toBe(2);
    await assertStates(f, { in_production: 4, ready: 2 });
    expect((await events(f)).map((r) => [r.quantity, r.from_status, r.to_status])).toEqual([
      [4, 'cancelled', 'in_production'], [1, 'cancelled', 'ready'],
    ]);
  });

  test('history and the cause roll back together', async () => {
    const f = await fixture(); const before = await capture(f);
    await db().query('savepoint cause'); const op = await operation(); await allocate(f, 2);
    expect(await record(f, before, op, 1)).toBe(1);
    await db().query('rollback to savepoint cause');
    expect(await events(f)).toEqual([]); await assertStates(f, { in_production: 6 });
  });

  test('newly visible units use NULL; leaving visibility uses NULL; old history is never a baseline', async () => {
    const f = await fixture('payment_in_progress'); const hidden = await capture(f); const op = await operation();
    await setOrderStatusForFixture(db(), [f.orderId], 'pending');
    expect(await record(f, hidden, op, 1)).toBe(1);
    expect((await events(f))[0]).toMatchObject({ from_status: null, to_status: 'unpaid', version: 1 });
    // Leaving visibility: J-19 allows no visible -> hidden transition, so no trigger is bypassed. A second order in
    // payment_in_progress becomes pending inside a savepoint only to capture its visible snapshot, is rolled back to
    // hidden, and then takes the allowed payment_in_progress -> abandoned; the recorder compares that snapshot with
    // the hidden result and writes the NULL target (with or without J-19).
    const g = await fixture('payment_in_progress');
    await db().query('savepoint visible_snapshot');
    await setOrderStatusForFixture(db(), [g.orderId], 'pending');
    const before = await capture(g);
    expect(before.every((r: { status: string }) => r.status === 'unpaid')).toBe(true);
    await db().query('rollback to savepoint visible_snapshot');
    await setOrderStatusForFixture(db(), [g.orderId], 'abandoned');
    expect(await ranges(g)).toEqual([]);
    expect(await record(g, before, op, 2)).toBe(1);
    expect(await events(g)).toEqual([expect.objectContaining({ from_status: 'unpaid', to_status: null, version: 1, sequence: 2 })]);
    expect(await events(f)).toHaveLength(1);
  });

  test('declined return restores delivered with reason, without delivery timestamp or event fabrication', async () => {
    const f = await fixture(); const s = await ship(f, 6); const r = await returned(f, s, 2, 'requested');
    const before = await capture(f); const op = await operation();
    await db().query(`update public.order_returns set status='declined',declined_at=now(),decline_reason='other',
      decline_message='fixture' where id=$1`, [r.id]);
    expect(await record(f, before, op, 1, 'return_declined_restore')).toBe(1);
    await assertStates(f, { delivered: 2, shipped: 4 });
    expect((await events(f))[0]).toMatchObject({ quantity: 2, from_status: 'return_requested', to_status: 'delivered',
      reason: 'return_declined_restore' });
    expect((await db().query('select delivered_at from public.order_fulfillments where id=$1', [s])).rows[0].delivered_at).toBeNull();
    expect((await db().query('select count(*)::int n from public.order_fulfillment_events where fulfillment_id=$1', [s])).rows[0].n).toBe(0);
  });

  test('repeated declined requests cover the same virtual units, within their own shipment', async () => {
    const f = await fixture(); const first = await ship(f, 3); await ship(f, 3, 2);
    await returned(f, first, 2, 'declined', 1); await returned(f, first, 1, 'declined', 2);
    await assertStates(f, { delivered: 2, shipped: 4 });
  });

  test('NULL/empty RPC and 201-order rejection, exact owner/security/ACLs and pre-request permissions', async () => {
    for (const ids of [null, []]) expect((await db().query('select * from public.list_admin_order_item_states($1)', [ids])).rows).toEqual([]);
    await db().query('savepoint too_many');
    let code: string | undefined; let safeMessage: string | undefined;
    try { await db().query('select * from public.list_admin_order_item_states($1)', [Array.from({ length: 201 }, () => randomUUID())]); }
    catch (e) { const err = e as { code: string; message: string }; code = err.code;
      safeMessage = err.message === 'TOO_MANY_ORDERS' ? err.message : 'UNEXPECTED'; }
    finally { await db().query('rollback to savepoint too_many'); }
    expect([code, safeMessage]).toEqual(['22023', 'TOO_MANY_ORDERS']);
    const signatures = ['private.group_g_item_state_ranges(uuid[])', 'private.list_admin_order_item_states(uuid[])',
      'public.list_admin_order_item_states(uuid[])', 'private.capture_group_g_item_states(uuid[])',
      'private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)'];
    for (const signature of signatures) {
      const p = (await db().query(`select pg_get_userbyid(proowner) as owner,prosecdef,proconfig,
        has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as auth,
        has_function_privilege('service_role',oid,'execute') as service,
        exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0) as public
        from pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
      expect(p).toEqual({ owner: 'postgres', prosecdef: !signature.startsWith('public.'), proconfig: ['search_path=""'],
        anon: false, auth: false, service: signature.includes('.list_admin_'), public: false });
    }
    const f = await fixture();
    await db().query('set local role service_role');
    expect((await db().query('select sum(quantity)::int n from public.list_admin_order_item_states($1)', [[f.orderId]])).rows[0].n).toBe(6);
    await db().query('reset role');
    for (const role of ['anon', 'authenticated']) expect((await db().query('select has_schema_privilege($1,\'private\',\'usage\') as ok', [role])).rows[0].ok).toBe(true);
  });
});
