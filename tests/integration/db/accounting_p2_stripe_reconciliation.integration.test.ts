/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { accountingFailure, insertAccountingAdmin, insertAccountingPeriod, postJournal } from './helpers/accounting-fixtures';
import { seedStripeFee, seedStripePayout, setCutoverForTest } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 4 (FREQ-566): the fee reconciliation (Japan month, UTC month, invoice) and the balance
// reconciliation (Stripe balance against 1160 + 1130 of Stripe), and the invoice record writer. ROLLBACK form (run with
// --runInBand): setCutoverForTest holds the settings table until the rollback.
jest.setTimeout(120000);

type Boundary = { txn_id: string; jst_date: string; utc_date: string; fee: number };
type FeeReconciliation = {
  jst_total: number; utc_total: number; invoice_total: number | null; boundary_in: Boundary[]; boundary_out: Boundary[];
  next_month_adjustments: Array<{ txn_id: string; jst_date: string; amount: number }>; diff_jst_utc: number;
  explained_boundary: number; unexplained_jst_utc: number; diff_utc_invoice: number | null; explained_adjustments: number | null;
  unexplained_utc_invoice: number | null; journal_vs_txn_diff: number;
};
type BalanceReconciliation = {
  through: string; stripe_balance: number; ledger_1160: number; ledger_1130_stripe: number; difference: number;
  unjournaled: Array<{ kind: string; count: number; net_sum: number }>; payout_in_transit_1150: number;
};

