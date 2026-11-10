/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { hBegin, hClaims, hRefundFixture, hResult } from './helpers/group-h-refund-fixtures';

jest.setTimeout(120000);
describeLocalDb('H5 common-lock race (controller: three consecutive runs)', db => {
  const clients: PgClient[] = [];
  afterEach(async () => { for (const c of clients.splice(0)) { await c.query('rollback').catch(() => undefined); await c.end(); } await db().query('rollback'); });
  async function connection() { const c = await connectLocalDb(); clients.push(c); await c.query("set statement_timeout='20s'"); return c; }
  async function blocked(waiter: number, blocker: number) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const r = (await db().query(`select $2=any(pg_blocking_pids($1)) b, exists(select 1 from pg_locks
        where pid=$1 and locktype='advisory' and classid=190521 and objid=1 and objsubid=2 and not granted) l`, [waiter, blocker])).rows[0];
      if (r.b && r.l) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('H5_COMMON_LOCK_WAIT_NOT_OBSERVED');
  }
  async function race(failure: 'failed' | 'error') {
    await db().query('begin'); const f = await hRefundFixture(db(), true); await db().query('set constraints all immediate'); await db().query('commit');
    const a = await connection(), b = await connection();
    await a.query('begin'); await b.query('begin');
    const ap = Number((await a.query('select pg_backend_pid() p')).rows[0].p);
    const bp = Number((await b.query('select pg_backend_pid() p')).rows[0].p);
    const firstKey = randomUUID();
    const first = await hBegin(a, f, 17000, false, firstKey);
    // G-1 allows the next refund only after the first has a Stripe result.
    await hResult(a, first.refund_id, 'pending');
    const secondPromise = hBegin(b, f, 20000);
    await blocked(bp, ap); await a.query('commit'); const second = await secondPromise; await hResult(b, second.refund_id, 'succeeded'); await b.query('commit');
    await db().query('begin');
    expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([null, null]); // 返品なしの発送後の返金は着を取り押さえない（FREQ-642-AC-28）
    await hResult(db(), first.refund_id, 'failed');
    if (failure === 'error') {
      // mark_order_refund_error applies to an awaiting retry, not the pending first refund.
      const errored = await hBegin(db(), f, 17000);
      expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([null, null]);
      const result = (await db().query("select * from public.mark_order_refund_error($1,'stripe_rejected',false)", [errored.refund_id])).rows[0];
      expect(result.outcome).toBe('errored');
    }
    expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([null, null]);
    const retryKey = randomUUID(); const retry = await hBegin(db(), f, 17000, false, retryKey);
    expect(await hBegin(db(), f, 17000, false, retryKey)).toMatchObject({ refund_id: retry.refund_id, replayed: true });
    await hResult(db(), retry.refund_id, 'succeeded');
    expect((await hClaims(db(), f.itemId)).map(u => u.refund_id)).toEqual([null, null]);
    expect((await db().query('select refunded_amount from public.orders where id=$1', [f.orderId])).rows[0].refunded_amount).toBe(37000);
    // 着を取り押さえないので、全部の着が空きのまま（旧: 全部取り押さえられて GROUP_H_REFUND_UNIT_MISMATCH）
    expect(Number((await db().query('select private.return_units_amount($1,1) n', [f.itemId])).rows[0].n)).toBe(17000);
  }
  test('FREQ-551-AC-02: 安い返金が失敗し高い返金が成功しても安い単位を一度だけ再試行できる', async () => { await race('failed'); });
  test('FREQ-551-AC-02: 並行の高い返金が成功した後もerrorで安いclaimを解放して再試行できる', async () => { await race('error'); });
});
