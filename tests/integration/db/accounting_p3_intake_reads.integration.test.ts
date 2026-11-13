/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { postManualEntryFixture, seedPostedPayment, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  backdateSlipFacts, bankTransfer, decideRefund, DISPUTE_DAYS, postOrderPayment, postShipments, receiveReturn, recordRefundResult,
  saveFailureTxn, saveRefundTxn, seedCancelEvent, seedCancelRefund, seedDisputeFlow, seedReturnFlow, seedSlotPaidOrder, setRequestedAt,
  shipAndPost, shipUnits, type ReturnFlow,
} from './helpers/accounting-returns-fixtures';
import { hRefundFixture } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createUbReturn } from './helpers/unit-binding-receive';

// 計画3 Task 9（S23）: 受注高（accounting_intake_events）と2段の照らし合わせ（get_intake_reconciliation）と内訳（get_intake_breakdown）が
// 計画3の返金・返品の仕訳を数える（FREQ-582 AC-01〜AC-05・AC-07・AC-08）。ROLLBACK の形（--runInBand）。
// 11月の例は、読み口が全部の注文を合わせるので、例を作る前の読みとの差で確かめる（説明のつかない差はその差が0）。
// 設計 8-3 の例（1月〜3月）は計画2の試験と同じく、その月にほかの仕訳が無い前提でそのままの値で確かめる。
jest.setTimeout(240000);

type Exception = { kind: string; label_key: string; amount: number; event_kind?: string };
type Reconciliation = {
  opening_backlog: number; intake: number; sales_before_return: number; closing_backlog: number; exceptions: Exception[]; unexplained: number;
  returns: number; booked_sales_net_orders: number; return_fee_revenue_4050: number; other_4010: number; other_4020: number; book_sales_total: number;
  unexplained2: number; dispute_confirmed_by_account: Array<{ account_code: string; sub_account: string | null; amount: number }>;
};
type Breakdown = Record<string, number | boolean>;
const NUMBERS = ['opening_backlog', 'intake', 'sales_before_return', 'closing_backlog', 'unexplained', 'returns', 'booked_sales_net_orders',
  'return_fee_revenue_4050', 'other_4010', 'other_4020', 'book_sales_total', 'unexplained2'] as const;
const FROM = '2026-11-01';
const TO = '2026-12-31';

