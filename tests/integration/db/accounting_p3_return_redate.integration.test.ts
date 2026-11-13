/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import { setAsideExistingSlips, setCutoverForTest } from './helpers/accounting-orders-fixtures';
import {
  correctArrival, orderBalance, postReturnEvents, receiveReturn, refundPending, seedReturnFlow, setRequestedAt, type ReturnFlow,
} from './helpers/accounting-returns-fixtures';
import { describeLocalDb } from './helpers/local-db';
import { ACCOUNTING_LABELS } from '@/lib/accounting/labels';

// 計画3 Task 7（S21）: 届いた日の直し（1-a22）の仕訳と、仕訳から直した跡をたどる読み口。
jest.setTimeout(180000);

const NONE = { posted: 0, parked_new: 0, reparked: 0, resolved: 0, reversed: 0, redated: 0 };
const STANDARD_ARRIVAL = [['4020', 18750, 0, null], ['2130', 0, 18750, 'return_refund'], ['2130', 1875, 0, 'return_refund'], ['4050', 0, 1875, null]];
const REVERSED_ARRIVAL = [['4020', 0, 18750, null], ['2130', 18750, 0, 'return_refund'], ['2130', 0, 1875, 'return_refund'], ['4050', 1875, 0, null]];

describeLocalDb('FREQ-578-AC-03: S21 arrival redate', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_advisory_xact_lock(190521,1)');
    await setAsideExistingSlips(db());
    await setCutoverForTest(db(), '2026-01-01');
  });
  afterEach(async () => { await db().query('rollback'); });

  const q = (text: string, params?: unknown[]) => db().query(text, params);
  const day = async (n = 0) => (await q("select (((now() at time zone 'Asia/Tokyo')::date) - $1::integer)::text as d", [n])).rows[0].d as string;
  const shape = (rows: Array<Record<string, unknown>>) => rows.map((l) => [l.account_code, l.debit, l.credit, l.sub_account ?? null]);
  /** The entries of the order, oldest first (entry_no runs per period, so the order is recorded_at, the day, then entry_no). */
  const entries = async (orderId: string) => {
    const lines = (await q(`select e.id as entry_id, e.event_kind, e.dedupe_key, e.entry_date::text as entry_date, e.reverses_entry_id,
      l.account_code, l.debit::int as debit, l.credit::int as credit, l.sub_account
      from public.accounting_journal_entries e join public.accounting_journal_lines l on l.entry_id=e.id
      where l.order_id=$1 order by e.recorded_at, e.entry_date, e.entry_no, l.line_no`, [orderId])).rows;
    const ids = [...new Set(lines.map((l) => l.entry_id as string))];
    return ids.map((id) => {
      const own = lines.filter((l) => l.entry_id === id);
      return { id, kind: own[0].event_kind as string, key: own[0].dedupe_key as string, date: own[0].entry_date as string,
        reverses: own[0].reverses_entry_id as string | null, lines: shape(own) };
    });
  };
  const periodOf = async (entryId: string) => (await q('select period_id from public.accounting_journal_entries where id=$1', [entryId])).rows[0].period_id;
  /** 届いた日を n 日前にして相談で受け取り、届いた日の仕訳まで入れる。 */
  async function arrived(daysAgo: number, flowDaysAgo = daysAgo + 2): Promise<{ flow: ReturnFlow; receiptId: string }> {
    const flow = await seedReturnFlow(db());
    await setRequestedAt(db(), flow.returnId, `${await day(flowDaysAgo)}T12:00:00+09:00`);
    const received = await receiveReturn(db(), flow, { choice: 'consult', arrivedOn: await day(daysAgo),
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1 });
    return { flow, receiptId: received.receipt_id };
  }

  test('FREQ-578-AC-03: 届いた日を直すと、古い日の取り消しと直した日の同じ行の仕訳になる（印は reversal:<元> と return_arrival_redated:<直しの番号>）', async () => {
    const { flow, receiptId } = await arrived(5);
    const [original] = await entries(flow.f.orderId);
    const correction = await correctArrival(db(), receiptId, await day(3));
    expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1, redated: 1 });
    const all = await entries(flow.f.orderId);
    expect(all).toHaveLength(3);
    const [, reversal, redated] = all;
    expect(reversal).toMatchObject({ kind: 'reversal', key: `reversal:${original.id}`, reverses: original.id, date: await day(5), lines: REVERSED_ARRIVAL });
    expect(redated).toMatchObject({ kind: 'return_arrival_redated', key: `return_arrival_redated:${correction.correction_id}`, date: await day(3),
      reverses: null, lines: STANDARD_ARRIVAL });
    // The reversal keeps the original's description (the core) and carries the redate label as its reason.
    const described = (await q('select id, description, reason from public.accounting_journal_entries where id = any($1::uuid[])',
      [[reversal.id, redated.id]])).rows;
    expect(described.find((d) => d.id === reversal.id)).toMatchObject({ description: ACCOUNTING_LABELS.returnArrived,
      reason: ACCOUNTING_LABELS.returnArrivalRedated });
    expect(described.find((d) => d.id === redated.id)).toMatchObject({ description: ACCOUNTING_LABELS.returnArrived, reason: null });
    expect(await orderBalance(db(), flow.f.orderId, '2130', 'return_refund')).toBe(16875);
    expect(await postReturnEvents(db())).toEqual(NONE);
  });

  test('FREQ-578-AC-03: 別の期間にまたがる直しでも、取り消しは元の期間、新しい仕訳は新しい期間に入る', async () => {
    await setCutoverForTest(db(), '2025-01-01');
    const flow = await seedReturnFlow(db());
    await setRequestedAt(db(), flow.returnId, '2025-12-20T12:00:00+09:00');
    const received = await receiveReturn(db(), flow, { choice: 'consult', arrivedOn: '2025-12-25',
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    await postReturnEvents(db());
    await correctArrival(db(), received.receipt_id, '2026-01-05');
    expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1, redated: 1 });
    const [original, reversal, redated] = await entries(flow.f.orderId);
    expect(original.date).toBe('2025-12-25');
    expect(reversal.date).toBe('2025-12-25');
    expect(redated.date).toBe('2026-01-05');
    expect(await periodOf(reversal.id)).toBe(await periodOf(original.id));
    expect(await periodOf(redated.id)).not.toBe(await periodOf(original.id));
    const periods = (await q(`select p.id, p.starts_on::text s from public.accounting_periods p where p.id = any($1::uuid[])`,
      [[await periodOf(original.id), await periodOf(redated.id)]])).rows;
    expect(periods.map((p) => p.s).sort()).toEqual(['2025-01-01', '2026-01-01']);
  });

  test('FREQ-578-AC-03: 直した先の日が期間の無い日なら period_missing で止まり、元の仕訳は取り消されないまま残る', async () => {
    await setCutoverForTest(db(), '2025-01-01');
    const flow = await seedReturnFlow(db());
    await setRequestedAt(db(), flow.returnId, '2025-12-20T12:00:00+09:00');
    const received = await receiveReturn(db(), flow, { choice: 'consult', arrivedOn: '2025-12-25',
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    await postReturnEvents(db());
    // A corporation has no period for 2026 yet.
    const admin = await insertAccountingAdmin(db());
    const version = (await q('select version::text as v from public.accounting_settings where id = 1')).rows[0].v;
    await q("select public.admin_update_accounting_settings($1::uuid, null, 'corporation', $2::bigint, $3::uuid)", [admin, version, randomUUID()]);
    const first = await correctArrival(db(), received.receipt_id, '2026-01-05');
    expect(await postReturnEvents(db())).toEqual({ ...NONE, parked_new: 1 });
    expect(await refundPending(db(), first.correction_id)).toMatchObject([{ event_kind: 'return_arrival_redated',
      source_table: 'order_return_arrival_corrections', reason: 'period_missing', detail: { entry_date: '2026-01-05' }, resolved_at: null }]);
    const after = await entries(flow.f.orderId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'return_arrived', date: '2025-12-25', lines: STANDARD_ARRIVAL });
    // A newer correction back into 2025 overtakes the parked one: the parked row closes, and the entry moves once.
    const second = await correctArrival(db(), received.receipt_id, '2025-12-27');
    expect(await postReturnEvents(db())).toMatchObject({ posted: 1, redated: 1, resolved: 1 });
    expect((await refundPending(db(), first.correction_id))[0].resolved_at).not.toBeNull();
    const moved = await entries(flow.f.orderId);
    expect(moved.map((e) => [e.kind, e.date])).toEqual([['return_arrived', '2025-12-25'], ['reversal', '2025-12-25'],
      ['return_arrival_redated', '2025-12-27']]);
    expect(moved[2].key).toBe(`return_arrival_redated:${second.correction_id}`);
  });

  test('FREQ-578-AC-03: 届いた日を2回直しても、取り消しは1回ずつで最後の日の仕訳だけが残る', async () => {
    const { flow, receiptId } = await arrived(6);
    const one = await correctArrival(db(), receiptId, await day(4));
    expect(await postReturnEvents(db())).toMatchObject({ posted: 1, redated: 1 });
    const two = await correctArrival(db(), receiptId, await day(2));
    expect(await postReturnEvents(db())).toMatchObject({ posted: 1, redated: 1 });
    const all = await entries(flow.f.orderId);
    expect(all).toHaveLength(5);
    const live = all.filter((e) => e.reverses === null && !all.some((r) => r.reverses === e.id));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: 'return_arrival_redated', key: `return_arrival_redated:${two.correction_id}`, date: await day(2) });
    const reversals = all.filter((e) => e.reverses !== null);
    expect(reversals.map((r) => r.reverses).sort()).toEqual([all[0].id, all.find((e) => e.key === `return_arrival_redated:${one.correction_id}`)!.id].sort());
    expect(new Set(reversals.map((r) => r.reverses)).size).toBe(2);
    expect(await orderBalance(db(), flow.f.orderId, '2130', 'return_refund')).toBe(16875);
    expect(await orderBalance(db(), flow.f.orderId, '4050')).toBe(1875);
  });

  test('FREQ-578-AC-03: 仕訳から直した跡（理由・人・前後の日）をたどれる', async () => {
    const { flow, receiptId } = await arrived(5);
    const actor = await insertAccountingAdmin(db());
    await correctArrival(db(), receiptId, await day(3), { actor, reason: '配達の記録と照らした' });
    await postReturnEvents(db());
    const trace = (await q('select public.get_return_journal_trace($1) as t', [receiptId])).rows[0].t;
    expect(trace.receipt).toMatchObject({ id: receiptId, return_id: flow.returnId, arrived_on: await day(5) });
    expect(trace.corrections).toEqual([expect.objectContaining({ version: 1, previous_on: await day(5), new_on: await day(3),
      reason: '配達の記録と照らした', actor_id: actor })]);
    expect(trace.entries.map((e: { event_kind: string; entry_date: string }) => [e.event_kind, e.entry_date])).toEqual([
      ['return_arrived', await day(5)], ['reversal', await day(5)], ['return_arrival_redated', await day(3)]]);
    expect(trace.entries[1].reverses_entry_id).toBe(trace.entries[0].entry_id);
    // Not a receive receipt: null. Service role only.
    expect((await q('select public.get_return_journal_trace($1) as t', [randomUUID()])).rows[0].t).toBeNull();
    const grants = (await q(`select grantee from information_schema.routine_privileges
      where routine_schema='public' and routine_name='get_return_journal_trace' and privilege_type='EXECUTE' order by grantee`)).rows.map((r) => r.grantee);
    expect(grants.filter((g) => ['anon', 'authenticated', 'PUBLIC', 'service_role'].includes(g))).toEqual(['service_role']);
  });

  test('FREQ-578-AC-06: 届いた日の直しの事実が届いた日の仕訳より先に見つかったら、直した日で最初から立つ', async () => {
    const flow = await seedReturnFlow(db());
    await setRequestedAt(db(), flow.returnId, `${await day(7)}T12:00:00+09:00`);
    const received = await receiveReturn(db(), flow, { choice: 'consult', arrivedOn: await day(5),
      units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    const correction = await correctArrival(db(), received.receipt_id, await day(3));
    expect(await postReturnEvents(db())).toEqual({ ...NONE, posted: 1 });
    const all = await entries(flow.f.orderId);
    expect(all).toEqual([expect.objectContaining({ kind: 'return_arrived', key: `return_arrived:${received.receipt_id}`, date: await day(3),
      reverses: null, lines: STANDARD_ARRIVAL })]);
    expect(await refundPending(db(), correction.correction_id)).toEqual([]);
    expect(await postReturnEvents(db())).toEqual(NONE);
  });
});
