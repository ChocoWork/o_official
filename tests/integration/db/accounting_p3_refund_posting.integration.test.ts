/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { seedFactSlip, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  cancelRefund, decideRefund, failRefund, orderBalance, orderLines, postOrderPayment, postRefundEvents, receiveReturn, recordRefundResult,
  refundPending, saveRefundTxn, seedCancelEvent, seedCancelRefund, takeFactSeq, seedPreShipmentCancel, seedRefundFlow, seedReturnArrivalEntries, seedReturnFlow,
  seedSlotPaidOrder, shipAndPost, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { createUbReturn, ubReceive } from './helpers/unit-binding-receive';

// 計画3 Task 6（S20）: 返金の成功の仕訳（出荷前・出荷後・返品の返金）、止める理由、計上係の入口の順と戻りの鍵。
jest.setTimeout(120000);

describeLocalDb('FREQ-577-AC-01: S20 refund posting', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  const entriesOf = async (orderId: string, kind: string) => (await orderLines(db(), orderId)).filter((l) => l.event_kind === kind);
  const shape = (rows: Array<Record<string, unknown>>) => rows.map((l) => [l.account_code, l.debit, l.credit, l.sub_account ?? null]);
  /** 写しのある2着（20,000円・17,000円）の注文に支払いの仕訳を入れ、1着を発送前に取り消した返金（17,000円）。 */
  async function pscRefund() {
    const f = await seedRefundFlow(db(), false, 2);
    await postOrderPayment(db(), f.orderId);
    const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
    return { f, ...c };
  }

  /** 出荷前の額 refunded の返金（品を名指さない）と、amount の割り当てを1つの着へ直接入れる（設計 2-4 の fixture）。 */
  async function allocatedRefund(orderId: string, orderItemId: string, amount: number, refunded = amount) {
    const refundId = (await q(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount,
      adjustment_amount, notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',$2,0,$2,false) returning id`,
    [orderId, refunded])).rows[0].id as string;
    await q("select private.accounting_record_refund_event($1,'requested')", [refundId]);
    await q(`insert into public.accounting_refund_facts(refund_id, order_id, source, event_kind, pre_shipment_amount, post_shipment_amount,
      shipping_amount) values($1,$2,'admin','none',$3,0,0)`, [refundId, orderId, refunded]);
    const n = await takeFactSeq(db());
    await q(`insert into public.accounting_unit_refund_allocations(order_item_id, unit_index, refund_key, amount, fact_seq, locked_at)
      values($1,0,$2,$3,$4,$5)`, [orderItemId, refundId, amount, n.seq, n.at]);
    return refundId;
  }

  describe('the pre-shipment refund', () => {
    test('FREQ-577-AC-01: 成功した出荷前の返金は、返金の残高の取引の日に「前受金／Stripe未収金」の1本で、印は pre_shipment_refund:<取引の番号>、前受金の行に注文番号が付く', async () => {
      const c = await pscRefund();
      const txn = await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
      expect(await postRefundEvents(db())).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 0, reversed: 0 });
      const lines = await entriesOf(c.f.orderId, 'pre_shipment_refund');
      expect(shape(lines)).toEqual([['2150', c.amount, 0, null], ['1160', 0, c.amount, null]]);
      expect(lines.every((l) => l.dedupe_key === `pre_shipment_refund:${txn}` && l.entry_date === '2026-11-05')).toBe(true);
      expect(lines.every((l) => l.order_id === c.f.orderId && l.source_table === 'order_refunds' && l.source_id === c.refundId)).toBe(true);
      expect(await orderBalance(db(), c.f.orderId, '2150')).toBe(37000 - c.amount);
      // Nothing more on the next call.
      expect(await postRefundEvents(db())).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0, reversed: 0 });
    });

    test('FREQ-577-AC-01: 日は残高の取引の日本時間の日で、店が成功を記録した時刻や orders.refunded_at を使わない', async () => {
      const c = await pscRefund();
      // 2025-12-31 23:00 UTC is 2026-01-01 in Japan; the success is recorded today and refunded_at is set to another day.
      await succeedRefund(db(), c.refundId, { at: '2025-12-31T23:00:00Z' });
      await q("update public.orders set refunded_at='2026-03-03T03:00:00Z' where id=$1", [c.f.orderId]);
      await postRefundEvents(db());
      const lines = await entriesOf(c.f.orderId, 'pre_shipment_refund');
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => l.entry_date)).toEqual(['2026-01-01', '2026-01-01']);
    });

    test('FREQ-577-AC-02: 残高不足で保留の間（残高の取引が無い）は仕訳を作らず、取引ができて同期されると次の呼び出しで1本入る', async () => {
      const c = await pscRefund();
      await recordRefundResult(db(), c.refundId, 'succeeded');
      expect(await postRefundEvents(db())).toEqual({ posted: 0, parked_new: 0, reparked: 0, resolved: 0, reversed: 0 });
      expect(await entriesOf(c.f.orderId, 'pre_shipment_refund')).toEqual([]);
      expect(await refundPending(db(), c.refundId)).toEqual([]);
      await saveRefundTxn(db(), c.refundId, { at: '2026-11-06T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(1);
      expect(await entriesOf(c.f.orderId, 'pre_shipment_refund')).toHaveLength(2);
    });

    test('FREQ-577-AC-03: 設計 2-4 の数字（パンツに出荷前の割り当て1,000円）を、割り当てを直接入れる fixture で作ると、パンツの出荷の仕訳は10,250円で、売上の累計は29,000円、前受金は0になる', async () => {
      // fixture: 設計 2-4 の割り当て（パンツの出荷前の1,000円）は今の画面では作れない（未確認 #3）ので、返金の事実と割り当ての行を直接入れる
      const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
      const [shirt, pants] = o.orderItemIds;
      const refundId = await allocatedRefund(o.orderId, pants, 1000);
      await succeedRefund(db(), refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await shipAndPost(db(), o.orderId, shirt);
      await shipAndPost(db(), o.orderId, pants);
      const shipments = await entriesOf(o.orderId, 'shipment_confirmed');
      expect(shipments.filter((l) => l.account_code === '4010').map((l) => l.credit)).toEqual([18750, 10250]);
      expect(await orderBalance(db(), o.orderId, '4010')).toBe(29000);
      expect(await orderBalance(db(), o.orderId, '2150')).toBe(0);
    });

    test('FREQ-577-AC-03: 計画2のオーナーへの報告の「ずれる」が解ける: 返金した分だけ売上が多く立つことも、前受金が残ることも無い', async () => {
      // The same numbers, the shipments first and the refund entry last: the end is the same.
      const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
      const [shirt, pants] = o.orderItemIds;
      const refundId = await allocatedRefund(o.orderId, pants, 1000);
      await shipAndPost(db(), o.orderId, shirt);
      await shipAndPost(db(), o.orderId, pants);
      await succeedRefund(db(), refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      expect(await orderBalance(db(), o.orderId, '4010')).toBe(30000 - 1000);
      expect(await orderBalance(db(), o.orderId, '2150')).toBe(0);
      expect(-(await orderBalance(db(), o.orderId, '1160'))).toBe(30000 - 1000);
    });

    test('FREQ-577-AC-05: 全額が返金で当たった着は出荷の仕訳の対象から外れ、その着の数だけ前受金が減っている', async () => {
      const c = await pscRefund();
      await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      expect(await orderBalance(db(), c.f.orderId, '2150')).toBe(37000 - c.amount);
      await shipAndPost(db(), c.f.orderId, c.f.itemId, 1, c.f.actor);
      const kept = 37000 - c.amount;
      expect((await entriesOf(c.f.orderId, 'shipment_confirmed')).filter((l) => l.account_code === '4010').map((l) => l.credit)).toEqual([kept]);
      expect(await orderBalance(db(), c.f.orderId, '2150')).toBe(0);
    });

    test('FREQ-577-AC-01: 前受金の残高を超える出荷前の返金の成功の仕訳は deferred_revenue_short で待つ', async () => {
      const c = await pscRefund();
      // The deferred revenue is taken down below the refund by a hand entry of the order (a shipment entry of another day).
      await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event('2026-11-04'::date), '2026-11-04'::date,
        'shipment_confirmed', array[$2::text], 'fixture', jsonb_build_array(
          jsonb_build_object('account_code','2150','debit',30000,'credit',0,'order_id',$1::text),
          jsonb_build_object('account_code','4010','debit',0,'credit',30000,'order_id',$1::text)))`, [c.f.orderId, randomUUID()]);
      await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      expect(await refundPending(db(), c.refundId)).toMatchObject([{ event_kind: 'pre_shipment_refund', reason: 'deferred_revenue_short',
        detail: { shortage: c.amount - (37000 - 30000) }, resolved_at: null }]);
      expect(await entriesOf(c.f.orderId, 'pre_shipment_refund')).toEqual([]);
    });
  });

  describe('the post-shipment and return refunds', () => {
    test('FREQ-579-AC-01: 返品の返金は残高の取引の日に「2130（返品の返金）／Stripe未収金」', async () => {
      const flow = await seedReturnFlow(db(), {});
      const r = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
      await seedReturnArrivalEntries(db(), flow.returnId);
      const txn = await succeedRefund(db(), r.refund_id as string, { at: '2026-11-08T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(1);
      const lines = await entriesOf(flow.f.orderId, 'return_refund');
      expect(shape(lines)).toEqual([['2130', 16875, 0, 'return_refund'], ['1160', 0, 16875, null]]);
      expect(lines.every((l) => l.dedupe_key === `return_refund:${txn}` && l.entry_date === '2026-11-08')).toBe(true);
      expect(await orderBalance(db(), flow.f.orderId, '2130', 'return_refund')).toBe(0);
    });

    test('FREQ-579-AC-01: 返送不要・お詫びの出荷後の返金は「売上値引・返品／Stripe未収金」', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const r = await hBegin(db(), f, 5000, false);
      await succeedRefund(db(), r.refund_id, { at: '2026-11-08T03:00:00Z' });
      await postRefundEvents(db());
      expect(shape(await entriesOf(f.orderId, 'return_refund'))).toEqual([['4020', 5000, 0, null], ['1160', 0, 5000, null]]);
    });

    test('FREQ-579-AC-01: 返品の届いた日の仕訳が無い返品の返金（返送不要の値引き）は 2130 を負にせず、全額が売上値引・返品に入る', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const r = await hBegin(db(), f, 17000, false);
      await succeedRefund(db(), r.refund_id, { at: '2026-11-08T03:00:00Z' });
      await postRefundEvents(db());
      expect(await orderBalance(db(), f.orderId, '2130')).toBe(0);
      expect((await orderLines(db(), f.orderId)).filter((l) => l.account_code === '2130')).toEqual([]);
      expect(-(await orderBalance(db(), f.orderId, '4020'))).toBe(17000);
    });

    test('FREQ-579-AC-01: 出荷前と出荷後が混ざった返金は pre_shipment_refund と return_refund の2本に分かれ、合計が残高の取引の額と合う', async () => {
      const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
      const [shirt, pants] = o.orderItemIds;
      await shipAndPost(db(), o.orderId, shirt);
      const refundId = await seedCancelRefund(db(), o.orderId, null, 13250,
        [{ item: pants, before: true, amount: 11250 }, { item: shirt, before: false, amount: 2000 }]);
      const txn = await succeedRefund(db(), refundId, { at: '2026-11-08T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(2);
      const pre = await entriesOf(o.orderId, 'pre_shipment_refund');
      const post = await entriesOf(o.orderId, 'return_refund');
      expect(shape(pre)).toEqual([['2150', 11250, 0, null], ['1160', 0, 11250, null]]);
      expect(shape(post)).toEqual([['4020', 2000, 0, null], ['1160', 0, 2000, null]]);
      const amount = Number((await q('select amount from public.stripe_balance_transactions where id=$1', [txn])).rows[0].amount);
      expect([...pre, ...post].filter((l) => l.account_code === '1160').reduce((s, l) => s + l.credit, 0)).toBe(-amount);
    });

    test('FREQ-579-AC-01: 残高の取引の額が返金の額と違えば amount_mismatch で止まり、仕訳を作らない', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const r = await hBegin(db(), f, 5000, false);
      await saveRefundTxn(db(), r.refund_id, { amount: 4999 });
      await recordRefundResult(db(), r.refund_id, 'succeeded');
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      expect(await refundPending(db(), r.refund_id)).toMatchObject([{ event_kind: 'return_refund', reason: 'amount_mismatch',
        detail: { mismatch: 'refund_amount' } }]);
      expect(await entriesOf(f.orderId, 'return_refund')).toEqual([]);
    });

    test('FREQ-579-AC-01: 切り替えより前・期間が無い日は before_cutover・period_missing で止まる', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const early = await hBegin(db(), f, 1000, false);
      await succeedRefund(db(), early.refund_id, { at: '2025-12-01T03:00:00Z' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      expect(await refundPending(db(), early.refund_id)).toMatchObject([{ reason: 'before_cutover' }]);
      // A corporation without a corporate period for the day: no period can be chosen or created.
      const admin = await insertAccountingAdmin(db());
      const version = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0].v;
      await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, version, randomUUID()]);
      const later = await hBegin(db(), f, 2000, false);
      await succeedRefund(db(), later.refund_id, { at: '2026-06-15T03:00:00Z' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      expect(await refundPending(db(), later.refund_id)).toMatchObject([{ reason: 'period_missing', detail: { entry_date: '2026-06-15' } }]);
      expect(await entriesOf(f.orderId, 'return_refund')).toEqual([]);
    });

    test('FREQ-579-AC-05: 返品の返金は、その返品の届いた日と額の決定の仕訳が入るまで待つ', async () => {
      const flow = await seedReturnFlow(db(), {});
      const r = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
      await succeedRefund(db(), r.refund_id as string, { at: '2026-11-08T03:00:00Z' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      expect(await refundPending(db(), r.refund_id as string)).toMatchObject([{ reason: 'refund_prior_unposted', detail: { why: 'return_prior' } }]);
      await seedReturnArrivalEntries(db(), flow.returnId);
      expect(await postRefundEvents(db())).toMatchObject({ posted: 1, resolved: 1 });
    });

    test('FREQ-579-AC-08: 前の注文から差し引いた分を返す返金（交換の設計の例10-2。1回目の注文へ 3,000円）は、返金した日に 4020 3,000／1160 3,000 の1本で、返品の届いた日・額の決定の仕訳を待たず、1回目の注文の 4020 の累計は 20,000円', async () => {
      // fixture: 例10-2 の1回目の注文の返品の届いた日までの売上値引・返品（4020 17,000円）は返品の係（Task 7）が入れるので、ここは core で直接入れ、
      // 前の注文から差し引いた分を返す返金の事実（source unit_hold_release・event_kind holdback_release）を直接書く。
      const flow = await seedReturnFlow(db(), {});
      const orderId = flow.f.orderId;
      await q(`select private.accounting_post_journal_core(null, private.accounting_period_for_event('2026-11-03'::date), '2026-11-03'::date,
        'return_arrived', array[$2::text], 'fixture', jsonb_build_array(
          jsonb_build_object('account_code','4020','debit',17000,'credit',0,'order_id',$1::text),
          jsonb_build_object('account_code','2130','debit',0,'credit',17000,'sub_account','return_refund','order_id',$1::text)))`, [orderId, randomUUID()]);
      const eventId = (await q(`insert into public.order_unit_events(order_id, kind, entitlement_previous, entitlement_max_before, entitlement_gross,
        entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund)
        values($1,'hold_release',0,0,0,0,0,0,0,3000,3000,0) returning id`, [orderId])).rows[0].id as string;
      const refundId = (await q(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount,
        adjustment_amount, notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',3000,0,3000,false) returning id`,
      [orderId])).rows[0].id as string;
      await q("select private.accounting_record_refund_event($1,'requested')", [refundId]);
      await q(`insert into public.accounting_refund_facts(refund_id, order_id, source, event_id, event_kind, pre_shipment_amount,
        post_shipment_amount, shipping_amount, fee_amount) values($1,$2,'unit_hold_release',$3,'holdback_release',0,3000,0,0)`,
      [refundId, orderId, eventId]);
      const txn = await succeedRefund(db(), refundId, { at: '2026-11-09T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(1);
      const lines = await entriesOf(orderId, 'return_refund');
      expect(shape(lines)).toEqual([['4020', 3000, 0, null], ['1160', 0, 3000, null]]);
      expect(lines.every((l) => l.dedupe_key === `return_refund:${txn}` && l.entry_date === '2026-11-09')).toBe(true);
      expect(await refundPending(db(), refundId)).toEqual([]);
      expect(-(await orderBalance(db(), orderId, '4020'))).toBe(20000);
    });
  });

  describe('the entry point and the parked rows', () => {
    test('FREQ-562-AC-05: 係の入口は支払い・出荷・Stripe・返金・取り消しの順に処理し、戻りに refunds と returns の鍵がある（returns は 0。返品の係を足す順は Task 7）', async () => {
      const src = (await q("select prosrc from pg_proc where oid='private.accounting_run_posting(integer)'::regprocedure")).rows[0].prosrc as string;
      const at = (name: string) => src.indexOf(`private.accounting_post_${name}_events(_limit)`);
      const order = ['payment', 'shipment', 'stripe', 'refund', 'dispute'].map(at);
      expect(order.every((n) => n > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const f = await seedRefundFlow(db(), true, 2);
      const r = await hBegin(db(), f, 5000, false);
      await succeedRefund(db(), r.refund_id, { at: '2026-11-08T03:00:00Z' });
      const run = (await q('select public.accounting_run_posting(50) as r')).rows[0].r;
      expect(Object.keys(run).sort()).toEqual(['disputes', 'has_more', 'parked', 'payments', 'refunds', 'resolved', 'returns', 'shipments', 'stripe']);
      expect(run).toMatchObject({ refunds: 1, returns: 0 });
    });

    test('FREQ-569-AC-02: 返金の計上待ちは、直ると次の呼び出しで入り解決済みになる', async () => {
      const flow = await seedReturnFlow(db(), {});
      const r = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
      const refundId = r.refund_id as string;
      await succeedRefund(db(), refundId, { at: '2026-11-08T03:00:00Z' });
      await postRefundEvents(db());
      expect(await refundPending(db(), refundId)).toMatchObject([{ reason: 'refund_prior_unposted', resolved_at: null }]);
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 0, reparked: 1 });
      await seedReturnArrivalEntries(db(), flow.returnId);
      expect(await postRefundEvents(db())).toEqual({ posted: 1, parked_new: 0, reparked: 0, resolved: 1, reversed: 0 });
      const [row] = await refundPending(db(), refundId);
      const entry = (await entriesOf(flow.f.orderId, 'return_refund'))[0];
      expect(row.resolved_at).not.toBeNull();
      expect(row.resolved_entry_id).toBe(entry.entry_id);
    });

    test('FREQ-569-AC-01: S20の成功・失敗・取り消しのすべてのperiod_missingでdetail.entry_dateが各枝の仕訳の日になり、返金の取り消しは戻りの取引の日になる', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const admin = await insertAccountingAdmin(db());
      const version = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0].v;
      await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, version, randomUUID()]);
      const success = (await hBegin(db(), f, 1000, false)).refund_id;
      await succeedRefund(db(), success, { at: '2026-06-15T03:00:00Z' });
      const unpulled = (await hBegin(db(), f, 1000, false)).refund_id;
      await failRefund(db(), unpulled);
      const pulled = (await hBegin(db(), f, 1000, false)).refund_id;
      await saveRefundTxn(db(), pulled, { at: '2026-06-16T03:00:00Z' });
      await recordRefundResult(db(), pulled, 'succeeded');
      await failRefund(db(), pulled, { pulled: true, at: '2026-06-20T03:00:00Z' });
      const abandoned = (await hBegin(db(), f, 1000, false)).refund_id;
      await saveRefundTxn(db(), abandoned, { at: '2026-06-17T03:00:00Z' });
      await recordRefundResult(db(), abandoned, 'succeeded');
      await cancelRefund(db(), abandoned, { pulled: true, at: '2026-06-21T03:00:00Z' });
      await decideRefund(db(), abandoned, 'abandoned', admin);
      await postRefundEvents(db());
      const parked = async (id: string, kind: string) =>
        (await refundPending(db(), id)).find((p) => p.event_kind === kind)?.detail;
      const today = (await q("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d;
      expect(await parked(success, 'return_refund')).toEqual({ entry_date: '2026-06-15' });
      expect(await parked(unpulled, 'refund_failed')).toEqual({ entry_date: today });
      expect(await parked(pulled, 'refund_failed')).toEqual({ entry_date: '2026-06-20' });
      expect(await parked(abandoned, 'refund_abandoned')).toEqual({ entry_date: '2026-06-21' });
      expect(await orderLines(db(), f.orderId)).toEqual([]);
    });
  });
  describe('rule 3: the event of a pre-shipment cancel', () => {
    /** 2つの品（20,000円・17,000円）の注文。cheapShipped なら 17,000円の着を先に送り（出荷の仕訳あり）、20,000円の着を返す出来事
     * （割り振り 20,000円・残る着の直し +3,000円・返す額 17,000円）と、それに結んだ返金 A を交換の設計の記録として直接入れる。 */
    async function dEvent(cheapShipped: boolean) {
      const o = await seedSlotPaidOrder(db(), [[20000], [17000]]);
      const [dear, cheap] = o.orderItemIds;
      if (cheapShipped) await shipAndPost(db(), o.orderId, cheap);
      const eventId = await seedCancelEvent(db(), o.orderId, [{ item: dear, unit: 0, kind: 'returned', allocation: 20000 },
        { item: cheap, unit: 0, kind: 'kept', correction: 3000, shipped: cheapShipped }], 17000);
      const refundId = await seedCancelRefund(db(), o.orderId, eventId, 17000);
      return { ...o, dear, cheap, eventId, refundId };
    }
    /** 同じ出来事のやり直しの返金（計画3 Task 3 の試験と同じく、結びは fixture で直接入れる）。 */
    async function retryOf(orderId: string, eventId: string, amount: number) {
      const retry = (await q(`insert into public.order_refunds(order_id,source,request_key,request_fingerprint,status,amount,notify_customer)
        values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',$2,false) returning id`, [orderId, amount])).rows[0].id as string;
      await q("insert into public.order_unit_event_refunds(event_id,refund_id,part) values($1,$2,'now')", [eventId, retry]);
      await q("select private.accounting_record_refund_event($1,'requested')", [retry]);
      // The retry points at the same event and allocation (Q6): its fact copies the first refund's P and Q.
      await q(`insert into public.accounting_refund_facts(refund_id, order_id, source, event_id, event_kind, pre_shipment_amount, post_shipment_amount,
        shipping_amount) select $1, f.order_id, f.source, f.event_id, f.event_kind, f.pre_shipment_amount, f.post_shipment_amount, 0
        from public.accounting_refund_facts f join public.order_unit_event_refunds er on er.refund_id=f.refund_id
        where er.event_id=$2 and f.refund_id<>$1 order by f.created_at limit 1`, [retry, eventId]);
      return retry;
    }
    const factOf = async (refundId: string) => (await q('select * from public.accounting_refund_facts where refund_id=$1', [refundId])).rows[0];

    test('FREQ-577-AC-10: 出荷済みの着が残る取り消し（20,000円と17,000円）の返金の成功の仕訳に 2150 3,000／4010 3,000 が入り、売上は20,000円、前受金は0。やり直しの返金の仕訳には d が入らない', async () => {
      // fixture: 出荷済みの着は番号の若い着から決まる（裁定 P3-6）ので、同じ品の2着では 17,000円の着だけを先に送れない（計画3 Task 3 と同じ作り）
      const e = await dEvent(true);
      const txn = await succeedRefund(db(), e.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      const lines = (await orderLines(db(), e.orderId)).filter((l) => l.dedupe_key === `pre_shipment_refund:${txn}`);
      expect(shape(lines)).toEqual([['2150', 17000, 0, null], ['1160', 0, 17000, null], ['2150', 3000, 0, null], ['4010', 0, 3000, null]]);
      expect(lines.every((l) => l.order_id === e.orderId)).toBe(true);
      expect(await orderBalance(db(), e.orderId, '4010')).toBe(20000);
      expect(await orderBalance(db(), e.orderId, '2150')).toBe(0);
      // A retry of the same event carries no d: its success entry waits for the deferred revenue of its own P only.
      const retry = await retryOf(e.orderId, e.eventId, 17000);
      await succeedRefund(db(), retry, { at: '2026-11-06T03:00:00Z' });
      await postRefundEvents(db());
      const p = (await factOf(retry)).pre_shipment_amount as number;
      expect(await refundPending(db(), retry)).toMatchObject([{ event_kind: 'pre_shipment_refund', reason: 'deferred_revenue_short', detail: { shortage: p } }]);
    });

    test('FREQ-577-AC-10: まだ送っていない着が残る取り消しは、その着の出荷の仕訳が今の値段（支払額＋直し）で入り、前受金は0', async () => {
      const e = await dEvent(false);
      await succeedRefund(db(), e.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      expect(shape(await entriesOf(e.orderId, 'pre_shipment_refund'))).toEqual([['2150', 17000, 0, null], ['1160', 0, 17000, null]]);
      await shipAndPost(db(), e.orderId, e.cheap);
      expect((await entriesOf(e.orderId, 'shipment_confirmed')).filter((l) => l.account_code === '4010').map((l) => l.credit)).toEqual([20000]);
      expect(await orderBalance(db(), e.orderId, '2150')).toBe(0);
    });

    test('FREQ-579-AC-07: 発送前の取り消しの返金を店がやめると（引かれる前・引かれた後）、止めた日に売上の仕訳が無く（引かれた後は成功の仕訳の取り消しだけ）、その着を後で送ると出荷の仕訳が支払額で入り、前受金が0', async () => {
      for (const pulled of [false, true]) {
        await q('savepoint s20_case');
        const c = await pscRefund();
        if (pulled) {
          await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
          await postRefundEvents(db());
        }
        await cancelRefund(db(), c.refundId, { pulled, at: '2026-11-07T03:00:00Z' });
        await decideRefund(db(), c.refundId, 'abandoned');
        await postRefundEvents(db());
        const kinds = [...new Set((await orderLines(db(), c.f.orderId)).map((l) => `${l.event_kind}:${l.entry_id}`))].map((k) => k.split(':')[0]);
        expect(kinds).toEqual(pulled ? ['payment_confirmed', 'pre_shipment_refund', 'reversal'] : ['payment_confirmed']);
        expect((await orderLines(db(), c.f.orderId)).filter((l) => l.account_code === '4010')).toEqual([]);
        await shipAndPost(db(), c.f.orderId, c.f.itemId, 2, c.f.actor);
        expect((await entriesOf(c.f.orderId, 'shipment_confirmed')).filter((l) => l.account_code === '4010').reduce((s, l) => s + l.credit, 0)).toBe(37000);
        expect(await orderBalance(db(), c.f.orderId, '2150')).toBe(0);
        await q('rollback to savepoint s20_case');
      }
    });

    test('FREQ-579-AC-07: 戻せなかった額 s がある時だけ、区分の仕訳に 2150 s／4010 s が入り、s は区分の行に残った額のまま', async () => {
      // s ≠ 0: 品を指定しない返金の割り当てが当たった後に出荷された着は戻せない（計画3 Task 3 の試験と同じ作り）
      const f = await seedRefundFlow(db(), 1);
      const refundId = (await q(`select * from public.begin_order_refund($1,'admin',$2,'[]'::jsonb,false,0,1000,null,'requested_by_customer',null,false,$3,null,null)`,
        [f.orderId, randomUUID(), f.actor])).rows[0].refund_id as string;
      await seedFactSlip(db(), { orderItemId: f.itemId, quantity: 1 });
      await cancelRefund(db(), refundId);
      await decideRefund(db(), refundId, 'abandoned');
      const s = (await q("select release_shortfall from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [refundId])).rows[0].release_shortfall;
      expect(s).not.toBe(0);
      await postRefundEvents(db());
      const lines = await entriesOf(f.orderId, 'refund_abandoned');
      expect(shape(lines)).toEqual([['2150', s, 0, null], ['4010', 0, s, null]]);
      expect((await q("select release_shortfall from public.accounting_refund_events where refund_id=$1 and state='abandoned'", [refundId])).rows[0].release_shortfall).toBe(s);
      // s = 0: nothing is booked.
      const c = await pscRefund();
      await cancelRefund(db(), c.refundId);
      await decideRefund(db(), c.refundId, 'abandoned');
      await postRefundEvents(db());
      expect(await entriesOf(c.f.orderId, 'refund_abandoned')).toEqual([]);
    });

    test('FREQ-577-AC-10: 出荷済みの残る着がある取り消し（d = +3,000）で、最初の返金 A を引かれる前に Stripe が取り消し、同じ出来事のやり直しの返金 B が成功した後に A をやめると、A の区分の仕訳に 2150 3,000／4010 3,000 が入り、注文の 2150 が0、売上は手元の服の値段', async () => {
      const e = await dEvent(true);
      await cancelRefund(db(), e.refundId);
      const b = await retryOf(e.orderId, e.eventId, 17000);
      await succeedRefund(db(), b, { at: '2026-11-06T03:00:00Z' });
      await decideRefund(db(), e.refundId, 'abandoned');
      for (let i = 0; i < 3; i += 1) await postRefundEvents(db());
      expect(shape(await entriesOf(e.orderId, 'refund_abandoned'))).toEqual([['2150', 3000, 0, null], ['4010', 0, 3000, null]]);
      expect((await entriesOf(e.orderId, 'pre_shipment_refund')).filter((l) => l.account_code === '4010')).toEqual([]);
      expect(await orderBalance(db(), e.orderId, '2150')).toBe(0);
      expect(await orderBalance(db(), e.orderId, '4010')).toBe(20000);
    });

    test('FREQ-577-AC-10: 同じ例で A が引かれた後（d を持つ成功の仕訳あり）に Stripe が取り消し、B が成功した後に A をやめると、A の成功の仕訳の取り消しで消えた d が区分の仕訳で立て直り、注文の 2150 が0', async () => {
      const e = await dEvent(true);
      await succeedRefund(db(), e.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await cancelRefund(db(), e.refundId, { pulled: true, at: '2026-11-07T03:00:00Z' });
      const b = await retryOf(e.orderId, e.eventId, 17000);
      await succeedRefund(db(), b, { at: '2026-11-08T03:00:00Z' });
      await decideRefund(db(), e.refundId, 'abandoned');
      for (let i = 0; i < 3; i += 1) await postRefundEvents(db());
      const reversal = (await orderLines(db(), e.orderId)).filter((l) => l.event_kind === 'reversal');
      expect(reversal.filter((l) => l.account_code === '4010').map((l) => l.debit)).toEqual([3000]);
      expect(shape(await entriesOf(e.orderId, 'refund_abandoned'))).toEqual([['2150', 3000, 0, null], ['4010', 0, 3000, null]]);
      expect(await orderBalance(db(), e.orderId, '2150')).toBe(0);
      expect(await orderBalance(db(), e.orderId, '4010')).toBe(20000);
    });

    test('FREQ-577-AC-03: 受け取りで残る着の値段が上がった後にその着を発送前に取り消すと、返金は 2150（V_P まで）と 4020／1160（超えた分）の2本で入り、前受金は0、売上の累計は手元に残る服の値段、計上待ちは0', async () => {
      // fixture: 受け取りで上がった記録の値段（12,000円）を交換の設計の関数で作る代わりに、出来事の割り振りを直接入れる（計画3 Task 3 と同じ作り）
      const o = await seedSlotPaidOrder(db(), [[10000, 10000]]);
      const [item] = o.orderItemIds;
      const eventId = await seedCancelEvent(db(), o.orderId, [{ item, unit: 0, kind: 'returned', allocation: 12000 }]);
      const refundId = await seedCancelRefund(db(), o.orderId, eventId, 12000);
      const txn = await succeedRefund(db(), refundId, { at: '2026-11-05T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(2);
      expect(shape((await orderLines(db(), o.orderId)).filter((l) => l.dedupe_key === `pre_shipment_refund:${txn}`)))
        .toEqual([['2150', 10000, 0, null], ['1160', 0, 10000, null]]);
      expect(shape((await orderLines(db(), o.orderId)).filter((l) => l.dedupe_key === `return_refund:${txn}`)))
        .toEqual([['4020', 2000, 0, null], ['1160', 0, 2000, null]]);
      await shipAndPost(db(), o.orderId, item, 1);
      expect(await orderBalance(db(), o.orderId, '2150')).toBe(0);
      expect(await orderBalance(db(), o.orderId, '4010') + await orderBalance(db(), o.orderId, '4020')).toBe(20000 - 12000);
      expect((await q('select count(*)::int n from public.accounting_pending_events where order_id=$1 and resolved_at is null', [o.orderId])).rows[0].n).toBe(0);
    });

    test('FREQ-577-AC-02: 注文の着が全部送られたか出荷前に返金された後に前受金が残る注文（明細より少ない返金など）は、前受金の異常の一覧に出る', async () => {
      const o = await seedSlotPaidOrder(db(), [[10000], [10000]]);
      const [first, second] = o.orderItemIds;
      // fixture: 着の全額（10,000円）の割り当てに、規約の手数料を引いた 9,000円の返金（割り当てと事実を直接入れる）
      const refundId = await allocatedRefund(o.orderId, first, 10000, 9000);
      await succeedRefund(db(), refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await shipAndPost(db(), o.orderId, second);
      expect(await orderBalance(db(), o.orderId, '2150')).toBe(1000);
      const { anomalies } = (await q('select public.list_deferred_revenue_anomalies() as r')).rows[0].r as { anomalies: Array<Record<string, unknown>> };
      expect(anomalies.filter((a) => a.order_id === o.orderId)).toMatchObject([{ balance: 1000, reason: 'balance_after_all_shipped_or_refunded' }]);
    });
  });

  describe('exchange items and hold-back releases', () => {
    /** 2着とも出荷した注文の1着を交換の返品で受け取り、交換の品を発送前に取り消した返金（事実は Q だけ、event_kind pre_shipment_cancel）。 */
    async function exchangeCancel() {
      const f = await seedRefundFlow(db(), true);
      const ex = await createUbReturn(db(), f, [{ quantity: 1, exchange: true }]);
      const received = await ubReceive(db(), { returnId: ex.returnId, actorId: f.actor, choice: 'none',
        units: [{ return_line_id: ex.lineIds[0], disposition: 'not_restocked', quantity: 1 }] });
      const exchangeItemId = received.exchange_order_item_ids[0] as string;
      const c = await seedPreShipmentCancel(db(), f, { itemId: exchangeItemId, quantity: 1 });
      return { f, ...c, returnId: ex.returnId };
    }

    test('FREQ-577-AC-03: 交換の品だけを発送前に取り消した返金（元の着は出荷済み）は、返金した日に 4020／1160 の1本で入り、前受金は0、売上は手元の服の値段、計上待ちは0', async () => {
      const c = await exchangeCancel();
      const txn = await succeedRefund(db(), c.refundId, { at: '2026-11-09T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(1);
      const lines = await orderLines(db(), c.f.orderId);
      expect(shape(lines)).toEqual([['4020', c.amount, 0, null], ['1160', 0, c.amount, null]]);
      expect(lines.every((l) => l.dedupe_key === `return_refund:${txn}` && l.entry_date === '2026-11-09')).toBe(true);
      expect(await orderBalance(db(), c.f.orderId, '2150')).toBe(0);
      expect(await refundPending(db(), c.refundId)).toEqual([]);
      expect((await q('select count(*)::int n from public.accounting_pending_events where order_id=$1 and resolved_at is null', [c.f.orderId])).rows[0].n).toBe(0);
    });

    test('FREQ-579-AC-08: 交換を返金に変えた返金（交換の品の行の発送前の取り消し。事実の event_kind は pre_shipment_cancel）は、返品の届いた日の仕訳を待たず、返金した日に 4020／1160 の1本', async () => {
      const c = await exchangeCancel();
      expect((await orderLines(db(), c.f.orderId)).filter((l) => l.event_kind === 'return_arrived')).toEqual([]);
      expect((await q('select event_kind from public.accounting_refund_facts where refund_id=$1', [c.refundId])).rows[0].event_kind).toBe('pre_shipment_cancel');
      await succeedRefund(db(), c.refundId, { at: '2026-11-09T03:00:00Z' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 1, parked_new: 0 });
      expect(shape(await entriesOf(c.f.orderId, 'return_refund'))).toEqual([['4020', c.amount, 0, null], ['1160', 0, c.amount, null]]);
    });

    test('FREQ-579-AC-08: その返金が引かれる前に失敗すると 4020／2130（refund_owed_post）の借りが立つ', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const eventId = (await q(`insert into public.order_unit_events(order_id, kind, entitlement_previous, entitlement_max_before, entitlement_gross,
        entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund)
        values($1,'hold_release',0,0,0,0,0,0,0,3000,3000,0) returning id`, [f.orderId])).rows[0].id as string;
      const refundId = (await q(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount,
        adjustment_amount, notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',3000,0,3000,false) returning id`,
      [f.orderId])).rows[0].id as string;
      await q("select private.accounting_record_refund_event($1,'requested')", [refundId]);
      await q(`insert into public.accounting_refund_facts(refund_id, order_id, source, event_id, event_kind, pre_shipment_amount,
        post_shipment_amount, shipping_amount, fee_amount) values($1,$2,'unit_hold_release',$3,'holdback_release',0,3000,0,0)`, [refundId, f.orderId, eventId]);
      await failRefund(db(), refundId);
      expect((await postRefundEvents(db())).posted).toBe(1);
      expect(shape(await entriesOf(f.orderId, 'refund_failed'))).toEqual([['4020', 3000, 0, null], ['2130', 0, 3000, 'refund_owed_post']]);
    });
  });
});
