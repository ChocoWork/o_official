/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { addDisputeHistory, seedDispute, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, cancelRefund, decideRefund, dropDiscountSnapshot, failRefund, orderBalance, orderLines, postOrderPayment, postRefundEvents,
  receiveReturn, recordRefundResult, refundPending, saveFailureTxn, saveRefundTxn, seedPreShipmentCancel, seedRefundFlow,
  seedReturnArrivalEntries, seedReturnFlow, settleOwed, shipAndPost, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 6（S20）: 返金の失敗・Stripe の取り消し・区分・振込・やり直しとの結びの仕訳。
jest.setTimeout(120000);

type Failure = { code?: string; message?: string; detail?: string };

describeLocalDb('FREQ-579-AC-02: S20 refund failures, cancels, bank transfers and settles', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint s20_expected');
    try { await run(); return {}; }
    catch (caught) { const e = caught as Failure; return { code: e.code, message: e.message, detail: e.detail }; }
    finally { await q('rollback to savepoint s20_expected'); await q('release savepoint s20_expected'); }
  }
  const today = async () => (await q("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d as string;
  const entriesOf = async (orderId: string, kind: string) => (await orderLines(db(), orderId)).filter((l) => l.event_kind === kind);
  const shape = (rows: Array<Record<string, unknown>>) => rows.map((l) => [l.account_code, l.debit, l.credit, l.sub_account ?? null]);
  const entryCount = async (orderId: string) => new Set((await orderLines(db(), orderId)).map((l) => l.entry_id)).size;
  const allocationLeft = async (key: string) => Number((await q(`select coalesce(sum(amount),0)::int n from public.accounting_unit_refund_allocations
    where refund_key=$1 or refund_key like 'release:' || $1 || ':%'`, [key])).rows[0].n);
  const allocations = async (orderId: string) => (await q(`select a.order_item_id, a.unit_index, a.refund_key, a.amount from public.accounting_unit_refund_allocations a
    join public.order_items oi on oi.id=a.order_item_id where oi.order_id=$1 order by a.refund_key, a.order_item_id, a.unit_index`, [orderId])).rows;
  const markError = (refundId: string) => q("select * from private.mark_order_refund_error($1,'timeout',false)", [refundId]);
  /** 写しのある2着（20,000円・17,000円）の注文に支払いの仕訳を入れ、1着を発送前に取り消した返金（17,000円）。 */
  async function pscRefund() {
    const f = await seedRefundFlow(db(), false, 2);
    await postOrderPayment(db(), f.orderId);
    const c = await seedPreShipmentCancel(db(), f, { itemId: f.itemId, quantity: 1 });
    return { f, ...c };
  }
  /** 写しの無い2着（20,000円・17,000円）の注文に支払いの仕訳を入れ、17,000円の着の出荷前の返金（P3-D3。出来事の無い返金）。 */
  async function plainBeforeRefund(amount = 17000) {
    const f = await seedRefundFlow(db(), false, 2);
    await dropDiscountSnapshot(db(), f.orderId);
    await postOrderPayment(db(), f.orderId);
    const refundId = (await hBegin(db(), f, amount, true)).refund_id;
    return { f, refundId };
  }
  /** 返品の受け取り（今すぐ）の返金 16,875円と、届いた日の仕訳（4020 18,750円／2130 16,875円・手数料 1,875円）。 */
  async function returnRefund() {
    const flow = await seedReturnFlow(db(), {});
    const r = await receiveReturn(db(), flow, { units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1 }], choice: 'now' });
    await seedReturnArrivalEntries(db(), flow.returnId);
    return { flow, orderId: flow.f.orderId, refundId: r.refund_id as string };
  }

  describe('failures', () => {
    test('FREQ-579-AC-02: 引かれた後に失敗した返金は、戻りの取引の日に「Stripe未収金／返金の未払い」で、元の返金の仕訳は変わらない', async () => {
      const c = await pscRefund();
      await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      const before = await entriesOf(c.f.orderId, 'pre_shipment_refund');
      await failRefund(db(), c.refundId, { pulled: true, at: '2026-11-07T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(1);
      const failed = await entriesOf(c.f.orderId, 'refund_failed');
      expect(shape(failed)).toEqual([['1160', 17000, 0, null], ['2130', 0, 17000, 'refund_owed_pre']]);
      expect(failed.every((l) => l.entry_date === '2026-11-07' && l.order_id === c.f.orderId)).toBe(true);
      expect(await entriesOf(c.f.orderId, 'pre_shipment_refund')).toEqual(before);
    });

    test('FREQ-579-AC-02: 引かれる前に失敗した出荷前の返金は、決まった日に「前受金／返金の未払い」を1回だけ立てる', async () => {
      const c = await pscRefund();
      await failRefund(db(), c.refundId);
      const row = (await q("select id from public.accounting_refund_events where refund_id=$1 and state='failed'", [c.refundId])).rows[0].id;
      expect((await postRefundEvents(db())).posted).toBe(1);
      expect((await postRefundEvents(db())).posted).toBe(0);
      const failed = await entriesOf(c.f.orderId, 'refund_failed');
      expect(shape(failed)).toEqual([['2150', 17000, 0, null], ['2130', 0, 17000, 'refund_owed_pre']]);
      expect(failed.map((l) => l.entry_date)).toEqual([await today(), await today()]);
      const key = (await q("select private.accounting_event_key('refund_failed', array[$1::text, $2::text]) as k", [c.refundId, row])).rows[0].k;
      expect(failed.every((l) => l.dedupe_key === key)).toBe(true);
    });

    test('FREQ-579-AC-02: 引かれる前に失敗した返品の返金は仕訳を作らず、届いた日の未払金がそのまま残る', async () => {
      const r = await returnRefund();
      await failRefund(db(), r.refundId);
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1, resolved: 1 });
      expect(await refundPending(db(), r.refundId)).toMatchObject([{ event_kind: 'refund_failed', reason: 'no_revenue' }]);
      expect((await refundPending(db(), r.refundId))[0].resolved_at).not.toBeNull();
      expect(await entriesOf(r.orderId, 'refund_failed')).toEqual([]);
      expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(16875);
    });

    test('FREQ-579-AC-02: 戻りの取引がまだ無い失敗は refund_prior_unposted で待ち、取引が同期されると入る', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const r = (await hBegin(db(), f, 5000, false)).refund_id;
      await succeedRefund(db(), r, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await recordRefundResult(db(), r, 'failed');
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      expect((await refundPending(db(), r)).find((p) => p.event_kind === 'refund_failed')).toMatchObject({
        reason: 'refund_prior_unposted', detail: { why: 'failure_txn_missing' }, resolved_at: null });
      await saveFailureTxn(db(), r, { at: '2026-11-08T03:00:00Z' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 1, resolved: 1 });
      expect(shape(await entriesOf(f.orderId, 'refund_failed'))).toEqual([['1160', 5000, 0, null], ['2130', 0, 5000, 'refund_owed_post']]);
    });

    test('FREQ-579-AC-02: 失敗の後に再試行の返金が成功しても、ふつうの返金は借りの残高を読まず前受金を減らす。やり直しと結ぶ操作で、借りと二重に減らした前受金が戻る', async () => {
      const admin = await insertAccountingAdmin(db());
      const p = await plainBeforeRefund();
      await failRefund(db(), p.refundId);
      await postRefundEvents(db());
      expect(await orderBalance(db(), p.f.orderId, '2150')).toBe(20000);
      const retry = (await hBegin(db(), p.f, 17000, true)).refund_id;
      await succeedRefund(db(), retry, { at: '2026-11-08T03:00:00Z' });
      await postRefundEvents(db());
      expect(shape(await entriesOf(p.f.orderId, 'pre_shipment_refund'))).toEqual([['2150', 17000, 0, null], ['1160', 0, 17000, null]]);
      expect(await orderBalance(db(), p.f.orderId, '2150')).toBe(3000);
      expect(await orderBalance(db(), p.f.orderId, '2130', 'refund_owed_pre')).toBe(17000);
      const settled = await settleOwed(db(), admin, p.refundId, retry);
      expect(settled).toMatchObject({ pre_amount: 17000, post_amount: 0, replayed: false });
      expect(await orderBalance(db(), p.f.orderId, '2150')).toBe(20000);
      expect(await orderBalance(db(), p.f.orderId, '2130', 'refund_owed_pre')).toBe(0);
      const lines = (await orderLines(db(), p.f.orderId)).filter((l) => l.source_table === 'accounting_refund_settlements');
      expect(shape(lines)).toEqual([['2130', 17000, 0, 'refund_owed_pre'], ['2150', 0, 17000, null]]);
      expect(lines[0].entry_date).toBe('2026-11-08');
    });

    test('FREQ-579-AC-02: error の返金が後で成功しても、成功の仕訳が入り、割り当ては動かずに出荷の売上から引かれる', async () => {
      const p = await plainBeforeRefund();
      const before = await allocations(p.f.orderId);
      await markError(p.refundId);
      await succeedRefund(db(), p.refundId, { at: '2026-11-08T03:00:00Z' });
      expect((await postRefundEvents(db())).posted).toBe(1);
      expect(await allocations(p.f.orderId)).toEqual(before);
      expect(shape(await entriesOf(p.f.orderId, 'pre_shipment_refund'))).toEqual([['2150', 17000, 0, null], ['1160', 0, 17000, null]]);
      await shipAndPost(db(), p.f.orderId, p.f.itemId, 1, p.f.actor);
      expect((await entriesOf(p.f.orderId, 'shipment_confirmed')).filter((l) => l.account_code === '4010').map((l) => l.credit)).toEqual([20000]);
      expect(await orderBalance(db(), p.f.orderId, '2150')).toBe(0);
    });

    test('FREQ-579-AC-02: 成功した返金が後で失敗しても、失敗の仕訳（引かれた後）が足される', async () => {
      const f = await seedRefundFlow(db(), true, 2);
      const r = (await hBegin(db(), f, 5000, false)).refund_id;
      await succeedRefund(db(), r, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await failRefund(db(), r, { pulled: true, at: '2026-11-09T03:00:00Z' });
      await postRefundEvents(db());
      expect(shape(await entriesOf(f.orderId, 'return_refund'))).toEqual([['4020', 5000, 0, null], ['1160', 0, 5000, null]]);
      const failed = await entriesOf(f.orderId, 'refund_failed');
      expect(shape(failed)).toEqual([['1160', 5000, 0, null], ['2130', 0, 5000, 'refund_owed_post']]);
      expect(failed[0].entry_date).toBe('2026-11-09');
    });

    test('FREQ-579-AC-02: error を抜けて failed になった返金（引かれる前・引かれた後）は、割り当てが残ったまま借りが立つ', async () => {
      for (const pulled of [false, true]) {
        await q('savepoint s20_case');
        const p = await plainBeforeRefund();
        const before = await allocations(p.f.orderId);
        await markError(p.refundId);
        if (pulled) {
          await saveRefundTxn(db(), p.refundId, { at: '2026-11-05T03:00:00Z' });
          await recordRefundResult(db(), p.refundId, 'succeeded');
          await failRefund(db(), p.refundId, { pulled: true, at: '2026-11-07T03:00:00Z' });
        } else {
          await failRefund(db(), p.refundId);
        }
        await postRefundEvents(db());
        expect(await allocations(p.f.orderId)).toEqual(before);
        expect(before.reduce((s, a) => s + a.amount, 0)).toBe(17000);
        expect(await orderBalance(db(), p.f.orderId, '2130', 'refund_owed_pre')).toBe(17000);
        await q('rollback to savepoint s20_case');
      }
    });

    test('FREQ-579-AC-02: 返品の返金が引かれる前に失敗しても引かれた後に失敗しても、やり直しが成功すれば2130（返品の返金）が0で、4020は18,750円のまま', async () => {
      for (const pulled of [false, true]) {
        await q('savepoint s20_case');
        const r = await returnRefund();
        if (pulled) {
          await succeedRefund(db(), r.refundId, { at: '2026-11-05T03:00:00Z' });
          await postRefundEvents(db());
          await failRefund(db(), r.refundId, { pulled: true, at: '2026-11-07T03:00:00Z' });
        } else {
          await failRefund(db(), r.refundId);
        }
        await postRefundEvents(db());
        const retry = (await q('select * from public.admin_refund_return($1,$2,$3,null,0,null,false)', [r.flow.returnId, r.flow.f.actor, randomUUID()])).rows[0].refund_id as string;
        await succeedRefund(db(), retry, { at: '2026-11-09T03:00:00Z' });
        await postRefundEvents(db());
        expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(0);
        expect(-(await orderBalance(db(), r.orderId, '4020'))).toBe(18750);
        await q('rollback to savepoint s20_case');
      }
    });
  });

  describe('Stripe cancels and the decision', () => {
    test('FREQ-579-AC-03: Stripe が取り消した返金は区分を選ぶまで refund_cancel_undecided で待ち、手では閉じられない', async () => {
      const admin = await insertAccountingAdmin(db());
      const c = await pscRefund();
      await cancelRefund(db(), c.refundId);
      const row = (await q("select id from public.accounting_refund_events where refund_id=$1 and state='canceled'", [c.refundId])).rows[0].id as string;
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1 });
      const [parked] = await refundPending(db(), row);
      expect(parked).toMatchObject({ event_kind: 'refund_abandoned', source_table: 'accounting_refund_events', reason: 'refund_cancel_undecided',
        detail: { refund_id: c.refundId, canceled_on: await today() }, resolved_at: null });
      const pendingId = (await q('select id from public.accounting_pending_events where source_id=$1', [row])).rows[0].id;
      expect(await failure(() => q('select public.admin_resolve_accounting_pending_event($1,$2,$3,$4)', [admin, pendingId, 'close', randomUUID()])))
        .toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, reparked: 1 });
      expect(await entryCount(c.f.orderId)).toBe(1);
    });

    test('FREQ-579-AC-03: 区分「店は返すつもりのまま返せなかった」を選ぶと失敗と同じ借りが立つ', async () => {
      const c = await pscRefund();
      await cancelRefund(db(), c.refundId);
      await postRefundEvents(db());
      await decideRefund(db(), c.refundId, 'owed');
      expect(await postRefundEvents(db())).toMatchObject({ posted: 1, resolved: 1 });
      expect(shape(await entriesOf(c.f.orderId, 'refund_failed'))).toEqual([['2150', 17000, 0, null], ['2130', 0, 17000, 'refund_owed_pre']]);
      const row = (await q("select id from public.accounting_refund_events where refund_id=$1 and state='canceled'", [c.refundId])).rows[0].id as string;
      expect((await refundPending(db(), row))[0].resolved_at).not.toBeNull();
    });

    test('FREQ-579-AC-03: 区分「店が返金をやめた」を選ぶと、引かれた後は戻りの取引の日に元の返金の仕訳を取り消すだけで、返品の届いた日の未払金は消えず、割り当てが戻り、新しい借りは立たない', async () => {
      const r = await returnRefund();
      await succeedRefund(db(), r.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await cancelRefund(db(), r.refundId, { pulled: true, at: '2026-11-08T03:00:00Z' });
      await decideRefund(db(), r.refundId, 'abandoned');
      expect(await postRefundEvents(db())).toMatchObject({ posted: 1, reversed: 1 });
      const reversal = (await orderLines(db(), r.orderId)).filter((l) => l.event_kind === 'reversal');
      expect(shape(reversal)).toEqual([['2130', 0, 16875, 'return_refund'], ['1160', 16875, 0, null]]);
      expect(reversal[0].entry_date).toBe('2026-11-08');
      expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(16875);
      expect(await entriesOf(r.orderId, 'refund_failed')).toEqual([]);
      expect(await entriesOf(r.orderId, 'refund_abandoned')).toEqual([]);
      expect(await allocationLeft(r.refundId)).toBe(0);
      // A psc refund: the allocation of the event comes back.
      const c = await pscRefund();
      await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
      await postRefundEvents(db());
      await cancelRefund(db(), c.refundId, { pulled: true, at: '2026-11-08T03:00:00Z' });
      await decideRefund(db(), c.refundId, 'abandoned');
      await postRefundEvents(db());
      expect(await allocationLeft(c.eventId)).toBe(0);
      expect(await orderBalance(db(), c.f.orderId, '2130')).toBe(0);
      expect(await orderBalance(db(), c.f.orderId, '2150')).toBe(37000);
    });

    test('FREQ-579-AC-03: 引かれる前にやめたなら仕訳を作らず、割り当てだけが戻る', async () => {
      const c = await pscRefund();
      expect(await allocationLeft(c.eventId)).toBeGreaterThan(0);
      await cancelRefund(db(), c.refundId);
      await decideRefund(db(), c.refundId, 'abandoned');
      expect(await postRefundEvents(db())).toMatchObject({ posted: 0, parked_new: 1, resolved: 1 });
      expect(await entryCount(c.f.orderId)).toBe(1);
      expect(await allocationLeft(c.eventId)).toBe(0);
    });
  });

  describe('bank transfers and settles', () => {
    test('FREQ-579-AC-04: 出荷前の借りを振込で返すと、振込の日に「返金の未払い／普通預金」が1本入り、同じ銀行の取引の番号の2回目は何も足さず、額が違えば DEDUPE_CONTENT_MISMATCH', async () => {
      const admin = await insertAccountingAdmin(db());
      const c = await pscRefund();
      await failRefund(db(), c.refundId);
      await postRefundEvents(db());
      const first = await bankTransfer(db(), { actor: admin, orderId: c.f.orderId, origin: 'pre_shipment', amount: 17000, on: '2026-11-10', txn: 'B-001' });
      expect(first.created).toBe(true);
      const lines = await entriesOf(c.f.orderId, 'pre_shipment_refund');
      expect(shape(lines)).toEqual([['2130', 17000, 0, 'refund_owed_pre'], ['1040', 0, 17000, null]]);
      expect(lines.every((l) => l.entry_date === '2026-11-10')).toBe(true);
      const again = await bankTransfer(db(), { actor: admin, orderId: c.f.orderId, origin: 'pre_shipment', amount: 17000, on: '2026-11-10', txn: 'B-001' });
      expect(again).toMatchObject({ created: false, entry_id: first.entry_id });
      expect(await failure(() => bankTransfer(db(), { actor: admin, orderId: c.f.orderId, origin: 'pre_shipment', amount: 16000, on: '2026-11-10', txn: 'B-001' })))
        .toMatchObject({ message: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' });
      expect(await entriesOf(c.f.orderId, 'pre_shipment_refund')).toHaveLength(2);
      expect(await orderBalance(db(), c.f.orderId, '2130', 'refund_owed_pre')).toBe(0);
    });

    test('FREQ-579-AC-04: 借りの残高を超える額・未来の日・額0・権限なしを断る', async () => {
      const admin = await insertAccountingAdmin(db());
      const c = await pscRefund();
      await failRefund(db(), c.refundId);
      await postRefundEvents(db());
      const base = { actor: admin, orderId: c.f.orderId, origin: 'pre_shipment' as const, amount: 17000, on: '2026-11-10', txn: 'B-002' };
      expect(await failure(() => bankTransfer(db(), { ...base, amount: 17001 }))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
      expect(await failure(() => bankTransfer(db(), { ...base, on: '2099-01-01' }))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
      expect(await failure(() => bankTransfer(db(), { ...base, amount: 0 }))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID' });
      expect(await failure(() => bankTransfer(db(), { ...base, actor: randomUUID() }))).toMatchObject({ message: 'ACCOUNTING_FORBIDDEN' });
      expect(await entriesOf(c.f.orderId, 'pre_shipment_refund')).toEqual([]);
    });

    test('FREQ-579-AC-04: 返品の返金待ちを振込で返すと2130（返品の返金）が減る', async () => {
      const admin = await insertAccountingAdmin(db());
      const r = await returnRefund();
      await failRefund(db(), r.refundId);
      await postRefundEvents(db());
      expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(16875);
      await bankTransfer(db(), { actor: admin, orderId: r.orderId, origin: 'return', amount: 16875, on: '2026-11-10', txn: 'R-001' });
      expect(shape(await entriesOf(r.orderId, 'return_refund'))).toEqual([['2130', 16875, 0, 'return_refund'], ['1040', 0, 16875, null]]);
      expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(0);
    });

    test('FREQ-579-AC-04: 同じ銀行の取引の番号で、出荷後の借り（post_shipment）と返品の返金待ち（return）を続けて入れると、別の記録として両方入り、同じ番号・同じ origin の2回目だけが何も足さない', async () => {
      const admin = await insertAccountingAdmin(db());
      const r = await returnRefund();
      await failRefund(db(), r.refundId);
      const post = (await hBegin(db(), r.flow.f, 3000, false)).refund_id;
      await failRefund(db(), post);
      await postRefundEvents(db());
      expect(await orderBalance(db(), r.orderId, '2130', 'refund_owed_post')).toBe(3000);
      const a = await bankTransfer(db(), { actor: admin, orderId: r.orderId, origin: 'post_shipment', amount: 3000, on: '2026-11-10', txn: 'T-1' });
      const b = await bankTransfer(db(), { actor: admin, orderId: r.orderId, origin: 'return', amount: 16875, on: '2026-11-10', txn: 'T-1' });
      expect([a.created, b.created]).toEqual([true, true]);
      expect(a.entry_id).not.toBe(b.entry_id);
      const again = await bankTransfer(db(), { actor: admin, orderId: r.orderId, origin: 'return', amount: 16875, on: '2026-11-10', txn: 'T-1' });
      expect(again).toMatchObject({ created: false, entry_id: b.entry_id });
      const keys = new Set((await entriesOf(r.orderId, 'return_refund')).map((l) => l.dedupe_key));
      expect(keys).toEqual(new Set(['return_refund:bank-T-1.post_shipment', 'return_refund:bank-T-1.return']));
      expect(await orderBalance(db(), r.orderId, '2130', 'refund_owed_post')).toBe(0);
      expect(await orderBalance(db(), r.orderId, '2130', 'return_refund')).toBe(0);
    });

    test('FREQ-579-AC-04: 確定した取り消しの確定の日以前の振込の日は断る', async () => {
      const admin = await insertAccountingAdmin(db());
      const c = await pscRefund();
      await failRefund(db(), c.refundId);
      await postRefundEvents(db());
      const dispute = await seedDispute(db(), { orderId: c.f.orderId, amount: 5000, status: 'lost', withdrawnAt: '2026-11-03T03:00:00Z' });
      await addDisputeHistory(db(), { disputeId: dispute.disputeId, status: 'lost', occurredAt: '2026-11-08T03:00:00Z', eventType: 'charge.dispute.closed' });
      const base = { actor: admin, orderId: c.f.orderId, origin: 'pre_shipment' as const, amount: 1000, txn: 'D-1' };
      for (const on of ['2026-11-07', '2026-11-08']) {
        expect(await failure(() => bankTransfer(db(), { ...base, on }))).toMatchObject({ message: 'ACCOUNTING_ARGUMENT_INVALID', detail: 'dispute_confirmed' });
      }
      expect((await bankTransfer(db(), { ...base, on: '2026-11-09' })).created).toBe(true);
    });

    test('FREQ-579-AC-04: 借りの仕訳が入る前（区分 owed だけの間）は結べない', async () => {
      const admin = await insertAccountingAdmin(db());
      const p = await plainBeforeRefund();
      await cancelRefund(db(), p.refundId);
      await decideRefund(db(), p.refundId, 'owed', admin);
      const retry = (await hBegin(db(), p.f, 17000, true)).refund_id;
      await succeedRefund(db(), retry, { at: '2026-11-08T03:00:00Z' });
      expect(await failure(() => settleOwed(db(), admin, p.refundId, retry))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
      await postRefundEvents(db());
      expect(await settleOwed(db(), admin, p.refundId, retry)).toMatchObject({ pre_amount: 17000, replayed: false });
    });

    test('FREQ-579-AC-04: 借りを先に振込で全額返した後に結ぶと、借りの残高を超えるので断られる', async () => {
      const admin = await insertAccountingAdmin(db());
      const p = await plainBeforeRefund();
      await failRefund(db(), p.refundId);
      await postRefundEvents(db());
      await bankTransfer(db(), { actor: admin, orderId: p.f.orderId, origin: 'pre_shipment', amount: 17000, on: '2026-11-10', txn: 'F-1' });
      const retry = (await hBegin(db(), p.f, 17000, true)).refund_id;
      await succeedRefund(db(), retry, { at: '2026-11-11T03:00:00Z' });
      await postRefundEvents(db());
      expect(await failure(() => settleOwed(db(), admin, p.refundId, retry))).toMatchObject({ message: 'ACCOUNTING_EVENT_NOT_POSTABLE' });
      expect((await q('select count(*)::int n from public.accounting_refund_settlements where owed_refund_id=$1', [p.refundId])).rows[0].n).toBe(0);
    });

    test('FREQ-579-AC-05: 写しのある注文で発送前の取り消しの返金が引かれる前に失敗すると、借りは 2130（refund_owed_pre）に残り、振込の記録で0になる。同じ出来事に新しい返金は結べず、品を指定しない新しい返金との結び（admin_settle_owed_by_refund）は ACCOUNTING_ARGUMENT_INVALID で断る（引かれた後の失敗も同じ）', async () => {
      const admin = await insertAccountingAdmin(db());
      for (const pulled of [false, true]) {
        await q('savepoint s20_case');
        const c = await pscRefund();
        if (pulled) {
          await succeedRefund(db(), c.refundId, { at: '2026-11-05T03:00:00Z' });
          await postRefundEvents(db());
          await failRefund(db(), c.refundId, { pulled: true, at: '2026-11-07T03:00:00Z' });
        } else {
          await failRefund(db(), c.refundId);
        }
        await postRefundEvents(db());
        expect(await orderBalance(db(), c.f.orderId, '2130', 'refund_owed_pre')).toBe(17000);
        const other = (await q(`select * from public.begin_order_refund($1,'admin',$2,'[]'::jsonb,false,0,1000,null,'requested_by_customer',null,false,$3,null,null)`,
          [c.f.orderId, randomUUID(), c.f.actor])).rows[0].refund_id as string;
        await succeedRefund(db(), other, { at: '2026-11-08T03:00:00Z' });
        await postRefundEvents(db());
        expect(await failure(() => settleOwed(db(), admin, c.refundId, other))).toEqual({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID', detail: undefined });
        await bankTransfer(db(), { actor: admin, orderId: c.f.orderId, origin: 'pre_shipment', amount: 17000, on: '2026-11-10', txn: `I1-${pulled}` });
        expect(await orderBalance(db(), c.f.orderId, '2130', 'refund_owed_pre')).toBe(0);
        await q('rollback to savepoint s20_case');
      }
    });

    test('FREQ-577-AC-03: 品が2着の注文で、発送前の取り消しの返金が引かれる前に失敗し、同じ出来事の返金をカードでやり直すと、割り当ては1回分のままで、残る1着の出荷が units_insufficient で止まらず、結ぶと前受金が0', async () => {
      // 写しのある注文の発送前の取り消しの借りは結べない（裁定 P3-B6）ので、写しの無い注文（P3-D3）の出荷前の返金で、同じ着のやり直しを結ぶ
      const admin = await insertAccountingAdmin(db());
      const p = await plainBeforeRefund();
      await failRefund(db(), p.refundId);
      await postRefundEvents(db());
      const retry = (await hBegin(db(), p.f, 17000, true)).refund_id;
      await succeedRefund(db(), retry, { at: '2026-11-08T03:00:00Z' });
      await postRefundEvents(db());
      const held = (await allocations(p.f.orderId)).reduce((sum, a) => sum + a.amount, 0);
      expect(held).toBe(17000);
      await shipAndPost(db(), p.f.orderId, p.f.itemId, 1, p.f.actor);
      expect((await q("select count(*)::int n from public.accounting_pending_events where order_id=$1 and reason='units_insufficient'", [p.f.orderId])).rows[0].n).toBe(0);
      // The shipment waits for the deferred revenue the settle gives back (the owed debt and the retry took it twice).
      await settleOwed(db(), admin, p.refundId, retry);
      await q('select private.accounting_post_shipment_events(50)');
      expect((await entriesOf(p.f.orderId, 'shipment_confirmed')).filter((l) => l.account_code === '4010').map((l) => l.credit)).toEqual([20000]);
      expect(await orderBalance(db(), p.f.orderId, '2150')).toBe(0);
      expect(await orderBalance(db(), p.f.orderId, '2130', 'refund_owed_pre')).toBe(0);
    });

    test('FREQ-579-AC-02: 17,000円の今すぐの返金が失敗し、相談の20,000円と合わせた37,000円のやり直しが成功すると、成功の仕訳は37,000円ちょうどで二重にならない', async () => {
      // P3-T6a: the retry pays the failed 'now' part and the consult part at once; the refund is counted once, from its own fact.
      const f = await seedRefundFlow(db(), true, 2);
      const failed = (await hBegin(db(), f, 17000, false)).refund_id;
      await failRefund(db(), failed);
      await postRefundEvents(db());
      const retry = (await hBegin(db(), f, 37000, false, randomUUID(), 2)).refund_id;
      const txn = await succeedRefund(db(), retry, { at: '2026-11-09T03:00:00Z' });
      await postRefundEvents(db());
      const lines = (await orderLines(db(), f.orderId)).filter((l) => l.dedupe_key === `return_refund:${txn}`);
      expect(shape(lines)).toEqual([['4020', 37000, 0, null], ['1160', 0, 37000, null]]);
      expect((await orderLines(db(), f.orderId)).filter((l) => l.account_code === '1160').reduce((s, l) => s + l.credit - l.debit, 0)).toBe(37000);
    });
  });
});