describeLocalDb('S9 Stripe reconciliation: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => { await q('begin'); await setCutoverForTest(db(), '2026-01-01'); });
  afterEach(async () => { await q('rollback'); });

  const runAll = async () => (await q('select private.accounting_post_stripe_events(200) as r')).rows[0].r as Record<string, number>;
  const feeRecon = async (month: string): Promise<FeeReconciliation> =>
    (await q('select public.get_stripe_fee_reconciliation($1::text) as r', [month])).rows[0].r;
  const balanceRecon = async (through: string): Promise<BalanceReconciliation> =>
    (await q('select public.get_stripe_balance_reconciliation($1::date) as r', [through])).rows[0].r;
  const fee = (createdAt: string, amount: number, feeAmount: number, type = 'charge', category = 'charge') =>
    seedStripeFee(db(), { createdAt, type, reportingCategory: category, amount, fee: feeAmount,
      paymentIntentId: type === 'charge' ? `pi_${randomUUID().replaceAll('-', '')}` : null });
  const setInvoice = (admin: string, month: string, total: number, tax: number, ref: string | null, expected: string | null, key = randomUUID()) =>
    q('select public.admin_set_stripe_invoice_record($1::uuid, $2::text, $3::bigint, $4::bigint, $5::text, $6::bigint, $7::uuid) as r',
      [admin, month, total, tax, ref, expected, key]);

  /** June 2026 with fees on both sides of the Japan / UTC month edge. */
  async function seedJune() {
    const inside = await fee('2026-06-15T03:00:00Z', 10000, 100);
    // 2026-06-01 00:30 in Japan is 2026-05-31 15:30 UTC.
    const boundaryIn = await fee('2026-05-31T15:30:00Z', 10000, 200);
    // 2026-07-01 08:00 in Japan is 2026-06-30 23:00 UTC.
    const boundaryOut = await fee('2026-06-30T23:00:00Z', 10000, 400);
    const july = await fee('2026-07-01T03:00:00Z', 10000, 800);
    // A stand-alone fee: fee = 0, the cost is -net.
    const standalone = await fee('2026-06-20T03:00:00Z', -50, 0, 'stripe_fee', 'fee');
    return { inside, boundaryIn, boundaryOut, july, standalone };
  }

  test('FREQ-566-AC-01: 日本時間の月と UTC の月の差は、月初0〜9時の取引と、次の月の月初0〜9時の取引の両方で説明され、説明のつかない差は0', async () => {
    const t = await seedJune();
    const result = await feeRecon('2026-06');
    // Japan June: 100 + 200 + 50 (the stand-alone fee counts as -net); UTC June: 100 + 400 + 50.
    expect(result.jst_total).toBe(350);
    expect(result.utc_total).toBe(550);
    expect(result.diff_jst_utc).toBe(-200);
    expect(result.boundary_in).toEqual([{ txn_id: t.boundaryIn, jst_date: '2026-06-01', utc_date: '2026-05-31', fee: 200 }]);
    expect(result.boundary_out).toEqual([{ txn_id: t.boundaryOut, jst_date: '2026-07-01', utc_date: '2026-06-30', fee: 400 }]);
    expect(result.explained_boundary).toBe(-200);
    expect(result.unexplained_jst_utc).toBe(0);
  });

  test('FREQ-566-AC-01: 単独の手数料（fee=0）は-netで日本時間の月の合計にも UTC の月の合計にも、境の一覧にも同じ符号で入る', async () => {
    // 2026-06-01 00:10 in Japan: JST June, UTC May. net = -70, fee = 0.
    const edge = await fee('2026-05-31T15:10:00Z', -70, 0, 'stripe_fx_fee', 'fee');
    const result = await feeRecon('2026-06');
    expect(result.jst_total).toBe(70);
    expect(result.utc_total).toBe(0);
    expect(result.boundary_in).toEqual([{ txn_id: edge, jst_date: '2026-06-01', utc_date: '2026-05-31', fee: 70 }]);
    expect(result.unexplained_jst_utc).toBe(0);
    // A returned stand-alone fee (net > 0) counts as a negative fee.
    await fee('2026-06-10T03:00:00Z', 20, 0, 'stripe_fee', 'fee');
    expect((await feeRecon('2026-06')).jst_total).toBe(50);
  });

  test('FREQ-566-AC-01: 種類を知らない取引と、手数料のない取引と、税額調整は手数料の合計に入らない', async () => {
    await fee('2026-06-10T03:00:00Z', 10000, 0);
    await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'future_fee', reportingCategory: 'fee', amount: -999 });
    await seedStripeFee(db(), { createdAt: '2026-06-10T04:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    const result = await feeRecon('2026-06');
    expect(result.jst_total).toBe(0);
    expect(result.utc_total).toBe(0);
  });

  test('FREQ-566-AC-02: UTCの月と請求書の差は翌月の税額調整で説明され、残りが説明のつかない差として出る', async () => {
    await seedJune();
    const admin = await insertAccountingAdmin(db());
    const adjustment = await seedStripeFee(db(), { createdAt: '2026-07-05T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -30 });
    await seedStripeFee(db(), { createdAt: '2026-08-05T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -999 });
    // The invoice is the UTC-month total plus the cost of the adjustment that moved the balance: 550 + 30 = 580 explains it all.
    // (The sign awaits confirmation against a real invoice, plan 2 Task 16 step 4.)
    await setInvoice(admin, '2026-06', 580, 53, 'INV-2026-06', null);
    const result = await feeRecon('2026-06');
    expect(result.invoice_total).toBe(580);
    expect(result.utc_total).toBe(550);
    expect(result.diff_utc_invoice).toBe(-30);
    // The adjustment of the next month moves the balance by -net = 30 of cost.
    expect(result.next_month_adjustments).toEqual([{ txn_id: adjustment, jst_date: '2026-07-05', amount: 30 }]);
    expect(result.explained_adjustments).toBe(30);
    expect(result.unexplained_utc_invoice).toBe(0);
    // An invoice of 600 leaves 20 that nothing explains (the invoice is higher than the books by more than the adjustment).
    await setInvoice(admin, '2026-06', 600, 53, 'INV-2026-06', '1');
    expect((await feeRecon('2026-06')).unexplained_utc_invoice).toBe(-20);
    // A returned adjustment (net > 0) is a negative cost.
    await seedStripeFee(db(), { createdAt: '2026-07-06T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: 10 });
    const after = await feeRecon('2026-06');
    expect(after.explained_adjustments).toBe(20);
    expect(after.unexplained_utc_invoice).toBe(-30);
  });

  test('FREQ-566-AC-02: 請求書の記録が無い月は2段目を出さない', async () => {
    await seedJune();
    await seedStripeFee(db(), { createdAt: '2026-07-05T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -30 });
    const result = await feeRecon('2026-06');
    expect(result.invoice_total).toBeNull();
    expect(result.diff_utc_invoice).toBeNull();
    expect(result.explained_adjustments).toBeNull();
    expect(result.unexplained_utc_invoice).toBeNull();
    // The first step does not need the invoice.
    expect(result.unexplained_jst_utc).toBe(0);
    expect(result.next_month_adjustments).toHaveLength(1);
  });

  test('FREQ-566-AC-02: 保存した仕訳との差は別の行に出し、説明のつかない差に混ぜない', async () => {
    await seedJune();
    await runAll();
    expect((await feeRecon('2026-06')).journal_vs_txn_diff).toBe(0);
    // A fee that is not in the books yet (not posted): the difference shows in its own row only.
    await fee('2026-06-25T03:00:00Z', 10000, 90);
    const result = await feeRecon('2026-06');
    expect(result.jst_total).toBe(440);
    expect(result.journal_vs_txn_diff).toBe(90);
    expect(result.unexplained_jst_utc).toBe(0);
  });

  test('FREQ-566-AC-02: 取り消した手数料の仕訳は保存した仕訳の合計から外れ、差が別の行に出る', async () => {
    const t = await seedJune();
    await runAll();
    expect((await feeRecon('2026-06')).journal_vs_txn_diff).toBe(0);
    const entry = (await q('select id from public.accounting_journal_entries where dedupe_key = $1', [`stripe:fee:${t.inside}`])).rows[0].id as string;
    const admin = await insertAccountingAdmin(db());
    await q("select public.admin_reverse_accounting_journal($1::uuid, $2::uuid, 'test reversal', null)", [admin, entry]);
    const result = await feeRecon('2026-06');
    // The fee of 100 is no longer on the books; the transactions did not change.
    expect(result.jst_total).toBe(350);
    expect(result.journal_vs_txn_diff).toBe(100);
    expect(result.unexplained_jst_utc).toBe(0);
  });

  test('FREQ-566-AC-02: 月の指定が正しくなければ断る', async () => {
    for (const month of ['2026-6', '2026-13', '2026-00', 'June', '']) {
      expect(await accountingFailure(db(), () => feeRecon(month))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    }
  });

  test('FREQ-566-AC-02: 請求書の記録は版が違えばVERSION_CONFLICTで、同じ要求番号の再送は前の結果', async () => {
    const admin = await insertAccountingAdmin(db());
    const key = randomUUID();
    const created = (await setInvoice(admin, '2026-06', 500, 45, 'INV-1', null, key)).rows[0].r;
    expect(created).toMatchObject({ invoice_month: '2026-06', invoice_total: 500, invoice_tax: 45, document_ref: 'INV-1', version: '1' });
    // The same key with the same content: the first result, no new version.
    expect((await setInvoice(admin, '2026-06', 500, 45, 'INV-1', null, key)).rows[0].r).toEqual(created);
    // The same key with other content is refused.
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', 600, 45, 'INV-1', null, key))).toMatchObject({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    // A new record for a month that has one needs the version.
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', 600, 55, null, null))).toMatchObject({ code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' });
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', 600, 55, null, '7'))).toMatchObject({ code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' });
    // A change for a month without a record is also a conflict.
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-05', 600, 55, null, '1'))).toMatchObject({ code: '40001', message: 'ACCOUNTING_VERSION_CONFLICT' });
    const changed = (await setInvoice(admin, '2026-06', 600, 55, null, '1')).rows[0].r;
    expect(changed).toMatchObject({ invoice_total: 600, invoice_tax: 55, document_ref: null, version: '2' });
    const row = (await q('select invoice_total::text as t, version::text as v, entered_by from public.accounting_stripe_invoice_records where invoice_month = $1', ['2026-06'])).rows[0];
    expect(row).toEqual({ t: '600', v: '2', entered_by: admin });
    expect(Number((await q('select count(*) as n from public.accounting_stripe_invoice_records')).rows[0].n)).toBe(1);
  });

  test('FREQ-566-AC-02: 請求書の記録は権限が無ければ42501で、月・額・参照の文字列が正しくなければ断る', async () => {
    const stranger = randomUUID();
    await q("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [stranger]);
    expect(await accountingFailure(db(), () => setInvoice(stranger, '2026-06', 500, 45, null, null))).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    const admin = await insertAccountingAdmin(db());
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-13', 500, 45, null, null))).toMatchObject(invalid);
    expect(await accountingFailure(db(), () => setInvoice(admin, '202606', 500, 45, null, null))).toMatchObject(invalid);
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', -1, 0, null, null))).toMatchObject(invalid);
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', 500, -1, null, null))).toMatchObject(invalid);
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', 500, 45, 'x'.repeat(201), null))).toMatchObject(invalid);
    expect(await accountingFailure(db(), () => q('select public.admin_set_stripe_invoice_record($1::uuid, $2::text, 500, 0, null, null, null)', [admin, '2026-06']))).toMatchObject(invalid);
    expect(await accountingFailure(db(), () => setInvoice(admin, '2026-06', 500, 45, 'x'.repeat(200), null))).toBeNull();
  });

  // ---- balance reconciliation -----------------------------------------------------------------------------------------
  /** Journaled and not-journaled transactions of every kind, June 2026. Returns the sums the test expects. */
  async function seedBalance() {
    const period = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    // S1: a sale whose payment entry exists; its fee goes in below.
    const s1 = await fee('2026-06-10T03:00:00Z', 10000, 360);
    const s1Pi = (await q('select payment_intent_id as pi from public.stripe_balance_transactions where id = $1', [s1])).rows[0].pi as string;
    await postJournal(db(), { periodId: period, entryDate: '2026-06-10', kind: 'payment_confirmed', parts: [s1Pi],
      lines: [{ account: '1160', debit: 10000 }, { account: '2150', credit: 10000 }] });
    // S2: a sale without a payment entry.
    await fee('2026-06-11T03:00:00Z', 4000, 144);
    // A refund (planned for plan 3) and an unknown kind.
    await seedStripeFee(db(), { createdAt: '2026-06-12T03:00:00Z', type: 'refund', reportingCategory: 'refund', amount: -2000 });
    await seedStripeFee(db(), { createdAt: '2026-06-12T04:00:00Z', type: 'future_fee', reportingCategory: 'fee', amount: -700 });
    // PO1: a payout that is posted. PO2: a payout that is not (mismatch).
    const po1 = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-13T03:00:00Z' });
    await seedStripeFee(db(), { createdAt: '2026-06-13T03:00:00Z', type: 'payout', reportingCategory: 'payout', amount: -9640, sourceId: po1, payoutId: po1 });
    const po2 = await seedStripePayout(db(), { amount: 5000, paidAt: '2026-06-14T03:00:00Z', reconciliationStatus: 'mismatch' });
    await seedStripeFee(db(), { createdAt: '2026-06-14T03:00:00Z', type: 'payout', reportingCategory: 'payout', amount: -5000, sourceId: po2, payoutId: po2 });
    // A top-up Stripe knows and the books do not.
    await seedStripeFee(db(), { createdAt: '2026-06-15T03:00:00Z', type: 'topup', reportingCategory: 'topup', amount: 50000 });
    await runAll();
    // A sale and its fee that were not posted before the check.
    await fee('2026-06-16T03:00:00Z', 3000, 90);
    return { period };
  }
  const bucket = (result: BalanceReconciliation, kind: string) => result.unjournaled.find((row) => row.kind === kind);

  test('FREQ-566-AC-03: Stripeの残高と台帳の差は、仕訳になっていない取引の合計（計画3で計上する種類・計上待ち・未知の種類）と一致する', async () => {
    await seedBalance();
    const result = await balanceRecon('2026-06-30');
    expect(result.through).toBe('2026-06-30');
    // S1 9640 + S2 3856 + S3 2910 - 2000 - 700 - 9640 - 5000 + 50000
    expect(result.stripe_balance).toBe(49066);
    // +10000 payment, -360 -144 fees, -9640 payout 1
    expect(result.ledger_1160).toBe(-144);
    expect(result.ledger_1130_stripe).toBe(0);
    expect(result.difference).toBe(49210);
    expect(result.unjournaled).toEqual([
      { kind: 'planned_p3', count: 1, net_sum: -2000 },
      // S2 principal 4000 + the unposted sale 3000 and its fee -90
      { kind: 'pending', count: 2, net_sum: 6910 },
      { kind: 'unknown', count: 1, net_sum: -700 },
      { kind: 'payout_unposted', count: 1, net_sum: -5000 },
      { kind: 'manual_topup', count: 1, net_sum: 50000 }]);
    expect(result.unjournaled.reduce((sum, row) => sum + row.net_sum, 0)).toBe(result.difference);
  });

  test('FREQ-566-AC-03: 手入力で入れた補充の仕訳があれば二重に数えず、差と合計は変わらず一致する', async () => {
    await seedBalance();
    const admin = await insertAccountingAdmin(db());
    await q('select public.admin_record_balance_topup($1::uuid, 50000, $2::date, $3::text, null, null, $4::uuid)', [admin, '2026-06-16', 'BANK-TOPUP-1', randomUUID()]);
    const result = await balanceRecon('2026-06-30');
    expect(result.ledger_1160).toBe(49856);
    expect(result.difference).toBe(-790);
    expect(bucket(result, 'manual_topup')).toEqual({ kind: 'manual_topup', count: 1, net_sum: 0 });
    expect(result.unjournaled.reduce((sum, row) => sum + row.net_sum, 0)).toBe(result.difference);
  });

  test('FREQ-566-AC-03: 入金途上1150は足さずに別に出る', async () => {
    await seedBalance();
    const result = await balanceRecon('2026-06-30');
    // PO1 moved 9640 into 1150; the difference does not include it.
    expect(result.payout_in_transit_1150).toBe(9640);
    expect(result.difference).toBe(result.stripe_balance - (result.ledger_1160 + result.ledger_1130_stripe));
    // The bank arrival moves it out of 1150 without touching 1160 or the difference.
    const admin = await insertAccountingAdmin(db());
    await q(`update public.stripe_payouts set bank_arrival_date = '2026-06-18', bank_confirmed_at = now(), bank_confirmed_by = $1 where reconciliation_status = 'matched'`, [admin]);
    // Only the arrival lane runs, so the sale and the fee that were left unposted stay as they are.
    await q('select private.accounting_post_stripe_bank_events(50)');
    const after = await balanceRecon('2026-06-30');
    expect(after.payout_in_transit_1150).toBe(0);
    expect(after.difference).toBe(result.difference);
  });

  test('FREQ-566-AC-03: 見る日（through）は日本時間の日で、その日より後の取引と仕訳は入れない', async () => {
    await seedBalance();
    expect((await balanceRecon('2026-06-09')).stripe_balance).toBe(0);
    const early = await balanceRecon('2026-06-11');
    // S1 (June 10) and S2 (June 11, 03:00Z = noon in Japan) only; the books hold the payment and both fees.
    expect(early.stripe_balance).toBe(9640 + 3856);
    expect(early.ledger_1160).toBe(10000 - 360 - 144);
    expect(early.difference).toBe(early.unjournaled.reduce((sum, row) => sum + row.net_sum, 0));
    // The end of the Japan day: 2026-06-30T15:30Z is already July 1 in Japan.
    await seedStripeFee(db(), { createdAt: '2026-06-30T15:30:00Z', type: 'topup', reportingCategory: 'topup', amount: 100 });
    const june = await balanceRecon('2026-06-30');
    expect(bucket(june, 'manual_topup')?.net_sum).toBe(50000);
    expect(bucket(await balanceRecon('2026-07-01'), 'manual_topup')?.net_sum).toBe(50100);
  });

  test('FREQ-566-AC-03: 取り消した仕訳は仕訳になっていない物として数え直し、差と合計は一致したまま', async () => {
    await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    const tx = await fee('2026-06-10T03:00:00Z', 5000, 180);
    await runAll();
    const entry = (await q('select id from public.accounting_journal_entries where dedupe_key = $1', [`stripe:fee:${tx}`])).rows[0].id as string;
    const before = await balanceRecon('2026-06-30');
    // The sale is not on the books (5000); the fee is (-180): 4820 of net against -180 of ledger.
    expect(before.difference).toBe(5000);
    expect(before.unjournaled.reduce((sum, row) => sum + row.net_sum, 0)).toBe(5000);
    const admin = await insertAccountingAdmin(db());
    await q("select public.admin_reverse_accounting_journal($1::uuid, $2::uuid, 'test reversal', null)", [admin, entry]);
    const after = await balanceRecon('2026-06-30');
    // The reversed fee is no longer on the books: the ledger is back to 0 and the fee counts as not journaled again.
    expect(after.ledger_1160).toBe(0);
    expect(after.difference).toBe(4820);
    expect(bucket(after, 'pending')).toEqual({ kind: 'pending', count: 1, net_sum: 4820 });
    expect(after.unjournaled.reduce((sum, row) => sum + row.net_sum, 0)).toBe(after.difference);
  });
});
