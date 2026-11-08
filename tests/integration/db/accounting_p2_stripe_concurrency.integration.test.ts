/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { seedStripeFee, seedStripePayout } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 4 (FREQ-565-AC-01): two runs of the Stripe posting at the same time. This suite COMMITS rows
// (Stripe rows, entries) into the local database and the accounting rows cannot be removed: run it alone, with
// ACCOUNTING_COMMIT_SUITE=1, between two resets.
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p2_stripe_concurrency --runInBand; db reset
// The cutover day is today in Japan and the rows are made now, so the committed suites never move it.
jest.setTimeout(120000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('S9 Stripe posting under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }

  /** One fee, one tax adjustment, one payout and the return of the payout, all of today. */
  const seed = async (client: PgClient) => {
    const now = new Date().toISOString();
    await client.query('begin');
    const fee = await seedStripeFee(client, { createdAt: now, type: 'charge', reportingCategory: 'charge', amount: 4000, fee: 144 });
    const tax = await seedStripeFee(client, { createdAt: now, type: 'tax_fee', reportingCategory: 'tax', amount: -110 });
    const payout = await seedStripePayout(client, { amount: 3856, paidAt: now });
    const failure = await seedStripeFee(client, { createdAt: now, type: 'payout_failure', reportingCategory: 'payout_reversal', amount: 3856, sourceId: payout });
    await client.query('commit');
    return { fee, tax, payout, failure };
  };
  const post = async (client: PgClient) =>
    (await client.query('select private.accounting_post_stripe_events(50) as r')).rows[0].r as { posted: number; parked_new: number };

  /** Wait until the backend of `client` is blocked by another one; the wait itself is what the test observes. */
  async function waitUntilBlocked(observer: PgClient, pid: number): Promise<number[]> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blockers = (await observer.query('select pg_catalog.pg_blocking_pids($1::integer) as b', [pid])).rows[0].b as number[];
      if (blockers.length > 0) return blockers;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('RUN_B_WAS_NOT_BLOCKED');
  }

  const keysOf = (rows: { fee: string; tax: string; payout: string; failure: string }) =>
    [`stripe:fee:${rows.fee}`, `stripe_tax_adjustment:${rows.tax}`, `payout_started:${rows.payout}`, `payout_failed:${rows.failure}`];

  test.each([1, 2, 3])('FREQ-565-AC-01: 全部の入口は同時に流しても1本ずつで、通し番号に欠番ができない（%i回目）', async () => {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      const rows = await seed(setup);
      const pidA = (await a.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      const pidB = (await b.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      await a.query('begin');
      const first = await post(a);
      // A holds the accounting locks until it commits; B asks for them and waits.
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      const secondResult = await second;
      expect(first.posted).toBeGreaterThanOrEqual(4);
      expect(secondResult.posted).toBe(0);
      for (const key of keysOf(rows)) {
        expect((await setup.query('select count(*)::int as n from public.accounting_journal_entries where dedupe_key = $1', [key])).rows[0].n).toBe(1);
      }
      const periods = (await setup.query(
        `select e.period_id, count(*)::int as n, max(e.entry_no)::int as max, min(e.entry_no)::int as min
         from public.accounting_journal_entries e group by e.period_id`)).rows;
      for (const period of periods) {
        expect(period.min).toBe(1);
        expect(period.max).toBe(period.n);
      }
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  });

  test('FREQ-565-AC-01: 先に始めた方が巻き戻っても、後から来た方が1本ずつ入れる', async () => {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      const rows = await seed(setup);
      const pidA = (await a.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      const pidB = (await b.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
      await a.query('begin');
      await post(a);
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('rollback');
      expect((await second).posted).toBeGreaterThanOrEqual(4);
      for (const key of keysOf(rows)) {
        expect((await setup.query('select count(*)::int as n from public.accounting_journal_entries where dedupe_key = $1', [key])).rows[0].n).toBe(1);
      }
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  });
});
