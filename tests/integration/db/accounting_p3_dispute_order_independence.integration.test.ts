/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import {
  addDisputeHistory, recordSlipFactAt, seedConfirmedSlip, seedDispute, seedDisputeReversal, seedPostedPayment, seedStripeFee, setAsideExistingSlips,
  setCutoverForTest,
} from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, cancelRefund, decideRefund, DISPUTE_DAYS, failRefund, orderBalance, postRefundEvents, postReturnEvents, receiveReturn, recordRefundResult,
  seedDisputeFlow, setRefundCreatedAt, succeedRefund, type DisputeFlow,
} from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 8（S22）: 取り消しの確定の相殺は、出来事の届く順と係の流れる回数によらない（FREQ-581-AC-06・AC-08）。計画2の13行の表も
// 引かれた時の止めを外した後にそのまま通る（FREQ-568-AC-07）。ROLLBACK の形（--runInBand）: 並べ方ごとに savepoint で戻す。
// 土台（seedDisputeFlow）: 2着（20,000円と18,750円）を送った写しのある注文、18,750円の1着の返品（手数料 10%。G 18,750・F 1,875）、
// 取り消し A = 30,000（両方出荷済み。S = 30,000）、原因の科目 7530。表の Y 年は 2026年（日付は 11月。返品の届いた日・振込の日は今日より後に
// できないため、ブリーフの 12月10日・12月20日の代わりに 11-05・11-09）、Y+1 年は遅れた取り下げの 2027-01-15。
jest.setTimeout(1800000);

type Step = { id: string; after?: string[]; run: () => Promise<unknown> };
type Measure = { pending: number; payable: number; review: number; expense: number; r4020: number; r4050: number; profit: Record<string, number> };

/** 依存（after）を守る並べ方をすべて返す。 */
function orders(steps: Step[]): Step[][] {
  const out: Step[][] = [];
  const walk = (done: Step[], left: Step[]) => {
    if (left.length === 0) { out.push(done); return; }
    for (const s of left) {
      if ((s.after ?? []).every((id) => done.some((d) => d.id === id))) walk([...done, s], left.filter((x) => x !== s));
    }
  };
  walk([], steps);
  return out;
}

