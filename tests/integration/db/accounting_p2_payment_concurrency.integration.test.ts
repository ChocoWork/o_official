/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { seedPaidOrder, seedStripeCharge } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 2 (FREQ-562-AC-05): two runs of the payment posting at the same time. This suite COMMITS rows
// (orders, charges, entries) into the local database and the accounting rows cannot be removed: run it alone, with
// ACCOUNTING_COMMIT_SUITE=1, between two resets.
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p2_payment_concurrency --runInBand; db reset
// The cutover day is today in Japan and the payments are made now, so the committed suites never move it.
jest.setTimeout(120000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('S7 payment posting under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }

  const seedPayment = async (client: PgClient) => {
    await client.query('begin');
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const order = await seedPaidOrder(client, { lines: [{ price: 4000, quantity: 2 }] });
    const txId = await seedStripeCharge(client, { paymentIntentId: order.paymentIntentId, amount: order.total,
      createdAt: new Date().toISOString(), fee: 288 });
    await client.query('commit');
    return { ...order, txId, pi: order.paymentIntentId as string };
  };
  const post = async (client: PgClient) =>
    (await client.query('select private.accounting_post_payment_events(50) as r')).rows[0].r as { posted: number; parked_new: number };

  /** Wait until the backend of `client` is blocked by another one; the wait itself is what the test observes. */
  async function waitUntilBlocked(observer: PgClient, pid: number): Promise<number[]> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blockers = (await observer.query('select pg_catalog.pg_blocking_pids($1::integer) as b', [pid])).rows[0].b as number[];
      if (blockers.length > 0) return blockers;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('RUN_B_WAS_NOT_BLOCKED');
  }

  test.each([1, 2, 3])('FREQ-562-AC-05: 同時に流しても1本だけ残り通し番号に欠番ができない（%i回目）', async () => {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      const payment = await seedPayment(setup);
      const pidB = (await b.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      const pidA = (await a.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      await a.query('begin');
      const first = await post(a);
      // A holds the accounting locks until it commits; B asks for them and waits.
      const second = post(b);
      const blockers = await waitUntilBlocked(observer, pidB);
      expect(blockers).toContain(pidA);
      await a.query('commit');
      const secondResult = await second;
      // Exactly one run posted this payment; the other found the entry and did nothing for it.
      expect(first.posted).toBeGreaterThanOrEqual(1);
      expect(secondResult.posted).toBe(0);
      const entries = (await setup.query(
        `select e.id, e.period_id, e.entry_no from public.accounting_journal_entries e where e.dedupe_key = $1`,
        ['payment_confirmed:' + payment.pi])).rows;
      expect(entries).toHaveLength(1);
      const lines = (await setup.query('select account_code, debit::text as debit, credit::text as credit from public.accounting_journal_lines where entry_id = $1 order by line_no',
        [entries[0].id])).rows;
      expect(lines).toEqual([
        { account_code: '1160', debit: String(payment.total), credit: '0' },
        { account_code: '2150', debit: '0', credit: String(payment.total) }]);
      // The numbers of the period run 1..N without a gap, in whatever order the committed runs left them.
      const numbers = (await setup.query('select count(*)::int as n, max(entry_no)::int as max, min(entry_no)::int as min from public.accounting_journal_entries where period_id = $1',
        [entries[0].period_id])).rows[0];
      expect(numbers.min).toBe(1);
      expect(numbers.max).toBe(numbers.n);
      expect((await setup.query('select last_entry_no::int as n from public.accounting_period_sequences where period_id = $1', [entries[0].period_id])).rows[0].n)
        .toBe(numbers.n);
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  });

  test('FREQ-562-AC-05: 同じ支払いを同時に始めた2本のうち後から来た方は待ち、待った後に二重に入れない（先に始めた方が失敗しても1本）', async () => {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      const payment = await seedPayment(setup);
      const pidA = (await a.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      const pidB = (await b.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      await a.query('begin');
      await post(a);
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      // A rolls back: B takes the lock, finds no entry, and posts it itself.
      await a.query('rollback');
      expect((await second).posted).toBeGreaterThanOrEqual(1);
      expect((await setup.query('select count(*)::int as n from public.accounting_journal_entries where dedupe_key = $1',
        ['payment_confirmed:' + payment.pi])).rows[0].n).toBe(1);
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  });
});
