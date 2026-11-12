/** @jest-environment node */
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import {
  bankTransfer, dropDiscountSnapshot, failRefund, orderBalance, orderLines, postOrderPayment, postRefundEvents, seedPreShipmentCancel, seedRefundFlow,
  settleOwed, succeedRefund,
} from './helpers/accounting-returns-fixtures';
import { hBegin } from './helpers/group-h-refund-fixtures';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// 計画3 Task 6（S20）の並行の試験。2つ以上の接続でコミットまで流す（使い捨ての手元の DB だけ）。日は切り替えの日より後の今。
// 消せない仕訳と計上待ちをコミットするので、計画2の並行の試験と同じく ACCOUNTING_COMMIT_SUITE=1 で、2つの db reset の間に単独で流す。
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p3_refund_concurrency --runInBand; db reset
jest.setTimeout(120000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('FREQ-577-AC-07: S20 refund posting under concurrency', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }
  const clients: PgClient[] = [];
  const open = async () => { const c = await connectLocalDb(); clients.push(c); return c; };
  afterEach(async () => {
    for (const c of clients.splice(0)) { await c.query('rollback').catch(() => null); await c.end(); }
  });
  const now = () => new Date().toISOString();
  const today = async (c: PgClient) => (await c.query("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d as string;

  test('FREQ-577-AC-07: 同じ返金を何度・同時に流しても1本ずつ', async () => {
    const setup = await open();
    await setup.query('begin');
    await setup.query('select pg_advisory_xact_lock(190521,1)');
    const f = await seedRefundFlow(setup, false, 2);
    await postOrderPayment(setup, f.orderId, now());
    const c = await seedPreShipmentCancel(setup, f, { itemId: f.itemId, quantity: 1 });
    await succeedRefund(setup, c.refundId, { at: now() });
    await setup.query('commit');

    const runners = await Promise.all([open(), open(), open()]);
    const results = await Promise.allSettled(runners.map(async (r, i) => {
      await r.query('begin');
      const run = i === 2 ? (await r.query('select public.accounting_run_posting(50) as r')).rows[0].r : await postRefundEvents(r);
      await r.query('commit');
      return run;
    }));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    // Once more after the others.
    const again = await open();
    await again.query('begin');
    await postRefundEvents(again);
    await again.query('commit');

    const check = await open();
    const entries = new Set((await orderLines(check, f.orderId)).filter((l) => l.source_id === c.refundId).map((l) => l.entry_id));
    expect(entries.size).toBe(1);
    expect(await orderBalance(check, f.orderId, '2150')).toBe(37000 - c.amount);
  });

  test('FREQ-579-AC-04: 結びの操作と振込を違う要求番号で同時に流しても、借りが二重に消えない', async () => {
    const setup = await open();
    await setup.query('begin');
    await setup.query('select pg_advisory_xact_lock(190521,1)');
    const admin = await insertAccountingAdmin(setup);
    const f = await seedRefundFlow(setup, false, 2);
    await dropDiscountSnapshot(setup, f.orderId);
    await postOrderPayment(setup, f.orderId, now());
    const owed = (await hBegin(setup, f, 17000, true)).refund_id;
    await failRefund(setup, owed);
    await postRefundEvents(setup);
    const retry = (await hBegin(setup, f, 17000, true)).refund_id;
    await succeedRefund(setup, retry, { at: now() });
    await postRefundEvents(setup);
    await setup.query('commit');
    const day = await today(setup);

    const a = await open();
    const b = await open();
    await a.query('begin');
    await b.query('begin');
    const results = await Promise.allSettled([
      settleOwed(a, admin, owed, retry).then(async (r) => { await a.query('commit'); return r; }),
      bankTransfer(b, { actor: admin, orderId: f.orderId, origin: 'pre_shipment', amount: 17000, on: day, txn: `CONC-${owed.slice(0, 8)}` })
        .then(async (r) => { await b.query('commit'); return r; }),
    ]);
    const done = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(done).toHaveLength(1);
    expect(refused.map((r) => (r.reason as Error).message)).toEqual(['ACCOUNTING_EVENT_NOT_POSTABLE']);

    const check = await open();
    expect(await orderBalance(check, f.orderId, '2130', 'refund_owed_pre')).toBe(0);
  });
});