describeLocalDb('S22 dispute offset: order of arrival', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const settle = async () => { for (let i = 0; i < 4; i += 1) await q('select private.accounting_run_posting(200)'); };
  /** 途中で流す係: 返金と取り消し（返品の届いた日の仕訳は、出来事 ARR として返品の係を流した時に入る）。 */
  const midway = async () => { await postRefundEvents(db(), 200); await q('select private.accounting_post_dispute_events(200)'); };
  const balance = async (dispute: string, account: string, sub: string | null) => Number((await q(
    'select private.accounting_dispute_balance($1, $2, $3) as b', [dispute, account, sub])).rows[0].b);
  /** 取り消しの印の仕訳と、注文の行を持つ返品・返金の仕訳（支払いと出荷の仕訳を除く）。 */
  const ENTRIES = `select e.id, e.event_kind, e.entry_date from public.accounting_journal_entries e
    where starts_with(e.dedupe_key, 'dispute_event:' || $1 || ':')
       or (e.event_kind not in ('payment_confirmed', 'shipment_confirmed')
           and exists (select 1 from public.accounting_journal_lines l where l.entry_id = e.id and l.order_id = $2))`;
  async function measure(d: DisputeFlow): Promise<Measure> {
    const profit = Object.fromEntries((await q(
      `select extract(year from e.entry_date)::int as y, sum(l.credit - l.debit)::int as p from (${ENTRIES}) e
       join public.accounting_journal_lines l on l.entry_id = e.id
       join public.accounting_accounts a on a.code = l.account_code and a.account_type in ('expense', 'revenue')
       group by 1 having sum(l.credit - l.debit) <> 0 order by 1`, [d.disputeId, d.orderId])).rows.map((r) => [String(r.y), r.p]));
    return {
      pending: await balance(d.disputeId, '1470', 'dispute_pending'),
      payable: await orderBalance(db(), d.orderId, '2130', 'return_refund'),
      review: Number((await q(`select coalesce(sum(debit - credit), 0)::int as n from public.accounting_journal_lines
        where order_id = $1 and account_code = '1470' and sub_account = 'dispute_refund_overlap_review'`, [d.orderId])).rows[0].n),
      expense: await balance(d.disputeId, '7530', null),
      r4020: 0 - (await orderBalance(db(), d.orderId, '4020')),
      r4050: await orderBalance(db(), d.orderId, '4050'),
      profit,
    };
  }
  /** 仕訳ごとの [種類, 日, 行（科目・補助・借方・貸方）] を並べた物（id と番号を除く。届く順で変わらないかを比べる）。 */
  async function entryShapes(d: DisputeFlow): Promise<string[]> {
    return (await q(
      `select e.event_kind || ' ' || to_char(e.entry_date, 'YYYY-MM-DD') || ' ' || string_agg(l.account_code || '(' || coalesce(l.sub_account, '') || ')'
         || l.debit || '/' || l.credit, ',' order by l.account_code, l.sub_account, l.debit, l.credit) as s
       from (${ENTRIES}) e join public.accounting_journal_lines l on l.entry_id = e.id group by e.id, e.event_kind, e.entry_date order by 1`,
      [d.disputeId, d.orderId])).rows.map((r) => r.s as string);
  }
  const confirmedLines = async (d: DisputeFlow) => (await q(
    `select l.account_code || coalesce('(' || l.sub_account || ')', '') || ':' || l.debit || '/' || l.credit as s
     from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
     where e.dedupe_key = $1 order by l.line_no`, [`dispute_event:${d.disputeId}:confirmed:lost`])).rows.map((r) => r.s as string);
  const openDisputeWaits = async (d: DisputeFlow) => Number((await q(
    `select count(*) as n from public.accounting_pending_events where event_kind = 'dispute_event' and resolved_at is null
     and (source_id = $1 or source_id in (select id from public.stripe_balance_transactions where source_id = $1))`, [d.disputeId])).rows[0].n);

  const unit = (d: DisputeFlow, choice: 'now' | 'consult') =>
    [{ return_line_id: d.flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: choice }];
  const consultReceipt = (d: DisputeFlow, arrivedOn: string = DISPUTE_DAYS.arrival) =>
    receiveReturn(db(), d.flow, { choice: 'consult', arrivedOn, units: unit(d, 'consult') });
  const nowReceipt = async (d: DisputeFlow) => {
    const r = await receiveReturn(db(), d.flow, { choice: 'now', arrivedOn: DISPUTE_DAYS.arrival, units: unit(d, 'now') });
    if (!r.refund_id) throw new Error('NOW_RECEIPT_WITHOUT_REFUND');
    await setRefundCreatedAt(db(), r.refund_id, '2026-11-05T03:00:00Z');
    return r.refund_id;
  };
  // The events. The refunds are made before the withdrawal (FREQ-580-AC-01 refuses a new refund while the dispute is open and withdrawn),
  // so they are part of each row's ground; the receipts too (an arrival on or before the confirmed day is refused once the dispute is lost).
  const W = (d: DisputeFlow): Step => ({ id: 'W', run: () => d.withdraw() });
  const LOST = (d: DisputeFlow, after: string[] = []): Step => ({ id: 'LOST', after, run: () => d.lose() });
  const ARR: Step = { id: 'ARR', run: () => postReturnEvents(db(), 200) };
  const SUCC = (refundId: () => string): Step => ({ id: 'SUCC', run: () => succeedRefund(db(), refundId(), { at: DISPUTE_DAYS.refund }) });
  const REV = (d: DisputeFlow, value = 30000): Step => ({ id: 'REV', run: () => d.reverse(value, DISPUTE_DAYS.late) });
  const BANK = (d: DisputeFlow, amount: number, on: string = DISPUTE_DAYS.bank): Step => ({ id: 'BANK', after: ['ARR'],
    run: () => bankTransfer(db(), { actor: d.admin, orderId: d.orderId, origin: 'return', amount, on, txn: `S22-${randomUUID().slice(0, 8)}` }) });

  /**
   * steps のすべての並べ方を、各出来事の後に係を流す（each）・最後にまとめて流す（end）の両方で試し、最後の残高・年ごとの利益と、
   * 仕訳の本数（shapes が真なら各仕訳の額）が最初の並べ方と同じかを確かめる。試した数を返す。
   */
  async function everyOrder(label: string, d: DisputeFlow, steps: Step[], expected: Measure,
    o: { shapes?: boolean; confirmed?: string[]; extra?: (name: string) => Promise<void> } = {}): Promise<number> {
    const all = orders(steps);
    expect([label, all.length > 0]).toEqual([label, true]);
    let reference: { count: number; shapes: string[] } | null = null;
    let tried = 0;
    for (const order of all) {
      for (const mode of ['each', 'end'] as const) {
        const name = `${label} / ${order.map((s) => s.id).join('>')} / ${mode}`;
        await q('savepoint s22_order');
        for (const step of order) {
          try { await step.run(); } catch (e) { throw new Error(`${name} at ${step.id}: ${(e as Error).message}`); }
          if (mode === 'each') await midway();
        }
        await settle();
        expect({ name, ...(await measure(d)) }).toEqual({ name, ...expected });
        expect([name, await openDisputeWaits(d)]).toEqual([name, 0]);
        if (o.confirmed) expect([name, await confirmedLines(d)]).toEqual([name, o.confirmed]);
        const shapes = await entryShapes(d);
        if (!reference) reference = { count: shapes.length, shapes };
        else if (o.shapes) expect([name, shapes]).toEqual([name, reference.shapes]);
        else expect([name, shapes.length]).toEqual([name, reference.count]);
        if (o.extra) await o.extra(name);
        await q('rollback to savepoint s22_order');
        await q('release savepoint s22_order');
        tried += 1;
      }
    }
    return tried;
  }

  const base = { pending: 0, payable: 0, review: 0, expense: 0, r4020: 18750, r4050: 1875 };

  test('FREQ-581-AC-06: 届く順がどうでも最後の残高と年ごとの利益が同じ', async () => {
    let tried = 0;
    const row = async (label: string, seed: Parameters<typeof seedDisputeFlow>[1],
      build: (d: DisputeFlow) => Promise<{ steps: Step[]; expected: Measure; after?: (d: DisputeFlow) => Promise<void> }>) => {
      await q('savepoint s22_row');
      const d = await seedDisputeFlow(db(), seed);
      const { steps, expected } = await build(d);
      tried += await everyOrder(label, d, steps, expected);
      await q('rollback to savepoint s22_row');
      await q('release savepoint s22_row');
    };
    await row('1. 返品なし', {}, async (d) => ({ steps: [W(d), LOST(d)],
      expected: { ...base, expense: 30000, r4020: 0, r4050: 0, profit: { 2026: -30000 } } }));
    await row('2. 返品あり（R = 16,875）、返金前', {}, async (d) => {
      await consultReceipt(d);
      return { steps: [W(d), LOST(d), ARR], expected: { ...base, expense: 13125, profit: { 2026: -30000 } } };
    });
    await row('3. 返品あり、返金済み（Z = 16,875）', {}, async (d) => {
      const refundId = await nowReceipt(d);
      return { steps: [W(d), LOST(d), ARR, SUCC(() => refundId)], expected: { ...base, review: 16875, expense: 13125, profit: { 2026: -30000 } } };
    });
    await row('4. 返品あり、一部返金済み（R = 6,875・Z = 10,000）', {}, async (d) => {
      await consultReceipt(d);
      // An arrival day or bank day on or before the confirmed day is refused once the dispute is lost: the transfer comes first.
      return { steps: [W(d), LOST(d, ['BANK']), ARR, BANK(d, 10000)], expected: { ...base, review: 10000, expense: 13125, profit: { 2026: -30000 } } };
    });
    await row('5. 2 の後に全額取り下げ（L）。戻りは Y+1 年', {}, async (d) => {
      await consultReceipt(d);
      return { steps: [W(d), LOST(d), ARR, REV(d)], expected: { ...base, payable: 16875, profit: { 2026: -30000, 2027: 13125 } } };
    });
    await row('6. 3 の後に全額取り下げ（L）。戻りは Y+1 年', {}, async (d) => {
      const refundId = await nowReceipt(d);
      return { steps: [W(d), LOST(d), ARR, SUCC(() => refundId), REV(d)], expected: { ...base, profit: { 2026: -30000, 2027: 13125 } } };
    });
    await row('7. 部分（S = 10,000）、R = 16,875', { amount: 10000 }, async (d) => {
      await consultReceipt(d);
      return { steps: [W(d), LOST(d), ARR], expected: { ...base, payable: 6875, profit: { 2026: -16875 } } };
    });
    await row('8. 返品の届いた日が確定の日より後', {}, async (d) => {
      // 届いた日 11-10（確定 11-09 の翌日）。ブリーフの表は届いた日を Y+1 年に置くが、ここは同じ 2026年なので Y に −16,875 が足される
      await consultReceipt(d, DISPUTE_DAYS.afterLost);
      return { steps: [W(d), LOST(d), ARR], expected: { ...base, payable: 16875, expense: 30000, profit: { 2026: -46875 } } };
    });
    await row('10. 返金が引かれた後に「店が返金をやめた」→ その後に確定', {}, async (d) => {
      const refundId = await nowReceipt(d);
      const actor = await insertAccountingAdmin(db());
      const abandon: Step = { id: 'ABN', after: ['SUCC'], run: async () => {
        await cancelRefund(db(), refundId, { pulled: true, at: DISPUTE_DAYS.failure });
        await decideRefund(db(), refundId, 'abandoned', actor);
      } };
      return { steps: [W(d), LOST(d, ['ABN']), ARR, SUCC(() => refundId), abandon], expected: { ...base, expense: 13125, profit: { 2026: -30000 } } };
    });
    await row('11. 返品でない出荷後の返金5,000円', {}, async (d) => {
      const r = await hBegin(db(), d.flow.f as never, 5000, false);
      await setRefundCreatedAt(db(), r.refund_id, '2026-11-05T03:00:00Z');
      return { steps: [W(d), LOST(d), SUCC(() => r.refund_id)], expected: { ...base, review: 5000, expense: 25000, r4020: 5000, r4050: 0, profit: { 2026: -30000 } } };
    });
    // 9. 保留の返金（確定の日までに作った）: 待つ間は 30,000 のまま仕訳が増えず、返金が済むと 3 と同じ
    {
      await q('savepoint s22_row');
      const d = await seedDisputeFlow(db());
      const refundId = await nowReceipt(d);
      const pend: Step = { id: 'PEND', run: () => recordRefundResult(db(), refundId, 'pending') };
      for (const order of orders([W(d), LOST(d), ARR, pend])) {
        for (const mode of ['each', 'end'] as const) {
          const name = `9 / ${order.map((s) => s.id).join('>')} / ${mode}`;
          await q('savepoint s22_order');
          for (const step of order) { await step.run(); if (mode === 'each') await midway(); }
          await settle();
          const count = (await entryShapes(d)).length;
          await settle();
          expect([name, await balance(d.disputeId, '1470', 'dispute_pending'), (await entryShapes(d)).length, await confirmedLines(d)])
            .toEqual([name, 30000, count, []]);
          expect([name, (await q("select reason from public.accounting_pending_events where source_table = 'stripe_disputes' and source_id = $1 and resolved_at is null",
            [d.disputeId])).rows.map((r) => r.reason)]).toEqual([name, ['dispute_refund_overlap']]);
          await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
          await settle();
          expect({ name, ...(await measure(d)) }).toEqual({ name, ...base, review: 16875, expense: 13125, profit: { 2026: -30000 } });
          await q('rollback to savepoint s22_order');
          await q('release savepoint s22_order');
          tried += 1;
        }
      }
      await q('rollback to savepoint s22_row');
      await q('release savepoint s22_row');
    }
    // 11 rows, every order of the events, and the posters run after each event or only at the end.
    expect(tried).toBeGreaterThan(400);
  });

  test('FREQ-581-AC-08: 返金（成功・遅い失敗）・返品・確定の相殺・振込の届く順をすべて試して、最後の残高と各仕訳の額が同じ', async () => {
    let tried = 0;
    const run = async (label: string, build: (d: DisputeFlow) => Promise<void>) => {
      await q('savepoint s22_case');
      const d = await seedDisputeFlow(db());
      await build(d);
      await q('rollback to savepoint s22_case');
      await q('release savepoint s22_case');
    };
    const a = { ...base, expense: 13125, profit: { 2026: -30000 } };
    const aLines = ['7530:13125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/30000'];
    const b = { ...base, review: 16875, expense: 13125, profit: { 2026: -30000 } };
    const bLines = ['7530:13125/0', '1470(dispute_refund_overlap_review):16875/0', '1470(dispute_pending):0/30000'];
    const FAIL = (refundId: string): Step => ({ id: 'FAIL', after: ['SUCC'], run: () => failRefund(db(), refundId, { pulled: true, at: DISPUTE_DAYS.failure }) });
    await run('a. 返金成功 → 遅い失敗 → 確定', async (d) => {
      const refundId = await nowReceipt(d);
      // A failure posted after the confirmed entry is a known limit (C is not booked again): the failure notice reaches us before the loss.
      tried += await everyOrder('a', d, [W(d), LOST(d, ['FAIL']), ARR, SUCC(() => refundId), FAIL(refundId)], a, { shapes: true, confirmed: aLines });
    });
    await run("a'. 引かれる前の失敗（返品の返金。仕訳は無く、返金待ちが残る）→ 確定", async (d) => {
      const refundId = await nowReceipt(d);
      const unpulled: Step = { id: 'FAIL0', run: () => failRefund(db(), refundId, {}) };
      tried += await everyOrder("a'", d, [W(d), LOST(d, ['FAIL0']), ARR, unpulled], a, { shapes: true, confirmed: aLines });
    });
    await run('b. 返金成功 → 確定（失敗なし）', async (d) => {
      const refundId = await nowReceipt(d);
      tried += await everyOrder('b', d, [W(d), LOST(d), ARR, SUCC(() => refundId)], b, { shapes: true, confirmed: bLines });
    });
    await run('c・d. 振込10,000（返金待ちに対して）→ 確定。確定の後の、確定の日以前の振込は断られ結果が変わらない', async (d) => {
      await consultReceipt(d);
      const c = { ...base, review: 10000, expense: 13125, profit: { 2026: -30000 } };
      tried += await everyOrder('c', d, [W(d), LOST(d, ['BANK']), ARR, BANK(d, 10000)], c, {
        shapes: true, confirmed: ['7530:13125/0', '2130(return_refund):6875/0', '1470(dispute_refund_overlap_review):10000/0', '1470(dispute_pending):0/30000'],
        extra: async (name) => {
          await q('savepoint s22_late_bank');
          const refused = await bankTransfer(db(), { actor: d.admin, orderId: d.orderId, origin: 'return', amount: 1000, on: '2026-11-08',
            txn: `S22-${randomUUID().slice(0, 8)}` }).then(() => null, (e: { message: string; detail?: string }) => [e.message, e.detail]);
          await q('rollback to savepoint s22_late_bank');
          await q('release savepoint s22_late_bank');
          expect([name, refused]).toEqual([name, ['ACCOUNTING_ARGUMENT_INVALID', 'dispute_confirmed']]);
          await settle();
          expect({ name, ...(await measure(d)) }).toEqual({ name, ...c });
        } });
    });
    await run('e. 返金の成功・失敗が確定の知らせより後に同期される', async (d) => {
      const refundId = await nowReceipt(d);
      for (const mode of ['each', 'end'] as const) {
        await q('savepoint s22_order');
        await d.withdraw();
        await postReturnEvents(db(), 200);
        await d.lose();
        if (mode === 'each') await midway();
        await settle();
        const count = (await entryShapes(d)).length;
        await settle();
        expect([mode, await balance(d.disputeId, '1470', 'dispute_pending'), (await entryShapes(d)).length, await confirmedLines(d)]).toEqual([mode, 30000, count, []]);
        await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
        await failRefund(db(), refundId, { pulled: true, at: DISPUTE_DAYS.failure });
        if (mode === 'each') await midway();
        await settle();
        expect({ mode, ...(await measure(d)) }).toEqual({ mode, ...a });
        expect([mode, await confirmedLines(d)]).toEqual([mode, aLines]);
        await q('rollback to savepoint s22_order');
        await q('release savepoint s22_order');
        tried += 1;
      }
    });
    await run('f. 返金が error のまま確定の知らせが流れ、あとで成功', async (d) => {
      const refundId = await nowReceipt(d);
      for (const mode of ['each', 'end'] as const) {
        await q('savepoint s22_order');
        await q("select * from private.mark_order_refund_error($1, 'timeout', false)", [refundId]);
        await d.withdraw();
        await postReturnEvents(db(), 200);
        await d.lose();
        if (mode === 'each') await midway();
        await settle();
        expect([mode, await balance(d.disputeId, '1470', 'dispute_pending'), await confirmedLines(d)]).toEqual([mode, 30000, []]);
        expect([mode, (await q("select reason from public.accounting_pending_events where source_table = 'stripe_disputes' and source_id = $1 and resolved_at is null",
          [d.disputeId])).rows.map((r) => r.reason)]).toEqual([mode, ['dispute_refund_overlap']]);
        await succeedRefund(db(), refundId, { at: DISPUTE_DAYS.refund });
        if (mode === 'each') await midway();
        await settle();
        expect({ mode, ...(await measure(d)) }).toEqual({ mode, ...b });
        expect([mode, await confirmedLines(d)]).toEqual([mode, bLines]);
        await q('rollback to savepoint s22_order');
        await q('release savepoint s22_order');
        tried += 1;
      }
    });
    expect(tried).toBeGreaterThan(60);
  });

  // ---- FREQ-568-AC-07: the plan-2 table of 13 rows still holds after the withdrawal holds came off -----------------------------------
  test('FREQ-568-AC-07: 計画2の13行の表が（引かれた時の止めを外した後も）そのまま通る', async () => {
    // 計画2の dispute の試験（accounting_p2_dispute_posting の FREQ-568-AC-07 の2つ）と同じ注文・日付・期待。返金・返品の無い注文なので、
    // S22 の相殺は 0 で、待ちも無い。ここでは負けの知らせの形を1つ（知らせ）にし、出来事の並べ方と流し方はすべて試す。
    const W_AT = '2026-06-20T03:00:00Z';
    const LOST_AT = '2026-12-20T03:00:00Z';
    const R_AT = '2026-12-10T03:00:00Z';
    const L_AT = '2027-01-15T03:00:00Z';
    const admin = await insertAccountingAdmin(db());
    const runDisputes = () => q('select private.accounting_post_dispute_events(50)');
    const setSetting = () => q("select public.admin_set_dispute_account_setting($1::uuid, 'fraudulent', '7530', null, $2::uuid)", [admin, randomUUID()]);
    async function seedOrder(shipped: number, post = true) {
      const order = await seedPostedPayment(db(), { lines: [{ price: 3750, quantity: 8 }], createdAt: '2026-06-10T03:00:00Z' });
      if (shipped > 0) {
        const slip = await seedConfirmedSlip(db(), { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: shipped }] }],
          shipmentDate: '2026-06-15', confirmedAt: '2026-06-15T01:00:00Z', recordFact: false });
        await recordSlipFactAt(db(), slip.slipId, 'confirm', '2026-06-15T01:00:00Z');
        if (post) await q('select private.accounting_post_shipment_events(50)');
      }
      return order;
    }
    async function measurePlan2(disputeId: string) {
      const profit = Object.fromEntries((await q(
        `select extract(year from e.entry_date)::int as y, sum(l.credit - l.debit)::int as profit
         from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id = e.id
         join public.accounting_accounts a on a.code = l.account_code and a.account_type in ('expense', 'revenue')
         where starts_with(e.dedupe_key, $1) group by 1 having sum(l.credit - l.debit) <> 0 order by 1`, [`dispute_event:${disputeId}:`])).rows.map((r) => [String(r.y), r.profit]));
      const d2150 = Number((await q(
        `select coalesce(sum(l.credit - l.debit), 0) as b from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
         where l.account_code = '2150' and starts_with(e.dedupe_key, $1)`, [`dispute_event:${disputeId}:`])).rows[0].b);
      return {
        pending: await balance(disputeId, '1470', 'dispute_pending'),
        unassigned: await balance(disputeId, '1470', 'dispute_confirmed_unassigned'),
        expense: await balance(disputeId, '7530', null),
        d2150, profit,
        entries: Number((await q('select count(*) as n from public.accounting_journal_entries where starts_with(dedupe_key, $1)', [`dispute_event:${disputeId}:`])).rows[0].n),
      };
    }
    type Row = { id: number; shipped: number; setting: boolean; end: 'lost' | 'won' | 'none'; rev: null | { amount: number; at: string };
      x: 'none' | 'after' | 'beforeRev'; expected: Awaited<ReturnType<typeof measurePlan2>> };
    const rows: Row[] = [
      { id: 1, shipped: 5, setting: true, end: 'lost', rev: null, x: 'none', expected: { pending: 0, unassigned: 0, expense: 18750, d2150: -11250, profit: { 2026: -18750 }, entries: 2 } },
      { id: 2, shipped: 5, setting: false, end: 'lost', rev: null, x: 'after', expected: { pending: 0, unassigned: 0, expense: 18750, d2150: -11250, profit: { 2026: -18750 }, entries: 3 } },
      { id: 3, shipped: 5, setting: true, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: { 2026: -18750, 2027: 18750 }, entries: 3 } },
      { id: 4, shipped: 5, setting: false, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'beforeRev', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: { 2026: -18750, 2027: 18750 }, entries: 4 } },
      { id: 5, shipped: 5, setting: false, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'after', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: { 2026: -18750, 2027: 18750 }, entries: 4 } },
      { id: 6, shipped: 5, setting: true, end: 'lost', rev: { amount: 30000, at: R_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: {}, entries: 2 } },
      { id: 7, shipped: 5, setting: true, end: 'lost', rev: { amount: 10000, at: L_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 12500, d2150: -7500, profit: { 2026: -18750, 2027: 6250 }, entries: 3 } },
      { id: 8, shipped: 5, setting: true, end: 'lost', rev: { amount: 10000, at: R_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 12500, d2150: -7500, profit: { 2026: -12500 }, entries: 3 } },
      { id: 9, shipped: 0, setting: true, end: 'lost', rev: { amount: 30000, at: L_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: {}, entries: 2 } },
      { id: 10, shipped: 8, setting: true, end: 'won', rev: { amount: 30000, at: R_AT }, x: 'none', expected: { pending: 0, unassigned: 0, expense: 0, d2150: 0, profit: {}, entries: 2 } },
      { id: 11, shipped: 8, setting: true, end: 'lost', rev: null, x: 'none', expected: { pending: 0, unassigned: 0, expense: 30000, d2150: 0, profit: { 2026: -30000 }, entries: 2 } },
      { id: 12, shipped: 5, setting: true, end: 'none', rev: null, x: 'none', expected: { pending: 18750, unassigned: 0, expense: 0, d2150: -11250, profit: {}, entries: 1 } },
    ];
    const settleDisputes = async () => { for (let i = 0; i < 4; i += 1) await runDisputes(); };
    let scenarios = 0;
    for (const row of rows) {
      const order = await seedOrder(row.shipped);
      const rBeforeLost = row.rev !== null && new Date(row.rev.at) <= new Date(LOST_AT) && row.end === 'lost';
      for (const mode of ['each', 'end'] as const) {
        const tags = ['W', ...(row.end === 'lost' ? ['lost'] : row.end === 'won' ? ['won'] : []), ...(row.rev && row.x !== 'beforeRev' ? ['rev'] : [])];
        const all = orders(tags.map((id) => ({ id, after: rBeforeLost && id === 'lost' ? ['rev'] : [], run: async () => undefined })));
        for (const steps of all) {
          await q('savepoint plan2_row');
          scenarios += 1;
          const d = await seedDispute(db(), { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 30000, withdrawnAt: null });
          if (row.setting) await setSetting();
          const rev = async () => { if (row.rev) await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: row.rev.amount, createdAt: row.rev.at }); };
          for (const step of steps) {
            if (step.id === 'W') await seedStripeFee(db(), { createdAt: W_AT, type: 'adjustment', reportingCategory: 'dispute', amount: -30000, sourceId: d.disputeId });
            else if (step.id === 'lost') await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-20T04:00:00Z', stripeEventCreatedAt: LOST_AT, eventType: 'charge.dispute.closed' });
            else if (step.id === 'won') await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-12-11T00:00:00Z', eventType: 'charge.dispute.closed' });
            else await rev();
            if (mode === 'each') await runDisputes();
          }
          await settleDisputes();
          if (row.x !== 'none') {
            await setSetting();
            await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()]);
            if (row.x === 'beforeRev') await rev();
            await settleDisputes();
          }
          const label = `row ${row.id} / ${steps.map((s) => s.id).join(',')} / ${mode}`;
          expect({ label, ...(await measurePlan2(d.disputeId)) }).toEqual({ label, ...row.expected });
          await q('rollback to savepoint plan2_row');
          await q('release savepoint plan2_row');
        }
      }
      // 場合13: 引かれた時が出荷の仕訳を待つ間に lost と戻りが届き、あとで出荷の仕訳と引かれた時が入っても、最後は同じ
      await q('savepoint plan2_row13');
      const held = await seedOrder(row.shipped, false);
      const d = await seedDispute(db(), { orderId: held.orderId, paymentIntentId: held.paymentIntentId, amount: 30000, withdrawnAt: W_AT });
      if (row.setting) await setSetting();
      const lateRev = row.rev !== null && row.x !== 'beforeRev';
      if (lateRev && rBeforeLost) await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: row.rev!.amount, createdAt: row.rev!.at });
      if (row.end === 'lost') await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'lost', occurredAt: '2026-12-20T04:00:00Z', stripeEventCreatedAt: LOST_AT, eventType: 'charge.dispute.closed' });
      if (row.end === 'won') await addDisputeHistory(db(), { disputeId: d.disputeId, status: 'won', occurredAt: '2026-12-11T00:00:00Z', eventType: 'charge.dispute.closed' });
      if (lateRev && !rBeforeLost) await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: row.rev!.amount, createdAt: row.rev!.at });
      if (row.shipped > 0) {
        await settleDisputes();
        expect({ row: row.id, entries: (await measurePlan2(d.disputeId)).entries }).toEqual({ row: row.id, entries: 0 });
        await q('select private.accounting_post_shipment_events(50)');
      }
      await settleDisputes();
      if (row.x !== 'none') {
        await setSetting();
        await q('select public.admin_assign_dispute_confirmed($1::uuid, $2, $3::uuid)', [admin, d.disputeId, randomUUID()]);
        if (row.x === 'beforeRev') await seedDisputeReversal(db(), { disputeId: d.disputeId, amount: row.rev!.amount, createdAt: row.rev!.at });
        await settleDisputes();
      }
      expect({ row: `13/${row.id}`, ...(await measurePlan2(d.disputeId)) }).toEqual({ row: `13/${row.id}`, ...row.expected });
      await q('rollback to savepoint plan2_row13');
      await q('release savepoint plan2_row13');
    }
    expect(scenarios).toBeGreaterThan(50);
  });
});
