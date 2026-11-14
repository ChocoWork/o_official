/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { accountingFailure, insertAccountingAdmin } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, seedDispute, seedPaidOrder, seedStripeFee, setAsideExistingSlips, setCutoverForTest,
} from './helpers/accounting-orders-fixtures';
import {
  DISPUTE_DAYS, receiveReturn, recordRefundResult, saveFailureTxn, saveRefundTxn, seedCancelRefund, seedDisputeFlow, seedSlotPaidOrder,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 11a（S24。Ruling P3-T11a・P3-T11b）: 手で入れた仕訳と結んで「手で入れる待ち」（order_not_postable）の計上待ちを閉じる道
// （FREQ-569-AC-07）、2つ目の取り消しの確定が手で入れる待ちの0円の終わりを待たないこと（FREQ-581-AC-05）、手で閉じた返金の取引が
// Stripe の残高の照合の planned_p3 から外れること（FREQ-582-AC-06）。ROLLBACK の形（--runInBand）。
jest.setTimeout(240000);

type PendingRow = { id: string; source_id: string; reason: string; resolved_at: Date | null; resolved_by: string | null; resolved_entry_id: string | null;
  resolution_note: string | null; resolution_request_key: string | null };
type BalanceReconciliation = { difference: number; unjournaled: Array<{ kind: string; count: number; net_sum: number }> };

describeLocalDb('S24 pending manual close: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const settle = async () => { for (let i = 0; i < 4; i += 1) await q('select private.accounting_run_posting(200)'); };
  const sid = () => `src_${randomUUID().slice(0, 8)}`;
  /** 手で入れる待ち（理由 shipping）の計上待ちを、注文に付けて作る。 */
  async function parkManual(orderId: string | null, reason = 'order_not_postable', detail: unknown = { reason: 'shipping' }) {
    const id = sid();
    await q('select private.accounting_park_event($1, $2, $3, $4::uuid, $5, $6::jsonb)', ['shipment_confirmed', 'shipment_slips', id, orderId, reason,
      JSON.stringify(reason === 'order_not_postable' ? detail : {})]);
    return (await q('select * from public.accounting_pending_events where source_id = $1', [id])).rows[0] as PendingRow;
  }
  const pendingById = async (id: string) => (await q('select * from public.accounting_pending_events where id = $1', [id])).rows[0] as PendingRow;
  const link = (actor: string, event: string, entry: string, note = '手で仕訳を入れた', key: string = randomUUID()) =>
    q('select public.admin_link_accounting_pending_entry($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) as r', [actor, event, entry, note, key]);
  const fails = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  const period = async (date: string) => (await q('select private.accounting_period_for_event($1::date, null) as p', [date])).rows[0].p as string;
  /** 計画1の核で、注文の行を持つ手入力の仕訳（kind manual_entry）を作る（人が作れる道ではなく、試験の取引の中の写し）。 */
  async function manualWithOrders(orderIds: Array<string | null>, date = '2026-11-05') {
    const lines = [
      { account_code: '7530', debit: 1000, credit: 0, order_id: orderIds[0], sub_account: null, counterparty: null, memo: null },
      { account_code: '1130', debit: 0, credit: 1000, order_id: orderIds[1] ?? orderIds[0], sub_account: null, counterparty: null, memo: null },
    ];
    const r = (await q(`select private.accounting_post_journal_core(null, $1::uuid, $2::date, 'manual_entry', $3::text[], 'test manual', $4::jsonb) as r`,
      [await period(date), date, [randomUUID(), '1'], JSON.stringify(lines)])).rows[0].r as { entry_id: string };
    return r.entry_id;
  }
  /** 計画1の本当の経費の道（admin_finance_expenses の行）で作る手入力の仕訳。どの行にも注文は付かない。 */
  async function expenseFormEntry(actor: string) {
    const id = (await q(`insert into public.admin_finance_expenses (expense_date, category, item_name, amount, payment_method, created_by)
      values ('2026-11-05', 'テスト', '手で入れる', 1000, '現金', $1::uuid) returning id`, [actor])).rows[0].id as string;
    const entry = (await q(`select id from public.accounting_journal_entries where source_table = 'admin_finance_expenses' and source_id = $1::text
      and event_kind = 'manual_entry'`, [id])).rows[0];
    return entry.id as string;
  }
  const order = async () => (await seedPaidOrder(db(), { lines: [{ price: 10000, quantity: 1 }] })).orderId;

  test('FREQ-569-AC-07: 手で入れた仕訳と結んで、送料や合計の形の違いと取り消しの確定の分け方の計上待ちを閉じられ、ほかの理由は断られる', async () => {
    const admin = await insertAccountingAdmin(db());
    const orderId = await order();
    for (const detail of [{ reason: 'shipping' }, { reason: 'units_sum' }, { reason: 'units_missing' }, { reason: 'dispute_lost' }, { reason: 'return_closed_after_lost' }]) {
      const row = await parkManual(orderId, 'order_not_postable', detail);
      const entry = await manualWithOrders([orderId]);
      const key = randomUUID();
      const result = (await link(admin, row.id, entry, '手で入れた', key)).rows[0].r;
      expect(result).toMatchObject({ id: row.id, reason: 'order_not_postable', detail, resolved_entry_id: entry });
      expect(result.resolved_at).not.toBeNull();
      expect(await pendingById(row.id)).toMatchObject({ resolved_by: admin, resolved_entry_id: entry, resolution_note: '手で入れた', resolution_request_key: key });
    }
    // 同じ手入力の仕訳で、同じ注文の複数の待ちを閉じられる
    const shared = await manualWithOrders([orderId]);
    const a = await parkManual(orderId);
    const b = await parkManual(orderId, 'order_not_postable', { reason: 'units_sum' });
    await link(admin, a.id, shared);
    await link(admin, b.id, shared);
    expect([(await pendingById(a.id)).resolved_entry_id, (await pendingById(b.id)).resolved_entry_id]).toEqual([shared, shared]);
    // order_not_postable 以外の理由は断る（計画2と同じ EVENT_NOT_POSTABLE）
    for (const reason of ['payment_journal_missing', 'before_cutover', 'no_revenue', 'amount_mismatch', 'posting_error']) {
      const row = await parkManual(orderId, reason);
      expect({ reason, failure: await fails(() => link(admin, row.id, shared)) }).toEqual({ reason, failure: { code: '55000', message: 'ACCOUNTING_EVENT_NOT_POSTABLE' } });
      expect((await pendingById(row.id)).resolved_at).toBeNull();
    }
  });

  test('FREQ-569-AC-07: 結べる仕訳は取り消されていない手入力の仕訳で、注文の行を持つ時は同じ注文の物だけ', async () => {
    const admin = await insertAccountingAdmin(db());
    const orderId = await order();
    const other = await order();
    const row = await parkManual(orderId);
    const invalid = (detail: string) => ({ code: '22023', message: 'ACCOUNTING_LINK_ENTRY_INVALID', detail });
    // 無い仕訳
    expect(await fails(() => link(admin, row.id, randomUUID()))).toEqual(invalid('link_not_found'));
    // 手入力でない仕訳（計画2の支払いの仕訳）
    const posted = await seedPaidOrder(db(), { lines: [{ price: 10000, quantity: 1 }] });
    const payment = (await q(`select private.accounting_post_journal_core(null, $1::uuid, '2026-11-05'::date, 'payment_confirmed', $2::text[], 'p', $3::jsonb) as r`,
      [await period('2026-11-05'), [`pi_${randomUUID()}`], JSON.stringify([
        { account_code: '1160', debit: 500, credit: 0, order_id: posted.orderId, sub_account: null, counterparty: null, memo: null },
        { account_code: '2150', debit: 0, credit: 500, order_id: posted.orderId, sub_account: null, counterparty: null, memo: null }])])).rows[0].r.entry_id as string;
    expect(await fails(() => link(admin, row.id, payment))).toEqual(invalid('link_not_manual'));
    // 取り消す仕訳そのもの（reversal）と、取り消された仕訳
    const manual = await manualWithOrders([orderId]);
    const reversal = (await q('select private.accounting_reverse_journal_core(null, $1::uuid, $2) as r', [manual, '取り消し'])).rows[0].r.entry_id as string;
    expect(await fails(() => link(admin, row.id, reversal))).toEqual(invalid('link_not_manual'));
    expect(await fails(() => link(admin, row.id, manual))).toEqual(invalid('link_reversed'));
    // 別の注文の行だけを持つ仕訳は断り、同じ注文の行を持てば通る
    const foreign = await manualWithOrders([other]);
    expect(await fails(() => link(admin, row.id, foreign))).toEqual(invalid('link_other_order'));
    const mixed = await manualWithOrders([other, orderId]);
    expect((await link(admin, row.id, mixed)).rows[0].r.resolved_entry_id).toBe(mixed);
    // 計画1の経費の道で作った手入力の仕訳は、どの行にも注文が付かないので、注文のある待ちにも結べる（P3-T11b）
    const row2 = await parkManual(orderId);
    const expense = await expenseFormEntry(admin);
    expect((await q('select count(*)::int n from public.accounting_journal_lines where entry_id = $1 and order_id is not null', [expense])).rows[0].n).toBe(0);
    expect((await link(admin, row2.id, expense)).rows[0].r.resolved_entry_id).toBe(expense);
    // 注文のない待ち（order_id が空）は、どの手入力の仕訳にも結べる
    const orderless = await parkManual(null);
    expect((await link(admin, orderless.id, foreign)).rows[0].r.resolved_entry_id).toBe(foreign);
    // 断られた結びは何も書かない
    const untouched = await parkManual(orderId);
    expect(await fails(() => link(admin, untouched.id, foreign))).toEqual(invalid('link_other_order'));
    expect(await pendingById(untouched.id)).toMatchObject({ resolved_at: null, resolved_by: null, resolved_entry_id: null });
  });

  test('FREQ-569-AC-07: 結ぶのは権限のある人だけで、2回目はPENDING_RESOLVED、同じ要求番号の再送は前の結果', async () => {
    const admin = await insertAccountingAdmin(db());
    const orderId = await order();
    const row = await parkManual(orderId);
    const entry = await manualWithOrders([orderId]);
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await fails(() => link(randomUUID(), row.id, entry))).toEqual({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    expect(await fails(() => link(admin, row.id, entry, '   '))).toEqual(invalid);
    expect(await fails(() => link(admin, row.id, entry, 'あ'.repeat(501)))).toEqual(invalid);
    expect(await fails(() => q('select public.admin_link_accounting_pending_entry($1::uuid, $2::uuid, null, $3, $4::uuid)', [admin, row.id, 'x', randomUUID()]))).toEqual(invalid);
    expect(await fails(() => link(admin, randomUUID(), entry))).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    expect((await pendingById(row.id)).resolved_at).toBeNull();
    const key = randomUUID();
    const first = (await link(admin, row.id, entry, 'あ'.repeat(500), key)).rows[0].r;
    expect(first.resolved_entry_id).toBe(entry);
    // 同じ要求番号・同じ内容は前の結果、内容が違えば衝突
    expect((await link(admin, row.id, entry, 'あ'.repeat(500), key)).rows[0].r).toEqual(first);
    expect(await fails(() => link(admin, row.id, entry, '別のメモ', key))).toEqual({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    const other = await manualWithOrders([orderId]);
    expect(await fails(() => link(admin, row.id, other, 'あ'.repeat(500), key))).toEqual({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    // 別の要求番号の2回目は、閉じ済みで断る
    expect(await fails(() => link(admin, row.id, entry))).toEqual({ code: '55000', message: 'ACCOUNTING_PENDING_RESOLVED' });
    // 閉じた行は、計上係がもう一度止めても開き直されない
    await q('select private.accounting_park_event($1, $2, $3, $4::uuid, $5, $6::jsonb)', ['shipment_confirmed', 'shipment_slips', (await q('select source_id from public.accounting_pending_events where id = $1', [row.id])).rows[0].source_id, orderId, 'order_not_postable', '{"reason":"units_sum"}']);
    expect(await pendingById(row.id)).toMatchObject({ resolved_entry_id: entry });
    // anon・authenticated は呼べない
    for (const role of ['anon', 'authenticated']) {
      await q(`set local role ${role}`);
      const denied = await fails(() => link(admin, row.id, entry));
      await q('reset role');
      expect({ role, denied }).toEqual({ role, denied: { code: '42501', message: 'DATABASE_ERROR' } });
    }
  });

  test('FREQ-581-AC-05: 同じ注文で2つ目の取り消しが確定しても、手で入れる待ちに置いた0円の終わりを待ち続けない', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await receiveReturn(db(), d.flow, { choice: 'consult', arrivedOn: DISPUTE_DAYS.arrival,
      units: [{ return_line_id: d.flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    await d.withdraw();
    await d.lose();
    await settle();
    // 取り消し A の確定 C が入った後に、返品を0円で終えると、その終わりは手で入れる待ち（dispute_lost）に置かれる
    expect((await q('select public.admin_refund_return($1,$2,$3,0,0,null,false)', [d.flow.returnId, d.flow.f.actor, randomUUID()])).rows).toHaveLength(1);
    const fact = (await q("select id from public.accounting_return_facts where return_id = $1 and kind = 'decision' and refund_id is null", [d.flow.returnId])).rows[0].id as string;
    await settle();
    const parked = (await q(`select id, reason, detail, resolved_at from public.accounting_pending_events
      where event_kind = 'return_amount_decided' and source_id = $1`, [fact])).rows[0];
    expect(parked).toMatchObject({ reason: 'order_not_postable', detail: { reason: 'dispute_lost' }, resolved_at: null });
    // 同じ注文の2つ目の取り消し B が、0円の終わりの日（今日）に確定する。0円の終わりは開いたまま
    const pi = (await q('select payment_intent_id from public.orders where id = $1', [d.orderId])).rows[0].payment_intent_id as string;
    const second = await seedDispute(db(), { orderId: d.orderId, paymentIntentId: pi, amount: 10000, withdrawnAt: DISPUTE_DAYS.withdrawn, createdAt: DISPUTE_DAYS.withdrawn });
    // 今日の日本の日付で確定させる（0円の終わりの日と同じ日）。日本の0時の直後の1分は前の日になる
    const today = new Date(Date.now() - 60_000).toISOString();
    // 前提: 0円の終わりの日と B の確定の日が同じ日本の日付であること。日本の0時の直後の1分は B が前の日になり、解放を使わずに通ってしまうので、
    // その時は何も試さずに通らず、ここで大きく落ちる。
    const decidedOn = (await q('select decided_on::text as d from public.accounting_return_facts where id = $1', [fact])).rows[0].d as string;
    expect(decidedOn).toBe(new Date(today).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }));
    await addDisputeHistory(db(), { disputeId: second.disputeId, status: 'lost', occurredAt: today, stripeEventCreatedAt: today, eventType: 'charge.dispute.closed' });
    await settle();
    const confirmedKey = `dispute_event:${second.disputeId}:confirmed:lost`;
    const entry = (await q('select id from public.accounting_journal_entries where dedupe_key = $1', [confirmedKey])).rows[0];
    expect(entry).toBeDefined();
    const wait = (await q(`select reason from public.accounting_pending_events where event_kind = 'dispute_event' and source_id like $1`, [`%${second.disputeId}%`])).rows;
    expect(wait.filter((r) => r.reason === 'dispute_return_refund_pending')).toEqual([]);
    // B の確定の仕訳は貸借が合い、引かれた時の仮の勘定は0に戻る（A の分は A が持つ）
    const sums = (await q('select sum(debit)::int d, sum(credit)::int c from public.accounting_journal_lines where entry_id = $1', [entry.id])).rows[0];
    expect(sums.d).toBe(sums.c);
    expect(Number((await q('select private.accounting_dispute_balance($1, $2, $3) as b', [second.disputeId, '1470', 'dispute_pending'])).rows[0].b)).toBe(0);
    // 0円の終わりは開いたまま（人が手で入れるまで）
    expect((await q('select resolved_at from public.accounting_pending_events where id = $1', [parked.id])).rows[0].resolved_at).toBeNull();
    // 手で入れた仕訳と結んで閉じた後も、B はそのまま
    const admin = await insertAccountingAdmin(db());
    const manual = await manualWithOrders([d.orderId]);
    await link(admin, parked.id, manual);
    await settle();
    expect((await q('select count(*)::int n from public.accounting_journal_entries where dedupe_key = $1', [confirmedKey])).rows[0].n).toBe(1);
  });

  test('FREQ-582-AC-06: 手で閉じた返金の計上待ちの取引は、Stripe の残高の照合で planned_p3 から外れる', async () => {
    const balanceRecon = async () => (await q('select public.get_stripe_balance_reconciliation($1::date) as r', ['2026-11-30'])).rows[0].r as BalanceReconciliation;
    const planned = (r: BalanceReconciliation) => r.unjournaled.find((row) => row.kind === 'planned_p3') ?? { count: 0, net_sum: 0 };
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const a = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: o.orderItemIds[1], before: true, amount: 11250 }]);
    await settle();
    const before = await balanceRecon();
    // 切り替えを返金の取引の日より後にして、取引を作る。返金は before_cutover で止まる
    await setCutoverForTest(db(), '2026-11-10');
    await saveRefundTxn(db(), a, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), a, 'succeeded');
    await settle();
    const row = (await q("select id, reason, resolved_at from public.accounting_pending_events where source_table = 'order_refunds' and source_id = $1", [a])).rows[0];
    expect(row).toMatchObject({ reason: 'before_cutover', resolved_at: null });
    const open = await balanceRecon();
    expect([planned(open).count - planned(before).count, planned(open).net_sum - planned(before).net_sum]).toEqual([1, -11250]);
    // 手で閉じる（計画2の確認済み）と、取引は planned_p3 から外れる。差額そのものは変わらない（新しい帳簿に入らない取引）
    const admin = await insertAccountingAdmin(db());
    await q('select public.admin_resolve_accounting_pending_event($1::uuid, $2::uuid, $3, $4::uuid)', [admin, row.id, '切り替え前の返金なので確認済み', randomUUID()]);
    const closed = await balanceRecon();
    expect([planned(closed).count - planned(before).count, planned(closed).net_sum - planned(before).net_sum]).toEqual([0, 0]);
    expect(closed.difference).toBe(open.difference);
    // 返金の行が無い取引（order_refunds が無い）は、手で閉じる行が無く planned_p3 に残る（計画2 Ruling P2-T4-N1-final）
    await seedStripeFee(db(), { createdAt: '2026-11-06T03:00:00Z', type: 'refund', reportingCategory: 'refund', amount: -2000 });
    await settle();
    expect(planned(await balanceRecon()).count - planned(before).count).toBe(1);
  });

  test('FREQ-582-AC-06: 手で閉じた返金の失敗の戻りの取引（refund_failed）も planned_p3 から外れ、人の操作でない閉じは外さない', async () => {
    const balanceRecon = async () => (await q('select public.get_stripe_balance_reconciliation($1::date) as r', ['2026-11-30'])).rows[0].r as BalanceReconciliation;
    const planned = (r: BalanceReconciliation) => r.unjournaled.find((row) => row.kind === 'planned_p3') ?? { count: 0, net_sum: 0 };
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const a = await seedCancelRefund(db(), o.orderId, null, 11250, [{ item: o.orderItemIds[1], before: true, amount: 11250 }]);
    await settle();
    const before = await balanceRecon();
    // 切り替えを2つの取引の日より後にする。引かれた取引（5日）も戻りの取引（6日）も切り替え前で、返金の成功も失敗も before_cutover で止まる
    await setCutoverForTest(db(), '2026-11-10');
    await saveRefundTxn(db(), a, { at: '2026-11-05T03:00:00Z' });
    await recordRefundResult(db(), a, 'succeeded');
    await saveFailureTxn(db(), a, { at: '2026-11-06T03:00:00Z' });
    await recordRefundResult(db(), a, 'failed');
    await settle();
    const rows = (await q("select id, event_kind, reason, resolved_at from public.accounting_pending_events where source_table = 'order_refunds' and source_id = $1 order by event_kind", [a])).rows;
    expect(rows.map((r) => [r.event_kind, r.reason, r.resolved_at])).toEqual([['pre_shipment_refund', 'before_cutover', null], ['refund_failed', 'before_cutover', null]]);
    const failedRow = rows.find((r) => r.event_kind === 'refund_failed');
    const open = await balanceRecon();
    // 2つの取引（-11,250 と +11,250）が planned_p3 に入る
    expect([planned(open).count - planned(before).count, planned(open).net_sum - planned(before).net_sum]).toEqual([2, 0]);
    // 人の操作でない閉じ（resolved_by が無い）は、取引を外さない
    await q('update public.accounting_pending_events set resolved_at = now() where id = $1', [failedRow.id]);
    const automatic = await balanceRecon();
    expect([planned(automatic).count - planned(before).count, planned(automatic).net_sum - planned(before).net_sum]).toEqual([2, 0]);
    await q('update public.accounting_pending_events set resolved_at = null where id = $1', [failedRow.id]);
    // 人が閉じると、失敗の戻りの取引だけが外れる（引かれた取引は成功の行が開いたまま）
    const admin = await insertAccountingAdmin(db());
    await q('select public.admin_resolve_accounting_pending_event($1::uuid, $2::uuid, $3, $4::uuid)', [admin, failedRow.id, '切り替え前の返金の失敗なので確認済み', randomUUID()]);
    const closed = await balanceRecon();
    expect([planned(closed).count - planned(before).count, planned(closed).net_sum - planned(before).net_sum]).toEqual([1, -11250]);
  });
});
