/** @jest-environment node */
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { seedStripeFee, seedStripePayout, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  decideRefund, recordRefundResult, saveFailureTxn, saveRefundTxn, seedCancelRefund, seedSlotPaidOrder,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 9（S23）: Stripe の残高の照合（get_stripe_balance_reconciliation）が、返金系の残高の取引を計画3の仕訳で「仕訳済み」と数える
// （FREQ-582-AC-06）。照合は見る日までの全部の取引を合わせるので、例を作る前の読みとの差で確かめる。ROLLBACK の形（--runInBand）。
jest.setTimeout(240000);

type BalanceReconciliation = {
  through: string; stripe_balance: number; ledger_1160: number; ledger_1130_stripe: number; difference: number;
  unjournaled: Array<{ kind: string; count: number; net_sum: number }>; payout_in_transit_1150: number;
};
const THROUGH = '2026-11-30';

describeLocalDb('S23 Stripe balance reconciliation: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const settle = async () => { for (let i = 0; i < 4; i += 1) await q('select private.accounting_run_posting(200)'); };
  const balanceRecon = async (through = THROUGH) =>
    (await q('select public.get_stripe_balance_reconciliation($1::date) as r', [through])).rows[0].r as BalanceReconciliation;
  const bucket = (r: BalanceReconciliation, kind: string) => r.unjournaled.find((row) => row.kind === kind) ?? { kind, count: 0, net_sum: 0 };
  /** 2つの読みの差（差額・1150・計画3で計上する種類）。 */
  const delta = (after: BalanceReconciliation, before: BalanceReconciliation) => ({
    difference: after.difference - before.difference,
    in_transit: after.payout_in_transit_1150 - before.payout_in_transit_1150,
    planned_count: bucket(after, 'planned_p3').count - bucket(before, 'planned_p3').count,
    planned_sum: bucket(after, 'planned_p3').net_sum - bucket(before, 'planned_p3').net_sum,
  });
  /** 注文 30,000円（シャツ 18,750円・パンツ 11,250円、支払いの仕訳あり）と、パンツの出荷前の返金 A（11,250円）。 */
  async function shirtPants() {
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [, pants] = o.orderItemIds;
    const a = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: pants, before: true, amount: 11250 }]);
    await settle();
    return { orderId: o.orderId, a };
  }

  test('FREQ-582-AC-06: Stripe の残高の照合で、返金系の取引の仕訳が入った後の「計画3で計上する種類」の差が0で、入る前は同じ額が planned_p3 に出る', async () => {
    const o = await shirtPants();
    const before = await balanceRecon();
    await saveRefundTxn(db(), o.a, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'succeeded');
    const unposted = await balanceRecon();
    expect(delta(unposted, before)).toEqual({ difference: -11250, in_transit: 0, planned_count: 1, planned_sum: -11250 });
    await settle();
    const posted = await balanceRecon();
    expect(delta(posted, before)).toEqual({ difference: 0, in_transit: 0, planned_count: 0, planned_sum: 0 });
    expect(posted.unjournaled.reduce((s, row) => s + row.net_sum, 0)).toBe(posted.difference);
  });

  test('FREQ-582-AC-06: 引かれた後に店が返金をやめた返金の戻りの取引は、取り消しの仕訳が入った後に planned_p3 から外れ、差が0になる', async () => {
    const o = await shirtPants();
    const before = await balanceRecon();
    await saveRefundTxn(db(), o.a, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'succeeded');
    await settle();
    await saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'canceled');
    await settle();
    // Before the shop decides, the transaction that gave the money back has no entry yet.
    expect(delta(await balanceRecon(), before)).toEqual({ difference: 11250, in_transit: 0, planned_count: 1, planned_sum: 11250 });
    await decideRefund(db(), o.a, 'abandoned');
    await settle();
    const reversed = (await q(`select count(*)::int n from public.accounting_journal_entries r join public.accounting_journal_entries e on e.id = r.reverses_entry_id
      where e.event_kind = 'pre_shipment_refund' and e.source_id = $1`, [o.a])).rows[0].n;
    expect(reversed).toBe(1);
    expect(delta(await balanceRecon(), before)).toEqual({ difference: 0, in_transit: 0, planned_count: 0, planned_sum: 0 });
  });

  test('FREQ-582-AC-06: 引かれて戻された（succeeded の行が無いまま失敗した）返金の2つの取引は、両方の日が来ると planned_p3 から外れる（P3-T6f）', async () => {
    const o = await shirtPants();
    const before = await balanceRecon();
    const beforeEarly = await balanceRecon('2026-11-06');
    await saveRefundTxn(db(), o.a, { at: '2026-11-05T03:00:00Z' });
    await saveFailureTxn(db(), o.a, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'failed');
    await settle();
    // Seen on 11-06 only the withdrawal is there: it waits in planned_p3 until the transaction that gave the money back comes.
    const early = await balanceRecon('2026-11-06');
    expect(delta(early, beforeEarly)).toEqual({ difference: -11250, in_transit: 0, planned_count: 1, planned_sum: -11250 });
    expect(delta(await balanceRecon(), before)).toEqual({ difference: 0, in_transit: 0, planned_count: 0, planned_sum: 0 });
  });

  test('FREQ-582-AC-06: order_refunds の行が無い返金の残高の取引は、手で閉じず planned_p3 に残る（計画2 Ruling P2-T4-N1-final）', async () => {
    const before = await balanceRecon();
    await seedStripeFee(db(), { createdAt: '2026-11-06T03:00:00Z', type: 'refund', reportingCategory: 'refund', amount: -2000 });
    await settle();
    expect(delta(await balanceRecon(), before)).toEqual({ difference: -2000, in_transit: 0, planned_count: 1, planned_sum: -2000 });
  });

  test('FREQ-582-AC-06: 入金途上1150は足さずに別に出る（計画2の試験が通る）', async () => {
    const o = await shirtPants();
    await saveRefundTxn(db(), o.a, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), o.a, 'succeeded');
    await settle();
    const before = await balanceRecon();
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-11-06T03:00:00Z' });
    await seedStripeFee(db(), { createdAt: '2026-11-06T03:00:00Z', type: 'payout', reportingCategory: 'payout', amount: -9640, sourceId: payout, payoutId: payout });
    await settle();
    const after = await balanceRecon();
    expect(delta(after, before)).toEqual({ difference: 0, in_transit: 9640, planned_count: 0, planned_sum: 0 });
    expect(after.difference).toBe(after.stripe_balance - (after.ledger_1160 + after.ledger_1130_stripe));
    const admin = await insertAccountingAdmin(db());
    await q(`update public.stripe_payouts set bank_arrival_date = '2026-11-09', bank_confirmed_at = now(), bank_confirmed_by = $1 where id = $2`, [admin, payout]);
    await q('select private.accounting_post_stripe_bank_events(50)');
    expect(delta(await balanceRecon(), before)).toEqual({ difference: 0, in_transit: 0, planned_count: 0, planned_sum: 0 });
  });
});
