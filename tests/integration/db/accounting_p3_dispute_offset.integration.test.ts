/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { accountingFailure, insertAccountingAdmin, insertAccountingPeriod } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, recordSlipFactAt, seedConfirmedSlip, seedDispute, seedDisputeReversal, seedPostedPayment, setAsideExistingSlips,
  setCutoverForTest,
} from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, correctArrival, DISPUTE_DAYS, orderBalance, receiveReturn, recordRefundResult, seedDisputeFlow, setRefundCreatedAt,
  succeedRefund, type DisputeFlow,
} from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 8（S22）: カード会社の取り消しの確定（C）を、注文の返品の返金待ち（2130 return_refund の残高 R）と出荷後の返金済みの額（Z）と
// 相殺する。引かれた時（W）の2つの止めは外れ、その理由は C の待ちに移る（FREQ-581）。ROLLBACK の形（--runInBand）。
// 土台は seedDisputeFlow: 2着（20,000円と18,750円）の写しのある注文を両方送り、18,750円の1着を手数料 10% で返品する（G = 18,750・F = 1,875・
// 返金待ち R = 16,875）。取り消しの額 A = 30,000（両方出荷済みなので S = 30,000・U = 0）、原因（fraudulent）の科目は 7530。
// 日付は2026年11月（返品の届いた日と振込の日は今日より後にできない）: 引かれた時 11-03、届いた日 11-05、返金 11-06、振込 11-07、確定 11-09。
jest.setTimeout(240000);

type PendingRow = { reason: string; detail: Record<string, unknown>; resolved_at: Date | null; resolved_entry_id: string | null };

