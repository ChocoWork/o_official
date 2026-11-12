/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { seedDispute, seedPaidOrder } from './helpers/accounting-orders-fixtures';
import {
  S15_APPEND_ONLY, S15_TABLES, insertRow, restorePreS17Bodies, seedReturnRefundParents, takeFactSeq, type ReturnRefundParents,
} from './helpers/accounting-returns-fixtures';
import { PENDING_REASONS } from '@/lib/accounting/posting-types';
import { REFUND_EVENT_STATES } from '@/lib/accounting/return-refund-types';

// Accounting plan 3 Task 1 (FREQ-575 / 576 / 569 / 580): the return and refund fact tables, the arrival date of a
// receipt, the return options, the two new parked reasons, the detail allowlist and the dispute-hold tools. ROLLBACK form
// (run with --runInBand). The rows are written directly as postgres: the writers come in Task 3 and Task 4.
jest.setTimeout(120000);

type Failure = { code?: string; message?: string } | null;
const RECEIPT_COLUMNS_BEFORE = 'id uuid not null default gen_random_uuid(), return_id uuid not null, request_key uuid not null, '
  + 'request_fingerprint text not null, kind text not null, refund_choice text, refund_id uuid, notify_customer boolean not null default false, '
  + 'sent_back_message text, sent_back_carrier text, sent_back_tracking_number text, note text, actor_id uuid, actor_can_refund boolean, '
  + 'created_at timestamp with time zone not null default now(), consult_quantity integer, restocking_fee_waived boolean not null default false';

