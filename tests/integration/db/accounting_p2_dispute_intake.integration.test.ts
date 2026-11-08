/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { accountingFailure } from './helpers/accounting-fixtures';
import { disputeFixture } from './helpers/accounting-orders-fixtures';

// Accounting plan 2 Task 5 (FREQ-567): the dispute tables and the writer record_stripe_dispute. ROLLBACK form (run with
// --runInBand): everything a test writes is undone. No entry is posted here (Task 6 posts from these tables).
jest.setTimeout(120000);

type Recorded = { dispute_id: string; event_inserted: boolean };

describeLocalDb('S10 dispute intake: controller only', (db) => {
  const q = (text: string, params?: unknown[]) => db().query(text, params);
  const failure = (run: () => Promise<unknown>) => accountingFailure(db(), run);
  beforeEach(async () => { await q('begin'); });
  afterEach(async () => { await q('rollback'); });

  const record = async (fixture: ReturnType<typeof disputeFixture>): Promise<Recorded> =>
    (await q('select public.record_stripe_dispute($1::jsonb, $2::jsonb) as r',
      [JSON.stringify(fixture.dispute), fixture.event === null ? null : JSON.stringify(fixture.event)])).rows[0].r;
  const eventRows = async (disputeId: string) =>
    (await q('select * from public.stripe_dispute_events where dispute_id = $1 order by occurred_at, created_at', [disputeId])).rows;
  const disputeRow = async (disputeId: string) =>
    (await q('select * from public.stripe_disputes where id = $1', [disputeId])).rows[0];

  test('FREQ-567-AC-01: dispute と履歴の1行が保存され、注文に結び付かない取り消しは order_id がNULL', async () => {
    const fixture = disputeFixture();
    const result = await record(fixture);
    expect(result).toEqual({ dispute_id: fixture.dispute.id, event_inserted: true });
    const row = await disputeRow(fixture.dispute.id);
    expect(row).toMatchObject({
      id: fixture.dispute.id, payment_intent_id: fixture.dispute.payment_intent_id, charge_id: fixture.dispute.charge_id, order_id: null,
      reason: 'fraudulent', status: 'needs_response', is_charge_refundable: false, currency: 'jpy',
    });
    expect(Number(row.amount)).toBe(5000);
    expect(row.evidence_details).toEqual(fixture.dispute.evidence_details);
    const events = await eventRows(fixture.dispute.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'charge.dispute.created', status: 'needs_response', stripe_event_created_at: null });
    expect(events[0].balance_transaction_ids).toEqual(fixture.event!.balance_transaction_ids);
  });

  test('FREQ-567-AC-01: 注文が結び付く時は order_id が入り、後の取り直しで注文が見つからなくても消えない', async () => {
    // No foreign key: a dispute whose order is not known (or is gone) is still kept.
    const orderId = randomUUID();
    const fixture = disputeFixture({ dispute: { order_id: orderId } });
    await record(fixture);
    expect((await disputeRow(fixture.dispute.id)).order_id).toBe(orderId);
    await record(disputeFixture({ dispute: { ...fixture.dispute, order_id: null } }));
    expect((await disputeRow(fixture.dispute.id)).order_id).toBe(orderId);
  });

  test('FREQ-567-AC-02: 同じ stripe_event_id の2回目は何も足さず event_inserted=false', async () => {
    const fixture = disputeFixture();
    expect((await record(fixture)).event_inserted).toBe(true);
    const again = await record(fixture);
    expect(again).toEqual({ dispute_id: fixture.dispute.id, event_inserted: false });
    expect(await eventRows(fixture.dispute.id)).toHaveLength(1);
    expect(Number((await q('select count(*) as n from public.stripe_disputes where id = $1', [fixture.dispute.id])).rows[0].n)).toBe(1);
  });

  test('FREQ-567-AC-02: 状態が変わると dispute の可変の欄が更新され、履歴は知らせごとに1行増える', async () => {
    const created = disputeFixture();
    await record(created);
    const closed = disputeFixture({
      dispute: { ...created.dispute, status: 'won', is_charge_refundable: true, evidence_due_by: null, evidence_details: { has_evidence: true } },
      event: { event_type: 'charge.dispute.closed', status: 'won', occurred_at: '2026-06-20T00:00:00Z' },
    });
    expect(await record(closed)).toEqual({ dispute_id: created.dispute.id, event_inserted: true });
    const row = await disputeRow(created.dispute.id);
    expect(row).toMatchObject({ status: 'won', is_charge_refundable: true, evidence_due_by: null });
    expect(row.evidence_details).toEqual({ has_evidence: true });
    expect((await eventRows(created.dispute.id)).map((e) => e.status)).toEqual(['needs_response', 'won']);
  });

  test('FREQ-567-AC-02: 古く取り直した状態は、新しく取り直した状態を上書きしない（履歴の行は足す）。同じ時刻なら更新する', async () => {
    const created = disputeFixture({ dispute: { synced_at: '2026-06-10T00:10:00Z' } });
    await record(created);
    // 新しい取り直し（00:20）で won
    const newer = disputeFixture({
      dispute: { ...created.dispute, status: 'won', synced_at: '2026-06-10T00:20:00Z' },
      event: { event_type: 'charge.dispute.closed', status: 'won' },
    });
    await record(newer);
    // 遅れて書き込まれた、もっと前（00:15）の取り直し（まだ under_review）
    const older = disputeFixture({
      dispute: { ...created.dispute, status: 'under_review', evidence_details: { stale: true }, synced_at: '2026-06-10T00:15:00Z' },
      event: { event_type: 'charge.dispute.updated', status: 'under_review' },
    });
    expect(await record(older)).toEqual({ dispute_id: created.dispute.id, event_inserted: true });
    const row = await disputeRow(created.dispute.id);
    expect(row.status).toBe('won');
    expect(row.evidence_details).toEqual(newer.dispute.evidence_details);
    expect(row.synced_at.toISOString()).toBe('2026-06-10T00:20:00.000Z');
    expect((await eventRows(created.dispute.id)).map((e) => e.status).sort()).toEqual(['needs_response', 'under_review', 'won']);
    // 同じ時刻の取り直しは更新する
    await record(disputeFixture({ dispute: { ...created.dispute, status: 'lost', synced_at: '2026-06-10T00:20:00Z' }, event: null }));
    expect((await disputeRow(created.dispute.id)).status).toBe('lost');
    // 時刻を渡さない呼び方は now() で、新しい取り直しとして更新する
    await record(disputeFixture({ dispute: { ...created.dispute, status: 'won', synced_at: undefined }, event: null }));
    expect((await disputeRow(created.dispute.id)).status).toBe('won');
  });

  test('FREQ-567-AC-02: 履歴を足さない呼び方（_event がNULL）は dispute の可変の欄だけを更新する', async () => {
    const created = disputeFixture();
    await record(created);
    const result = await record(disputeFixture({ dispute: { ...created.dispute, status: 'under_review' }, event: null }));
    expect(result).toEqual({ dispute_id: created.dispute.id, event_inserted: false });
    expect((await disputeRow(created.dispute.id)).status).toBe('under_review');
    expect(await eventRows(created.dispute.id)).toHaveLength(1);
  });

  test('FREQ-567-AC-03: record_stripe_disputeはstripe_event_created_atの値もNULLも保存する', async () => {
    const lost = disputeFixture({ event: { event_type: 'charge.dispute.closed', status: 'lost', stripe_event_created_at: '2026-06-25T01:02:03Z' } });
    await record(lost);
    expect((await eventRows(lost.dispute.id))[0].stripe_event_created_at.toISOString()).toBe('2026-06-25T01:02:03.000Z');
    const other = disputeFixture({ event: { stripe_event_created_at: null } });
    await record(other);
    expect((await eventRows(other.dispute.id))[0].stripe_event_created_at).toBeNull();
    const missing = disputeFixture();
    delete (missing.event as Record<string, unknown>).stripe_event_created_at;
    await record(missing);
    expect((await eventRows(missing.dispute.id))[0].stripe_event_created_at).toBeNull();
  });

  test('FREQ-567-AC-03: 原因・期限・資料の写しは履歴に残り、履歴と dispute の固定の欄のUPDATEとDELETEとTRUNCATEを断る', async () => {
    const fixture = disputeFixture();
    await record(fixture);
    const [event] = await eventRows(fixture.dispute.id);
    expect(event.raw_payload).toEqual(fixture.event!.raw_payload);
    expect(event.raw_payload.reason).toBe('fraudulent');
    expect(event.raw_payload.evidence_details).toEqual(fixture.dispute.evidence_details);
    const immutable = { code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE' };
    for (const statement of [
      `update public.stripe_dispute_events set status = 'won' where dispute_id = '${fixture.dispute.id}'`,
      `update public.stripe_dispute_events set raw_payload = '{}'::jsonb where dispute_id = '${fixture.dispute.id}'`,
      `delete from public.stripe_dispute_events where dispute_id = '${fixture.dispute.id}'`,
      'truncate public.stripe_dispute_events',
      `update public.stripe_disputes set amount = 1 where id = '${fixture.dispute.id}'`,
      `update public.stripe_disputes set reason = 'general' where id = '${fixture.dispute.id}'`,
      `update public.stripe_disputes set charge_id = 'ch_other' where id = '${fixture.dispute.id}'`,
      `update public.stripe_disputes set payment_intent_id = 'pi_other' where id = '${fixture.dispute.id}'`,
      `update public.stripe_disputes set stripe_created_at = now() where id = '${fixture.dispute.id}'`,
      `update public.stripe_disputes set currency = 'usd' where id = '${fixture.dispute.id}'`,
      `update public.stripe_disputes set id = 'dp_changed' where id = '${fixture.dispute.id}'`,
      `delete from public.stripe_disputes where id = '${fixture.dispute.id}'`,
    ]) {
      expect({ statement, result: await failure(() => q(statement)) }).toEqual({ statement, result: immutable });
    }
    // TRUNCATE of the parent is refused by Postgres itself (a foreign key points at it, 0A000); with CASCADE the trigger of the
    // child table refuses it.
    expect(await failure(() => q('truncate public.stripe_disputes'))).toEqual({ code: '0A000', message: 'DATABASE_ERROR' });
    expect(await failure(() => q('truncate public.stripe_disputes cascade'))).toEqual(immutable);
    // The mutable columns can be changed (the writer does it).
    await q(`update public.stripe_disputes set status = 'under_review', evidence_details = '{}'::jsonb where id = $1`, [fixture.dispute.id]);
    expect((await disputeRow(fixture.dispute.id)).status).toBe('under_review');
  });

  test('FREQ-567-AC-03: 表の条件（id の形・額・原因と状態の長さ・履歴の重複）が不正な入力を断る', async () => {
    const bad = (dispute: Record<string, unknown>) => failure(() => record(disputeFixture({ dispute })));
    const invalid = { code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID' };
    expect(await bad({ id: 'xx_1' })).toEqual(invalid);
    expect(await bad({ id: null })).toEqual(invalid);
    expect(await bad({ amount: 0 })).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await bad({ reason: '' })).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await bad({ status: 'x'.repeat(65) })).toEqual({ code: '23514', message: 'DATABASE_ERROR' });
    expect(await failure(() => q("select public.record_stripe_dispute('[]'::jsonb, null)"))).toEqual(invalid);
    expect(await failure(() => q("select public.record_stripe_dispute(null, null)"))).toEqual(invalid);
    const noRaw = disputeFixture();
    delete (noRaw.event as Record<string, unknown>).raw_payload;
    expect(await failure(() => record(noRaw))).toEqual(invalid);
    expect(await failure(() => record(disputeFixture({ event: { stripe_event_id: '' } })))).toEqual(invalid);
    expect(await failure(() => record(disputeFixture({ event: { balance_transaction_ids: 'txn_1' } })))).toEqual(invalid);
  });

  test('FREQ-567-AC-03: 表はanonとauthenticatedに権限が無く、service_roleはSELECTだけ。関数はservice_roleだけが呼べる', async () => {
    for (const table of ['stripe_disputes', 'stripe_dispute_events']) {
      const row = (await q(`select c.relrowsecurity, c.relowner::regrole::text as owner,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select, has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
        has_table_privilege('anon', c.oid, 'INSERT') as anon_insert, has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
        has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
        has_table_privilege('service_role', c.oid, 'INSERT') as service_insert, has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
        has_table_privilege('service_role', c.oid, 'DELETE') as service_delete, has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_truncate,
        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c where c.oid = to_regclass($1)`, [`public.${table}`])).rows[0];
      expect({ table, ...row, policies: Number(row.policies) }).toEqual({ table, relrowsecurity: true, owner: 'postgres', anon_select: false,
        auth_select: false, anon_insert: false, auth_update: false, service_select: true, service_insert: false, service_update: false,
        service_delete: false, service_truncate: false, policies: 0 });
      for (const role of ['anon', 'authenticated']) {
        await q(`set local role ${role}`);
        const result = await failure(() => q(`select 1 from public.${table} limit 1`));
        await q('reset role');
        expect({ role, table, result }).toEqual({ role, table, result: { code: '42501', message: 'DATABASE_ERROR' } });
      }
    }
    const fixture = disputeFixture();
    const call = `select public.record_stripe_dispute('${JSON.stringify(fixture.dispute)}'::jsonb, '${JSON.stringify(fixture.event)}'::jsonb)`;
    for (const role of ['anon', 'authenticated']) {
      await q(`set local role ${role}`);
      const result = await failure(() => q(call));
      await q('reset role');
      expect({ role, result }).toEqual({ role, result: { code: '42501', message: 'DATABASE_ERROR' } });
    }
    await q('set local role service_role');
    const direct = await failure(() => q(`insert into public.stripe_disputes (id, amount, currency, reason, status, stripe_created_at) values ('dp_direct', 1, 'jpy', 'general', 'x', now())`));
    expect(direct).toEqual({ code: '42501', message: 'DATABASE_ERROR' });
    expect((await q(call)).rows[0].record_stripe_dispute).toEqual({ dispute_id: fixture.dispute.id, event_inserted: true });
    expect(Number((await q('select count(*) as n from public.stripe_dispute_events')).rows[0].n)).toBeGreaterThanOrEqual(1);
    await q('reset role');
  });

  test('FREQ-567-AC-01: 受け取りは仕訳も計上待ちも作らない（仕訳は Task 6 の係が表を読んで作る）', async () => {
    const count = async () => (await q(`select
      (select count(*) from public.accounting_journal_entries) as entries, (select count(*) from public.accounting_journal_lines) as lines,
      (select count(*) from public.accounting_pending_events) as pending`)).rows[0];
    const before = await count();
    await record(disputeFixture());
    expect(await count()).toEqual(before);
  });
});