describeLocalDb('S23 intake reads: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  /** 計上係の入口を何度か流す（待っていた物が次の回に入る）。 */
  const settle = async () => { for (let i = 0; i < 4; i += 1) await q('select private.accounting_run_posting(200)'); };
  const reconcile = async (from = FROM, to = TO) =>
    (await q('select public.get_intake_reconciliation($1::date, $2::date) as r', [from, to])).rows[0].r as Reconciliation;
  const breakdown = async (from = FROM, to = TO) =>
    (await q('select public.get_intake_breakdown($1::date, $2::date) as r', [from, to])).rows[0].r as Breakdown;
  const exception = (r: Reconciliation, kind: string) => r.exceptions.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount, 0);
  /** 2つの読みの差（数の欄と、例外の行の種類ごとの合計）。 */
  const delta = (after: Reconciliation, before: Reconciliation) => ({
    ...Object.fromEntries(NUMBERS.map((k) => [k, after[k] - before[k]])),
    dispute_pending: exception(after, 'dispute_pending') - exception(before, 'dispute_pending'),
    return_refund_2130: exception(after, 'return_refund_2130') - exception(before, 'return_refund_2130'),
    other: exception(after, 'other') - exception(before, 'other'),
  });
  /** 注文の受注高の出来事（支払い以外）の [日, 額]。 */
  const intakeOf = async (orderId: string, from = '2026-01-01', to = TO) =>
    ((await q('select public.list_order_intake_events($1::date, $2::date, 5000) as r', [from, to])).rows[0].r as {
      events: Array<{ order_id: string; event_date: string; kind: string; amount: number }> }).events
      .filter((e) => e.order_id === orderId && e.kind !== 'payment').map((e) => [e.event_date, e.kind === 'pre_shipment_cancel' ? e.amount : `${e.kind}:${e.amount}`]);
  /** 注文 30,000円（シャツ 18,750円・パンツ 11,250円、支払いの仕訳あり）と、パンツの出荷前の返金 A（11,250円）。 */
  async function shirtPants() {
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt, pants] = o.orderItemIds;
    const a = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: pants, before: true, amount: 11250 }]);
    return { orderId: o.orderId, shirt, pants, a };
  }
  const succeed = async (refundId: string, at = '2026-11-05T03:00:00Z') => {
    await saveRefundTxn(db(), refundId, { at });
    await recordRefundResult(db(), refundId, 'succeeded');
  };
  const bank = async (orderId: string, amount: number, on = '2026-11-12') => {
    const actor = await insertAccountingAdmin(db());
    await bankTransfer(db(), { actor, orderId, origin: 'pre_shipment', amount, on, txn: `S23-${randomUUID().slice(0, 8)}` });
  };

  // ---- design 8-3 with the plan-3 entries -------------------------------------------------------------------------------------
  /** 設計 8-3: 1/20 に支払い、2/3 に出荷、3/10 に返品（18,750円の1着、手数料の割合10%）が届き、3/12 に返金16,875。 */
  async function seedExample(): Promise<ReturnFlow> {
    const f = await hRefundFixture(db(), false, 2, 1250);
    const shipped = await shipUnits(db(), f.orderId, f.itemId, 2, f.actor);
    const fx = { ...f, fulfillment: { fulfillment_id: shipped.fulfillmentId } } as unknown as ReturnFlow['f'];
    const ret = await createUbReturn(db(), fx, [{ quantity: 1 }], { percent: 10 });
    const flow: ReturnFlow = { f: fx, returnId: ret.returnId, lineIds: ret.lineIds };
    await postOrderPayment(db(), f.orderId, '2026-01-20T03:00:00Z');
    // The G shipping tool ships today; the example ships on 2/3 (the slip and the fulfillment carry the day, the fact the time).
    // The guards of the two tables are ordinary (origin) triggers, so the replica role skips them for these two updates only.
    await q('set local session_replication_role = replica');
    await q("update public.order_fulfillments set shipment_date = '2026-02-03' where order_id = $1", [f.orderId]);
    await q(`update public.shipment_slips s set shipment_date = '2026-02-03' where exists (select 1 from public.shipment_slip_fulfillments sf
      where sf.slip_id = s.id and sf.order_id = $1)`, [f.orderId]);
    await q('set local session_replication_role = origin');
    await backdateSlipFacts(db(), f.orderId, '2026-02-03T01:00:00Z');
    await postShipments(db());
    await setRequestedAt(db(), flow.returnId, '2026-03-05T03:00:00Z');
    const r = await receiveReturn(db(), flow, { choice: 'now', arrivedOn: '2026-03-10',
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' }] });
    if (!r.refund_id || r.refund_amount !== 16875) throw new Error(`S23_EXAMPLE_REFUND ${JSON.stringify(r)}`);
    await settle();
    await succeed(r.refund_id, '2026-03-12T03:00:00Z');
    await settle();
    return flow;
  }

  test('FREQ-582-AC-05: 1月から3月まで、期首の受注残＋受注高−売上高（返品の前）＝期末の受注残が合い、説明のつかない差は0', async () => {
    await seedExample();
    const months = [['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31']];
    const results = [];
    for (const [from, to] of months) results.push(await reconcile(from, to));
    const [january, february, march] = results;
    expect(january.intake).toBeGreaterThan(0);
    expect(january).toMatchObject({ opening_backlog: 0, sales_before_return: 0, closing_backlog: january.intake, unexplained: 0 });
    expect(february).toMatchObject({ opening_backlog: january.intake, intake: 0, sales_before_return: january.intake, closing_backlog: 0, unexplained: 0 });
    expect(march).toMatchObject({ opening_backlog: 0, intake: 0, sales_before_return: 0, closing_backlog: 0, unexplained: 0 });
    for (const result of results) {
      expect(result.exceptions.every((row) => row.amount === 0)).toBe(true);
      expect(result.opening_backlog + result.intake - result.sales_before_return).toBe(result.closing_backlog);
    }
  });

  test('FREQ-582-AC-05: 3月の売上高（返品の前）0−返品18,750＝帳簿の売上高−18,750、返品の手数料の売上1,875は別の行', async () => {
    await seedExample();
    expect(await reconcile('2026-03-01', '2026-03-31')).toMatchObject({ sales_before_return: 0, returns: 18750, booked_sales_net_orders: -18750,
      return_fee_revenue_4050: 1875, other_4010: 0, other_4020: 0, book_sales_total: -18750, unexplained: 0, unexplained2: 0 });
  });

  // ---- AC-01..AC-03: the pre-shipment refunds ---------------------------------------------------------------------------------
  test('FREQ-582-AC-01: 出荷前の返金は返金の残高の取引の日の月の受注高から引かれる', async () => {
    const o = await shirtPants();
    const before = await reconcile();
    const breakdownBefore = await breakdown();
    await succeed(o.a, '2026-11-05T03:00:00Z');
    await settle();
    expect(await intakeOf(o.orderId)).toEqual([['2026-11-05', -11250]]);
    expect(await intakeOf(o.orderId, '2026-12-01', '2026-12-31')).toEqual([]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: -11250, closing_backlog: -11250, return_refund_2130: 0, other: 0, unexplained: 0 });
    const after = await breakdown();
    expect([(after.pre_shipment_cancel as number) - (breakdownBefore.pre_shipment_cancel as number), after.breakdown_ok]).toEqual([-11250, true]);
  });

  test('FREQ-582-AC-02: 引かれる前に失敗して借りにした出荷前の返金は、立てた日の受注高から引かれず、例外の行 return_refund_2130 で説明され、説明のつかない差は0', async () => {
    const o = await shirtPants();
    const before = await reconcile();
    await recordRefundResult(db(), o.a, 'failed');
    await settle();
    expect(await intakeOf(o.orderId)).toEqual([]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: 0, closing_backlog: -11250, return_refund_2130: -11250, other: 0, unexplained: 0 });
  });

  test('FREQ-582-AC-02: その借りを振込で返した日に受注高から引かれ、例外の行が戻って差は0', async () => {
    const o = await shirtPants();
    const before = await reconcile();
    await recordRefundResult(db(), o.a, 'failed');
    await settle();
    expect(delta(await reconcile(), before)).toMatchObject({ intake: 0, return_refund_2130: -11250, unexplained: 0 });
    await bank(o.orderId, 11250, '2026-11-12');
    expect(await intakeOf(o.orderId)).toEqual([['2026-11-12', -11250]]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: -11250, closing_backlog: -11250, return_refund_2130: 0, other: 0, unexplained: 0 });
    // Between the failure and the transfer the exception row holds the debt; the transfer gives it back.
    expect(await intakeOf(o.orderId, '2026-11-12', '2026-11-12')).toEqual([['2026-11-12', -11250]]);
  });

  test('FREQ-582-AC-02: 引かれた後に失敗した出荷前の返金は、成功の日に引かれ、戻りの日に足し戻され、振込で返した日に引かれる（二重に引かない）', async () => {
    const o = await shirtPants();
    const before = await reconcile();
    await succeed(o.a, '2026-11-05T03:00:00Z');
    await saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'failed');
    await settle();
    await bank(o.orderId, 11250, '2026-11-12');
    expect(await intakeOf(o.orderId)).toEqual([['2026-11-05', -11250], ['2026-11-07', 11250], ['2026-11-12', -11250]]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: -11250, closing_backlog: -11250, return_refund_2130: 0, other: 0, unexplained: 0 });
  });

  test('FREQ-582-AC-03: 店が返金をやめた取り消しは、戻りの取引の日に足し戻る', async () => {
    const o = await shirtPants();
    const before = await reconcile();
    await succeed(o.a, '2026-11-05T03:00:00Z');
    await saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'canceled');
    await settle();
    await decideRefund(db(), o.a, 'abandoned');
    await settle();
    expect(await intakeOf(o.orderId)).toEqual([['2026-11-05', -11250], ['2026-11-07', 11250]]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: 0, closing_backlog: 0, return_refund_2130: 0, other: 0, unexplained: 0 });
  });

  // ---- AC-04: a refund of shipped and unshipped units ---------------------------------------------------------------------------
  test('FREQ-582-AC-04: 出荷前と出荷後が混ざった返金は、出荷前の分だけが受注高から引かれ、出荷後の分は返品の行になる', async () => {
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt, pants] = o.orderItemIds;
    await shipAndPost(db(), o.orderId, shirt);
    const before = await reconcile();
    const breakdownBefore = await breakdown();
    const refundId = await seedCancelRefund(db(), o.orderId, null, 13250,
      [{ item: pants, before: true, amount: 11250 }, { item: shirt, before: false, amount: 2000 }]);
    await succeed(refundId, '2026-11-08T03:00:00Z');
    await settle();
    expect(await intakeOf(o.orderId)).toEqual([['2026-11-08', -11250]]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: -11250, sales_before_return: 0, returns: 2000, booked_sales_net_orders: -2000,
      return_refund_2130: 0, other: 0, unexplained: 0, unexplained2: 0 });
    const after = await breakdown();
    expect([(after.pre_shipment_cancel as number) - (breakdownBefore.pre_shipment_cancel as number),
      (after.post_shipment_refund as number) - (breakdownBefore.post_shipment_refund as number), after.breakdown_ok]).toEqual([-11250, -2000, true]);
  });

  test('FREQ-582-AC-04: 品を決めない額は、出荷した分とまだの分の値打ちの比で分かれ、出荷前の分だけが受注高から引かれ、出荷後の分が返品の額になる', async () => {
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt] = o.orderItemIds;
    await shipAndPost(db(), o.orderId, shirt);
    const before = await reconcile();
    // 3,000円の品を決めない返金: まだの分 11,250 と出荷した分 18,750 の比（3:5）で P 1,125・Q 1,875。
    const refundId = await seedCancelRefund(db(), o.orderId, null, 3000);
    const fact = (await q('select pre_shipment_amount::int p, post_shipment_amount::int q from public.accounting_refund_facts where refund_id=$1', [refundId])).rows[0];
    expect(fact).toEqual({ p: 1125, q: 1875 });
    await succeed(refundId, '2026-11-08T03:00:00Z');
    await settle();
    expect(await intakeOf(o.orderId)).toEqual([['2026-11-08', -1125]]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: -1125, returns: 1875, unexplained: 0, unexplained2: 0 });
  });

  // ---- AC-07: the price correction d of rule 3-2 --------------------------------------------------------------------------------
  /** 9,999円（u0）と10,001円の2着。cheapShipped なら u0 を先に送り、10,001円の着を返す出来事（残る u0 の直し d = +2、返す額 9,999円）と返金。 */
  async function dPair(cheapShipped: boolean) {
    const o = await seedSlotPaidOrder(db(), [[9999], [10001]]);
    const [cheap, dear] = o.orderItemIds;
    if (cheapShipped) await shipAndPost(db(), o.orderId, cheap);
    const eventId = await seedCancelEvent(db(), o.orderId, [{ item: dear, unit: 0, kind: 'returned', allocation: 10001 },
      { item: cheap, unit: 0, kind: 'kept', correction: 2, shipped: cheapShipped }], 9999);
    const refundId = await seedCancelRefund(db(), o.orderId, eventId, 9999);
    return { ...o, cheap, dear, refundId };
  }

  test('FREQ-582-AC-07: d≠0 の移しがある月（9,999円と10,001円の2着、u0 を出荷した後に残りを発送前に取り消して d=+2）も、1段目・2段目とも説明のつかない差が0で、受注高は d を引かない（10,001円）。まだ送っていない残る着の値段の直しが出荷の仕訳に入る月も同じ', async () => {
    for (const cheapShipped of [true, false]) {
      await q('savepoint s23_d');
      const before = await reconcile();
      const e = await dPair(cheapShipped);
      await succeed(e.refundId, '2026-11-05T03:00:00Z');
      await settle();
      if (!cheapShipped) await shipAndPost(db(), e.orderId, e.cheap);
      await settle();
      expect([cheapShipped, await intakeOf(e.orderId)]).toEqual([cheapShipped, [['2026-11-05', -9999]]]);
      expect([cheapShipped, delta(await reconcile(), before)]).toEqual([cheapShipped, expect.objectContaining({ intake: 10001, sales_before_return: 10001,
        closing_backlog: 0, returns: 0, booked_sales_net_orders: 10001, return_refund_2130: 0, other: 0, unexplained: 0, unexplained2: 0 })]);
      await q('rollback to savepoint s23_d');
    }
  });

  test('FREQ-582-AC-07: 引かれる前に失敗して借りにした出荷前の返金に d がある時も、立てた日の受注高は0のままで、売上の寄せの d が sales_before_return に入る', async () => {
    const before = await reconcile();
    const e = await dPair(true);
    await recordRefundResult(db(), e.refundId, 'failed');
    await settle();
    expect(await intakeOf(e.orderId)).toEqual([]);
    expect(delta(await reconcile(), before)).toMatchObject({ intake: 20000, sales_before_return: 10001, closing_backlog: 0, return_refund_2130: -9999,
      other: 0, unexplained: 0, unexplained2: 0 });
  });

  // ---- AC-08: a return closed at 0 yen ------------------------------------------------------------------------------------------
  test('FREQ-582-AC-08: 返金を0円で終えた返品（G=18,750・F=1,875）の月も、2段の照らし合わせの説明のつかない差が0で、4020の返品の行も0に戻る', async () => {
    const before = await reconcile();
    const flow = await seedReturnFlow(db());
    await receiveReturn(db(), flow, { choice: 'now', amount: 0,
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' }] });
    await settle();
    const lines = (await q(`select e.event_kind, l.account_code, l.debit::int d, l.credit::int c from public.accounting_journal_lines l
      join public.accounting_journal_entries e on e.id = l.entry_id where l.order_id = $1 and l.account_code in ('4020','4050') order by e.entry_no, l.line_no`,
    [flow.f.orderId])).rows;
    expect(lines).toEqual([{ event_kind: 'return_arrived', account_code: '4020', d: 18750, c: 0 }, { event_kind: 'return_arrived', account_code: '4050', d: 0, c: 1875 },
      { event_kind: 'return_amount_decided', account_code: '4050', d: 1875, c: 0 }, { event_kind: 'return_amount_decided', account_code: '4020', d: 0, c: 18750 }]);
    expect(delta(await reconcile(), before)).toMatchObject({ returns: 0, return_fee_revenue_4050: 0, return_refund_2130: 0, other: 0,
      unexplained: 0, unexplained2: 0 });
  });

  // ---- the second stage: the debit accounts of the confirmed dispute ------------------------------------------------------------
  test('FREQ-582-AC-05: 2段目の dispute_confirmed_by_account に、確定の仕訳の借方が勘定ごと（2130 の返品の返金待ち・1470 の dispute_refund_overlap_review を含む）に出る', async () => {
    const byAccount = async () => new Map((await reconcile()).dispute_confirmed_by_account.map((r) => [`${r.account_code}:${r.sub_account ?? ''}`, r.amount]));
    const before = await byAccount();
    const d = await seedDisputeFlow(db());
    await receiveReturn(db(), d.flow, { choice: 'consult', arrivedOn: DISPUTE_DAYS.arrival,
      units: [{ return_line_id: d.flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    await settle();
    await bankTransfer(db(), { actor: d.admin, orderId: d.orderId, origin: 'return', amount: 10000, on: DISPUTE_DAYS.bank, txn: `S23-${randomUUID().slice(0, 8)}` });
    await d.withdraw();
    await d.lose();
    await settle();
    const after = await byAccount();
    const moved = [...new Set([...before.keys(), ...after.keys()])].map((k) => [k, (after.get(k) ?? 0) - (before.get(k) ?? 0)]).filter(([, n]) => n !== 0).sort();
    expect(moved).toEqual([['1470:dispute_refund_overlap_review', 10000], ['2130:return_refund', 6875], ['7530:', 13125]]);
  });

  // ---- plan 2 ---------------------------------------------------------------------------------------------------------------------
  test('FREQ-571-AC-05: 計画2の受注高・照合の試験が無改造で通る', async () => {
    // The plan-2 suites stay as they are; this replays their 2130 fixture (a refund_failed entry with a 2130 line without a sub
    // account) through the rebuilt readers and gets the plan-2 figures.
    for (const name of ['accounting_p2_intake_reconciliation', 'accounting_p2_intake_reads']) {
      expect(fs.existsSync(path.join(process.cwd(), `tests/integration/db/${name}.integration.test.ts`))).toBe(true);
    }
    const order = await seedPostedPayment(db(), { lines: [{ price: 18750, quantity: 1 }], createdAt: '2026-01-20T03:00:00Z' });
    await postManualEntryFixture(db(), { entryDate: '2026-02-10', kind: 'refund_failed', parts: [order.orderId, 'fixture-refund-1'], lines: [
      { account: '2150', debit: 5000, orderId: order.orderId }, { account: '2130', credit: 5000, orderId: order.orderId }] });
    const february = await reconcile('2026-02-01', '2026-02-28');
    expect(february).toMatchObject({ opening_backlog: 18750, intake: 0, sales_before_return: 0, closing_backlog: 13750, unexplained: 0 });
    expect(february.exceptions.filter((e) => e.kind === 'return_refund_2130').map((e) => e.amount)).toEqual([-5000]);
    expect(february.exceptions.filter((e) => e.kind === 'other')).toEqual([]);
    expect(await intakeOf(order.orderId)).toEqual([]);
  });
});
