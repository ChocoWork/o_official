/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { orderBalance, orderLines, postReturnEvents, receiveReturn, seedReturnFlow } from './helpers/accounting-returns-fixtures';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// 計画3 Task 7（S21）の並行の試験。2つ以上の接続でコミットまで流す（使い捨ての手元の DB だけ）。日は切り替えの日（今日）の今。
// 消せない仕訳と計上待ちをコミットするので、ACCOUNTING_COMMIT_SUITE=1 で、2つの db reset の間に単独で流す。
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p3_return_concurrency --runInBand; db reset
jest.setTimeout(120000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('FREQ-578-AC-07: S21 return posting under concurrency', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }
  const clients: PgClient[] = [];
  const open = async () => { const c = await connectLocalDb(); clients.push(c); return c; };
  afterEach(async () => {
    for (const c of clients.splice(0)) { await c.query('rollback').catch(() => null); await c.end(); }
  });

  /** 3つの接続で同時に流し（1つは入口 accounting_run_posting）、その後にもう1回流す。 */
  async function runTogether(): Promise<void> {
    const runners = await Promise.all([open(), open(), open()]);
    const results = await Promise.allSettled(runners.map(async (r, i) => {
      await r.query('begin');
      const run = i === 2 ? (await r.query('select public.accounting_run_posting(50) as r')).rows[0].r : await postReturnEvents(r);
      await r.query('commit');
      return run;
    }));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const again = await open();
    await again.query('begin');
    await postReturnEvents(again);
    await again.query('commit');
  }

  test('FREQ-578-AC-07: 同じ受け取りを何度・同時に流しても1本', async () => {
    const setup = await open();
    await setup.query('begin');
    await setup.query('select pg_advisory_xact_lock(190521,1)');
    const flow = await seedReturnFlow(setup);
    const received = await receiveReturn(setup, flow, { choice: 'consult',
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    await setup.query('commit');

    await runTogether();

    const check = await open();
    const lines = (await orderLines(check, flow.f.orderId)).filter((l) => l.source_id === received.receipt_id);
    expect(new Set(lines.map((l) => l.entry_id)).size).toBe(1);
    expect(lines.every((l) => l.dedupe_key === `return_arrived:${received.receipt_id}`)).toBe(true);
    expect(await orderBalance(check, flow.f.orderId, '2130', 'return_refund')).toBe(16875);
  });

  test('FREQ-578-AC-08: 0円で終えた返品の決定の仕訳を何度・同時に流しても1本', async () => {
    const setup = await open();
    await setup.query('begin');
    await setup.query('select pg_advisory_xact_lock(190521,1)');
    const flow = await seedReturnFlow(setup);
    await receiveReturn(setup, flow, { choice: 'consult',
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    await setup.query('select * from public.admin_refund_return($1,$2,$3,0,0,null,false)', [flow.returnId, flow.f.actor, randomUUID()]);
    const decision = (await setup.query("select id from public.accounting_return_facts where return_id=$1 and kind='decision'", [flow.returnId])).rows[0].id;
    await setup.query('commit');

    await runTogether();

    const check = await open();
    const lines = (await orderLines(check, flow.f.orderId)).filter((l) => l.event_kind === 'return_amount_decided');
    expect(new Set(lines.map((l) => l.entry_id)).size).toBe(1);
    expect(lines.every((l) => l.dedupe_key === `return_amount_decided:${decision}`)).toBe(true);
    expect(await orderBalance(check, flow.f.orderId, '2130', 'return_refund')).toBe(0);
    expect(await orderBalance(check, flow.f.orderId, '4050')).toBe(0);
  });
});
