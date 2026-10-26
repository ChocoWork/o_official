import { randomUUID } from 'node:crypto';
import type { PgClient } from './local-db';
import { createCatalogFixture, insertRestockMovement, insertOrderWithLines, insertRefundRecord, insertReturnRecord,
  insertReturnReceipt, insertReturnRefund, insertCancelRequest, type RefundFixtureStatus } from './order-fixtures';
import { seedGroupG1Allocation, seedGroupG1Shipment, setOrderStatusForFixture, isInTransaction, holdsCommonLock } from './group-g1-fixtures';
import { seedGroupG3ReadyOrder, setGroupG3PaidAt } from './group-g3-fixtures';

/** Caller owns BEGIN, the common advisory lock and ROLLBACK; legal snapshots are fixed at INSERT. */
export async function seedGroupG4MixedOrder(client: PgClient, input: {
  email: string; createdAt?: string; itemPrice?: number; quantity?: number; shipped?: number;
  delivered?: number; ready?: number; inProduction?: number; cancelRequested?: number;
  discountAmount?: number; shippingAmount?: number; refundedAmount?: number;
  paymentIntentId?: string; status?: string; variantMissing?: boolean;
  shipping?: Parameters<typeof insertOrderWithLines>[1]['shipping'];
  extraLines?: number;
}) {
  const shipped = input.shipped ?? 0;
  const delivered = input.delivered ?? 0;
  const ready = input.ready ?? 0;
  const quantity = input.quantity ?? shipped + delivered + ready + (input.inProduction ?? 0);
  const price = input.itemPrice ?? 5000;
  const simple = price === 5000 && !input.discountAmount && !input.shippingAmount && !input.refundedAmount
    && !input.paymentIntentId && !input.status && !input.variantMissing && !input.extraLines;
  let material: { orderId: string; orderItemId: string; orderItemIds: string[]; itemId: number; variantId: number };
  if (simple) {
    material = await seedGroupG3ReadyOrder(client, { email: input.email, createdAt: input.createdAt,
      quantity, allocated: shipped + delivered + ready, shipping: input.shipping });
  } else {
    const catalog = await createCatalogFixture(client, { stock: quantity * (1 + (input.extraLines ?? 0)) + 20 });
    const order = await insertOrderWithLines(client, { status: 'pending', shippingEmail: input.email,
      createdAt: input.createdAt, shipping: input.shipping, discountAmount: input.discountAmount,
      shippingAmount: input.shippingAmount, refundedAmount: input.refundedAmount, paymentIntentId: input.paymentIntentId,
      lines: Array.from({ length: 1 + (input.extraLines ?? 0) }, () => ({ itemId: catalog.itemId,
        variantId: input.variantMissing ? null : catalog.variantId, itemPrice: price, quantity,
        fulfillmentType: 'stock' as const, reserved: false })) });
    await setGroupG3PaidAt(client, order.orderId, '2026-10-20T00:00:00Z');
    await setOrderStatusForFixture(client, [order.orderId], input.status ?? 'paid', {
      paidAmount: price * quantity * (1 + (input.extraLines ?? 0)) + (input.shippingAmount ?? 0) - (input.discountAmount ?? 0),
    });
    material = { ...catalog, ...order, orderItemId: order.orderItemIds[0] };
    if (shipped + delivered + ready > 0) await seedGroupG1Allocation(client,
      { orderItemId: material.orderItemId, quantity: shipped + delivered + ready, kind: 'paid' });
  }
  const shipments: string[] = [];
  if (delivered) shipments.push(await seedGroupG1Shipment(client, { orderId: material.orderId,
    lines: [{ orderItemId: material.orderItemId, quantity: delivered }],
    shippedAt: '2026-10-21T00:00:00Z', deliveredAt: '2026-10-22T00:00:00Z' }));
  if (shipped) shipments.push(await seedGroupG1Shipment(client, { orderId: material.orderId,
    lines: [{ orderItemId: material.orderItemId, quantity: shipped }], shippedAt: '2026-10-23T00:00:00Z' }));
  if (input.cancelRequested) await insertCancelRequest(client, { orderId: material.orderId,
    lines: [{ orderItemId: material.orderItemId, quantity: input.cancelRequested }] });
  return { ...material, shipments, email: input.email };
}

