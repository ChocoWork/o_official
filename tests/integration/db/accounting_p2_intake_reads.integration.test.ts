/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { hDiscount, seedHDiscount, seedHOrderUnits } from './helpers/group-h-fixtures';
import { accountingFailure } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, confirmSlipAt, postManualEntryFixture, reverseEntryFixture, seedDispute, seedDisputeReversal, seedPaidOrder,
  seedPostedPayment, seedStripeCharge, setAsideExistingSlips, setCutoverForTest,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 7 (FREQ-571 AC-01..AC-04): the order intake read list_order_intake_events and the breakdown / backlog reads.
// ROLLBACK form (run with --runInBand): setCutoverForTest holds the settings table until the rollback. The posters are private;
// the reads go through their public entries as the connection's role. Every date is in 2026 before today, so rows that another
// suite committed today (it dates them today) are outside the windows read here.
jest.setTimeout(240000);

type IntakeEvent = { order_id: string; event_date: string; kind: string; amount: number; key: string };
type EventsPage = { events: IntakeEvent[]; next_after_date: string | null; next_after_key: string | null };
type Breakdown = {
  subtotal_before_discount: number; discount: number; shipping: number; payment: number; pre_shipment_cancel: number;
  dispute_unshipped: number; dispute_unshipped_restored: number; intake: number; order_count: number; breakdown_ok: boolean;
};

const LOST_AT = '2026-08-20T03:00:00Z';
const W_AT = '2026-06-20T03:00:00Z';

