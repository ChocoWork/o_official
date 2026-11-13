/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import { confirmSlipAt, makePeriodTaxable, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, decideRefund, postShipments, recordRefundResult, saveFailureTxn, saveRefundTxn, seedCancelRefund, seedSlotPaidOrder,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 9（S23）: 消費税用の返金の一覧（list_consumption_tax_refunds）と合計（get_consumption_tax_refund_totals）（FREQ-583 AC-01〜AC-04）。
// 行は返金のお金の行（+ は客へ出た日、− は戻った日）。一覧は期間の全部の注文を読むので、行は注文で絞り、合計は例を作る前の読みとの差で確かめる。
// 期間: 2026年の個人の期間（taxableFrom から課税）と、2027年の個人の期間（免税）。注文の支払いは 11-01、シャツの出荷は 11-02。
jest.setTimeout(240000);

type TaxRow = {
  entry_id: string; line_key: string; refund_date: string; order_id: string; order_number: string; amount: number; tax_rate: number; tax_amount: number;
  item_summary: string; original_sale_date: string | null; sale_period_status: string | null; refund_period_status: string; exclusion: string;
};
type TaxList = { rows: TaxRow[]; next_after_date: string | null; next_after_key: string | null; retention_note: string };
type Totals = { included_amount: number; included_tax: number; excluded_amount: number;
  excluded_by: { before_sale: number; sale_unbooked: number; exempt_sale_14_1_6: number; after_exit_14_1_7: number } };
const FROM = '2026-11-01';
const TO = '2027-12-31';
const ROW_KEYS = ['amount', 'entry_id', 'exclusion', 'item_summary', 'line_key', 'order_id', 'order_number', 'original_sale_date', 'refund_date',
  'refund_period_status', 'sale_period_status', 'tax_amount', 'tax_rate'];

describeLocalDb('S23 consumption tax refunds: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const settle = async () => { for (let i = 0; i < 4; i += 1) await q('select private.accounting_run_posting(200)'); };
  const list = async (limit = 200, afterDate: string | null = null, afterKey: string | null = null, from = FROM, to = TO) =>
    (await q('select public.list_consumption_tax_refunds($1::date, $2::date, $3::integer, $4::date, $5::text) as r', [from, to, limit, afterDate, afterKey]))
      .rows[0].r as TaxList;
  const totals = async (from = FROM, to = TO) =>
    (await q('select public.get_consumption_tax_refund_totals($1::date, $2::date) as r', [from, to])).rows[0].r as Totals;
  const totalsDelta = (after: Totals, before: Totals) => ({
    included_amount: after.included_amount - before.included_amount, included_tax: after.included_tax - before.included_tax,
    excluded_amount: after.excluded_amount - before.excluded_amount,
    before_sale: after.excluded_by.before_sale - before.excluded_by.before_sale,
    sale_unbooked: after.excluded_by.sale_unbooked - before.excluded_by.sale_unbooked,
    exempt_sale_14_1_6: after.excluded_by.exempt_sale_14_1_6 - before.excluded_by.exempt_sale_14_1_6,
    after_exit_14_1_7: after.excluded_by.after_exit_14_1_7 - before.excluded_by.after_exit_14_1_7,
  });
  const rowsOf = async (orderId: string) => (await list()).rows.filter((r) => r.order_id === orderId);
  const pick = (r: TaxRow) => [r.refund_date, r.amount, r.tax_amount, r.original_sale_date, r.sale_period_status, r.refund_period_status, r.exclusion];

  /**
   * 2026年の期間（taxableFrom から課税。null なら免税のまま）と2027年の期間（免税）を作り、注文 30,000円（シャツ 18,750円・パンツ 11,250円）を
   * 11-01 に支払い、シャツを 11-02 に出荷する。
   */
  async function seedOrder(taxableFrom: string | null = '2026-01-01') {
    const period = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    if (taxableFrom) await makePeriodTaxable(db(), period, taxableFrom);
    await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2027-01-01', endsOn: '2027-12-31' });
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt, pants] = o.orderItemIds;
    await confirmSlipAt(db(), o, { orderItemId: shirt, quantity: 1, shipmentDate: '2026-11-02', lockedAt: '2026-11-02T01:00:00Z' });
    await postShipments(db());
    return { orderId: o.orderId, shirt, pants };
  }
  /** シャツの出荷後の返金 2,000円（返送不要の値引き）を at に成功させる。 */
  const postRefund = async (o: { orderId: string; shirt: string }, at = '2026-11-05T03:00:00Z') => {
    const refundId = await seedCancelRefund(db(), o.orderId, null, 2000, [{ item: o.shirt, before: false, amount: 2000 }]);
    await saveRefundTxn(db(), refundId, { at });
    await recordRefundResult(db(), refundId, 'succeeded');
    await settle();
    return refundId;
  };

  test('FREQ-583-AC-01: 返金した年月日・注文番号・品の内容・税率・税額・元の売上の日が出て、名前・メール・住所の鍵が無い', async () => {
    const o = await seedOrder();
    await postRefund(o);
    const rows = await rowsOf(o.orderId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(Object.keys(row).filter((k) => /name|mail|address|phone|postal/.test(k))).toEqual([]);
    const shirtName = (await q('select item_name from public.order_items where id=$1', [o.shirt])).rows[0].item_name as string;
    expect(row).toMatchObject({ refund_date: '2026-11-05', order_number: `ORD-${o.orderId.slice(0, 8).toUpperCase()}`, amount: 2000, tax_rate: 10,
      tax_amount: 181, item_summary: `${shirtName}×1`, original_sale_date: '2026-11-02' });
    expect(row.line_key).toMatch(new RegExp(`^${row.entry_id}:\\d+$`));
  });

  test('FREQ-583-AC-01: 返金した日は残高の取引の日（振込なら振込の日）', async () => {
    const o = await seedOrder();
    // The balance transaction at 2026-11-05 16:00 UTC is 11-06 in Japan.
    await postRefund(o, '2026-11-05T16:00:00Z');
    const owed = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: o.pants, before: true, amount: 11250 }]);
    await recordRefundResult(db(), owed, 'failed');
    await settle();
    const actor = await insertAccountingAdmin(db());
    await bankTransfer(db(), { actor, orderId: o.orderId, origin: 'pre_shipment', amount: 11250, on: '2026-11-12', txn: `S23-${randomUUID().slice(0, 8)}` });
    expect((await rowsOf(o.orderId)).map((r) => [r.refund_date, r.amount])).toEqual([['2026-11-06', 2000], ['2026-11-12', 11250]]);
  });

  test('FREQ-583-AC-02: 元の売上の期間が免税の返金は exempt_sale_14_1_6 として included の合計から外れる', async () => {
    const before = await totals();
    // Taxable from 11-03: the sale of 11-02 is exempt, the refund of 11-05 taxable.
    const o = await seedOrder('2026-11-03');
    await postRefund(o);
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2026-11-05', 2000, 181, '2026-11-02', 'exempt', 'taxable', 'exempt_sale_14_1_6']]);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 0, included_tax: 0, excluded_amount: 2000, before_sale: 0, sale_unbooked: 0,
      exempt_sale_14_1_6: 2000, after_exit_14_1_7: 0 });
  });

  test('FREQ-583-AC-02: 元の売上が課税で返金した日の期間が免税なら after_exit_14_1_7 として外れる', async () => {
    const before = await totals();
    const o = await seedOrder();
    await postRefund(o, '2027-01-15T03:00:00Z');
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2027-01-15', 2000, 181, '2026-11-02', 'taxable', 'exempt', 'after_exit_14_1_7']]);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 0, included_tax: 0, excluded_amount: 2000, before_sale: 0, sale_unbooked: 0,
      exempt_sale_14_1_6: 0, after_exit_14_1_7: 2000 });
  });

  test('FREQ-583-AC-02: 出荷前の返金は before_sale として外れる', async () => {
    const before = await totals();
    const o = await seedOrder();
    const refundId = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: o.pants, before: true, amount: 11250 }]);
    await saveRefundTxn(db(), refundId, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), refundId, 'succeeded');
    await settle();
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2026-11-05', 11250, 1022, null, null, 'taxable', 'before_sale']]);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 0, included_tax: 0, excluded_amount: 11250, before_sale: 11250, sale_unbooked: 0,
      exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 });
  });

  test('FREQ-583-AC-02: 元も返金も課税の期間なら none で合計に入る', async () => {
    const before = await totals();
    const o = await seedOrder();
    await postRefund(o);
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2026-11-05', 2000, 181, '2026-11-02', 'taxable', 'taxable', 'none']]);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 2000, included_tax: 181, excluded_amount: 0, before_sale: 0, sale_unbooked: 0,
      exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 });
  });

  test('FREQ-583-AC-02: 引かれた後の失敗の戻りは − の行で出て、同じ返金の + の行と合わせて0になる', async () => {
    const before = await totals();
    const o = await seedOrder();
    const refundId = await postRefund(o);
    await saveFailureTxn(db(), refundId, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), refundId, 'failed');
    await settle();
    const rows = await rowsOf(o.orderId);
    expect(rows.map(pick)).toEqual([['2026-11-05', 2000, 181, '2026-11-02', 'taxable', 'taxable', 'none'],
      ['2026-11-07', -2000, -181, '2026-11-02', 'taxable', 'taxable', 'none']]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(0);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 0, included_tax: 0, excluded_amount: 0, before_sale: 0, sale_unbooked: 0,
      exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 });
  });

  test('FREQ-583-AC-03: 続きの目印で最後まで読め、合計が合う（二重にも抜けも無い）', async () => {
    const o = await seedOrder();
    const refundId = await postRefund(o);
    await saveFailureTxn(db(), refundId, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), refundId, 'failed');
    const pre = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: o.pants, before: true, amount: 11250 }]);
    await saveRefundTxn(db(), pre, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), pre, 'succeeded');
    await settle();
    await postRefund(o, '2027-01-15T03:00:00Z');
    const whole = (await list()).rows;
    expect(whole.filter((r) => r.order_id === o.orderId)).toHaveLength(4);
    const paged: TaxRow[] = [];
    let page = await list(1);
    for (let i = 0; i < 1000; i += 1) {
      expect(page.rows.length).toBeLessThanOrEqual(1);
      paged.push(...page.rows);
      if (page.next_after_date === null) break;
      expect(page.next_after_key).not.toBeNull();
      page = await list(1, page.next_after_date, page.next_after_key);
    }
    expect(paged).toEqual(whole);
    expect(new Set(paged.map((r) => r.line_key)).size).toBe(paged.length);
    const sum = await totals();
    expect(sum.included_amount + sum.excluded_amount).toBe(whole.reduce((s, r) => s + r.amount, 0));
    expect(sum.included_tax).toBe(whole.filter((r) => r.exclusion === 'none').reduce((s, r) => s + r.tax_amount, 0));
    expect(sum.excluded_by.before_sale + sum.excluded_by.sale_unbooked + sum.excluded_by.exempt_sale_14_1_6 + sum.excluded_by.after_exit_14_1_7)
      .toBe(sum.excluded_amount);
  });

  test('FREQ-583-AC-02: 出荷後の分で注文の出荷の仕訳が無い返金は before_sale でなく sale_unbooked として外れる（P3-T9d）', async () => {
    const before = await totals();
    const period = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    await makePeriodTaxable(db(), period, '2026-01-01');
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt] = o.orderItemIds;
    // The slip of 11-02 is before the cutover of 11-03: it is parked before_cutover and has no shipment entry.
    await confirmSlipAt(db(), o, { orderItemId: shirt, quantity: 1, shipmentDate: '2026-11-02', lockedAt: '2026-11-02T01:00:00Z' });
    await setCutoverForTest(db(), '2026-11-03');
    await postRefund({ orderId: o.orderId, shirt });
    const shipped = (await q(`select count(*)::int n from public.accounting_journal_entries e where e.event_kind in ('shipment_confirmed','shipment_redated')
      and exists (select 1 from public.accounting_journal_lines l where l.entry_id = e.id and l.order_id = $1)`, [o.orderId])).rows[0].n;
    expect(shipped).toBe(0);
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2026-11-05', 2000, 181, null, null, 'taxable', 'sale_unbooked']]);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 0, included_tax: 0, excluded_amount: 2000, before_sale: 0, sale_unbooked: 2000,
      exempt_sale_14_1_6: 0, after_exit_14_1_7: 0 });
  });

  test('FREQ-583-AC-02: 分けて送った注文の返金は、返した品の出荷の日を元の売上の日にする（P3-T9e）', async () => {
    // 2026 is exempt, 2027 taxable. The shirt ships on 2026-12-20, the pants on 2027-01-10; the pants are refunded on 2027-02-01.
    await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    const p2027 = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2027-01-01', endsOn: '2027-12-31' });
    await makePeriodTaxable(db(), p2027, '2027-01-01');
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt, pants] = o.orderItemIds;
    await confirmSlipAt(db(), o, { orderItemId: shirt, quantity: 1, shipmentDate: '2026-12-20', lockedAt: '2026-12-20T01:00:00Z' });
    await confirmSlipAt(db(), o, { orderItemId: pants, quantity: 1, shipmentDate: '2027-01-10', lockedAt: '2027-01-10T01:00:00Z' });
    await postShipments(db());
    const refundId = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: pants, before: false, amount: 11250 }]);
    await saveRefundTxn(db(), refundId, { at: '2027-02-01T03:00:00Z' });
    await recordRefundResult(db(), refundId, 'succeeded');
    await settle();
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2027-02-01', 11250, 1022, '2027-01-10', 'taxable', 'taxable', 'none']]);
  });

  test('FREQ-583-AC-02: 元の売上と返金の期間の事業の形が違う（個人の売上を法人で返金した）なら after_exit_14_1_7 として外れる（P3-T9f）', async () => {
    const before = await totals();
    const sole = await insertAccountingPeriod(db(), { businessType: 'soleProprietor', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    await makePeriodTaxable(db(), sole, '2026-01-01');
    const corporation = await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2027-01-01', endsOn: '2027-12-31' });
    await makePeriodTaxable(db(), corporation, '2027-01-01');
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const [shirt] = o.orderItemIds;
    await confirmSlipAt(db(), o, { orderItemId: shirt, quantity: 1, shipmentDate: '2026-11-02', lockedAt: '2026-11-02T01:00:00Z' });
    await postShipments(db());
    await postRefund({ orderId: o.orderId, shirt }, '2027-02-01T03:00:00Z');
    expect((await rowsOf(o.orderId)).map(pick)).toEqual([['2027-02-01', 2000, 181, '2026-11-02', 'taxable', 'taxable', 'after_exit_14_1_7']]);
    expect(totalsDelta(await totals(), before)).toEqual({ included_amount: 0, included_tax: 0, excluded_amount: 2000, before_sale: 0, sale_unbooked: 0,
      exempt_sale_14_1_6: 0, after_exit_14_1_7: 2000 });
  });

  test('FREQ-583-AC-02: 引かれた後に店が返金をやめると、成功の仕訳の取り消しが戻りの取引の日に − の行で出る', async () => {
    const o = await seedOrder();
    const refundId = await postRefund(o);
    await saveFailureTxn(db(), refundId, { at: '2026-11-07T03:00:00Z' });
    await recordRefundResult(db(), refundId, 'canceled');
    await settle();
    await decideRefund(db(), refundId, 'abandoned');
    await settle();
    const rows = await rowsOf(o.orderId);
    expect(rows.map(pick)).toEqual([['2026-11-05', 2000, 181, '2026-11-02', 'taxable', 'taxable', 'none'],
      ['2026-11-07', -2000, -181, '2026-11-02', 'taxable', 'taxable', 'none']]);
    const reversal = (await q('select reverses_entry_id from public.accounting_journal_entries where id = $1', [rows[1].entry_id])).rows[0].reverses_entry_id;
    expect(reversal).toBe(rows[0].entry_id);
  });

  test('FREQ-583-AC-01: 品を決めない返金の品の内容は注文の品（品名×数量）', async () => {
    const o = await seedOrder();
    const refundId = await seedCancelRefund(db(), o.orderId, null, 3000);
    await saveRefundTxn(db(), refundId, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), refundId, 'succeeded');
    await settle();
    const items = (await q(`select item_name || '×' || quantity as s from public.order_items where order_id = $1 and line_kind = 'order'
      order by created_at, id`, [o.orderId])).rows.map((r) => r.s as string).join(', ');
    const rows = (await rowsOf(o.orderId)).sort((a, b) => a.amount - b.amount);
    expect(rows.map((r) => [r.amount, r.exclusion])).toEqual([[1125, 'before_sale'], [1875, 'none']]);
    expect(rows.map((r) => r.item_summary)).toEqual([items, items]);
  });

  test('FREQ-583-AC-04: 7年保存の注記が応答に含まれる', async () => {
    const result = await list();
    expect(result.retention_note).toBe('消費税法施行令58条の2により7年間保存する');
    expect(Object.keys(result).sort()).toEqual(['next_after_date', 'next_after_key', 'retention_note', 'rows']);
  });

  test('FREQ-583-AC-03: 読み口は STABLE で service_role だけが呼べる', async () => {
    const reads = ['list_consumption_tax_refunds(date,date,integer,date,text)', 'get_consumption_tax_refund_totals(date,date)'];
    for (const signature of [...reads.map((s) => `public.${s}`), ...reads.map((s) => `private.${s}`), 'private.accounting_tax_refund_rows(date,date)']) {
      const p = (await q(`select provolatile, has_function_privilege('anon', $1::regprocedure, 'EXECUTE') anon,
        has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') auth, has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') service
        from pg_proc where oid = $1::regprocedure`, [signature])).rows[0];
      expect([signature, p]).toEqual([signature, { provolatile: 's', anon: false, auth: false, service: !signature.includes('accounting_tax_refund_rows') }]);
    }
    for (const [text, params] of [['select public.list_consumption_tax_refunds($1::date, $2::date, 201)', ['2026-11-01', '2026-11-30']],
      ['select public.list_consumption_tax_refunds($1::date, $2::date, 0)', ['2026-11-01', '2026-11-30']],
      ['select public.list_consumption_tax_refunds($1::date, $2::date, 10, $1::date, null)', ['2026-11-01', '2026-11-30']],
      ['select public.get_consumption_tax_refund_totals($1::date, $2::date)', ['2026-11-30', '2026-11-01']]] as Array<[string, string[]]>) {
      await q('savepoint s23_refused');
      const message = await q(text, params).then(() => null, (e: Error) => e.message);
      await q('rollback to savepoint s23_refused');
      expect([text, message]).toEqual([text, 'ACCOUNTING_ARGUMENT_INVALID']);
    }
  });
});