/** Only the supplied item's refunds are created; failed/pending records remain available as negative controls. */
export async function seedGroupG4Refund(client: PgClient, input: {
  orderItemId: string; quantity: number; amount: number; beforeShipment: boolean; returnId?: string;
  status?: RefundFixtureStatus; shippingAmount?: number; adjustmentAmount?: number;
}) {
  const orderId = (await client.query('select order_id from public.order_items where id=$1', [input.orderItemId])).rows[0].order_id as string;
  const amount = Math.max(1, input.amount + (input.shippingAmount ?? 0) + (input.adjustmentAmount ?? 0));
  // Monetary snapshots are immutable. Fix adjustment/shipping at INSERT rather than updating the header.
  if (input.adjustmentAmount || input.returnId && input.shippingAmount) {
    const result = await client.query(`insert into public.order_refunds
      (order_id,source,return_id,request_key,request_fingerprint,status,amount,shipping_amount,adjustment_amount,notify_customer)
      values($1,$2,$3,gen_random_uuid(),'fixture',$4,$5,$6,$7,false) returning id`,
    [orderId,input.returnId ? 'return' : 'admin',input.returnId ?? null,input.status ?? 'succeeded',amount,
      input.shippingAmount ?? 0,input.adjustmentAmount ?? 0]);
    const refundId = result.rows[0].id as string;
    await client.query(`insert into public.order_refund_lines(refund_id,order_item_id,quantity,before_shipment,restock_type,amount)
      values($1,$2,$3,$4,$5,$6)`,[refundId,input.orderItemId,input.quantity,input.beforeShipment,
      input.returnId ? 'return' : 'no_restock',input.amount]);
    return refundId;
  }
  const { refundId } = input.returnId ? await insertReturnRefund(client, { orderId, returnId: input.returnId,
    status: input.status ?? 'succeeded', amount,
    lines: [{ orderItemId: input.orderItemId, quantity: input.quantity, amount: input.amount }] })
    : await insertRefundRecord(client, { orderId, status: input.status ?? 'succeeded',
    amount,
    shippingAmount: input.shippingAmount,
    lines: [{ orderItemId: input.orderItemId, quantity: input.quantity, amount: input.amount,
      beforeShipment: input.beforeShipment, restockType: 'no_restock' }] });
  return refundId;
}

/** Receipt-backed returned range, using the established E-3 material instead of changing the G-1 projection. */
export async function seedGroupG4Return(client: PgClient, input: {
  orderId: string; orderItemId: string; fulfillmentId: string; quantity: number;
  resolution?: 'refund' | 'exchange'; exchangeVariantId?: number;
}) {
  const result = await insertReturnRecord(client, { orderId: input.orderId, lines: [{ ...input,
    resolution: input.resolution, exchangeVariantId: input.exchangeVariantId, exchangeMethod: 'make' }] });
  await insertReturnReceipt(client, { returnId: result.returnId,refundChoice: input.resolution === 'exchange' ? 'none' : 'consult',
    lines: [{ returnLineId: result.lineIds[0], quantity: input.quantity, disposition: 'not_restocked' }] });
  return result;
}

/** The legal exchange snapshot is zero; defensive price material requires a caller-owned savepoint. */
export async function seedGroupG4Exchange(client: PgClient, input: {
  orderId: string; sourceItemId: string; returnLineId: string; quantity?: number; itemPrice?: number;
}) {
  const id = randomUUID();
  await client.query(`insert into public.order_items
    (id,order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type,
     line_kind,exchange_return_line_id,exchange_paid_amount)
    select $1,$2,item_id,variant_id,item_name,$6,color,size,$3,0,'backorder','exchange',$4,1000
    from public.order_items where id=$5`,
  [id, input.orderId, input.quantity ?? 1, input.returnLineId, input.sourceItemId, input.itemPrice ?? 0]);
  return id;
}

/**
 * Defensive read material only. Current write bounds reject repeated same-unit refunds and T=0 fallback.
 * Keep the original relation and its guards intact, use a checked stand-in for just these items, and restore
 * all schema/data at the savepoint. No G-1 projection is replaced and no trigger is disabled.
 */
export async function withGroupG4RefundReadMaterial<T>(client: PgClient, orderItemIds: string[], run: () => Promise<T>): Promise<T> {
  if (!(await isInTransaction(client)) || !(await holdsCommonLock(client))) throw new Error('GROUP_G_FIXTURE_TRANSACTION_REQUIRED');
  const snapshot = async () => (await client.query(`select 'public.order_refund_lines'::regclass::oid as oid,
    (select tgenabled from pg_catalog.pg_trigger where tgrelid='public.order_refund_lines'::regclass
      and tgname='order_refund_lines_bounds_check') as bounds_mode,
    pg_catalog.to_regclass('public.g4_original_refund_lines')::oid as stand_in_oid`)).rows[0];
  const before = await snapshot();
  if (before.stand_in_oid !== null) throw new Error('GROUP_G_FIXTURE_STAND_IN_EXISTS');
  await client.query('savepoint g4_refund_read_material');
  try {
    await client.query(`alter table public.order_refund_lines rename to g4_original_refund_lines;
      create table public.order_refund_lines (like public.g4_original_refund_lines including all)`);
    await client.query('insert into public.order_refund_lines select * from public.g4_original_refund_lines where order_item_id=any($1::uuid[])', [orderItemIds]);
    return await run();
  } finally {
    await client.query('rollback to savepoint g4_refund_read_material');
    await client.query('release savepoint g4_refund_read_material');
    const after = await snapshot();
    if (after.oid !== before.oid || after.bounds_mode !== before.bounds_mode || after.stand_in_oid !== null)
      throw new Error('GROUP_G_FIXTURE_RESTORE_FAILED');
  }
}

