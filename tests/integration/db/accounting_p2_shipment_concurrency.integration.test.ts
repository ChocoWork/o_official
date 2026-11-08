/** @jest-environment node */
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { cancelSlip, correctShipmentDate, seedConfirmedSlip, seedPostedPayment } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 3 (FREQ-563-AC-06, FREQ-564-AC-02): two runs of the shipment posting at the same time. This suite
// COMMITS rows (orders, charges, slips, entries) into the local database and the accounting rows cannot be removed: run it
// alone, with ACCOUNTING_COMMIT_SUITE=1, between two resets.
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p2_shipment_concurrency --runInBand; db reset
// The cutover day is today in Japan, so every day used here is today or tomorrow (a slip dated tomorrow is corrected to today).
jest.setTimeout(120000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

type RunResult = { posted: number; parked_new: number; reparked: number; resolved: number; reversed: number; redated: number };

describeLocalDb('S8 shipment posting under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }

  const nowIso = () => new Date().toISOString();
  /** A paid order with its payment entry (a committed transaction), and a confirmed slip dated `dayOffset` days from today. */
  async function seedShipment(client: PgClient, dayOffset = 0) {
    await client.query('begin');
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const order = await seedPostedPayment(client, { lines: [{ price: 4000, quantity: 2 }], createdAt: nowIso() });
    await client.query('commit');
    const date = (await client.query("select ((now() at time zone 'Asia/Tokyo')::date + $1::integer)::text as d", [dayOffset])).rows[0].d as string;
    const slip = await seedConfirmedSlip(client, { orders: [{ orderId: order.orderId, lines: [{ orderItemId: order.orderItemIds[0], quantity: 2 }] }],
      shipmentDate: date });
    return { order, slip, date };
  }
  const post = async (client: PgClient) =>
    (await client.query('select private.accounting_post_shipment_events(50) as r')).rows[0].r as RunResult;

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
  async function withClients<T>(run: (c: { setup: PgClient; a: PgClient; b: PgClient; observer: PgClient }) => Promise<T>): Promise<T> {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      return await run({ setup, a, b, observer });
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  }
  const countOf = async (client: PgClient, sql: string, params: unknown[]) =>
    Number((await client.query(sql, params)).rows[0].n);

  test.each([1, 2, 3])('FREQ-563-AC-06: 同じ発送票を同時に流しても1本だけ残り通し番号に欠番ができない（%i回目）', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { slip } = await seedShipment(setup);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await post(a);
      // A holds the accounting locks until it commits; B asks for them and waits.
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      const secondResult = await second;
      expect(first.posted).toBeGreaterThanOrEqual(1);
      expect(secondResult.posted).toBe(0);
      const entries = (await setup.query('select id, period_id from public.accounting_journal_entries where dedupe_key = $1',
        ['shipment_confirmed:' + slip.number])).rows;
      expect(entries).toHaveLength(1);
      expect(await countOf(setup, 'select count(*) as n from public.accounting_shipment_units where entry_id = $1', [entries[0].id])).toBe(2);
      const numbers = (await setup.query(
        'select count(*)::int as n, max(entry_no)::int as max, min(entry_no)::int as min from public.accounting_journal_entries where period_id = $1',
        [entries[0].period_id])).rows[0];
      expect(numbers.min).toBe(1);
      expect(numbers.max).toBe(numbers.n);
    });
  });

  test('FREQ-563-AC-06: 先に始めた方が失敗して巻き戻っても、後から来た方が1本だけ入れる', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { slip } = await seedShipment(setup);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      await post(a);
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('rollback');
      expect((await second).posted).toBeGreaterThanOrEqual(1);
      expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1',
        ['shipment_confirmed:' + slip.number])).toBe(1);
    });
  });

  test('FREQ-564-AC-01: 同じ取り消しを同時に流しても取り消しの仕訳は1本', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const { slip } = await seedShipment(setup);
      await post(setup);
      await cancelSlip(setup, slip.slipId);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await post(a);
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first.reversed).toBe(1);
      expect((await second).reversed).toBe(0);
      const entry = (await setup.query('select id from public.accounting_journal_entries where dedupe_key = $1', ['shipment_confirmed:' + slip.number])).rows[0];
      expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where reverses_entry_id = $1', [entry.id])).toBe(1);
    });
  });

  test('FREQ-564-AC-02: 同じ直しを同時に流しても、取り消しも入れ直しも1本ずつ', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      // Dated tomorrow (a direct insert may), posted, then corrected to today (the group G function allows it).
      const { slip } = await seedShipment(setup, 1);
      await post(setup);
      const historyId = await correctShipmentDate(setup, slip.slipId, (await setup.query("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await post(a);
      const second = post(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first.redated).toBe(1);
      expect((await second).redated).toBe(0);
      const entry = (await setup.query('select id from public.accounting_journal_entries where dedupe_key = $1', ['shipment_confirmed:' + slip.number])).rows[0];
      expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where reverses_entry_id = $1', [entry.id])).toBe(1);
      expect(await countOf(setup, 'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1', ['shipment_redated:' + historyId])).toBe(1);
    });
  });

  test('FREQ-563-AC-06: 係が動いている間、発送票を確定する側（Gの共通の鍵）は待たされる。待ちの長さは記録するだけ', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      await seedShipment(setup);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      await post(a);
      const startedAt = Date.now();
      // The first thing every group G writer takes is the common advisory (190521,1).
      const writer = b.query('select pg_catalog.pg_advisory_lock(190521,1)').then(() => b.query('select pg_catalog.pg_advisory_unlock(190521,1)'));
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await a.query('commit');
      await writer;
      const waitedMs = Date.now() - startedAt;
      // Record only (Ruling P2-R7): the wait lasts as long as the poster's transaction; the measured value goes into the report.
      expect(waitedMs).toBeGreaterThanOrEqual(150);
    });
  });
});
