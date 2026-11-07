/** @jest-environment node */
/**
 * Accounting plan 1 S2 (FREQ-554-AC-03/04): two writers with the same event key, or two reversals of the same entry,
 * wait on the common lock and leave exactly one entry, with no gap in the entry numbers.
 *
 * This suite COMMITS periods and entries (entries cannot be deleted). Run it last, on its own jest invocation, with a
 * db reset before and after (controller only), three times in a row:
 *   npm run db:reset
 *   ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx jest tests/integration/db/accounting_p1_journal_concurrency --runInBand
 *   npm run db:reset
 * Without ACCOUNTING_COMMIT_SUITE=1 it skips; a non-localhost URL fails.
 */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { journalLines, postJournal, seedAccountingPeriod } from './helpers/accounting-fixtures';

type Posted = { entry_id: string; entry_no: number; created: boolean };
type Outcome = { ok: true; result: Posted } | { ok: false; code?: string; message?: string };
type Op = (client: PgClient) => Promise<Posted>;
jest.setTimeout(120000);
const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';
const SALE = [{ account: '1130', debit: 1000 }, { account: '4010', credit: 1000 }];

describeLocalDb('S2 journal concurrency: controller only, commits rows', (db) => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }
  const clients: PgClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { await c.query('rollback').catch(() => undefined); await c.end(); }
  });
  async function connection() { const c = await connectLocalDb(); clients.push(c); await c.query("set statement_timeout='20s'"); return c; }
  const pid = async (c: PgClient) => Number((await c.query('select pg_backend_pid() as p')).rows[0].p);
  /** Wait until the waiter is blocked by one of the blockers on the group G common lock (190521,1); no fixed sleep. */
  async function waitBlocked(waiter: number, blockers: number[]) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const r = (await db().query(`select exists(select 1 from unnest(pg_blocking_pids($1)) p where p = any($2::int[])) as b,
        exists(select 1 from pg_locks where pid = $1 and locktype = 'advisory' and classid = 190521 and objid = 1 and objsubid = 2
          and not granted) as l`, [waiter, blockers])).rows[0];
      if (r.b && r.l) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('ACC_S2_COMMON_LOCK_WAIT_NOT_OBSERVED');
  }
  async function invoke(c: PgClient, op: Op): Promise<Outcome> {
    await c.query('savepoint acc_s2_race');
    try { const result = await op(c); await c.query('set constraints all immediate'); return { ok: true, result }; } catch (caught) {
      const e = caught as { code?: string; message?: string };
      await c.query('rollback to savepoint acc_s2_race');
      return { ok: false, code: e.code, message: /^ACCOUNTING_[A-Z_]+$/.test(e.message ?? '') ? e.message : 'DATABASE_ERROR' };
    }
  }
  /** Both writers queue behind a held common lock; the gate opens, the winner commits, then the loser decides. */
  async function race(aOp: Op, bOp: Op): Promise<Outcome[]> {
    const gate = await connection(), a = await connection(), b = await connection();
    const gp = await pid(gate), ap = await pid(a), bp = await pid(b);
    await gate.query('begin'); await gate.query('select pg_advisory_xact_lock(190521, 1)');
    await a.query('begin'); await b.query('begin');
    const pa = invoke(a, aOp); await waitBlocked(ap, [gp]);
    const pb = invoke(b, bOp); await waitBlocked(bp, [gp, ap]);
    await gate.query('rollback');
    const aFirst = await Promise.race([pa.then(() => true), pb.then(() => false)]);
    const [winner, loser, wc, lc, wp, lp] = aFirst ? [pa, pb, a, b, ap, bp] : [pb, pa, b, a, bp, ap];
    const w = await winner;
    if (w.ok) await waitBlocked(lp, [wp]);
    await wc.query(w.ok ? 'commit' : 'rollback');
    const l = await loser; await lc.query(l.ok ? 'commit' : 'rollback');
    const results = [await pa, await pb];
    expect(results.some((r) => !r.ok && r.code === '40P01')).toBe(false);
    return results;
  }
  async function committed<T>(run: () => Promise<T>): Promise<T> {
    await db().query('begin');
    try { const value = await run(); await db().query('set constraints all immediate'); await db().query('commit'); return value; } catch (e) {
      await db().query('rollback'); throw e;
    }
  }
  const periodState = async (periodId: string) => (await db().query(`select
      (select last_entry_no::int from public.accounting_period_sequences where period_id = $1) as last_no,
      (select count(*)::int from public.accounting_journal_entries where period_id = $1) as entries,
      (select coalesce(max(entry_no), 0)::int from public.accounting_journal_entries where period_id = $1) as max_no`, [periodId])).rows[0];

  test('FREQ-554-AC-03: 同じ印を同時に入れても1本だけが残り通し番号に欠番ができない', async () => {
    const period = await committed(() => seedAccountingPeriod(db(), { businessType: 'corporation' }));
    const date = (await db().query("select to_char(starts_on, 'YYYY-MM-DD') as d from public.accounting_periods where id = $1", [period])).rows[0].d as string;
    for (let round = 1; round <= 3; round += 1) {
      const part = `pi_race_${randomUUID().slice(0, 8)}`;
      const before = await periodState(period);
      const op: Op = async (c) => (await c.query(
        `select private.accounting_post_journal_core(null, $1::uuid, $2::date, 'payment_confirmed', $3::text[], 'race', $4::jsonb) as r`,
        [period, date, [part], journalLines(SALE)])).rows[0].r;
      const results = await race(op, op);
      const created = results.flatMap((r) => (r.ok ? [r.result] : []));
      expect({ round, failures: results.filter((r) => !r.ok) }).toEqual({ round, failures: [] });
      expect(created.map((r) => r.created).sort()).toEqual([false, true]);
      expect(created[0].entry_id).toBe(created[1].entry_id);
      const after = await periodState(period);
      expect({ round, after }).toEqual({ round, after: { last_no: (before.last_no ?? 0) + 1, entries: before.entries + 1, max_no: before.entries + 1 } });
      expect((await db().query('select count(*)::int as n from public.accounting_journal_entries where dedupe_key = $1', [`payment_confirmed:${part}`])).rows[0].n).toBe(1);
    }
  });

  test('FREQ-554-AC-04: 同じ元を同時に取り消しても1本だけ', async () => {
    const period = await committed(() => seedAccountingPeriod(db(), { businessType: 'corporation' }));
    const date = (await db().query("select to_char(starts_on, 'YYYY-MM-DD') as d from public.accounting_periods where id = $1", [period])).rows[0].d as string;
    for (const [round, reasons] of [[1, ['same', 'same']], [2, ['first', 'second']], [3, ['same', 'same']]] as [number, [string, string]][]) {
      const original = await committed(() => postJournal(db(), { periodId: period, entryDate: date, kind: 'payment_confirmed', parts: [`pi_rev_${randomUUID().slice(0, 8)}`], lines: SALE }));
      const before = await periodState(period);
      const op = (reason: string): Op => async (c) => (await c.query(
        'select private.accounting_reverse_journal_core(null, $1::uuid, $2::text) as r', [original.entryId, reason])).rows[0].r;
      const results = await race(op(reasons[0]), op(reasons[1]));
      const ok = results.flatMap((r) => (r.ok ? [r.result] : []));
      if (reasons[0] === reasons[1]) {
        expect({ round, created: ok.map((r) => r.created).sort() }).toEqual({ round, created: [false, true] });
      } else {
        expect({ round, ok: ok.map((r) => r.created), failed: results.filter((r) => !r.ok) })
          .toEqual({ round, ok: [true], failed: [{ ok: false, code: '23505', message: 'ACCOUNTING_ALREADY_REVERSED' }] });
      }
      expect((await db().query('select count(*)::int as n from public.accounting_journal_entries where reverses_entry_id = $1', [original.entryId])).rows[0].n).toBe(1);
      const after = await periodState(period);
      expect({ round, after }).toEqual({ round, after: { last_no: before.last_no + 1, entries: before.entries + 1, max_no: before.entries + 1 } });
    }
  });
});
