/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, confirmSlipAt, postManualEntryFixture, seedDispute, seedDisputeReversal, seedPostedPayment, setAsideExistingSlips,
  setCutoverForTest,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 7 (FREQ-571 AC-05 / AC-06): the two-step reconciliation of the intake and the backlog with the books
// (design 8-g, 8-g2), on the example of design 8-3. ROLLBACK form (run with --runInBand). The return and refund entries of plan 3
// are posted straight through the core (postManualEntryFixture); nothing here depends on plan 3.
jest.setTimeout(240000);

type Exception = { kind: string; label_key: string; amount: number; event_kind?: string };
type Reconciliation = {
  opening_backlog: number; intake: number; sales_before_return: number; closing_backlog: number; exceptions: Exception[]; unexplained: number;
  returns: number; booked_sales_net_orders: number; return_fee_revenue_4050: number; other_4010: number; other_4020: number; book_sales_total: number;
  unexplained2: number; dispute_confirmed_by_account: Array<{ account_code: string; sub_account: string | null; amount: number }>;
};

describeLocalDb('S12 intake reconciliation: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const runAll = async () => (await q('select private.accounting_run_posting(50) as r')).rows[0].r as Record<string, unknown>;
  const reconcile = async (from: string, to: string) =>
    (await q('select public.get_intake_reconciliation($1::date, $2::date) as r', [from, to])).rows[0].r as Reconciliation;
  const amountOf = (result: Reconciliation, kind: string) => result.exceptions.filter((row) => row.kind === kind).map((row) => row.amount);
  const lose = async (disputeId: string, at: string) => {
    await addDisputeHistory(db(), { disputeId, status: 'lost', occurredAt: new Date(new Date(at).getTime() + 3600_000).toISOString(),
      stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
  };
  const postShipments = async () => { await q('select private.accounting_post_shipment_events(50)'); };

  /** Design 8-3: paid 1/20 (18,750), shipped 2/3, the returned item arrives 3/10 (return fee 1,000), refunded 3/12 (17,750). */
  async function seedExample() {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await confirmSlipAt(db(), order, { quantity: 1, shipmentDate: '2026-02-03', lockedAt: '2026-02-03T01:00:00Z' });
    await postShipments();
    await postManualEntryFixture(db(), { entryDate: '2026-03-10', kind: 'return_arrived', parts: [order.orderId], lines: [
      { account: '4020', debit: 18750, orderId: order.orderId }, { account: '2130', credit: 17750, orderId: order.orderId },
      { account: '4050', credit: 1000, orderId: order.orderId }] });
    await postManualEntryFixture(db(), { entryDate: '2026-03-12', kind: 'return_refund', parts: [order.orderId], lines: [
      { account: '2130', debit: 17750, orderId: order.orderId }, { account: '1160', credit: 17750 }] });
    return order;
  }

  test('FREQ-571-AC-05: 1月から3月まで、期首の受注残＋受注高−売上高（返品の前）＝期末の受注残が合う（8-3 の表）', async () => {
    await seedExample();
    const january = await reconcile('2026-01-01', '2026-01-31');
    const february = await reconcile('2026-02-01', '2026-02-28');
    const march = await reconcile('2026-03-01', '2026-03-31');
    expect(january).toMatchObject({ opening_backlog: 0, intake: 18750, sales_before_return: 0, closing_backlog: 18750, unexplained: 0 });
    expect(february).toMatchObject({ opening_backlog: 18750, intake: 0, sales_before_return: 18750, closing_backlog: 0, unexplained: 0 });
    expect(march).toMatchObject({ opening_backlog: 0, intake: 0, sales_before_return: 0, closing_backlog: 0, unexplained: 0 });
    for (const result of [january, february, march]) {
      expect(result.exceptions.every((row) => row.amount === 0)).toBe(true);
      expect(amountOf(result, 'dispute_pending')).toEqual([0]);
      expect(amountOf(result, 'return_refund_2130')).toEqual([0]);
      expect(result.opening_backlog + result.intake - result.sales_before_return).toBe(result.closing_backlog);
    }
  });

  test('FREQ-571-AC-06: 3月の売上高（返品の前）0−返品18,750＝帳簿の売上高−18,750、返品の手数料の売上1,000は別の行', async () => {
    await seedExample();
    expect(await reconcile('2026-01-01', '2026-01-31')).toMatchObject({ sales_before_return: 0, returns: 0, booked_sales_net_orders: 0,
      return_fee_revenue_4050: 0, other_4010: 0, book_sales_total: 0, unexplained2: 0 });
    expect(await reconcile('2026-02-01', '2026-02-28')).toMatchObject({ sales_before_return: 18750, returns: 0, booked_sales_net_orders: 18750,
      return_fee_revenue_4050: 0, other_4010: 0, book_sales_total: 18750, unexplained2: 0 });
    expect(await reconcile('2026-03-01', '2026-03-31')).toMatchObject({ sales_before_return: 0, returns: 18750, booked_sales_net_orders: -18750,
      return_fee_revenue_4050: 1000, other_4010: 0, book_sales_total: -18750, unexplained2: 0 });
    // The whole span: 18,750 - 18,750 = 0 booked sales, the fee stays a separate row.
    expect(await reconcile('2026-01-01', '2026-03-31')).toMatchObject({ sales_before_return: 18750, returns: 18750, booked_sales_net_orders: 0,
      return_fee_revenue_4050: 1000, book_sales_total: 0, unexplained: 0, unexplained2: 0 });
  });

  test('FREQ-571-AC-06: 注文番号なしの4010（店頭など）はother_4010に出て全体の帳簿へつながり、4050は帳簿の売上高に入らない', async () => {
    await seedExample();
    await postManualEntryFixture(db(), { entryDate: '2026-03-15', kind: 'compensation_received', parts: ['fixture-store-sale'], lines: [
      { account: '1160', debit: 5000 }, { account: '4010', credit: 5000 }] });
    await postManualEntryFixture(db(), { entryDate: '2026-03-16', kind: 'owner_use', parts: ['fixture-store-return'], lines: [
      { account: '4020', debit: 300 }, { account: '1160', credit: 300 }] });
    const march = await reconcile('2026-03-01', '2026-03-31');
    expect(march).toMatchObject({ other_4010: 5000, other_4020: 300, booked_sales_net_orders: -18750, return_fee_revenue_4050: 1000,
      book_sales_total: -18750 + 5000 - 300, unexplained2: 0 });
    expect(march.book_sales_total).toBe(march.booked_sales_net_orders + march.other_4010 - march.other_4020);
    // The two figures that make the books' total (4010 - 4020) are the whole of the sales rows, and 4050 is outside it.
    const books = (await q(
      `select coalesce(sum(l.credit - l.debit) filter (where l.account_code = '4010'), 0)::int as sales,
        coalesce(sum(l.debit - l.credit) filter (where l.account_code = '4020'), 0)::int as returns
       from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
       where e.entry_date between '2026-03-01' and '2026-03-31'`)).rows[0];
    expect(march.book_sales_total).toBe(books.sales - books.returns);
  });

  test('FREQ-571-AC-05: 判断待ちの取り消しで前受金を先に減らした分は例外の行（dispute_pending）で説明され、説明のつかない差は0', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const d = await seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30000, withdrawnAt: '2026-06-20T03:00:00Z' });
    await runAll();
    // June: paid 30,000 (intake), withdrawn 30,000 (2150 down, intake not yet): the closing backlog is 0 and the gap is the exception row.
    const june = await reconcile('2026-06-01', '2026-06-30');
    expect(june).toMatchObject({ opening_backlog: 0, intake: 30000, sales_before_return: 0, closing_backlog: 0, unexplained: 0 });
    expect(amountOf(june, 'dispute_pending')).toEqual([-30000]);
    // Part of it comes back before the decision (a reversal is booked once the dispute is settled; its time is before the loss time,
    // so it is the early kind): 2150 is up again in July, the exception moves the other way.
    await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 10000, createdAt: '2026-07-05T03:00:00Z' });
    await lose(d.disputeId, '2026-08-20T03:00:00Z');
    await runAll();
    const july = await reconcile('2026-07-01', '2026-07-31');
    expect(july).toMatchObject({ opening_backlog: 0, intake: 0, closing_backlog: 10000, unexplained: 0 });
    expect(amountOf(july, 'dispute_pending')).toEqual([10000]);
    // Lost: the intake takes the rest (30,000 - 10,000) off and the exception gives it back.
    const august = await reconcile('2026-08-01', '2026-08-31');
    expect(august).toMatchObject({ opening_backlog: 10000, intake: -20000, closing_backlog: 10000, unexplained: 0 });
    expect(amountOf(august, 'dispute_pending')).toEqual([20000]);
    // The exception rows over the whole span cancel out, the intake of the order is the backlog change: no gap.
    const whole = await reconcile('2026-06-01', '2026-12-31');
    expect(whole).toMatchObject({ opening_backlog: 0, intake: 10000, closing_backlog: 10000, unexplained: 0 });
    expect(amountOf(whole, 'dispute_pending')).toEqual([0]);
  });

  test('FREQ-571-AC-05: 確定の後に遅れて戻った分は受注高に戻り、例外の行は動かず、差は0のまま', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    const d = await seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30000, withdrawnAt: '2026-06-20T03:00:00Z' });
    await lose(d.disputeId, '2026-08-20T03:00:00Z');
    await runAll();
    await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: 7000, createdAt: '2026-09-15T03:00:00Z' });
    await runAll();
    const september = await reconcile('2026-09-01', '2026-09-30');
    expect(september).toMatchObject({ opening_backlog: 0, intake: 7000, closing_backlog: 7000, unexplained: 0 });
    expect(amountOf(september, 'dispute_pending')).toEqual([0]);
  });

  test('FREQ-571-AC-05: 未出荷の返金が失敗して2130へ振り替えた分は return_refund_2130 の行で説明される', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-02-10', kind: 'refund_failed', parts: [order.orderId, 'fixture-refund-1'], lines: [
      { account: '2150', debit: 5000, orderId: order.orderId }, { account: '2130', credit: 5000, orderId: order.orderId }] });
    const february = await reconcile('2026-02-01', '2026-02-28');
    expect(february).toMatchObject({ opening_backlog: 18750, intake: 0, sales_before_return: 0, closing_backlog: 13750, unexplained: 0 });
    expect(amountOf(february, 'return_refund_2130')).toEqual([-5000]);
    expect(amountOf(february, 'other')).toEqual([]);
  });

  test('FREQ-571-AC-05: 上に当たらない種類で2150を動かした仕訳は other の行に種類ごとに出る', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-02-10', kind: 'compensation_received', parts: ['fixture-other-1'], lines: [
      { account: '1160', debit: 700 }, { account: '2150', credit: 700, orderId: order.orderId }] });
    await postManualEntryFixture(db(), { entryDate: '2026-02-11', kind: 'personal_discount', parts: [order.orderId, 'fixture-other-2'], lines: [
      { account: '2150', debit: 200, orderId: order.orderId }, { account: '1160', credit: 200 }] });
    const february = await reconcile('2026-02-01', '2026-02-28');
    const others = february.exceptions.filter((row) => row.kind === 'other').map((row) => `${row.event_kind}:${row.amount}`).sort();
    expect(others).toEqual(['compensation_received:700', 'personal_discount:-200']);
    expect(february).toMatchObject({ opening_backlog: 18750, closing_backlog: 19250, unexplained: 0 });
  });

  test('FREQ-571-AC-05: 出荷の2150と4010の額が食い違うと、説明のつかない差と2段目の差が0でなく出る', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    // A shipment entry that moves 1,000 out of 2150 but books 900 of sales: the first step cannot explain 100.
    await postManualEntryFixture(db(), { entryDate: '2026-02-03', kind: 'shipment_confirmed', parts: ['SL-FIXTURE-0001'], lines: [
      { account: '2150', debit: 1000, orderId: order.orderId }, { account: '4010', credit: 900, orderId: order.orderId },
      { account: '4050', credit: 100 }] });
    const february = await reconcile('2026-02-01', '2026-02-28');
    expect(february.sales_before_return).toBe(900);
    expect(february.unexplained).toBe(-100);
    // A sales row of an order that is not a shipment: the second step shows it.
    await postManualEntryFixture(db(), { entryDate: '2026-02-05', kind: 'compensation_received', parts: ['fixture-order-sale'], lines: [
      { account: '1160', debit: 400 }, { account: '4010', credit: 400, orderId: order.orderId }] });
    expect((await reconcile('2026-02-01', '2026-02-28')).unexplained2).toBe(-400);
  });

  test('FREQ-571-AC-06: 確定した出荷済みの取り消しは振替先の勘定ごとに示し、決まるまでは1470の補助 dispute_confirmed_unassigned に出る', async () => {
    const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
    await confirmSlipAt(db(), order, { quantity: 4, shipmentDate: '2026-06-15', lockedAt: '2026-06-15T01:00:00Z' });
    await postShipments();
    const d = await seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30000, withdrawnAt: '2026-06-20T03:00:00Z' });
    await lose(d.disputeId, '2026-08-20T03:00:00Z');
    await runAll();
    expect((await reconcile('2026-08-01', '2026-08-31')).dispute_confirmed_by_account)
      .toEqual([{ account_code: '1470', sub_account: 'dispute_confirmed_unassigned', amount: 15000 }]);
    expect((await reconcile('2026-06-01', '2026-06-30')).dispute_confirmed_by_account).toEqual([]);
    const admin = await insertAccountingAdmin(db());
    await q('select public.admin_set_dispute_account_setting($1::uuid, $2, $3, null, $4::uuid)', [admin, 'fraudulent', '7530', randomUUID()]);
    await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()]);
    // The assignment moves the amount from the unassigned sub-account to the account of the setting.
    expect((await reconcile('2026-08-01', '2026-08-31')).dispute_confirmed_by_account)
      .toEqual([{ account_code: '7530', sub_account: null, amount: 15000 }]);
  });

  test('FREQ-571-AC-05: 年末に払って翌年に出荷する注文は、年末の受注残に残り翌年の売上高になる', async () => {
    const base = (await q("select (public.get_order_backlog('2026-12-31'::date) ->> 'backlog_total')::bigint as total")).rows[0].total as string;
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-12-30T03:00:00Z' });
    await confirmSlipAt(db(), order, { quantity: 1, shipmentDate: '2027-01-05', lockedAt: '2027-01-05T01:00:00Z' });
    await postShipments();
    const december = await reconcile('2026-12-01', '2026-12-31');
    expect(december).toMatchObject({ intake: 18750, sales_before_return: 0, unexplained: 0 });
    expect(december.closing_backlog - Number(base)).toBe(18750);
    const january = await reconcile('2027-01-01', '2027-01-31');
    expect(january).toMatchObject({ intake: 0, sales_before_return: 18750, closing_backlog: Number(base), unexplained: 0, unexplained2: 0 });
    expect(january.opening_backlog - Number(base)).toBe(18750);
    expect(january.booked_sales_net_orders).toBe(18750);
  });

  test('FREQ-571-AC-05: 読み口は期間の向きを確かめ、個人の情報を返さない', async () => {
    await expect(q('select public.get_intake_reconciliation($1::date, $2::date)', ['2026-02-01', '2026-01-01'])).rejects.toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
  });
});
