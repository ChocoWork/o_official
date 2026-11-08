/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { describeLocalDb } from './helpers/local-db';
import { insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import {
  cancelSlip, correctShipmentDate, seedConfirmedSlip, setAsideExistingSlips, seedPostedPayment, setCutoverForTest, shippedUnits,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 3 (FREQ-564, FREQ-563-AC-04, FREQ-569-AC-01/AC-06): the cancellation and the date correction of a
// shipment entry, and the two reads. ROLLBACK form (run with --runInBand): setCutoverForTest holds the settings table.
jest.setTimeout(120000);

type RunResult = { posted: number; parked_new: number; reparked: number; resolved: number; reversed: number; redated: number };

describeLocalDb('S8 shipment corrections: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
  });
  afterEach(async () => { await q('rollback'); });

  const run = async (limit = 50): Promise<RunResult> =>
    (await q('select private.accounting_post_shipment_events($1::integer) as r', [limit])).rows[0].r as RunResult;
  const none: RunResult = { posted: 0, parked_new: 0, reparked: 0, resolved: 0, reversed: 0, redated: 0 };
  const entryRow = async (where: string, param: string) => (await q(
    `select e.id, e.event_kind, e.dedupe_key, e.description, e.reason, e.reverses_entry_id, e.source_table, e.source_id, e.recorded_by,
       to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.period_id, e.source_recorded_at, e.is_late,
       to_char(p.starts_on, 'YYYY-MM-DD') as period_starts_on
     from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id where ${where}`, [param])).rows;
  const confirmedEntry = async (number: string) => (await entryRow('e.dedupe_key = $1', 'shipment_confirmed:' + number))[0];
  const reversalOf = async (entryId: string) => (await entryRow('e.reverses_entry_id = $1::uuid', entryId))[0];
  const redatedEntry = async (historyId: string) => (await entryRow('e.dedupe_key = $1', 'shipment_redated:' + historyId))[0];
  const linesOf = async (entryId: string) => (await q(
    `select line_no, account_code, debit::text as debit, credit::text as credit, order_id, sub_account, counterparty, memo
     from public.accounting_journal_lines where entry_id = $1 order by line_no`, [entryId])).rows;
  const unitsOf = async (entryId: string) => (await q(
    `select order_item_id, unit_index, paid_amount, refunded_amount from public.accounting_shipment_units
     where entry_id = $1 order by order_item_id, unit_index`, [entryId])).rows;
  const deferredBalance = async (orderId: string) => Number((await q(
    "select coalesce(sum(credit - debit), 0) as b from public.accounting_journal_lines where order_id = $1 and account_code = '2150'",
    [orderId])).rows[0].b);
  const pendingRows = async (kind: string) => (await q(
    `select reason, detail, resolved_at, resolved_entry_id, source_table, source_id, detection_count
     from public.accounting_pending_events where event_kind = $1 order by first_detected_at, id`, [kind])).rows;

  /** An order with a payment entry and one shipped slip (2026-06-20) already posted. */
  async function postedShipment(input: { lines?: Array<{ price: number; quantity: number; unitAmounts?: number[] }>; quantity?: number;
    paidAt?: string; shipmentDate?: string } = {}) {
    await setCutoverForTest(db(), '2025-01-01');
    const order = await seedPostedPayment(db(), { lines: input.lines ?? [{ price: 5000, quantity: 3 }], createdAt: input.paidAt });
    const slip = await seedConfirmedSlip(db(), {
      orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: input.quantity ?? 2 }] }],
      shipmentDate: input.shipmentDate ?? '2026-06-20' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    return { order, slip, entry: await confirmedEntry(slip.number) };
  }

  test('FREQ-564-AC-01: 発送の取り消しは元の仕訳の借貸を入れ替えた仕訳を足し、元の日の日付で、元の仕訳は変わらない', async () => {
    const { order, slip, entry } = await postedShipment();
    const originalLines = await linesOf(entry.id);
    expect(await deferredBalance(order.orderId)).toBe(5000);
    await cancelSlip(db(), slip.slipId);
    const cancelledAt = (await q('select cancelled_at from public.shipment_slips where id = $1', [slip.slipId])).rows[0].cancelled_at as Date;
    expect(await run()).toEqual({ ...none, posted: 1, reversed: 1 });
    const reversal = await reversalOf(entry.id);
    expect(reversal).toMatchObject({ event_kind: 'reversal', dedupe_key: `reversal:${entry.id}`, entry_date: '2026-06-20',
      reason: ACCOUNTING_LABELS.shipmentCancelled, reverses_entry_id: entry.id, description: entry.description, recorded_by: null,
      source_table: 'shipment_slips', source_id: slip.slipId, period_id: entry.period_id });
    expect(new Date(reversal.source_recorded_at).getTime()).toBe(cancelledAt.getTime());
    // Debit and credit are swapped, line by line.
    expect((await linesOf(reversal.id)).map((l) => [l.account_code, l.debit, l.credit, l.order_id])).toEqual(
      originalLines.map((l) => [l.account_code, l.credit, l.debit, l.order_id]));
    // The original entry and its lines are as they were.
    expect(await confirmedEntry(slip.number)).toEqual(entry);
    expect(await linesOf(entry.id)).toEqual(originalLines);
    expect(await deferredBalance(order.orderId)).toBe(15000);
    expect(await run()).toEqual(none);
    expect(Number((await q("select count(*) as n from public.accounting_journal_entries where event_kind = 'reversal'")).rows[0].n)).toBe(1);
  });

  test('FREQ-564-AC-01: 取り消した発送票の着は、もう一度出荷すれば同じ着から送られる', async () => {
    const { order, slip, entry } = await postedShipment({ lines: [{ price: 5000, quantity: 3 }], quantity: 2 });
    const item = order.orderItemIds[0];
    expect((await shippedUnits(db(), item)).map((u) => u.unit)).toEqual([0, 1]);
    await cancelSlip(db(), slip.slipId);
    // The cancel number alone sets the units free; no entry has to exist for that.
    expect(await shippedUnits(db(), item)).toEqual([]);
    await run();
    const again = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: item, quantity: 2 }] }], shipmentDate: '2026-06-22' });
    expect((await shippedUnits(db(), item)).map((u) => u.unit)).toEqual([0, 1]);
    expect(await run()).toEqual({ ...none, posted: 1 });
    const next = await confirmedEntry(again.number);
    expect(await unitsOf(next.id)).toEqual(await unitsOf(entry.id));
  });

  test('FREQ-564-AC-02: 出荷日の直しは、元の日の取り消しと、直した日の同じ行の仕訳になる', async () => {
    const { order, slip, entry } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    const originalLines = await linesOf(entry.id);
    const historyId = await correctShipmentDate(db(), slip.slipId, '2026-06-25', { reason: 'Wrong day typed' });
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1 });
    const reversal = await reversalOf(entry.id);
    expect(reversal).toMatchObject({ event_kind: 'reversal', dedupe_key: `reversal:${entry.id}`, entry_date: '2026-06-20',
      reason: 'Wrong day typed', period_id: entry.period_id });
    const redated = await redatedEntry(historyId);
    expect(redated).toMatchObject({ event_kind: 'shipment_redated', dedupe_key: `shipment_redated:${historyId}`, entry_date: '2026-06-25',
      description: ACCOUNTING_LABELS.shipmentRevenue, source_table: 'shipment_slips', source_id: slip.slipId, recorded_by: null });
    const content = (rows: Array<Record<string, unknown>>) => rows.map((row) => [row.account_code, row.debit, row.credit, row.order_id, row.memo]);
    expect(content(await linesOf(redated.id))).toEqual(content(originalLines));
    // The units move to the new entry.
    expect(await unitsOf(redated.id)).toEqual(await unitsOf(entry.id));
    expect(await unitsOf(redated.id)).toHaveLength(2);
    // Net effect: the same revenue, on the new day only.
    expect(await deferredBalance(order.orderId)).toBe(5000);
    expect(await confirmedEntry(slip.number)).toEqual(entry);
    expect(await run()).toEqual(none);
  });

  test('FREQ-564-AC-02: 日の直しで別の期間にまたがっても、取り消しは元の期間、正しい仕訳は新しい期間に入る', async () => {
    await setCutoverForTest(db(), '2025-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 15000, quantity: 1 }], createdAt: '2025-12-28T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
      shipmentDate: '2026-01-05' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const entry = await confirmedEntry(slip.number);
    expect(entry.period_starts_on).toBe('2026-01-01');
    const historyId = await correctShipmentDate(db(), slip.slipId, '2025-12-30');
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1 });
    const reversal = await reversalOf(entry.id);
    expect(reversal).toMatchObject({ entry_date: '2026-01-05', period_starts_on: '2026-01-01', period_id: entry.period_id });
    const redated = await redatedEntry(historyId);
    expect(redated).toMatchObject({ entry_date: '2025-12-30', period_starts_on: '2025-01-01' });
    expect(redated.period_id).not.toBe(entry.period_id);
    // At the end of 2025 the revenue is now in 2025: the deferred revenue is gone by then.
    const endOf2025 = Number((await q(
      `select coalesce(sum(l.credit - l.debit), 0) as b from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
       where l.order_id = $1 and l.account_code = '2150' and e.entry_date <= '2025-12-31'`, [order.orderId])).rows[0].b);
    expect(endOf2025).toBe(0);
  });

  test('FREQ-564-AC-02: 直した先の日が期間の無い日ならperiod_missingで止まり、元の仕訳は取り消されないまま残る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 2 }], createdAt: '2026-01-05T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
      shipmentDate: '2026-02-01' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const entry = await confirmedEntry(slip.number);
    // The sole business ended on 31 March and no corporation has started: a day after it has no period.
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q('select public.admin_shorten_final_sole_period($1::uuid, $2::uuid, $3::date, 1, $4::bigint, null, $5::uuid)',
      [admin, entry.period_id, '2026-03-31', settings.v, randomUUID()]);
    const historyId = await correctShipmentDate(db(), slip.slipId, '2026-05-01');
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    const [parked] = await pendingRows('shipment_redated');
    expect(parked).toMatchObject({ reason: 'period_missing', source_table: 'shipment_date_history', source_id: historyId,
      detail: { entry_date: '2026-05-01', cause: 'sole_ended_not_switched' }, resolved_at: null });
    // The first entry is not reversed and no new one exists.
    expect(await reversalOf(entry.id)).toBeUndefined();
    expect(await redatedEntry(historyId)).toBeUndefined();
    expect(await run()).toEqual({ ...none, reparked: 1 });
    expect(Number((await q('select count(*) as n from public.accounting_journal_entries')).rows[0].n)).toBe(2);
  });

  test('FREQ-564-AC-02: 日を2回直しても取り消しは1回ずつで、最後の日の仕訳だけが残る', async () => {
    const { order, slip, entry } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    const first = await correctShipmentDate(db(), slip.slipId, '2026-06-25');
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1 });
    const second = await correctShipmentDate(db(), slip.slipId, '2026-06-28');
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1 });
    const middle = await redatedEntry(first);
    const last = await redatedEntry(second);
    expect(last.entry_date).toBe('2026-06-28');
    expect((await reversalOf(entry.id)).entry_date).toBe('2026-06-20');
    expect((await reversalOf(middle.id)).entry_date).toBe('2026-06-25');
    expect(await reversalOf(last.id)).toBeUndefined();
    expect(Number((await q("select count(*) as n from public.accounting_journal_entries where event_kind = 'reversal'")).rows[0].n)).toBe(2);
    expect(await deferredBalance(order.orderId)).toBe(5000);
    expect(await run()).toEqual(none);
  });

  test('FREQ-564-AC-02: 流す前に2回直されていれば、古い直しの仕訳は作らず新しい直しの1回で入れ直す', async () => {
    const { order, slip, entry } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    const first = await correctShipmentDate(db(), slip.slipId, '2026-06-25');
    const second = await correctShipmentDate(db(), slip.slipId, '2026-06-28');
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1 });
    expect(await redatedEntry(first)).toBeUndefined();
    expect((await redatedEntry(second)).entry_date).toBe('2026-06-28');
    expect(await reversalOf(entry.id)).toBeDefined();
    expect(await deferredBalance(order.orderId)).toBe(5000);
  });

  test('FREQ-564-AC-02: 古い直しが止まっていて新しい直しに追い越されると、古い直しの計上待ちは自動で解決済みになる', async () => {
    const { slip, entry } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    // The first correction cannot be posted (the day is before the cutover day).
    await setCutoverForTest(db(), '2026-06-22');
    const first = await correctShipmentDate(db(), slip.slipId, '2026-06-21');
    expect(await run()).toEqual({ ...none, parked_new: 1 });
    expect((await pendingRows('shipment_redated'))[0]).toMatchObject({ reason: 'before_cutover', source_id: first, resolved_at: null });
    const second = await correctShipmentDate(db(), slip.slipId, '2026-06-28');
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1, resolved: 1 });
    const [overtaken] = await pendingRows('shipment_redated');
    expect(overtaken.resolved_at).not.toBeNull();
    expect(overtaken.resolved_entry_id).toBeNull();
    expect((await redatedEntry(second)).entry_date).toBe('2026-06-28');
    expect(await reversalOf(entry.id)).toBeDefined();
  });

  test('FREQ-564-AC-02: 同じ直しを何度流しても1回だけ', async () => {
    const { slip, entry } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    const history = await correctShipmentDate(db(), slip.slipId, '2026-06-25');
    expect(await run()).toEqual({ ...none, posted: 1, redated: 1 });
    expect(await run()).toEqual(none);
    expect(await run()).toEqual(none);
    expect(Number((await q("select count(*) as n from public.accounting_journal_entries where event_kind = 'shipment_redated'")).rows[0].n)).toBe(1);
    expect(Number((await q("select count(*) as n from public.accounting_journal_entries where reverses_entry_id = $1", [entry.id])).rows[0].n)).toBe(1);
    expect(await redatedEntry(history)).toBeDefined();
  });

  test('FREQ-569-AC-01: 日の直しがperiod_missingで止まるとdetail.entry_dateに入れようとした新しい日が入る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 2 }], createdAt: '2026-01-05T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
      shipmentDate: '2026-02-01' });
    await run();
    const entry = await confirmedEntry(slip.number);
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q('select public.admin_shorten_final_sole_period($1::uuid, $2::uuid, $3::date, 1, $4::bigint, null, $5::uuid)',
      [admin, entry.period_id, '2026-03-31', settings.v, randomUUID()]);
    await correctShipmentDate(db(), slip.slipId, '2026-05-02');
    await run();
    const [parked] = await pendingRows('shipment_redated');
    expect(parked.reason).toBe('period_missing');
    expect(parked.detail.entry_date).toBe('2026-05-02');
    expect(parked.detail.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('FREQ-569-AC-06: 日の直しの後半で落ちても前半の取り消しを残さず、ほかの出荷は計上される', async () => {
    await setCutoverForTest(db(), '2025-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 2 }], createdAt: '2026-06-10T03:00:00Z' });
    const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
      shipmentDate: '2026-06-20' });
    expect(await run()).toEqual({ ...none, posted: 1 });
    const entry = await confirmedEntry(slip.number);
    // The new day is in a corporation period that has a gap before the next one: the core refuses that entry after it
    // has taken a number, while the cancellation (a sole entry) has already been written.
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-10-01', endsOn: '2027-03-31' });
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2028-04-01', endsOn: '2029-03-31' });
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    const other = await seedPostedPayment(db(), { lines: [{ price: 4000, quantity: 1 }], createdAt: '2026-06-11T03:00:00Z' });
    const otherSlip = await seedConfirmedSlip(db(), { orders: [{ orderId: other.orderId, lines: [{ orderItemId: other.orderItemIds[0], quantity: 1 }] }],
      shipmentDate: '2026-06-21' });
    const historyId = await correctShipmentDate(db(), slip.slipId, '2026-10-15');
    const sequences = (await q('select period_id, last_entry_no from public.accounting_period_sequences order by period_id')).rows;
    const result = await run();
    expect(result).toEqual({ ...none, posted: 1, parked_new: 1 });
    const [failed] = await pendingRows('shipment_redated');
    expect(failed).toMatchObject({ reason: 'posting_error', source_id: historyId, resolved_at: null });
    expect(Object.keys(failed.detail).sort()).toEqual(['entry_date', 'error_code', 'error_sqlstate']);
    // The cancellation is not left behind, and no unit or entry of the new day exists.
    expect(await reversalOf(entry.id)).toBeUndefined();
    expect(await redatedEntry(historyId)).toBeUndefined();
    expect(Number((await q("select count(*) as n from public.accounting_journal_entries where event_kind = 'shipment_redated'")).rows[0].n)).toBe(0);
    // The other slip is posted in the same call.
    expect(await confirmedEntry(otherSlip.number)).toBeDefined();
    const after = (await q('select period_id, last_entry_no from public.accounting_period_sequences order by period_id')).rows;
    const touched = after.filter((row) => !sequences.some((s) => s.period_id === row.period_id && s.last_entry_no === row.last_entry_no));
    expect(touched).toHaveLength(1);
  });

  test('FREQ-564-AC-03: 仕訳から発送票の直した跡（理由・人・前後の日）をたどれる', async () => {
    const { slip, entry } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    const actor = await insertAccountingAdmin(db());
    const historyId = await correctShipmentDate(db(), slip.slipId, '2026-06-25', { reason: 'Wrong day typed', actorId: actor });
    await run();
    const trace = (await q('select public.get_shipment_journal_trace($1::uuid) as t', [slip.slipId])).rows[0].t;
    expect(trace.slip).toMatchObject({ number: slip.number, shipment_date: '2026-06-25', stage: 'confirmed' });
    expect(new Date(trace.slip.confirmed_at).getTime()).toBe((await q('select confirmed_at from public.shipment_slips where id = $1', [slip.slipId])).rows[0].confirmed_at.getTime());
    expect(trace.history.map((h: { version: number; kind: string }) => [h.version, h.kind])).toEqual([[1, 'initial'], [2, 'correction']]);
    expect(trace.history[1]).toMatchObject({ previous_date: '2026-06-20', new_date: '2026-06-25', reason: 'Wrong day typed', actor_id: actor });
    expect(Object.keys(trace.history[1]).sort()).toEqual(['actor_id', 'created_at', 'kind', 'new_date', 'previous_date', 'reason', 'version']);
    const redated = await redatedEntry(historyId);
    const reversal = await reversalOf(entry.id);
    expect(trace.entries.map((e: { entry_id: string }) => e.entry_id).sort()).toEqual([entry.id, redated.id, reversal.id].sort());
    expect(trace.entries.find((e: { entry_id: string }) => e.entry_id === reversal.id)).toMatchObject({ event_kind: 'reversal', reverses_entry_id: entry.id });
    expect(Object.keys(trace.entries[0]).sort()).toEqual(['entry_date', 'entry_id', 'entry_no', 'event_kind', 'recorded_at', 'reverses_entry_id']);
    await q('savepoint missing');
    await expect(q('select public.get_shipment_journal_trace($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    await q('rollback to savepoint missing');
  });

  test('FREQ-564-AC-04: 出荷した日と登録した日を並べる材料に、出荷の仕訳の日と発送票を確定した日が出る', async () => {
    await setCutoverForTest(db(), '2025-01-01');
    const order = await seedPostedPayment(db(), { lines: [{ price: 5000, quantity: 2 }] });
    const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
      shipmentDate: '2026-06-20', confirmedAt: '2026-06-20T05:30:00Z' });
    await run();
    const entry = await confirmedEntry(slip.number);
    const payment = (await q('select id from public.accounting_journal_entries where id = $1', [order.paymentEntryId])).rows[0].id as string;
    const rows = (await q('select entry_id, slip_number, shipment_date::text as shipment_date, confirmed_at from public.list_journal_shipment_meta($1::uuid[])', [[entry.id, payment]])).rows;
    // Only the shipment entry has a slip; the payment entry is not in the answer.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: entry.id, slip_number: slip.number });
    expect(rows[0].shipment_date).toBe('2026-06-20');
    // The registered day is the day the slip was confirmed, not the time the entry was stored (which is later).
    expect(new Date(rows[0].confirmed_at).toISOString()).toBe('2026-06-20T05:30:00.000Z');
    const stored = (await q('select recorded_at from public.accounting_journal_entries where id = $1', [entry.id])).rows[0].recorded_at as Date;
    expect(stored.getTime()).toBeGreaterThan(new Date(rows[0].confirmed_at).getTime());
    await cancelSlip(db(), slip.slipId);
    await run();
    // The cancellation entry points at the same slip.
    const reversal = await reversalOf(entry.id);
    const both = (await q('select entry_id from public.list_journal_shipment_meta($1::uuid[]) order by entry_id', [[entry.id, reversal.id]])).rows;
    expect(both.map((r) => r.entry_id).sort()).toEqual([entry.id, reversal.id].sort());
    await q('savepoint too_many');
    await expect(q('select * from public.list_journal_shipment_meta($1::uuid[])', [Array.from({ length: 201 }, () => randomUUID())]))
      .rejects.toMatchObject({ code: '22023' });
    await q('rollback to savepoint too_many');
  });

  test('FREQ-563-AC-04: G-3の読み口list_shipment_accounting_inputsの列と動きは変わらない', async () => {
    const { slip, order } = await postedShipment({ paidAt: '2026-06-10T03:00:00Z' });
    const result = await q('select * from private.list_shipment_accounting_inputs($1::date, $2::date, 10)', ['2026-06-01', '2026-06-30']);
    expect(Object.keys(result.rows[0])).toEqual(['slip_id', 'fulfillment_id', 'order_item_id', 'quantity', 'shipment_date', 'revision_id', 'cancelled_at']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ slip_id: slip.slipId, order_item_id: order.orderItemIds[0], quantity: 2, cancelled_at: null });
    const history = (await q("select id from public.shipment_date_history where slip_id = $1 and kind = 'initial'", [slip.slipId])).rows[0].id;
    expect(result.rows[0].revision_id).toBe(history);
  });
});