describeLocalDb('S22 dispute offset: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  /** 計上係の入口を何度か流す（返品 → 返金 → 取り消しの順に流れるので、待っていた物が次の回に入る）。 */
  const settle = async () => { for (let i = 0; i < 4; i += 1) await q('select private.accounting_run_posting(200)'); };
  const runDisputes = async () => (await q('select private.accounting_post_dispute_events(200) as r')).rows[0].r as Record<string, number>;
  const key = (dispute: string, stage: string, ref: string) => `dispute_event:${dispute}:${stage}:${ref}`;
  const entryOf = async (dedupeKey: string) => (await q(
    "select id, event_kind, to_char(entry_date, 'YYYY-MM-DD') as entry_date from public.accounting_journal_entries where dedupe_key = $1",
    [dedupeKey])).rows[0] as { id: string; event_kind: string; entry_date: string } | undefined;
  /** `account(sub):debit/credit` per line, in line order. */
  const summary = async (dedupeKey: string) => {
    const entry = await entryOf(dedupeKey);
    if (!entry) return null;
    return (await q('select account_code, sub_account, debit::int as debit, credit::int as credit from public.accounting_journal_lines where entry_id = $1 order by line_no',
      [entry.id])).rows.map((l) => `${l.account_code}${l.sub_account ? `(${l.sub_account})` : ''}:${l.debit}/${l.credit}`);
  };
  const memos = async (dedupeKey: string) => (await q(
    'select l.memo from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id where e.dedupe_key = $1 order by l.line_no',
    [dedupeKey])).rows.map((r) => r.memo as string | null);
  const confirmed = (d: DisputeFlow) => summary(key(d.disputeId, 'confirmed', 'lost'));
  const pendingOf = async (sourceTable: string, sourceId: string): Promise<PendingRow | undefined> => (await q(
    `select reason, detail, resolved_at, resolved_entry_id from public.accounting_pending_events
     where event_kind = 'dispute_event' and source_table = $1 and source_id = $2`, [sourceTable, sourceId])).rows[0];
  const balance = async (dispute: string, account: string, sub: string | null) => Number((await q(
    'select private.accounting_dispute_balance($1, $2, $3) as b', [dispute, account, sub])).rows[0].b);
  /** 注文の「分けて調べる」補助（1470 dispute_refund_overlap_review）の借方の残高。 */
  const reviewOf = async (orderId: string) => Number((await q(
    "select coalesce(sum(debit - credit), 0)::int as n from public.accounting_journal_lines where order_id = $1 and account_code = '1470' and sub_account = 'dispute_refund_overlap_review'",
    [orderId])).rows[0].n);
  const payableOf = (orderId: string) => orderBalance(db(), orderId, '2130', 'return_refund');
  /** 断られた時の { code, message, detail }（取引は savepoint で戻す）。断られなければ null。 */
  async function failure(run: () => Promise<unknown>) {
    await q('savepoint s22_failure');
    try { await run(); return null; } catch (e) {
      const { code, message, detail } = e as { code: string; message: string; detail?: string };
      return { code, message, detail };
    } finally { await q('rollback to savepoint s22_failure'); await q('release savepoint s22_failure'); }
  }
  const disputeEntryCount = async (dispute: string) => Number((await q(
    'select count(*) as n from public.accounting_journal_entries where starts_with(dedupe_key, $1)', [`dispute_event:${dispute}:`])).rows[0].n);

  const unit = (d: DisputeFlow, choice: 'now' | 'consult') =>
    [{ return_line_id: d.flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: choice }];
  /** 返金を作らない受け取り（相談）: 届いた日の仕訳の後に返金待ち R = 16,875 が残る。 */
  const consultReceipt = (d: DisputeFlow, arrivedOn: string = DISPUTE_DAYS.arrival) =>
    receiveReturn(db(), d.flow, { choice: 'consult', arrivedOn, units: unit(d, 'consult') });
  /** 今すぐ返金する受け取り: 返金 16,875円を作り、作った時刻を届いた日（確定の日より前）にする。 */
  const nowReceipt = async (d: DisputeFlow) => {
    const r = await receiveReturn(db(), d.flow, { choice: 'now', arrivedOn: DISPUTE_DAYS.arrival, units: unit(d, 'now') });
    if (!r.refund_id) throw new Error('NOW_RECEIPT_WITHOUT_REFUND');
    await setRefundCreatedAt(db(), r.refund_id, '2026-11-05T03:00:00Z');
    return r.refund_id;
  };

  // ---- AC-01: the withdrawal no longer stops -----------------------------------------------------------------------------
  test('FREQ-581-AC-01: 返品の返金待ちがある注文でも、成功した返金がある注文でも、引かれた時の仕訳は止まらず入る', async () => {
    // 返品の返金待ち（2130 return_refund 16,875）がある注文
    const waiting = await seedDisputeFlow(db());
    await consultReceipt(waiting);
    await settle();
    expect(await payableOf(waiting.orderId)).toBe(16875);
    const waitingTxn = await waiting.withdraw();
    // 成功した返金（16,875円）がある注文
    const paid = await seedDisputeFlow(db());
    const refundId = await nowReceipt(paid);
    await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
    await settle();
    expect(Number((await q("select count(*) n from public.stripe_refunds where order_id = $1 and status = 'succeeded'", [paid.orderId])).rows[0].n)).toBe(1);
    const paidTxn = await paid.withdraw();
    await settle();
    for (const [d, txn] of [[waiting, waitingTxn], [paid, paidTxn]] as const) {
      expect(await summary(key(d.disputeId, 'withdrawn', txn))).toEqual(['1160:0/30000', '1470(dispute_pending):30000/0']);
      expect(await pendingOf('stripe_balance_transactions', txn)).toBeUndefined();
      expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(30000);
    }
  });

  // ---- AC-02: the return payable R is cleared first -------------------------------------------------------------------------
  test('FREQ-581-AC-02: 返品の届いた日の仕訳が入り返金待ちが16,875円ある注文は、確定で「2130（返品の返金）16,875／1470（判断待ち）16,875」と残り13,125円の費用が入る', async () => {
    const d = await seedDisputeFlow(db());
    await consultReceipt(d);
    await d.withdraw();
    await settle();
    await d.lose();
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/30000']);
    expect(await memos(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['dispute_reason:fraudulent', 'offset_pay:16875', 'dispute_lost_at:2026-11-09T03:00:00Z']);
    expect((await entryOf(key(d.disputeId, 'confirmed', 'lost')))?.entry_date).toBe(DISPUTE_DAYS.lostOn);
    expect(await payableOf(d.orderId)).toBe(0);
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(0);
    expect(await reviewOf(d.orderId)).toBe(0);
  });

  test('FREQ-581-AC-02: 引かれた額が返金待ちより小さい（S = 10,000）なら10,000円だけ未払金を消し、費用は立たず、未払金が6,875円残る', async () => {
    const d = await seedDisputeFlow(db(), { amount: 10000 });
    await consultReceipt(d);
    await d.withdraw();
    await settle();
    await d.lose();
    await settle();
    expect(await confirmed(d)).toEqual(['2130(return_refund):10000/0', '1470(dispute_pending):0/10000']);
    expect(await memos(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['offset_pay:10000', 'dispute_lost_at:2026-11-09T03:00:00Z']);
    expect(await payableOf(d.orderId)).toBe(6875);
    expect(await balance(d.disputeId, '7530', null)).toBe(0);
  });

  // ---- AC-03: the refunds already paid (Z) go to the review sub-account --------------------------------------------------------
  test('FREQ-581-AC-03: 返品の返金16,875円が済んだ後の確定は、16,875円を「分けて調べる」の補助に移し、費用は13,125円だけ', async () => {
    const d = await seedDisputeFlow(db());
    const refundId = await nowReceipt(d);
    await d.withdraw();
    await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
    await settle();
    expect(await payableOf(d.orderId)).toBe(0);
    await d.lose();
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '1470(dispute_refund_overlap_review):16875/0', '1470(dispute_pending):0/30000']);
    expect(await memos(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['dispute_reason:fraudulent', 'offset_review:16875', 'dispute_lost_at:2026-11-09T03:00:00Z']);
    expect(await reviewOf(d.orderId)).toBe(16875);
    expect(await balance(d.disputeId, '1470', 'dispute_refund_overlap_review')).toBe(16875);
  });

  test('FREQ-581-AC-03: 返金待ち6,875円と返金済み10,000円が混ざる時は、先に返金待ちを消し、次に返金済みと重なる分を移し、残りだけが費用', async () => {
    const d = await seedDisputeFlow(db());
    await consultReceipt(d);
    await settle();
    // 返金待ち 16,875 のうち 10,000円を銀行振込で返した（11-07。確定の日より前）
    await bankTransfer(db(), { actor: d.admin, orderId: d.orderId, origin: 'return', amount: 10000, on: DISPUTE_DAYS.bank, txn: `S22-${randomUUID().slice(0, 8)}` });
    expect(await payableOf(d.orderId)).toBe(6875);
    await d.withdraw();
    await d.lose();
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '2130(return_refund):6875/0', '1470(dispute_refund_overlap_review):10000/0',
      '1470(dispute_pending):0/30000']);
    expect(await payableOf(d.orderId)).toBe(0);
    expect(await reviewOf(d.orderId)).toBe(10000);
  });

  test('FREQ-581-AC-03: 返品でない出荷後の返金5,000円がある注文は、5,000円が分けて調べる補助に移り、費用は25,000円', async () => {
    const d = await seedDisputeFlow(db());
    const r = await hBegin(db(), d.flow.f as never, 5000, false);
    await setRefundCreatedAt(db(), r.refund_id, '2026-11-05T03:00:00Z');
    await d.withdraw();
    await succeedRefund(db(), r.refund_id, { at: DISPUTE_DAYS.refund });
    await d.lose();
    await settle();
    expect(-(await orderBalance(db(), d.orderId, '4020'))).toBe(5000);
    expect(await confirmed(d)).toEqual(['7530:25000/0', '1470(dispute_refund_overlap_review):5000/0', '1470(dispute_pending):0/30000']);
    expect(await reviewOf(d.orderId)).toBe(5000);
  });

  test('FREQ-581-AC-03: 別の dispute で使った分は、同じ返金済みの額を二重に使わない', async () => {
    // 同じ支払いに 10,000円の取り消しが2つ。返品の返金 16,875円は済んでいる
    const first = await seedDisputeFlow(db(), { amount: 10000 });
    const refundId = await nowReceipt(first);
    const pi = (await q('select payment_intent_id from public.orders where id = $1', [first.orderId])).rows[0].payment_intent_id as string;
    const second = await seedDispute(db(), { orderId: first.orderId, paymentIntentId: pi, amount: 10000, withdrawnAt: DISPUTE_DAYS.withdrawn,
      createdAt: DISPUTE_DAYS.withdrawn });
    await first.withdraw();
    await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
    await settle();
    await first.lose();
    await settle();
    expect(await confirmed(first)).toEqual(['1470(dispute_refund_overlap_review):10000/0', '1470(dispute_pending):0/10000']);
    await addDisputeHistory(db(), { disputeId: second.disputeId, status: 'lost', occurredAt: '2026-11-09T05:00:00Z', stripeEventCreatedAt: DISPUTE_DAYS.lost,
      eventType: 'charge.dispute.closed' });
    await settle();
    // Z = 16,875 − すでに補助に移した 10,000 = 6,875。残り 3,125 だけが費用
    expect(await summary(key(second.disputeId, 'confirmed', 'lost'))).toEqual(['7530:3125/0', '1470(dispute_refund_overlap_review):6875/0',
      '1470(dispute_pending):0/10000']);
    expect(await reviewOf(first.orderId)).toBe(16875);
  });

  // ---- AC-04: the late reversal goes back in the order cost → review → payable -------------------------------------------------
  test('FREQ-581-AC-04: 返品の返金待ちを消して確定した後に全額が遅れて取り下げられると、費用の科目13,125円、返金待ち16,875円（未払金を元に戻す）の順に戻り、補助とどの科目も0かの元の状態になる', async () => {
    const d = await seedDisputeFlow(db());
    await consultReceipt(d);
    await d.withdraw();
    await settle();
    await d.lose();
    await settle();
    expect(await payableOf(d.orderId)).toBe(0);
    const reversal = await d.reverse(30000, DISPUTE_DAYS.late);
    await settle();
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '7530:0/13125', '2130(return_refund):0/16875']);
    expect(await payableOf(d.orderId)).toBe(16875);
    expect([await balance(d.disputeId, '1470', 'dispute_pending'), await balance(d.disputeId, '7530', null),
      await balance(d.disputeId, '1470', 'dispute_refund_overlap_review'), await balance(d.disputeId, '2130', 'return_refund')]).toEqual([0, 0, 0, 0]);
    expect(await reviewOf(d.orderId)).toBe(0);
  });

  test('FREQ-581-AC-04: 分けて調べる補助に移した分は、費用の科目の次に戻る', async () => {
    const d = await seedDisputeFlow(db());
    await consultReceipt(d);
    await settle();
    await bankTransfer(db(), { actor: d.admin, orderId: d.orderId, origin: 'return', amount: 10000, on: DISPUTE_DAYS.bank, txn: `S22-${randomUUID().slice(0, 8)}` });
    await d.withdraw();
    await d.lose();
    await settle();
    const reversal = await d.reverse(30000, DISPUTE_DAYS.late);
    await settle();
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:30000/0', '7530:0/13125', '1470(dispute_refund_overlap_review):0/10000',
      '2130(return_refund):0/6875']);
    expect(await reviewOf(d.orderId)).toBe(0);
    expect(await payableOf(d.orderId)).toBe(6875);
  });

  // ---- AC-05: the wait of C ---------------------------------------------------------------------------------------------------
  test('FREQ-581-AC-05: 確定の日までに作った返金が保留（Stripeの結果待ち）の間は、確定は dispute_refund_overlap で待ち、手では閉じられず、返金が済むと入る', async () => {
    const d = await seedDisputeFlow(db());
    const refundId = await nowReceipt(d);
    await d.withdraw();
    await recordRefundResult(db(), refundId, 'pending');
    await settle();
    await d.lose();
    await settle();
    expect(await entryOf(key(d.disputeId, 'confirmed', 'lost'))).toBeUndefined();
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ reason: 'dispute_refund_overlap', detail: { why: 'refund' }, resolved_at: null });
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(30000);
    const id = (await q("select id from public.accounting_pending_events where event_kind = 'dispute_event' and source_id = $1", [d.disputeId])).rows[0].id;
    expect(await accountingFailure(db(), () => q('select public.admin_resolve_accounting_pending_event($1::uuid, $2::uuid, $3, $4::uuid)',
      [d.admin, id, 'try', randomUUID()]))).toMatchObject({ code: '55000', message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '1470(dispute_refund_overlap_review):16875/0', '1470(dispute_pending):0/30000']);
    const entry = await entryOf(key(d.disputeId, 'confirmed', 'lost'));
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ resolved_entry_id: entry?.id });
  });

  test('FREQ-581-AC-06: 確定の日までに作り確定の時に保留だった返金が、確定の日より後に済んでも、済んだ時に返金済みとして数え、分けて調べる補助16,875円で返品の返金待ちは0（確定の前に済んだ時と同じ）', async () => {
    const d = await seedDisputeFlow(db());
    const refundId = await nowReceipt(d);
    await d.withdraw();
    await recordRefundResult(db(), refundId, 'pending');
    await settle();
    await d.lose();
    await settle();
    expect(await entryOf(key(d.disputeId, 'confirmed', 'lost'))).toBeUndefined();
    // 返金の成功の取引は確定（11-09）の後の 11-11
    await succeedRefund(db(), refundId, { at: '2026-11-11T03:00:00Z' });
    await settle();
    expect((await q("select to_char(entry_date, 'YYYY-MM-DD') as d from public.accounting_journal_entries where event_kind = 'return_refund' and source_id = $1",
      [refundId])).rows).toEqual([{ d: '2026-11-11' }]);
    expect(await confirmed(d)).toEqual(['7530:13125/0', '1470(dispute_refund_overlap_review):16875/0', '1470(dispute_pending):0/30000']);
    expect(await reviewOf(d.orderId)).toBe(16875);
    expect(await payableOf(d.orderId)).toBe(0);
  });

  test('FREQ-581-AC-05: 確定の日までに作った返金が Stripe へ送る前（awaiting_response）でも保留（pending）でも、確定は dispute_refund_overlap で待つ', async () => {
    for (const status of ['awaiting_response', 'pending'] as const) {
      await q('savepoint refund_state');
      const d = await seedDisputeFlow(db());
      const refundId = await nowReceipt(d);
      await d.withdraw();
      if (status === 'pending') await recordRefundResult(db(), refundId, 'pending');
      await settle();
      await d.lose();
      await settle();
      expect([status, (await q('select status from public.order_refunds where id = $1', [refundId])).rows[0].status]).toEqual([status, status]);
      expect([status, await entryOf(key(d.disputeId, 'confirmed', 'lost'))]).toEqual([status, undefined]);
      expect([status, await pendingOf('stripe_disputes', d.disputeId)]).toEqual([status, expect.objectContaining({ reason: 'dispute_refund_overlap',
        detail: { why: 'refund' }, resolved_at: null })]);
      await q('rollback to savepoint refund_state');
    }
  });

  test('FREQ-581-AC-05: 確定の日までの返品の届いた日の仕訳が入っていない間は dispute_return_refund_pending で待つ', async () => {
    const d = await seedDisputeFlow(db());
    await consultReceipt(d);
    await d.withdraw();
    await d.lose();
    // 取り消しの係だけを流す（返品の係はまだ流さない）: 引かれた時は入り、確定は届いた日の仕訳を待つ
    await runDisputes();
    await runDisputes();
    expect(await disputeEntryCount(d.disputeId)).toBe(1);
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ reason: 'dispute_return_refund_pending', detail: { why: 'return' }, resolved_at: null });
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/30000']);
    expect((await pendingOf('stripe_disputes', d.disputeId))?.resolved_at).not.toBeNull();
  });

  test('FREQ-581-AC-05: 手数料で返金額が0になった受け取り（割合100%）を0円で終えた返品がある注文でも、確定の相殺は待たずに入る', async () => {
    // P3-D3: 0円で終えるのは写しの無い注文で作る。手数料 100% で返金額 0、0円の決定は仕訳を作らず no_revenue で解決済み
    const d = await seedDisputeFlow(db(), { snapshot: false, percent: 100 });
    const r = await receiveReturn(db(), d.flow, { choice: 'now', arrivedOn: DISPUTE_DAYS.arrival, units: unit(d, 'now') });
    expect(r.refund_id).toBeNull();
    const decision = (await q("select covers_amount, decided_amount, payable_delta from public.accounting_return_facts where return_id = $1 and kind = 'decision'",
      [d.flow.returnId])).rows;
    expect(decision).toEqual([{ covers_amount: 0, decided_amount: 0, payable_delta: 0 }]);
    await d.withdraw();
    await d.lose();
    await settle();
    expect(await payableOf(d.orderId)).toBe(0);
    expect(await confirmed(d)).toEqual(['7530:30000/0', '1470(dispute_pending):0/30000']);
    expect(await pendingOf('stripe_disputes', d.disputeId)).toBeUndefined();
    // 返金待ち（C = 16,875）を admin_refund_return(0) で0円で終えた返品も同じ: 0円の決定の仕訳（差 −16,875）が 2130 から外すので R = 0。
    // 決定の日は今日なので、確定を今日にして決定の仕訳を確定の日以前に置く（確定の日より後の決定は相殺の外。報告の懸念）。
    // 0円の終わりの仕訳を確定の知らせより先に入れる（同じ日でも、確定が先に届くと0円の終わりは手で入れる待ちになる）。
    const waived = await seedDisputeFlow(db(), { snapshot: false });
    await receiveReturn(db(), waived.flow, { choice: 'consult', arrivedOn: DISPUTE_DAYS.arrival, units: unit(waived, 'consult') });
    await settle();
    expect((await q('select * from public.admin_refund_return($1,$2,$3,0,0,null,false)', [waived.flow.returnId, waived.flow.f.actor, randomUUID()])).rows[0])
      .toMatchObject({ refund_id: null, status: 'waived' });
    await settle();
    await waived.withdraw();
    await waived.lose(new Date().toISOString());
    await settle();
    expect(await payableOf(waived.orderId)).toBe(0);
    expect(await confirmed(waived)).toEqual(['7530:30000/0', '1470(dispute_pending):0/30000']);
  });

  // ---- AC-05: a 0 yen close and a lost dispute of the same order (P3-T8c) ----------------------------------------------------
  /** 返品を0円で終える（返金を作らない。写しの無い注文で、引かれた時の前か確定の後に呼ぶ）。決定の事実の id を返す。 */
  const closeAtZero = async (d: DisputeFlow) => {
    expect((await q('select * from public.admin_refund_return($1,$2,$3,0,0,null,false)', [d.flow.returnId, d.flow.f.actor, randomUUID()])).rows[0])
      .toMatchObject({ refund_id: null, status: 'waived' });
    return (await q("select id from public.accounting_return_facts where return_id = $1 and kind = 'decision' and refund_id is null",
      [d.flow.returnId])).rows[0].id as string;
  };
  const decisionPending = async (factId: string) => (await q(
    `select reason, detail, resolved_at from public.accounting_pending_events
     where event_kind = 'return_amount_decided' and source_table = 'accounting_return_facts' and source_id = $1`, [factId])).rows[0];
  const decisionEntry = (factId: string) => q(
    "select 1 from public.accounting_journal_entries where event_kind = 'return_amount_decided' and source_id = $1", [factId]).then((r) => r.rows.length);

  test('FREQ-581-AC-05: 確定の相殺が先に入った後で、確定の日以降に返品を0円で終えると、その0円の終わりは仕訳にならず手で入れる待ち（理由 dispute_lost）になり、返品の返金待ちはマイナスにならない', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await consultReceipt(d);
    await d.withdraw();
    await d.lose();
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/30000']);
    expect(await payableOf(d.orderId)).toBe(0);
    const factId = await closeAtZero(d);
    await settle();
    expect(await decisionPending(factId)).toEqual({ reason: 'order_not_postable', detail: { reason: 'dispute_lost' }, resolved_at: null });
    expect(await decisionEntry(factId)).toBe(0);
    expect(await payableOf(d.orderId)).toBe(0);
    // 次の回も待ちのまま（入れ直さない）
    await settle();
    expect(await decisionEntry(factId)).toBe(0);
    expect((await decisionPending(factId))?.resolved_at).toBeNull();
  });

  test('FREQ-581-AC-05: 返品を0円で終えた仕訳が先に入った後で、それより前の日の確定の知らせが届くと、確定は仕訳にならず手で入れる待ち（理由 return_closed_after_lost）になり、二重に数えない', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await consultReceipt(d);
    await settle();
    const factId = await closeAtZero(d);
    await settle();
    expect(await decisionEntry(factId)).toBe(1);
    expect(await payableOf(d.orderId)).toBe(0);
    await d.withdraw();
    await d.lose();
    await settle();
    expect(await confirmed(d)).toBeNull();
    const pending = await pendingOf('stripe_disputes', d.disputeId);
    expect(pending).toMatchObject({ reason: 'order_not_postable', detail: { reason: 'return_closed_after_lost' }, resolved_at: null });
    expect(await balance(d.disputeId, '1470', 'dispute_pending')).toBe(30000);
    expect(await payableOf(d.orderId)).toBe(0);
    expect(await reviewOf(d.orderId)).toBe(0);
    await settle();
    expect(await confirmed(d)).toBeNull();
  });

  test('FREQ-581-AC-05: 確定の日より前の日に返品を0円で終えた仕訳はふつうに入り、確定の相殺の返金待ちにはその分が入らない', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await consultReceipt(d);
    await settle();
    const factId = await closeAtZero(d);
    await settle();
    expect(await decisionEntry(factId)).toBe(1);
    await d.withdraw();
    // 決定の日は今日なので、確定を明日（日本の日付）にする
    const tomorrow = (await q("select to_char((now() at time zone 'Asia/Tokyo')::date + 1, 'YYYY-MM-DD') as d")).rows[0].d as string;
    await d.lose(`${tomorrow}T03:00:00Z`);
    await settle();
    expect(await decisionPending(factId)).toBeUndefined();
    expect(await confirmed(d)).toEqual(['7530:30000/0', '1470(dispute_pending):0/30000']);
    expect(await payableOf(d.orderId)).toBe(0);
    expect(await pendingOf('stripe_disputes', d.disputeId)).toBeUndefined();
  });

  /** 今の時刻の1分前（日本の今日）の確定の知らせ。決定の日（今日）と同じ日になる。 */
  const loseToday = (d: DisputeFlow) => d.lose(new Date(Date.now() - 60_000).toISOString());

  test('FREQ-581-AC-05: 確定の知らせが届いて確定の仕訳がまだ無い同じ日に返品を0円で終えると、0円の終わりはふつうに入り、確定はそれを待って返金待ちに数えて入り、待ちは何も残らない', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await consultReceipt(d);
    await settle();
    await d.withdraw();
    await settle();
    await loseToday(d);
    const factId = await closeAtZero(d);
    await settle();
    expect(await decisionEntry(factId)).toBe(1);
    expect(await decisionPending(factId)).toBeUndefined();
    // 0円の終わりが返品の返金待ちを 2130 から外すので R = 0、費用は 30,000
    expect(await confirmed(d)).toEqual(['7530:30000/0', '1470(dispute_pending):0/30000']);
    expect(await pendingOf('stripe_disputes', d.disputeId)).toBeUndefined();
    expect(await payableOf(d.orderId)).toBe(0);
    expect(Number((await q('select count(*) as n from public.accounting_pending_events where order_id = $1 and resolved_at is null',
      [d.orderId])).rows[0].n)).toBe(0);
  });

  test('FREQ-581-AC-05: 同じ日に確定の仕訳が先に入った後で返品を0円で終えると、0円の終わりは手で入れる待ち（理由 dispute_lost）になる', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await consultReceipt(d);
    await d.withdraw();
    await loseToday(d);
    await settle();
    expect(await confirmed(d)).toEqual(['7530:13125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/30000']);
    const factId = await closeAtZero(d);
    await settle();
    expect(await decisionPending(factId)).toEqual({ reason: 'order_not_postable', detail: { reason: 'dispute_lost' }, resolved_at: null });
    expect(await decisionEntry(factId)).toBe(0);
    expect(await payableOf(d.orderId)).toBe(0);
  });

  test('FREQ-581-AC-05: 確定で残りが0円になり確定の仕訳が無い（S = 0）注文で、確定の後に返品を0円で終えると、0円の終わりはふつうに入る', async () => {
    const d = await seedDisputeFlow(db(), { snapshot: false });
    await consultReceipt(d);
    await d.withdraw();
    await settle();
    // 確定の前の全額の取り下げ（R）で、確定の時の残りが 0 円
    await d.reverse(30000, '2026-11-08T03:00:00Z');
    await d.lose();
    await settle();
    expect(await confirmed(d)).toBeNull();
    expect(await pendingOf('stripe_disputes', d.disputeId)).toMatchObject({ reason: 'no_revenue' });
    const factId = await closeAtZero(d);
    await settle();
    expect(await decisionEntry(factId)).toBe(1);
    expect(await decisionPending(factId)).toBeUndefined();
    expect(await payableOf(d.orderId)).toBe(0);
  });

  test('FREQ-581-AC-05: 確定の日より後に作った返金・届いた返品は、相殺に使わない', async () => {
    const d = await seedDisputeFlow(db());
    await d.withdraw();
    await d.lose();
    // 確定（11-09）の後: 11-10 に届いた返品（返金待ち 16,875）と、今日作り 11-11 に成功した返品でない返金 5,000円
    await consultReceipt(d, DISPUTE_DAYS.afterLost);
    const r = await hBegin(db(), d.flow.f as never, 5000, false);
    await succeedRefund(db(), r.refund_id, { at: '2026-11-11T03:00:00Z' });
    await settle();
    expect(await payableOf(d.orderId)).toBe(16875);
    expect(-(await orderBalance(db(), d.orderId, '4020'))).toBe(18750 + 5000);
    expect(await confirmed(d)).toEqual(['7530:30000/0', '1470(dispute_pending):0/30000']);
    expect(await memos(key(d.disputeId, 'confirmed', 'lost'))).toEqual(['dispute_reason:fraudulent', 'dispute_lost_at:2026-11-09T03:00:00Z']);
    expect(await reviewOf(d.orderId)).toBe(0);
  });

  test('FREQ-581-AC-05: 注文に結び付かない取り消しは待たず、相殺もしない', async () => {
    // 本物の書き手では、注文の無い取り消しは引かれた時が no_order で止まり（計画2）、確定は引かれた時を待つので相殺の段に届かない。
    // 待ちの道具を注文 NULL で直接呼んで「待たない」を確かめ、確定は計画2のとおり相殺の理由で止まらないことを確かめる。
    expect((await q("select * from private.accounting_dispute_offset_ready('dp_none', null, '2026-11-09'::date)")).rows).toEqual([{ ready: true, reason: null }]);
    const d = await seedDispute(db(), { orderId: null, paymentIntentId: null, amount: 30000, withdrawnAt: DISPUTE_DAYS.withdrawn });
    await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-11-09T05:00:00Z', stripeEventCreatedAt: DISPUTE_DAYS.lost,
      eventType: 'charge.dispute.closed' });
    await settle();
    expect(await pendingOf('stripe_balance_transactions', d.txnId as string)).toMatchObject({ reason: 'no_order' });
    const c = await pendingOf('stripe_disputes', d.disputeId);
    expect(c?.reason).toBe('dispute_withdrawal_missing');
    expect(await disputeEntryCount(d.disputeId)).toBe(0);
  });

  test('FREQ-581-AC-05: 確定の前の取り下げ（R）は相殺しない', async () => {
    const d = await seedDisputeFlow(db());
    await consultReceipt(d);
    await d.withdraw();
    await settle();
    const reversal = await d.reverse(10000, '2026-11-08T03:00:00Z');
    await d.lose();
    await settle();
    expect(await summary(key(d.disputeId, 'reversal', reversal))).toEqual(['1160:10000/0', '1470(dispute_pending):0/10000']);
    // 確定は R の後の残り S = 20,000 で、返金待ち 16,875 を先に消す
    expect(await confirmed(d)).toEqual(['7530:3125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/20000']);
  });

  // ---- AC-07: an arrival day on or before the confirmed day is refused ----------------------------------------------------------
  test('FREQ-581-AC-07: 確定済みの注文の確定の日以前への届いた日の入れ替えを断る', async () => {
    const d = await seedDisputeFlow(db());
    await d.withdraw();
    await d.lose();
    await settle();
    expect(await entryOf(key(d.disputeId, 'confirmed', 'lost'))).toBeDefined();
    // 確定の日（11-09）以前の届いた日の受け取りは断られ、後の日なら受け取れる
    expect(await failure(() => consultReceipt(d, DISPUTE_DAYS.lostOn))).toMatchObject({ code: '22023', message: 'RETURN_ARRIVAL_DATE_INVALID', detail: 'dispute_confirmed' });
    const receipt = await consultReceipt(d, DISPUTE_DAYS.afterLost);
    await settle();
    for (const day of [DISPUTE_DAYS.lostOn, '2026-11-08']) {
      expect(await failure(() => correctArrival(db(), receipt.receipt_id, day, { actor: d.admin })))
        .toMatchObject({ code: '22023', message: 'RETURN_ARRIVAL_DATE_INVALID', detail: 'dispute_confirmed' });
    }
    expect((await correctArrival(db(), receipt.receipt_id, '2026-11-11', { actor: d.admin })).new_on).toBe('2026-11-11');
  });

  // ---- FREQ-569-AC-01: period_missing keeps the day of the entry in the rebuilt poster ------------------------------------------
  test('FREQ-569-AC-01: S22で作り直したdisputeの係もすべてのperiod_missingにdetail.entry_dateを残す', async () => {
    const admin = await insertAccountingAdmin(db());
    await q("select public.admin_set_dispute_account_setting($1::uuid, 'fraudulent', '7530', null, $2::uuid)", [admin, randomUUID()]);
    // 計画2の同じ試験の形: 8着を 2026-06-15 に送った注文。2026年の個人の期間だけの間に前の段を入れ、法人に切り替えて 2027年の段を止める
    async function seedOrder() {
      const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
      const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 8 }] }],
        shipmentDate: '2026-06-15', confirmedAt: '2026-06-15T01:00:00Z', recordFact: false });
      await recordSlipFactAt(db(), slip.slipId, 'confirm', '2026-06-15T01:00:00Z');
      await q('select private.accounting_post_shipment_events(50)');
      return order;
    }
    const dispute = async (order: { orderId: string; paymentIntentId: string | null }, withdrawnAt?: string) =>
      seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30000, withdrawnAt });
    const lose = (disputeId: string, at: string) => addDisputeHistory(db(), { disputeId, status: 'lost',
      occurredAt: new Date(new Date(at).getTime() + 3600_000).toISOString(), stripeEventCreatedAt: at, eventType: 'charge.dispute.closed' });
    const disputeC = await dispute(await seedOrder());
    const disputeR = await dispute(await seedOrder());
    const disputeL = await dispute(await seedOrder());
    await lose(disputeL.disputeId, '2026-12-20T03:00:00Z');
    await runDisputes();
    expect(await entryOf(key(disputeL.disputeId, 'confirmed', 'lost'))).toBeDefined();
    const settings = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0];
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, settings.v, randomUUID()]);
    const disputeW = await dispute(await seedOrder(), '2027-01-02T03:00:00Z');
    await lose(disputeC.disputeId, '2027-01-05T03:00:00Z');
    await addDisputeHistory(db(), { disputeId: disputeR.disputeId, status: 'won', occurredAt: '2027-01-03T05:00:00Z', eventType: 'charge.dispute.closed' });
    const reversalR = await seedDisputeReversal(db(), { disputeId: disputeR.disputeId, amount: 30000, createdAt: '2027-01-03T03:00:00Z' });
    const reversalL = await seedDisputeReversal(db(), { disputeId: disputeL.disputeId, amount: 30000, createdAt: '2027-01-10T03:00:00Z' });
    expect(await runDisputes()).toMatchObject({ posted: 0, parked_new: 4 });
    const expected: Array<[string, string, string]> = [
      ['stripe_balance_transactions', disputeW.txnId as string, '2027-01-02'],
      ['stripe_disputes', disputeC.disputeId, '2027-01-05'],
      ['stripe_balance_transactions', reversalR, '2027-01-03'],
      ['stripe_balance_transactions', reversalL, '2027-01-10']];
    for (const [table, id, date] of expected) {
      const row = await pendingOf(table, id);
      expect([table, row?.reason, row?.detail]).toEqual([table, 'period_missing', { entry_date: date }]);
    }
    expect(await runDisputes()).toMatchObject({ posted: 0, reparked: 4 });
    for (const [table, id, date] of expected) expect((await pendingOf(table, id))?.detail).toEqual({ entry_date: date });
    await insertAccountingPeriod(db(), { businessType: 'corporation', startsOn: '2026-07-01', endsOn: '2027-06-30' });
    expect(await runDisputes()).toMatchObject({ posted: 4, resolved: 4, reparked: 0 });
  });
});
