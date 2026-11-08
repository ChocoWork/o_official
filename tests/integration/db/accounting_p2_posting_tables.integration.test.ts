/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { allocateByWeight } from '@/lib/accounting/allocate';
import { PENDING_REASONS } from '@/lib/accounting/posting-types';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createPurchaseFlow } from './helpers/purchase-order-flow';
import { seedGroupG3ReadyOrder } from './helpers/group-g3-fixtures';
import {
  insertAccountingAdmin, japanToday, postJournal, seedAccountingPeriod,
} from './helpers/accounting-fixtures';
import {
  recordSlipFact, seedBareSlip, seedFactSlip, seedUnitOrder, setCutoverForTest, shippedUnits, slipFactSeq,
} from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 1 (FREQ-562 / 563 / 569): the posting foundation. ROLLBACK form (run with --runInBand),
// except the concurrency test at the end, which commits rows into the local database (reset it afterwards).
jest.setTimeout(120000);

const directory = path.join(process.cwd(), 'supabase/migrations');
const g4 = fs.readFileSync(path.join(directory, '20261026045859_group_g4_orders_foundation.sql'), 'utf8');
const g3 = fs.readFileSync(path.join(directory, '20261025100130_group_g3_shipping_slips.sql'), 'utf8');
const confirmSignature = 'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)';
const cancelSignature = 'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)';
const STRIP_BLOCKS = /-- ACC_P\d_BEGIN[\s\S]*?-- ACC_P\d_END/g;
const squash = (value: string) => value.replace(STRIP_BLOCKS, '').replace(/\s+/g, '');
const bodyOf = (statement: string) => statement.slice(statement.indexOf('AS $$') + 5, statement.lastIndexOf('$$;'));
const confirmLatest = g4.match(/CREATE OR REPLACE FUNCTION private\.admin_confirm_shipment_slip\([\s\S]*?\n\$\$;/)?.[0] ?? '';
const cancelLatest = g3.match(/CREATE FUNCTION private\.admin_cancel_shipment_slip\([\s\S]*?\n\$\$;/)?.[0] ?? '';

type Failure = { code?: string; message?: string } | null;
const TABLES = ['accounting_pending_events', 'accounting_shipment_units', 'accounting_unit_refund_allocations', 'accounting_g_slip_facts'];

describeLocalDb('S6 posting foundation: controller only', (db) => {
  const flow = createPurchaseFlow(db);
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  beforeEach(async () => {
    await q('begin');
    await q('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await q('rollback'); });

  /** The fixed (code, message) of a refusal; everything the run wrote is undone either way. */
  async function failure(run: () => Promise<unknown>): Promise<Failure> {
    await q('savepoint t_failure');
    try {
      await run();
      await q('set constraints all immediate');
      return null;
    } catch (caught) {
      const e = caught as { code?: string; message?: string };
      return { code: e.code, message: /^[A-Z][A-Z0-9_]+$/.test(e.message ?? '') ? e.message : 'DATABASE_ERROR' };
    } finally {
      await q('rollback to savepoint t_failure');
      await q('release savepoint t_failure');
    }
  }
  const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
  const sid = () => `src_${randomUUID().slice(0, 8)}`;
  const park = (kind: string, table: string, id: string, orderId: string | null, reason: string, detail: unknown = {}) =>
    q('select private.accounting_park_event($1, $2, $3, $4::uuid, $5, $6::jsonb)',
      [kind, table, id, orderId, reason, detail === null ? null : JSON.stringify(detail)]);
  const pending = async (id: string) => (await q('select * from public.accounting_pending_events where source_id = $1', [id])).rows[0];
  const allocate = async (total: number, weights: number[]) =>
    ((await q('select private.accounting_allocate_amount($1::bigint, $2::bigint[]) as r', [total, weights])).rows[0].r as string[]).map(Number);
  const refund = (key: string, item: string, unit: number, amount: number) =>
    q('select private.accounting_record_unit_refund($1, $2::uuid, $3, $4)', [key, item, unit, amount]);
  const allocationSum = async (item: string, unit: number) => Number((await q(
    'select coalesce(sum(amount), 0) as s from public.accounting_unit_refund_allocations where order_item_id = $1 and unit_index = $2', [item, unit])).rows[0].s);

  // ---- parked events (FREQ-569) -------------------------------------------------------------------------------
  test('FREQ-569-AC-01: 計上待ちは出来事ごとに1行で、同じ出来事の2回目は回数と最後の日時だけが変わる', async () => {
    const id = sid();
    await park('payment_confirmed', 'stripe_balance_transactions', id, null, 'payment_journal_missing', { order_count: 1 });
    await q('update public.accounting_pending_events set first_detected_at = first_detected_at - interval \'1 hour\', last_detected_at = last_detected_at - interval \'1 hour\' where source_id = $1', [id]);
    const first = await pending(id);
    expect(first).toMatchObject({ detection_count: 1, resolved_at: null, reason: 'payment_journal_missing', detail: { order_count: 1 } });
    await park('payment_confirmed', 'stripe_balance_transactions', id, null, 'amount_mismatch', { stripe_amount: 100, order_total: 90 });
    const second = await pending(id);
    expect((await q('select count(*) as n from public.accounting_pending_events where source_id = $1', [id])).rows[0].n).toBe('1');
    expect(second.id).toBe(first.id);
    expect(second.detection_count).toBe(2);
    expect(second.reason).toBe('amount_mismatch');
    expect(second.detail).toEqual({ stripe_amount: 100, order_total: 90 });
    expect(second.first_detected_at).toEqual(first.first_detected_at);
    expect(new Date(second.last_detected_at).getTime()).toBeGreaterThan(new Date(first.last_detected_at).getTime());
    // The same source id under another kind or table is another event.
    await park('shipment_confirmed', 'stripe_balance_transactions', id, null, 'no_order');
    await park('payment_confirmed', 'shipment_slips', id, null, 'no_order');
    expect((await q('select count(*) as n from public.accounting_pending_events where source_id = $1', [id])).rows[0].n).toBe('3');
  });

  test('FREQ-569-AC-01: 理由の値は決めた値だけを受ける', async () => {
    expect(PENDING_REASONS).toHaveLength(18);
    for (const reason of PENDING_REASONS) {
      const detail = reason === 'period_missing' ? { entry_date: '2026-11-08' } : {};
      const id = sid();
      await park('payment_confirmed', 'orders', id, null, reason, detail);
      expect((await pending(id)).reason).toBe(reason);
    }
    expect(await failure(() => park('payment_confirmed', 'orders', sid(), null, 'something_else'))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => q(`insert into public.accounting_pending_events (event_kind, source_table, source_id, reason)
      values ('payment_confirmed', 'orders', $1, 'something_else')`, [sid()]))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => q(`insert into public.accounting_pending_events (event_kind, source_table, source_id, reason)
      values ('not_a_kind', 'orders', $1, 'no_order')`, [sid()]))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => q(`insert into public.accounting_pending_events (event_kind, source_table, source_id, reason, detail)
      values ('payment_confirmed', 'orders', $1, 'no_order', '[]')`, [sid()]))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => q(`insert into public.accounting_pending_events (event_kind, source_table, source_id, reason, resolution_note)
      values ('payment_confirmed', 'orders', $1, 'no_order', $2)`, [sid(), 'x'.repeat(501)]))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
  });

  const VALID_DETAILS: Array<[string, Record<string, unknown>]> = [
    ['period_missing', { entry_date: '2026-11-08' }],
    ['period_missing', { entry_date: '2026-11-08', cause: 'sole_ended_not_switched' }],
    ['posting_error', { error_sqlstate: '55000', error_code: 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' }],
    ['posting_error', { error_sqlstate: 'XX000', error_code: 'unexpected_error', entry_date: '2026-01-31' }],
    ['amount_mismatch', { stripe_amount: 18750, order_total: 18000 }],
    ['order_not_postable', { reason: 'shipping' }],
    ['order_not_postable', { reason: 'units_sum' }],
    ['order_not_postable', { reason: 'units_missing' }],
    ['payment_journal_missing', { order_count: 2 }],
    ['deferred_revenue_short', { shortage: 100 }],
    ['payout_mismatch', { payout_state: 'payout_not_posted' }],
    ['payout_mismatch', { payout_state: 'payout_net_zero' }],
    ['payout_mismatch', {}],
    ['dispute_withdrawal_missing', { waiting_on: 'dispute_account_unassigned', dispute_status: 'needs_response' }],
    ['dispute_withdrawal_missing', { waiting_on: 'dispute_withdrawn' }],
    ['no_revenue', { lost_on: '2026-11-08' }],
    ['no_revenue', {}],
    ['no_order', {}], ['units_insufficient', {}], ['shipment_date_mismatch', {}], ['before_cutover', {}], ['unknown_category', {}],
    ['dispute_refund_overlap', {}], ['dispute_return_refund_pending', {}], ['dispute_shipment_pending', {}], ['shipment_lines_mismatch', {}],
  ];
  const INVALID_DETAILS: Array<[string, unknown]> = [
    ['period_missing', {}],
    ['period_missing', { entry_date: '2026-11-08', cause: 'other' }],
    ['period_missing', { entry_date: '2026-11-08', customer_email: 'a@example.com' }],
    ['period_missing', { entry_date: '2026-02-30' }],
    ['period_missing', { entry_date: '20261108' }],
    ['period_missing', { entry_date: 20261108 }],
    ['posting_error', { error_sqlstate: '55000', error_code: 'duplicate key value violates unique constraint "x"' }],
    ['posting_error', { error_sqlstate: '5500', error_code: 'unexpected_error' }],
    ['posting_error', { error_sqlstate: '55000', error_code: 'unexpected_error', message: 'raw text' }],
    ['posting_error', { error_sqlstate: 55000, error_code: 'unexpected_error' }],
    ['amount_mismatch', { stripe_amount: -1, order_total: 1 }],
    ['amount_mismatch', { stripe_amount: '100', order_total: 1 }],
    ['amount_mismatch', { stripe_amount: 1.5, order_total: 1 }],
    ['amount_mismatch', { stripe_amount: 9007199254740992, order_total: 1 }],
    ['order_not_postable', { reason: 'other' }],
    ['payment_journal_missing', { order_count: -1 }],
    ['payment_journal_missing', { order_id: 'x' }],
    ['deferred_revenue_short', { shortage: 'many' }],
    ['payout_mismatch', { payout_state: 'matched' }],
    ['dispute_withdrawal_missing', { waiting_on: 'someone' }],
    ['dispute_withdrawal_missing', { dispute_status: 'Needs Response' }],
    ['no_revenue', { lost_on: 'tomorrow' }],
    ['no_order', { email: 'a@example.com' }],
    ['before_cutover', { name: 'x' }],
    ['unknown_category', { category: 'x' }],
    ['no_order', []],
    ['period_missing', null],
  ];
  test('FREQ-569-AC-01: 計上待ちの詳細に個人の情報を入れる鍵は無い（鍵は固定）', async () => {
    for (const [reason, detail] of VALID_DETAILS) {
      const id = sid();
      await park('payment_confirmed', 'orders', id, null, reason, detail);
      expect({ reason, detail: (await pending(id)).detail }).toEqual({ reason, detail });
    }
    for (const [reason, detail] of INVALID_DETAILS) {
      expect({ reason, detail, failure: await failure(() => park('payment_confirmed', 'orders', sid(), null, reason, detail)) })
        .toEqual({ reason, detail, failure: invalid });
    }
    // The upsert checks the new detail too: a bad one leaves the first row as it was.
    const id = sid();
    await park('payment_confirmed', 'orders', id, null, 'payment_journal_missing', { order_count: 1 });
    expect(await failure(() => park('payment_confirmed', 'orders', id, null, 'payment_journal_missing', { order_count: -5 }))).toEqual(invalid);
    expect((await pending(id)).detail).toEqual({ order_count: 1 });
  });

  test('FREQ-569-AC-03: 確認済みにできる理由はbefore_cutoverとno_revenueだけで、お金の動く理由はEVENT_NOT_POSTABLEで断られる', async () => {
    const admin = await insertAccountingAdmin(db());
    for (const reason of PENDING_REASONS) {
      const id = sid();
      await park('payment_confirmed', 'orders', id, null, reason, reason === 'period_missing' ? { entry_date: '2026-11-08' } : {});
      const row = await pending(id);
      const run = () => q('select public.admin_resolve_accounting_pending_event($1, $2, $3, $4) as r', [admin, row.id, '確認した', randomUUID()]);
      if (reason === 'before_cutover' || reason === 'no_revenue') {
        const result = (await run()).rows[0].r;
        expect(result).toMatchObject({ id: row.id, reason, resolved_entry_id: null });
        expect(result.resolved_at).not.toBeNull();
        expect((await pending(id)).resolved_by).toBe(admin);
      } else {
        expect({ reason, failure: await failure(run) }).toEqual({ reason, failure: { code: '55000', message: 'ACCOUNTING_EVENT_NOT_POSTABLE' } });
        expect((await pending(id)).resolved_at).toBeNull();
      }
    }
  });

  test('FREQ-569-AC-01: ops_job_heartbeatsのjobにaccounting_postが通る', async () => {
    await q("select public.record_ops_heartbeat('accounting_post', true, null)");
    const row = (await q("select job, last_succeeded_at from public.get_ops_heartbeats() where job = 'accounting_post'")).rows[0];
    expect(row.job).toBe('accounting_post');
    expect(row.last_succeeded_at).not.toBeNull();
    expect(await failure(() => q("select public.record_ops_heartbeat('accounting_unknown', true, null)"))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
  });

  test('FREQ-569-AC-03: 確認済みにできるのは権限のある人だけで、2回目はPENDING_RESOLVED、同じ要求番号の再送は前の結果', async () => {
    const admin = await insertAccountingAdmin(db());
    const outsider = randomUUID();
    const id = sid();
    await park('payment_confirmed', 'orders', id, null, 'before_cutover');
    const event = await pending(id);
    const call = (actor: string, eventId: string, note: string | null, key: string) =>
      q('select public.admin_resolve_accounting_pending_event($1::uuid, $2::uuid, $3, $4::uuid) as r', [actor, eventId, note, key]);
    expect(await failure(() => call(outsider, event.id, 'メモ', randomUUID()))).toEqual({ code: '42501', message: 'ACCOUNTING_FORBIDDEN' });
    expect(await failure(() => call(admin, event.id, '   ', randomUUID()))).toEqual(invalid);
    expect(await failure(() => call(admin, event.id, 'あ'.repeat(501), randomUUID()))).toEqual(invalid);
    expect(await failure(() => call(admin, event.id, null, randomUUID()))).toEqual(invalid);
    expect(await failure(() => call(admin, randomUUID(), 'メモ', randomUUID()))).toEqual({ code: 'P0002', message: 'ACCOUNTING_NOT_FOUND' });
    const key = randomUUID();
    const first = (await call(admin, event.id, 'あ'.repeat(500), key)).rows[0].r;
    expect(first.resolved_at).not.toBeNull();
    expect((await call(admin, event.id, 'あ'.repeat(500), key)).rows[0].r).toEqual(first);
    expect(await failure(() => call(admin, event.id, '別のメモ', key))).toEqual({ code: '23505', message: 'ACCOUNTING_REQUEST_KEY_CONFLICT' });
    expect(await failure(() => call(admin, event.id, 'メモ', randomUUID()))).toEqual({ code: '55000', message: 'ACCOUNTING_PENDING_RESOLVED' });
    const stored = await pending(id);
    expect(stored).toMatchObject({ resolved_by: admin, resolution_note: 'あ'.repeat(500), resolution_request_key: key });
  });

  test('FREQ-569-AC-03: 確認済みの行は同じ出来事を再び止めても開き直されない', async () => {
    const admin = await insertAccountingAdmin(db());
    const id = sid();
    await park('payment_confirmed', 'orders', id, null, 'before_cutover');
    const event = await pending(id);
    await q('select public.admin_resolve_accounting_pending_event($1, $2, $3, $4)', [admin, event.id, '確認済み', randomUUID()]);
    const resolved = await pending(id);
    await park('payment_confirmed', 'orders', id, null, 'amount_mismatch', { stripe_amount: 1, order_total: 2 });
    expect(await pending(id)).toEqual(resolved);
    // The automatic resolution is idempotent too, and a row it resolved is not reopened either.
    const other = sid();
    await park('shipment_confirmed', 'shipment_slips', other, null, 'payment_journal_missing', { order_count: 1 });
    const period = await seedAccountingPeriod(db(), { businessType: 'soleProprietor' });
    const entry = await postJournal(db(), { periodId: period, entryDate: (await q('select starts_on::text as d from public.accounting_periods where id = $1', [period])).rows[0].d,
      kind: 'payment_confirmed', parts: [`pi_${other}`], lines: [{ account: '1160', debit: 10 }, { account: '2150', credit: 10 }] });
    await q('select private.accounting_unpark_event($1, $2, $3, $4::uuid)', ['shipment_confirmed', 'shipment_slips', other, entry.entryId]);
    const auto = await pending(other);
    expect(auto.resolved_at).not.toBeNull();
    expect(auto.resolved_entry_id).toBe(entry.entryId);
    await q('select private.accounting_unpark_event($1, $2, $3, $4::uuid)', ['shipment_confirmed', 'shipment_slips', other, null]);
    await park('shipment_confirmed', 'shipment_slips', other, null, 'payment_journal_missing', { order_count: 9 });
    expect(await pending(other)).toEqual(auto);
  });

  test('FREQ-569-AC-01: 一覧は新しい順で続きの目印を渡して最後まで読め、既定は未解決だけ', async () => {
    const admin = await insertAccountingAdmin(db());
    const ids = [sid(), sid(), sid(), sid(), sid()];
    for (const id of ids) await park('payment_confirmed', 'orders', id, null, 'before_cutover');
    // The newest five: strictly increasing first_detected_at in the future so no other row interleaves.
    for (const [index, id] of ids.entries()) {
      await q('update public.accounting_pending_events set first_detected_at = now() + make_interval(mins => $2) where source_id = $1', [id, index + 1]);
    }
    const resolvedRow = await pending(ids[0]);
    await q('select public.admin_resolve_accounting_pending_event($1, $2, $3, $4)', [admin, resolvedRow.id, '済み', randomUUID()]);
    const open = Number((await q('select count(*) as n from public.accounting_pending_events where resolved_at is null')).rows[0].n);
    const list = async (resolved: boolean, limit: number, at: string | null = null, after: string | null = null) =>
      (await q('select public.list_accounting_pending_events($1, $2, $3::timestamptz, $4::uuid) as r', [resolved, limit, at, after])).rows[0].r;
    const page1 = await list(false, 2);
    expect(page1.open_count).toBe(open);
    expect(page1.events.map((e: { source_id: string }) => e.source_id)).toEqual([ids[4], ids[3]]);
    expect(page1.next_after_at).not.toBeNull();
    const page2 = await list(false, 2, page1.next_after_at, page1.next_after_id);
    expect(page2.events.map((e: { source_id: string }) => e.source_id)).toEqual([ids[2], ids[1]]);
    // Nothing of this test is left after page 2 (the resolved one is hidden): either there is no next page (no cursor, and the
    // cursor pair is null together) or the next page holds none of the five.
    expect([page2.next_after_at === null, page2.next_after_id === null]).toEqual([page2.next_after_at === null, page2.next_after_at === null]);
    if (page2.next_after_at !== null) {
      const page3 = await list(false, 2, page2.next_after_at, page2.next_after_id);
      expect(page3.events.filter((e: { source_id: string }) => ids.includes(e.source_id))).toEqual([]);
    }
    const all = await list(true, 100);
    expect(all.events.filter((e: { source_id: string }) => ids.includes(e.source_id)).map((e: { source_id: string }) => e.source_id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(Object.keys(all.events[0]).sort()).toEqual(['detail', 'detection_count', 'event_kind', 'first_detected_at', 'id', 'last_detected_at',
      'order_id', 'reason', 'resolved_at', 'resolved_entry_id', 'source_id', 'source_table']);
    expect(await failure(() => list(false, 0))).toEqual(invalid);
    expect(await failure(() => list(false, 101))).toEqual(invalid);
    expect(await failure(() => list(false, 10, page1.next_after_at, null))).toEqual(invalid);
    expect(await failure(() => list(false, 10, null, page1.next_after_id))).toEqual(invalid);
  });

  test('FREQ-569-AC-01: 要約は未解決の件数と理由ごとの件数と最も古い日時を返す', async () => {
    const before = (await q('select public.get_accounting_pending_summary() as r')).rows[0].r;
    await park('payment_confirmed', 'orders', sid(), null, 'before_cutover');
    await park('payment_confirmed', 'orders', sid(), null, 'before_cutover');
    await park('payment_confirmed', 'orders', sid(), null, 'no_order');
    const old = sid();
    await park('payment_confirmed', 'orders', old, null, 'amount_mismatch', { stripe_amount: 1, order_total: 2 });
    await q("update public.accounting_pending_events set first_detected_at = '2000-01-01T00:00:00Z' where source_id = $1", [old]);
    const after = (await q('select public.get_accounting_pending_summary() as r')).rows[0].r;
    expect(after.open_count).toBe(before.open_count + 4);
    expect(after.by_reason.before_cutover).toBe((before.by_reason.before_cutover ?? 0) + 2);
    expect(after.by_reason.no_order).toBe((before.by_reason.no_order ?? 0) + 1);
    expect(after.by_reason.amount_mismatch).toBe((before.by_reason.amount_mismatch ?? 0) + 1);
    expect(new Date(after.oldest_at).toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  // ---- the allocation tool (FREQ-563-AC-03) -------------------------------------------------------------------
  const VECTORS: Array<{ total: number; weights: number[]; expected: number[] }> = [
    { total: 10, weights: [1, 1, 1], expected: [4, 3, 3] },
    { total: 0, weights: [1, 1, 1], expected: [0, 0, 0] },
    { total: 0, weights: [0, 0], expected: [0, 0] },
    { total: 5, weights: [2, 0, 1], expected: [4, 0, 1] },
    { total: 1, weights: [1, 1, 1], expected: [1, 0, 0] },
    { total: 2, weights: [1, 1, 1], expected: [1, 1, 0] },
    { total: 100, weights: [3], expected: [100] },
    { total: 100, weights: [0, 5], expected: [0, 100] },
    { total: 7, weights: [0, 1, 1], expected: [0, 4, 3] },
    { total: 1000, weights: [1, 2, 3, 4], expected: [100, 200, 300, 400] },
    { total: 999, weights: [1, 2, 3, 4], expected: [100, 200, 300, 399] },
    { total: 18750, weights: [6250, 6250, 6250], expected: [6250, 6250, 6250] },
    { total: 10250, weights: [5000, 5250], expected: [5000, 5250] },
    { total: 3, weights: [5000, 0, 5000, 0, 5000], expected: [1, 0, 1, 0, 1] },
    { total: 9007199254740991, weights: [1, 1], expected: [4503599627370496, 4503599627370495] },
  ];
  test('FREQ-563-AC-03: 割り振りは端数を番号の若い順に1円ずつ足し合計が元の額に合う', async () => {
    expect(await allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(await allocate(0, [1, 1, 1])).toEqual([0, 0, 0]);
    expect(await allocate(0, [0, 0])).toEqual([0, 0]);
    expect(await allocate(5, [2, 0, 1])).toEqual([4, 0, 1]);
    expect(await allocate(0, [])).toEqual([]);
    for (const vector of VECTORS) {
      const result = await allocate(vector.total, vector.weights);
      expect(result).toEqual(vector.expected);
      expect(result.reduce((sum, value) => sum + value, 0)).toBe(vector.total);
    }
  });

  test('FREQ-563-AC-03: 重みの合計が0で額が正なら拒む', async () => {
    const call = (total: number | null, weights: Array<number | null> | null) =>
      q('select private.accounting_allocate_amount($1::bigint, $2::bigint[])', [total, weights]);
    expect(await failure(() => call(1, [0, 0]))).toEqual(invalid);
    expect(await failure(() => call(1, []))).toEqual(invalid);
    expect(await failure(() => call(-1, [1]))).toEqual(invalid);
    expect(await failure(() => call(1, [1, -1]))).toEqual(invalid);
    expect(await failure(() => call(1, [1, null]))).toEqual(invalid);
    expect(await failure(() => call(null, [1]))).toEqual(invalid);
    expect(await failure(() => call(1, null))).toEqual(invalid);
  });

  test('FREQ-563-AC-03: TSとSQLの割り振りは同じ値を返す', async () => {
    expect(VECTORS).toHaveLength(15);
    for (const vector of VECTORS) {
      expect({ vector, sql: await allocate(vector.total, vector.weights) }).toEqual({ vector, sql: allocateByWeight(vector.total, vector.weights) });
    }
  });

  // ---- append only and the sum check (FREQ-563) ---------------------------------------------------------------
  test('FREQ-563-AC-03: 送った着の記録と返金の割り当ては追記専用でUPDATEとDELETEとTRUNCATEを断る', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000]]);
    const item = order.orderItemIds[0];
    const period = await seedAccountingPeriod(db(), { businessType: 'soleProprietor' });
    const day = (await q('select starts_on::text as d from public.accounting_periods where id = $1', [period])).rows[0].d as string;
    const entry = await postJournal(db(), { periodId: period, entryDate: day, kind: 'shipment_confirmed', parts: [`SL-${randomUUID().slice(0, 8)}`],
      lines: [{ account: '2150', debit: 5000 }, { account: '4010', credit: 5000 }] });
    await q('insert into public.accounting_shipment_units (entry_id, order_item_id, unit_index, paid_amount) values ($1, $2, 0, 5000)', [entry.entryId, item]);
    await refund('RF-1', item, 0, 100);
    const slip = await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    const immutable = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };
    // TRUNCATE is refused while a deferred check of this transaction is still pending; run them first.
    await q('set constraints all immediate');
    const statements: Array<[string, string]> = [
      ['accounting_shipment_units', "update public.accounting_shipment_units set paid_amount = 1 where order_item_id = '" + item + "'"],
      ['accounting_shipment_units', 'delete from public.accounting_shipment_units'],
      ['accounting_shipment_units', 'truncate table public.accounting_shipment_units'],
      ['accounting_unit_refund_allocations', 'update public.accounting_unit_refund_allocations set amount = 1'],
      ['accounting_unit_refund_allocations', 'delete from public.accounting_unit_refund_allocations'],
      ['accounting_unit_refund_allocations', 'truncate table public.accounting_unit_refund_allocations'],
      ['accounting_g_slip_facts', "update public.accounting_g_slip_facts set kind = 'cancel' where slip_id = '" + slip + "'"],
      ['accounting_g_slip_facts', 'delete from public.accounting_g_slip_facts'],
      ['accounting_g_slip_facts', 'truncate table public.accounting_g_slip_facts'],
    ];
    for (const [table, statement] of statements) {
      expect({ table, statement, failure: await failure(() => q(statement)) }).toEqual({ table, statement, failure: immutable });
      await q('savepoint t_replica');
      await q('set local session_replication_role = replica');
      expect({ table, statement, replica: await failure(() => q(statement)) }).toEqual({ table, statement, replica: immutable });
      await q('rollback to savepoint t_replica');
      await q('release savepoint t_replica');
    }
  });

  test('FREQ-563-AC-02: 返金の割り当ての合計が1着の支払額を超えると断る', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000]]);
    const item = order.orderItemIds[0];
    const insert = async (key: string, unit: number, amount: number) => q(
      `insert into public.accounting_unit_refund_allocations (order_item_id, unit_index, refund_key, amount, fact_seq, locked_at)
       select $1::uuid, $2, $3, $4, t.fact_seq, t.locked_at from private.accounting_take_g_fact_seq() as t`, [item, unit, key, amount]);
    expect(await failure(async () => { await insert('RF-1', 0, 5000); })).toBeNull();
    expect(await failure(async () => { await insert('RF-1', 0, 3000); await insert('RF-2', 0, 2000); })).toBeNull();
    expect(await failure(async () => { await insert('RF-1', 0, 3000); await insert('RF-2', 0, 3000); })).toEqual(invalid);
    expect(await failure(async () => { await insert('RF-1', 0, 5001); })).toEqual(invalid);
    expect(await failure(async () => { await insert('release:RF-1:1', 0, -1); })).toEqual(invalid);
    // A release and the row it releases may arrive in either order inside one transaction.
    expect(await failure(async () => { await insert('release:RF-1:1', 0, -1000); await insert('RF-1', 0, 3000); })).toBeNull();
    expect(await failure(async () => { await insert('RF-1', 0, 3000); await insert('release:RF-1:1', 0, -3001); })).toEqual(invalid);
    // Another unit has its own sum; the table refuses a zero amount, a bad key and a unit that does not exist.
    expect(await failure(async () => { await insert('RF-1', 0, 5000); await insert('RF-1', 1, 5000); })).toBeNull();
    expect(await failure(() => insert('RF-9', 0, 0))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => insert('bad key', 0, 10))).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => insert('RF-9', 7, 10))).toEqual({ code: '23503', message: 'DATABASE_ERROR' });
    expect(await failure(async () => { await insert('RF-1', 0, 10); await insert('RF-1', 0, 10); })).toEqual({ code: '23505', message: 'DATABASE_ERROR' });
  });

  test('FREQ-563-AC-02: 戻しの負の行は release のキーで元の正の合計の範囲だけ受け、出荷済みの着（accounting_shipped_units）への負の行と正の行を断り、reapply と cover の正の行を受ける', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000, 5000]]);
    const item = order.orderItemIds[0];
    await refund('RF1', item, 0, 3000);
    await refund('reapply:RF1', item, 0, 1000);
    await refund('cover:RF1', item, 0, 500);
    expect(await allocationSum(item, 0)).toBe(4500);
    await refund('release:RF1:1', item, 0, -2000);
    expect(await allocationSum(item, 0)).toBe(2500);
    expect(await failure(() => refund('release:RF1:2', item, 0, -3000))).toEqual(invalid);
    expect(await failure(() => refund('release:ZZ:1', item, 0, -100))).toEqual(invalid);
    expect(await failure(() => refund('release:RF1:1', item, 0, -100))).toEqual({ code: '23505', message: 'DATABASE_ERROR' });
    await refund('release:RF1:2', item, 0, -2500);
    expect(await allocationSum(item, 0)).toBe(0);
    // Shapes that are refused.
    expect(await failure(() => refund('RF1', item, 1, -100))).toEqual(invalid);
    expect(await failure(() => refund('release:RF1:3', item, 1, 100))).toEqual(invalid);
    expect(await failure(() => refund('RF2', item, 1, 0))).toEqual(invalid);
    expect(await failure(() => refund('bad key', item, 1, 100))).toEqual(invalid);
    expect(await failure(() => refund('RF2', item, -1, 100))).toEqual(invalid);
    expect(await failure(() => refund('release:reapply:RF1:1', item, 1, -100))).toEqual(invalid);
    // A shipped unit takes no row, positive or negative.
    await refund('RF3', item, 1, 1000);
    await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    expect((await shippedUnits(db(), item)).map((u) => u.unit)).toEqual([0]);
    expect(await failure(() => refund('RF4', item, 0, 100))).toEqual(invalid);
    expect(await failure(() => refund('release:RF1:9', item, 0, -100))).toEqual(invalid);
    await refund('RF4', item, 2, 100);
  });

  test('FREQ-563-AC-02: 出荷済みの着（accounting_shipped_units）への返金の割り当ては断る', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000]]);
    const item = order.orderItemIds[0];
    const slip = await seedFactSlip(db(), { orderItemId: item, quantity: 2 });
    expect((await shippedUnits(db(), item)).map((u) => u.unit)).toEqual([0, 1]);
    expect(await failure(() => refund('RF1', item, 0, 100))).toEqual(invalid);
    expect(await failure(() => refund('RF1', item, 1, 100))).toEqual(invalid);
    // Cancelling the slip gives the units back: a refund is possible again (design: a cancelled slip's units are not shipped).
    await recordSlipFact(db(), slip, 'cancel');
    expect(await shippedUnits(db(), item)).toEqual([]);
    await refund('RF1', item, 0, 100);
    expect(await allocationSum(item, 0)).toBe(100);
  });

  // ---- which units are shipped (FREQ-563-AC-03) ---------------------------------------------------------------
  test('FREQ-563-AC-03: 出荷済みの着は G の鍵の中で取った番号で決まり、出荷の仕訳が入る前でも後でも同じ着になる（全額の割り当てを受けた着は送る着から除かれ、H の確保は同じトランザクションで書く全額の割り当てを通して除かれ、番号の小さい着から数量ぶん取る）', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000, 5000, 5000]]);
    const item = order.orderItemIds[0];
    const units = async (asOf: number | null = null) => (await shippedUnits(db(), item, asOf)).map((u) => `${u.unit}`);
    const slipA = await seedFactSlip(db(), { orderItemId: item, quantity: 2 });
    const slipB = await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    expect(await shippedUnits(db(), item)).toEqual([{ unit: 0, slipId: slipA }, { unit: 1, slipId: slipA }, { unit: 2, slipId: slipB }]);
    const cA = (await slipFactSeq(db(), slipA, 'confirm')) as number;
    const cB = (await slipFactSeq(db(), slipB, 'confirm')) as number;
    // The same answer before and after a shipment entry exists for the slips.
    const before = await shippedUnits(db(), item);
    const period = await seedAccountingPeriod(db(), { businessType: 'soleProprietor' });
    const day = (await q('select starts_on::text as d from public.accounting_periods where id = $1', [period])).rows[0].d as string;
    const entry = await postJournal(db(), { periodId: period, entryDate: day, kind: 'shipment_confirmed', parts: [`SL-${randomUUID().slice(0, 8)}`],
      lines: [{ account: '2150', debit: 10000 }, { account: '4010', credit: 10000 }] });
    await q('insert into public.accounting_shipment_units (entry_id, order_item_id, unit_index, paid_amount) values ($1, $2, 0, 5000), ($1, $2, 1, 5000)', [entry.entryId, item]);
    expect(await shippedUnits(db(), item)).toEqual(before);
    // Cancel A: B keeps unit 2; C (confirmed after the cancel) takes the freed 0 and 1.
    const xA = await recordSlipFact(db(), slipA, 'cancel');
    expect(await units()).toEqual(['2']);
    const slipC = await seedFactSlip(db(), { orderItemId: item, quantity: 2 });
    const cC = (await slipFactSeq(db(), slipC, 'confirm')) as number;
    expect(await shippedUnits(db(), item)).toEqual([{ unit: 0, slipId: slipC }, { unit: 1, slipId: slipC }, { unit: 2, slipId: slipB }]);
    // The answer for a number does not change with later rows.
    expect(await shippedUnits(db(), item, cA)).toEqual([{ unit: 0, slipId: slipA }, { unit: 1, slipId: slipA }]);
    expect(await shippedUnits(db(), item, cB)).toEqual([{ unit: 0, slipId: slipA }, { unit: 1, slipId: slipA }, { unit: 2, slipId: slipB }]);
    expect(await shippedUnits(db(), item, xA - 1)).toEqual([{ unit: 0, slipId: slipA }, { unit: 1, slipId: slipA }, { unit: 2, slipId: slipB }]);
    expect(await shippedUnits(db(), item, xA)).toEqual([{ unit: 2, slipId: slipB }]);
    expect(await shippedUnits(db(), item, cC)).toEqual([{ unit: 0, slipId: slipC }, { unit: 1, slipId: slipC }, { unit: 2, slipId: slipB }]);
    expect(await shippedUnits(db(), item, 0)).toEqual([]);
    // D takes the last unit; E finds nothing left and takes nothing.
    const slipD = await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    expect((await shippedUnits(db(), item)).filter((u) => u.slipId === slipD)).toEqual([{ unit: 3, slipId: slipD }]);
    const slipE = await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    expect((await shippedUnits(db(), item)).filter((u) => u.slipId === slipE)).toEqual([]);

    // A unit refunded in full before the slip is confirmed is skipped; a partly refunded one is still shipped.
    const second = await seedUnitOrder(db(), [[5000, 5000, 5000]]);
    const other = second.orderItemIds[0];
    await refund('RF-FULL', other, 0, 5000);
    await refund('RF-PART', other, 1, 2000);
    const slipF = await seedFactSlip(db(), { orderItemId: other, quantity: 2 });
    expect(await shippedUnits(db(), other)).toEqual([{ unit: 1, slipId: slipF }, { unit: 2, slipId: slipF }]);
    // Released in full before a later slip: the unit counts again for that slip.
    await refund('release:RF-FULL:1', other, 0, -5000);
    const slipG = await seedFactSlip(db(), { orderItemId: other, quantity: 1 });
    expect((await shippedUnits(db(), other)).filter((u) => u.slipId === slipG)).toEqual([{ unit: 0, slipId: slipG }]);
    // The group H claim is not read (it has no number and no time).
    const source = (await q("select prosrc from pg_catalog.pg_proc where oid = 'private.accounting_shipped_units(uuid,bigint)'::regprocedure")).rows[0].prosrc as string;
    expect(source).not.toMatch(/refund_id|return_line_id|refund_before_shipment|confirmed_at|cancelled_at|created_at|now\(\)/);
    expect(source).toContain("oi.line_kind = 'order'");
  });

  test('FREQ-563-AC-03: 番号はG の鍵を持たない呼び出しでは取れずGROUP_H_LOCK_REQUIRED、確定と取り消しの再送では増えず、拒否された確定では残らない', async () => {
    // (a) No group G lock: a second connection that holds none is refused by all three writers.
    const lockRequired = { code: '55000', message: 'GROUP_H_LOCK_REQUIRED' };
    const bare = await connectLocalDb();
    try {
      await bare.query('begin');
      const refused = async (sql: string, params: unknown[] = []): Promise<Failure> => {
        await bare.query('savepoint t_lock');
        try { await bare.query(sql, params); return null; } catch (caught) {
          const e = caught as { code?: string; message?: string }; return { code: e.code, message: e.message };
        } finally { await bare.query('rollback to savepoint t_lock'); }
      };
      expect(await refused('select * from private.accounting_take_g_fact_seq()')).toEqual(lockRequired);
      expect(await refused("select private.accounting_record_slip_fact($1::uuid, 'confirm')", [randomUUID()])).toEqual(lockRequired);
      expect(await refused("select private.accounting_record_unit_refund('RF', $1::uuid, 0, 100)", [randomUUID()])).toEqual(lockRequired);
      await bare.query('rollback');
    } finally { await bare.end(); }

    // (b) The real group G functions: a replay takes no number, a refusal leaves no row, the first run leaves one.
    const actor = await flow.createActor(['supporter']);
    const today = await flow.today();
    const ready = await seedGroupG3ReadyOrder(db());
    const draft = (await q('select public.admin_save_shipment_slip_draft(null, null, $1::jsonb, $2, $3) as r',
      [JSON.stringify([{ orderItemId: ready.orderItemId, quantity: 4 }]), actor, randomUUID()])).rows[0].r as { id: string; version: number };
    const sequence = async () => (await q('select last_value::text as v, is_called from private.accounting_g_fact_seq')).rows[0];
    const factCount = async () => Number((await q('select count(*) as n from public.accounting_g_slip_facts where slip_id = $1', [draft.id])).rows[0].n);
    const confirm = (key: string, version = draft.version) => q(
      "select public.admin_confirm_shipment_slip($1, $2, 'yamato', 'ab-123', $3::date, false, $4, $5) as r", [draft.id, version, today, actor, key]);
    const cancel = (key: string, version: number) => q('select public.admin_cancel_shipment_slip($1, $2, $3, $4) as r', [draft.id, version, actor, key]);
    expect(await factCount()).toBe(0);
    // A refusal before the stage changes (stale version) leaves nothing.
    const seq0 = await sequence();
    expect(await failure(() => confirm(randomUUID(), 99))).toEqual({ code: '55000', message: 'GROUP_G_SLIP_VERSION_CONFLICT' });
    expect(await factCount()).toBe(0);
    expect(await sequence()).toEqual(seq0);
    const key = randomUUID();
    const confirmed = (await confirm(key)).rows[0].r as { version: number; replayed: boolean };
    expect(confirmed.replayed).toBe(false);
    expect(await factCount()).toBe(1);
    const confirmSeq = (await slipFactSeq(db(), draft.id, 'confirm')) as number;
    const seq1 = await sequence();
    expect((await confirm(key)).rows[0].r.replayed).toBe(true);
    expect(await sequence()).toEqual(seq1);
    expect(await factCount()).toBe(1);
    expect(await failure(() => confirm(randomUUID()))).toEqual({ code: '55000', message: 'GROUP_G_SLIP_NOT_DRAFT' });
    expect(await sequence()).toEqual(seq1);
    // The cancel adds its own fact with a later number; its replay and a second cancel add none.
    const cancelKey = randomUUID();
    expect((await cancel(cancelKey, confirmed.version)).rows[0].r.replayed).toBe(false);
    const cancelSeq = (await slipFactSeq(db(), draft.id, 'cancel')) as number;
    expect(cancelSeq).toBeGreaterThan(confirmSeq);
    const seq2 = await sequence();
    expect((await cancel(cancelKey, confirmed.version)).rows[0].r.replayed).toBe(true);
    expect(await failure(() => cancel(randomUUID(), confirmed.version + 1))).toEqual({ code: '55000', message: 'GROUP_G_SLIP_CANCELLED' });
    expect(await sequence()).toEqual(seq2);
    expect(await factCount()).toBe(2);
    // The second fact of the same (slip, kind) is refused by the primary key.
    expect(await failure(() => recordSlipFact(db(), draft.id, 'confirm'))).toEqual({ code: '23505', message: 'DATABASE_ERROR' });
  });

  test('FREQ-563-AC-03: Stripe の時刻から直した番号は、その時刻までに鍵の中で取った番号の最大', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000, 5000]]);
    const item = order.orderItemIds[0];
    const at = async (instant: string | null) => Number((await q('select private.accounting_g_fact_seq_at($1::timestamptz) as n', [instant])).rows[0].n);
    const wait = () => q('select pg_catalog.pg_sleep(0.05)');
    const now = async () => (await q('select clock_timestamp()::text as t')).rows[0].t as string;
    await wait();
    const slip = await seedBareSlip(db(), { orderItemId: item, quantity: 1 });
    const first = await recordSlipFact(db(), slip, 'confirm');
    await wait();
    const afterFirst = await now();
    await wait();
    await refund('RF-1', item, 1, 100);
    const second = Number((await q('select max(fact_seq) as n from public.accounting_unit_refund_allocations where order_item_id = $1', [item])).rows[0].n);
    await wait();
    const afterSecond = await now();
    expect(second).toBeGreaterThan(first);
    expect(await at(afterFirst)).toBe(first);
    expect(await at(afterSecond)).toBe(second);
    expect(await at('-infinity')).toBe(0);
    expect(await at(null)).toBe(0);
    // A later time never goes below an earlier one.
    expect(await at('infinity')).toBeGreaterThanOrEqual(second);
  });

  test('FREQ-563-AC-03: 着の値打ちは出荷済みでも未出荷でも支払額−番号までの割り当て', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000, 5000]]);
    const item = order.orderItemIds[0];
    const values = async (asOf: number | null = null) => (await q(
      'select unit_index, shipped, value from private.accounting_unit_values($1::uuid, $2::bigint) order by unit_index', [order.orderId, asOf])).rows
      .map((r) => ({ unit: r.unit_index as number, shipped: r.shipped as boolean, value: r.value as number }));
    expect(await values()).toEqual([{ unit: 0, shipped: false, value: 5000 }, { unit: 1, shipped: false, value: 5000 }, { unit: 2, shipped: false, value: 5000 }]);
    await refund('RF-1', item, 0, 2000);
    const beforeSlip = Number((await q('select max(fact_seq) as n from public.accounting_unit_refund_allocations where order_item_id = $1', [item])).rows[0].n);
    const slip = await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    const confirmSeq = (await slipFactSeq(db(), slip, 'confirm')) as number;
    // The partly refunded unit 0 is still the lowest free unit, so it ships with 3000 left.
    expect(await values()).toEqual([{ unit: 0, shipped: true, value: 3000 }, { unit: 1, shipped: false, value: 5000 }, { unit: 2, shipped: false, value: 5000 }]);
    expect(await values(beforeSlip - 1)).toEqual([{ unit: 0, shipped: false, value: 5000 }, { unit: 1, shipped: false, value: 5000 }, { unit: 2, shipped: false, value: 5000 }]);
    expect(await values(beforeSlip)).toEqual([{ unit: 0, shipped: false, value: 3000 }, { unit: 1, shipped: false, value: 5000 }, { unit: 2, shipped: false, value: 5000 }]);
    expect(await values(confirmSeq)).toEqual([{ unit: 0, shipped: true, value: 3000 }, { unit: 1, shipped: false, value: 5000 }, { unit: 2, shipped: false, value: 5000 }]);
    await refund('RF-2', item, 2, 1000);
    await refund('release:RF-2:1', item, 2, -1000);
    expect((await values())[2]).toEqual({ unit: 2, shipped: false, value: 5000 });
    // Another order is not mixed in.
    const other = await seedUnitOrder(db(), [[1000]]);
    expect((await q('select count(*) as n from private.accounting_unit_values($1::uuid, null)', [other.orderId])).rows[0].n).toBe('1');
  });

  test('FREQ-563-AC-03: 支払額0の着は全額返金済みとは見ず、番号の若い着から送り、値打ちは0', async () => {
    // Units paid [0, 1]: a slip of 1 takes unit 0 (the lowest index), and unit 0 is worth 0.
    const order = await seedUnitOrder(db(), [[0, 1]]);
    const item = order.orderItemIds[0];
    const slip = await seedFactSlip(db(), { orderItemId: item, quantity: 1 });
    expect(await shippedUnits(db(), item)).toEqual([{ unit: 0, slipId: slip }]);
    const values = (await q('select unit_index, shipped, value from private.accounting_unit_values($1::uuid, null) order by unit_index', [order.orderId])).rows;
    expect(values).toEqual([{ unit_index: 0, shipped: true, value: 0 }, { unit_index: 1, shipped: false, value: 1 }]);
    // A fully refunded unit with a positive paid amount is still skipped (the rule needs paid_amount > 0 and sum = paid_amount).
    const second = await seedUnitOrder(db(), [[0, 1]]);
    await refund('RF-FULL', second.orderItemIds[0], 1, 1);
    const next = await seedFactSlip(db(), { orderItemId: second.orderItemIds[0], quantity: 2 });
    expect(await shippedUnits(db(), second.orderItemIds[0])).toEqual([{ unit: 0, slipId: next }]);
  });

  test('FREQ-563-AC-03: 交換の品（line_kind=exchange）の着は送った着にも着の値打ちにも出ない', async () => {
    const order = await seedUnitOrder(db(), [[5000, 5000]]);
    const base = order.orderItemIds[0];
    // The foreign key to the return line is not the point here; replica mode skips it for this one insert (CHECKs still apply).
    await q('set local session_replication_role = replica');
    const exchange = (await q(`insert into public.order_items (order_id, item_id, item_name, item_price, quantity, line_total, variant_id,
      fulfillment_type, line_kind, exchange_return_line_id, exchange_paid_amount)
      select oi.order_id, oi.item_id, 'exchange', 0, 2, 0, oi.variant_id, 'backorder', 'exchange', gen_random_uuid(), 3000
      from public.order_items oi where oi.id = $1 returning id`, [base])).rows[0].id as string;
    await q('insert into public.order_line_unit_amounts (order_id, order_item_id, unit_index, paid_amount) values ($1, $2, 0, 3000), ($1, $2, 1, 3000)',
      [order.orderId, exchange]);
    await q('set local session_replication_role = origin');
    const slip = await seedFactSlip(db(), { orderItemId: exchange, quantity: 2 });
    expect(slip).toBeTruthy();
    expect(await shippedUnits(db(), exchange)).toEqual([]);
    const values = (await q('select order_item_id, unit_index from private.accounting_unit_values($1::uuid, null) order by order_item_id, unit_index', [order.orderId])).rows;
    expect(values.map((r) => r.order_item_id)).toEqual([base, base]);
    expect((await q('select count(*) as n from public.order_line_unit_amounts where order_item_id = $1', [exchange])).rows[0].n).toBe('2');
  });

  // ---- the two group G functions (FREQ-563-AC-03) --------------------------------------------------------------
  test('FREQ-563-AC-03: 番号を取る1行を足した確定と取り消しの2本は、囲みを全部除いた本文が最新の定義と同じで、属性とACLが前と同じ', async () => {
    expect(confirmLatest).not.toBe('');
    expect(cancelLatest).not.toBe('');
    const body = async (signature: string) => (await q('select prosrc from pg_catalog.pg_proc where oid = $1::regprocedure', [signature])).rows[0].prosrc as string;
    const stripped = async (signature: string) => (await q(
      `select regexp_replace(regexp_replace(prosrc, '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g') as t
       from pg_catalog.pg_proc where oid = $1::regprocedure`, [signature])).rows[0].t as string;
    expect(await stripped(confirmSignature)).toBe(squash(bodyOf(confirmLatest)));
    expect(await stripped(cancelSignature)).toBe(squash(bodyOf(cancelLatest)));
    // The block is there once, right after the UPDATE that changes the stage, and nothing else differs.
    const confirmBody = await body(confirmSignature);
    const cancelBody = await body(cancelSignature);
    expect(confirmBody.match(/-- ACC_P2_BEGIN/g)).toHaveLength(1);
    expect(cancelBody.match(/-- ACC_P2_BEGIN/g)).toHaveLength(1);
    expect(confirmBody).toMatch(/UPDATE public\.shipment_slips SET stage = 'confirmed'[\s\S]*?RETURNING version INTO v_version;\s*-- ACC_P2_BEGIN\s*PERFORM private\.accounting_record_slip_fact\(_slip_id, 'confirm'\);\s*-- ACC_P2_END/);
    expect(cancelBody).toMatch(/UPDATE public\.shipment_slips SET stage = 'cancelled'[\s\S]*?RETURNING version INTO v_version;\s*-- ACC_P2_BEGIN\s*PERFORM private\.accounting_record_slip_fact\(_slip_id, 'cancel'\);\s*-- ACC_P2_END/);
    // The lock is taken before the line (the first statement that reads is after the lock call).
    expect(confirmBody.indexOf('lock_group_g_shipment_slips(')).toBeLessThan(confirmBody.indexOf('accounting_record_slip_fact'));
    expect(cancelBody.indexOf('lock_group_g_shipment_slips(')).toBeLessThan(cancelBody.indexOf('accounting_record_slip_fact'));
    // Attributes and ACL as G made them: owner, SECURITY DEFINER, search_path, service_role only, one function each.
    for (const [signature, arity] of [[confirmSignature, 8], [cancelSignature, 4]] as const) {
      const row = (await q(`select p.proowner::regrole::text as owner, p.prosecdef, p.proconfig, p.provolatile, p.prorettype::regtype::text as ret,
        p.pronargs, has_function_privilege('service_role', p.oid, 'EXECUTE') as service, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_acl,
        (select count(*) from pg_proc o where o.pronamespace = p.pronamespace and o.proname = p.proname) as same_name
        from pg_catalog.pg_proc p where p.oid = $1::regprocedure`, [signature])).rows[0];
      expect(row).toEqual({ owner: 'postgres', prosecdef: true, proconfig: ['search_path=""'], provolatile: 'v', ret: 'jsonb', pronargs: arity,
        service: true, anon: false, auth: false, public_acl: false, same_name: '1' });
    }
    // The group G writer list still holds both and gained nothing.
    const listed = (await q(`select (private.group_g_writer_allowlist() @> array['${confirmSignature}'::regprocedure, '${cancelSignature}'::regprocedure]) as ok`)).rows[0].ok;
    expect(listed).toBe(true);
  });

  test('FREQ-563-AC-03: 囲みの除き方は、ACC_P2 と別の番号（ACC_P3）の囲みを足した本文も最新の定義と同じと見て、2つの囲みの間の元の文の1字の違いは見逃さない', async () => {
    const strip = async (text: string) => (await q(
      `select regexp_replace(regexp_replace($1::text, '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g') as t`, [text])).rows[0].t as string;
    const original = (await q("select prosrc from pg_catalog.pg_proc where oid = $1::regprocedure", [confirmSignature])).rows[0].prosrc as string;
    const anchor = "  v_previous_change text;\nBEGIN\n";
    expect(original).toContain(anchor);
    const withP3 = original.replace(anchor, `${anchor}  -- ACC_P3_BEGIN\n  PERFORM 1;\n  -- ACC_P3_END\n`);
    expect(withP3).not.toBe(original);
    expect(await strip(withP3)).toBe(await strip(original));
    expect(await strip(withP3)).toBe(squash(bodyOf(confirmLatest)));
    // The same expression in TS (the group G tests use it) gives the same text.
    expect(squash(withP3)).toBe(squash(original));
    // One character of the original text between the two blocks is not hidden by the removal.
    const marker = "IF v_slip.expires_at <= pg_catalog.now() THEN";
    expect(original).toContain(marker);
    const tampered = withP3.replace(marker, "IF v_slip.expires_at < pg_catalog.now() THEN");
    expect(await strip(tampered)).not.toBe(await strip(original));
    expect(squash(tampered)).not.toBe(squash(original));
    // Two blocks with original text between them: the text between is kept, the blocks go.
    const twoBlocks = original.replace(anchor, `${anchor}  -- ACC_P3_BEGIN\n  PERFORM 1;\n  -- ACC_P3_END\n`)
      .replace(marker, `-- ACC_P4_BEGIN\n  PERFORM 2;\n  -- ACC_P4_END\n  ${marker}`);
    expect(await strip(twoBlocks)).toBe(await strip(original));
    const twoBlocksTampered = twoBlocks.replace(marker, "IF v_slip.expires_at < pg_catalog.now() THEN");
    expect(await strip(twoBlocksTampered)).not.toBe(await strip(original));
  });

  // ---- period, recorded_by, ACL, the test tool ---------------------------------------------------------------
  test('FREQ-569-AC-05: 期間の決め方は取引の日を含む期間を探し、個人と法人の両方があればcurrent_business_typeの期間を選ぶ', async () => {
    // Years nobody else uses: a sole year and a corporation term that overlap in 2095 (rows are removed by the rollback).
    const sole = (await q(`insert into public.accounting_periods (business_type, name, starts_on, ends_on)
      values ('soleProprietor', 'sole-2095', '2095-01-01', '2095-12-31') returning id`)).rows[0].id as string;
    const corporation = (await q(`insert into public.accounting_periods (business_type, name, starts_on, ends_on)
      values ('corporation', 'corp-2095', '2095-04-01', '2096-03-31') returning id`)).rows[0].id as string;
    const periodFor = async (day: string) => (await q('select private.accounting_period_for_event($1::date, null) as id', [day])).rows[0].id as string;
    const setType = (type: string) => q('update public.accounting_settings set current_business_type = $1 where id = 1', [type]);
    // current_business_type = individual
    await setType('soleProprietor');
    expect(await periodFor('2095-02-01')).toBe(sole); // only the sole period contains it
    expect(await periodFor('2095-06-01')).toBe(sole); // both contain it: the current type
    expect(await periodFor('2096-02-01')).toBe(corporation); // only the corporation term contains it
    // current_business_type = corporation
    await setType('corporation');
    expect(await periodFor('2095-02-01')).toBe(sole);
    expect(await periodFor('2095-06-01')).toBe(corporation);
    expect(await periodFor('2096-02-01')).toBe(corporation);
    // A corporation with no term on that day stops with the fixed refusal (no period is made).
    expect(await failure(() => periodFor('2099-06-01'))).toEqual({ code: '55000', message: 'ACCOUNTING_PERIOD_MISSING' });
    expect(Number((await q("select count(*) as n from public.accounting_periods where starts_on >= '2097-01-01'")).rows[0].n)).toBe(0);
  });

  test('FREQ-562-AC-01: 記録の人がNULLの自動の計上を受けてrecorded_byがNULLになる', async () => {
    const period = await seedAccountingPeriod(db(), { businessType: 'soleProprietor' });
    const day = (await q('select starts_on::text as d from public.accounting_periods where id = $1', [period])).rows[0].d as string;
    const entry = await postJournal(db(), { periodId: period, entryDate: day, kind: 'payment_confirmed', parts: [`pi_${randomUUID().slice(0, 8)}`],
      lines: [{ account: '1160', debit: 5000 }, { account: '2150', credit: 5000 }] });
    expect(entry.created).toBe(true);
    const row = (await q('select recorded_by from public.accounting_journal_entries where id = $1', [entry.entryId])).rows[0];
    expect(row.recorded_by).toBeNull();
  });

  test('FREQ-569-AC-01: 計上待ちの表はanonとauthenticatedに権限が無くservice_roleはSELECTだけ', async () => {
    for (const table of TABLES) {
      const row = (await q(`select c.relrowsecurity, c.relowner::regrole::text as owner,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select, has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
        has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
        has_table_privilege('service_role', c.oid, 'INSERT') as service_insert, has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
        has_table_privilege('service_role', c.oid, 'DELETE') as service_delete
        from pg_class c where c.oid = to_regclass($1)`, [`public.${table}`])).rows[0];
      expect({ table, ...row }).toEqual({ table, relrowsecurity: true, owner: 'postgres', anon_select: false, auth_select: false,
        service_select: true, service_insert: false, service_update: false, service_delete: false });
    }
    for (const role of ['anon', 'authenticated']) {
      for (const table of TABLES) {
        await q(`set local role ${role}`);
        const result = await failure(() => q(`select 1 from public.${table} limit 1`));
        await q('reset role');
        expect({ role, table, result }).toEqual({ role, table, result: { code: '42501', message: 'DATABASE_ERROR' } });
      }
    }
    await q('set local role service_role');
    for (const table of TABLES) await q(`select 1 from public.${table} limit 1`);
    const denied = await failure(() => q(`insert into public.accounting_g_slip_facts (slip_id, kind, fact_seq, locked_at) values ('${randomUUID()}', 'confirm', 1, now())`));
    await q('reset role');
    expect(denied).toEqual({ code: '42501', message: 'DATABASE_ERROR' });
  });

  test('FREQ-569-AC-03: 読み口と書き口はservice_roleだけが呼べ、anonとauthenticatedと道具の関数は呼べない', async () => {
    const admin = await insertAccountingAdmin(db());
    const id = sid();
    await park('payment_confirmed', 'orders', id, null, 'before_cutover');
    const event = await pending(id);
    const calls = [
      'select public.list_accounting_pending_events()',
      'select public.get_accounting_pending_summary()',
      `select public.admin_resolve_accounting_pending_event('${admin}', '${event.id}', 'x', '${randomUUID()}')`,
    ];
    for (const role of ['anon', 'authenticated']) {
      for (const call of calls) {
        await q(`set local role ${role}`);
        const result = await failure(() => q(call));
        await q('reset role');
        expect({ role, call, result }).toEqual({ role, call, result: { code: '42501', message: 'DATABASE_ERROR' } });
      }
    }
    await q('set local role service_role');
    expect((await q(calls[0])).rows).toHaveLength(1);
    expect((await q(calls[1])).rows).toHaveLength(1);
    expect((await q(calls[2])).rows[0]).toBeDefined();
    // The tools have no entry point, not even for service_role.
    for (const tool of [
      "select private.accounting_park_event('payment_confirmed', 'orders', 'x', null, 'no_order', '{}')",
      "select private.accounting_unpark_event('payment_confirmed', 'orders', 'x', null)",
      'select * from private.accounting_take_g_fact_seq()',
      'select private.accounting_allocate_amount(1, array[1]::bigint[])',
      'select private.accounting_cutover_on()',
      'select * from private.accounting_shipped_units(gen_random_uuid(), null)',
      'select private.accounting_g_fact_seq_at(now())',
    ]) {
      const result = await failure(() => q(tool));
      expect({ tool, result }).toEqual({ tool, result: { code: '42501', message: 'DATABASE_ERROR' } });
    }
    await q('reset role');
    expect((await q('select private.accounting_cutover_on()::text as d')).rows[0].d).toBe(
      (await q('select cutover_on::text as d from public.accounting_settings where id = 1')).rows[0].d);
  });

  test('FREQ-569-AC-01: 試験の道具 setCutoverForTest は日を動かし、設定の守りは終わりの後に有効へ戻る', async () => {
    const original = (await q('select cutover_on::text as d from public.accounting_settings where id = 1')).rows[0].d as string;
    await setCutoverForTest(db(), '2020-01-01');
    expect((await q('select private.accounting_cutover_on()::text as d')).rows[0].d).toBe('2020-01-01');
    const trigger = (await q(`select tgenabled::text as enabled from pg_trigger where tgrelid = 'public.accounting_settings'::regclass
      and tgname = 'accounting_settings_guard_update'`)).rows[0];
    expect(trigger.enabled).toBe('A');
    expect(await failure(() => q("update public.accounting_settings set cutover_on = '2021-01-01' where id = 1")))
      .toEqual({ code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' });
    expect(original).not.toBe('2020-01-01');
    await expect(setCutoverForTest(db(), '2020-1-1')).rejects.toThrow('ACCOUNTING_CUTOVER_DATE_INVALID');
    expect(japanToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('FREQ-569-AC-01: 試験の道具で動かした日は ROLLBACK で元に戻る', async () => {
    const row = (await q('select cutover_on::text as d from public.accounting_settings where id = 1')).rows[0];
    expect(row.d).not.toBe('2020-01-01');
  });
});

// The concurrency test commits rows into the local database (the accounting_* rows cannot be removed): reset it afterwards.
// Run it on its own (the controller): db reset, ACCOUNTING_COMMIT_SUITE=1 ... npx jest <this file> --runInBand -t concurrency, db reset.
const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';
describeLocalDb('S6 fact numbers under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }
  const order = async (client: PgClient) => {
    await client.query('begin');
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const seeded = await seedUnitOrder(client, [[5000, 5000, 5000]]);
    const first = await seedBareSlip(client, { orderItemId: seeded.orderItemIds[0], quantity: 1 });
    const second = await seedBareSlip(client, { orderItemId: seeded.orderItemIds[0], quantity: 2 });
    await client.query('commit');
    return { item: seeded.orderItemIds[0], first, second };
  };

  test.each([1, 2, 3])('FREQ-563-AC-03: 確定のトランザクションが先に始まっても鍵を後に取った発送票は後に数え、確定の時刻（now()）の順と鍵の順が入れ替わっても2つの発送票の取る着が重ならず、ある番号の答えは後からコミットした行で変わらない（%i回目）', async () => {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    try {
      const { item, first, second } = await order(setup);
      // A starts first (an earlier now()), B second; B takes the group G lock first and wins the lower number.
      await a.query('begin');
      const startedA = (await a.query('select now() as t')).rows[0].t as Date;
      await b.query('begin');
      const startedB = (await b.query('select now() as t')).rows[0].t as Date;
      expect(startedA.getTime()).toBeLessThan(startedB.getTime());
      await b.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const seqB = Number((await b.query("select private.accounting_record_slip_fact($1::uuid, 'confirm') as s", [second])).rows[0].s);
      // A asks for the lock now and waits for B.
      const waiting = a.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      let settled = false;
      void waiting.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await b.query('commit');
      await waiting;
      const seqA = Number((await a.query("select private.accounting_record_slip_fact($1::uuid, 'confirm') as s", [first])).rows[0].s);
      expect(seqA).toBeGreaterThan(seqB);
      // Before A commits, the answer for B's number is B's slip alone; after A commits it is the same.
      const answer = async (client: PgClient, asOf: number | null) => (await client.query(
        'select unit_index, slip_id from private.accounting_shipped_units($1::uuid, $2::bigint) order by unit_index', [item, asOf])).rows;
      const beforeCommit = await answer(setup, seqB);
      expect(beforeCommit).toEqual([{ unit_index: 0, slip_id: second }, { unit_index: 1, slip_id: second }]);
      await a.query('commit');
      expect(await answer(setup, seqB)).toEqual(beforeCommit);
      // Now: B's slip has the lowest units although its transaction started later; A's slip takes the next one.
      expect(await answer(setup, null)).toEqual([{ unit_index: 0, slip_id: second }, { unit_index: 1, slip_id: second }, { unit_index: 2, slip_id: first }]);
      expect(await answer(setup, seqA)).toEqual(await answer(setup, null));
    } finally {
      for (const client of [a, b]) await client.query('rollback').catch(() => undefined);
      await Promise.all([setup.end(), a.end(), b.end()]);
    }
  });
});
