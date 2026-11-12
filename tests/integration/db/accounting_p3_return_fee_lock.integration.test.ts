/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { seedHMember } from './helpers/group-h-fixtures';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder } from './helpers/order-fixtures';
import { createUbReturn, ubReceive } from './helpers/unit-binding-receive';

// Accounting plan 3 S16 (FREQ-578-AC-05): the fixed return fees (the shop-label return shipping fee, the exchange fee
// and the exchange shipping fee) are held at 0 by the database until the journal rules for them are designed. The
// percentage restocking fee stays.
jest.setTimeout(60000);

type DbFailure = { code?: string; constraint?: string };

async function refusal(db: PgClient, work: string | (() => Promise<unknown>), params: unknown[] = []): Promise<DbFailure | null> {
  await db.query('savepoint acc_fee_lock_try');
  try {
    await (typeof work === 'string' ? db.query(work, params) : work());
    return null;
  } catch (error) {
    const e = error as DbFailure;
    return { code: e.code, constraint: e.constraint };
  } finally {
    await db.query('rollback to savepoint acc_fee_lock_try');
    await db.query('release savepoint acc_fee_lock_try');
  }
}

/** A shipped order of one unit at 999 yen without unit rows (the percentage is cut down: 999 * 10 / 100 = 99). */
async function shippedOrder(db: PgClient) {
  await db.query('select pg_advisory_xact_lock(190521,1)');
  const actor = await seedHMember(db);
  const catalog = await createCatalogFixture(db, { stock: 3 });
  const order = await insertOrderWithLines(db, { status: 'paid', shippingAmount: 0, discountAmount: 0, paidAmount: 999,
    paymentIntentId: `pi_fee_lock_${randomUUID()}`,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 1, itemPrice: 999, fulfillmentType: 'stock' }] });
  const itemId = order.orderItemIds[0];
  const fulfillment = await shipFixtureOrder(db, { orderId: order.orderId, actorId: actor, trackingNumber: 'FEE-LOCK',
    lines: [{ order_item_id: itemId, quantity: 1 }] });
  return { orderId: order.orderId, itemId, actor, fulfillment, catalog };
}

describeLocalDb('FREQ-578-AC-05: S16 fee lock (controller only)', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  const settingsLock = { code: '23514', constraint: 'acc_p3_fee_lock_settings' };
  const returnsLock = { code: '23514', constraint: 'acc_p3_fee_lock_returns' };

  test('FREQ-578-AC-05: 返送料の定額を0でない値にする設定をDBが断る', async () => {
    expect(await refusal(db(), 'update public.shop_return_settings set shop_label_fee = 800 where id = 1')).toEqual(settingsLock);
    expect(await refusal(db(), 'update public.shop_return_settings set shop_label_fee = 0 where id = 1')).toBeNull();
  });

  test('FREQ-578-AC-05: 交換の手数料・交換の送料・交換の手数料の有効化を断る', async () => {
    expect(await refusal(db(), 'update public.shop_return_settings set exchange_fees_enabled = true where id = 1')).toEqual(settingsLock);
    expect(await refusal(db(), 'update public.shop_return_settings set exchange_fee = 500 where id = 1')).toEqual(settingsLock);
    expect(await refusal(db(), 'update public.shop_return_settings set exchange_shipping_fee = 300 where id = 1')).toEqual(settingsLock);
    expect((await db().query(`select shop_label_fee, exchange_fees_enabled, exchange_fee, exchange_shipping_fee
      from public.shop_return_settings where id = 1`)).rows[0])
      .toEqual({ shop_label_fee: 0, exchange_fees_enabled: false, exchange_fee: 0, exchange_shipping_fee: 0 });
  });

  test('FREQ-578-AC-05: 返品の行に0でない返送料・交換の手数料・交換の送料を新しく入れると断る', async () => {
    const f = await shippedOrder(db());
    const insert = (column: string, value: number) => refusal(db(), `insert into public.order_returns
      (order_id, number, source, status, request_key, request_fingerprint, requested_at, requested_by, return_method,
       return_shipping_payer, notify_customer, ${column})
      values ($1, 1, 'customer_request', 'requested', $2, 'fee-lock', now(), $3, 'shop_label', 'customer', false, $4)`,
    [f.orderId, randomUUID(), f.actor, value]);
    expect(await insert('return_shipping_fee', 800)).toEqual(returnsLock);
    expect(await insert('exchange_fee', 500)).toEqual(returnsLock);
    expect(await insert('exchange_shipping_fee', 300)).toEqual(returnsLock);
    expect(await insert('return_shipping_fee', 0)).toBeNull();
    // The approval writes the fees of a requested return: a non-zero fixed fee is refused there too.
    expect(await refusal(db(), () => createUbReturn(db(), f, [{ quantity: 1 }], { fixed: 800 }))).toEqual(returnsLock);
    expect(await refusal(db(), () => createUbReturn(db(), f, [{ quantity: 1 }]))).toBeNull();
  });

  test('FREQ-578-AC-05: 割合の手数料は今のとおり設定でき、受け取りで切り捨てて計算される', async () => {
    expect(await refusal(db(), `update public.shop_return_settings set restocking_fee_enabled = true, restocking_fee_percent = 10
      where id = 1`)).toBeNull();
    const f = await shippedOrder(db());
    const ret = await createUbReturn(db(), f, [{ quantity: 1 }], { percent: 10 });
    expect((await db().query(`select restocking_fee_percent, return_shipping_fee, exchange_fee, exchange_shipping_fee
      from public.order_returns where id = $1`, [ret.returnId])).rows[0])
      .toEqual({ restocking_fee_percent: 10, return_shipping_fee: 0, exchange_fee: 0, exchange_shipping_fee: 0 });
    const received = await ubReceive(db(), { returnId: ret.returnId, actorId: f.actor, choice: 'now',
      units: [{ return_line_id: ret.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' }] });
    // 999 * 10 / 100 = 99.9 is cut down to 99.
    expect(received.refund_amount).toBe(900);
    expect((await db().query('select return_fee_deduction from public.order_refunds where id = $1', [received.refund_id])).rows[0])
      .toEqual({ return_fee_deduction: 99 });
  });
});
