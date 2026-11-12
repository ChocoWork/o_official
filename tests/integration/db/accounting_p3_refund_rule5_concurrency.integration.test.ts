/** @jest-environment node */
import { setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  orderBalance, orderLines, postOrderPayment, postRefundEvents, postShipments, seedPairFlow, seedPreShipmentCancel, shipUnits, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// 計画3 Task 6（S20）: 規則5の表の⑦（FREQ-577-AC-09）。出荷の確定と発送前の取り消しを2つの接続で、G の鍵を取る順を入れ替えて流す。
// 書き手の行（注文・発送票・取り消し・返金）だけをコミットし、仕訳は確かめの接続の中で入れて ROLLBACK で戻す
// （消せない仕訳を残さないので ACCOUNTING_COMMIT_SUITE は要らない。残る発送票と返金はほかの suite の setAsideExistingSlips が外す）。
jest.setTimeout(120000);

const EXAMPLES = [['a', 10001, 2], ['b', 5000, 1], ['c', 10000, 1000]] as const;

describeLocalDb('FREQ-577-AC-09: S20 rule 5 lock order', () => {
  const clients: PgClient[] = [];
  const open = async () => { const c = await connectLocalDb(); clients.push(c); return c; };
  afterEach(async () => {
    for (const c of clients.splice(0)) { await c.query('rollback').catch(() => null); await c.end(); }
  });

  /** 安い着（u0）の出荷の確定と、高い着（u1）の発送前の取り消しを、first が先に始め、lockFirst が先に G の鍵を取る順で流す。 */
  async function race(price: number, delta: number, lockFirst: 'confirm' | 'cancel') {
    const setup = await open();
    await setup.query('begin');
    const o = await seedPairFlow(setup, price, delta);
    await setup.query('commit');

    const confirm = await open();
    const cancel = await open();
    const [starter, locker] = lockFirst === 'cancel' ? [confirm, cancel] : [cancel, confirm];
    // 後に鍵を取る側が先に取引を始める（⑦-1 は確定の confirmed_at が取り消しより前）
    await starter.query('begin');
    await starter.query('select 1');
    await locker.query('begin');
    await locker.query('select pg_advisory_xact_lock(190521,1)');
    const work = {
      confirm: () => shipUnits(confirm, o.orderId, o.cheap, 1, o.actor),
      cancel: () => seedPreShipmentCancel(cancel, o, { itemId: o.dear, quantity: 1 }),
    };
    const first = await work[lockFirst]();
    const waiting = starter.query('select pg_advisory_xact_lock(190521,1)');
    await new Promise((r) => setTimeout(r, 300));
    await locker.query('commit');
    await waiting;
    const second = await work[lockFirst === 'cancel' ? 'confirm' : 'cancel']();
    await starter.query('commit');
    const refundId = (lockFirst === 'cancel' ? first : second) as { refundId: string };

    // 仕訳は確かめの接続の中だけで入れる
    const check = await open();
    await check.query('begin');
    await setCutoverForTest(check, '2026-01-01');
    await postOrderPayment(check, o.orderId);
    await succeedRefund(check, refundId.refundId, { at: '2026-11-05T03:00:00Z' });
    for (let i = 0; i < 3; i += 1) { await postShipments(check); await postRefundEvents(check, 200); }
    const lines = await orderLines(check, o.orderId);
    const d = lines.filter((l) => l.account_code === '4010' && l.event_kind === 'pre_shipment_refund').reduce((s, l) => s + l.credit - l.debit, 0);
    const result = { d, revenue: await orderBalance(check, o.orderId, '4010'), b2150: await orderBalance(check, o.orderId, '2150') };
    await check.query('rollback');
    return { o, result };
  }

  test.each(EXAMPLES)('FREQ-577-AC-09: ⑦-1 例 %s（%i 円、割引 %i 円）: 確定を先に始め、取り消しが先に鍵を取ると、②と同じ（d 0、売上 p1、前受金 0）', async (_n, price, delta) => {
    const { o, result } = await race(price, delta, 'cancel');
    expect(result).toEqual({ d: 0, revenue: o.p1, b2150: 0 });
  });

  test.each(EXAMPLES)('FREQ-577-AC-09: ⑦-2 例 %s（%i 円、割引 %i 円）: 取り消しを先に始め、確定が先に鍵を取ると、①と同じ（d Δ、売上 p1、前受金 0）', async (_n, price, delta) => {
    const { o, result } = await race(price, delta, 'confirm');
    expect(result).toEqual({ d: delta, revenue: o.p1, b2150: 0 });
  });
});
