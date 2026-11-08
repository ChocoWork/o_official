/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { seedConfirmedSlip, seedDispute, seedDisputeReversal, seedPostedPayment, addDisputeHistory, recordSlipFactAt } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 6 (FREQ-568-AC-01, FREQ-562-AC-05): two runs of the posting entry point at the same time. This suite
// COMMITS rows (orders, charges, disputes, entries) into the local database and the accounting rows cannot be removed: run it
// alone, with ACCOUNTING_COMMIT_SUITE=1, between two resets.
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p2_dispute_concurrency --runInBand; db reset
// The cutover day is today in Japan, so the dates used here are today (the withdrawal) and later days (the loss and the return).
jest.setTimeout(180000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

type RunResult = { payments: number; shipments: number; stripe: number; disputes: number; parked: number; resolved: number; has_more: boolean };

describeLocalDb('S11 dispute posting under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }

  const nowIso = () => new Date().toISOString();
  /** A paid order with its payment entry (committed), and a dispute of 8,000 yen withdrawn now. */
  async function seedWithdrawal(client: PgClient, input: { disputes?: number } = {}) {
    await client.query('begin');
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const order = await seedPostedPayment(client, { lines: [{ price: 4000, quantity: 2 }], createdAt: nowIso() });
    const disputes = [];
    for (let i = 0; i < (input.disputes ?? 1); i += 1) {
      disputes.push(await seedDispute(client, { orderId: order.orderId, paymentIntentId: order.paymentIntentId, amount: 8000 / (input.disputes ?? 1),
        withdrawnAt: nowIso() }));
    }
    await client.query('commit');
    return { order, disputes };
  }
  const run = async (client: PgClient) =>
    (await client.query('select public.accounting_run_posting(50) as r')).rows[0].r as RunResult;

  /** Wait until the backend of `client` is blocked by another one; the wait itself is what the test observes. */
  async function waitUntilBlocked(observer: PgClient, pid: number): Promise<number[]> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blockers = (await observer.query('select pg_catalog.pg_blocking_pids($1::integer) as b', [pid])).rows[0].b as number[];
      if (blockers.length > 0) return blockers;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('RUN_B_WAS_NOT_BLOCKED');
  }
  const pidOf = async (client: PgClient) => (await client.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
  async function withClients<T>(task: (c: { setup: PgClient; a: PgClient; b: PgClient; observer: PgClient }) => Promise<T>): Promise<T> {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      return await task({ setup, a, b, observer });
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  }
  const countOf = async (client: PgClient, sql: string, params: unknown[]) => Number((await client.query(sql, params)).rows[0].n);

  test.each([1, 2, 3])('FREQ-568-AC-01: 同じ取り消しを同時に流しても仕訳は1本で通し番号に欠番ができない（%i回目）', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { disputes } = await seedWithdrawal(setup);
      const key = `dispute_event:${disputes[0].disputeId}:withdrawn:${disputes[0].txnId}`;
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await run(a);
      // A holds the accounting locks until it commits; B asks for them and waits.
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      const secondResult = await second;
      expect(first.disputes).toBeGreaterThanOrEqual(1);
      expect(secondResult.disputes).toBe(0);
      const entries = (await setup.query('select id, period_id from public.accounting_journal_entries where dedupe_key = $1', [key])).rows;
      expect(entries).toHaveLength(1);
      const numbers = (await setup.query(
        'select count(*)::int as n, max(entry_no)::int as max, min(entry_no)::int as min from public.accounting_journal_entries where period_id = $1',
        [entries[0].period_id])).rows[0];
      expect(numbers.min).toBe(1);
      expect(numbers.max).toBe(numbers.n);
    });
  });

  test('FREQ-568-AC-01: 先に始めた方が失敗して巻き戻っても、後から来た方が1本だけ入れる', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { disputes } = await seedWithdrawal(setup);
      const key = `dispute_event:${disputes[0].disputeId}:withdrawn:${disputes[0].txnId}`;
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      await run(a);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('rollback');
      expect((await second).disputes).toBeGreaterThanOrEqual(1);
      expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1', [key])).toBe(1);
    });
  });

  test('FREQ-568-AC-04: 取り下げの戻りの取引を同時に流しても、戻りの取引1件に仕訳は1本', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { disputes } = await seedWithdrawal(setup);
      await run(setup);
      await addDisputeHistory(setup, { disputeId: disputes[0].disputeId, status: 'won', occurredAt: nowIso(), eventType: 'charge.dispute.closed' });
      const reversal = await seedDisputeReversal(setup, { disputeId: disputes[0].disputeId, amount: 8000, createdAt: nowIso() });
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await run(a);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first.disputes).toBe(1);
      expect((await second).disputes).toBe(0);
      expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1',
        [`dispute_event:${disputes[0].disputeId}:reversal:${reversal}`])).toBe(1);
    });
  });

  test('FREQ-562-AC-05: 取り消しが2つあっても同時の2回で1本ずつ、確定も1本', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { order, disputes } = await seedWithdrawal(setup, { disputes: 2 });
      // One of the two units is sent (confirmed an hour ago), so each loss has a shipped part to confirm.
      await setup.query('begin');
      await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const slip = await seedConfirmedSlip(setup, { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
        recordFact: false });
      await recordSlipFactAt(setup, slip.slipId, 'confirm', new Date(Date.now() - 3_600_000).toISOString());
      await setup.query('commit');
      for (const d of disputes) {
        await addDisputeHistory(setup, { disputeId: d.disputeId, status: 'lost', occurredAt: nowIso(), stripeEventCreatedAt: nowIso(), eventType: 'charge.dispute.closed' });
      }
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await run(a);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first).toMatchObject({ shipments: 1, disputes: 4 });
      expect(await second).toMatchObject({ shipments: 0, disputes: 0 });
      for (const d of disputes) {
        expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where starts_with(dedupe_key, $1)',
          [`dispute_event:${d.disputeId}:`])).toBe(2);
        expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1',
          [`dispute_event:${d.disputeId}:confirmed:lost`])).toBe(1);
      }
    });
  });

  test('FREQ-568-AC-01: 係が動いている間、発送票を確定する側（Gの共通の鍵）は待たされる。待ちの長さは記録するだけ', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      // Twenty withdrawals waiting: the run takes a while and holds the group G lock until it commits.
      for (let i = 0; i < 20; i += 1) await seedWithdrawal(setup, { disputes: 1 });
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const startedAt = Date.now();
      const running = run(a);
      // Wait until the run holds the group G lock (190521,1), the first thing every group G writer takes; then a slip confirm asks for it.
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const held = await observer.query(
          "select 1 from pg_catalog.pg_locks where locktype = 'advisory' and classid = 190521 and objid = 1 and pid = $1 and granted", [pidA]);
        if (held.rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const askedAt = Date.now();
      const writer = b.query('select pg_catalog.pg_advisory_lock(190521,1)').then(() => b.query('select pg_catalog.pg_advisory_unlock(190521,1)'));
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      const result = await running;
      const ranMs = Date.now() - startedAt;
      await a.query('commit');
      await writer;
      const waitedMs = Date.now() - askedAt;
      // Record only (Ruling P2-R7): the numbers go into the report, not to the console.
      fs.writeFileSync(path.join(os.tmpdir(), 'accounting-p2-task6-slip-wait.json'),
        JSON.stringify({ waitedMs, runMs: ranMs, withdrawals: 20, posted: result.disputes + result.payments + result.stripe }));
      expect(result.disputes).toBeGreaterThanOrEqual(20);
      expect(waitedMs).toBeGreaterThan(0);
    });
  });

  test('FREQ-568-AC-03: 発送票を確定する側が先に鍵を取っていると、係はそれが終わるのを待ってから引かれた時を数える', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      // A confirms a slip (holds the group G lock and has taken its fact number); the dispute runner B must wait and then see it.
      const { order, disputes } = await seedWithdrawal(setup);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      await a.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const slip = await seedConfirmedSlip(a, { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 1 }] }],
        recordFact: false });
      await recordSlipFactAt(a, slip.slipId, 'confirm', new Date(Date.now() - 3_600_000).toISOString());
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      const result = await second;
      // The slip was confirmed before the withdrawal time and its shipment is posted in the same call: the unit counts as sent.
      expect(result.shipments).toBe(1);
      const lines = (await setup.query(
        `select l.account_code, l.debit::int as debit from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
         where e.dedupe_key = $1 order by l.line_no`, [`dispute_event:${disputes[0].disputeId}:withdrawn:${disputes[0].txnId}`])).rows;
      expect(lines.map((l) => `${l.account_code}:${l.debit}`)).toEqual(['1160:0', '2150:4000', '1470:4000']);
    });
  });
});
