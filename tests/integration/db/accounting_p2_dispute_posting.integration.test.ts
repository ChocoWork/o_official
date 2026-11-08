/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { describeLocalDb } from './helpers/local-db';
import { accountingFailure, insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, cancelSlip, recordAllocationAt, recordSlipFactAt, seedConfirmedSlip, seedDispute, seedDisputeReversal, seedPaidOrder,
  seedPostedPayment, seedStripeFee, setAsideExistingSlips, setCutoverForTest,
} from './helpers/accounting-orders-fixtures';
import { seedGroupG3Slip } from './helpers/group-g3-fixtures';

// Accounting plan 2 Task 6 (FREQ-568 / FREQ-569): the card network dispute posting (W withdrawn, C confirmed, R / L reversal, X assigned),
// the dispute account settings and the holds. ROLLBACK form (run with --runInBand): setCutoverForTest holds the settings table
// until the rollback. The posters are private; the writers and the reads go through their public entries as the connection's role.
// The shipments are confirmed in the past with a lock time of their own (recordSlipFactAt), so the withdrawal time (2026-06-20)
// decides which of them the withdrawal counts, whatever day the suite runs on.
jest.setTimeout(240000);

type DisputeRun = { posted: number; parked_new: number; reparked: number; resolved: number; withdrawn: number; confirmed: number;
  reversals: number; late_reversals: number };
type PendingRow = { reason: string; detail: Record<string, unknown>; resolved_at: Date | null; resolved_entry_id: string | null;
  detection_count: number; order_id: string | null; event_kind: string; source_table: string };

const W_AT = '2026-06-20T03:00:00Z';
const LOST_AT = '2026-12-20T03:00:00Z';
const R_AT = '2026-12-10T03:00:00Z';
const L_AT = '2027-01-15T03:00:00Z';