describeLocalDb('S15 return and refund tables: controller only', (db) => {
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
  const checkFailed = { code: '23514', message: 'DATABASE_ERROR' };
  const duplicate = { code: '23505', message: 'DATABASE_ERROR' };
  const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
  const immutable = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };

  const refundEvent = async (p: ReturnRefundParents, over: Record<string, unknown> = {}) =>
    insertRow(db(), 'accounting_refund_events', { refund_id: p.refundIds[0], order_id: p.orderId, seq: 1, state: 'requested',
      fact_seq: (await takeFactSeq(db())).seq, ...over });
  const refundFact = (p: ReturnRefundParents, over: Record<string, unknown> = {}) =>
    insertRow(db(), 'accounting_refund_facts', { refund_id: p.refundIds[0], order_id: p.orderId, source: 'admin',
      pre_shipment_amount: 0, post_shipment_amount: 1000, shipping_amount: 0, ...over });
  const returnFact = (p: ReturnRefundParents, over: Record<string, unknown> = {}) =>
    insertRow(db(), 'accounting_return_facts', { return_id: p.returnId, order_id: p.orderId, seq: 1, kind: 'arrival',
      receipt_id: p.receiptId, goods_amount: 1000, fee_amount: 100, ...over });
  const correction = (p: ReturnRefundParents, over: Record<string, unknown> = {}) =>
    insertRow(db(), 'order_return_arrival_corrections', { receipt_id: p.receiptId, version: 1, previous_on: '2026-11-10',
      new_on: '2026-11-09', reason: '届いた日の記録の誤り', actor_id: randomUUID(), request_key: randomUUID(), request_hash: 'h', ...over });
  const transferAdjust = async (p: ReturnRefundParents, over: Record<string, unknown> = {}) => {
    const n = await takeFactSeq(db());
    return insertRow(db(), 'accounting_refund_transfer_adjusts', { event_id: p.eventId, adjust_key: p.eventId, order_item_id: p.itemId,
      unit_index: 0, amount: -100, fact_seq: n.seq, locked_at: n.at, ...over });
  };
  const priceAdjust = async (p: ReturnRefundParents, over: Record<string, unknown> = {}) => {
    const n = await takeFactSeq(db());
    return insertRow(db(), 'accounting_unit_price_adjusts', { order_item_id: p.itemId, unit_index: 1, adjust_key: p.eventId,
      event_id: p.eventId, amount: 100, fact_seq: n.seq, locked_at: n.at, ...over });
  };
  // The rows here are written by hand to check the shapes, so the parents are seeded with the refund functions of before
  // S17 (Task 3), which write no refund event, fact or allocation (put back inside this test's transaction; the rollback
  // restores S17). The receive of S18 (Task 4) writes the arrival fact of the return, which is taken out again here so
  // the hand-written rows start from an empty return (the rollback restores the row and the trigger).
  const seedWithoutWriters = async () => {
    await restorePreS17Bodies(db(), ['core', 'groupGResult']);
    const parents = await seedReturnRefundParents(db());
    await q('alter table public.accounting_return_facts disable trigger accounting_return_facts_no_update_delete');
    await q('delete from public.accounting_return_facts where return_id = $1', [parents.returnId]);
    await q('alter table public.accounting_return_facts enable always trigger accounting_return_facts_no_update_delete');
    return parents;
  };
  const sid = () => `src_${randomUUID().slice(0, 8)}`;
  const park = (reason: string, detail: unknown = {}) =>
    q('select private.accounting_park_event($1, $2, $3, $4::uuid, $5, $6::jsonb)',
      ['return_refund', 'order_refunds', sid(), null, reason, JSON.stringify(detail)]);

  // ---- permissions and append only (FREQ-576-AC-04) ----------------------------------------------------------------
  test('FREQ-576-AC-04: 7つの表はanonとauthenticatedに権限が無くservice_roleはSELECTだけ', async () => {
    expect(S15_TABLES).toHaveLength(7);
    for (const table of S15_TABLES) {
      const row = (await q(`select c.relrowsecurity, c.relowner::regrole::text as owner,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select, has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
        has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
        has_table_privilege('service_role', c.oid, 'INSERT') as service_insert, has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
        has_table_privilege('service_role', c.oid, 'DELETE') as service_delete
        from pg_class c where c.oid = to_regclass($1)`, [`public.${table}`])).rows[0];
      expect({ table, ...row }).toEqual({ table, relrowsecurity: true, owner: 'postgres', policies: 0, anon_select: false, auth_select: false,
        service_select: true, service_insert: false, service_update: false, service_delete: false });
    }
    for (const role of ['anon', 'authenticated']) {
      for (const table of S15_TABLES) {
        await q(`set local role ${role}`);
        const result = await failure(() => q(`select 1 from public.${table} limit 1`));
        await q('reset role');
        expect({ role, table, result }).toEqual({ role, table, result: { code: '42501', message: 'DATABASE_ERROR' } });
      }
    }
    await q('set local role service_role');
    for (const table of S15_TABLES) await q(`select 1 from public.${table} limit 1`);
    const denied = await failure(() => q('update public.accounting_return_options set use_carrier_delivery_date = true'));
    await q('reset role');
    expect(denied).toEqual({ code: '42501', message: 'DATABASE_ERROR' });
  });

  test('FREQ-576-AC-04: 履歴と事実と直しの差と値段の直しの表はUPDATEとDELETEとTRUNCATEを断る', async () => {
    // Counted against the rows already there: the S17 concurrency suite (Task 3) commits rows that cannot be removed.
    const before = new Map<string, number>();
    for (const table of S15_APPEND_ONLY) before.set(table, (await q(`select count(*)::int as n from public.${table}`)).rows[0].n as number);
    const p = await seedWithoutWriters();
    await correction(p);
    await refundEvent(p);
    await refundFact(p);
    await transferAdjust(p);
    await priceAdjust(p);
    await returnFact(p);
    await q('set constraints all immediate');
    expect(S15_APPEND_ONLY).toHaveLength(6);
    // Where the role may switch to replica mode (postgres on Supabase), the rewrite is still refused (ENABLE ALWAYS).
    const canReplica = (await failure(() => q("set local session_replication_role = 'replica'"))) === null;
    for (const table of S15_APPEND_ONLY) {
      const column = table === 'accounting_refund_events' ? 'occurred_at' : 'created_at';
      expect((await q(`select count(*)::int as n from public.${table}`)).rows[0].n).toBe((before.get(table) ?? 0) + 1);
      expect({ table, result: await failure(() => q(`update public.${table} set ${column} = ${column}`)) }).toEqual({ table, result: immutable });
      expect({ table, result: await failure(() => q(`delete from public.${table}`)) }).toEqual({ table, result: immutable });
      expect({ table, result: await failure(() => q(`truncate public.${table}`)) }).toEqual({ table, result: immutable });
      if (canReplica) {
        const replica = await failure(async () => {
          await q("set local session_replication_role = 'replica'");
          await q(`delete from public.${table}`);
        });
        expect({ table, replica }).toEqual({ table, replica: immutable });
      }
    }
    // The options row is a setting: the owner may change it (the writer comes in Task 4).
    await q('update public.accounting_return_options set use_carrier_delivery_date = true, version = version + 1');
    expect((await q('select use_carrier_delivery_date from public.accounting_return_options')).rows[0].use_carrier_delivery_date).toBe(true);
  });

  // ---- refund states (FREQ-576-AC-01) ------------------------------------------------------------------------------
  test('FREQ-576-AC-01: 返金の状態は同じ返金に同じ状態を2行入れられず、abandonedとowedは理由・人・要求番号が無いと入らない', async () => {
    const p = await seedWithoutWriters();
    let seq = 1;
    for (const state of ['requested', 'accepted', 'succeeded', 'failed', 'canceled', 'error', 'settled']) {
      await refundEvent(p, { seq: seq++, state, stripe_status: state === 'succeeded' ? 'succeeded' : null });
    }
    // The same state twice, and the same seq twice, are refused.
    expect(await failure(() => refundEvent(p, { seq: 99, state: 'failed' }))).toEqual(duplicate);
    expect(await failure(() => refundEvent(p, { seq: 1, state: 'abandoned', reason: 'x', actor_id: randomUUID(), request_key: randomUUID() })))
      .toEqual(duplicate);
    // A state outside the nine is refused.
    expect(await failure(() => refundEvent(p, { seq: 50, state: 'refunded' }))).toEqual(checkFailed);
    // abandoned / owed need the reason, the person and the request key; the other states may not carry all three.
    const decided = { reason: '店が返金をやめた', actor_id: randomUUID(), request_key: randomUUID(), request_hash: 'h' };
    for (const missing of ['reason', 'actor_id', 'request_key']) {
      for (const state of ['abandoned', 'owed']) {
        expect({ state, missing, result: await failure(() => refundEvent(p, { seq: 60, state, ...decided, [missing]: null })) })
          .toEqual({ state, missing, result: checkFailed });
      }
    }
    expect(await failure(() => refundEvent(p, { seq: 61, refund_id: p.refundIds[1], state: 'canceled', ...decided }))).toEqual(checkFailed);
    // release_shortfall and carried_adjust belong to abandoned only.
    expect(await failure(() => refundEvent(p, { seq: 62, refund_id: p.refundIds[1], state: 'owed', ...decided, release_shortfall: 10 }))).toEqual(checkFailed);
    expect(await failure(() => refundEvent(p, { seq: 63, refund_id: p.refundIds[1], state: 'owed', ...decided, carried_adjust: 10 }))).toEqual(checkFailed);
    // The same request key twice is refused.
    await refundEvent(p, { seq: 70, state: 'abandoned', ...decided, release_shortfall: 30, carried_adjust: -20 });
    expect(await failure(() => refundEvent(p, { seq: 1, refund_id: p.refundIds[1], state: 'owed', ...decided, reason: 'y' }))).toEqual(duplicate);
    await refundEvent(p, { seq: 1, refund_id: p.refundIds[1], state: 'owed', ...decided, request_key: randomUUID() });
    // A reason longer than 500 characters, a Stripe status longer than 64 and a seq below 1 are refused.
    expect(await failure(() => refundEvent(p, { seq: 2, refund_id: p.refundIds[1], state: 'abandoned', ...decided,
      request_key: randomUUID(), reason: 'x'.repeat(501) }))).toEqual(checkFailed);
    expect(await failure(() => refundEvent(p, { seq: 2, refund_id: p.refundIds[1], state: 'failed', stripe_status: 'x'.repeat(65) }))).toEqual(checkFailed);
    expect(await failure(() => refundEvent(p, { seq: 0, refund_id: p.refundIds[1], state: 'failed' }))).toEqual(checkFailed);
    // The nine states of the CHECK are the TS list.
    const def = (await q(`select pg_get_constraintdef(oid) as d from pg_constraint
      where conrelid = 'public.accounting_refund_events'::regclass and conname = 'accounting_refund_events_state_check'`)).rows[0].d as string;
    expect([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])).toEqual([...REFUND_EVENT_STATES]);
  });

  // ---- refund facts (FREQ-576-AC-02) -------------------------------------------------------------------------------
  test('FREQ-576-AC-02: 返金の事実は返金1件に1行で、返品の返金は出荷前の額が0', async () => {
    const p = await seedWithoutWriters();
    await refundFact(p, { source: 'return', return_id: p.returnId, event_id: p.eventId, event_kind: 'return_receipt' });
    expect(await failure(() => refundFact(p))).toEqual(duplicate);
    const other = { refund_id: p.refundIds[1] };
    // A return refund has its return and no pre-shipment amount; only a return refund has a return.
    expect(await failure(() => refundFact(p, { ...other, source: 'return', return_id: p.returnId, pre_shipment_amount: 1 }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, source: 'return', return_id: null }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, source: 'admin', return_id: p.returnId }))).toEqual(checkFailed);
    // The event link: none has no event, any other kind has one; the fee belongs to holdback_release, which has no
    // pre-shipment amount.
    expect(await failure(() => refundFact(p, { ...other, event_id: p.eventId }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, event_kind: 'pre_shipment_cancel' }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, event_kind: 'other_kind', event_id: p.eventId }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, fee_amount: 100 }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, event_kind: 'pre_shipment_cancel', event_id: p.eventId, fee_amount: 100 }))).toEqual(checkFailed);
    expect(await failure(() => refundFact(p, { ...other, source: 'unit_hold_release', event_kind: 'holdback_release', event_id: p.eventId,
      pre_shipment_amount: 1 }))).toEqual(checkFailed);
    for (const column of ['pre_shipment_amount', 'post_shipment_amount', 'shipping_amount', 'fee_amount']) {
      expect({ column, result: await failure(() => refundFact(p, { ...other, [column]: -1 })) }).toEqual({ column, result: checkFailed });
    }
    // The refund of what an earlier order held back: no return, the event and its fee.
    await refundFact(p, { ...other, source: 'unit_hold_release', event_kind: 'holdback_release', event_id: p.eventId, fee_amount: 300,
      post_shipment_amount: 700 });
    const rows = (await q(`select refund_id, source, return_id, event_kind, fee_amount, pre_shipment_amount from public.accounting_refund_facts
      where refund_id = any($1::uuid[]) order by source`, [p.refundIds])).rows;
    expect(rows).toEqual([
      { refund_id: p.refundIds[0], source: 'return', return_id: p.returnId, event_kind: 'return_receipt', fee_amount: 0, pre_shipment_amount: 0 },
      { refund_id: p.refundIds[1], source: 'unit_hold_release', return_id: null, event_kind: 'holdback_release', fee_amount: 300, pre_shipment_amount: 0 },
    ]);
  });

  test('FREQ-576-AC-02: 直しの差と値段の直しの表は着の行と出来事に結び付き、額0と形の違う鍵と同じ番号を断る', async () => {
    const p = await seedWithoutWriters();
    await transferAdjust(p);
    await transferAdjust(p, { adjust_key: `release:${p.eventId}:1`, amount: 100 });
    expect(await failure(() => transferAdjust(p))).toEqual(duplicate);
    expect(await failure(() => transferAdjust(p, { adjust_key: 'k0', amount: 0 }))).toEqual(checkFailed);
    expect(await failure(() => transferAdjust(p, { adjust_key: 'bad key' }))).toEqual(checkFailed);
    expect(await failure(() => transferAdjust(p, { adjust_key: 'x'.repeat(201) }))).toEqual(checkFailed);
    expect(await failure(() => transferAdjust(p, { adjust_key: 'k1', unit_index: 9 }))).toEqual({ code: '23503', message: 'DATABASE_ERROR' });
    expect(await failure(() => transferAdjust(p, { adjust_key: 'k2', event_id: randomUUID() }))).toEqual({ code: '23503', message: 'DATABASE_ERROR' });
    await priceAdjust(p);
    expect(await failure(() => priceAdjust(p))).toEqual(duplicate);
    expect(await failure(() => priceAdjust(p, { adjust_key: 'k0', amount: 0 }))).toEqual(checkFailed);
    expect(await failure(() => priceAdjust(p, { adjust_key: 'a/b' }))).toEqual(checkFailed);
    expect(await failure(() => priceAdjust(p, { adjust_key: 'k1', unit_index: 9 }))).toEqual({ code: '23503', message: 'DATABASE_ERROR' });
    // One number of the G lock is used once in each table.
    const used = (await q('select fact_seq from public.accounting_unit_price_adjusts')).rows[0].fact_seq as string;
    expect(await failure(() => priceAdjust(p, { adjust_key: 'k3', fact_seq: used }))).toEqual(duplicate);
  });

  // ---- return facts (FREQ-576-AC-03) -------------------------------------------------------------------------------
  test('FREQ-576-AC-03: 返品の事実は届いた日の行と決定の行の形を守り、同じ受け取り・同じ返金に2行入らない。返金を0円で終える決定は返金が無く受け取りの行に結び付き、額0だけが許される', async () => {
    const p = await seedWithoutWriters();
    const [refund, other] = p.refundIds;
    // The arrival: a receipt, no refund, the goods at least the fee.
    await returnFact(p);
    expect(await failure(() => returnFact(p, { seq: 2 }))).toEqual(duplicate);
    expect(await failure(() => returnFact(p, { seq: 2, receipt_id: null }))).toEqual(checkFailed);
    expect(await failure(() => returnFact(p, { seq: 2, refund_id: refund }))).toEqual(checkFailed);
    expect(await failure(() => returnFact(p, { seq: 2, goods_amount: 99, fee_amount: 100 }))).toEqual(checkFailed);
    expect(await failure(() => returnFact(p, { seq: 2, kind: 'other' }))).toEqual(checkFailed);
    // The decision that starts a refund: the refund, the decided amount and day; once per refund.
    const decision = { kind: 'decision', receipt_id: null, goods_amount: 0, fee_amount: 0, covers_amount: 900, decided_amount: 900,
      payable_delta: 0, decided_on: '2026-11-10' };
    await returnFact(p, { ...decision, seq: 2, refund_id: refund });
    expect(await failure(() => returnFact(p, { ...decision, seq: 3, refund_id: refund }))).toEqual(duplicate);
    expect(await failure(() => returnFact(p, { ...decision, seq: 3, refund_id: other, decided_amount: null }))).toEqual(checkFailed);
    expect(await failure(() => returnFact(p, { ...decision, seq: 3, refund_id: other, decided_on: null }))).toEqual(checkFailed);
    // The receive path names its receipt with the refund.
    await returnFact(p, { ...decision, seq: 3, refund_id: other, receipt_id: p.receiptId, payable_delta: -100 });
    // The decision that ends with 0 yen: no refund, a receipt, the decided amount 0 (and no goods amount).
    const waived = { ...decision, refund_id: null, covers_amount: 900, fee_amount: 100, decided_amount: 0 };
    expect(await failure(() => returnFact(p, { ...waived, seq: 4, receipt_id: null }))).toEqual(checkFailed);
    expect(await failure(() => returnFact(p, { ...waived, seq: 4, receipt_id: p.receiptId, decided_amount: 100 }))).toEqual(checkFailed);
    expect(await failure(() => returnFact(p, { ...waived, seq: 4, receipt_id: p.receiptId, goods_amount: 100 }))).toEqual(checkFailed);
    // A second decision of the same receipt is refused (here the receipt already started the refund above).
    expect(await failure(() => returnFact(p, { ...waived, seq: 4, receipt_id: p.receiptId }))).toEqual(duplicate);
    for (const column of ['goods_amount', 'fee_amount', 'covers_amount', 'decided_amount']) {
      expect({ column, result: await failure(() => returnFact(p, { ...decision, seq: 9, refund_id: randomUUID(), [column]: -1 })) })
        .toEqual({ column, result: checkFailed });
    }
    expect(await failure(() => returnFact(p, { ...decision, seq: 0, refund_id: randomUUID() }))).toEqual(checkFailed);
    // Only this return: suites that commit (the G and S18 concurrency suites) leave the arrival facts of their own returns.
    expect((await q('select kind, seq from public.accounting_return_facts where return_id = $1 order by seq', [p.returnId])).rows)
      .toEqual([{ kind: 'arrival', seq: 1 }, { kind: 'decision', seq: 2 }, { kind: 'decision', seq: 3 }]);
  });

  test('FREQ-576-AC-03: 返金を0円で終える決定は受け取り1件に1回だけ入る', async () => {
    const p = await seedWithoutWriters();
    const waived = { kind: 'decision', receipt_id: p.receiptId, refund_id: null, goods_amount: 0, fee_amount: 100, covers_amount: 900,
      decided_amount: 0, decided_on: '2026-11-10' };
    await returnFact(p, { ...waived, seq: 1 });
    expect(await failure(() => returnFact(p, { ...waived, seq: 2 }))).toEqual(duplicate);
    // The arrival of the same receipt is another kind and still goes in.
    await returnFact(p, { seq: 2 });
  });

  // ---- the arrival date (FREQ-575) ---------------------------------------------------------------------------------
  test('FREQ-575-AC-01: 受け取りの行の届いた日は何も渡さなければ記録した日（日本時間）になる', async () => {
    const column = (await q(`select format_type(a.atttypid, a.atttypmod) as type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as def
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.order_return_receipts'::regclass and a.attname = 'arrived_on' and not a.attisdropped`)).rows[0];
    expect(column).toEqual({ type: 'date', attnotnull: true, def: "((now() AT TIME ZONE 'Asia/Tokyo'::text))::date" });
    // A receipt written without the date gets the day of the recording in Japan.
    const p = await seedWithoutWriters();
    const row = (await q(`select r.arrived_on::text as arrived_on, ((now() at time zone 'Asia/Tokyo')::date)::text as today
      from public.order_return_receipts r where r.id = $1`, [p.receiptId])).rows[0];
    expect(row.arrived_on).toBe(row.today);
    // The day of Japan: 2026-12-31T23:00Z is 1 January 08:00 in Japan; one second before Japan's midnight stays on 31 December.
    const at = async (instant: string) => (await q(`select ((($1::timestamptz) at time zone 'Asia/Tokyo')::date)::text as expr,
      private.accounting_jst_date($1::timestamptz)::text as tool`, [instant])).rows[0];
    expect(await at('2026-12-31T23:00:00Z')).toEqual({ expr: '2027-01-01', tool: '2027-01-01' });
    expect(await at('2026-12-31T14:59:59Z')).toEqual({ expr: '2026-12-31', tool: '2026-12-31' });
  });

  test('FREQ-575-AC-01: 受け取りの行の既存の列は変わらず、UPDATEは今も断られる', async () => {
    const columns = (await q(`select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        || case when a.attnotnull then ' not null' else '' end || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''), ', ' order by a.attnum) as c
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.order_return_receipts'::regclass and a.attnum > 0 and not a.attisdropped`)).rows[0].c as string;
    expect(columns).toBe(`${RECEIPT_COLUMNS_BEFORE}, arrived_on date not null default ((now() AT TIME ZONE 'Asia/Tokyo'::text))::date`);
    const p = await seedWithoutWriters();
    const appendOnly = { code: '23514', message: 'ORDER_RETURN_APPEND_ONLY' };
    expect(await failure(() => q("update public.order_return_receipts set arrived_on = '2026-01-01' where id = $1", [p.receiptId]))).toEqual(appendOnly);
    expect(await failure(() => q('delete from public.order_return_receipts where id = $1', [p.receiptId]))).toEqual(appendOnly);
    // The column has no grant of its own: service_role reads it with the table, anon and authenticated do not.
    expect((await q(`select has_column_privilege('service_role', 'public.order_return_receipts', 'arrived_on', 'SELECT') as service,
      has_column_privilege('anon', 'public.order_return_receipts', 'arrived_on', 'SELECT') as anon,
      has_column_privilege('authenticated', 'public.order_return_receipts', 'arrived_on', 'SELECT') as auth`)).rows[0])
      .toEqual({ service: true, anon: false, auth: false });
  });

  test('FREQ-575-AC-02: 届いた日の直しは版ごとに1行で、前の日と同じ日は入らない', async () => {
    const p = await seedWithoutWriters();
    await correction(p);
    await correction(p, { version: 2, previous_on: '2026-11-09', new_on: '2026-11-08' });
    expect(await failure(() => correction(p, { version: 2, previous_on: '2026-11-08', new_on: '2026-11-07' }))).toEqual(duplicate);
    expect(await failure(() => correction(p, { version: 3, previous_on: '2026-11-08', new_on: '2026-11-08' }))).toEqual(checkFailed);
    expect(await failure(() => correction(p, { version: 0 }))).toEqual(checkFailed);
    expect(await failure(() => correction(p, { version: 3, reason: '' }))).toEqual(checkFailed);
    expect(await failure(() => correction(p, { version: 3, reason: 'x'.repeat(501) }))).toEqual(checkFailed);
    for (const column of ['previous_on', 'new_on', 'reason', 'actor_id', 'request_key', 'request_hash']) {
      expect({ column, result: await failure(() => correction(p, { version: 3, [column]: null })) })
        .toEqual({ column, result: { code: '23502', message: 'DATABASE_ERROR' } });
    }
    const key = randomUUID();
    await correction(p, { version: 3, previous_on: '2026-11-08', new_on: '2026-11-07', request_key: key });
    expect(await failure(() => correction(p, { version: 4, previous_on: '2026-11-07', new_on: '2026-11-06', request_key: key }))).toEqual(duplicate);
    expect(await failure(() => correction(p, { version: 4, receipt_id: randomUUID() }))).toEqual({ code: '23503', message: 'DATABASE_ERROR' });
    expect((await q('select version from public.order_return_arrival_corrections where receipt_id = $1 order by version', [p.receiptId])).rows
      .map((r) => r.version)).toEqual([1, 2, 3]);
  });

  test('FREQ-575-AC-04: 配達日を使う設定は1行だけあり、既定はオフ', async () => {
    const rows = (await q('select * from public.accounting_return_options')).rows;
    expect(rows).toEqual([{ id: true, use_carrier_delivery_date: false, changed_at: null, changed_by: null, version: '1', admin_requests: {} }]);
    expect(await failure(() => q('insert into public.accounting_return_options (id) values (false)'))).toEqual(checkFailed);
    expect(await failure(() => q('insert into public.accounting_return_options default values'))).toEqual(duplicate);
  });

  // ---- parked reasons and details (FREQ-569-AC-01) -----------------------------------------------------------------
  test('FREQ-569-AC-01: 計上待ちの理由に refund_prior_unposted と refund_cancel_undecided が通る', async () => {
    expect(PENDING_REASONS).toEqual(expect.arrayContaining(['refund_prior_unposted', 'refund_cancel_undecided']));
    await park('refund_prior_unposted');
    await park('refund_cancel_undecided');
    expect((await q("select reason from public.accounting_pending_events where source_id like 'src_%' order by reason")).rows.map((r) => r.reason))
      .toEqual(['refund_cancel_undecided', 'refund_prior_unposted']);
    expect(await failure(() => park('refund_unknown'))).toEqual(checkFailed);
  });

  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const VALID_DETAILS: Array<[string, Record<string, unknown>]> = [
    ['amount_mismatch', { mismatch: 'split' }],
    ['amount_mismatch', { mismatch: 'refund_amount' }],
    ['amount_mismatch', { mismatch: 'allocation_overflow' }],
    ['amount_mismatch', { mismatch: 'unit_value_left' }],
    ['amount_mismatch', { stripe_amount: 18750, order_total: 18000, mismatch: 'split' }],
    ['amount_mismatch', { stripe_amount: 18750, order_total: 18000 }],
    ['refund_prior_unposted', { why: 'return_prior' }],
    ['refund_prior_unposted', { why: 'original' }],
    ['refund_prior_unposted', { why: 'failure_txn_missing' }],
    ['refund_prior_unposted', {}],
    ['refund_cancel_undecided', { refund_id: uuid, canceled_on: '2026-11-10' }],
    ['refund_cancel_undecided', { refund_id: uuid }],
    ['refund_cancel_undecided', {}],
    ['dispute_refund_overlap', { why: 'refund' }],
    ['dispute_refund_overlap', { why: 'return' }],
    ['dispute_refund_overlap', {}],
    ['dispute_return_refund_pending', { why: 'refund' }],
    ['dispute_return_refund_pending', { why: 'return' }],
    ['dispute_return_refund_pending', {}],
    // Plan 2 keys stay as they were.
    ['order_not_postable', { reason: 'shipping' }],
    ['deferred_revenue_short', { shortage: 0 }],
    ['period_missing', { entry_date: '2026-11-10', cause: 'sole_ended_not_switched' }],
    ['posting_error', { error_sqlstate: '55000', error_code: 'unexpected_error', entry_date: '2026-11-10' }],
    ['no_revenue', {}],
  ];
  const INVALID_DETAILS: Array<[string, Record<string, unknown>]> = [
    ['amount_mismatch', { mismatch: 'other' }],
    ['amount_mismatch', { mismatch: 1 }],
    ['refund_prior_unposted', { why: 'refund' }],
    ['refund_prior_unposted', { why: 'other' }],
    ['refund_prior_unposted', { why: 1 }],
    ['dispute_refund_overlap', { why: 'original' }],
    ['dispute_return_refund_pending', { why: 'return_prior' }],
    ['refund_cancel_undecided', { refund_id: 'not-a-uuid' }],
    ['refund_cancel_undecided', { refund_id: uuid.toUpperCase() }],
    ['refund_cancel_undecided', { refund_id: 1 }],
    ['refund_cancel_undecided', { canceled_on: '2026-02-30' }],
    ['refund_cancel_undecided', { canceled_on: 'tomorrow' }],
    ['refund_cancel_undecided', { canceled_on: 20261110 }],
    ['refund_cancel_undecided', { why: 'refund' }],
    ['refund_prior_unposted', { entry_date: '2026-11-10' }],
    ['refund_cancel_undecided', { entry_date: '2026-11-10' }],
    ['amount_mismatch', { entry_date: '2026-11-10' }],
    ['dispute_refund_overlap', { entry_date: '2026-11-10' }],
    ['no_revenue', { entry_date: '2026-11-10' }],
    ['amount_mismatch', { why: 'refund' }],
    ['no_order', { why: 'refund' }],
    ['refund_prior_unposted', { mismatch: 'split' }],
    ['dispute_refund_overlap', { refund_id: uuid }],
    ['no_revenue', { canceled_on: '2026-11-10' }],
    ['refund_prior_unposted', { customer_email: 'a@example.com' }],
  ];
  test('FREQ-569-AC-01: 計画3の detail の鍵と値（mismatch の4語〔split・refund_amount・allocation_overflow・unit_value_left〕・理由ごとの why・refund_id・canceled_on）が許可の一覧を通り、一覧に無い鍵・値（理由と組で許さない why の語、uuid でない refund_id、日付でない canceled_on、period_missing と posting_error 以外の entry_date）は今までどおり22023', async () => {
    for (const [reason, detail] of VALID_DETAILS) {
      const id = sid();
      await q('select private.accounting_park_event($1, $2, $3, null, $4, $5::jsonb)', ['return_refund', 'order_refunds', id, reason, JSON.stringify(detail)]);
      const row = (await q('select reason, detail from public.accounting_pending_events where source_id = $1', [id])).rows[0];
      expect({ reason, detail: row.detail }).toEqual({ reason, detail });
    }
    for (const [reason, detail] of INVALID_DETAILS) {
      expect({ reason, detail, failure: await failure(() => park(reason, detail)) }).toEqual({ reason, detail, failure: invalid });
      expect({ reason, detail, valid: (await q('select private.accounting_pending_detail_valid($1, $2::jsonb) as v', [reason, JSON.stringify(detail)])).rows[0].v })
        .toEqual({ reason, detail, valid: false });
    }
  });

  // ---- the dispute-hold tools (FREQ-580-AC-01) ---------------------------------------------------------------------
  test('FREQ-580-AC-01: 判断待ちの道具は get_order_dispute_holds と同じ注文を返し、1件以上なら ACCOUNTING_DISPUTE_HOLD（55000、DETAIL order_count=件数）で断り、無ければ何もしない', async () => {
    const held = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }] });
    const heldTwice = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }] });
    const clean = await seedPaidOrder(db(), { lines: [{ price: 5000, quantity: 1 }] });
    await seedDispute(db(), { orderId: held.orderId, paymentIntentId: held.paymentIntentId, amount: 5000 });
    await seedDispute(db(), { orderId: heldTwice.orderId, paymentIntentId: heldTwice.paymentIntentId, amount: 2000, status: 'under_review' });
    await seedDispute(db(), { orderId: heldTwice.orderId, paymentIntentId: heldTwice.paymentIntentId, amount: 3000 });
    // A warning that took no funds does not hold.
    await seedDispute(db(), { orderId: clean.orderId, paymentIntentId: clean.paymentIntentId, amount: 5000, status: 'warning_needs_response', withdrawnAt: null });
    const ids = [held.orderId, heldTwice.orderId, clean.orderId];
    const tool = (await q('select order_id, dispute_id from private.accounting_dispute_holds($1::uuid[]) order by order_id, dispute_id', [ids])).rows;
    const read = (await q('select order_id, dispute_id from private.get_order_dispute_holds($1::uuid[]) order by order_id, dispute_id', [ids])).rows;
    expect(tool).toHaveLength(3);
    expect(tool).toEqual(read);
    const assertHold = async (orderIds: string[]) => {
      await q('savepoint t_hold');
      try { await q('select private.accounting_assert_no_dispute_hold($1::uuid[])', [orderIds]); return null; }
      catch (caught) { const e = caught as { code?: string; message?: string; detail?: string }; return { code: e.code, message: e.message, detail: e.detail }; }
      finally { await q('rollback to savepoint t_hold'); await q('release savepoint t_hold'); }
    };
    expect(await assertHold(ids)).toEqual({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD', detail: 'order_count=2' });
    expect(await assertHold([held.orderId])).toEqual({ code: '55000', message: 'ACCOUNTING_DISPUTE_HOLD', detail: 'order_count=1' });
    expect(await assertHold([clean.orderId])).toBeNull();
    expect(await assertHold([])).toBeNull();
    // No entry point and no grant: only the owner's functions call them.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const signature of ['private.accounting_dispute_holds(uuid[])', 'private.accounting_assert_no_dispute_hold(uuid[])']) {
        const can = (await q('select has_function_privilege($1, $2::regprocedure, \'EXECUTE\') as ok', [role, signature])).rows[0].ok;
        expect({ role, signature, can }).toEqual({ role, signature, can: false });
      }
    }
  });
});
