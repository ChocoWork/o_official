/** @jest-environment node */
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, failRefund, orderBalance, orderLines, postRefundEvents, postReturnEvents, receiveReturn, returnFacts, seedReturnFlow,
  setReturnNotRequired, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 最終レビューの直し（S26。Ruling P3-F1。設計 5-e・計画の未確認事項 14）: 品を送り返さない返品（return_method が not_required）の返金は、
// 届いた日の仕訳を作らず、返金した日に「売上値引・返品／Stripe未収金」の1本だけを立てる。失敗した時の借りは出荷後の返金の未払いに入る。
// 本物の受け取り（admin_receive_return）と返金の係（accounting_post_refund_events）を通す。ROLLBACK の形でコミットしない。
jest.setTimeout(240000);

describeLocalDb('FREQ-579-AC-01: S26 not_required return refunds', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const shape = (rows: Array<Record<string, unknown>>) => rows.map((l) => [l.account_code, l.debit, l.credit, l.sub_account ?? null]);
  const entriesOf = async (orderId: string, kind: string) => (await orderLines(db(), orderId)).filter((l) => l.event_kind === kind);

  /** 品を送り返さない返品を、今すぐ返金する選び方で受け取る（返金の本数は1本）。 */
  async function notRequiredReceive() {
    const flow = await seedReturnFlow(db(), {});
    await setReturnNotRequired(db(), flow.returnId);
    const received = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    const refundId = received.refund_id as string;
    expect(refundId).toBeTruthy();
    const amount = Number((await q('select amount::int as n from public.order_refunds where id = $1', [refundId])).rows[0].n);
    expect(amount).toBeGreaterThan(0);
    return { flow, refundId, amount, orderId: flow.f.orderId as string };
  }

  test('FREQ-579-AC-01: 返送不要の返品は、受け取っても届いた日・額の決定の仕訳も事実も作らず、返金した日に 4020／1160 の1本だけが立ち、2130 に何も立たない', async () => {
    const r = await notRequiredReceive();
    expect(await returnFacts(db(), r.flow.returnId)).toEqual([]);
    await postReturnEvents(db(), 200);
    expect(await entriesOf(r.orderId, 'return_arrived')).toEqual([]);
    expect(await entriesOf(r.orderId, 'return_amount_decided')).toEqual([]);
    const txn = await succeedRefund(db(), r.refundId, { at: '2026-11-08T03:00:00Z' });
    expect(await postRefundEvents(db())).toMatchObject({ posted: 1, parked_new: 0 });
    const lines = await entriesOf(r.orderId, 'return_refund');
    expect(shape(lines)).toEqual([['4020', r.amount, 0, null], ['1160', 0, r.amount, null]]);
    expect(lines.every((l) => l.dedupe_key === `return_refund:${txn}` && l.entry_date === '2026-11-08')).toBe(true);
    expect((await orderLines(db(), r.orderId)).filter((l) => l.account_code === '2130')).toEqual([]);
    expect(await orderBalance(db(), r.orderId, '2130')).toBe(0);
    // その返品の仕訳は、返金の1本だけ（届いた日の仕訳が前の日に立つことは無い）
    expect((await orderLines(db(), r.orderId)).filter((l) => l.account_code === '4020').map((l) => l.entry_date)).toEqual(['2026-11-08']);
  });

  test('FREQ-579-AC-01: 返送不要の返品の返金が次の年の日に引かれると、その仕訳は返金した日の年の期間に入る（受け取った年へ寄せない）', async () => {
    const r = await notRequiredReceive();
    await succeedRefund(db(), r.refundId, { at: '2027-01-02T03:00:00Z' });
    expect(await postRefundEvents(db())).toMatchObject({ posted: 1 });
    const rows = (await q(`select e.entry_date::text as d, p.starts_on::text as starts_on, p.ends_on::text as ends_on
      from public.accounting_journal_entries e join public.accounting_periods p on p.id = e.period_id
      where e.event_kind = 'return_refund' and e.source_table = 'order_refunds' and e.source_id = $1`, [r.refundId])).rows;
    expect(rows).toEqual([{ d: '2027-01-02', starts_on: '2027-01-01', ends_on: '2027-12-31' }]);
    expect((await orderLines(db(), r.orderId)).filter((l) => l.account_code === '4020' && l.entry_date.startsWith('2026'))).toEqual([]);
  });

  test('FREQ-579-AC-01: 返送不要の返品の返金が引かれる前に失敗すると、借りは出荷後の返金の未払い（refund_owed_post）に入り、返品の返金待ち（2130 return_refund）は立たず、出荷後の振込で消える', async () => {
    const admin = await insertAccountingAdmin(db());
    const r = await notRequiredReceive();
    await failRefund(db(), r.refundId);
    expect(await postRefundEvents(db())).toMatchObject({ posted: 1 });
    expect(shape(await entriesOf(r.orderId, 'refund_failed'))).toEqual([['4020', r.amount, 0, null], ['2130', 0, r.amount, 'refund_owed_post']]);
    expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(0);
    expect(await orderBalance(db(), r.orderId, '2130', 'refund_owed_post')).toBe(r.amount);
    const rows = ((await q('select public.list_refund_accounting_states(100, null, null) as r')).rows[0].r as { refunds: Array<Record<string, unknown>> }).refunds;
    expect(rows.find((x) => x.refund_id === r.refundId)).toMatchObject({ owed_pre: 0, owed_post: r.amount, owed_return: 0 });
    // 出荷後の借りとして、origin post_shipment の振込がその額ちょうどを受ける
    const transfer = await bankTransfer(db(), { actor: admin, orderId: r.orderId, origin: 'post_shipment', amount: r.amount, on: '2026-11-10', txn: 'F1-1' });
    expect(transfer.created).toBe(true);
    expect(await orderBalance(db(), r.orderId, '2130', 'refund_owed_post')).toBe(0);
  });

  test('FREQ-579-AC-01: 普通の返品（品を送り返す）の返金は今まで通り、届いた日の仕訳と 2130 return_refund を通る', async () => {
    const flow = await seedReturnFlow(db(), {});
    const received = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    expect((await returnFacts(db(), flow.returnId)).map((f) => f.kind)).toEqual(['arrival', 'decision']);
    await postReturnEvents(db(), 200);
    await succeedRefund(db(), received.refund_id as string, { at: '2026-11-08T03:00:00Z' });
    expect(await postRefundEvents(db())).toMatchObject({ posted: 1 });
    expect((await entriesOf(flow.f.orderId, 'return_refund')).map((l) => [l.account_code, l.sub_account ?? null])).toEqual([['2130', 'return_refund'], ['1160', null]]);
  });
});
