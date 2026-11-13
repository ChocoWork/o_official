/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { addDisputeHistory, seedDispute } from './helpers/accounting-orders-fixtures';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import {
  orderBalance, postOrderPayment, postShipments, receiveReturn, shipUnits, succeedRefund, type ReturnFlow,
} from './helpers/accounting-returns-fixtures';
import { hRefundFixture } from './helpers/group-h-refund-fixtures';
import { createUbReturn } from './helpers/unit-binding-receive';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// 計画3 Task 8（S22）の並行の試験: 取り消しの確定（C）の相殺を2つの接続で同時に流す。注文・取り消し・仕訳をコミットし、仕訳は消せないので、
// ACCOUNTING_COMMIT_SUITE=1 で、2つの db reset の間に単独で流す（run between db resets）。
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p3_dispute_offset_concurrency --runInBand; db reset
// 日は切り替えの日（今日）の今: 発送の事実・引かれた時・確定・返品の届いた日は今の時刻で、過去へ戻す道具（事実の表の守りを外す物）は使わない。
jest.setTimeout(180000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('S22 dispute offset under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }

  const nowIso = () => new Date().toISOString();
  const run = async (client: PgClient) => (await client.query('select public.accounting_run_posting(50) as r')).rows[0].r as Record<string, unknown>;
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
  const lines = async (client: PgClient, dispute: string) => (await client.query(
    `select l.account_code || coalesce('(' || l.sub_account || ')', '') || ':' || l.debit || '/' || l.credit as s
     from public.accounting_journal_lines l join public.accounting_journal_entries e on e.id = l.entry_id
     where e.dedupe_key = $1 order by l.line_no`, [`dispute_event:${dispute}:confirmed:lost`])).rows.map((r) => r.s as string);
  const confirmedCount = async (client: PgClient, dispute: string) => Number((await client.query(
    'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1', [`dispute_event:${dispute}:confirmed:lost`])).rows[0].n);
  const review = async (client: PgClient, orderId: string) => Number((await client.query(
    "select coalesce(sum(debit - credit), 0)::int as n from public.accounting_journal_lines where order_id = $1 and account_code = '1470' and sub_account = 'dispute_refund_overlap_review'",
    [orderId])).rows[0].n);
  const lose = (client: PgClient, disputeId: string) => addDisputeHistory(client, { disputeId, status: 'lost', occurredAt: nowIso(),
    stripeEventCreatedAt: nowIso(), eventType: 'charge.dispute.closed' });

  /**
   * 2着（20,000円と18,750円）を今送り、18,750円の1着を手数料 10% で受け取り（choice: consult は返金待ち 16,875、now は返金 16,875 を作り今成功させる）、
   * 今引かれた取り消し（disputes 本、額 amount）を作ってコミットし、係を1回流して支払い・出荷・届いた日・返金・引かれた時をコミットする。
   */
  async function seed(setup: PgClient, choice: 'consult' | 'now', amount: number, disputes = 1) {
    await setup.query('begin');
    await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const f = await hRefundFixture(setup, false, 2, 1250);
    const shipped = await shipUnits(setup, f.orderId, f.itemId, 2, f.actor);
    const fx = { ...f, fulfillment: { fulfillment_id: shipped.fulfillmentId } } as unknown as ReturnFlow['f'];
    const ret = await createUbReturn(setup, fx, [{ quantity: 1 }], { percent: 10 });
    const flow: ReturnFlow = { f: fx, returnId: ret.returnId, lineIds: ret.lineIds };
    await postOrderPayment(setup, f.orderId, nowIso());
    await postShipments(setup);
    const received = await receiveReturn(setup, flow, { choice, units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: choice }] });
    if (choice === 'now') await succeedRefund(setup, received.refund_id as string, { at: nowIso() });
    if ((await setup.query("select 1 from public.accounting_dispute_account_settings where reason = 'fraudulent'")).rows.length === 0) {
      const admin = await insertAccountingAdmin(setup);
      await setup.query("select public.admin_set_dispute_account_setting($1::uuid, 'fraudulent', '7530', null, $2::uuid)", [admin, randomUUID()]);
    }
    const pi = (await setup.query('select payment_intent_id from public.orders where id = $1', [f.orderId])).rows[0].payment_intent_id as string;
    const ids: string[] = [];
    for (let i = 0; i < disputes; i += 1) {
      ids.push((await seedDispute(setup, { orderId: f.orderId, paymentIntentId: pi, amount, withdrawnAt: nowIso(), createdAt: nowIso() })).disputeId);
    }
    await setup.query('commit');
    for (let i = 0; i < 2; i += 1) { await setup.query('begin'); await run(setup); await setup.query('commit'); }
    return { orderId: f.orderId, disputes: ids };
  }

  test('FREQ-581-AC-02: 返品の返金待ちがある注文の確定を同時に2回流しても、確定の仕訳は1本で、返金待ちを二重に消さない', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const s = await seed(setup, 'consult', 30000);
      expect(await orderBalance(setup, s.orderId, '2130', 'return_refund')).toBe(16875);
      await lose(setup, s.disputes[0]);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await run(a);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first).toMatchObject({ disputes: 1 });
      expect(await second).toMatchObject({ disputes: 0 });
      expect(await confirmedCount(setup, s.disputes[0])).toBe(1);
      expect(await lines(setup, s.disputes[0])).toEqual(['7530:13125/0', '2130(return_refund):16875/0', '1470(dispute_pending):0/30000']);
      expect(await orderBalance(setup, s.orderId, '2130', 'return_refund')).toBe(0);
    });
  });

  test('FREQ-581-AC-03: 同じ注文の2つの取り消しの確定を別々の接続で続けて流しても、返金済みの額を二重に「分けて調べる」補助へ移さない', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      // 返品の返金 16,875円は済んでいる。10,000円の取り消しが2つ: A が1つ目の確定を入れている間に2つ目が負け、B は A のコミットを待ってから入れる
      const s = await seed(setup, 'now', 10000, 2);
      expect(await orderBalance(setup, s.orderId, '2130', 'return_refund')).toBe(0);
      await lose(setup, s.disputes[0]);
      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      expect(await run(a)).toMatchObject({ disputes: 1 });
      await lose(setup, s.disputes[1]);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(await second).toMatchObject({ disputes: 1 });
      expect(await lines(setup, s.disputes[0])).toEqual(['1470(dispute_refund_overlap_review):10000/0', '1470(dispute_pending):0/10000']);
      expect(await lines(setup, s.disputes[1])).toEqual(['7530:3125/0', '1470(dispute_refund_overlap_review):6875/0', '1470(dispute_pending):0/10000']);
      expect(await review(setup, s.orderId)).toBe(16875);
    });
  });
});
