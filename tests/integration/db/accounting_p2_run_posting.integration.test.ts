/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { accountingFailure, insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, seedConfirmedSlip, seedDispute, seedDisputeReversal, seedPaidOrder, seedPostedPayment, seedStripeCharge,
  setAsideExistingSlips, setCutoverForTest,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 6 (FREQ-562-AC-05 / FREQ-569-AC-02 / FREQ-569-AC-06): the posting entry point public.accounting_run_posting.
// ROLLBACK form (run with --runInBand). The entry point calls the payment, shipment, Stripe and dispute posters in that order.
jest.setTimeout(120000);

type RunResult = { payments: number; shipments: number; stripe: number; disputes: number; parked: number; resolved: number; has_more: boolean };

describeLocalDb('S11 posting entry point: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const run = async (limit = 50): Promise<RunResult> => (await q('select public.accounting_run_posting($1::integer) as r', [limit])).rows[0].r as RunResult;
  const quiet: RunResult = { payments: 0, shipments: 0, stripe: 0, disputes: 0, parked: 0, resolved: 0, has_more: false };
  const entryOf = async (dedupeKey: string) => (await q('select id, entry_no from public.accounting_journal_entries where dedupe_key = $1', [dedupeKey])).rows[0];
  const pendingOf = async (sourceTable: string, sourceId: string) => (await q(
    `select reason, detail, resolved_at, resolved_entry_id from public.accounting_pending_events where source_table = $1 and source_id = $2`,
    [sourceTable, sourceId])).rows[0];
  /** An order with its charge (payment not posted yet) of 8,000 yen and a fee of 360. */
  async function unpostedPayment(createdAt = '2026-06-10T03:00:00Z') {
    const order = await seedPaidOrder(db(), { lines: [{ price: 4000, quantity: 2 }], paidAt: createdAt });
    const txId = await seedStripeCharge(db(), { paymentIntentId: order.paymentIntentId, amount: order.total, createdAt, fee: 360 });
    return { ...order, txId };
  }
  const slipFor = (order: { orderId: string; orderItemIds: string[] }, quantity: number, shipmentDate = '2026-06-15') =>
    seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity }] }], shipmentDate });

  test('FREQ-562-AC-05: 係の入口は支払い・出荷・Stripe・取り消しを順に処理し、同じ内容を2回流すと2回目は0件', async () => {
    const other = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const paid = await unpostedPayment();
    await slipFor(paid, 2);
    const d = await seedDispute(db(), { orderId: other.orderId, paymentIntentId: other.paymentIntentId, amount: 30000, withdrawnAt: '2026-06-20T03:00:00Z' });
    const first = await run();
    expect(first).toEqual({ payments: 1, shipments: 1, stripe: 1, disputes: 1, parked: 0, resolved: 0, has_more: false });
    expect(Object.keys(first).sort()).toEqual(['disputes', 'has_more', 'parked', 'payments', 'resolved', 'shipments', 'stripe']);
    expect(await entryOf(`payment_confirmed:${paid.paymentIntentId}`)).toBeDefined();
    expect(await entryOf(`stripe:fee:${paid.txId}`)).toBeDefined();
    expect(await entryOf(`dispute_event:${d.disputeId}:withdrawn:${d.txnId}`)).toBeDefined();
    expect(await run()).toEqual(quiet);
  });

  test('FREQ-562-AC-05: 支払いより先に出荷が起きていても、1回の呼び出しの中で支払い→出荷の順に入り、出荷は計上待ちに止まらない', async () => {
    const paid = await unpostedPayment();
    const slip = await slipFor(paid, 2);
    // The slip was confirmed before the payment is booked: the shipment needs the payment entry, which the same call creates first.
    expect(await run()).toMatchObject({ payments: 1, shipments: 1, parked: 0 });
    expect(await entryOf(`shipment_confirmed:${slip.number}`)).toBeDefined();
    expect(await pendingOf('shipment_slips', slip.slipId)).toBeUndefined();
  });

  test('FREQ-569-AC-06: 1件の出来事がcoreで失敗してもほかの係の出来事は計上され、SET CONSTRAINTS ALL IMMEDIATEの後にも成功と保留が残る', async () => {
    const other = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const paid = await unpostedPayment();
    // A balance transaction number a key cannot hold: the core refuses this withdrawal, everything else goes in.
    const bad = await seedDispute(db(), { orderId: other.orderId, paymentIntentId: other.paymentIntentId, amount: 30000, txnId: 'txn:with:colons' });
    expect(await run()).toMatchObject({ payments: 1, stripe: 1, disputes: 0, parked: 1 });
    await q('set constraints all immediate');
    await q('set constraints all deferred');
    expect(await entryOf(`payment_confirmed:${paid.paymentIntentId}`)).toBeDefined();
    expect(await pendingOf('stripe_balance_transactions', 'txn:with:colons')).toMatchObject({
      reason: 'posting_error', detail: { error_sqlstate: '22023', error_code: 'ACCOUNTING_ARGUMENT_INVALID', entry_date: '2026-06-20' }, resolved_at: null });
    expect(Number((await q('select count(*) as n from public.accounting_journal_entries where starts_with(dedupe_key, $1)', [`dispute_event:${bad.disputeId}:`])).rows[0].n)).toBe(0);
  });

  test('FREQ-569-AC-06: posting_errorが毎回失敗しても新しい候補を塞がず、直した後の再計上で保留が解決する（FREQ-569-AC-02: 直らない保留が_limit件あっても後ろの新しい出来事は入り、has_moreは偽になる）', async () => {
    const a = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const b = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const badDispute = await seedDispute(db(), { orderId: a.orderId, paymentIntentId: a.paymentIntentId, amount: 30000 });
    const goodDispute = await seedDispute(db(), { orderId: b.orderId, paymentIntentId: b.paymentIntentId, amount: 30000 });
    expect(await run()).toMatchObject({ disputes: 2 });
    for (const id of [badDispute.disputeId, goodDispute.disputeId]) {
      await addDisputeHistory(db(), { disputeId: id, status: 'won', occurredAt: '2026-07-06T03:00:00Z', eventType: 'charge.dispute.closed' });
    }
    // The first reversal is larger than what was withdrawn: it fails every time. The second one is fine and comes later.
    const bad = await seedDisputeReversal(db(), { disputeId: badDispute.disputeId, amount: 40000, createdAt: '2026-07-05T03:00:00Z' });
    const good = await seedDisputeReversal(db(), { disputeId: goodDispute.disputeId, amount: 30000, createdAt: '2026-07-05T05:00:00Z' });
    // limit 1: the bad one is parked (a new stop counts), so there may be more.
    expect(await run(1)).toEqual({ ...quiet, parked: 1, has_more: true });
    expect(await pendingOf('stripe_balance_transactions', bad)).toMatchObject({ reason: 'posting_error', resolved_at: null,
      detail: { error_sqlstate: '22023', error_code: 'ACCOUNTING_ARGUMENT_INVALID', entry_date: '2026-07-05' } });
    // The parked one no longer takes the place of a new event: the good one goes in (and the bad one is looked at again).
    expect(await run(1)).toEqual({ ...quiet, disputes: 1, parked: 1, has_more: true });
    expect(await entryOf(`dispute_event:${goodDispute.disputeId}:reversal:${good}`)).toBeDefined();
    // Only the same unresolved stop is parked again: nothing new, so has_more is false.
    expect(await run(1)).toEqual({ ...quiet, parked: 1, has_more: false });
    expect((await pendingOf('stripe_balance_transactions', bad)).detail).toMatchObject({ error_code: 'ACCOUNTING_ARGUMENT_INVALID' });
    // After the data is fixed the next call books it and closes the parked row.
    await q('update public.stripe_balance_transactions set amount = 30000, net = 30000 where id = $1', [bad]);
    expect(await run()).toEqual({ ...quiet, disputes: 1, resolved: 1 });
    const closed = await pendingOf('stripe_balance_transactions', bad);
    expect(closed.resolved_at).not.toBeNull();
    expect(closed.resolved_entry_id).toBe((await entryOf(`dispute_event:${badDispute.disputeId}:reversal:${bad}`)).id);
  });

  test('FREQ-569-AC-02: 計上待ちの出来事は、直ると次の呼び出しで入り解決済みになる', async () => {
    const admin = await insertAccountingAdmin(db());
    const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    const d = await seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30000, withdrawnAt: '2027-01-03T03:00:00Z' });
    expect(await run()).toEqual({ ...quiet, parked: 1 });
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'period_missing', detail: { entry_date: '2027-01-03' } });
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(await run()).toEqual({ ...quiet, disputes: 1, resolved: 1 });
    const closed = await pendingOf('stripe_balance_transactions', d.txnId as string);
    expect(closed.resolved_entry_id).toBe((await entryOf(`dispute_event:${d.disputeId}:withdrawn:${d.txnId}`)).id);
  });

  test('FREQ-562-AC-05: 入口は limit が範囲の外なら断り、has_more は入れた・新しく止めた件数が上限に達した時だけ真', async () => {
    for (const bad of [0, 201, -1, null]) {
      expect(await accountingFailure(db(), () => q('select public.accounting_run_posting($1::integer)', [bad]))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
      expect(await accountingFailure(db(), () => q('select private.accounting_run_posting($1::integer)', [bad]))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
    }
    await unpostedPayment('2026-06-10T03:00:00Z');
    await unpostedPayment('2026-06-11T03:00:00Z');
    // Two payments and two fees are waiting. Limit 1 books one of each kind, which reaches the limit.
    const first = await run(1);
    expect(first).toMatchObject({ payments: 1, stripe: 1, has_more: true });
    expect(await run(1)).toMatchObject({ payments: 1, stripe: 1, has_more: true });
    expect(await run(1)).toEqual(quiet);
    // Below the limit there is nothing left to do.
    await unpostedPayment('2026-06-12T03:00:00Z');
    expect(await run(200)).toMatchObject({ payments: 1, stripe: 1, has_more: false });
    expect(await run(1)).toEqual(quiet);
  });
});
