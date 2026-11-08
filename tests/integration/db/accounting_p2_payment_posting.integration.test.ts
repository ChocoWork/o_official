/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { describeLocalDb } from './helpers/local-db';
import { insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import { seedPaidOrder, seedStripeCharge, setCutoverForTest } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 2 (FREQ-562 / FREQ-569): the payment posting (Stripe receivable 1160 / deferred revenue 2150).
// ROLLBACK form (run with --runInBand): setCutoverForTest holds the settings table until the rollback.
jest.setTimeout(120000);

type RunResult = { posted: number; parked_new: number; reparked: number; resolved: number };
type PendingRow = { reason: string; detail: Record<string, unknown>; resolved_at: Date | null; resolved_entry_id: string | null;
  detection_count: number; order_id: string | null; event_kind: string };

describeLocalDb('S7 payment posting: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    // The group G lock: the order fixtures write unit rows that need it.
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await q('rollback'); });

  const run = async (limit = 50): Promise<RunResult> =>
    (await q('select private.accounting_post_payment_events($1::integer) as r', [limit])).rows[0].r as RunResult;
  const pendingOf = async (txId: string): Promise<PendingRow | undefined> => (await q(
    `select reason, detail, resolved_at, resolved_entry_id, detection_count, order_id, event_kind
     from public.accounting_pending_events where source_table = 'stripe_balance_transactions' and source_id = $1`, [txId])).rows[0];
  const entriesOf = async (pi: string) => (await q(
    `select e.id, e.event_kind, e.dedupe_key, e.description, e.source_table, e.source_id, e.recorded_by, e.recorded_at,
       to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.period_id, e.entry_no, e.is_late, e.source_recorded_at, to_char(p.starts_on, 'YYYY-MM-DD') as period_starts_on
     from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id
     where e.dedupe_key = $1`, ['payment_confirmed:' + pi])).rows;
  const linesOf = async (entryId: string) => (await q(
    `select line_no, account_code, debit::text as debit, credit::text as credit, order_id, sub_account, counterparty, memo
     from public.accounting_journal_lines where entry_id = $1 order by line_no`, [entryId])).rows;
  const entryCount = async () => Number((await q('select count(*) as n from public.accounting_journal_entries')).rows[0].n);
  const sole = (price = 5000, quantity = 3) => ({ lines: [{ price, quantity }] });
  /** An order with one line and the Stripe charge that paid it. */
  async function paidPair(input: { createdAt: string; price?: number; quantity?: number; paidAt?: string | null; amount?: number;
    shippingAmount?: number; status?: 'paid' | 'pending' | 'payment_in_progress' }) {
    const order = await seedPaidOrder(db(), {
      lines: [{ price: input.price ?? 5000, quantity: input.quantity ?? 3 }], paidAt: input.paidAt, shippingAmount: input.shippingAmount,
      status: input.status,
    });
    const txId = await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: input.amount ?? order.total,
      createdAt: input.createdAt, fee: 540 });
    return { ...order, txId, pi: order.paymentIntentId as string };
  }

  test('FREQ-562-AC-01: 支払いは借方1160貸方2150の仕訳1本で、額は手数料を引く前の総額で、2150の行に注文番号が付く', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    expect(pair.total).toBe(15000);
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    const entries = await entriesOf(pair.pi);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event_kind: 'payment_confirmed', description: ACCOUNTING_LABELS.paymentReceived,
      source_table: 'stripe_balance_transactions', source_id: pair.txId, entry_date: '2026-06-15' });
    const lines = await linesOf(entries[0].id);
    // The fee (540) is not taken off: the amount is the whole charge.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line_no: 1, account_code: '1160', debit: '15000', credit: '0', order_id: pair.orderId });
    expect(lines[1]).toMatchObject({ line_no: 2, account_code: '2150', debit: '0', credit: '15000', order_id: pair.orderId });
    expect(await pendingOf(pair.txId)).toBeUndefined();
  });

  test('FREQ-562-AC-01: 印は payment_confirmed:<payment_intent>', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    await run();
    const entries = await entriesOf(pair.pi);
    expect(entries).toHaveLength(1);
    expect(entries[0].dedupe_key).toBe(`payment_confirmed:${pair.pi}`);
    expect(entries[0].dedupe_key).toBe((await q("select private.accounting_event_key('payment_confirmed', ARRAY[$1]) as k", [pair.pi])).rows[0].k);
  });

  test('FREQ-562-AC-01: 記録の人はNULLで登録日時は流した時刻になる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    const before = (await q('select clock_timestamp() as t')).rows[0].t as Date;
    await run();
    const [entry] = await entriesOf(pair.pi);
    const after = (await q('select clock_timestamp() as t')).rows[0].t as Date;
    expect(entry.recorded_by).toBeNull();
    // Not the time of the Stripe charge (2026-06-15) but the time of the run.
    expect(new Date(entry.recorded_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(new Date(entry.recorded_at).getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  test('FREQ-562-AC-01: 支払いの途中の注文でも払われたお金があれば仕訳にする（お金の事実を正とする）', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const midway = await paidPair({ createdAt: '2026-06-15T03:00:00Z', status: 'payment_in_progress', paidAt: null });
    const pending = await paidPair({ createdAt: '2026-06-15T04:00:00Z', status: 'pending', paidAt: null });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entriesOf(midway.pi)).toHaveLength(1);
    expect(await entriesOf(pending.pi)).toHaveLength(1);
  });

  test('FREQ-562-AC-02: 手数料の行は支払いの仕訳に入れず別の出来事にする', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    // The same payment intent also has a fee row of another type: it is not a payment and posts nothing here.
    const feeTx = await seedStripeCharge(db(), { paymentIntentId: pair.pi, amount: 0, fee: 540, createdAt: '2026-06-15T03:00:01Z',
      type: 'stripe_fee', reportingCategory: 'fee' });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    const [entry] = await entriesOf(pair.pi);
    expect(await linesOf(entry.id)).toHaveLength(2);
    expect(await pendingOf(feeTx)).toBeUndefined();
    expect(await entryCount()).toBe(1);
  });

  test('FREQ-562-AC-02: Stripeの総額が注文の合計と違えばamount_mismatchで止め仕訳を作らない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z', amount: 14000 });
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await entriesOf(pair.pi)).toHaveLength(0);
    expect(await entryCount()).toBe(0);
    expect(await pendingOf(pair.txId)).toMatchObject({ event_kind: 'payment_confirmed', reason: 'amount_mismatch', order_id: pair.orderId,
      detail: { stripe_amount: 14000, order_total: 15000 }, resolved_at: null, detection_count: 1 });
    // The second run reviews it again (a re-park, not a new one) and it stays out of the entries.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 1, resolved: 0 });
    expect((await pendingOf(pair.txId))?.detection_count).toBe(2);
  });

  test('FREQ-562-AC-02: 送料の欄が0でない注文はorder_not_postableで止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z', shippingAmount: 500 });
    expect(pair.total).toBe(15500);
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(pair.txId)).toMatchObject({ reason: 'order_not_postable', detail: { reason: 'shipping' }, order_id: pair.orderId });
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-562-AC-02: 1着ごとの支払額の合計が注文の合計と違う注文と、支払額の行が無い注文は止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const short = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 3, unitAmounts: [5000, 5000, 4000] }] });
    const shortTx = await seedStripeCharge(db(), { paymentIntentId: short.paymentIntentId, amount: short.total, createdAt: '2026-06-15T03:00:00Z' });
    const legacy = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 3 }], legacy: true });
    const legacyTx = await seedStripeCharge(db(), { paymentIntentId: legacy.paymentIntentId, amount: legacy.total, createdAt: '2026-06-15T04:00:00Z' });
    expect(await run()).toEqual({ posted: 0, parked_new: 2, reparked: 0, resolved: 0 });
    expect(await pendingOf(shortTx)).toMatchObject({ reason: 'order_not_postable', detail: { reason: 'units_sum' } });
    expect(await pendingOf(legacyTx)).toMatchObject({ reason: 'order_not_postable', detail: { reason: 'units_missing' } });
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-562-AC-03: 1月1日の朝8時（日本時間）の支払いは1月1日の仕訳で、12月31日の期間に入らない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    // 2026-12-31T23:00Z is 2027-01-01 08:00 in Japan; paid_at is a different day and must not be used.
    const morning = await paidPair({ createdAt: '2026-12-31T23:00:00Z', paidAt: '2026-12-30T03:00:00Z' });
    // One second before Japan's midnight stays on 31 December.
    const lastSecond = await paidPair({ createdAt: '2026-12-31T14:59:59Z', paidAt: '2027-01-02T03:00:00Z' });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    const [first] = await entriesOf(morning.pi);
    const [second] = await entriesOf(lastSecond.pi);
    expect(first.entry_date).toBe('2027-01-01');
    expect(first.period_starts_on).toBe('2027-01-01');
    expect(second.entry_date).toBe('2026-12-31');
    expect(second.period_starts_on).toBe('2026-01-01');
    expect(first.period_id).not.toBe(second.period_id);
  });

  test('FREQ-562-AC-04: 切り替えの日より前の日の支払いはbefore_cutoverで止まる', async () => {
    await setCutoverForTest(db(), '2026-06-01');
    // 2026-05-31T14:59:59Z is 23:59:59 on 31 May in Japan: before the cutover day. A second later it is 1 June.
    const before = await paidPair({ createdAt: '2026-05-31T14:59:59Z' });
    const onDay = await paidPair({ createdAt: '2026-05-31T15:00:00Z' });
    expect(await run()).toEqual({ posted: 1, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(before.txId)).toMatchObject({ reason: 'before_cutover', detail: {}, order_id: before.orderId });
    expect(await entriesOf(before.pi)).toHaveLength(0);
    expect((await entriesOf(onDay.pi))[0].entry_date).toBe('2026-06-01');
  });

  test('FREQ-562-AC-04: 期間が無い日はperiod_missingで止まり、期間を作ると次の呼び出しで入って計上待ちが解決される', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    // A corporation with no corporate period for the day: no period can be chosen or created.
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(pair.txId)).toMatchObject({ reason: 'period_missing', detail: { entry_date: '2026-06-15' }, resolved_at: null });
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 1, resolved: 0 });
    expect((await pendingOf(pair.txId))?.detection_count).toBe(2);
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-04-01', endsOn: '2027-03-31' });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 1 });
    const [entry] = await entriesOf(pair.pi);
    expect(entry.entry_date).toBe('2026-06-15');
    const resolved = await pendingOf(pair.txId);
    expect(resolved?.resolved_at).not.toBeNull();
    expect(resolved?.resolved_entry_id).toBe(entry.id);
    // Nothing is left to do.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
  });

  test('FREQ-562-AC-04: やめた日より後で法人へ未切り替えの日は period_missing に cause=sole_ended_not_switched が付く', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const admin = await insertAccountingAdmin(db());
    const period = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q('select public.admin_shorten_final_sole_period($1::uuid, $2::uuid, $3::date, 1, $4::bigint, null, $5::uuid)',
      [admin, period, '2026-03-31', settings.v, randomUUID()]);
    const pair = await paidPair({ createdAt: '2026-05-01T03:00:00Z' });
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(pair.txId)).toMatchObject({ reason: 'period_missing',
      detail: { entry_date: '2026-05-01', cause: 'sole_ended_not_switched' } });
  });

  test('FREQ-569-AC-01: 支払いがperiod_missingで止まるとdetail.entry_dateに取引の日本時間の日がYYYY-MM-DDで入る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    // 2026-12-31T20:00Z is 2027-01-01 05:00 in Japan: the date is the Japanese day, not the UTC day.
    const pair = await paidPair({ createdAt: '2026-12-31T20:00:00Z' });
    await run();
    const parked = await pendingOf(pair.txId);
    expect(parked?.reason).toBe('period_missing');
    expect(parked?.detail).toEqual({ entry_date: '2027-01-01' });
    expect(parked?.detail.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('FREQ-562-AC-05: 同じ支払いを2回流しても1本で2回目はcreated=false', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const pair = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entriesOf(pair.pi)).toHaveLength(1);
    expect(await entryCount()).toBe(1);
    // Posting the same event through the core again answers created=false with the same entry.
    const [entry] = await entriesOf(pair.pi);
    const again = (await q(
      `select private.accounting_post_journal_core(null, $1::uuid, $2::date, 'payment_confirmed', ARRAY[$3]::text[], 'again',
        $4::jsonb) as r`,
      [entry.period_id, '2026-06-15', pair.pi, JSON.stringify([
        { account_code: '1160', debit: 15000, credit: 0, order_id: pair.orderId },
        { account_code: '2150', debit: 0, credit: 15000, order_id: pair.orderId }])])).rows[0].r;
    expect(again).toMatchObject({ entry_id: entry.id, created: false });
    expect(await entryCount()).toBe(1);
  });

  test('FREQ-562-AC-05: 店頭の取引（注文に結び付かない支払い）はno_orderで止まる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const store = await seedStripeCharge(db(), { paymentIntentId: `pi_store_${randomUUID().replaceAll('-', '')}`, amount: 8000,
      createdAt: '2026-06-15T03:00:00Z' });
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(store)).toMatchObject({ reason: 'no_order', detail: {}, order_id: null });
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-562-AC-05: 注文の payment_intent が無くても取引の order_id で注文を探す', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), { ...sole(), paymentIntentId: null });
    const txId = await seedStripeCharge(db(), { paymentIntentId: `pi_${randomUUID().replaceAll('-', '')}`, amount: order.total,
      createdAt: '2026-06-15T03:00:00Z', orderId: order.orderId });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    const entry = (await q('select e.id from public.accounting_journal_entries e where e.source_id = $1', [txId])).rows[0];
    expect((await linesOf(entry.id))[1]).toMatchObject({ account_code: '2150', order_id: order.orderId });
  });

  test('FREQ-562-AC-05: 1回の呼び出しは新しい出来事を古い順に _limit 件までで切り、_limit が範囲外なら断る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    for (const hour of ['01', '02', '03']) await paidPair({ createdAt: `2026-06-15T${hour}:00:00Z` });
    // Oldest first, at most _limit new events per call; the next call takes the rest.
    expect(await run(2)).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await run(2)).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entryCount()).toBe(3);
    const dates = (await q('select entry_no from public.accounting_journal_entries order by entry_no')).rows.map((r) => Number(r.entry_no));
    expect(dates).toEqual([1, 2, 3]);
    for (const bad of [0, -1, 201, null]) {
      await q('savepoint bad_limit');
      await expect(q('select private.accounting_post_payment_events($1::integer)', [bad])).rejects.toMatchObject({ code: '22023' });
      await q('rollback to savepoint bad_limit');
    }
  });

  test('FREQ-569-AC-06: 支払い1件がcoreで失敗しても次の支払いは計上され失敗した方だけがposting_errorに残る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    // Two sole periods with a gap between them: the core numbers and inserts an entry in 2026 and then refuses it
    // (PERIOD_GAP). A corporation-only day posts normally.
    const gapped = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2028-01-01', endsOn: '2028-12-31' });
    const corporation = await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2029-01-01', endsOn: '2029-12-31' });
    const failing = await paidPair({ createdAt: '2026-06-15T03:00:00Z' });
    const fine = await paidPair({ createdAt: '2029-03-01T03:00:00Z' });
    expect(await run()).toEqual({ posted: 1, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(failing.txId)).toMatchObject({ reason: 'posting_error', order_id: failing.orderId,
      detail: { error_sqlstate: '23514', error_code: 'ACCOUNTING_PERIOD_GAP', entry_date: '2026-06-15' } });
    // Neither the header, the lines nor the number of the failed event stay.
    expect(await entriesOf(failing.pi)).toHaveLength(0);
    expect(Number((await q('select count(*) as n from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id where e.period_id = $1', [gapped])).rows[0].n)).toBe(0);
    const sequence = (await q('select last_entry_no from public.accounting_period_sequences where period_id = $1', [gapped])).rows[0];
    expect(Number(sequence?.last_entry_no ?? 0)).toBe(0);
    // The next payment is in, with number 1 of its own period.
    const [entry] = await entriesOf(fine.pi);
    expect(entry).toMatchObject({ period_id: corporation, entry_no: '1', entry_date: '2029-03-01' });
    expect(await pendingOf(fine.txId)).toBeUndefined();
    // Only the SQLSTATE, the fixed code and the day are kept; the text of the exception is never stored.
    expect(Object.keys((await pendingOf(failing.txId))?.detail ?? {}).sort()).toEqual(['entry_date', 'error_code', 'error_sqlstate']);
  });

  test('FREQ-569-AC-06: 範囲外の年の出来事はposting_errorになり同じ呼び出しの正常な出来事は入る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const far = await paidPair({ createdAt: '2031-06-15T03:00:00Z' });
    const fine = await paidPair({ createdAt: '2026-06-16T03:00:00Z' });
    // The year 2031 is past the window of the individual periods (this year in Japan + 1).
    expect(await run()).toEqual({ posted: 1, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(far.txId)).toMatchObject({ reason: 'posting_error',
      detail: { error_sqlstate: '22023', error_code: 'ACCOUNTING_ARGUMENT_INVALID', entry_date: '2031-06-15' } });
    expect(await entriesOf(fine.pi)).toHaveLength(1);
    expect(await entriesOf(far.pi)).toHaveLength(0);
    // A parked error is reviewed again next time (a re-park), and it does not hold back new events.
    const later = await paidPair({ createdAt: '2026-06-17T03:00:00Z' });
    expect(await run(1)).toEqual({ posted: 1, parked_new: 0, reparked: 1, resolved: 0 });
    expect(await entriesOf(later.pi)).toHaveLength(1);
  });

  test('FREQ-562-AC-05: 未解決の見直しは1回10件までで、新しい出来事は見直しの数に押し出されない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const mismatched = [];
    for (let i = 0; i < 12; i += 1) mismatched.push(await paidPair({ createdAt: `2026-06-15T01:${String(i).padStart(2, '0')}:00Z`, amount: 1000 }));
    expect(await run(50)).toEqual({ posted: 0, parked_new: 12, reparked: 0, resolved: 0 });
    // One test transaction has one now(): stagger the detection times as separate runs would have left them.
    for (const [index, row] of mismatched.entries()) {
      await q("update public.accounting_pending_events set last_detected_at = now() - make_interval(mins => $2) where source_id = $1",
        [row.txId, 60 - index]);
    }
    const fine = await paidPair({ createdAt: '2026-06-16T03:00:00Z' });
    // 12 are open: only 10 are reviewed in one call, the new event is still posted.
    expect(await run(50)).toEqual({ posted: 1, parked_new: 0, reparked: 10, resolved: 0 });
    expect(await entriesOf(fine.pi)).toHaveLength(1);
    // The next call reviews the 10 oldest-detected again: the 2 left out last time come first, the 8 others fill up.
    expect(await run(50)).toEqual({ posted: 0, parked_new: 0, reparked: 10, resolved: 0 });
    for (const skipped of mismatched.slice(10)) expect((await pendingOf(skipped.txId))?.detection_count).toBe(2);
    for (const reviewed of mismatched.slice(0, 10)) expect((await pendingOf(reviewed.txId))?.detection_count).toBeGreaterThanOrEqual(2);
  });

  test('FREQ-569-AC-06: 失敗の保留の道具は入力が壊れていても例外を出さず、固定の posting_error に落とすか何も保留しない', async () => {
    const call = async (kind: string, sqlstate: string | null, message: string, date: string | null, id: string): Promise<boolean> =>
      (await q("select private.accounting_park_failure($1, 'stripe_balance_transactions', $2, null, $3, $4, null, $5::date) as parked",
        [kind, id, sqlstate, message, date])).rows[0].parked as boolean;
    // A known core error keeps its fixed code; the text of an unknown one is dropped.
    expect(await call('payment_confirmed', '23514', 'ACCOUNTING_PERIOD_GAP', '2026-06-15', 'txn_helper_1')).toBe(true);
    expect(await call('payment_confirmed', '23505', 'duplicate key value violates unique constraint "x"', null, 'txn_helper_2')).toBe(true);
    expect((await pendingOf('txn_helper_1'))?.detail).toEqual({ error_sqlstate: '23514', error_code: 'ACCOUNTING_PERIOD_GAP', entry_date: '2026-06-15' });
    expect((await pendingOf('txn_helper_2'))?.detail).toEqual({ error_sqlstate: '23505', error_code: 'unexpected_error' });
    expect(await call('payment_confirmed', '55000', 'ACCOUNTING_PERIOD_MISSING', '2026-06-15', 'txn_helper_3')).toBe(true);
    expect(await pendingOf('txn_helper_3')).toMatchObject({ reason: 'period_missing', detail: { entry_date: '2026-06-15' } });
    // A broken SQLSTATE falls back to the fixed row; an unknown event kind parks nothing; neither raises.
    expect(await call('payment_confirmed', 'not-a-state', 'boom', null, 'txn_helper_4')).toBe(true);
    expect((await pendingOf('txn_helper_4'))?.detail).toEqual({ error_sqlstate: 'XX000', error_code: 'unexpected_error' });
    // false: nothing could be parked, so the caller counts the event nowhere.
    expect(await call('not_a_kind', '22023', 'ACCOUNTING_ARGUMENT_INVALID', null, 'txn_helper_5')).toBe(false);
    expect(await pendingOf('txn_helper_5')).toBeUndefined();
  });

  test('FREQ-562-AC-01: 記録した時刻（Stripeの行を保存した時刻）が出来事の日から近ければ、止まっていて後で入っても遅れの印は付かない', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    const order = await seedPaidOrder(db(), sole());
    // Stored the day after the charge; it stays parked (no corporate period) and is posted months later (now).
    const syncedAt = '2026-06-16T03:00:00Z';
    await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: order.total, createdAt: '2026-06-15T03:00:00Z', syncedAt });
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-04-01', endsOn: '2027-03-31' });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 1 });
    const [entry] = await entriesOf(order.paymentIntentId as string);
    expect(entry.is_late).toBe(false);
    expect(new Date(entry.source_recorded_at).toISOString()).toBe('2026-06-16T03:00:00.000Z');
  });

  test('FREQ-562-AC-01: Stripeの行を出来事の日から2か月を超えて保存した（遅れて届いた）支払いは遅れの印が付く', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), sole());
    await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: order.total, createdAt: '2026-06-15T03:00:00Z',
      syncedAt: '2026-09-20T03:00:00Z' });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    const [entry] = await entriesOf(order.paymentIntentId as string);
    expect(entry.is_late).toBe(true);
    expect(new Date(entry.source_recorded_at).toISOString()).toBe('2026-09-20T03:00:00.000Z');
  });

  test('FREQ-562-AC-01: 保存した時刻が先の日付でも断られず、流した時刻に丸めて入る', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), sole());
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: order.total, createdAt: '2026-06-15T03:00:00Z', syncedAt: tomorrow });
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    const [entry] = await entriesOf(order.paymentIntentId as string);
    expect(new Date(entry.source_recorded_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('FREQ-562-AC-05: 印に使えない文字の payment_intent は係全体を止めず posting_error になる', async () => {
    await setCutoverForTest(db(), '2026-01-01');
    const order = await seedPaidOrder(db(), { ...sole(), paymentIntentId: 'pi_bad:colon' });
    const bad = await seedStripeCharge(db(), { paymentIntentId: 'pi_bad:colon', amount: order.total, createdAt: '2026-06-15T03:00:00Z' });
    const fine = await paidPair({ createdAt: '2026-06-16T03:00:00Z' });
    expect(await run()).toEqual({ posted: 1, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf(bad)).toMatchObject({ reason: 'posting_error', detail: { error_code: 'ACCOUNTING_ARGUMENT_INVALID', error_sqlstate: '22023' } });
    expect(await entriesOf(fine.pi)).toHaveLength(1);
  });
});
