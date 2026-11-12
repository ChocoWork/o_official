/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { cancelSlip, setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  bankTransfer, cancelRefund, decideRefund, failRefund, orderBalance, orderLines, postOrderPayment, postRefundEvents, postShipments,
  seedPairFlow, seedPreShipmentCancel, shipUnits, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';

// 計画3 Task 6（S20）: 規則5の表（FREQ-577-AC-09）。2着 u0・u1（支払額 p0 < p1、Δ = p1 − p0。安い u0 が割引の付いた着）の注文で、
// 1着を出荷し1着を発送前に取り消す。出荷・取り消し・発送の取り消し・error・失敗・店が返金をやめた時の順を、係を途中で流す・
// まとめて流すの両方で試し、d・売上の累計・前受金の最後を表のとおりに確かめる。⑦（鍵を取る順）は rule5 の並行の suite。
// 注文は H の受け付け（同じ品の2つの色違いを1着ずつ）で作り、出荷・取り消し・発送の取り消し・返金の結果・振込は本物の関数で入れる
// （seedPairFlow の説明のとおり、1行に2着だと安い着だけを先に送れないので、行を分けて送る着と取り消す着を名指す）。
jest.setTimeout(600000);

type Pair = Awaited<ReturnType<typeof seedPairFlow>>;
type Ctx = { o: Pair; refund: string; slip: string };
type Step = { id: string; hold?: boolean; run: (c: Ctx) => Promise<unknown> };
type Row = { id: string; steps: Step[]; d: 'delta' | 0; revenue: 'p1' | 'both' };

const EXAMPLES = [['a', 10001, 2], ['b', 5000, 1], ['c', 10000, 1000]] as const;

describeLocalDb('FREQ-577-AC-09: S20 rule 5 table', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  const postAll = async () => { await postShipments(db()); await postRefundEvents(db()); };
  let admin = '';

  const ship = (which: 'cheap' | 'dear', hold = false): Step => ({ id: `ship(${which})`, hold, run: async (c) => {
    c.slip = (await shipUnits(db(), c.o.orderId, c.o[which], 1, c.o.actor)).slipId;
  } });
  const cancel = (which: 'cheap' | 'dear'): Step => ({ id: `cancel(${which})`, run: async (c) => {
    c.refund = (await seedPreShipmentCancel(db(), c.o, { itemId: c.o[which], quantity: 1 })).refundId;
  } });
  const slipCancel: Step = { id: 'slipCancel', run: (c) => cancelSlip(db(), c.slip) };
  const success: Step = { id: 'success', run: (c) => succeedRefund(db(), c.refund, { at: '2026-11-05T03:00:00Z' }) };
  const error: Step = { id: 'error', run: (c) => q("select * from private.mark_order_refund_error($1,'timeout',false)", [c.refund]) };
  const failed: Step = { id: 'failed', run: (c) => failRefund(db(), c.refund) };
  const stripeCancel: Step = { id: 'stripeCancel', run: (c) => cancelRefund(db(), c.refund) };
  const abandon: Step = { id: 'abandon', run: (c) => decideRefund(db(), c.refund, 'abandoned', admin) };
  /** 借りを振込で返す（人の操作は画面が仕訳の後に出すので、操作の前に係を流す）。額は借りの残高。 */
  const bank: Step = { id: 'bank', run: async (c) => {
    await postAll();
    const owed = await orderBalance(db(), c.o.orderId, '2130', 'refund_owed_pre');
    const today = (await q("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d as string;
    await bankTransfer(db(), { actor: admin, orderId: c.o.orderId, origin: 'pre_shipment', amount: owed, on: today, txn: `R5-${randomUUID().slice(0, 8)}` });
  } };

  const ROWS: Row[] = [
    { id: '①', steps: [ship('cheap'), cancel('dear'), success], d: 'delta', revenue: 'p1' },
    { id: '②', steps: [cancel('cheap'), ship('dear'), success], d: 0, revenue: 'p1' },
    { id: '③', steps: [ship('cheap', true), cancel('dear'), success], d: 'delta', revenue: 'p1' },
    { id: '④', steps: [ship('cheap'), slipCancel, cancel('cheap'), ship('dear'), success], d: 0, revenue: 'p1' },
    { id: '⑤-1', steps: [cancel('cheap'), error, ship('dear'), success], d: 0, revenue: 'p1' },
    { id: '⑤-2', steps: [ship('cheap'), cancel('dear'), error, success], d: 'delta', revenue: 'p1' },
    { id: '⑥-1', steps: [cancel('cheap'), error, failed, ship('dear'), bank], d: 0, revenue: 'p1' },
    { id: '⑥-2', steps: [ship('cheap'), cancel('dear'), error, failed, bank], d: 'delta', revenue: 'p1' },
    { id: '⑧', steps: [cancel('cheap'), stripeCancel, abandon, ship('cheap'), ship('dear')], d: 0, revenue: 'both' },
    { id: '⑨', steps: [cancel('cheap'), failed, bank, ship('dear')], d: 0, revenue: 'p1' },
  ];

  /** d: 返金の仕訳（成功・借り・区分）の 4010 の貸方−借方。 */
  async function measure(orderId: string) {
    const lines = await orderLines(db(), orderId);
    const d = lines.filter((l) => l.account_code === '4010' && ['pre_shipment_refund', 'refund_failed', 'refund_abandoned'].includes(l.event_kind))
      .reduce((s, l) => s + l.credit - l.debit, 0);
    return {
      d,
      revenue: await orderBalance(db(), orderId, '4010'),
      b2150: await orderBalance(db(), orderId, '2150'),
      owed: await orderBalance(db(), orderId, '2130', 'refund_owed_pre'),
      open: (await q('select count(*)::int n from public.accounting_pending_events where order_id=$1 and resolved_at is null', [orderId])).rows[0].n as number,
    };
  }

  test.each(EXAMPLES)('FREQ-577-AC-09: 例 %s（%i 円の2着、割引 %i 円）は、①〜⑥・⑧・⑨のどの順でも、係を途中で流しても最後にまとめても、d・売上の累計・前受金の最後が表のとおり', async (_name, price, delta) => {
    admin = await insertAccountingAdmin(db());
    for (const row of ROWS) {
      for (const mode of ['each', 'end'] as const) {
        await q('savepoint r5');
        const o = await seedPairFlow(db(), price, delta);
        await postOrderPayment(db(), o.orderId);
        const c: Ctx = { o, refund: '', slip: '' };
        for (const step of row.steps) {
          try { await step.run(c); } catch (e) { throw new Error(`${row.id} ${mode} at ${step.id}: ${(e as Error).message}`); }
          if (mode === 'each' && !step.hold) await postAll();
        }
        for (let i = 0; i < 3; i += 1) await postAll();
        const expected = { d: row.d === 'delta' ? delta : 0, revenue: row.revenue === 'p1' ? o.p1 : o.p0 + o.p1, b2150: 0, owed: 0, open: 0 };
        expect([row.id, mode, await measure(o.orderId)]).toEqual([row.id, mode, expected]);
        await q('rollback to savepoint r5');
      }
    }
  });
});
