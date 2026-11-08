/** @jest-environment node */
import { describeLocalDb } from './helpers/local-db';
import {
  confirmSlipAt, postManualEntryFixture, recordAllocationAt, seedPostedPayment, setAsideExistingSlips, setCutoverForTest,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 7 (FREQ-569 AC-04, FREQ-571 AC-05): the list of the deferred revenue carried over (design 2-e) and the list of
// the anomalies (design 2-a). ROLLBACK form (run with --runInBand). Rows another suite committed today are outside the dates used here,
// and the lists are checked by order number, so they cannot disturb the figures.
jest.setTimeout(240000);

type DeferredOrder = {
  order_id: string; order_number: string; balance: number; paid_on: string; unshipped_units: number; states: Record<string, number>;
};
type DeferredList = { orders: DeferredOrder[]; next_after_order: string | null; total_balance: number };
type Anomaly = { order_id: string; order_number: string; balance: number; reason: string };

describeLocalDb('S12 deferred revenue lists: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const postShipments = async () => { await q('select private.accounting_post_shipment_events(50)'); };
  const list = async (asOf: string, limit = 100, after: string | null = null) =>
    (await q('select public.list_deferred_revenue($1::date, $2::integer, $3::uuid) as r', [asOf, limit, after])).rows[0].r as DeferredList;
  /** Every order of the list, page by page. */
  const listAll = async (asOf: string, limit = 100) => {
    const orders: DeferredOrder[] = [];
    let after: string | null = null;
    let first: DeferredList | null = null;
    for (;;) {
      const next: DeferredList = await list(asOf, limit, after);
      first ??= next;
      orders.push(...next.orders);
      if (next.next_after_order === null) break;
      after = next.next_after_order;
    }
    return { orders, total: (first as DeferredList).total_balance };
  };
  const anomalies = async () => (await q('select public.list_deferred_revenue_anomalies() as r')).rows[0].r as { anomalies: Anomaly[] };
  const orderNumber = (orderId: string) => `ORD-${orderId.slice(0, 8).toUpperCase()}`;

  test('FREQ-569-AC-04: 繰り越した前受金の一覧が注文・額・出荷の見込みつきで出る', async () => {
    const open = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-12-20T03:00:00Z' });
    const part = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-12-21T03:00:00Z' });
    await confirmSlipAt(db(), part, { quantity: 3, shipmentDate: '2026-12-28', lockedAt: '2026-12-28T01:00:00Z' });
    const done = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }], createdAt: '2026-12-22T03:00:00Z' });
    await confirmSlipAt(db(), done, { quantity: 1, shipmentDate: '2026-12-29', lockedAt: '2026-12-29T01:00:00Z' });
    const later = await seedPostedPayment(db(), { lines: [{ price: 2000, quantity: 1 }], createdAt: '2027-01-03T03:00:00Z' });
    await postShipments();
    // The day before the first taxable period starts: the dates and the figures are the books as of then.
    const { orders, total } = await listAll('2026-12-31', 1);
    const byId = new Map(orders.map((order) => [order.order_id, order]));
    expect(byId.get(open.orderId)).toMatchObject({ order_number: orderNumber(open.orderId), balance: 30000, paid_on: '2026-12-20', unshipped_units: 8 });
    expect(byId.get(part.orderId)).toMatchObject({ order_number: orderNumber(part.orderId), balance: 30000 - 3 * 3750, paid_on: '2026-12-21', unshipped_units: 5 });
    // Shipped in full: no deferred revenue left. Paid after the day: not yet.
    expect(byId.has(done.orderId)).toBe(false);
    expect(byId.has(later.orderId)).toBe(false);
    for (const order of [byId.get(open.orderId) as DeferredOrder, byId.get(part.orderId) as DeferredOrder]) {
      expect(Object.values(order.states).reduce((sum, count) => sum + count, 0)).toBe(order.unshipped_units);
      expect(Object.keys(order.states).every((state) => ['ready', 'in_production', 'cancel_requested', 'unpaid', 'payment_expired'].includes(state))).toBe(true);
    }
    expect(orders.map((order) => order.order_id)).toEqual([...orders.map((order) => order.order_id)].sort());
    expect(total).toBe(orders.reduce((sum, order) => sum + order.balance, 0));
    // Later in time the order paid on 1/3 is carried too, and the one shipped is gone as before.
    const january = await listAll('2027-01-10');
    expect(january.orders.find((order) => order.order_id === later.orderId)).toMatchObject({ balance: 2000, paid_on: '2027-01-03', unshipped_units: 1 });
  });

  test('FREQ-569-AC-04: 一覧は続きの目印で最後まで読め、合計は全部の注文の額で、上限を確かめる', async () => {
    const seeded: Array<Awaited<ReturnType<typeof seedPostedPayment>>> = [];
    for (let i = 0; i < 3; i += 1) {
      seeded.push(await seedPostedPayment(db(), { lines: [{ price: 1000 * (i + 1), quantity: 1 }], createdAt: `2026-12-1${i}T03:00:00Z` }));
    }
    const pageOne = await list('2026-12-31', 1);
    expect(pageOne.orders).toHaveLength(1);
    expect(pageOne.next_after_order).toBe(pageOne.orders[0].order_id);
    const everything = await listAll('2026-12-31', 1);
    const mine = everything.orders.filter((order) => seeded.some((s) => s.orderId === order.order_id));
    expect(mine.map((order) => order.balance).sort()).toEqual([1000, 2000, 3000]);
    expect(everything.total).toBe(everything.orders.reduce((sum, order) => sum + order.balance, 0));
    await expect(q('select public.list_deferred_revenue($1::date, 0)', ['2026-12-31'])).rejects.toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
  });

  test('FREQ-569-AC-04: 前受金がマイナスの注文と、全部送った後に0でない注文が異常の一覧に出る', async () => {
    const healthy = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    const open = await seedPostedPayment(db(), { lines: [{ price: 3000, quantity: 2 }], createdAt: '2026-06-10T03:00:00Z' });
    const shipped = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    await confirmSlipAt(db(), shipped, { quantity: 1, shipmentDate: '2026-06-12', lockedAt: '2026-06-12T01:00:00Z' });
    await postShipments();
    // Every unit sent and booked: 2150 is 0, so it is not an anomaly (nor is an order still waiting to be sent).
    const negative = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-06-15', kind: 'pre_shipment_refund', parts: ['fixture-negative-1'], lines: [
      { account: '2150', debit: 4500, orderId: negative.orderId }, { account: '1160', credit: 4500 }] });
    // Every unit is sent, but the shipment entry was never booked: the balance is not 0.
    const unbooked = await seedPostedPayment(db(), { lines: [{ price: 6000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    await confirmSlipAt(db(), unbooked, { quantity: 1, shipmentDate: '2026-06-13', lockedAt: '2026-06-13T01:00:00Z' });
    const found = new Map((await anomalies()).anomalies.map((row) => [row.order_id, row]));
    expect(found.get(negative.orderId)).toEqual({ order_id: negative.orderId, order_number: orderNumber(negative.orderId), balance: -500, reason: 'negative_balance' });
    expect(found.get(unbooked.orderId)).toEqual({ order_id: unbooked.orderId, order_number: orderNumber(unbooked.orderId), balance: 6000,
      reason: 'balance_after_all_shipped_or_refunded' });
    for (const order of [healthy, open, shipped]) expect(found.has(order.orderId)).toBe(false);
    // The unbooked shipment gets booked: the anomaly goes away on its own.
    await postShipments();
    expect((await anomalies()).anomalies.some((row) => row.order_id === unbooked.orderId)).toBe(false);
  });

  test('FREQ-569-AC-04: 全部の着が出荷前に返金済みなのに前受金が残る注文も異常の一覧に出る', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    // The unit is refunded in full (a plan 3 allocation) but the entry that moves 2150 was never booked.
    await recordAllocationAt(db(), { orderItemId: order.orderItemIds[0], unitIndex: 0, refundKey: 'fixture-refund-key', amount: 5000, lockedAt: '2026-06-11T03:00:00Z' });
    const found = (await anomalies()).anomalies.find((row) => row.order_id === order.orderId);
    expect(found).toMatchObject({ balance: 5000, reason: 'balance_after_all_shipped_or_refunded' });
    await postManualEntryFixture(db(), { entryDate: '2026-06-11', kind: 'pre_shipment_refund', parts: ['fixture-refund-2'], lines: [
      { account: '2150', debit: 5000, orderId: order.orderId }, { account: '1160', credit: 5000 }] });
    expect((await anomalies()).anomalies.some((row) => row.order_id === order.orderId)).toBe(false);
  });

  test('FREQ-569-AC-04: 異常の一覧にお客様の名前・メールを含めない', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    // The seeded order carries a fixture name and e-mail address; neither may come out of the lists.
    const personal = (await q('select shipping_email, shipping_full_name from public.orders where id = $1', [order.orderId])).rows[0];
    expect(personal.shipping_email).toContain('@');
    expect(personal.shipping_full_name.length).toBeGreaterThan(0);
    await postManualEntryFixture(db(), { entryDate: '2026-06-15', kind: 'pre_shipment_refund', parts: ['fixture-negative-2'], lines: [
      { account: '2150', debit: 9000, orderId: order.orderId }, { account: '1160', credit: 9000 }] });
    const text = JSON.stringify((await anomalies()));
    expect(text).toContain(order.orderId);
    expect(text).not.toContain(personal.shipping_email);
    expect(text).not.toContain(personal.shipping_full_name);
    expect(text).not.toMatch(/example\.invalid|@/);
    const row = (await anomalies()).anomalies.find((entry) => entry.order_id === order.orderId) as Anomaly;
    expect(Object.keys(row).sort()).toEqual(['balance', 'order_id', 'order_number', 'reason']);
    const deferred = JSON.stringify(await list('2026-12-31'));
    expect(deferred).not.toContain(personal.shipping_email);
    expect(deferred).not.toContain(personal.shipping_full_name);
    expect(deferred).not.toMatch(/example\.invalid|@/);
  });
});