/** Fresh swap targets. Caller holds the common advisory and owns the transaction (including commit in concurrency tests). */
export async function seedGroupG4SwapPair(client: PgClient, input: {
  donorQuantity?: number; takerQuantity?: number; donorParts?: number[]; freeStock?: number;
  catalog?: Pick<Awaited<ReturnType<typeof createCatalogFixture>>, 'itemId' | 'variantId'>;
  donorCreatedAt?: string; takerCreatedAt?: string;
  donorStatus?: string; takerStatus?: string; donorVariantMissing?: boolean; takerVariantMissing?: boolean;
  differentVariant?: boolean; donorReview?: boolean; takerReview?: boolean;
  donorCancelRequested?: number; takerCancelRequested?: number; donorRefundProcessing?: number;
  donorExchange?: boolean; takerExchange?: boolean; takerFeeWaiting?: boolean;
} = {}) {
  if (!(await isInTransaction(client)) || !(await holdsCommonLock(client))) throw new Error('GROUP_G_FIXTURE_TRANSACTION_REQUIRED');
  const donorQuantity = input.donorQuantity ?? 3;
  const takerQuantity = input.takerQuantity ?? 2;
  const sourceStock = (input.donorExchange ? donorQuantity : 0) + (input.takerExchange || input.takerFeeWaiting ? takerQuantity : 0);
  const catalog = input.catalog ?? await createCatalogFixture(client, { stock: donorQuantity + (input.freeStock ?? 0) + sourceStock });
  if (input.catalog) await insertRestockMovement(client, catalog.variantId, donorQuantity + sourceStock + (input.freeStock ?? 0));
  const other = input.differentVariant ? await createCatalogFixture(client, { stock: 0 }) : catalog;
  async function target(quantity: number, donor: boolean) {
    const exchange = donor ? input.donorExchange : input.takerExchange || input.takerFeeWaiting;
    const missing = donor ? input.donorVariantMissing : input.takerVariantMissing;
    const variant = donor ? catalog : other;
    const order = await insertOrderWithLines(client, { status: 'pending',
      createdAt: donor ? input.donorCreatedAt ?? '2026-10-18T00:00:00Z' : input.takerCreatedAt ?? '2026-10-19T00:00:00Z',
      lines: [{ itemId: variant.itemId, variantId: missing ? null : variant.variantId,
        quantity, fulfillmentType: 'stock', reserved: false }] });
    const requestedStatus = (donor ? input.donorStatus : input.takerStatus) ?? (exchange ? 'shipped' : 'paid');
    if (requestedStatus !== 'pending' && requestedStatus !== 'failed' && requestedStatus !== 'cancelled') {
      await setGroupG3PaidAt(client, order.orderId, '2026-10-20T00:00:00Z');
      await setOrderStatusForFixture(client, [order.orderId], 'paid', { paidAmount: 5000 * quantity });
    }
    let orderItemId = order.orderItemIds[0];
    if (exchange) {
      await seedGroupG1Allocation(client, { orderItemId, quantity, kind: 'paid' });
      const fulfillmentId = await seedGroupG1Shipment(client, { orderId: order.orderId,
        lines: [{ orderItemId, quantity }], shippedAt: '2026-10-21T00:00:00Z' });
      const ret = await insertReturnRecord(client, { orderId: order.orderId,
        feeDueAmount: !donor && input.takerFeeWaiting ? 100 : 0,
        lines: [{ fulfillmentId, orderItemId, quantity, resolution: 'exchange',
          exchangeVariantId: variant.variantId, exchangeMethod: 'make' }] });
      orderItemId = await seedGroupG4Exchange(client, { orderId: order.orderId, sourceItemId: orderItemId,
        returnLineId: ret.lineIds[0], quantity });
    }
    await setOrderStatusForFixture(client, [order.orderId], requestedStatus);
    const parts = donor && !missing ? input.donorParts ?? [quantity] : [];
    const allocations: string[] = [];
    for (let k = 0; k < parts.length; k++) {
      const id = await seedGroupG1Allocation(client, { orderItemId, quantity: parts[k], kind: 'paid',
        createdAt: k === 0 ? '2026-10-22T00:00:00Z' : '2026-10-23T00:00:00Z' });
      if (id) allocations.push(id);
    }
    const cancel = donor ? input.donorCancelRequested : input.takerCancelRequested;
    if (cancel) await insertCancelRequest(client, { orderId: order.orderId, lines: [{ orderItemId, quantity: cancel }] });
    if (donor && input.donorRefundProcessing) await seedGroupG4Refund(client, {
      orderItemId, quantity: input.donorRefundProcessing, amount: 5000 * input.donorRefundProcessing,
      beforeShipment: true, status: 'pending' });
    if (donor ? input.donorReview : input.takerReview) await client.query(
      "select private.ensure_group_g_payment_review_hold($1,'g4-swap',null,null,null)", [order.orderId]);
    return { orderId: order.orderId, orderItemId, allocations, ...variant };
  }
  const donor = await target(donorQuantity, true);
  const taker = await target(takerQuantity, false);
  // Fresh ordinary material has exactly the requested F, leaving FIFO no unrelated free stock.
  // Exchange source shipments consume their own units; the test observes the resulting F/A/H.
  return { ...catalog, donor, taker };
}