describeLocalDb('S12 intake reads: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const runAll = async () => (await q('select private.accounting_run_posting(50) as r')).rows[0].r as Record<string, unknown>;
  const page = async (from: string, to: string, limit = 5000, afterDate: string | null = null, afterKey: string | null = null) =>
    (await q('select public.list_order_intake_events($1::date, $2::date, $3::integer, $4::date, $5::text) as r', [from, to, limit, afterDate, afterKey]))
      .rows[0].r as EventsPage;
  const allEvents = async (from: string, to: string) => (await page(from, to)).events;
  const ofOrder = (events: readonly IntakeEvent[], orderId: string) => events.filter((event) => event.order_id === orderId);
  const summary = (events: readonly IntakeEvent[]) => events.map((event) => `${event.event_date} ${event.kind} ${event.amount}`);
  const breakdown = async (from: string, to: string) =>
    (await q('select public.get_intake_breakdown($1::date, $2::date) as r', [from, to])).rows[0].r as Breakdown;
  const backlog = async (asOf: string) =>
    (await q('select public.get_order_backlog($1::date) as r', [asOf])).rows[0].r as { backlog_total: number; order_count: number };
  const lose = async (disputeId: string, at = LOST_AT) => {
    await addDisputeHistory(db(), { disputeId, status: 'lost', occurredAt: new Date(new Date(at).getTime() + 3600_000).toISOString(),
      stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
  };
  const postShipments = async () => { await q('select private.accounting_post_shipment_events(50)'); };
  /** A paid order of `units` units (3,750 yen each); `shipped` of them are sent by a slip confirmed (and posted) on 2026-06-15. */
  async function seedOrder(input: { shipped?: number; units?: number } = {}) {
    const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: input.units ?? 8 }], createdAt: '2026-06-10T03:00:00Z' });
    if ((input.shipped ?? 0) > 0) {
      await confirmSlipAt(db(), order, { quantity: input.shipped as number, shipmentDate: '2026-06-15', lockedAt: '2026-06-15T01:00:00Z' });
      await postShipments();
    }
    return order;
  }
  const dispute = (order: { orderId: string; paymentIntentId: string | null }, amount: number, withdrawnAt = W_AT) =>
    seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount, withdrawnAt });

  test('FREQ-571-AC-01: 受注高の対象は支払いを受けた注文（支払い済み・発送済み・あとで取り消した）で、支払いの途中・失敗・放棄の注文を含まない', async () => {
    const paid = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    const shipped = await seedPostedPayment(db(), { lines: [{ price: 9000, quantity: 1 }], createdAt: '2026-01-21T03:00:00Z' });
    await confirmSlipAt(db(), shipped, { quantity: 1, shipmentDate: '2026-01-25', lockedAt: '2026-01-25T01:00:00Z' });
    await postShipments();
    const cancelled = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 1 }], createdAt: '2026-01-22T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-01-23', kind: 'pre_shipment_refund', parts: ['fixture-cancel-1'], lines: [
      { account: '2150', debit: 4000, orderId: cancelled.orderId }, { account: '1160', credit: 4000 }] });
    const inProgress = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }], status: 'payment_in_progress' });
    const pending = await seedPaidOrder(db(), { lines: [{ price: 6000, quantity: 1 }], status: 'pending' });
    // A paid order whose Stripe amount does not match is parked, not booked: it has no payment entry, so it is not in the intake.
    const mismatch = await seedPaidOrder(db(), { lines: [{ price: 7000, quantity: 1 }], paidAt: '2026-01-24T03:00:00Z' });
    await seedStripeCharge(db(), { paymentIntentId: mismatch.paymentIntentId, amount: 6000, createdAt: '2026-01-24T03:00:00Z' });
    await runAll();
    const events = await allEvents('2026-01-01', '2026-01-31');
    const ids = new Set(events.map((event) => event.order_id));
    expect(ids.has(paid.orderId) && ids.has(shipped.orderId) && ids.has(cancelled.orderId)).toBe(true);
    for (const order of [inProgress, pending, mismatch]) expect(ids.has(order.orderId)).toBe(false);
    expect(summary(ofOrder(events, paid.orderId))).toEqual(['2026-01-20 payment 18750']);
    expect(summary(ofOrder(events, shipped.orderId))).toEqual(['2026-01-21 payment 9000']);
    expect(summary(ofOrder(events, cancelled.orderId))).toEqual(['2026-01-22 payment 4000', '2026-01-23 pre_shipment_cancel -4000']);
  });

  test('FREQ-571-AC-01: 受注高の日は支払いの仕訳の日で、orders.paid_atやcreated_atを使わない', async () => {
    const order = await seedPaidOrder(db(), { lines: [{ price: 12000, quantity: 1 }], paidAt: '2026-03-01T03:00:00Z' });
    await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: 12000, createdAt: '2026-01-20T14:59:00Z', orderId: order.orderId });
    await runAll();
    // 14:59 UTC is 23:59 on the 20th in Japan; orders.paid_at (March) and orders.created_at (now) are never read.
    expect(summary(ofOrder(await allEvents('2026-01-01', '2026-12-31'), order.orderId))).toEqual(['2026-01-20 payment 12000']);
    expect(ofOrder(await allEvents('2026-03-01', '2026-03-31'), order.orderId)).toEqual([]);
  });

  test('FREQ-571-AC-02: 内訳（割引の前の商品の額−割引−出荷前の取り消し）の合計が受注高に合い、合わなければbreakdown_okが偽', async () => {
    // 32,000 yen of goods, a 2,000 yen discount shared by the two lines (1,250 and 750): the customer paid 30,000.
    const discountId = await seedHDiscount(db(), hDiscount());
    const seeded = await seedHOrderUnits(db(), { legacy: false, status: 'paid', paidAt: '2026-01-05T03:00:00Z', lines: [
      { itemPrice: 20000, quantity: 1, discounts: [{ discountId, amount: 1250 }], unitAmounts: [18750] },
      { itemPrice: 12000, quantity: 1, discounts: [{ discountId, amount: 750 }], unitAmounts: [11250] }] });
    const order = { orderId: seeded.orderId, paymentIntentId: `pi_${randomUUID().replaceAll('-', '')}` };
    await q('update public.orders set payment_intent_id = $2 where id = $1', [order.orderId, order.paymentIntentId]);
    await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: 30000, createdAt: '2026-01-05T03:00:00Z', orderId: order.orderId });
    await runAll();
    await postManualEntryFixture(db(), { entryDate: '2026-02-01', kind: 'pre_shipment_refund', parts: ['fixture-cancel-2'], lines: [
      { account: '2150', debit: 1000, orderId: order.orderId }, { account: '1160', credit: 1000 }] });
    const january = await breakdown('2026-01-01', '2026-01-31');
    expect(january).toMatchObject({ subtotal_before_discount: 32000, discount: 2000, pre_shipment_cancel: 0, dispute_unshipped: 0, intake: 30000,
      order_count: 1, breakdown_ok: true });
    const both = await breakdown('2026-01-01', '2026-02-28');
    expect(both).toMatchObject({ subtotal_before_discount: 32000, discount: 2000, pre_shipment_cancel: -1000, intake: 29000, order_count: 1,
      breakdown_ok: true });
    // February alone: no payment in the window, only the cancel (the order is not counted again).
    expect(await breakdown('2026-02-01', '2026-02-28')).toMatchObject({ subtotal_before_discount: 0, discount: 0, pre_shipment_cancel: -1000,
      intake: -1000, order_count: 0, breakdown_ok: true });
    // The books and the order disagree (a payment entry of 5,000 yen for an order of 6,000 yen): the breakdown says so.
    const other = await seedPaidOrder(db(), { lines: [{ price: 6000, quantity: 1 }], paidAt: '2026-01-06T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-01-06', kind: 'payment_confirmed', parts: [other.paymentIntentId as string], lines: [
      { account: '1160', debit: 5000, orderId: other.orderId }, { account: '2150', credit: 5000, orderId: other.orderId }] });
    expect(await breakdown('2026-01-06', '2026-01-06')).toMatchObject({ subtotal_before_discount: 6000, discount: 0, intake: 5000, order_count: 1,
      breakdown_ok: false });
  });

  test('FREQ-571-AC-02: 支払いが後の期間で取り消された時は、その期間の注文の額を符号つきで足し、breakdown_ok は真のまま', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await reverseEntryFixture(db(), order.paymentEntryId, 'fixture payment reversal', '2026-02-10');
    expect(await breakdown('2026-01-01', '2026-01-31')).toMatchObject({ subtotal_before_discount: 18750, payment: 18750, intake: 18750, order_count: 1, breakdown_ok: true });
    // February: the payment is reversed (-18,750), so the order counts with the minus sign and the breakdown still adds up.
    expect(await breakdown('2026-02-01', '2026-02-28')).toMatchObject({ subtotal_before_discount: -18750, discount: 0, payment: -18750, intake: -18750,
      order_count: 1, breakdown_ok: true });
    expect(await breakdown('2026-01-01', '2026-02-28')).toMatchObject({ subtotal_before_discount: 0, payment: 0, intake: 0, order_count: 0, breakdown_ok: true });
  });

  test('FREQ-571-AC-03: 出荷して発送済みになった注文も、出荷後に返品が届いても受注高は変わらない', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await confirmSlipAt(db(), order, { quantity: 1, shipmentDate: '2026-02-03', lockedAt: '2026-02-03T01:00:00Z' });
    await postShipments();
    await postManualEntryFixture(db(), { entryDate: '2026-03-10', kind: 'return_arrived', parts: [order.orderId], lines: [
      { account: '4020', debit: 18750, orderId: order.orderId }, { account: '2130', credit: 17750, orderId: order.orderId },
      { account: '4050', credit: 1000, orderId: order.orderId }] });
    await postManualEntryFixture(db(), { entryDate: '2026-03-12', kind: 'return_refund', parts: [order.orderId], lines: [
      { account: '2130', debit: 17750, orderId: order.orderId }, { account: '1160', credit: 17750 }] });
    expect(summary(ofOrder(await allEvents('2026-01-01', '2026-01-31'), order.orderId))).toEqual(['2026-01-20 payment 18750']);
    expect(await allEvents('2026-02-01', '2026-03-31')).toEqual([]);
    expect(await breakdown('2026-01-01', '2026-01-31')).toMatchObject({ intake: 18750, order_count: 1, breakdown_ok: true });
    expect(await breakdown('2026-03-01', '2026-03-31')).toMatchObject({ intake: 0, pre_shipment_cancel: 0, dispute_unshipped: 0, order_count: 0, breakdown_ok: true });
  });

  test('FREQ-571-AC-03: 出荷前の取り消しの仕訳があれば、その返金の日に受注高から引く。取り消した仕訳は同じ日に符号を逆にして打ち消す', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    const refund = await postManualEntryFixture(db(), { entryDate: '2026-02-10', kind: 'pre_shipment_refund', parts: ['fixture-cancel-3'], lines: [
      { account: '2150', debit: 5000, orderId: order.orderId }, { account: '1160', credit: 5000 }] });
    expect(summary(ofOrder(await allEvents('2026-01-01', '2026-02-28'), order.orderId))).toEqual(['2026-01-20 payment 18750', '2026-02-10 pre_shipment_cancel -5000']);
    expect(ofOrder(await allEvents('2026-01-01', '2026-01-31'), order.orderId)).toHaveLength(1);
    await reverseEntryFixture(db(), refund.entryId);
    const events = ofOrder(await allEvents('2026-01-01', '2026-02-28'), order.orderId);
    // The two rows of the 10th share a day: their order is the key's, so compare them as a set.
    expect(summary(events).sort()).toEqual(['2026-01-20 payment 18750', '2026-02-10 pre_shipment_cancel -5000', '2026-02-10 pre_shipment_cancel 5000']);
    expect(events.reduce((sum, event) => sum + event.amount, 0)).toBe(18750);
    expect(new Set(events.map((event) => event.key)).size).toBe(3);
    expect(await breakdown('2026-01-01', '2026-02-28')).toMatchObject({ pre_shipment_cancel: 0, intake: 18750, breakdown_ok: true });
  });

  test('FREQ-571-AC-04: カード会社の取り消しは、確定した日に未出荷の分だけ受注高から引く（確定の前は引かず、確定が no_revenue でも引く）', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000);
    await runAll();
    // Withdrawn but not lost yet: 2150 is down, the intake is not.
    expect(summary(ofOrder(await allEvents('2026-06-01', '2026-12-31'), order.orderId))).toEqual(['2026-06-10 payment 30000']);
    await lose(d.disputeId);
    await runAll();
    expect(summary(ofOrder(await allEvents('2026-06-01', '2026-12-31'), order.orderId)))
      .toEqual(['2026-06-10 payment 30000', '2026-08-20 dispute_unshipped -30000']);
    expect(await breakdown('2026-08-01', '2026-08-31')).toMatchObject({ dispute_unshipped: -30000, intake: -30000, order_count: 0, breakdown_ok: true });
    expect((await backlog('2026-12-31')).backlog_total - (await backlog('2026-06-09')).backlog_total).toBe(0);
  });

  test('FREQ-571-AC-04: 出荷済みの分がある取り消しは、未出荷の分だけを確定した日に引く（出荷済みの分は受注高から引かない）', async () => {
    const order = await seedOrder({ shipped: 4 });
    const d = await dispute(order, 30000);
    await runAll();
    await lose(d.disputeId);
    await runAll();
    // 30,000 yen over 8 equal units: 15,000 is the shipped half (booked to the unassigned sub-account), 15,000 the unshipped half.
    expect(summary(ofOrder(await allEvents('2026-06-01', '2026-12-31'), order.orderId)))
      .toEqual(['2026-06-10 payment 30000', '2026-08-20 dispute_unshipped -15000']);
  });

  test('FREQ-571-AC-04: 確定の前に一部が戻った時は、UからRの2150の貸方を引いた額を、確定がno_revenueの時もlostの日に引く', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000);
    await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 10000, createdAt: '2026-07-05T03:00:00Z' });
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'under_review', occurredAt: '2026-07-06T03:00:00Z' });
    await lose(d.disputeId);
    await runAll();
    expect(summary(ofOrder(await allEvents('2026-06-01', '2026-12-31'), order.orderId)))
      .toEqual(['2026-06-10 payment 30000', '2026-08-20 dispute_unshipped -20000']);
    const pending = (await q(
      "select reason, detail ->> 'lost_on' as lost_on from public.accounting_pending_events where source_table = 'stripe_disputes' and source_id = $1", [d.disputeId])).rows[0];
    expect(pending).toEqual({ reason: 'no_revenue', lost_on: '2026-08-20' });
  });

  test('FREQ-571-AC-04: 確定の後に遅れて戻った分は戻った日に未出荷の受注高を戻す', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000);
    await lose(d.disputeId);
    await runAll();
    await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 7000, createdAt: '2026-09-15T03:00:00Z' });
    await runAll();
    const events = ofOrder(await allEvents('2026-06-01', '2026-12-31'), order.orderId);
    expect(summary(events)).toEqual(['2026-06-10 payment 30000', '2026-08-20 dispute_unshipped -30000', '2026-09-15 dispute_unshipped_restored 7000']);
    expect(await breakdown('2026-09-01', '2026-09-30')).toMatchObject({ dispute_unshipped: 0, dispute_unshipped_restored: 7000, payment: 0, pre_shipment_cancel: 0, intake: 7000, breakdown_ok: true });
  });

  test('FREQ-571-AC-04: 2つの取り消しがあっても同じ額を二重に引かない', async () => {
    const order = await seedOrder();
    const a = await dispute(order, 10000);
    const b = await dispute(order, 20000, '2026-06-22T03:00:00Z');
    await lose(a.disputeId);
    await lose(b.disputeId, '2026-08-25T03:00:00Z');
    await runAll();
    const events = ofOrder(await allEvents('2026-06-01', '2026-12-31'), order.orderId);
    expect(summary(events)).toEqual(['2026-06-10 payment 30000', '2026-08-20 dispute_unshipped -10000', '2026-08-25 dispute_unshipped -20000']);
    expect(events.reduce((sum, event) => sum + event.amount, 0)).toBe(0);
    // The sum of the intake over the whole span is the 2150 balance of the order (here 0): nothing was taken twice.
    expect((await backlog('2026-12-31')).backlog_total - (await backlog('2026-06-09')).backlog_total).toBe(0);
  });

  test('FREQ-571-AC-05: 続きの目印で最後まで読め、元と取り消しを両方足して合計が合う（二重に引かない）', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    for (const day of ['2026-01-25', '2026-01-26', '2026-01-26', '2026-01-27']) {
      const entry = await postManualEntryFixture(db(), { entryDate: day, kind: 'pre_shipment_refund', parts: [`fixture-page-${day}-${Math.random().toString(36).slice(2, 8)}`],
        lines: [{ account: '2150', debit: 100, orderId: order.orderId }, { account: '1160', credit: 100 }] });
      if (day === '2026-01-26') await reverseEntryFixture(db(), entry.entryId);
    }
    const whole = await allEvents('2026-01-01', '2026-01-31');
    expect(new Set(whole.map((event) => event.key)).size).toBe(whole.length);
    expect(whole.length).toBeGreaterThanOrEqual(7);
    const ordered = [...whole].sort((x, y) => (x.event_date < y.event_date ? -1 : x.event_date > y.event_date ? 1 : x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    expect(whole.map((event) => event.key)).toEqual(ordered.map((event) => event.key));
    const walked: IntakeEvent[] = [];
    let after: { date: string | null; key: string | null } = { date: null, key: null };
    let pages = 0;
    for (;;) {
      const next = await page('2026-01-01', '2026-01-31', 2, after.date, after.key);
      expect(next.events.length).toBeLessThanOrEqual(2);
      walked.push(...next.events);
      pages += 1;
      if (next.next_after_date === null) { expect(next.next_after_key).toBeNull(); break; }
      after = { date: next.next_after_date, key: next.next_after_key };
    }
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(whole.length / 2));
    expect(walked).toEqual(whole);
    expect(ofOrder(walked, order.orderId).reduce((sum, event) => sum + event.amount, 0)).toBe(18750 - 200);
  });

  test('FREQ-571-AC-05: 読み口は上限と期間の向き・続きの目印の組を確かめ、service_role だけが呼べる', async () => {
    const refused = async (text: string, params: unknown[]) => (await accountingFailure(db(), () => q(text, params)))?.message;
    expect(await refused('select public.list_order_intake_events($1::date, $2::date, 0)', ['2026-01-01', '2026-01-31'])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect(await refused('select public.list_order_intake_events($1::date, $2::date, 5001)', ['2026-01-01', '2026-01-31'])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect(await refused('select public.list_order_intake_events($1::date, $2::date)', ['2026-02-01', '2026-01-31'])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect(await refused('select public.list_order_intake_events(null, $1::date)', ['2026-01-31'])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect(await refused('select public.list_order_intake_events($1::date, $2::date, 10, $3::date, null)', ['2026-01-01', '2026-01-31', '2026-01-05'])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect(await refused('select public.get_intake_breakdown($1::date, $2::date)', ['2026-02-01', '2026-01-31'])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    expect(await refused('select public.get_order_backlog(null)', [])).toBe('ACCOUNTING_ARGUMENT_INVALID');
    for (const signature of ['list_order_intake_events(date,date,integer,date,text)', 'get_intake_breakdown(date,date)', 'get_order_backlog(date)',
      'get_intake_reconciliation(date,date)', 'list_deferred_revenue(date,integer,uuid)', 'list_deferred_revenue_anomalies()']) {
      const row = (await q(
        `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated,
           has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_role, has_function_privilege('public', $1::regprocedure, 'EXECUTE') as public`,
        [`public.${signature}`])).rows[0];
      expect([signature, row]).toEqual([signature, { anon: false, authenticated: false, service_role: true, public: false }]);
    }
    await q('savepoint acc_s12_role');
    await q('set local role service_role');
    expect((await q('select public.get_order_backlog($1::date) as r', ['2026-01-31'])).rows[0].r)
      .toEqual(expect.objectContaining({ backlog_total: expect.any(Number), order_count: expect.any(Number) }));
    await q('rollback to savepoint acc_s12_role');
    for (const role of ['anon', 'authenticated']) {
      await q('savepoint acc_s12_role');
      await q(`set local role ${role}`);
      await expect(q('select public.get_order_backlog($1::date)', ['2026-01-31'])).rejects.toMatchObject({ code: '42501' });
      await q('rollback to savepoint acc_s12_role');
    }
  });

  test('FREQ-571-AC-05: 受注残は期日までの注文番号つき2150の貸方−借方の合計で、注文番号のない2150と期日より後を数えない', async () => {
    const before = await backlog('2026-03-31');
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-02-01', kind: 'compensation_received', parts: ['fixture-no-order'], lines: [
      { account: '1160', debit: 3000 }, { account: '2150', credit: 3000 }] });
    const after = await backlog('2026-03-31');
    expect(after.backlog_total - before.backlog_total).toBe(18750);
    expect(after.order_count - before.order_count).toBe(1);
    expect((await backlog('2026-01-19')).backlog_total).toBe(before.backlog_total);
    expect((await backlog('2026-01-20')).backlog_total - before.backlog_total).toBe(18750);
    expect(order.total).toBe(18750);
  });
});