describeLocalDb('S11 dispute posting: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    // The group G lock: the order fixtures write unit rows that need it.
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const runDisputes = async (limit = 50): Promise<DisputeRun> =>
    (await q('select private.accounting_post_dispute_events($1::integer) as r', [limit])).rows[0].r as DisputeRun;
  const runAll = async (limit = 50) => (await q('select private.accounting_run_posting($1::integer) as r', [limit])).rows[0].r as Record<string, unknown>;
  const postShipments = async () => { await q('select private.accounting_post_shipment_events(50)'); };
  const none: DisputeRun = { posted: 0, parked_new: 0, reparked: 0, resolved: 0, withdrawn: 0, confirmed: 0, reversals: 0, late_reversals: 0 };
  const key = (dispute: string, stage: string, ref: string) => `dispute_event:${dispute}:${stage}:${ref}`;
  const entryOf = async (dedupeKey: string) => (await q(
    `select e.id, e.dedupe_key, e.event_kind, e.description, e.source_table, e.source_id, e.recorded_by, e.is_late, e.source_recorded_at,
       to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.period_id, e.entry_no
     from public.accounting_journal_entries e where e.dedupe_key = $1`, [dedupeKey])).rows[0];
  const linesOf = async (entryId: string) => (await q(
    `select line_no, account_code, debit::text as debit, credit::text as credit, order_id, sub_account, counterparty, memo
     from public.accounting_journal_lines where entry_id = $1 order by line_no`, [entryId])).rows;
  /** `account(sub):debit/credit` per line, in line order. */
  const summary = async (dedupeKey: string) => {
    const entry = await entryOf(dedupeKey);
    return entry ? (await linesOf(entry.id)).map((l) => `${l.account_code}${l.sub_account ? `(${l.sub_account})` : ''}:${l.debit}/${l.credit}`) : null;
  };
  const pendingOf = async (sourceTable: string, sourceId: string): Promise<PendingRow | undefined> => (await q(
    `select reason, detail, resolved_at, resolved_entry_id, detection_count, order_id, event_kind, source_table
     from public.accounting_pending_events where event_kind = 'dispute_event' and source_table = $1 and source_id = $2`,
    [sourceTable, sourceId])).rows[0];
  const disputeEntryCount = async (dispute: string) => Number((await q(
    "select count(*) as n from public.accounting_journal_entries where starts_with(dedupe_key, $1)", [`dispute_event:${dispute}:`])).rows[0].n);
  const balance = async (dispute: string, account: string, sub: string | null) => Number((await q(
    'select private.accounting_dispute_balance($1, $2, $3) as b', [dispute, account, sub])).rows[0].b);
  const deferredBalance = async (orderId: string) => Number((await q(
    "select coalesce(sum(credit - debit), 0) as b from public.accounting_journal_lines where order_id = $1 and account_code = '2150'", [orderId])).rows[0].b);
  const setSetting = async (reason: string, account: string, actor?: string) => {
    const admin = actor ?? await insertAccountingAdmin(db());
    await q('select public.admin_set_dispute_account_setting($1::uuid, $2, $3, null, $4::uuid)', [admin, reason, account, randomUUID()]);
  };

  /** A paid order of `units` units (3,750 yen each); `shipped` of them are sent by a slip confirmed (and posted) on 2026-06-15. */
  async function seedOrder(input: { shipped?: number; units?: number; price?: number } = {}) {
    const units = input.units ?? 8;
    const order = await seedPostedPayment(db(), { lines: [{ price: input.price ?? 3750, quantity: units }], createdAt: '2026-06-10T03:00:00Z' });
    let slip: Awaited<ReturnType<typeof confirmSlipAt>> | null = null;
    if ((input.shipped ?? 0) > 0) {
      slip = await confirmSlipAt(order, input.shipped as number, '2026-06-15', '2026-06-15T01:00:00Z');
      await postShipments();
    }
    return { ...order, slip };
  }
  async function confirmSlipAt(order: { orderId: string; orderItemIds: string[] }, quantity: number, shipmentDate: string, lockedAt: string, orderItemId?: string) {
    const slip = await seedConfirmedSlip(db(), {
      orders: [{ orderId: order.orderId, lines: [{ orderItemId: orderItemId ?? order.orderItemIds[0], quantity }] }],
      shipmentDate, confirmedAt: lockedAt, recordFact: false });
    await recordSlipFactAt(db(), slip.slipId, 'confirm', lockedAt);
    return slip;
  }
  const dispute = (order: { orderId: string; paymentIntentId: string | null }, amount: number, over: Partial<Parameters<typeof seedDispute>[1]> = {}) =>
    seedDispute(db(), { ...over, orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount });
  const lose = async (disputeId: string, at = LOST_AT) => {
    await addDisputeHistory(db(), { disputeId, status: 'lost', occurredAt: new Date(new Date(at).getTime() + 3600_000).toISOString(),
      stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
  };

  // ---- W: the withdrawal (4-d, 4-e2) ------------------------------------------------------------------------------------
  test('FREQ-568-AC-01: 未出荷の注文の支払いの取り消し30,000円は、引かれた日に「前受金／Stripe未収金」30,000円で、取り消しの手数料1,500円は「支払手数料／Stripe未収金」', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000, { amount: 30000, fee: 1500 });
    const result = await runAll();
    expect(result).toMatchObject({ payments: 0, shipments: 0, stripe: 1, disputes: 1, parked: 0, has_more: false });
    const entry = await entryOf(key(d.disputeId, 'withdrawn', d.txnId as string));
    expect(entry).toMatchObject({ event_kind: 'dispute_event', description: ACCOUNTING_LABELS.disputeWithdrawn, source_table: 'stripe_balance_transactions',
      source_id: d.txnId, entry_date: '2026-06-20', recorded_by: null });
    expect(await linesOf(entry.id)).toEqual([
      { line_no: 1, account_code: '1160', debit: '0', credit: '30000', order_id: null, sub_account: null, counterparty: null, memo: null },
      { line_no: 2, account_code: '2150', debit: '30000', credit: '0', order_id: order.orderId, sub_account: null, counterparty: null, memo: null }]);
    expect(await deferredBalance(order.orderId)).toBe(0);
    expect(await summary(`stripe:fee:${d.txnId}`)).toEqual(['6280:1500/0', '1160:0/1500']);
    expect((await entryOf(`stripe:fee:${d.txnId}`)).description).toBe(ACCOUNTING_LABELS.feeDispute);
    expect(await runAll()).toMatchObject({ disputes: 0, stripe: 0, parked: 0, has_more: false });
  });

  test('FREQ-568-AC-01: 取り下げられて代金が戻ると、戻った日に「Stripe未収金／前受金」30,000円だけで、手数料は戻らない', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000, { amount: 30000, fee: 1500 });
    await runAll();
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-07-05T04:00:00Z', eventType: 'charge.dispute.closed' });
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: '2026-07-05T03:00:00Z' });
    expect(await runAll()).toMatchObject({ disputes: 1, stripe: 0 });
    const entry = await entryOf(key(d.disputeId, 'reversal', reversal));
    expect(entry).toMatchObject({ description: ACCOUNTING_LABELS.disputeReversal, entry_date: '2026-07-05' });
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '2150:0/30000']);
    expect((await linesOf(entry.id))[0].memo).toBe('dispute_reversal_kind:R');
    expect(await deferredBalance(order.orderId)).toBe(30000);
    // The Stripe receivable (1160) over the withdrawal, the fee and the reversal: -30,000 - 1,500 + 30,000. The fee is not given back.
    const stripeBalance = Number((await q(
      `select coalesce(sum(l.debit - l.credit), 0) as b from public.accounting_journal_lines l
       join public.accounting_journal_entries e on e.id = l.entry_id
       where l.account_code = '1160' and e.dedupe_key = any($1::text[])`,
      [[key(d.disputeId, 'withdrawn', d.txnId as string), key(d.disputeId, 'reversal', reversal), `stripe:fee:${d.txnId}`]])).rows[0].b);
    expect(stripeBalance).toBe(-1500);
  });

  test('FREQ-568-AC-02: 出荷済みの注文の取り消し30,000円は、引かれた日に「仮払金（判断待ち）／Stripe未収金」で、原因がメモに残る', async () => {
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000, reason: 'product_not_received' });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, withdrawn: 1 });
    expect(await summary(key(d.disputeId, 'withdrawn', d.txnId as string))).toEqual(['1160:0/30000', '1470(dispute_pending):30000/0']);
    const lines = await linesOf((await entryOf(key(d.disputeId, 'withdrawn', d.txnId as string))).id);
    expect(lines[1]).toMatchObject({ memo: 'dispute_reason:product_not_received', order_id: null });
  });

  test('FREQ-568-AC-02: 2か月後に確定すると、設定の科目へ「設定の科目／仮払金」で振り替わる', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    await lose(d.disputeId, '2026-08-25T03:00:00Z');
    expect(await runDisputes()).toEqual({ ...none, posted: 1, confirmed: 1 });
    const confirmed = key(d.disputeId, 'confirmed', 'lost');
    expect(await entryOf(confirmed)).toMatchObject({ description: ACCOUNTING_LABELS.disputeConfirmed, entry_date: '2026-08-25', source_table: 'stripe_disputes',
      source_id: d.disputeId, recorded_by: null });
    expect(await summary(confirmed)).toEqual(['7530:30000/0', '1470(dispute_pending):0/30000']);
    const lines = await linesOf((await entryOf(confirmed)).id);
    expect(lines.map((l) => l.memo)).toEqual(['dispute_reason:fraudulent', 'dispute_lost_at:2026-08-25T03:00:00Z']);
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    expect(await balance(d.disputeId, '7530', null)).toBe(30000);
  });

  test('FREQ-568-AC-02: 設定が無いまま確定すると「仮払金（確定・科目の決定待ち）」の補助に分けて置く', async () => {
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    await lose(d.disputeId);
    await runDisputes();
    expect(await summary(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['1470(dispute_confirmed_unassigned):30000/0', '1470(dispute_pending):0/30000']);
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    expect(await balance(d.disputeId, '1470', 'dispute_confirmed_unassigned')).toBe(30000);
  });

  test('FREQ-568-AC-03: 引かれた後に確定した発送票の着は未出荷の分として分け、同じ回に流しても結果が変わらない', async () => {
    // A: the withdrawal is posted first and the slip (confirmed after the withdrawal time) afterwards; B: the other way round.
    const worlds: string[][] = [];
    for (const shipmentFirst of [false, true]) {
      const order = await seedOrder();
      const d = await dispute(order, 10000, { amount: 10000 });
      if (!shipmentFirst) await runDisputes();
      await confirmSlipAt(order, 5, '2026-06-21', '2026-06-21T01:00:00Z');
      if (shipmentFirst) {
        // The slip was confirmed after the withdrawal time: its shipment waits for the withdrawal and goes in on the next call.
        expect(await runAll()).toMatchObject({ shipments: 0, disputes: 1 });
        expect(await runAll()).toMatchObject({ shipments: 1, disputes: 0 });
      } else {
        await postShipments();
      }
      worlds.push((await summary(key(d.disputeId, 'withdrawn', d.txnId as string))) as string[]);
      // The slip took 18,750 and the withdrawal 10,000 of the 30,000 deferred revenue in both worlds.
      expect(await deferredBalance(order.orderId)).toBe(1250);
    }
    expect(worlds[0]).toEqual(['1160:0/10000', '2150:10000/0']);
    expect(worlds[1]).toEqual(worlds[0]);
  });

  test('FREQ-568-AC-02: 知らせの行と再照合の行の両方でlostが来ても、確定の仕訳は1本', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    await lose(d.disputeId);
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-21T03:00:00Z', eventType: 'reconcile',
      eventId: `reconcile:${d.disputeId}:lost` });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, confirmed: 1 });
    expect(await runDisputes()).toEqual(none);
    expect(Number((await q('select count(*) as n from public.accounting_journal_entries where dedupe_key = $1',
      [key(d.disputeId, 'confirmed', 'lost')])).rows[0].n)).toBe(1);
    expect((await entryOf(key(d.disputeId, 'confirmed', 'lost'))).entry_date).toBe('2026-12-20');
  });

  test('FREQ-568-AC-04: 決着の後に、戻りの取引の時刻がlostの時刻より後なら遅れた取り下げ、同じかそれより前なら確定の前の取り下げとして、戻りの取引1件に仕訳1本だけ入る（同じ回に確定の履歴と戻りが見つかっても）', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    const early = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 10000, createdAt: R_AT });
    const late = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 20000, createdAt: L_AT });
    await lose(d.disputeId);
    // One call finds the withdrawal, both reversals and the lost row. The stages go W, R, C, L.
    expect(await runDisputes()).toEqual({ ...none, posted: 4, withdrawn: 1, confirmed: 1, reversals: 1, late_reversals: 1 });
    expect(await summary(key(d.disputeId, 'reversal', early))).toEqual(['1160:10000/0', '2150:0/3750', '1470(dispute_pending):0/6250']);
    expect(await summary(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['7530:12500/0', '1470(dispute_pending):0/12500']);
    expect(await summary(key(d.disputeId, 'reversal', late))).toEqual(['1160:20000/0', '2150:0/7500', '7530:0/12500']);
    expect((await linesOf((await entryOf(key(d.disputeId, 'reversal', early))).id))[0].memo).toBe('dispute_reversal_kind:R');
    expect((await linesOf((await entryOf(key(d.disputeId, 'reversal', late))).id))[0].memo).toBe('dispute_reversal_kind:L');
    expect((await entryOf(key(d.disputeId, 'reversal', early))).entry_date).toBe('2026-12-10');
    expect((await entryOf(key(d.disputeId, 'reversal', late))).entry_date).toBe('2027-01-15');
    expect(await disputeEntryCount(d.disputeId)).toBe(4);
    expect(await runDisputes()).toEqual(none);
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    expect(await balance(d.disputeId, '7530', null)).toBe(0);
  });

  test('FREQ-568-AC-04: 決着していないdisputeの戻りの取引はdispute_withdrawal_missingで待ち、手では確認済みにできず、決着すると入る', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: '2026-07-05T03:00:00Z' });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    const waiting = await pendingOf('stripe_balance_transactions', reversal);
    expect(waiting).toMatchObject({ reason: 'dispute_withdrawal_missing', detail: { dispute_status: 'needs_response' }, resolved_at: null });
    const admin = await insertAccountingAdmin(db());
    const id = (await q("select id from public.accounting_pending_events where source_id = $1", [reversal])).rows[0].id;
    expect(await accountingFailure(db(), () => q('select public.admin_resolve_accounting_pending_event($1::uuid, $2::uuid, $3, $4::uuid)',
      [admin, id, 'try', randomUUID()]))).toMatchObject({ code: '55000', message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-07-06T03:00:00Z', eventType: 'charge.dispute.closed' });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, reparked: 0, resolved: 1, reversals: 1 });
    expect((await pendingOf('stripe_balance_transactions', reversal))?.resolved_entry_id).toBe((await entryOf(key(d.disputeId, 'reversal', reversal))).id);
  });

  test('FREQ-568-AC-02: 引かれた時が計上待ちに止まっている間にlostが来ても、確定はdispute_withdrawal_missingで待ち、引かれた時が入った後に確定が1本入る（no_revenueで閉じない）', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder();
    // A slip confirmed before the withdrawal whose shipment entry is not in the books yet: the withdrawal waits for it.
    await confirmSlipAt(order, 5, '2026-06-15', '2026-06-15T01:00:00Z');
    const d = await dispute(order, 30000, { amount: 30000 });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'dispute_shipment_pending', detail: {} });
    await lose(d.disputeId);
    const waiting = await runDisputes();
    expect(waiting).toEqual({ ...none, parked_new: 1, reparked: 1 });
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ reason: 'dispute_withdrawal_missing', resolved_at: null });
    expect(await disputeEntryCount(d.disputeId)).toBe(0);
    await postShipments();
    expect(await runDisputes()).toEqual({ ...none, posted: 2, resolved: 2, withdrawn: 1, confirmed: 1 });
    expect(await summary(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['7530:18750/0', '1470(dispute_pending):0/18750']);
    const parked = await pendingOf('stripe_disputes', d.disputeId);
    expect(parked?.resolved_entry_id).toBe((await entryOf(key(d.disputeId, 'confirmed', 'lost'))).id);
  });

  test('FREQ-568-AC-02: 確定の前に取り下げられると「Stripe未収金／仮払金」で戻り、確定の仕訳は作らない', async () => {
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: R_AT });
    await lose(d.disputeId);
    expect(await runDisputes()).toEqual({ ...none, posted: 2, parked_new: 1, resolved: 1, withdrawn: 1, reversals: 1 });
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '1470(dispute_pending):0/30000']);
    expect(await entryOf(key(d.disputeId, 'confirmed', 'lost'))).toBeUndefined();
    const closed = await pendingOf('stripe_disputes', d.disputeId);
    expect(closed).toMatchObject({ reason: 'no_revenue', detail: { lost_on: '2026-12-20' }, resolved_entry_id: null });
    expect(closed?.resolved_at).not.toBeNull();
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
  });

  test('FREQ-568-AC-03: 一部だけ出荷した注文は、引かれた額を出荷した着とまだの着の支払額の比で分け、端数は番号の若い着から', async () => {
    const order = await seedPaidOrder(db(), { lines: [{ price: 10000, quantity: 3, unitAmounts: [10000, 10000, 10001] }] });
    // The units add up to 30,001: the payment entry is put in by hand (the payment poster would refuse the order total).
    await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event($1::date), $1::date, 'payment_confirmed',
        ARRAY[$2]::text[], 'payment', $3::jsonb)`,
      ['2026-06-10', order.paymentIntentId, JSON.stringify([
        { account_code: '1160', debit: 30001, credit: 0 }, { account_code: '2150', debit: 0, credit: 30001, order_id: order.orderId }])]);
    await confirmSlipAt(order, 1, '2026-06-15', '2026-06-15T01:00:00Z');
    await postShipments();
    const d = await dispute(order, 10000, { amount: 10000 });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, withdrawn: 1 });
    // floor(10000 * w / 30001) = 3333 for each unit, one yen is left and goes to the unit with the lowest number (the sent one).
    expect(await summary(key(d.disputeId, 'withdrawn', d.txnId as string))).toEqual(['1160:0/10000', '2150:6666/0', '1470(dispute_pending):3334/0']);
  });

  test('FREQ-568-AC-03: 出荷前の返金の割り当てが一部当たった後に出荷した着の値打ちは支払額−割り当てで、前受金が残らない', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 10000, quantity: 1 }, { price: 10000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    const [x] = order.orderItemIds;
    // 1,000 yen of X is refunded before it is shipped (the allocation and the entry), then X is sent.
    await recordAllocationAt(db(), { orderItemId: x, unitIndex: 0, refundKey: 'RF-0001', amount: 1000, lockedAt: '2026-06-12T01:00:00Z' });
    await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event($1::date), $1::date,
        'pre_shipment_refund', ARRAY['RF-0001']::text[], 'refund', $2::jsonb)`,
      ['2026-06-12', JSON.stringify([{ account_code: '2150', debit: 1000, credit: 0, order_id: order.orderId },
        { account_code: '1160', debit: 0, credit: 1000, order_id: order.orderId }])]);
    await confirmSlipAt(order, 1, '2026-06-15', '2026-06-15T01:00:00Z', x);
    await postShipments();
    expect(await deferredBalance(order.orderId)).toBe(10000);
    const d = await dispute(order, 19000, { amount: 19000 });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, withdrawn: 1 });
    // X is worth 9,000 and Y 10,000: S = 9,000, U = 10,000 (counting the paid amounts would give 9,500 each).
    expect(await summary(key(d.disputeId, 'withdrawn', d.txnId as string))).toEqual(['1160:0/19000', '2150:10000/0', '1470(dispute_pending):9000/0']);
    expect(await deferredBalance(order.orderId)).toBe(0);
  });

  test('FREQ-568-AC-03: 引かれた取引の時刻の前に鍵を取った発送票・割り当てだけを W が数え、後に鍵を取った物は数えない', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 10000, quantity: 1 }, { price: 10000, quantity: 1 }], createdAt: '2026-06-10T03:00:00Z' });
    const [x, y] = order.orderItemIds;
    await confirmSlipAt(order, 1, '2026-06-15', '2026-06-15T01:00:00Z', x);
    // After the withdrawal (06-20): an allocation on Y and then the slip of Y. The withdrawal counts neither.
    await recordAllocationAt(db(), { orderItemId: y, unitIndex: 0, refundKey: 'RF-0002', amount: 4000, lockedAt: '2026-06-21T00:00:00Z' });
    await confirmSlipAt(order, 1, '2026-06-21', '2026-06-21T01:00:00Z', y);
    const d = await dispute(order, 6000, { amount: 6000 });
    // X's shipment and the withdrawal go in at once; Y's slip was confirmed after the withdrawal time, so it waits for the withdrawal.
    expect(await runAll()).toMatchObject({ shipments: 1, disputes: 1 });
    expect(await runAll()).toMatchObject({ shipments: 1, disputes: 0 });
    // As of the withdrawal: X is 10,000 and sent, Y is 10,000 and not sent. (Counting the later facts would give S = 6,000, U = 0.)
    expect(await summary(key(d.disputeId, 'withdrawn', d.txnId as string))).toEqual(['1160:0/6000', '2150:3000/0', '1470(dispute_pending):3000/0']);
  });

  test('FREQ-568-AC-03: 同じ支払いに2つの取り消しがあれば、取り消しの番号ごとに別の仕訳になる', async () => {
    const order = await seedOrder();
    const first = await dispute(order, 5000, { amount: 5000, withdrawnAt: '2026-06-20T03:00:00Z' });
    const second = await dispute(order, 7000, { amount: 7000, withdrawnAt: '2026-06-22T03:00:00Z' });
    expect(await runDisputes()).toEqual({ ...none, posted: 2, withdrawn: 2 });
    expect(await summary(key(first.disputeId, 'withdrawn', first.txnId as string))).toEqual(['1160:0/5000', '2150:5000/0']);
    expect(await summary(key(second.disputeId, 'withdrawn', second.txnId as string))).toEqual(['1160:0/7000', '2150:7000/0']);
    expect(await deferredBalance(order.orderId)).toBe(18000);
  });

  test('FREQ-568-AC-03: 引かれた後に発送票を取り消しても、出荷の係とdisputeの係のどちらを先に流してもWのSとUが同じで、最後の前受金も同じ', async () => {
    const wLines = ['1160:0/30000', '2150:11250/0', '1470(dispute_pending):18750/0'];
    const worlds: Array<{ lines: string[] | null; deferred: number }> = [];
    // (a) the shipment is posted, then the withdrawal, then the slip is cancelled (the cancel fact comes after the withdrawal time)
    // and the cancellation is posted.
    {
      const order = await seedOrder({ shipped: 5 });
      const d = await dispute(order, 30000, { amount: 30000 });
      await runDisputes();
      await cancelSlip(db(), (order.slip as { slipId: string }).slipId);
      await postShipments();
      worlds.push({ lines: await summary(key(d.disputeId, 'withdrawn', d.txnId as string)), deferred: await deferredBalance(order.orderId) });
    }
    // (b) the same events with the posters the other way round: the cancel fact is there before the withdrawal is posted, and the
    // withdrawal goes in first, the cancellation after it.
    {
      const order = await seedOrder({ shipped: 5 });
      const d = await dispute(order, 30000, { amount: 30000 });
      await cancelSlip(db(), (order.slip as { slipId: string }).slipId);
      await runDisputes();
      await postShipments();
      worlds.push({ lines: await summary(key(d.disputeId, 'withdrawn', d.txnId as string)), deferred: await deferredBalance(order.orderId) });
    }
    // (c) the slip was confirmed before the withdrawal and cancelled after it, and its shipment entry was never posted.
    {
      const order = await seedOrder();
      const slip = await confirmSlipAt(order, 5, '2026-06-15', '2026-06-15T01:00:00Z');
      const d = await dispute(order, 30000, { amount: 30000 });
      expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
      expect((await pendingOf('stripe_balance_transactions', d.txnId as string))?.reason).toBe('dispute_shipment_pending');
      await cancelSlip(db(), slip.slipId);
      await runAll();
      expect(await entryOf(`shipment_confirmed:${slip.number}`)).toBeUndefined();
      worlds.push({ lines: await summary(key(d.disputeId, 'withdrawn', d.txnId as string)), deferred: await deferredBalance(order.orderId) });
    }
    // The units sent as of the withdrawal count as sent whatever happened to the slip afterwards; the cancellation only gives the
    // deferred revenue back. Deferred revenue at the end: 30,000 paid - 11,250 withdrawn.
    expect(worlds).toEqual([0, 1, 2].map(() => ({ lines: wLines, deferred: 18750 })));
  });

  test('FREQ-568-AC-03: 引かれた後に確定した発送票は引かれた時を待たせず、引かれた時が入るまで自分が待ち、前受金が足りなければ止まって、勝って戻ると自動で入る', async () => {
    const worlds: string[][] = [];
    for (const shipmentsFirst of [true, false]) {
      const order = await seedOrder();
      const d = await dispute(order, 10000, { amount: 10000 });
      const slip = await confirmSlipAt(order, 8, '2026-06-21', '2026-06-21T01:00:00Z');
      const slipPending = async () => (await q(
        "select reason, detail, resolved_at from public.accounting_pending_events where event_kind = 'shipment_confirmed' and source_id = $1", [slip.slipId])).rows[0];
      if (shipmentsFirst) {
        // The shipment (confirm number above the withdrawal's) waits for the withdrawal, which goes in in full in the same call.
        expect(await runAll()).toMatchObject({ shipments: 0, disputes: 1, parked: 1 });
        expect(await slipPending()).toMatchObject({ reason: 'dispute_withdrawal_missing', detail: { waiting_on: 'dispute_withdrawn' }, resolved_at: null });
        expect(await runAll()).toMatchObject({ shipments: 0, disputes: 0, parked: 1 });
      } else {
        expect(await runDisputes()).toEqual({ ...none, posted: 1, withdrawn: 1 });
        await postShipments();
      }
      expect(await slipPending()).toMatchObject({ reason: 'deferred_revenue_short', detail: { shortage: 10000 }, resolved_at: null });
      expect(await entryOf(`shipment_confirmed:${slip.number}`)).toBeUndefined();
      expect(await summary(key(d.disputeId, 'withdrawn', d.txnId as string))).toEqual(['1160:0/10000', '2150:10000/0']);
      // The dispute is won: the money comes back to the deferred revenue and the shipment goes in by itself.
      await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-07-06T03:00:00Z', eventType: 'charge.dispute.closed' });
      const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 10000, createdAt: '2026-07-05T03:00:00Z' });
      await runAll();
      await runAll();
      expect(await entryOf(`shipment_confirmed:${slip.number}`)).toBeDefined();
      expect((await slipPending()).resolved_at).not.toBeNull();
      expect(await deferredBalance(order.orderId)).toBe(0);
      worlds.push((await summary(key(d.disputeId, 'reversal', reversal))) as string[]);
    }
    expect(worlds[1]).toEqual(worlds[0]);
  });

  test('FREQ-568-AC-03: 切り替えの日より前の発送票が止まったまま（開いたbefore_cutover）でも、引かれた時はそれを待たず出荷済みとして数える', async () => {
    const order = await seedOrder();
    const slip = await confirmSlipAt(order, 5, '2025-12-31', '2025-12-31T01:00:00Z');
    await postShipments();
    expect(await q("select reason, resolved_at from public.accounting_pending_events where event_kind = 'shipment_confirmed' and source_id = $1", [slip.slipId]))
      .toMatchObject({ rows: [{ reason: 'before_cutover', resolved_at: null }] });
    const d = await dispute(order, 30000, { amount: 30000 });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, withdrawn: 1 });
    expect(await summary(key(d.disputeId, 'withdrawn', d.txnId as string))).toEqual(['1160:0/30000', '2150:11250/0', '1470(dispute_pending):18750/0']);
  });

  test('FREQ-568-AC-04: 引かれた取引が2つある取り消しは、2つ目が止まっている間は確定も待ち、2つ目が入った後に両方のSで確定が入る', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 10000, { amount: 10000, withdrawnAt: '2026-06-20T03:00:00Z' });
    // A second withdrawal of the same dispute whose number a key cannot hold: it is parked, the first one is booked.
    const second = await seedStripeFee(db(), { createdAt: '2026-06-21T03:00:00Z', type: 'adjustment', reportingCategory: 'dispute', amount: -5000,
      sourceId: d.disputeId, id: 'txn:second:withdrawal' });
    await lose(d.disputeId);
    expect(await runDisputes()).toEqual({ ...none, posted: 1, parked_new: 2, withdrawn: 1 });
    expect(await pendingOf('stripe_balance_transactions', second)).toMatchObject({ reason: 'posting_error' });
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ reason: 'dispute_withdrawal_missing', resolved_at: null });
    expect(await entryOf(key(d.disputeId, 'confirmed', 'lost'))).toBeUndefined();
    await q('update public.stripe_balance_transactions set id = $2 where id = $1', [second, 'txn_second_withdrawal']);
    await q('update public.accounting_pending_events set source_id = $2 where source_id = $1', [second, 'txn_second_withdrawal']);
    // 10,000 -> S = 6,250 and U = 3,750; 5,000 -> S = 3,125 and U = 1,875 (the second one is worth 5/8 of 3/8 again)
    expect(await runDisputes()).toMatchObject({ posted: 2, withdrawn: 1, confirmed: 1 });
    expect(await summary(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['7530:9375/0', '1470(dispute_pending):0/9375']);
  });

  test('FREQ-568-AC-04: 確定の後に遅れて取り下げられると、戻った日に「Stripe未収金／確定の時に振り替えた科目」で戻り、未出荷の分は前受金を戻す', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId);
    await runDisputes();
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: L_AT });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, late_reversals: 1 });
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '2150:0/11250', '7530:0/18750']);
    expect((await entryOf(key(d.disputeId, 'reversal', reversal))).entry_date).toBe('2027-01-15');
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    expect(await balance(d.disputeId, '1470', 'dispute_confirmed_unassigned')).toBe(0);
    expect(await deferredBalance(order.orderId)).toBe(11250);
  });

  test('FREQ-568-AC-04: 未出荷だけの取り消しが確定した後に遅れて取り下げられると、借方1160貸方2150（Uの分だけ）で前受金が戻り、計上待ちに残らない', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId);
    await runDisputes();
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: L_AT });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, late_reversals: 1 });
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '2150:0/30000']);
    expect(await entryOf(key(d.disputeId, 'confirmed', 'lost'))).toBeUndefined();
    expect(Number((await q('select count(*) as n from public.accounting_pending_events where resolved_at is null')).rows[0].n)).toBe(0);
    expect(await deferredBalance(order.orderId)).toBe(30000);
  });

  test('FREQ-568-AC-04: 設定が無いまま確定し遅れて取り下げられると、遅れた取り下げはdispute_withdrawal_missing（dispute_account_unassigned）で待ち、手では確認済みにできず、設定を入れて振り替えた後に入り、確定の年の費用がSになる', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId);
    await runDisputes();
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: L_AT });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', reversal)).toMatchObject({
      reason: 'dispute_withdrawal_missing', detail: { waiting_on: 'dispute_account_unassigned' }, resolved_at: null });
    const admin = await insertAccountingAdmin(db());
    const id = (await q('select id from public.accounting_pending_events where source_id = $1', [reversal])).rows[0].id;
    expect(await accountingFailure(db(), () => q('select public.admin_resolve_accounting_pending_event($1::uuid, $2::uuid, $3, $4::uuid)',
      [admin, id, 'try', randomUUID()]))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    expect(await runDisputes()).toEqual({ ...none, reparked: 1 });
    await setSetting('fraudulent', '7530');
    await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()]);
    expect(await runDisputes()).toEqual({ ...none, posted: 1, resolved: 1, late_reversals: 1 });
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '2150:0/11250', '7530:0/18750']);
    const years = (await q(
      `select extract(year from e.entry_date)::int as y, sum(l.credit - l.debit)::int as profit
       from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
       where starts_with(e.dedupe_key, $1) and l.account_code = '7530' group by 1 order by 1`, [`dispute_event:${d.disputeId}:`])).rows;
    expect(years).toEqual([{ y: 2026, profit: -18750 }, { y: 2027, profit: 18750 }]);
    expect(await balance(d.disputeId, '1470', 'dispute_confirmed_unassigned')).toBe(0);
  });

  test('FREQ-568-AC-04: 戻りの取引が先に保存されlostの行が後で届いても、決着を待って遅れた取り下げ（L）で入り、確定はSの額で入る', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    // The balance transaction is saved first (step 2 of the sync) and the poster runs before the history row (step 3) is saved.
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: L_AT });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', reversal)).toMatchObject({ reason: 'dispute_withdrawal_missing', detail: { dispute_status: 'needs_response' } });
    await lose(d.disputeId);
    expect(await runDisputes()).toEqual({ ...none, posted: 2, resolved: 1, confirmed: 1, late_reversals: 1 });
    expect(await summary(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['7530:18750/0', '1470(dispute_pending):0/18750']);
    expect((await linesOf((await entryOf(key(d.disputeId, 'reversal', reversal))).id))[0].memo).toBe('dispute_reversal_kind:L');
  });

  test('FREQ-568-AC-04: lostより前の知らせ（12月15日のcharge.dispute.updated）をlostの後に処理しても、lostの時刻は負けた出来事（12月20日）の時刻', async () => {
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId);
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'under_review', occurredAt: '2026-12-22T00:00:00Z', stripeEventCreatedAt: '2026-12-15T03:00:00Z',
      eventType: 'charge.dispute.updated', setStatus: false });
    expect((await q('select to_char(private.accounting_dispute_lost_at($1) at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as t', [d.disputeId])).rows[0].t).toBe('2026-12-20T03:00:00Z');
    await runDisputes();
    expect((await entryOf(key(d.disputeId, 'confirmed', 'lost'))).entry_date).toBe('2026-12-20');
  });

  test('FREQ-568-AC-04: どのlostの行にもStripeの時刻が無い時だけ、lostの行のoccurred_atの最も古い物をlostの時刻とする', async () => {
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    const lostAt = async () => (await q("select to_char(private.accounting_dispute_lost_at($1) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') as t", [d.disputeId])).rows[0].t;
    expect((await q('select private.accounting_dispute_lost_at($1) as t', [d.disputeId])).rows[0].t).toBeNull();
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-22T03:00:00Z', eventId: `reconcile:${d.disputeId}:lost`, eventType: 'reconcile' });
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-21T03:00:00Z', eventType: 'charge.dispute.closed' });
    expect(await lostAt()).toBe('2026-12-21T03:00:00Z');
    // Once a row has Stripe's time, that time wins even when another row was received earlier.
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-23T03:00:00Z', stripeEventCreatedAt: '2026-12-20T03:00:00Z',
      eventId: `reconcile:${d.disputeId}:lost:event_time`, eventType: 'reconcile' });
    expect(await lostAt()).toBe('2026-12-20T03:00:00Z');
  });

  test('FREQ-568-AC-04: lostの時刻より前の戻り（R）が止まっている間は確定も待ち、Rの後の残高で確定が入りdispute_pendingがマイナスにならない', async () => {
    // After the switch to a corporation there is no period for 2027: the reversal (01-03) and the loss (01-05) cannot go in yet.
    const admin = await insertAccountingAdmin(db());
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 10000, createdAt: '2027-01-03T03:00:00Z' });
    await lose(d.disputeId, '2027-01-05T03:00:00Z');
    expect(await runDisputes()).toEqual({ ...none, parked_new: 2 });
    expect(await pendingOf('stripe_balance_transactions', reversal)).toMatchObject({ reason: 'period_missing', detail: { entry_date: '2027-01-03' } });
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ reason: 'dispute_withdrawal_missing', detail: {} });
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(await runDisputes()).toEqual({ ...none, posted: 2, resolved: 2, reversals: 1, confirmed: 1 });
    // C takes the balance as it is after R: 18,750 - 6,250.
    expect(await summary(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['7530:12500/0', '1470(dispute_pending):0/12500']);
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
  });

  test('FREQ-568-AC-04: 戻りが2回（B1+B2=A）あっても、Sの分の合計はちょうどSで補助が0になる', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    const first = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 10001, createdAt: '2026-07-05T03:00:00Z' });
    const second = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 19999, createdAt: '2026-07-06T03:00:00Z' });
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-07-07T03:00:00Z', eventType: 'charge.dispute.closed' });
    await runDisputes();
    // S = 18,750, A = 30,000: floor(18750 * 10001 / 30000) = 6250, then 18750 - 6250 = 12500.
    expect(await summary(key(d.disputeId, 'reversal', first))).toEqual(['1160:10001/0', '2150:0/3751', '1470(dispute_pending):0/6250']);
    expect(await summary(key(d.disputeId, 'reversal', second))).toEqual(['1160:19999/0', '2150:0/7499', '1470(dispute_pending):0/12500']);
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    // The sent units were recognised as sales; the unsent part (11,250) is deferred revenue again.
    expect(await deferredBalance(order.orderId)).toBe(11250);
    // The amounts do not depend on the order the entries go in: the first reversal fails once (an id a key cannot hold), the
    // second goes in first, then the first goes in. The lines are the same.
    const other = await seedOrder({ shipped: 5 });
    const e = await dispute(other, 30000, { amount: 30000 });
    await runDisputes();
    const b1 = await seedDisputeReversal(db(), { disputeId: e.disputeId, amount: 10001, createdAt: '2026-07-05T03:00:00Z', id: 'txn:colons' });
    const b2 = await seedDisputeReversal(db(), { disputeId: e.disputeId, amount: 19999, createdAt: '2026-07-06T03:00:00Z' });
    await addDisputeHistory(db(), { disputeId: e.disputeId, status: 'won', occurredAt: '2026-07-07T03:00:00Z', eventType: 'charge.dispute.closed' });
    expect(await runDisputes()).toMatchObject({ posted: 1, parked_new: 1 });
    expect(await entryOf(key(e.disputeId, 'reversal', b2))).toBeDefined();
    await q('update public.stripe_balance_transactions set id = $2 where id = $1', [b1, 'txn_b1_fixed']);
    await q('update public.accounting_pending_events set source_id = $2 where source_id = $1', [b1, 'txn_b1_fixed']);
    expect(await runDisputes()).toMatchObject({ posted: 1, resolved: 1 });
    expect(await summary(key(e.disputeId, 'reversal', b2))).toEqual(await summary(key(d.disputeId, 'reversal', second)));
    expect(await summary(key(e.disputeId, 'reversal', 'txn_b1_fixed'))).toEqual(await summary(key(d.disputeId, 'reversal', first)));
    expect(await balance(e.disputeId, '1470', 'dispute_pending')).toBe(0);
  });

  test('FREQ-568-AC-05: 振り替えの日は確定の仕訳の日で、年を越してから振り替えても費用は確定の年に立つ', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId, '2026-12-20T03:00:00Z');
    await runDisputes();
    await setSetting('fraudulent', '7530');
    const admin = await insertAccountingAdmin(db());
    const assigned = await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid) as r', [admin, d.disputeId, randomUUID()]);
    expect(assigned.rows[0].r).toMatchObject({ created: true });
    const entry = await entryOf(key(d.disputeId, 'assigned', '1'));
    expect(entry).toMatchObject({ entry_date: '2026-12-20', description: ACCOUNTING_LABELS.disputeAssigned, recorded_by: admin, source_table: 'stripe_disputes', source_id: d.disputeId });
    expect(await summary(key(d.disputeId, 'assigned', '1'))).toEqual(['7530:18750/0', '1470(dispute_confirmed_unassigned):0/18750']);
    expect(entry.period_id).toBe((await entryOf(key(d.disputeId, 'confirmed', 'lost'))).period_id);
  });

  test('FREQ-568-AC-05: 設定を後から入れて振り替えると「設定の科目／仮払金（確定・科目の決定待ち）」が1本入り、2回目は要求番号を変えても何も足さず、補助の残高がマイナスにならない', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId);
    await runDisputes();
    const admin = await insertAccountingAdmin(db());
    const requestKey = randomUUID();
    // No setting yet: nothing can be assigned.
    expect(await accountingFailure(db(), () => q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, requestKey])))
      .toMatchObject({ code: '55000', message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    await setSetting('fraudulent', '7530');
    const first = (await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid) as r', [admin, d.disputeId, requestKey])).rows[0].r;
    expect(first).toMatchObject({ created: true });
    expect(await balance(d.disputeId, '1470', 'dispute_confirmed_unassigned')).toBe(0);
    const before = await disputeEntryCount(d.disputeId);
    const second = (await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid) as r', [admin, d.disputeId, randomUUID()])).rows[0].r;
    expect(second).toEqual({ entry_id: first.entry_id, entry_no: first.entry_no, period_id: first.period_id, created: false });
    const replay = (await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid) as r', [admin, d.disputeId, requestKey])).rows[0].r;
    expect(replay).toEqual({ ...second, created: false });
    expect(await disputeEntryCount(d.disputeId)).toBe(before);
    expect(await balance(d.disputeId, '1470', 'dispute_confirmed_unassigned')).toBe(0);
    // The same request key for another dispute is a conflict.
    const otherOrder = await seedOrder({ shipped: 8 });
    const other = await dispute(otherOrder, 30000, { amount: 30000 });
    expect(await accountingFailure(db(), () => q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, other.disputeId, requestKey])))
      .toMatchObject({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    // Only admin.accounting.entries.correct may assign.
    const nobody = randomUUID();
    await q("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [nobody]);
    expect(await accountingFailure(db(), () => q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [nobody, d.disputeId, randomUUID()])))
      .toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
  });

  test('FREQ-568-AC-05: 設定が無い時に振り替えようとするとEVENT_NOT_POSTABLE（確定の仕訳が無い時、補助の残高が0の時も同じ）', async () => {
    const admin = await insertAccountingAdmin(db());
    const order = await seedOrder({ shipped: 8 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await runDisputes();
    await setSetting('fraudulent', '7530');
    // No confirmed entry yet.
    expect(await accountingFailure(db(), () => q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()])))
      .toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    await lose(d.disputeId);
    await runDisputes();
    // The setting existed when C went in: C debited the setting account itself, so the unassigned balance is 0.
    expect(await accountingFailure(db(), () => q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()])))
      .toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
  });

  // ---- the setting of the account (4-e) ---------------------------------------------------------------------------------
  test('FREQ-568-AC-05: 科目の設定は費用か収益の勘定だけを受け、それ以外はACCOUNTING_DISPUTE_ACCOUNT_INVALID、版違いはVERSION_CONFLICT、同じ要求番号の再送は前の結果', async () => {
    const admin = await insertAccountingAdmin(db());
    const set = (reason: string, account: string, version: number | null, requestKey: string, actor = admin) =>
      q('select public.admin_set_dispute_account_setting($1::uuid, $2, $3, $4::bigint, $5::uuid) as r', [actor, reason, account, version, requestKey]);
    for (const bad of ['1160', '1470', '2150', '1010', '0000', 'abcd']) {
      expect(await accountingFailure(db(), () => set('fraudulent', bad, null, randomUUID()))).toMatchObject({ code: '22023', message: 'ACCOUNTING_DISPUTE_ACCOUNT_INVALID' });
    }
    expect(await accountingFailure(db(), () => set('not_a_cause', '7530', null, randomUUID()))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
    const requestKey = randomUUID();
    const created = (await set('fraudulent', '7530', null, requestKey)).rows[0].r;
    expect(created).toMatchObject({ reason: 'fraudulent', account_code: '7530', version: '1' });
    // A revenue account is accepted too. The same content under the same key returns the first result.
    expect((await set('fraudulent', '7530', null, requestKey)).rows[0].r).toEqual(created);
    expect(await accountingFailure(db(), () => set('fraudulent', '4010', null, requestKey))).toMatchObject({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    // New row with an existing one, and a change with the wrong version.
    expect(await accountingFailure(db(), () => set('fraudulent', '6330', null, randomUUID()))).toMatchObject({ code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' });
    expect(await accountingFailure(db(), () => set('fraudulent', '6330', 5, randomUUID()))).toMatchObject({ message: 'ACCOUNTING_VERSION_CONFLICT' });
    expect(await accountingFailure(db(), () => set('general', '6330', 1, randomUUID()))).toMatchObject({ message: 'ACCOUNTING_VERSION_CONFLICT' });
    const changed = (await set('fraudulent', '4010', 1, randomUUID())).rows[0].r;
    expect(changed).toMatchObject({ account_code: '4010', version: '2' });
    const listed = (await q('select public.list_dispute_account_settings() as r')).rows[0].r;
    expect(listed.settings).toEqual([expect.objectContaining({ reason: 'fraudulent', account_code: '4010', version: '2' })]);
    const nobody = randomUUID();
    await q("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [nobody]);
    expect(await accountingFailure(db(), () => set('general', '7530', null, randomUUID(), nobody))).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
  });

  // ---- holds (4-e3) -----------------------------------------------------------------------------------------------------
  const holds = async (orderIds: string[]) => (await q(
    'select order_id, dispute_id, status, amount::text as amount, since from public.get_order_dispute_holds($1::uuid[]) order by dispute_id', [orderIds])).rows;

  test('FREQ-568-AC-06: 判断待ちの注文を、読み口が注文と取り消しの番号つきで返す', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000, status: 'under_review' });
    const rows = await holds([order.orderId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order_id: order.orderId, dispute_id: d.disputeId, status: 'under_review', amount: '30000' });
    expect(new Date(rows[0].since).toISOString()).toBe('2026-06-20T03:00:00.000Z');
    expect(await holds([randomUUID()])).toEqual([]);
    // The same through a draft shipment slip that has a line of the order.
    const slipId = await seedGroupG3Slip(db(), { stage: 'draft', draftLines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] });
    const slipHolds = (await q('select order_id, dispute_id from public.get_slip_dispute_holds($1::uuid)', [slipId])).rows;
    expect(slipHolds).toEqual([{ order_id: order.orderId, dispute_id: d.disputeId }]);
    const clean = await seedOrder({ shipped: 5 });
    const cleanSlip = await seedGroupG3Slip(db(), { stage: 'draft', draftLines: [{ orderItemId: clean.orderItemIds[0], quantity: 1 }] });
    expect((await q('select * from public.get_slip_dispute_holds($1::uuid)', [cleanSlip])).rows).toEqual([]);
  });

  test('FREQ-568-AC-06: 事前の問い合わせ（warning系）は保留に数えない', async () => {
    const order = await seedOrder({ shipped: 5 });
    await dispute(order, 30000, { amount: 30000, status: 'warning_needs_response', withdrawnAt: null });
    await dispute(order, 30000, { amount: 30000, status: 'warning_under_review', withdrawnAt: null });
    expect(await holds([order.orderId])).toEqual([]);
  });

  test('FREQ-568-AC-06: 確定または取り下げ後は保留から外れる', async () => {
    const order = await seedOrder({ shipped: 5 });
    const open = await dispute(order, 30000, { amount: 30000, status: 'needs_response' });
    expect((await holds([order.orderId])).map((r) => r.dispute_id)).toEqual([open.disputeId]);
    await seedDisputeReversal(db(), { disputeId: open.disputeId, amount: 30000, createdAt: '2026-07-05T03:00:00Z' });
    expect(await holds([order.orderId])).toEqual([]);
    for (const status of ['lost', 'won', 'warning_closed']) {
      const closed = await dispute(order, 1000, { amount: 1000, status });
      expect((await holds([order.orderId])).map((r) => r.dispute_id)).not.toContain(closed.disputeId);
    }
  });

  test('FREQ-568-AC-06: 一覧の読み口は申し立ての資料の写しと名前を返さず、確定の日と振り替え先と計上待ちの理由を出す', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await q(`update public.stripe_disputes set evidence_details = '{"customer_name":"Taro Yamada","customer_email_address":"taro@example.invalid"}'::jsonb where id = $1`, [d.disputeId]);
    await lose(d.disputeId);
    await runDisputes();
    const listed = (await q('select public.list_accounting_disputes(10, null, null) as r')).rows[0].r;
    const row = listed.disputes.find((x: { dispute_id: string }) => x.dispute_id === d.disputeId);
    expect(row).toEqual({ dispute_id: d.disputeId, reason: 'fraudulent', status: 'lost', amount: 30000, order_id: order.orderId,
      stripe_created_at: expect.any(String), withdrawn_on: '2026-06-20', confirmed_on: '2026-12-20', assigned_account_code: '7530', pending_reasons: [] });
    expect(JSON.stringify(listed)).not.toMatch(/Taro|taro@|evidence|raw_payload|customer_/);
    // A parked reversal shows its reason.
    const waiting = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 1000, createdAt: '2027-01-02T03:00:00Z' });
    await q('update public.stripe_balance_transactions set amount = 99999999, net = 99999999 where id = $1', [waiting]);
    await runDisputes();
    const again = (await q('select public.list_accounting_disputes(10, null, null) as r')).rows[0].r;
    expect(again.disputes.find((x: { dispute_id: string }) => x.dispute_id === d.disputeId).pending_reasons).toEqual(['posting_error']);
    // Paging: one row per page, the next page starts after the last row.
    await dispute(order, 1000, { amount: 1000, withdrawnAt: null, createdAt: '2026-06-01T00:00:00Z' });
    const page1 = (await q('select public.list_accounting_disputes(1, null, null) as r')).rows[0].r;
    expect(page1.disputes).toHaveLength(1);
    expect(page1.next_after_id).not.toBeNull();
    const page2 = (await q('select public.list_accounting_disputes(1, $1::timestamptz, $2) as r', [page1.next_after_at, page1.next_after_id])).rows[0].r;
    expect(page2.disputes[0].dispute_id).not.toBe(page1.disputes[0].dispute_id);
    expect(await accountingFailure(db(), () => q('select public.list_accounting_disputes(0, null, null)'))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
    expect(await accountingFailure(db(), () => q('select public.list_accounting_disputes(10, now(), null)'))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
  });

  // ---- stops (4-e2) -------------------------------------------------------------------------------------------------------
  test('FREQ-568-AC-01: 成功した返金がある注文はdispute_refund_overlapで止まり、二重に費用にしない', async () => {
    const order = await seedOrder({ shipped: 5 });
    await q(`insert into public.stripe_refunds (id, payment_intent_id, order_id, amount, currency, status, stripe_created_at, succeeded_at, raw_payload)
      values ('re_overlap', $1, $2, 1000, 'jpy', 'succeeded', now(), now(), '{}'::jsonb)`, [order.paymentIntentId, order.orderId]);
    const d = await dispute(order, 30000, { amount: 30000 });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'dispute_refund_overlap', detail: {}, order_id: order.orderId });
    expect(await disputeEntryCount(d.disputeId)).toBe(0);
  });

  test('FREQ-568-AC-01: 返品の返金待ち（2130）がある注文はdispute_return_refund_pendingで止まる', async () => {
    const order = await seedOrder({ shipped: 5 });
    await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event($1::date), $1::date, 'return_arrived',
        ARRAY['RT-0001']::text[], 'return', $2::jsonb)`,
      ['2026-06-18', JSON.stringify([{ account_code: '4010', debit: 1000, credit: 0 }, { account_code: '2130', debit: 0, credit: 1000, order_id: order.orderId, sub_account: 'return_refund' }])]);
    const d = await dispute(order, 30000, { amount: 30000 });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: {} });
  });

  test('FREQ-568-AC-01: 結び付く注文が無い取り消しはno_orderで止まる', async () => {
    const d = await seedDispute(db(), { orderId: null, paymentIntentId: null, amount: 30000 });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'no_order', detail: {}, order_id: null });
    // A balance transaction of a dispute that was never saved is parked the same way.
    const orphan = await seedStripeFee(db(), { createdAt: W_AT, type: 'adjustment', reportingCategory: 'dispute', amount: -500, sourceId: 'dp_unknownunknown' });
    await runDisputes();
    expect(await pendingOf('stripe_balance_transactions', orphan)).toMatchObject({ reason: 'no_order' });
  });

  test('FREQ-568-AC-01: 前受金の残りより多い未出荷の分はdeferred_revenue_shortで止まる', async () => {
    const order = await seedOrder();
    const d = await dispute(order, 30000, { amount: 30000 });
    // The deferred revenue was already taken (a sale entry nobody explains): U = 30,000 against a balance of 20,000.
    await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event($1::date), $1::date, 'pre_shipment_refund',
        ARRAY['RF-9999']::text[], 'refund', $2::jsonb)`,
      ['2026-06-12', JSON.stringify([{ account_code: '2150', debit: 10000, credit: 0, order_id: order.orderId }, { account_code: '1160', debit: 0, credit: 10000, order_id: order.orderId }])]);
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'deferred_revenue_short', detail: { shortage: 10000 } });
  });

  test('FREQ-568-AC-01: 同じ取り消しの係を2回流しても仕訳は1本のままで、2回目は何も足さない', async () => {
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    expect(await runDisputes()).toEqual({ ...none, posted: 1, withdrawn: 1 });
    expect(await runDisputes()).toEqual(none);
    expect(await disputeEntryCount(d.disputeId)).toBe(1);
    expect(Number((await q('select count(*) as n from public.accounting_journal_entries where starts_with(dedupe_key, $1)', [`dispute_event:${d.disputeId}:withdrawn:`])).rows[0].n)).toBe(1);
  });

  // ---- period_missing carries the day of the entry ---------------------------------------------------------------------------
  test('FREQ-569-AC-01: W・C・R・Lがperiod_missingで止まるとdetail.entry_dateがその段の仕訳の日になり、止め直しても日付が残る', async () => {
    await setSetting('fraudulent', '7530');
    const admin = await insertAccountingAdmin(db());
    // Four disputes whose earlier stages go in while the sole period of 2026 is the only one.
    const orderC = await seedOrder({ shipped: 8 });
    const disputeC = await dispute(orderC, 30000, { amount: 30000 });
    const orderR = await seedOrder({ shipped: 8 });
    const disputeR = await dispute(orderR, 30000, { amount: 30000 });
    const orderL = await seedOrder({ shipped: 8 });
    const disputeL = await dispute(orderL, 30000, { amount: 30000 });
    await lose(disputeL.disputeId, LOST_AT);
    await runDisputes();
    expect(await entryOf(key(disputeL.disputeId, 'confirmed', 'lost'))).toBeDefined();
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    // W: its day is in 2027. C: the loss is in 2027. R: the reversal (won) is in 2027. L: the reversal after the loss is in 2027.
    const orderW = await seedOrder({ shipped: 8 });
    const disputeW = await dispute(orderW, 30000, { amount: 30000, withdrawnAt: '2027-01-02T03:00:00Z' });
    await lose(disputeC.disputeId, '2027-01-05T03:00:00Z');
    await addDisputeHistory(db(), { disputeId: disputeR.disputeId, status: 'won', occurredAt: '2027-01-03T05:00:00Z', eventType: 'charge.dispute.closed' });
    const reversalR = await seedDisputeReversal(db(), { disputeId: disputeR.disputeId, amount: 30000, createdAt: '2027-01-03T03:00:00Z' });
    const reversalL = await seedDisputeReversal(db(), { disputeId: disputeL.disputeId, amount: 30000, createdAt: '2027-01-10T03:00:00Z' });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 4 });
    const expected: Array<[string, string, string]> = [
      ['stripe_balance_transactions', disputeW.txnId as string, '2027-01-02'],
      ['stripe_disputes', disputeC.disputeId, '2027-01-05'],
      ['stripe_balance_transactions', reversalR, '2027-01-03'],
      ['stripe_balance_transactions', reversalL, '2027-01-10']];
    for (const [table, id, date] of expected) {
      expect([table, (await pendingOf(table, id))?.reason, (await pendingOf(table, id))?.detail]).toEqual([table, 'period_missing', { entry_date: date }]);
    }
    expect(await runDisputes()).toEqual({ ...none, reparked: 4 });
    for (const [table, id, date] of expected) expect((await pendingOf(table, id))?.detail).toEqual({ entry_date: date });
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(await runDisputes()).toMatchObject({ posted: 4, resolved: 4, reparked: 0 });
  });

  test('FREQ-569-AC-06: 取り消しの1件が失敗しても、ほかの取り消しは入り、直した後の再計上で保留が解決する', async () => {
    const order = await seedOrder({ shipped: 5 });
    const bad = await dispute(order, 10000, { amount: 10000, withdrawnAt: '2026-06-20T03:00:00Z' });
    const good = await dispute(order, 5000, { amount: 5000, withdrawnAt: '2026-06-21T03:00:00Z' });
    // An id a key cannot hold: the core refuses it (a posting error), the next withdrawal still goes in.
    await q('update public.stripe_balance_transactions set id = $2 where id = $1', [bad.txnId, 'txn:with:colons']);
    expect(await runDisputes()).toEqual({ ...none, posted: 1, parked_new: 1, withdrawn: 1 });
    await q('set constraints all immediate');
    await q('set constraints all deferred');
    expect(await pendingOf('stripe_balance_transactions', 'txn:with:colons')).toMatchObject({
      reason: 'posting_error', detail: { error_sqlstate: '22023', error_code: 'ACCOUNTING_ARGUMENT_INVALID', entry_date: '2026-06-20' } });
    expect(await entryOf(key(good.disputeId, 'withdrawn', good.txnId as string))).toBeDefined();
    expect(await disputeEntryCount(bad.disputeId)).toBe(0);
    await q('update public.stripe_balance_transactions set id = $2 where id = $1', ['txn:with:colons', 'txn_fixed_after_error']);
    await q("update public.accounting_pending_events set source_id = 'txn_fixed_after_error' where source_id = 'txn:with:colons'");
    const again = await runDisputes();
    expect([again, await pendingOf('stripe_balance_transactions', 'txn_fixed_after_error')]).toEqual([{ ...none, posted: 1, resolved: 1, withdrawn: 1 }, expect.anything()]);
    expect((await pendingOf('stripe_balance_transactions', 'txn_fixed_after_error'))?.resolved_entry_id).not.toBeNull();
  });

  // ---- FREQ-568-AC-07: every order of arrival gives the same last balances and the same profit per year -------------------------
  /** The last balances of a dispute as the AC-07 table lists them. */
  async function measure(disputeId: string) {
    const profit = Object.fromEntries((await q(
      `select extract(year from e.entry_date)::int as y, sum(l.credit - l.debit)::int as profit
       from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
       join public.accounting_accounts a on a.code = l.account_code and a.account_type in ('expense', 'revenue')
       where starts_with(e.dedupe_key, $1) group by 1 having sum(l.credit - l.debit) <> 0 order by 1`, [`dispute_event:${disputeId}:`])).rows.map((r) => [String(r.y), r.profit]));
    const delta2150 = Number((await q(
      `select coalesce(sum(l.credit - l.debit), 0) as b from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
       where l.account_code = '2150' and starts_with(e.dedupe_key, $1)`, [`dispute_event:${disputeId}:`])).rows[0].b);
    return {
      pending: await balance(disputeId, '1470', 'dispute_pending'),
      unassigned: await balance(disputeId, '1470', 'dispute_confirmed_unassigned'),
      expense: await balance(disputeId, '7530', null),
      d2150: delta2150, profit, entries: await disputeEntryCount(disputeId),
    };
  }

  type Step = 'W' | 'lostNotice' | 'lostReconcile' | 'lostTimed' | 'won' | 'rev';
  type MatrixRow = {
    id: number; shipped: number; setting: boolean; end: 'lost' | 'won' | 'none'; rev: null | { amount: number; at: string };
    x: 'none' | 'after' | 'beforeRev';
    expected: { pending: number; unassigned: number; expense: number; d2150: number; profit: Record<string, number>; entries: number };
  };
  const rows: MatrixRow[] = [
    { id: 1, shipped: 5, setting: true, end: 'lost', rev: null, x: 'none', expected: { pending: 0, unassigned: 0, expense: 18750, d2150: -11250, profit: { 2026: -18750 }, entries: 2 } },
    { id: 2, shipped: 5, setting: false, end: 'lost', rev: null, x: 'after', expected: { pending: 0, unassigned: 0, expense: 18750, d2150: -11250, profit: { 2026: -18750 }, entries: 3 } },
    { id: 3, shipped: 5, setting: true, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: { 2026: -18750, 2027: 18750 }, entries: 3 } },
    { id: 4, shipped: 5, setting: false, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'beforeRev', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: { 2026: -18750, 2027: 18750 }, entries: 4 } },
    { id: 5, shipped: 5, setting: false, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'after', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: { 2026: -18750, 2027: 18750 }, entries: 4 } },
    { id: 6, shipped: 5, setting: true, end: 'lost', rev: { amount: 30000, at: R_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: {}, entries: 2 } },
    { id: 7, shipped: 5, setting: true, end: 'lost', rev: { amount: 10000, at: L_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 12500, d2150: -7500, profit: { 2026: -18750, 2027: 6250 }, entries: 3 } },
    { id: 8, shipped: 5, setting: true, end: 'lost', rev: { amount: 10000, at: R_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 12500, d2150: -7500, profit: { 2026: -12500 }, entries: 3 } },
    { id: 9, shipped: 0, setting: true, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: {}, entries: 2 } },
    { id: 10, shipped: 8, setting: true, end: 'won', rev: { amount: 30000, at: R_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: {}, entries: 2 } },
    { id: 11, shipped: 8, setting: true, end: 'lost', rev: null, x: 'none', expected: { pending: 0, unassigned: 0, expense: 30000, d2150: 0, profit: { 2026: -30000 }, entries: 2 } },
    { id: 12, shipped: 5, setting: true, end: 'none', rev: null, x: 'none', expected: { pending: 18750, unassigned: 0, expense: 0, d2150: -11250, profit: {}, entries: 1 } },
  ];
  // The ways the loss reaches this system: the notice, the nightly re-read (without Stripe's time), both, or the re-read alone with the time.
  const lostForms: Array<{ name: string; steps: Step[] }> = [
    { name: 'notice', steps: ['lostNotice'] },
    { name: 'notice+reread', steps: ['lostNotice', 'lostReconcile'] },
    { name: 'reread only', steps: ['lostTimed'] },
  ];
  const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items] :
    items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));

  test('FREQ-568-AC-07: disputeの出来事がどの順で届いても、最後の残高と年ごとの利益は同じ（場合1〜12）', async () => {
    const admin = await insertAccountingAdmin(db());
    let scenarios = 0;
    for (const row of rows) {
      const order = await seedOrder({ shipped: row.shipped });
      const forms = row.end === 'lost' ? lostForms : [{ name: row.end, steps: row.end === 'won' ? (['won'] as Step[]) : ([] as Step[]) }];
      for (const form of forms) {
        const base: Step[] = ['W', ...form.steps, ...(row.rev && row.x !== 'beforeRev' ? (['rev'] as Step[]) : [])];
        const rBeforeLost = row.rev !== null && new Date(row.rev.at) <= new Date(LOST_AT) && row.end === 'lost';
        const orders = permutations(base).filter((steps) => {
          // A reversal at or before the loss time is in the table before the lost row can exist (they come from the same read).
          if (rBeforeLost) {
            const rev = steps.indexOf('rev');
            return steps.every((step, index) => !step.startsWith('lost') || index > rev);
          }
          return true;
        });
        for (const steps of orders) {
          for (const mode of ['each', 'end'] as const) {
            await q('savepoint matrix');
            scenarios += 1;
            const d = await dispute(order, 30000, { amount: 30000, withdrawnAt: null });
            if (row.setting) await setSetting('fraudulent', '7530', admin);
            let reversalId: string | null = null;
            const apply = async (step: Step) => {
              if (step === 'W') {
                await seedStripeFee(db(), { createdAt: W_AT, type: 'adjustment', reportingCategory: 'dispute', amount: -30000, sourceId: d.disputeId });
              } else if (step === 'lostNotice') {
                await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-20T04:00:00Z', stripeEventCreatedAt: LOST_AT, eventType: 'charge.dispute.closed' });
              } else if (step === 'lostReconcile') {
                await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-21T05:00:00Z', eventId: `reconcile:${d.disputeId}:lost`, eventType: 'reconcile' });
              } else if (step === 'lostTimed') {
                await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-21T05:00:00Z', stripeEventCreatedAt: LOST_AT, eventId: `reconcile:${d.disputeId}:lost`, eventType: 'reconcile' });
              } else if (step === 'won') {
                await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-12-11T00:00:00Z', eventType: 'charge.dispute.closed' });
              } else if (row.rev) {
                reversalId = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: row.rev.amount, createdAt: row.rev.at });
              }
            };
            const settle = async () => { for (let i = 0; i < 4; i += 1) { if ((await runDisputes()).posted === 0) break; } };
            const assign = async () => {
              await setSetting('fraudulent', '7530', admin);
              await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()]);
            };
            for (const step of steps) {
              await apply(step);
              if (mode === 'each') await runDisputes();
            }
            await settle();
            if (row.x === 'after') {
              // The loss sits in the unassigned sub-account until a person assigns it.
              expect(await balance(d.disputeId, '1470', 'dispute_confirmed_unassigned')).toBe(18750);
              await assign();
              await settle();
            } else if (row.x === 'beforeRev') {
              await assign();
              await apply('rev');
              await settle();
            }
            const label = `row ${row.id} / ${form.name} / ${steps.join(',')} / ${mode}`;
            const actual = await measure(d.disputeId);
            expect({ label, ...actual }).toEqual({ label, ...row.expected });
            // No event has two entries, and nothing is left waiting.
            expect(Number((await q(
              `select count(*) as n from (select dedupe_key from public.accounting_journal_entries where starts_with(dedupe_key, $1)
               group by dedupe_key having count(*) > 1) x`, [`dispute_event:${d.disputeId}:`])).rows[0].n)).toBe(0);
            expect(Number((await q(
              `select count(*) as n from public.accounting_pending_events where event_kind = 'dispute_event' and resolved_at is null
               and (source_id = $1 or source_id = $2 or source_id in (select id from public.stripe_balance_transactions where source_id = $1))`,
              [d.disputeId, reversalId ?? d.disputeId])).rows[0].n)).toBe(0);
            await q('rollback to savepoint matrix');
            await q('release savepoint matrix');
          }
        }
      }
    }
    // 12 rows, the forms of the loss, every order of arrival, and a poster run after each step or only at the end.
    expect(scenarios).toBeGreaterThan(200);
  });

  test('FREQ-568-AC-07: W が止まっている間に lost と戻りが届き、あとで W が入っても、待っている間は仕訳が増えず、最後は場合1〜12と同じ（場合13）', async () => {
    const admin = await insertAccountingAdmin(db());
    for (const row of rows) {
      await q('savepoint row13');
      // The slip was confirmed before the withdrawal but its shipment entry is not posted: the withdrawal waits (dispute_shipment_pending).
      const order = await seedOrder();
      if (row.shipped > 0) await confirmSlipAt(order, row.shipped, '2026-06-15', '2026-06-15T01:00:00Z');
      const d = await dispute(order, 30000, { amount: 30000, withdrawnAt: null });
      if (row.setting) await setSetting('fraudulent', '7530', admin);
      await seedStripeFee(db(), { createdAt: W_AT, type: 'adjustment', reportingCategory: 'dispute', amount: -30000, sourceId: d.disputeId });
      const lateRev = row.rev !== null && row.x !== 'beforeRev';
      if (lateRev && new Date((row.rev as { at: string }).at) <= new Date(LOST_AT)) {
        await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: (row.rev as { amount: number }).amount, createdAt: (row.rev as { at: string }).at });
      }
      if (row.end === 'lost') await lose(d.disputeId);
      if (row.end === 'won') await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-12-11T00:00:00Z', eventType: 'charge.dispute.closed' });
      if (lateRev && new Date((row.rev as { at: string }).at) > new Date(LOST_AT)) {
        await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: (row.rev as { amount: number }).amount, createdAt: (row.rev as { at: string }).at });
      }
      // Nothing is booked while the withdrawal waits, however many times the poster runs.
      if (row.shipped > 0) {
        await runDisputes();
        await runDisputes();
        expect({ row: row.id, entries: await disputeEntryCount(d.disputeId) }).toEqual({ row: row.id, entries: 0 });
        await postShipments();
      }
      for (let i = 0; i < 4; i += 1) { if ((await runDisputes()).posted === 0) break; }
      if (row.x === 'after' || row.x === 'beforeRev') {
        await setSetting('fraudulent', '7530', admin);
        await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()]);
        if (row.x === 'beforeRev') {
          await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: (row.rev as { amount: number }).amount, createdAt: (row.rev as { at: string }).at });
        }
        for (let i = 0; i < 4; i += 1) { if ((await runDisputes()).posted === 0) break; }
      }
      expect({ row: row.id, ...(await measure(d.disputeId)) }).toEqual({ row: row.id, ...row.expected });
      await q('rollback to savepoint row13');
      await q('release savepoint row13');
    }
  });

  test('FREQ-569-AC-05: 元の記録の時刻は保存した時刻と今の小さい方で、2か月を超えてから記録した引かれた時・確定は遅れの印が付き、その前なら付かない', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 8 });
    // Withdrawal saved the day after (not late) and saved long afterwards (late); a time in the future is clamped to now and still posts.
    const near = await dispute(order, 10000, { syncedAt: '2026-06-21T00:00:00Z' });
    const far = await dispute(order, 5000, { syncedAt: '2026-10-01T00:00:00Z' });
    const future = await dispute(order, 3000, { syncedAt: '2999-01-01T00:00:00Z' });
    expect(await runDisputes()).toEqual({ ...none, posted: 3, withdrawn: 3 });
    const entry = async (d: { disputeId: string; txnId: string | null }) => entryOf(key(d.disputeId, 'withdrawn', d.txnId as string));
    expect(await entry(near)).toMatchObject({ is_late: false });
    expect(new Date((await entry(near)).source_recorded_at).toISOString()).toBe('2026-06-21T00:00:00.000Z');
    expect(await entry(far)).toMatchObject({ is_late: true });
    expect(new Date((await entry(far)).source_recorded_at).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect((await entry(future)).is_late).toBe(true);
    expect(new Date((await entry(future)).source_recorded_at).getTime()).toBeLessThanOrEqual(Date.now());
    // The confirmation: the lost row was saved the day after the loss (not late), or two and a half months afterwards (late).
    await addDisputeHistory(db(), { disputeId: near.disputeId, status: 'lost', occurredAt: '2026-08-02T00:00:00Z', stripeEventCreatedAt: '2026-08-01T03:00:00Z',
      eventType: 'charge.dispute.closed', createdAt: '2026-08-02T00:00:00Z' });
    await addDisputeHistory(db(), { disputeId: far.disputeId, status: 'lost', occurredAt: '2026-08-02T00:00:00Z', stripeEventCreatedAt: '2026-08-01T03:00:00Z',
      eventType: 'charge.dispute.closed', createdAt: '2026-10-15T00:00:00Z' });
    await runDisputes();
    expect(await entryOf(key(near.disputeId, 'confirmed', 'lost'))).toMatchObject({ is_late: false, entry_date: '2026-08-01' });
    expect(await entryOf(key(far.disputeId, 'confirmed', 'lost'))).toMatchObject({ is_late: true, entry_date: '2026-08-01' });
  });

  test('FREQ-562-AC-05: 取り消しの係は limit が範囲の外なら断り、新しい出来事を _limit 件までと未解決の見直し10件までで切る', async () => {
    for (const bad of [0, 201, -1, null]) {
      expect(await accountingFailure(db(), () => q('select private.accounting_post_dispute_events($1::integer)', [bad]))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    }
    const order = await seedOrder({ shipped: 8 });
    for (let i = 0; i < 3; i += 1) await dispute(order, 1000, { withdrawnAt: `2026-06-2${i}T03:00:00Z` });
    expect(await runDisputes(2)).toEqual({ ...none, posted: 2, withdrawn: 2 });
    expect(await runDisputes(2)).toEqual({ ...none, posted: 1, withdrawn: 1 });
    expect(await runDisputes(2)).toEqual(none);
  });

  test('FREQ-568-AC-03: before_cutover で止まった引かれた時は入らないので、後に確定した発送票はそれを待たずに入る', async () => {
    const order = await seedOrder();
    // A withdrawal before the cutover day never posts. The slip confirmed after it must not wait for it.
    const d = await dispute(order, 10000, { amount: 10000, withdrawnAt: '2025-12-30T03:00:00Z' });
    expect(await runDisputes()).toEqual({ ...none, parked_new: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'before_cutover' });
    const slip = await confirmSlipAt(order, 5, '2026-06-21', '2026-06-21T01:00:00Z');
    await postShipments();
    expect(await entryOf(`shipment_confirmed:${slip.number}`)).toBeDefined();
    expect((await q("select 1 from public.accounting_pending_events where event_kind = 'shipment_confirmed' and source_id = $1", [slip.slipId])).rows).toEqual([]);
  });

  test('FREQ-568-AC-04: 確定の後に保存された戻りの取引は、lostの時刻より前の時刻でも遅れた取り下げとして入り、dispute_pendingはマイナスにならない', async () => {
    await setSetting('fraudulent', '7530');
    const order = await seedOrder({ shipped: 5 });
    const d = await dispute(order, 30000, { amount: 30000 });
    await lose(d.disputeId);
    await runDisputes();
    // C took the whole balance. A reversal that is saved afterwards is an L whatever its time: C is not computed again.
    const reversal = await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 30000, createdAt: R_AT });
    expect(await runDisputes()).toMatchObject({ posted: 1, late_reversals: 1, reversals: 0 });
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    expect((await linesOf((await entryOf(key(d.disputeId, 'reversal', reversal))).id))[0].memo).toBe('dispute_reversal_kind:L');
  });
});
