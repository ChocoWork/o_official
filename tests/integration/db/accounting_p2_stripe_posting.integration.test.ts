/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';
import { STRIPE_CATEGORY_RULES, kindOfStripeCategory } from '@/lib/accounting/stripe-categories';
import { describeLocalDb } from './helpers/local-db';
import { accountingFailure, createAccountingPeriod, insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import { makePeriodTaxable, seedStripeFee, seedStripePayout, setCutoverForTest } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 4 (FREQ-565 / FREQ-569): the Stripe fee, tax adjustment, payout, bank arrival and payout failure
// posting, and the manual balance top-up. ROLLBACK form (run with --runInBand): setCutoverForTest holds the settings table
// until the rollback. The posting functions are private; the top-up goes through its public entry as the connection's role.
jest.setTimeout(120000);

type RunResult = { posted: number; parked_new: number; reparked: number; resolved: number };
type PendingRow = { reason: string; detail: Record<string, unknown>; resolved_at: Date | null; resolved_entry_id: string | null;
  detection_count: number; event_kind: string; source_table: string };

describeLocalDb('S9 Stripe posting: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => { await q('begin'); });
  afterEach(async () => { await q('rollback'); });

  const core = (r: Record<string, number>): RunResult =>
    ({ posted: r.posted, parked_new: r.parked_new, reparked: r.reparked, resolved: r.resolved });
  const runAll = async (limit = 50) => (await q('select private.accounting_post_stripe_events($1::integer) as r', [limit])).rows[0].r as Record<string, number>;
  const run = async (limit = 50): Promise<RunResult> => core(await runAll(limit));
  const lane = async (name: string, limit = 50): Promise<RunResult> =>
    core((await q(`select private.accounting_post_stripe_${name}_events($1::integer) as r`, [limit])).rows[0].r);
  const entryOf = async (key: string) => (await q(
    `select e.id, e.dedupe_key, e.event_kind, e.description, e.source_table, e.source_id, e.recorded_by, e.is_late, e.source_recorded_at,
       to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, e.period_id, e.entry_no
     from public.accounting_journal_entries e where e.dedupe_key = $1`, [key])).rows[0];
  const linesOf = async (entryId: string) => (await q(
    `select line_no, account_code, debit::text as debit, credit::text as credit, order_id, sub_account, counterparty, memo
     from public.accounting_journal_lines where entry_id = $1 order by line_no`, [entryId])).rows;
  const entryCount = async () => Number((await q('select count(*) as n from public.accounting_journal_entries')).rows[0].n);
  const pendingOf = async (sourceTable: string, sourceId: string, eventKind?: string): Promise<PendingRow | undefined> => (await q(
    `select reason, detail, resolved_at, resolved_entry_id, detection_count, event_kind, source_table
     from public.accounting_pending_events where source_table = $1 and source_id = $2 and ($3::text is null or event_kind = $3)`,
    [sourceTable, sourceId, eventKind ?? null])).rows[0];
  const pendingCount = async () => Number((await q('select count(*) as n from public.accounting_pending_events')).rows[0].n);
  const lineSummary = async (key: string) => {
    const entry = await entryOf(key);
    return entry ? (await linesOf(entry.id)).map((l) => `${l.account_code}:${l.debit}/${l.credit}`) : null;
  };
  const start = async (cutover = '2026-01-01') => { await setCutoverForTest(db(), cutover); };
  const switchToCorporation = async () => {
    const admin = await insertAccountingAdmin(db());
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
  };
  const charge = (createdAt: string, fee: number, extra: { id?: string; feeDetails?: Array<Record<string, unknown>>; amount?: number } = {}) =>
    seedStripeFee(db(), { createdAt, type: 'charge', reportingCategory: 'charge', amount: extra.amount ?? 10000, fee, id: extra.id,
      feeDetails: extra.feeDetails, paymentIntentId: `pi_${randomUUID().replaceAll('-', '')}` });

  // ---- fee (1-a10) ----------------------------------------------------------------------------------------------------
  test('FREQ-565-AC-01: 手数料は取引1件に1本で、印は stripe:fee:<取引の番号>、相手はストライプジャパン株式会社', async () => {
    await start();
    const txId = await charge('2026-06-15T03:00:00Z', 360);
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    const entry = await entryOf(`stripe:fee:${txId}`);
    expect(entry).toMatchObject({ event_kind: 'stripe_fee', description: ACCOUNTING_LABELS.feePayment, source_table: 'stripe_balance_transactions',
      source_id: txId, entry_date: '2026-06-15', recorded_by: null });
    expect(entry.dedupe_key).toBe((await q("select private.accounting_event_key('stripe_fee', ARRAY[$1]) as k", [txId])).rows[0].k);
    const lines = await linesOf(entry.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ account_code: '6280', debit: '360', credit: '0', counterparty: ACCOUNTING_LABELS.stripeJapan, memo: ACCOUNTING_LABELS.feePayment });
    expect(lines[1]).toMatchObject({ account_code: '1160', debit: '0', credit: '360', counterparty: ACCOUNTING_LABELS.stripeJapan });
    // The second run finds it posted: nothing new, nothing parked.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entryCount()).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  test('FREQ-565-AC-01: 免税の期間は税込みの1行で、課税の期間は本体と仮払消費税に分かれる', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const period = (await createAccountingPeriod(db(), admin, { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' })).id;
    await makePeriodTaxable(db(), period, '2026-04-01');
    const details = [{ amount: 327, currency: 'jpy', type: 'stripe_fee' }, { amount: 33, currency: 'jpy', type: 'tax' }];
    const exempt = await charge('2026-03-15T03:00:00Z', 360, { feeDetails: details });
    const taxable = await charge('2026-04-01T03:00:00Z', 360, { feeDetails: details });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    // Before the day the period became taxable the fee is one tax-included line; from that day it splits.
    expect(await lineSummary(`stripe:fee:${exempt}`)).toEqual(['6280:360/0', '1160:0/360']);
    expect(await lineSummary(`stripe:fee:${taxable}`)).toEqual(['6280:327/0', '1480:33/0', '1160:0/360']);
    const split = await linesOf((await entryOf(`stripe:fee:${taxable}`)).id);
    expect(split.map((l) => l.memo)).toEqual([ACCOUNTING_LABELS.feePayment, ACCOUNTING_LABELS.feePayment, ACCOUNTING_LABELS.feePayment]);
  });

  test('FREQ-565-AC-01: 課税でfee_detailsに税が無ければ既定の課税10%で分けメモに残る', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const period = (await createAccountingPeriod(db(), admin, { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' })).id;
    await makePeriodTaxable(db(), period, '2026-01-01');
    const noDetails = await charge('2026-06-15T03:00:00Z', 110);
    const noTaxElement = await charge('2026-06-15T04:00:00Z', 220, { feeDetails: [{ amount: 220, currency: 'jpy', type: 'stripe_fee' }] });
    await run();
    expect(await lineSummary(`stripe:fee:${noDetails}`)).toEqual(['6280:100/0', '1480:10/0', '1160:0/110']);
    expect(await lineSummary(`stripe:fee:${noTaxElement}`)).toEqual(['6280:200/0', '1480:20/0', '1160:0/220']);
    const memos = (await linesOf((await entryOf(`stripe:fee:${noDetails}`)).id)).map((l) => l.memo);
    expect(memos[0]).toBe(`${ACCOUNTING_LABELS.feePayment} tax_default_10`);
    expect(memos[1]).toBe(`${ACCOUNTING_LABELS.feePayment} tax_default_10`);
    // A fee with a tax element does not get the default mark.
    const withTax = await charge('2026-06-16T03:00:00Z', 110, { feeDetails: [{ amount: 100, type: 'stripe_fee' }, { amount: 10, type: 'tax' }] });
    await run();
    expect((await linesOf((await entryOf(`stripe:fee:${withTax}`)).id)).map((l) => l.memo).join('|')).not.toContain('tax_default_10');
  });

  test('FREQ-565-AC-01: 単独の手数料の取引と返金の取引に付いた手数料も1件1本で、負の手数料は逆の仕訳', async () => {
    await start();
    // Stand-alone fees: type decides; fee = 0 and the amount carries the cost (net = amount).
    const standalone = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'stripe_fee', reportingCategory: 'fee', amount: -300 });
    const fx = await seedStripeFee(db(), { createdAt: '2026-06-10T04:00:00Z', type: 'stripe_fx_fee', reportingCategory: 'fee', amount: -50 });
    const refund = await seedStripeFee(db(), { createdAt: '2026-06-10T05:00:00Z', type: 'refund', reportingCategory: 'refund', amount: -5000, fee: -100 });
    const returned = await seedStripeFee(db(), { createdAt: '2026-06-10T06:00:00Z', type: 'stripe_fee', reportingCategory: 'fee', amount: 40 });
    const dispute = await seedStripeFee(db(), { createdAt: '2026-06-10T07:00:00Z', type: 'adjustment', reportingCategory: 'dispute', amount: -8000, fee: 1500 });
    expect(await run()).toEqual({ posted: 5, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lineSummary(`stripe:fee:${standalone}`)).toEqual(['6280:300/0', '1160:0/300']);
    expect((await linesOf((await entryOf(`stripe:fee:${standalone}`)).id))[0].memo).toBe(ACCOUNTING_LABELS.feePayment);
    expect(await lineSummary(`stripe:fee:${fx}`)).toEqual(['6280:50/0', '1160:0/50']);
    expect((await linesOf((await entryOf(`stripe:fee:${fx}`)).id))[0].memo).toBe(ACCOUNTING_LABELS.feeFx);
    // A refund that gave back 100 of fee: debit the receivable, credit the expense.
    expect(await lineSummary(`stripe:fee:${refund}`)).toEqual(['1160:100/0', '6280:0/100']);
    expect(await lineSummary(`stripe:fee:${returned}`)).toEqual(['1160:40/0', '6280:0/40']);
    expect(await lineSummary(`stripe:fee:${dispute}`)).toEqual(['6280:1500/0', '1160:0/1500']);
    expect((await linesOf((await entryOf(`stripe:fee:${dispute}`)).id))[0].memo).toBe(ACCOUNTING_LABELS.feeDispute);
  });

  test('FREQ-565-AC-01: 手数料の日は日本時間の日で、UTCの月末の夜の取引は日本時間の翌月の仕訳になる', async () => {
    await start();
    const txId = await charge('2026-06-30T16:00:00Z', 360);
    await run();
    expect((await entryOf(`stripe:fee:${txId}`)).entry_date).toBe('2026-07-01');
  });

  test('FREQ-565-AC-01: 手数料も入金も1160から引く（1130は使わない）', async () => {
    await start();
    const txId = await charge('2026-06-15T03:00:00Z', 360);
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z' });
    await run();
    const used = (await q(
      `select distinct l.account_code from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
       where e.dedupe_key in ($1, $2)`, [`stripe:fee:${txId}`, `payout_started:${payout}`])).rows.map((r) => r.account_code).sort();
    expect(used).toEqual(['1150', '1160', '6280']);
  });

  test('FREQ-565-AC-01: fee=0のstripe_feeとstripe_fx_feeも候補に入り-netで1本ずつ計上される', async () => {
    await start();
    const a = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'stripe_fee', reportingCategory: 'fee', amount: -200, fee: 0 });
    const b = await seedStripeFee(db(), { createdAt: '2026-06-10T04:00:00Z', type: 'stripe_fx_fee', reportingCategory: 'fee', amount: -60, fee: 0 });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lineSummary(`stripe:fee:${a}`)).toEqual(['6280:200/0', '1160:0/200']);
    expect(await lineSummary(`stripe:fee:${b}`)).toEqual(['6280:60/0', '1160:0/60']);
  });

  // ---- tax adjustment (1-a11, 4-c4) -----------------------------------------------------------------------------------
  test('FREQ-565-AC-02: 税額調整はnet=-110なら費用側の借方110と1160の貸方110、net=110なら逆で、net=0は仕訳を作らない', async () => {
    await start();
    const minus = await seedStripeFee(db(), { createdAt: '2026-07-02T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    const plus = await seedStripeFee(db(), { createdAt: '2026-07-03T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: 110 });
    const zero = await seedStripeFee(db(), { createdAt: '2026-07-04T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: 0 });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lineSummary(`stripe_tax_adjustment:${minus}`)).toEqual(['6280:110/0', '1160:0/110']);
    expect(await lineSummary(`stripe_tax_adjustment:${plus}`)).toEqual(['1160:110/0', '6280:0/110']);
    expect(await entryOf(`stripe_tax_adjustment:${zero}`)).toBeUndefined();
    expect(await pendingOf('stripe_balance_transactions', zero)).toBeUndefined();
    const entry = await entryOf(`stripe_tax_adjustment:${minus}`);
    expect(entry).toMatchObject({ event_kind: 'stripe_tax_adjustment', description: ACCOUNTING_LABELS.taxAdjustment, entry_date: '2026-07-02' });
    expect((await linesOf(entry.id))[0]).toMatchObject({ counterparty: ACCOUNTING_LABELS.stripeJapan, memo: ACCOUNTING_LABELS.taxAdjustment });
  });

  test('FREQ-565-AC-02: 課税の期間の税額調整は仮払消費税の1480を使う', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const period = (await createAccountingPeriod(db(), admin, { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' })).id;
    await makePeriodTaxable(db(), period, '2026-04-01');
    const minus = await seedStripeFee(db(), { createdAt: '2026-07-02T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    const plus = await seedStripeFee(db(), { createdAt: '2026-07-03T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: 110 });
    await run();
    expect(await lineSummary(`stripe_tax_adjustment:${minus}`)).toEqual(['1480:110/0', '1160:0/110']);
    expect(await lineSummary(`stripe_tax_adjustment:${plus}`)).toEqual(['1160:110/0', '1480:0/110']);
  });

  test('FREQ-565-AC-02: 税額調整は調整の取引の日に1本で、元の手数料の仕訳と合計が二重にならない', async () => {
    await start();
    const chargeTx = await charge('2026-06-15T03:00:00Z', 360);
    const adjustment = await seedStripeFee(db(), { createdAt: '2026-07-02T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    // The adjustment has no fee entry, the charge has no adjustment entry: 360 + 110 of expense, no more.
    expect(await entryOf(`stripe:fee:${adjustment}`)).toBeUndefined();
    expect(await entryOf(`stripe_tax_adjustment:${chargeTx}`)).toBeUndefined();
    const expense = Number((await q(`select coalesce(sum(l.debit - l.credit), 0) as n from public.accounting_journal_lines l
      join public.accounting_journal_entries e on e.id = l.entry_id where l.account_code = '6280'`)).rows[0].n);
    expect(expense).toBe(470);
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
  });

  // ---- unknown categories (4-c) and skipped rows ----------------------------------------------------------------------
  test('FREQ-565-AC-03: 知らない種類の取引は仕訳にせずunknown_categoryで計上待ちに置き、種類を足すと入る', async () => {
    await start();
    const txId = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'future_fee', reportingCategory: 'fee', amount: -700 });
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await entryCount()).toBe(0);
    expect(await pendingOf('stripe_balance_transactions', txId)).toMatchObject({ reason: 'unknown_category', detail: {}, resolved_at: null, detection_count: 1 });
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 1, resolved: 0 });
    expect((await pendingOf('stripe_balance_transactions', txId))?.detection_count).toBe(2);
    // Add the kind to the mapping (the test replaces the function inside this transaction).
    await q(`do $x$ declare d text; begin
      d := pg_get_functiondef('private.accounting_stripe_category_kind(text,text)'::regprocedure);
      d := replace(d, 'ELSE NULL', 'WHEN _type = ''future_fee'' THEN ''fee_only'' ELSE NULL');
      execute d; end $x$`);
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 1 });
    expect(await lineSummary(`stripe:fee:${txId}`)).toEqual(['6280:700/0', '1160:0/700']);
    const parked = await pendingOf('stripe_balance_transactions', txId);
    expect(parked?.resolved_at).not.toBeNull();
    expect(parked?.resolved_entry_id).toBe((await entryOf(`stripe:fee:${txId}`)).id);
  });

  test('FREQ-565-AC-03: 支払いの種類でreporting_categoryがchargeでない取引と、知らない調整は、どの係からも落ちずunknown_categoryで止まる', async () => {
    await start();
    const odd = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'charge', reportingCategory: 'other_charge', amount: 4000, fee: 100 });
    const adjustment = await seedStripeFee(db(), { createdAt: '2026-06-10T04:00:00Z', type: 'adjustment', reportingCategory: 'other_adjustment', amount: -900 });
    expect(await run()).toEqual({ posted: 0, parked_new: 2, reparked: 0, resolved: 0 });
    expect((await pendingOf('stripe_balance_transactions', odd))?.reason).toBe('unknown_category');
    expect((await pendingOf('stripe_balance_transactions', adjustment))?.reason).toBe('unknown_category');
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-565-AC-03: 返金系の取引の元本は係が飛ばし、計上待ちにもしない', async () => {
    await start();
    const refund = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'refund', reportingCategory: 'refund', amount: -3000 });
    const payment = await seedStripeFee(db(), { createdAt: '2026-06-10T04:00:00Z', type: 'payment_refund', reportingCategory: 'refund', amount: -1000 });
    const failure = await seedStripeFee(db(), { createdAt: '2026-06-10T05:00:00Z', type: 'refund_failure', reportingCategory: 'refund_failure', amount: 1000 });
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    for (const id of [refund, payment, failure]) expect(await pendingOf('stripe_balance_transactions', id)).toBeUndefined();
    expect(await entryCount()).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  test('FREQ-565-AC-03: topupの取引は止めずに飛ばし、照合でmanual_topupとして名指される', async () => {
    await start();
    const topup = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'topup', reportingCategory: 'topup', amount: 50000 });
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await pendingOf('stripe_balance_transactions', topup)).toBeUndefined();
    const result = (await q("select public.get_stripe_balance_reconciliation('2026-06-30') as r")).rows[0].r;
    const manual = result.unjournaled.find((row: { kind: string }) => row.kind === 'manual_topup');
    expect(manual).toEqual({ kind: 'manual_topup', count: 1, net_sum: 50000 });
    expect(result.difference).toBe(50000);
  });

  test('FREQ-565-AC-03: 飛ばす取引が_limit件以上あっても、新しい手数料の取引が入る', async () => {
    await start();
    // Older than the fee: refund principals, payout rows, top-ups and a stand-alone fee-less row all stay out of the candidates.
    for (let i = 0; i < 3; i += 1) {
      await seedStripeFee(db(), { createdAt: `2026-05-0${i + 1}T03:00:00Z`, type: 'refund', reportingCategory: 'refund', amount: -1000 });
      await seedStripeFee(db(), { createdAt: `2026-05-1${i}T03:00:00Z`, type: 'payout', reportingCategory: 'payout', amount: -2000 });
      await seedStripeFee(db(), { createdAt: `2026-05-2${i}T03:00:00Z`, type: 'topup', reportingCategory: 'topup', amount: 3000 });
      await seedStripeFee(db(), { createdAt: `2026-05-0${i + 1}T04:00:00Z`, type: 'stripe_fee', reportingCategory: 'fee', amount: 0 });
    }
    const fee = await charge('2026-06-15T03:00:00Z', 360);
    expect(await run(2)).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entryOf(`stripe:fee:${fee}`)).toBeDefined();
    expect(await pendingCount()).toBe(0);
  });

  test('FREQ-565-AC-03: 種類の対応は type を鍵にし、単独の手数料（fee=0でnetは正負）と入金の失敗が正しい出来事になる', async () => {
    const pairs: Array<[string, string]> = [];
    for (const rule of STRIPE_CATEGORY_RULES) {
      for (const type of rule.types) {
        for (const category of rule.reportingCategories ?? ['anything', 'fee', 'refund']) pairs.push([type, category]);
      }
    }
    pairs.push(['charge', 'other_charge'], ['adjustment', 'other_adjustment'], ['advance', 'advance'], ['', '']);
    for (const [type, category] of pairs) {
      const sql = (await q('select private.accounting_stripe_category_kind($1, $2) as k', [type, category])).rows[0].k as string | null;
      expect([type, category, sql]).toEqual([type, category, kindOfStripeCategory(type, category)]);
    }
    await start();
    const fee = await seedStripeFee(db(), { createdAt: '2026-06-10T03:00:00Z', type: 'stripe_fee', reportingCategory: 'whatever', amount: -120, fee: 0 });
    const refunded = await seedStripeFee(db(), { createdAt: '2026-06-10T04:00:00Z', type: 'stripe_fx_fee', reportingCategory: 'whatever', amount: 20, fee: 0 });
    const payout = await seedStripePayout(db(), { amount: 1000, paidAt: '2026-06-09T03:00:00Z' });
    await run();
    const failure = await seedStripeFee(db(), { createdAt: '2026-06-11T03:00:00Z', type: 'payout_failure', reportingCategory: 'whatever', amount: 1000, sourceId: payout });
    await run();
    expect(await lineSummary(`stripe:fee:${fee}`)).toEqual(['6280:120/0', '1160:0/120']);
    expect(await lineSummary(`stripe:fee:${refunded}`)).toEqual(['1160:20/0', '6280:0/20']);
    expect(await lineSummary(`payout_failed:${failure}`)).toEqual(['1160:1000/0', '1150:0/1000']);
  });

  // ---- payout (1-a12) -------------------------------------------------------------------------------------------------
  test('FREQ-565-AC-04: 入金は中身と額が一致した時だけ「1150／1160」で、mismatchはpayout_mismatchで止まる', async () => {
    await start();
    const matched = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z' });
    const mismatch = await seedStripePayout(db(), { amount: 5000, paidAt: '2026-06-21T03:00:00Z', reconciliationStatus: 'mismatch' });
    const waiting = await seedStripePayout(db(), { amount: 4000, paidAt: '2026-06-22T03:00:00Z', reconciliationStatus: 'pending' });
    expect(await run()).toEqual({ posted: 1, parked_new: 1, reparked: 0, resolved: 0 });
    const entry = await entryOf(`payout_started:${matched}`);
    expect(entry).toMatchObject({ event_kind: 'payout_started', description: ACCOUNTING_LABELS.payoutStarted, source_table: 'stripe_payouts',
      source_id: matched, entry_date: '2026-06-20' });
    expect(await lineSummary(`payout_started:${matched}`)).toEqual(['1150:9640/0', '1160:0/9640']);
    expect(await entryOf(`payout_started:${mismatch}`)).toBeUndefined();
    expect(await pendingOf('stripe_payouts', mismatch)).toMatchObject({ event_kind: 'payout_started', reason: 'payout_mismatch', detail: {}, resolved_at: null });
    // A payout whose reconciliation has not finished only waits: no entry, no parked row.
    expect(await entryOf(`payout_started:${waiting}`)).toBeUndefined();
    expect(await pendingOf('stripe_payouts', waiting)).toBeUndefined();
    // When the payout is reconciled the parked one and the waiting one go in.
    await q("update public.stripe_payouts set reconciliation_status = 'matched' where id = any($1::text[])", [[mismatch, waiting]]);
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 1 });
    expect(await lineSummary(`payout_started:${mismatch}`)).toEqual(['1150:5000/0', '1160:0/5000']);
    expect((await pendingOf('stripe_payouts', mismatch))?.resolved_at).not.toBeNull();
  });

  test('FREQ-565-AC-04: 入金の日は入金の取引の日本時間の日', async () => {
    await start();
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-30T16:30:00Z' });
    await run();
    expect((await entryOf(`payout_started:${payout}`)).entry_date).toBe('2026-07-01');
  });

  test('FREQ-565-AC-04: 着金は着金の日に「1040／1150」で、入金の仕訳が先に無ければ入れない', async () => {
    await start();
    const withEntry = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z' });
    await run();
    const admin = await insertAccountingAdmin(db());
    await q(`update public.stripe_payouts set bank_arrival_date = '2026-06-23', bank_confirmed_at = now(), bank_confirmed_by = $2 where id = $1`, [withEntry, admin]);
    const noEntry = await seedStripePayout(db(), { amount: 3000, paidAt: '2026-06-20T04:00:00Z', reconciliationStatus: 'mismatch', bankArrivalDate: '2026-06-24' });
    // The arrival of the first payout goes in; the second payout (a mismatch) is parked by the payout lane in the same call.
    expect(await run()).toEqual({ posted: 1, parked_new: 1, reparked: 0, resolved: 0 });
    const entry = await entryOf(`bank_arrived:${withEntry}`);
    expect(entry).toMatchObject({ event_kind: 'bank_arrived', description: ACCOUNTING_LABELS.bankArrived, source_table: 'stripe_payouts', source_id: withEntry,
      entry_date: '2026-06-23' });
    expect(await lineSummary(`bank_arrived:${withEntry}`)).toEqual(['1040:9640/0', '1150:0/9640']);
    // The payout that never reached its own entry gets no arrival (the arrival is not parked: the payout itself is).
    expect(await entryOf(`bank_arrived:${noEntry}`)).toBeUndefined();
    expect(await pendingOf('stripe_payouts', noEntry, 'bank_arrived')).toBeUndefined();
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 1, resolved: 0 });
    expect(await entryCount()).toBe(2);
  });

  // ---- payout failure (1-a13) -----------------------------------------------------------------------------------------
  test('FREQ-565-AC-05: 入金の失敗と取り消しは戻りの取引の日に「1160／1150」で戻り、同じ取引は1本', async () => {
    await start();
    const failed = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z', status: 'failed' });
    const canceled = await seedStripePayout(db(), { amount: 3000, paidAt: '2026-06-20T04:00:00Z', status: 'canceled' });
    await run();
    const failureTx = await seedStripeFee(db(), { createdAt: '2026-06-25T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 9640,
      sourceId: failed, rawPayload: { retried_payout_id: 'po_retry_1' } });
    const cancelTx = await seedStripeFee(db(), { createdAt: '2026-06-26T03:00:00Z', type: 'payout_cancel', reportingCategory: 'payout_reversal', amount: 3000, sourceId: canceled });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    const entry = await entryOf(`payout_failed:${failureTx}`);
    expect(entry).toMatchObject({ event_kind: 'payout_failed', description: ACCOUNTING_LABELS.payoutFailed, source_table: 'stripe_balance_transactions',
      source_id: failureTx, entry_date: '2026-06-25' });
    const lines = await linesOf(entry.id);
    expect(lines.map((l) => `${l.account_code}:${l.debit}/${l.credit}`)).toEqual(['1160:9640/0', '1150:0/9640']);
    expect(lines[0].memo).toBe(`payout:${failed} retried:po_retry_1`);
    expect(await lineSummary(`payout_failed:${cancelTx}`)).toEqual(['1160:3000/0', '1150:0/3000']);
    expect((await linesOf((await entryOf(`payout_failed:${cancelTx}`)).id))[0].memo).toBe(`payout:${canceled}`);
    // The same return is one entry however often the run goes.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entryCount()).toBe(4);
    // 1150 is back to zero.
    expect(Number((await q(`select coalesce(sum(l.debit - l.credit), 0) as n from public.accounting_journal_lines l where l.account_code = '1150'`)).rows[0].n)).toBe(0);
  });

  test('FREQ-565-AC-05: 入金の仕訳が無い入金の失敗は仕訳にせず止める', async () => {
    await start();
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z', status: 'failed', reconciliationStatus: 'mismatch' });
    const failureTx = await seedStripeFee(db(), { createdAt: '2026-06-25T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 9640, sourceId: payout });
    expect(await lane('payout_failure')).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await entryOf(`payout_failed:${failureTx}`)).toBeUndefined();
    expect(await pendingOf('stripe_balance_transactions', failureTx)).toMatchObject({ event_kind: 'payout_failed', reason: 'payout_mismatch',
      detail: { payout_state: 'payout_not_posted' }, resolved_at: null });
  });

  test('FREQ-565-AC-05: 照合待ちの入金が失敗しても、入金と戻りは両方入るか両方入らないかのどちらかで、1150が残らない', async () => {
    await start();
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z', status: 'failed', reconciliationStatus: 'pending' });
    const failureTx = await seedStripeFee(db(), { createdAt: '2026-06-25T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 9640, sourceId: payout });
    const balance1150 = async () => Number((await q(`select coalesce(sum(l.debit - l.credit), 0) as n from public.accounting_journal_lines l where l.account_code = '1150'`)).rows[0].n);
    // Waiting for the reconciliation: neither the payout nor its return is posted.
    expect(await run()).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await entryOf(`payout_started:${payout}`)).toBeUndefined();
    expect(await entryOf(`payout_failed:${failureTx}`)).toBeUndefined();
    expect(await balance1150()).toBe(0);
    // Reconciled: one run posts the payout first and then its return, so 1150 is zero again.
    await q("update public.stripe_payouts set reconciliation_status = 'matched' where id = $1", [payout]);
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 1 });
    expect(await entryOf(`payout_started:${payout}`)).toBeDefined();
    expect(await entryOf(`payout_failed:${failureTx}`)).toBeDefined();
    expect(await balance1150()).toBe(0);
  });

  test('FREQ-565-AC-05: 入金の仕訳がこの先も入らない入金（失敗・取り消しで支払い日が無い）は、入金の取引と戻りの取引が打ち消し合い解決済みの印だけが残る', async () => {
    await start();
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: null, status: 'failed', reconciliationStatus: 'pending' });
    const payoutTx = await seedStripeFee(db(), { createdAt: '2026-06-20T03:00:00Z', type: 'payout', reportingCategory: 'payout', amount: -9640, sourceId: payout, payoutId: payout });
    const failureTx = await seedStripeFee(db(), { createdAt: '2026-06-25T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 9640, sourceId: payout });
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 1 });
    expect(await entryCount()).toBe(0);
    for (const [table, id, kind] of [['stripe_balance_transactions', failureTx, 'payout_failed'], ['stripe_balance_transactions', payoutTx, 'payout_started'],
      ['stripe_payouts', payout, 'payout_started']] as const) {
      expect(await pendingOf(table, id, kind)).toMatchObject({ reason: 'payout_mismatch', detail: { payout_state: 'payout_net_zero' }, resolved_entry_id: null });
      expect((await pendingOf(table, id, kind))?.resolved_at).not.toBeNull();
    }
    // Nothing more to do, and the balance check treats the pair as settled.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    const result = (await q("select public.get_stripe_balance_reconciliation('2026-06-30') as r")).rows[0].r;
    expect(result.difference).toBe(0);
    expect(result.unjournaled.every((row: { net_sum: number }) => row.net_sum === 0)).toBe(true);
  });

  // ---- balance top-up (1-a14) -----------------------------------------------------------------------------------------
  test('FREQ-565-AC-06: 残高の補充は画面の入力から「1160／1040」で入り、同じ銀行の取引の番号で2回目は何も足さず、額が違えばDEDUPE_CONTENT_MISMATCH', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const topup = (amount: number, ref = 'BANK-2026.06_001', date = '2026-06-10', stripe: string | null = 'txn_topup_1') =>
      q('select public.admin_record_balance_topup($1::uuid, $2::bigint, $3::date, $4::text, $5::text, $6::text, $7::uuid) as r',
        [admin, amount, date, ref, stripe, 'Stripe balance was negative', randomUUID()]);
    const first = (await topup(20000)).rows[0].r;
    expect(first.created).toBe(true);
    const entry = await entryOf('balance_topup:BANK-2026.06_001');
    expect(entry).toMatchObject({ event_kind: 'balance_topup', entry_date: '2026-06-10', recorded_by: admin, id: first.entry_id });
    expect(entry.description.startsWith(ACCOUNTING_LABELS.balanceTopup)).toBe(true);
    const lines = await linesOf(entry.id);
    expect(lines.map((l) => `${l.account_code}:${l.debit}/${l.credit}`)).toEqual(['1160:20000/0', '1040:0/20000']);
    expect(lines.map((l) => l.memo)).toEqual(['txn_topup_1', 'txn_topup_1']);
    // The same number again adds nothing and answers the first entry.
    const second = (await topup(20000)).rows[0].r;
    expect(second).toMatchObject({ created: false, entry_id: first.entry_id });
    expect(await entryCount()).toBe(1);
    // The same number with another amount is refused.
    expect(await accountingFailure(db(), () => topup(25000))).toMatchObject({ code: '23505', message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
    expect(await entryCount()).toBe(1);
    // Without a bank number the Stripe transaction number is the number.
    await q('select public.admin_record_balance_topup($1::uuid, 7000, $2::date, null, $3::text, null, $4::uuid)', [admin, '2026-06-11', 'txn_only_stripe', randomUUID()]);
    expect(await entryOf('balance_topup:txn_only_stripe')).toBeDefined();
  });

  test('FREQ-565-AC-06: 補充の銀行の取引の番号は英数字・._-の1〜128字だけで、空の番号と未来の日と額0と切り替えの日より前を断る', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const call = (amount: number | null, date: string | null, bank: string | null, stripe: string | null = null) =>
      accountingFailure(db(), () => q('select public.admin_record_balance_topup($1::uuid, $2::bigint, $3::date, $4::text, $5::text, null, $6::uuid)',
        [admin, amount, date, bank, stripe, randomUUID()]));
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await call(1000, '2026-06-10', 'bank number')).toMatchObject(invalid);
    expect(await call(1000, '2026-06-10', 'bank:001')).toMatchObject(invalid);
    expect(await call(1000, '2026-06-10', 'a'.repeat(129))).toMatchObject(invalid);
    expect(await call(1000, '2026-06-10', '')).toMatchObject(invalid);
    expect(await call(1000, '2026-06-10', null, null)).toMatchObject(invalid);
    expect(await call(1000, '2026-06-10', 'ok-1', 'txn bad')).toMatchObject(invalid);
    expect(await call(0, '2026-06-10', 'ok-2')).toMatchObject(invalid);
    expect(await call(-5, '2026-06-10', 'ok-3')).toMatchObject(invalid);
    expect(await call(null, '2026-06-10', 'ok-4')).toMatchObject(invalid);
    expect(await call(1000, '2999-01-01', 'ok-5')).toMatchObject(invalid);
    expect(await call(1000, '2025-12-31', 'ok-6')).toMatchObject(invalid);
    expect(await call(1000, null, 'ok-7')).toMatchObject(invalid);
    // The longest allowed number and every allowed character go in.
    expect(await call(1000, '2026-06-10', 'a'.repeat(128))).toBeNull();
    expect(await call(1000, '2026-06-10', 'Az09._-')).toBeNull();
    expect(await entryCount()).toBe(0);
  });

  test('FREQ-565-AC-06: 補充は権限なしを42501で断る', async () => {
    await start();
    const stranger = randomUUID();
    await q("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, '{}', '{}')", [stranger]);
    for (const actor of [stranger, randomUUID()]) {
      expect(await accountingFailure(db(), () => q('select public.admin_record_balance_topup($1::uuid, 1000, $2::date, $3::text, null, null, $4::uuid)',
        [actor, '2026-06-10', 'NOPE-1', randomUUID()]))).toMatchObject({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    }
    expect(await entryCount()).toBe(0);
  });

  // ---- failure handling, cutover, periods -----------------------------------------------------------------------------
  test('FREQ-569-AC-06: 手数料1件の失敗は保留に残りほかの手数料と入金は計上される', async () => {
    await start();
    // A transaction number the event key cannot hold fails inside the core; it is the oldest, so the loop must go on.
    const bad = await seedStripeFee(db(), { id: 'txn:bad', createdAt: '2026-06-01T03:00:00Z', type: 'charge', reportingCategory: 'charge', amount: 5000, fee: 180 });
    const good = await charge('2026-06-02T03:00:00Z', 360);
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-03T03:00:00Z' });
    expect(await run()).toEqual({ posted: 2, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf('stripe_balance_transactions', bad)).toMatchObject({ event_kind: 'stripe_fee', reason: 'posting_error',
      detail: { error_sqlstate: '22023', error_code: 'ACCOUNTING_ARGUMENT_INVALID', entry_date: '2026-06-01' } });
    expect(await entryOf(`stripe:fee:${good}`)).toBeDefined();
    expect(await entryOf(`payout_started:${payout}`)).toBeDefined();
    // Only the failed one stays: a second run re-parks it and posts nothing else.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 1, resolved: 0 });
    expect(await entryCount()).toBe(2);
  });

  test('FREQ-565-AC-01: 切り替えの日より前の手数料・税額調整・入金・入金の失敗は仕訳にせずbefore_cutoverで止める', async () => {
    await start('2026-06-01');
    const fee = await charge('2026-05-31T03:00:00Z', 360);
    const adjustment = await seedStripeFee(db(), { createdAt: '2026-05-30T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-05-29T03:00:00Z' });
    const onDay = await charge('2026-06-01T03:00:00Z', 180);
    const failureTx = await seedStripeFee(db(), { createdAt: '2026-05-28T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 9640, sourceId: payout });
    await run();
    for (const id of [fee, adjustment, failureTx]) expect(await pendingOf('stripe_balance_transactions', id)).toMatchObject({ reason: 'before_cutover', detail: {} });
    expect(await pendingOf('stripe_payouts', payout)).toMatchObject({ reason: 'before_cutover', detail: {} });
    expect(await entryOf(`stripe:fee:${onDay}`)).toBeDefined();
    expect(await entryCount()).toBe(1);
  });

  test('FREQ-569-AC-01: 手数料・税額調整・入金・着金・入金の失敗のすべてでperiod_missingのdetail.entry_dateが各仕訳の日になる', async () => {
    await start();
    // P1 goes in while the sole period of 2026 exists; its arrival and its return come after the switch to a corporation.
    const p1 = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-17T03:00:00Z' });
    await run();
    expect(await entryOf(`payout_started:${p1}`)).toBeDefined();
    const admin = await insertAccountingAdmin(db());
    await q(`update public.stripe_payouts set bank_arrival_date = '2027-01-05', bank_confirmed_at = now(), bank_confirmed_by = $2 where id = $1`, [p1, admin]);
    await switchToCorporation();
    const fee = await charge('2026-12-31T20:00:00Z', 360);
    const adjustment = await seedStripeFee(db(), { createdAt: '2027-01-03T03:00:00Z', type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    const p2 = await seedStripePayout(db(), { amount: 5000, paidAt: '2027-01-04T03:00:00Z' });
    const failureTx = await seedStripeFee(db(), { createdAt: '2027-01-06T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 9640, sourceId: p1 });
    expect(await run()).toEqual({ posted: 0, parked_new: 5, reparked: 0, resolved: 0 });
    const expected: Array<[string, string, string, string]> = [
      ['stripe_balance_transactions', fee, 'stripe_fee', '2027-01-01'],
      ['stripe_balance_transactions', adjustment, 'stripe_tax_adjustment', '2027-01-03'],
      ['stripe_payouts', p2, 'payout_started', '2027-01-04'],
      ['stripe_payouts', p1, 'bank_arrived', '2027-01-05'],
      ['stripe_balance_transactions', failureTx, 'payout_failed', '2027-01-06']];
    for (const [table, id, kind, date] of expected) {
      const parked = await pendingOf(table, id, kind);
      expect([kind, parked?.reason, parked?.detail]).toEqual([kind, 'period_missing', { entry_date: date }]);
    }
    // A second run looks at them again with the same dates.
    expect(await run()).toEqual({ posted: 0, parked_new: 0, reparked: 5, resolved: 0 });
    for (const [table, id, kind, date] of expected) expect((await pendingOf(table, id, kind))?.detail).toEqual({ entry_date: date });
    // A corporate period for the days lets all five go in.
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(await run()).toEqual({ posted: 5, parked_new: 0, reparked: 0, resolved: 5 });
  });

  test('FREQ-565-AC-01: 5つの係は別々にも流せて、結果は{posted,parked_new,reparked,resolved}を返す', async () => {
    await start();
    const fee = await charge('2026-06-15T03:00:00Z', 360);
    expect(await lane('fee')).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lane('tax_adjustment')).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lane('payout')).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lane('bank')).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lane('payout_failure')).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entryOf(`stripe:fee:${fee}`)).toBeDefined();
    const all = await runAll();
    expect(all).toMatchObject({ posted: 0, fees: 0, tax_adjustments: 0, payouts: 0, bank_arrivals: 0, payout_failures: 0 });
    for (const bad of [0, 201, -1]) {
      expect(await accountingFailure(db(), () => q('select private.accounting_post_stripe_events($1::integer)', [bad]))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    }
  });

  test('FREQ-565-AC-03: 支払いの番号（payment_intent）が無い売上の取引は黙って落とさずno_orderで止め、手数料は計上される', async () => {
    await start();
    const txId = await seedStripeFee(db(), { createdAt: '2026-06-15T03:00:00Z', type: 'charge', reportingCategory: 'charge', amount: 5000, fee: 180,
      paymentIntentId: null });
    const payment = (await q('select private.accounting_post_payment_events(50) as r')).rows[0].r as RunResult;
    expect(payment).toEqual({ posted: 0, parked_new: 1, reparked: 0, resolved: 0 });
    expect(await pendingOf('stripe_balance_transactions', txId, 'payment_confirmed')).toMatchObject({ reason: 'no_order', detail: {}, resolved_at: null });
    // The fee lane takes the fee as before; the principal is never posted (the key needs the payment intent).
    expect(await run()).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lineSummary(`stripe:fee:${txId}`)).toEqual(['6280:180/0', '1160:0/180']);
    expect(await entryCount()).toBe(1);
    // A second run looks at it again and keeps it parked; the balance read names it as pending.
    expect((await q('select private.accounting_post_payment_events(50) as r')).rows[0].r).toEqual({ posted: 0, parked_new: 0, reparked: 1, resolved: 0 });
    // The type payment is treated the same way as charge.
    const second = await seedStripeFee(db(), { createdAt: '2026-06-16T03:00:00Z', type: 'payment', reportingCategory: 'charge', amount: 3000, paymentIntentId: null });
    await q('select private.accounting_post_payment_events(50)');
    expect((await pendingOf('stripe_balance_transactions', second, 'payment_confirmed'))?.reason).toBe('no_order');
  });

  test('FREQ-565-AC-01: 入金の失敗の仕訳は取引の額（amount）で入り、戻りの取引に付いた手数料は手数料の係が1本で計上する', async () => {
    await start();
    const payout = await seedStripePayout(db(), { amount: 1000, paidAt: '2026-06-09T03:00:00Z' });
    await run();
    const failureTx = await seedStripeFee(db(), { createdAt: '2026-06-11T03:00:00Z', type: 'payout_failure', reportingCategory: 'payout_reversal',
      amount: 1000, fee: 10, sourceId: payout });
    expect(await run()).toEqual({ posted: 2, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await lineSummary(`payout_failed:${failureTx}`)).toEqual(['1160:1000/0', '1150:0/1000']);
    expect(await lineSummary(`stripe:fee:${failureTx}`)).toEqual(['6280:10/0', '1160:0/10']);
    // 1160 moved by the net of the transaction (990), not by amount minus two fees.
    const moved = Number((await q(`select coalesce(sum(l.debit - l.credit), 0) as n from public.accounting_journal_lines l
      join public.accounting_journal_entries e on e.id = l.entry_id where l.account_code = '1160' and e.dedupe_key in ($1, $2)`,
      [`payout_failed:${failureTx}`, `stripe:fee:${failureTx}`])).rows[0].n);
    expect(moved).toBe(990);
  });

  test('FREQ-565-AC-04: 入金の仕訳を取り消した入金には着金を入れない', async () => {
    await start();
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-06-20T03:00:00Z' });
    await run();
    const entry = (await entryOf(`payout_started:${payout}`)).id as string;
    const admin = await insertAccountingAdmin(db());
    await q("select public.admin_reverse_accounting_journal($1::uuid, $2::uuid, 'test reversal', null)", [admin, entry]);
    await q(`update public.stripe_payouts set bank_arrival_date = '2026-06-23', bank_confirmed_at = now(), bank_confirmed_by = $2 where id = $1`, [payout, admin]);
    expect(await lane('bank')).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0 });
    expect(await entryOf(`bank_arrived:${payout}`)).toBeUndefined();
  });

  test('FREQ-565-AC-01: 元の記録の保存が古く登録が2か月以上遅れた手数料は遅れの印が付く', async () => {
    await start();
    const late = await seedStripeFee(db(), { createdAt: '2026-01-05T03:00:00Z', type: 'charge', reportingCategory: 'charge', amount: 5000, fee: 180,
      syncedAt: new Date().toISOString() });
    const notLate = await seedStripeFee(db(), { createdAt: '2026-01-05T04:00:00Z', type: 'charge', reportingCategory: 'charge', amount: 5000, fee: 180,
      syncedAt: '2026-01-06T00:00:00Z' });
    await run();
    expect((await entryOf(`stripe:fee:${late}`)).is_late).toBe(true);
    expect((await entryOf(`stripe:fee:${notLate}`)).is_late).toBe(false);
  });

  test('FREQ-565-AC-06: 同じStripeの取引の番号は別の銀行の取引の番号や番号なしでも2回入らない（同じ内容は前の仕訳を返し、違えば断る）', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const topup = (amount: number, bank: string | null, stripe: string | null, date = '2026-06-10') =>
      q('select public.admin_record_balance_topup($1::uuid, $2::bigint, $3::date, $4::text, $5::text, null, $6::uuid) as r', [admin, amount, date, bank, stripe, randomUUID()]);
    const first = (await topup(20000, 'BANK-1', 'txn_a')).rows[0].r;
    // Another bank number, the same Stripe transaction.
    expect((await topup(20000, 'BANK-2', 'txn_a')).rows[0].r).toMatchObject({ created: false, entry_id: first.entry_id });
    expect(await accountingFailure(db(), () => topup(25000, 'BANK-2', 'txn_a'))).toMatchObject({ code: '23505', message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
    expect(await accountingFailure(db(), () => topup(20000, 'BANK-2', 'txn_a', '2026-06-11'))).toMatchObject({ code: '23505', message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
    // No bank number: the Stripe number becomes the key, which the first entry does not carry.
    expect((await topup(20000, null, 'txn_a')).rows[0].r).toMatchObject({ created: false, entry_id: first.entry_id });
    expect(await accountingFailure(db(), () => topup(1000, null, 'txn_a'))).toMatchObject({ code: '23505', message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
    expect(await entryCount()).toBe(1);
    // A reversed entry no longer binds the Stripe number.
    await q("select public.admin_reverse_accounting_journal($1::uuid, $2::uuid, 'test reversal', null)", [admin, first.entry_id]);
    expect((await topup(7000, 'BANK-3', 'txn_a')).rows[0].r.created).toBe(true);
  });

  test('FREQ-565-AC-06: Stripeの取引の番号だけで入れた補充に、あとから銀行の取引の番号を付けて入れ直しても2回入らない', async () => {
    await start();
    const admin = await insertAccountingAdmin(db());
    const topup = (amount: number, bank: string | null, stripe: string | null) =>
      q('select public.admin_record_balance_topup($1::uuid, $2::bigint, $3::date, $4::text, $5::text, null, $6::uuid) as r', [admin, amount, '2026-06-10', bank, stripe, randomUUID()]);
    const first = (await topup(20000, null, 'txn_b')).rows[0].r;
    expect(await entryOf('balance_topup:txn_b')).toBeDefined();
    expect((await topup(20000, 'BANK-9', 'txn_b')).rows[0].r).toMatchObject({ created: false, entry_id: first.entry_id });
    expect(await accountingFailure(db(), () => topup(20001, 'BANK-9', 'txn_b'))).toMatchObject({ code: '23505', message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
    expect(await entryOf('balance_topup:BANK-9')).toBeUndefined();
    expect(await entryCount()).toBe(1);
  });

  test('FREQ-565-AC-01: 手数料の仕訳に元の記録を保存した時刻が渡り、未来の時刻は流した時刻に丸められて計上される', async () => {
    await start();
    const future = await seedStripeFee(db(), { createdAt: '2026-03-01T03:00:00Z', type: 'charge', reportingCategory: 'charge', amount: 5000, fee: 180,
      syncedAt: new Date(Date.now() + 86400_000).toISOString() });
    const old = await seedStripeFee(db(), { createdAt: '2026-03-01T04:00:00Z', type: 'charge', reportingCategory: 'charge', amount: 5000, fee: 180,
      syncedAt: '2026-03-02T00:00:00Z' });
    const payout = await seedStripePayout(db(), { amount: 9640, paidAt: '2026-03-01T03:00:00Z', syncedAt: '2026-03-02T00:00:00Z' });
    expect(await run()).toEqual({ posted: 3, parked_new: 0, reparked: 0, resolved: 0 });
    // Synced the day after (a recent sync of an old row is not "late" by the time of the run) and clamped for the future one.
    expect((await entryOf(`stripe:fee:${old}`)).is_late).toBe(false);
    expect(new Date((await entryOf(`stripe:fee:${old}`)).source_recorded_at).toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(new Date((await entryOf(`stripe:fee:${future}`)).source_recorded_at).getTime()).toBeLessThanOrEqual(Date.now() + 5000);
    expect((await entryOf(`payout_started:${payout}`)).is_late).toBe(false);
  });
});
