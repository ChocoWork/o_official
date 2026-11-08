/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { describeLocalDb } from './helpers/local-db';
import { insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import {
  cancelSlip, seedConfirmedSlip, setAsideExistingSlips, seedPaidOrder, seedPostedPayment, seedStripeCharge, setCutoverForTest, type SeedSlipOrder,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 3 (FREQ-563 / FREQ-564-AC-04 / FREQ-569): the shipment posting (deferred revenue 2150 / sales 4010).
// ROLLBACK form (run with --runInBand): setCutoverForTest holds the settings table until the rollback.
jest.setTimeout(120000);

type RunResult = { posted: number; parked_new: number; reparked: number; resolved: number; reversed: number; redated: number };
type PendingRow = { reason: string; detail: Record<string, unknown>; resolved_at: Date | null; resolved_entry_id: string | null;
  detection_count: number; order_id: string | null; event_kind: string; source_table: string };

describeLocalDb('S8 shipment posting: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    // The group G lock: the order fixtures write unit rows that need it.
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
  });
  afterEach(async () => { await q('rollback'); });

  const run = async (limit = 50): Promise<RunResult> =>
    (await q('select private.accounting_post_shipment_events($1::integer) as r', [limit])).rows[0].r as RunResult;
  const none: RunResult = { posted: 0, parked_new: 0, reparked: 0, resolved: 0, reversed: 0, redated: 0 };
  const postPayments = async () => { await q('select private.accounting_post_payment_events(50)'); };
  const pendingOf = async (slipId: string, kind = 'shipment_confirmed'): Promise<PendingRow | undefined> => (await q(
    `select reason, detail, resolved_at, resolved_entry_id, detection_count, order_id, event_kind, source_table
     from public.accounting_pending_events where event_kind = $2 and source_id = $1`, [slipId, kind])).rows[0];
  const entriesOf = async (number: string) => (await q(
    `select e.id, e.event_kind, e.dedupe_key, e.description, e.source_table, e.source_id, e.recorded_by, e.recorded_at,
       to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.period_id, e.entry_no, e.is_late, e.source_recorded_at,
       to_char(p.starts_on, 'YYYY-MM-DD') as period_starts_on
     from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id
     where e.dedupe_key = $1`, ['shipment_confirmed:' + number])).rows;
  const linesOf = async (entryId: string) => (await q(
    `select line_no, account_code, debit::text as debit, credit::text as credit, order_id, sub_account, counterparty, memo
     from public.accounting_journal_lines where entry_id = $1 order by line_no`, [entryId])).rows;
  const entryCount = async (kind = 'shipment_confirmed') => Number((await q(
    'select count(*) as n from public.accounting_journal_entries where event_kind = $1', [kind])).rows[0].n);
  const unitsOf = async (entryId: string) => (await q(
    `select order_item_id, unit_index, paid_amount, refunded_amount from public.accounting_shipment_units
     where entry_id = $1 order by order_item_id, unit_index`, [entryId])).rows;
  /** The deferred revenue (2150) balance of an order over every entry: credit minus debit. */
  const deferredBalance = async (orderId: string) => Number((await q(
    "select coalesce(sum(credit - debit), 0) as b from public.accounting_journal_lines where order_id = $1 and account_code = '2150'",
    [orderId])).rows[0].b);
  const salesTotal = async (orderId: string) => Number((await q(
    "select coalesce(sum(credit - debit), 0) as b from public.accounting_journal_lines where order_id = $1 and account_code = '4010'",
    [orderId])).rows[0].b);
  const slipFor = (orderId: string, lines: Array<{ orderItemId: string; quantity: number }>, extra: Partial<SeedSlipOrder> = {}): SeedSlipOrder =>
    ({ orderId, lines, ...extra });
  /** A pre-shipment refund: the allocation to the unit and the journal entry that takes it off the deferred revenue. */
  async function refundBeforeShipment(orderId: string, orderItemId: string, unitIndex: number, amount: number, key: string) {
    await q('select private.accounting_record_unit_refund($1, $2::uuid, $3::integer, $4::integer)', [key, orderItemId, unitIndex, amount]);
    await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event($1::date), $1::date,
        'pre_shipment_refund', ARRAY[$2]::text[], 'refund', $3::jsonb)`,
      ['2026-06-12', key, JSON.stringify([
        { account_code: '2150', debit: amount, credit: 0, order_id: orderId },
        { account_code: '1160', debit: 0, credit: amount, order_id: orderId }])]);
  }
  const shirtAndPants = [{ price: 18750, quantity: 1 }, { price: 11250, quantity: 1 }];

  test('FREQ-563-AC-01: 一部の出荷は送った着の額だけで、シャツの出荷は18,750円、前受金の残りは11,250円になる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: shirtAndPants, fee: 540 });
    expect(order.total).toBe(30000);
    const [shirt] = order.orderItemIds;
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: shirt, quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const entries = await entriesOf(slip.number);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event_kind: 'shipment_confirmed', description: ACCOUNTING_LABELS.shipmentRevenue,
      source_table: 'shipment_slips', source_id: slip.slipId, entry_date: '2026-06-20', recorded_by: null,
      dedupe_key: `shipment_confirmed:${slip.number}` });
    expect(await linesOf(entries[0].id)).toEqual([
      { line_no: 1, account_code: '2150', debit: '18750', credit: '0', order_id: order.orderId, sub_account: null, counterparty: null, memo: 'H fixture × 1' },
      { line_no: 2, account_code: '4010', debit: '0', credit: '18750', order_id: order.orderId, sub_account: null, counterparty: null, memo: null }]);
    expect(await deferredBalance(order.orderId)).toBe(11250);
    expect(await unitsOf(entries[0].id)).toEqual([{ order_item_id: shirt, unit_index: 0, paid_amount: 18750, refunded_amount: 0 }]);
  });

  test('FREQ-563-AC-01: 手数料や入金の行を出荷の仕訳に入れない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: shirtAndPants, fee: 540 });
    const slip = await seedConfirmedSlip(db(), {
      orders: [slipFor(order.orderId, order.orderItemIds.map((orderItemId) => ({ orderItemId, quantity: 1 })))], shipmentDate: '2026-06-20' });
    await run();
    const [entry] = await entriesOf(slip.number);
    const accounts = (await linesOf(entry.id)).map((line) => line.account_code);
    expect(new Set(accounts)).toEqual(new Set(['2150', '4010']));
    expect(accounts).toHaveLength(4);
  });

  async function pantsAfterRefund() {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: shirtAndPants });
    const [shirt, pants] = order.orderItemIds;
    const first = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: shirt, quantity: 1 }])], shipmentDate: '2026-06-20' });
    await refundBeforeShipment(order.orderId, pants, 0, 1000, 'RF-0001');
    const second = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: pants, quantity: 1 }])], shipmentDate: '2026-06-21' });
    expect(await run()).toEqual({ ...none, posted: 2 });
    return { order, pants, first, second };
  }

  test('FREQ-563-AC-01: パンツの出荷で前受金が0になり売上の累計は29,000円になる', async () => {
    const { order, second } = await pantsAfterRefund();
    const [entry] = await entriesOf(second.number);
    expect((await linesOf(entry.id)).map((line) => [line.account_code, line.debit, line.credit])).toEqual([['2150', '10250', '0'], ['4010', '0', '10250']]);
    expect(await salesTotal(order.orderId)).toBe(29000);
    expect(await deferredBalance(order.orderId)).toBe(0);
  });

  test('FREQ-563-AC-02: 出荷前の返金の割り当てがあれば、その着の額から引く（パンツ11,250−1,000＝10,250円）', async () => {
    const { pants, second } = await pantsAfterRefund();
    const [entry] = await entriesOf(second.number);
    expect(await unitsOf(entry.id)).toEqual([{ order_item_id: pants, unit_index: 0, paid_amount: 11250, refunded_amount: 1000 }]);
  });

  test('FREQ-563-AC-03: 同じ品を2着、支払額が9,999円と10,001円なら1着目の出荷は番号の若い着の9,999円、2着目は10,001円', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 10000, quantity: 2, unitAmounts: [9999, 10001] }] });
    const [item] = order.orderItemIds;
    const first = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: item, quantity: 1 }])], shipmentDate: '2026-06-20' });
    const second = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: item, quantity: 1 }])], shipmentDate: '2026-06-21' });
    expect(await run()).toEqual({ ...none, posted: 2 });
    const [one] = await entriesOf(first.number);
    const [two] = await entriesOf(second.number);
    expect((await linesOf(one.id))[0].debit).toBe('9999');
    expect((await linesOf(two.id))[0].debit).toBe('10001');
    expect(await unitsOf(one.id)).toEqual([{ order_item_id: item, unit_index: 0, paid_amount: 9999, refunded_amount: 0 }]);
    expect(await unitsOf(two.id)).toEqual([{ order_item_id: item, unit_index: 1, paid_amount: 10001, refunded_amount: 0 }]);
  });

  test('FREQ-563-AC-03: 同じ発送票を取り消して出し直すと、送った着は番号の若い順に戻る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 10000, quantity: 2, unitAmounts: [9999, 10001] }] });
    const [item] = order.orderItemIds;
    const first = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: item, quantity: 1 }])], shipmentDate: '2026-06-20' });
    await run();
    await cancelSlip(db(), first.slipId);
    expect(await run()).toEqual({ ...none, posted: 1, reversed: 1 });
    const again = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: item, quantity: 1 }])], shipmentDate: '2026-06-22' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const [entry] = await entriesOf(again.number);
    // The unit the cancelled slip held is free again: the lowest number is taken, not unit 1.
    expect(await unitsOf(entry.id)).toEqual([{ order_item_id: item, unit_index: 0, paid_amount: 9999, refunded_amount: 0 }]);
    expect((await linesOf(entry.id))[0].debit).toBe('9999');
    expect(await deferredBalance(order.orderId)).toBe(20000 - 9999);
  });

  test('FREQ-563-AC-04: 支払いの仕訳が無い注文の出荷はpayment_journal_missingで止まり、支払いの仕訳が入ると次の呼び出しで1本入って計上待ちが解決される', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    // The order is paid and has a paid_at, but no payment entry exists yet.
    const order = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 2 }], paidAt: '2026-06-10T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), {
      orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect(await entriesOf(slip.number)).toHaveLength(0);
    expect(await pendingOf(slip.slipId)).toMatchObject({ reason: 'payment_journal_missing', detail: { order_count: 1 }, order_id: order.orderId,
      resolved_at: null, detection_count: 1, source_table: 'shipment_slips' });
    expect(await run()).toEqual({ ...none, reparked: 1 });
    // The payment arrives.
    await seedStripeCharge(db(), {
      paymentIntentId: order.paymentIntentId, amount: order.total, createdAt: '2026-06-10T03:00:00Z' });
    await postPayments();
    expect(await run()).toEqual({ ...none, posted: 1, resolved: 1 });
    const [entry] = await entriesOf(slip.number);
    expect(entry.entry_date).toBe('2026-06-20');
    const resolved = await pendingOf(slip.slipId);
    expect(resolved?.resolved_at).not.toBeNull();
    expect(resolved?.resolved_entry_id).toBe(entry.id);
    expect(await run()).toEqual(none);
  });

  test('FREQ-563-AC-04: orders.statusやpaid_atが払い済みでも、支払いの仕訳が無ければ出荷を仕訳にしない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }], paidAt: '2026-06-10T03:00:00Z', status: 'paid' });
    const row = (await q('select status, paid_at from public.orders where id = $1', [order.orderId])).rows[0];
    expect(row.status).toBe('paid');
    expect(row.paid_at).not.toBeNull();
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    await run();
    expect(await entryCount()).toBe(0);
    expect((await pendingOf(slip.slipId))?.reason).toBe('payment_journal_missing');
  });

  test('FREQ-563-AC-04: 取り消された支払いの仕訳しか無い注文も支払いの仕訳が無い扱いで止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }] });
    await q('select private.accounting_reverse_journal_core(null, $1::uuid, $2)', [order.paymentEntryId, 'payment cancelled']);
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect((await pendingOf(slip.slipId))?.reason).toBe('payment_journal_missing');
  });

  test('FREQ-563-AC-04: 発送ごとの出荷日と発送票の出荷日が違えばshipment_date_mismatchで止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }] });
    const slip = await seedConfirmedSlip(db(), {
      orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }], { fulfillmentDate: '2026-06-21' })], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf(slip.slipId)).toMatchObject({ reason: 'shipment_date_mismatch', detail: {}, resolved_at: null });
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-563-AC-04: 出荷の額が前受金の残りより多ければdeferred_revenue_shortで止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: shirtAndPants });
    // 29,000 yen leave the deferred revenue by another entry: 1,000 remain, the shirt needs 18,750.
    await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event('2026-06-12'::date), '2026-06-12'::date,
        'pre_shipment_refund', ARRAY['RF-BIG']::text[], 'refund', $1::jsonb)`, [JSON.stringify([
      { account_code: '2150', debit: 29000, credit: 0, order_id: order.orderId },
      { account_code: '1160', debit: 0, credit: 29000, order_id: order.orderId }])]);
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf(slip.slipId)).toMatchObject({ reason: 'deferred_revenue_short', detail: { shortage: 17750 }, order_id: order.orderId });
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-563-AC-04: 送る着が足りなければunits_insufficientで止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: shirtAndPants });
    const pants = order.orderItemIds[1];
    // The whole unit is refunded before the shipment: no unit is left to send.
    await q('select private.accounting_record_unit_refund($1, $2::uuid, 0, 11250)', ['RF-FULL', pants]);
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: pants, quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf(slip.slipId)).toMatchObject({ reason: 'units_insufficient', detail: {} });
  });

  test('FREQ-563-AC-04: 切り替えの日より前の出荷日はbefore_cutover', async () => {
    await setCutoverForTest(db(), '2026-06-18');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }], createdAt: '2026-06-20T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-15' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf(slip.slipId)).toMatchObject({ reason: 'before_cutover', detail: {} });
    expect(await entryCount()).toBe(0);
  });

  async function exchangeItem(orderId: string, baseItemId: string) {
    // The foreign key to the return line is not the point here; replica mode skips it for this one insert (CHECKs still apply).
    await q('set local session_replication_role = replica');
    const exchange = (await q(`insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total, variant_id,
      fulfillment_type, line_kind, exchange_return_line_id, exchange_paid_amount)
      select oi.order_id, oi.item_id, 'exchange', 0, 2, 0, oi.variant_id, 'backorder', 'exchange', gen_random_uuid(), 3000
      from public.order_items oi where oi.id = $1 returning id`, [baseItemId])).rows[0].id as string;
    await q('insert into public.order_line_unit_amounts (order_id, order_item_id, unit_index, paid_amount) values ($1, $2, 0, 3000), ($1, $2, 1, 3000)',
      [orderId, exchange]);
    await q('set local session_replication_role = origin');
    return exchange;
  }

  test('FREQ-563-AC-05: 交換の品（line_kind=exchange）の行は売上にならず、交換だけの発送票はno_revenueで解決済みになる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 2 }] });
    const exchange = await exchangeItem(order.orderId, order.orderItemIds[0]);
    const only = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: exchange, quantity: 2 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1, resolved: 1 });
    expect(await entriesOf(only.number)).toHaveLength(0);
    expect(await pendingOf(only.slipId)).toMatchObject({ reason: 'no_revenue', detail: {} });
    const resolved = await pendingOf(only.slipId);
    expect(resolved?.resolved_at).not.toBeNull();
    expect(resolved?.resolved_entry_id).toBeNull();
    // The mark keeps it out of the next run.
    expect(await run()).toEqual(none);
    // A slip with both an ordinary item and an exchange item posts the ordinary one only.
    const exchangeAgain = await exchangeItem(order.orderId, order.orderItemIds[0]);
    const mixed = await seedConfirmedSlip(db(), {
      orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }, { orderItemId: exchangeAgain, quantity: 2 }])], shipmentDate: '2026-06-21' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const [entry] = await entriesOf(mixed.number);
    expect(await linesOf(entry.id)).toHaveLength(2);
    expect((await linesOf(entry.id))[0].debit).toBe('5000');
    expect((await unitsOf(entry.id)).map((unit) => unit.order_item_id)).toEqual([order.orderItemIds[0]]);
    expect(await deferredBalance(order.orderId)).toBe(5000);
  });

  test('FREQ-563-AC-06: 同じ発送票を2回流しても1本だけで2回目は何も入れない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 2 }] });
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 2 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    expect(await run()).toEqual(none);
    expect(await entriesOf(slip.number)).toHaveLength(1);
    expect(await entryCount()).toBe(1);
    // The same event through the core again answers created=false with the same entry.
    const [entry] = await entriesOf(slip.number);
    const again = (await q(
      `select private.accounting_post_journal_core(null, $1::uuid, $2::date, 'shipment_confirmed', ARRAY[$3]::text[], 'again', $4::jsonb) as r`,
      [entry.period_id, '2026-06-20', slip.number, JSON.stringify([
        { account_code: '2150', debit: 10000, credit: 0, order_id: order.orderId, memo: 'H fixture × 2' },
        { account_code: '4010', debit: 0, credit: 10000, order_id: order.orderId }])])).rows[0].r;
    expect(again).toMatchObject({ entry_id: entry.id, created: false });
  });

  test('FREQ-563-AC-01: 1枚の発送票に2つの注文があれば、品ごとの行にそれぞれの注文番号が付き、仕訳は1本', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const a = await seedPostedPayment(db(), { lines: shirtAndPants });
    const b = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 2 }] });
    const slip = await seedConfirmedSlip(db(), { orders: [
      slipFor(a.orderId, [{ orderItemId: a.orderItemIds[0], quantity: 1 }]),
      slipFor(b.orderId, [{ orderItemId: b.orderItemIds[0], quantity: 2 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const entries = await entriesOf(slip.number);
    expect(entries).toHaveLength(1);
    const lines = await linesOf(entries[0].id);
    expect(lines.map((line) => [line.account_code, line.order_id, line.debit, line.credit])).toEqual(expect.arrayContaining([
      ['2150', a.orderId, '18750', '0'], ['4010', a.orderId, '0', '18750'], ['2150', b.orderId, '8000', '0'], ['4010', b.orderId, '0', '8000']]));
    expect(lines).toHaveLength(4);
    expect(await deferredBalance(a.orderId)).toBe(11250);
    expect(await deferredBalance(b.orderId)).toBe(0);
    expect(await unitsOf(entries[0].id)).toHaveLength(3);
  });

  test('FREQ-563-AC-01: 12月28日に払い翌年1月5日に出荷した注文は、前受金が12月31日の残高に残り、売上は翌年の期間に入る', async () => {
    await setCutoverForTest(db(), '2025-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 15000, quantity: 1 }], createdAt: '2025-12-28T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-01-05' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const [entry] = await entriesOf(slip.number);
    expect(entry).toMatchObject({ entry_date: '2026-01-05', period_starts_on: '2026-01-01' });
    // At the end of 2025 the whole payment is still deferred revenue; the revenue is booked in the next year.
    const endOf2025 = Number((await q(
      `select coalesce(sum(l.credit - l.debit), 0) as b from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
       where l.order_id = $1 and l.account_code = '2150' and e.entry_date <= '2025-12-31'`, [order.orderId])).rows[0].b);
    expect(endOf2025).toBe(15000);
    expect(await deferredBalance(order.orderId)).toBe(0);
    const revenueIn2025 = Number((await q(
      `select count(*) as n from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
       where l.order_id = $1 and l.account_code = '4010' and e.entry_date <= '2025-12-31'`, [order.orderId])).rows[0].n);
    expect(revenueIn2025).toBe(0);
  });

  async function tamperSlipLine(slipId: string, orderItemId: string, quantity: number) {
    await q('set local session_replication_role = replica');
    await q('update public.shipment_slip_lines set quantity = $3 where slip_id = $1 and order_item_id = $2', [slipId, orderItemId, quantity]);
    await q('set local session_replication_role = origin');
  }

  test('FREQ-563-AC-04: 発送票の明細と発送ごとの明細の数量が食い違えばshipment_lines_mismatchで止まり、直ると入る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 3 }] });
    const [item] = order.orderItemIds;
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: item, quantity: 2 }])], shipmentDate: '2026-06-20' });
    await tamperSlipLine(slip.slipId, item, 3);
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf(slip.slipId)).toMatchObject({ reason: 'shipment_lines_mismatch', detail: {} });
    expect(await entryCount()).toBe(0);
    await tamperSlipLine(slip.slipId, item, 2);
    expect(await run()).toEqual({ ...none, posted: 1, resolved: 1 });
    const [entry] = await entriesOf(slip.number);
    expect((await linesOf(entry.id))[0].debit).toBe('10000');
    expect((await pendingOf(slip.slipId))?.resolved_entry_id).toBe(entry.id);
  });

  test('FREQ-563-AC-04: 未解決の計上待ちの発送票が取り消されると、計上待ちが自動で解決済みになる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }], paidAt: '2026-06-10T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect((await pendingOf(slip.slipId))?.resolved_at).toBeNull();
    await cancelSlip(db(), slip.slipId);
    expect(await run()).toEqual({ ...none, resolved: 1 });
    const closed = await pendingOf(slip.slipId);
    expect(closed?.resolved_at).not.toBeNull();
    expect(closed?.resolved_entry_id).toBeNull();
    expect(closed?.reason).toBe('payment_journal_missing');
    expect(await entryCount()).toBe(0);
    expect(await run()).toEqual(none);
  });

  test('FREQ-564-AC-04: 出荷が計上待ちに2か月以上止まっても、発送票をすぐ確定していれば遅れの印が付かず、recorded_atは係が入れた時刻になる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }], paidAt: '2026-06-10T03:00:00Z' });
    // The slip was confirmed on the shipment day, but the payment entry is missing for months.
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])],
      shipmentDate: '2026-06-20', confirmedAt: '2026-06-20T05:00:00Z' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: order.total, createdAt: '2026-06-10T03:00:00Z' });
    await postPayments();
    const before = (await q('select clock_timestamp() as t')).rows[0].t as Date;
    expect(await run()).toEqual({ ...none, posted: 1, resolved: 1 });
    const [entry] = await entriesOf(slip.number);
    expect(entry.is_late).toBe(false);
    expect(new Date(entry.source_recorded_at).toISOString()).toBe('2026-06-20T05:00:00.000Z');
    // recorded_at is the time the poster stored it, months after the shipment day.
    expect(new Date(entry.recorded_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  test('FREQ-564-AC-04: 発送票の確定が出荷日から2か月以上遅ければ遅れの印が付く', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }] });
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])],
      shipmentDate: '2026-06-20', confirmedAt: '2026-09-25T05:00:00Z' });
    await run();
    const [entry] = await entriesOf(slip.number);
    expect(entry.is_late).toBe(true);
    expect(new Date(entry.source_recorded_at).toISOString()).toBe('2026-09-25T05:00:00.000Z');
  });

  async function corporationWithoutPeriods() {
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
  }

  test('FREQ-569-AC-01: 出荷の確定がperiod_missingで止まるとdetail.entry_dateに入れようとした仕訳の日が入る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }] });
    await corporationWithoutPeriods();
    // 2027: no period covers the day and a corporation never gets one made for it.
    const slip = await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2027-01-05' });
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    const parked = await pendingOf(slip.slipId);
    expect(parked).toMatchObject({ reason: 'period_missing', detail: { entry_date: '2027-01-05' }, resolved_at: null });
    expect(parked?.detail.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The period is made: the next call posts it and resolves the row.
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-12-01', endsOn: '2027-11-30' });
    expect(await run()).toEqual({ ...none, posted: 1, resolved: 1 });
    expect((await entriesOf(slip.number))[0].entry_date).toBe('2027-01-05');
  });

  test('FREQ-569-AC-06: 出荷1件の失敗で取り消しや着の記録の片方だけを残さずほかの出荷は計上される', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const failing = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }] });
    const fine = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 1 }] });
    // Two sole periods with a gap: the core numbers and inserts an entry in 2026 and then refuses it (PERIOD_GAP).
    const gapped = (await q("select id from public.accounting_periods where business_type = 'soleProprietor' and starts_on = '2026-01-01'")).rows[0].id as string;
    await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2028-01-01', endsOn: '2028-12-31' });
    const corporation = await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2029-01-01', endsOn: '2029-12-31' });
    const slipFailing = await seedConfirmedSlip(db(), { orders: [slipFor(failing.orderId, [{ orderItemId: failing.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    const slipFine = await seedConfirmedSlip(db(), { orders: [slipFor(fine.orderId, [{ orderItemId: fine.orderItemIds[0], quantity: 1 }])], shipmentDate: '2029-03-01' });
    const before = Number((await q('select last_entry_no from public.accounting_period_sequences where period_id = $1', [gapped])).rows[0].last_entry_no);
    expect(await run()).toEqual({ ...none, posted: 1, parked_new: 1 });
    expect(await pendingOf(slipFailing.slipId)).toMatchObject({ reason: 'posting_error', order_id: failing.orderId,
      detail: { error_sqlstate: '23514', error_code: 'ACCOUNTING_PERIOD_GAP', entry_date: '2026-06-20' } });
    // Neither the entry, its units nor its number of the failed slip stay.
    expect(await entriesOf(slipFailing.number)).toHaveLength(0);
    expect(Number((await q('select last_entry_no from public.accounting_period_sequences where period_id = $1', [gapped])).rows[0].last_entry_no)).toBe(before);
    expect(Number((await q('select count(*) as n from public.accounting_shipment_units u join public.order_items oi on oi.id = u.order_item_id where oi.order_id = $1',
      [failing.orderId])).rows[0].n)).toBe(0);
    // The next slip is in, in the corporation period.
    const [entry] = await entriesOf(slipFine.number);
    expect(entry).toMatchObject({ period_id: corporation, entry_date: '2029-03-01' });
    expect(await unitsOf(entry.id)).toHaveLength(1);
    expect(Object.keys((await pendingOf(slipFailing.slipId))?.detail ?? {}).sort()).toEqual(['entry_date', 'error_code', 'error_sqlstate']);
  });

  test('FREQ-569-AC-06: 確定の事実が無い発送票はposting_errorで止まり、ほかの出荷は計上される', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const broken = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 1 }] });
    const fine = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 1 }] });
    const noFact = await seedConfirmedSlip(db(), { orders: [slipFor(broken.orderId, [{ orderItemId: broken.orderItemIds[0], quantity: 1 }])],
      shipmentDate: '2026-06-20', recordFact: false });
    const ok = await seedConfirmedSlip(db(), { orders: [slipFor(fine.orderId, [{ orderItemId: fine.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, posted: 1, parked_new: 1 });
    expect(await pendingOf(noFact.slipId)).toMatchObject({ reason: 'posting_error' });
    expect(await entriesOf(ok.number)).toHaveLength(1);
  });

  test('FREQ-563-AC-06: 1回の呼び出しは新しい出来事を確定の番号の順に _limit 件までで切り、_limit が範囲外なら断る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const slips = [];
    for (let i = 0; i < 3; i += 1) {
      const order = await seedPostedPayment(db(), { lines: [{ price: 1000 + i, quantity: 1 }] });
      slips.push(await seedConfirmedSlip(db(), { orders: [slipFor(order.orderId, [{ orderItemId: order.orderItemIds[0], quantity: 1 }])], shipmentDate: '2026-06-20' }));
    }
    expect(await run(2)).toEqual({ ...none, posted: 2 });
    expect(await entriesOf(slips[0].number)).toHaveLength(1);
    expect(await entriesOf(slips[1].number)).toHaveLength(1);
    expect(await entriesOf(slips[2].number)).toHaveLength(0);
    expect(await run(2)).toEqual({ ...none, posted: 1 });
    for (const bad of [0, -1, 201, null]) {
      await q('savepoint bad_limit');
      await expect(q('select private.accounting_post_shipment_events($1::integer)', [bad])).rejects.toMatchObject({ code: '22023' });
      await q('rollback to savepoint bad_limit');
    }
  });
});
