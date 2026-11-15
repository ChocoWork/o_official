/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { accountingFailure, insertAccountingAdmin } from './helpers/accounting-fixtures';
import { setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, dropDiscountSnapshot, failRefund, orderBalance, postOrderPayment, postRefundEvents, receiveReturn, recordRefundResult, saveRefundTxn,
  seedCancelRefund, seedPreShipmentCancel, seedRefundFlow, seedReturnArrivalEntries, seedReturnFlow, seedSlotPaidOrder, setReturnNotRequired, settleOwed, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { createUbReturn } from './helpers/unit-binding-receive';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 11c（S25。Ruling P3-T11e・P3-T11f）: 借りの一覧に出来事と返品の借りを足し、やり直しの結びの候補を出す。
// 読みなので、ROLLBACK の形（--runInBand）でコミットしない。
jest.setTimeout(240000);

type Candidate = { refund_id: string; amount: number; succeeded_on: string; event_id: string | null; event_kind: string; same_event: boolean };
type DebtRow = {
  refund_id: string; order_id: string; source: string; state: string; owed_pre: number; owed_post: number; owed_return: number;
  event_id: string | null; event_kind: string;
};

describeLocalDb('S25 refund debt reads: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await q('rollback'); });

  const fails = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  const candidatesOf = async (owedRefundId: string) =>
    ((await q('select public.list_refund_settle_candidates($1::uuid) as r', [owedRefundId])).rows[0].r as { candidates: Candidate[] }).candidates;
  const debtRows = async () =>
    ((await q('select public.list_refund_accounting_states(100, null, null) as r')).rows[0].r as { refunds: DebtRow[] }).refunds;
  const debtRow = async (refundId: string) => (await debtRows()).find((r) => r.refund_id === refundId);
  /** 出来事（返品の受け取り）を fixture で入れ、その出来事の返金を作れるようにする。 */
  async function seedEvent(orderId: string, kind = 'return_receive'): Promise<string> {
    return (await q(`insert into public.order_unit_events(order_id, kind, entitlement_previous, entitlement_max_before, entitlement_gross,
      entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund)
      values($1,$2,0,0,0,0,0,0,0,0,0,0) returning id`, [orderId, kind])).rows[0].id as string;
  }

  /**
   * 注文（18,750円・11,250円の2着）の出荷後の返金 11,250円を、借り（owed）1本・候補にできる成功3本・失敗だけ1本で作る。
   * owed と a は同じ出来事 E1、b は出来事なし（cancel_reverted の出来事）、c は別の出来事 E2。どれも出荷後の分（Q）11,250円。
   */
  async function postShipmentOrder() {
    const o = await seedSlotPaidOrder(db(), [[18750], [11250]]);
    const e1 = await seedEvent(o.orderId);
    const e2 = await seedEvent(o.orderId);
    // 出来事に結んだ返金は全部が出荷後の分（Q）。cancel_reverted の出来事は、事実の行では「出来事なし」（event_id NULL・event_kind none）
    const none = await seedEvent(o.orderId, 'cancel_reverted');
    const refund = (eventId: string) => seedCancelRefund(db(), o.orderId, eventId, 11250);
    const owed = await refund(e1);
    const a = await refund(e1);
    const b = await refund(none);
    const c = await refund(e2);
    const failedOnly = await refund(e1);
    // 残高の取引はあるが、成功の行が無い返金（候補の「成功の行」の条件だけを確かめる）
    const noSucceeded = await refund(e1);
    return { o, e1, e2, owed, a, b, c, failedOnly, noSucceeded };
  }

  test('FREQ-579-AC-05: 結びの候補は同じ注文の成功した返金で、まだ結ばれていない物だけが出て、同じ出来事の返金が先頭に来る', async () => {
    const admin = await insertAccountingAdmin(db());
    const s = await postShipmentOrder();
    // owed は引かれる前に失敗して借り（2130 refund_owed_post）を立てる。a・b・c は成功する（c、b、a の順に日付が新しい）。failedOnly は結果が無い
    await recordRefundResult(db(), s.owed, 'failed');
    await succeedRefund(db(), s.c, { at: '2026-11-05T03:00:00Z' });
    await succeedRefund(db(), s.b, { at: '2026-11-06T03:00:00Z' });
    await succeedRefund(db(), s.a, { at: '2026-11-07T03:00:00Z' });
    await saveRefundTxn(db(), s.noSucceeded, { at: '2026-11-04T03:00:00Z' });
    // Stripe の返金の番号まで持たせる（pending）。成功の行だけが無い状態で、成功の行の条件だけが候補から外す
    await recordRefundResult(db(), s.noSucceeded, 'pending');
    await postRefundEvents(db());
    expect(await orderBalance(db(), s.o.orderId, '2130', 'refund_owed_post')).toBe(11250);
    // 同じ出来事の a が先頭。そのあとは成功の日（c、b の順に日付が若い物から）と返金の番号の順。owed 自身と、成功していない failedOnly は出ない
    const rows = await candidatesOf(s.owed);
    expect(rows.map((r) => r.refund_id)).toEqual([s.a, s.c, s.b]);
    expect(rows.map((r) => r.same_event)).toEqual([true, false, false]);
    expect(rows[0]).toEqual({ refund_id: s.a, amount: 11250, succeeded_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), event_id: s.e1, event_kind: 'return_receipt', same_event: true });
    expect(rows[1]).toMatchObject({ event_id: s.e2, event_kind: 'return_receipt', same_event: false });
    expect(rows[2]).toMatchObject({ event_id: null, event_kind: 'none', same_event: false });
    // 残高の取引の日（日本時間）が、結びの仕訳の日。並びは、同じ出来事の a、次に日の若い c（5日）、b（6日）で、番号の並びに頼らない
    expect(rows.map((r) => r.succeeded_on)).toEqual(['2026-11-07', '2026-11-05', '2026-11-06']);
    // 残高の取引だけがあって成功の行が無い返金は候補に出ず、結びの関数も断る
    expect(rows.map((r) => r.refund_id)).not.toContain(s.noSucceeded);
    expect(await fails(() => settleOwed(db(), admin, s.owed, s.noSucceeded))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    // 結ばれた返金は、同じ注文の別の借りの候補からも消える。借りの残りが無ければ、どの返金も出ない
    await settleOwed(db(), admin, s.owed, s.a);
    expect(await candidatesOf(s.owed)).toEqual([]);
    // 別の借り（同じ注文の返金 failedOnly。ここで失敗する）から見ると、結ばれた a は出ない。出来事 E1 の a が外れて、c と b が出る
    await recordRefundResult(db(), s.failedOnly, 'failed');
    await postRefundEvents(db());
    const other = await candidatesOf(s.failedOnly);
    expect(other.map((r) => r.refund_id)).toEqual([s.c, s.b]);
    // 知らない返金の番号・NULL は、行なし・引数の誤り。権限の無い role は呼べない
    expect(await candidatesOf(randomUUID())).toEqual([]);
    expect(await fails(() => q('select public.list_refund_settle_candidates(null)'))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    for (const role of ['anon', 'authenticated']) {
      await q(`set local role ${role}`);
      const denied = await fails(() => q('select public.list_refund_settle_candidates($1::uuid)', [s.owed]));
      await q('reset role');
      expect({ role, denied }).toEqual({ role, denied: { code: '42501', message: 'DATABASE_ERROR' } });
    }
  });

  test('FREQ-579-AC-05: 候補に出た返金は結びの関数がそのまま受ける', async () => {
    const admin = await insertAccountingAdmin(db());
    const s = await postShipmentOrder();
    await recordRefundResult(db(), s.owed, 'failed');
    await succeedRefund(db(), s.c, { at: '2026-11-05T03:00:00Z' });
    await succeedRefund(db(), s.b, { at: '2026-11-06T03:00:00Z' });
    await succeedRefund(db(), s.a, { at: '2026-11-07T03:00:00Z' });
    await postRefundEvents(db());
    const rows = await candidatesOf(s.owed);
    expect(rows).toHaveLength(3);
    for (const candidate of rows) {
      await q('savepoint settle_each');
      const settled = await settleOwed(db(), admin, s.owed, candidate.refund_id);
      expect(settled).toMatchObject({ owed_refund_id: s.owed, paying_refund_id: candidate.refund_id, pre_amount: 0, post_amount: 11250, replayed: false });
      await q('rollback to savepoint settle_each');
      await q('release savepoint settle_each');
    }
    // 候補に出ない返金（成功していない・自分自身・別の借りで結ばれた物）は、結びの関数が断る
    expect(await fails(() => settleOwed(db(), admin, s.owed, s.failedOnly))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    expect(await fails(() => settleOwed(db(), admin, s.owed, s.owed))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
    // 切り替えの日より前の残高の取引の返金は候補から外れ、結びの関数も断る（残りの候補は変わらない）
    await setCutoverForTest(db(), '2026-11-06');
    expect((await candidatesOf(s.owed)).map((r) => r.refund_id)).toEqual([s.a, s.b]);
    expect(await fails(() => settleOwed(db(), admin, s.owed, s.c))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    // 借りの残高を超える結び（借りを振込で先に返した後）は候補から外れ、結びの関数も断る
    await setCutoverForTest(db(), '2026-01-01');
    await bankTransfer(db(), { actor: admin, orderId: s.o.orderId, origin: 'post_shipment', amount: 11250, on: '2026-11-10', txn: 'S25-1' });
    expect(await candidatesOf(s.owed)).toEqual([]);
    expect(await fails(() => settleOwed(db(), admin, s.owed, s.a))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
  });

  test('FREQ-579-AC-05: 発送前の取り消しの出来事の借りには候補が出ない', async () => {
    const admin = await insertAccountingAdmin(db());
    const f = await seedRefundFlow(db(), false, 2);
    await postOrderPayment(db(), f.orderId);
    const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
    await failRefund(db(), c.refundId);
    await postRefundEvents(db());
    expect(await orderBalance(db(), f.orderId, '2130', 'refund_owed_pre')).toBe(17000);
    // 同じ注文に、成功した別の返金がある（出来事なし）。それでも、出荷前の取り消しの借りには候補を出さない
    const other = (await q(`select * from public.begin_order_refund($1,'admin',$2,'[]'::jsonb,false,0,1000,null,'requested_by_customer',null,false,$3,null,null)`,
      [f.orderId, randomUUID(), f.actor])).rows[0].refund_id as string;
    await succeedRefund(db(), other, { at: '2026-11-08T03:00:00Z' });
    await postRefundEvents(db());
    expect(await candidatesOf(c.refundId)).toEqual([]);
    expect(await fails(() => settleOwed(db(), admin, c.refundId, other))).toMatchObject({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' });
    // 出来事の無い写しの無い注文の借りには、同じ形で候補が出る
    const p = await seedRefundFlow(db(), false, 2);
    await dropDiscountSnapshot(db(), p.orderId);
    await postOrderPayment(db(), p.orderId);
    const owed = (await hBegin(db(), p, 17000, true)).refund_id;
    await failRefund(db(), owed);
    await postRefundEvents(db());
    const retry = (await hBegin(db(), p, 17000, true)).refund_id;
    await succeedRefund(db(), retry, { at: '2026-11-08T03:00:00Z' });
    await postRefundEvents(db());
    expect((await candidatesOf(owed)).map((r) => [r.refund_id, r.same_event, r.event_kind])).toEqual([[retry, false, 'none']]);
    expect(await settleOwed(db(), admin, owed, retry)).toMatchObject({ pre_amount: 17000, post_amount: 0 });
  });

  test('FREQ-579-AC-04: 返品の返金が返すつもりのまま残ると借りの一覧に出て、その額を origin return の振込が受ける', async () => {
    const admin = await insertAccountingAdmin(db());
    const flow = await seedReturnFlow(db(), {});
    const received = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    await seedReturnArrivalEntries(db(), flow.returnId);
    const refundId = received.refund_id as string;
    const orderId = flow.f.orderId;
    // 引かれる前に失敗した返品の返金は仕訳を作らず、届いた日の返品の返金待ち（2130 return_refund）がそのまま残る
    await failRefund(db(), refundId);
    await postRefundEvents(db());
    expect(await orderBalance(db(), orderId, '2130', 'return_refund')).toBe(16875);
    expect(await debtRow(refundId)).toMatchObject({ source: 'return', state: 'failed', owed_pre: 0, owed_post: 0, owed_return: 16875, event_kind: 'return_receipt' });
    // 一覧の額を超える origin return の振込は断られ、その額ちょうどは受けられる。受けた後は、その返金は一覧から消える
    const base = { actor: admin, orderId, origin: 'return' as const, on: '2026-11-10' };
    expect(await fails(() => bankTransfer(db(), { ...base, amount: 16876, txn: 'R25-1' }))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    expect((await bankTransfer(db(), { ...base, amount: 16875, txn: 'R25-2' })).created).toBe(true);
    expect(await debtRow(refundId)).toBeUndefined();
  });

  /** 返品の受け取りの返金が引かれる前に失敗した返品の借り（返品の返金 16,875 円）。 */
  async function failedReturnDebt() {
    const flow = await seedReturnFlow(db(), {});
    const received = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    await seedReturnArrivalEntries(db(), flow.returnId);
    const refundId = received.refund_id as string;
    await failRefund(db(), refundId);
    await postRefundEvents(db());
    return { flow, refundId, orderId: flow.f.orderId as string };
  }
  /** 同じ返品の、Stripe で処理中の返品の返金（order_refunds の行だけ。open_total と同じく awaiting_response か pending）。 */
  async function inFlightReturnRefund(flow: Awaited<ReturnType<typeof seedReturnFlow>>, amount: number) {
    return (await q(`insert into public.order_refunds(order_id, source, return_id, request_key, request_fingerprint, status, amount, shipping_amount,
      adjustment_amount, notify_customer) values($1,'return',$2,gen_random_uuid(),'fixture','awaiting_response',$3,0,$3,false) returning id`,
    [flow.f.orderId, flow.returnId, amount])).rows[0].id as string;
  }
  const setStatus = (refundId: string, status: string) => q('update public.order_refunds set status = $2 where id = $1', [refundId, status]);

  test('FREQ-579-AC-04: 返品の借りの額は、その返金の額と、処理中の返品の返金を引いた注文の残高を超えない', async () => {
    // 同じ注文の2つの返品の返金が、どちらも引かれる前に失敗した状態（本物の道で作れる）。残高は2つの借りの合計になる
    const d = await failedReturnDebt();
    const ret2 = await createUbReturn(db(), d.flow.f, [{ quantity: 1 }], { percent: 10 });
    const flow2 = { f: d.flow.f, returnId: ret2.returnId, lineIds: ret2.lineIds };
    const received2 = await receiveReturn(db(), flow2, { units: [{ return_line_id: ret2.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    await seedReturnArrivalEntries(db(), flow2.returnId);
    const b = received2.refund_id as string;
    await failRefund(db(), b);
    await postRefundEvents(db());
    const own = async (id: string) => Number((await q('select post_shipment_amount::int n from public.accounting_refund_facts where refund_id = $1', [id])).rows[0].n);
    const [ownA, ownB] = [await own(d.refundId), await own(b)];
    const balance = await orderBalance(db(), d.orderId, '2130', 'return_refund');
    expect(balance).toBe(ownA + ownB);
    // 注文の残高は両方の合計だが、各行はその返金自身の額まで（二重に見せない）
    expect(await debtRow(d.refundId)).toMatchObject({ owed_return: ownA });
    expect(await debtRow(b)).toMatchObject({ owed_return: ownB });
    // 処理中の返品の返金は、注文の残高から引く。残高が各行の額より小さくなれば、その残高で止まる。pending になっても同じ
    const live = await inFlightReturnRefund(d.flow, balance - 10000);
    expect(await debtRow(d.refundId)).toMatchObject({ owed_return: Math.min(ownA, 10000) });
    expect(await debtRow(b)).toMatchObject({ owed_return: Math.min(ownB, 10000) });
    await setStatus(live, 'pending');
    expect(await debtRow(d.refundId)).toMatchObject({ owed_return: Math.min(ownA, 10000) });
    // 残高以上の処理中の分があれば 0 で止まり（負にならない）、どちらの行も消える
    const big = await inFlightReturnRefund(d.flow, balance);
    expect(await debtRow(d.refundId)).toBeUndefined();
    expect(await debtRow(b)).toBeUndefined();
    // 失敗した返金は引かない
    await setStatus(live, 'failed');
    await setStatus(big, 'failed');
    expect(await debtRow(d.refundId)).toMatchObject({ owed_return: ownA });
    expect(await debtRow(b)).toMatchObject({ owed_return: ownB });
    expect(await debtRow(d.refundId)).toMatchObject({ owed_pre: 0, owed_post: 0 });
  });

  test('FREQ-579-AC-04: 同じ注文に Stripe で処理中の返品の返金がある間は、返品の借りの振込を断る', async () => {
    const admin = await insertAccountingAdmin(db());
    const d = await failedReturnDebt();
    const base = { actor: admin, orderId: d.orderId, origin: 'return' as const, on: '2026-11-10' };
    const refused = { code: '55000', message: 'ACCOUNTING_REFUND_IN_FLIGHT' };
    const live = await inFlightReturnRefund(d.flow, 5000);
    expect(await fails(() => bankTransfer(db(), { ...base, amount: 10000, txn: 'IF-1' }))).toEqual(refused);
    await setStatus(live, 'pending');
    expect(await fails(() => bankTransfer(db(), { ...base, amount: 10000, txn: 'IF-1' }))).toEqual(refused);
    // ほかの借りの種類（出荷後）は、この断りの対象外（残高の断りだけが出る）
    expect(await fails(() => bankTransfer(db(), { ...base, origin: 'post_shipment', amount: 1, txn: 'IF-2' }))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
    // 処理中の返金が失敗すると、同じ振込が通る。成功した場合も同じ
    await setStatus(live, 'failed');
    expect((await bankTransfer(db(), { ...base, amount: 10000, txn: 'IF-1' })).created).toBe(true);
    const second = await inFlightReturnRefund(d.flow, 1000);
    expect(await fails(() => bankTransfer(db(), { ...base, amount: 1000, txn: 'IF-3' }))).toEqual(refused);
    await setStatus(second, 'succeeded');
    expect((await bankTransfer(db(), { ...base, amount: 1000, txn: 'IF-3' })).created).toBe(true);
    // 同じ銀行の取引の番号の再送は、処理中でも前の結果を返す（新しい記録ではない）
    await inFlightReturnRefund(d.flow, 100);
    expect(await bankTransfer(db(), { ...base, amount: 10000, txn: 'IF-1' })).toMatchObject({ created: false });
  });

  test('FREQ-579-AC-05: 普通の返品の借り（2130 return_refund）は結びを断り、同じ注文の出荷後の借り（refund_owed_post）を消さない。候補も出ない。出荷後の借りはこれまで通り結べる（P3-F2）', async () => {
    const admin = await insertAccountingAdmin(db());
    const d = await failedReturnDebt();
    const orderId = d.orderId;
    // 同じ注文の出荷後の返金 Y（失敗。引かれる前なので 4020／2130 refund_owed_post）と、成功した返金 P（候補になる）
    const y = await seedCancelRefund(db(), orderId, null, 5000);
    const p = await seedCancelRefund(db(), orderId, null, 5000);
    const fact = async (id: string) => (await q('select pre_shipment_amount::int p, post_shipment_amount::int q from public.accounting_refund_facts where refund_id=$1', [id])).rows[0];
    expect(await fact(y)).toEqual({ p: 0, q: 5000 });
    expect(await fact(p)).toEqual({ p: 0, q: 5000 });
    await failRefund(db(), y);
    await succeedRefund(db(), p, { at: '2026-11-08T03:00:00Z' });
    await postRefundEvents(db());
    expect(await orderBalance(db(), orderId, '2130', 'return_refund')).toBe(16875);
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(5000);
    // 普通の返品の借り X: 断る（残高の合計は足りるので、断りが無ければ Y の借りを減らしてしまう形）。候補も出ない
    expect(await candidatesOf(d.refundId)).toEqual([]);
    expect(await fails(() => settleOwed(db(), admin, d.refundId, p))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID', detail: 'settle_plain_return' });
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(5000);
    expect(await orderBalance(db(), orderId, '2130', 'return_refund')).toBe(16875);
    expect((await q('select count(*)::int n from public.accounting_refund_settlements where owed_refund_id = $1', [d.refundId])).rows[0].n).toBe(0);
    // 出荷後の借り Y は、P で結べる
    expect((await candidatesOf(y)).map((r) => r.refund_id)).toEqual([p]);
    expect(await settleOwed(db(), admin, y, p)).toMatchObject({ pre_amount: 0, post_amount: 5000, replayed: false });
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(0);
    expect(await orderBalance(db(), orderId, '2130', 'return_refund')).toBe(16875);
  });

  test('FREQ-579-AC-05: 成功した普通の返品の返金（2130 return_refund から払った返金）を払い手にした結びは断り、出荷後の借りも返品の返金待ちも動かさず、候補にも出さない（P3-F8）', async () => {
    const admin = await insertAccountingAdmin(db());
    const flow = await seedReturnFlow(db(), {});
    const received = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    await seedReturnArrivalEntries(db(), flow.returnId);
    const payer = received.refund_id as string;
    const orderId = flow.f.orderId as string;
    // 払い手 P: 成功した普通の返品の返金（2130 return_refund ／ 1160）。借り X: 同じ注文の出荷後の返金で、引かれる前に失敗（4020 ／ 2130 refund_owed_post）
    await succeedRefund(db(), payer, { at: '2026-11-08T03:00:00Z' });
    const x = await seedCancelRefund(db(), orderId, null, 5000);
    await failRefund(db(), x);
    await postRefundEvents(db());
    expect(await orderBalance(db(), orderId, '2130', 'return_refund')).toBe(0);
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(5000);
    const before = (await q('select count(*)::int n from public.accounting_journal_entries')).rows[0].n;
    // 候補に出ない
    expect((await candidatesOf(x)).map((r) => r.refund_id)).not.toContain(payer);
    expect(await candidatesOf(x)).toEqual([]);
    // 結びは断る。仕訳も結びの行も増えず、残高は動かない
    expect(await fails(() => settleOwed(db(), admin, x, payer))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID', detail: 'settle_plain_return_payer' });
    expect((await q('select count(*)::int n from public.accounting_journal_entries')).rows[0].n).toBe(before);
    expect((await q('select count(*)::int n from public.accounting_refund_settlements where owed_refund_id = $1', [x])).rows[0].n).toBe(0);
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(5000);
    expect(await orderBalance(db(), orderId, '2130', 'return_refund')).toBe(0);
    // 普通でない払い手（出荷後の管理者の返金）なら、同じ借りをこれまで通り結べる
    const other = await seedCancelRefund(db(), orderId, null, 5000);
    await succeedRefund(db(), other, { at: '2026-11-09T03:00:00Z' });
    await postRefundEvents(db());
    expect((await candidatesOf(x)).map((r) => r.refund_id)).toEqual([other]);
    expect(await settleOwed(db(), admin, x, other)).toMatchObject({ pre_amount: 0, post_amount: 5000 });
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(0);
  });

  test('FREQ-579-AC-05: 前の注文から差し引いた分を返す返金（holdback_release）と返送不要の返品の返金は、払い手としてこれまで通り出荷後の借りを結べる（P3-F8 は普通の返品の返金だけを断る）', async () => {
    const admin = await insertAccountingAdmin(db());
    const flow = await seedReturnFlow(db(), {});
    await setReturnNotRequired(db(), flow.returnId);
    const received = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    const notRequired = received.refund_id as string;
    const orderId = flow.f.orderId as string;
    // 払い手 H: 前の注文から差し引いた分を返す返金の事実を直接書く（refund_posting の試験と同じ fixture）
    const eventId = (await q(`insert into public.order_unit_events(order_id, kind, entitlement_previous, entitlement_max_before, entitlement_gross,
      entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund)
      values($1,'hold_release',0,0,0,0,0,0,0,3000,3000,0) returning id`, [orderId])).rows[0].id as string;
    const hold = (await q(`insert into public.order_refunds(order_id, source, request_key, request_fingerprint, status, amount, shipping_amount,
      adjustment_amount, notify_customer) values($1,'admin',gen_random_uuid(),'fixture','awaiting_response',3000,0,3000,false) returning id`, [orderId])).rows[0].id as string;
    await q("select private.accounting_record_refund_event($1,'requested')", [hold]);
    await q(`insert into public.accounting_refund_facts(refund_id, order_id, source, event_id, event_kind, pre_shipment_amount,
      post_shipment_amount, shipping_amount, fee_amount) values($1,$2,'unit_hold_release',$3,'holdback_release',0,3000,0,0)`, [hold, orderId, eventId]);
    // 借り X1・X2: 同じ注文の出荷後の返金が、引かれる前に失敗（各 2,000円。4020／2130 refund_owed_post）
    const x1 = await seedCancelRefund(db(), orderId, null, 2000);
    const x2 = await seedCancelRefund(db(), orderId, null, 2000);
    await failRefund(db(), x1);
    await failRefund(db(), x2);
    await succeedRefund(db(), hold, { at: '2026-11-08T03:00:00Z' });
    await succeedRefund(db(), notRequired, { at: '2026-11-09T03:00:00Z' });
    await postRefundEvents(db());
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(4000);
    expect((await candidatesOf(x1)).map((r) => r.refund_id).sort()).toEqual([hold, notRequired].sort());
    expect(await settleOwed(db(), admin, x1, hold)).toMatchObject({ pre_amount: 0, post_amount: 2000 });
    expect(await settleOwed(db(), admin, x2, notRequired)).toMatchObject({ pre_amount: 0, post_amount: 2000 });
    expect(await orderBalance(db(), orderId, '2130', 'refund_owed_post')).toBe(0);
  });

  test('FREQ-579-AC-04: 借りの一覧の行に event_id と event_kind がある', async () => {
    const f = await seedRefundFlow(db(), false, 2);
    await postOrderPayment(db(), f.orderId);
    const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
    await failRefund(db(), c.refundId);
    await postRefundEvents(db());
    expect(await debtRow(c.refundId)).toMatchObject({ order_id: f.orderId, event_id: c.eventId, event_kind: 'pre_shipment_cancel', owed_pre: 17000, owed_post: 0, owed_return: 0 });
    // 出来事の無い借りは event_id が NULL・event_kind が none。ほかの行の形は変わらず、owed_return は 0
    const p = await seedRefundFlow(db(), false, 2);
    await dropDiscountSnapshot(db(), p.orderId);
    await postOrderPayment(db(), p.orderId);
    const plain = (await hBegin(db(), p, 17000, true)).refund_id;
    await failRefund(db(), plain);
    await postRefundEvents(db());
    const row = await debtRow(plain);
    expect(row).toMatchObject({ order_id: p.orderId, event_id: null, event_kind: 'none', owed_pre: 17000, owed_post: 0, owed_return: 0 });
    expect(Object.keys(row as object).sort()).toEqual(['canceled_at', 'event_id', 'event_kind', 'order_id', 'order_number', 'owed_post', 'owed_pre', 'owed_return',
      'post_amount', 'pre_amount', 'refund_id', 'source', 'state']);
  });
});
