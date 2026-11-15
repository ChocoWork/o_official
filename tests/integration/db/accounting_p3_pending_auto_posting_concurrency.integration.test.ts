/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { addDisputeHistory, seedDispute } from './helpers/accounting-orders-fixtures';
import { insertAccountingAdmin } from './helpers/accounting-fixtures';
import {
  postAutoEntry, postSales, postWithdrawal, seedAnotherReturn, seedArrival, seedAutoOrder, seedWithdrawn, seedZeroClose, type AutoOrder,
} from './helpers/accounting-pending-auto-fixtures';
import {
  postOrderPayment, postShipments, receiveReturn, shipUnits, succeedRefund, type ReturnFlow,
} from './helpers/accounting-returns-fixtures';
import { hRefundFixture } from './helpers/group-h-refund-fixtures';
import { createUbReturn } from './helpers/unit-binding-receive';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';

// 計画 S27 Task 5（FREQ-643-AC-10）: 自動計上の同時の試験。注文・取り消し・仕訳をコミットし、仕訳は消せないので、
// ACCOUNTING_COMMIT_SUITE=1 で、2つの db reset の間に単独で流す（run between db resets）。
//   db reset; ACCOUNTING_COMMIT_SUITE=1 DATABASE_URL=... npx jest tests/integration/db/accounting_p3_pending_auto_posting_concurrency --runInBand; db reset
// 日は切り替えの日（今日）の今: 発送の事実・引かれた時・確定・返品の届いた日は今の時刻で、過去へ戻す道具（事実の表の守りを外す物）は使わない。
// 取り消しの計上係の「直し」は、負けた日（今日）より後の0円の終わりが要るので、その日だけ明日にする。
jest.setTimeout(240000);

const COMMIT_SUITE = process.env.ACCOUNTING_COMMIT_SUITE === '1';

describeLocalDb('S27 auto posting under concurrency: controller only (commits)', () => {
  if (!COMMIT_SUITE) {
    test.skip('ACCOUNTING_COMMIT_SUITE=1 未設定のためスキップ', () => {});
    return;
  }

  const nowIso = () => new Date().toISOString();
  const run = async (client: PgClient) => (await client.query('select public.accounting_run_posting(50) as r')).rows[0].r as Record<string, number>;
  async function waitUntilBlocked(observer: PgClient, pid: number): Promise<number[]> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const blockers = (await observer.query('select pg_catalog.pg_blocking_pids($1::integer) as b', [pid])).rows[0].b as number[];
      if (blockers.length > 0) return blockers;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('SECOND_CONNECTION_WAS_NOT_BLOCKED');
  }
  const pidOf = async (client: PgClient) => (await client.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number;
  /** 4つの接続。a・b の statement_timeout は 15 秒（固まりは待ちが切れて落ちる）。 */
  async function withClients<T>(task: (c: { setup: PgClient; a: PgClient; b: PgClient; observer: PgClient }) => Promise<T>): Promise<T> {
    const setup = await connectLocalDb();
    const a = await connectLocalDb();
    const b = await connectLocalDb();
    const observer = await connectLocalDb();
    try {
      for (const client of [a, b]) await client.query('set statement_timeout = 15000');
      return await task({ setup, a, b, observer });
    } finally {
      for (const client of [a, b, setup, observer]) {
        try { await client.query('rollback'); } catch { /* nothing open */ }
        await client.end();
      }
    }
  }
  const jstToday = async (client: PgClient) => (await client.query("select ((now() at time zone 'Asia/Tokyo')::date)::text as d")).rows[0].d as string;
  const jstTomorrow = async (client: PgClient) => (await client.query("select ((now() at time zone 'Asia/Tokyo')::date + 1)::text as d")).rows[0].d as string;
  const bal = async (client: PgClient, orderId: string, account: string, sub?: string) => Number((await client.query(
    `select coalesce(sum(l.debit - l.credit), 0) as b from public.accounting_journal_lines l
     where l.order_id = $1 and l.account_code = $2 and ($3::text is null or l.sub_account = $3)`, [orderId, account, sub ?? null])).rows[0].b);
  const snap = async (client: PgClient, orderId: string) => ({
    payable: 0 - (await bal(client, orderId, '2130', 'return_refund')),
    d4020: await bal(client, orderId, '4020'),
    review: await bal(client, orderId, '1470', 'dispute_refund_overlap_review'),
    net: 0 - ((await bal(client, orderId, '4010')) + (await bal(client, orderId, '4020')) + (await bal(client, orderId, '4050'))),
  });
  const count = async (client: PgClient, key: string) => Number((await client.query(
    'select count(*) as n from public.accounting_journal_entries where dedupe_key = $1', [key])).rows[0].n);
  const openRows = async (client: PgClient, orderId: string) => Number((await client.query(
    'select count(*) as n from public.accounting_pending_events where order_id = $1 and resolved_at is null', [orderId])).rows[0].n);
  const settle = async (client: PgClient) => { for (let i = 0; i < 3; i += 1) { await client.query('begin'); await run(client); await client.query('commit'); } };

  /**
   * 返品 A（届いた goods 円）、売上 goods 円、s 円の取り消し（今引かれ・今負け・W の仕訳あり）をコミットし、係を流して届いた日の仕訳と C を入れる。
   * 0円の終わりは含まない（呼ぶ側が足す）。
   */
  async function seedLostOrder(setup: PgClient, goods: number, s: number) {
    await setup.query('begin');
    await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const today = await jstToday(setup);
    const o = await seedAutoOrder(setup, [goods], nowIso());
    await postSales(setup, o.orderId, goods, today);
    await seedArrival(setup, o, goods, 0, today);
    const w = await seedWithdrawn(setup, o.orderId, s, nowIso());
    await postWithdrawal(setup, w.disputeId, w.txnId, s, today);
    await setup.query('commit');
    await settle(setup);
    return { o, dp: w.disputeId, today };
  }
  const closeOn = async (setup: PgClient, o: AutoOrder, covers: number, on: string) => {
    await setup.query('begin');
    await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const close = await seedZeroClose(setup, o, covers, 0, on);
    await setup.query('commit');
    return close;
  };


  const lose = (client: PgClient, disputeId: string) => addDisputeHistory(client, { disputeId, status: 'lost', occurredAt: nowIso(),
    stripeEventCreatedAt: nowIso(), eventType: 'charge.dispute.closed' });
  type Write = 'create' | 'decide';
  /**
   * 2着（20,000円と18,750円）を今送り、18,750円の1着を手数料 10% で受け取り（返金は相談: 16,875円が返金待ち）、今引かれた取り消し（30,000円）を作ってコミットし、
   * 係を流して支払い・出荷・届いた日・引かれた時をコミットする。負けはまだ入れない。
   */
  async function seedConsult(setup: PgClient, disputeAmount = 30000, withA = false, receive = true) {
    await setup.query('begin');
    await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    const f = await hRefundFixture(setup, false, 2, 1250);
    const shipped = await shipUnits(setup, f.orderId, f.itemId, 2, f.actor);
    const fx = { ...f, fulfillment: { fulfillment_id: shipped.fulfillmentId } } as unknown as ReturnFlow['f'];
    const ret = await createUbReturn(setup, fx, [{ quantity: 1 }], { percent: 10 });
    const flow: ReturnFlow = { f: fx, returnId: ret.returnId, lineIds: ret.lineIds };
    await postOrderPayment(setup, f.orderId, nowIso());
    await postShipments(setup);
    if (receive) await receiveReturn(setup, flow, { choice: 'consult', units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'consult' }] });
    if ((await setup.query("select 1 from public.accounting_dispute_account_settings where reason = 'fraudulent'")).rows.length === 0) {
      const admin = await insertAccountingAdmin(setup);
      await setup.query("select public.admin_set_dispute_account_setting($1::uuid, 'fraudulent', '7530', null, $2::uuid)", [admin, randomUUID()]);
    }
    const pi = (await setup.query('select payment_intent_id from public.orders where id = $1', [f.orderId])).rows[0].payment_intent_id as string;
    const dispute = (await seedDispute(setup, { orderId: f.orderId, paymentIntentId: pi, amount: disputeAmount, withdrawnAt: nowIso(), createdAt: nowIso() })).disputeId;
    // 同じ注文の2つ目の返品 A（goods 10,000円が今日届いた）。0円の終わりは負けの後に足す
    const a = withA ? await seedAnotherReturn(setup, { orderId: f.orderId, orderItemIds: [f.itemId], returnId: flow.returnId, actor: f.actor }, 2) : null;
    if (a) await seedArrival(setup, a, 10000, 0, await jstToday(setup));
    await setup.query('commit');
    await settle(setup);
    return { orderId: f.orderId, returnId: flow.returnId, actor: f.actor, dispute, a, flow };
  }
  /** 返品の返金を決める（相談で待っていた返金を作る。admin_refund_return）。作った返金の番号を返す。 */
  const decide = async (client: PgClient, s: { returnId: string; actor: string }) => (await client.query(
    'select * from public.admin_refund_return($1, $2, $3, null, 0, null, false)', [s.returnId, s.actor, randomUUID()])).rows[0] as { refund_id: string | null; amount: number; status: string };

  const receiveNow = (client: PgClient, flow: ReturnFlow) => receiveReturn(client, flow, { choice: 'now',
    units: [{ return_line_id: flow.lineIds[0], disposition: 'not_restocked', quantity: 1, refund_choice: 'now' }] });
  type Final = { payable: number; d4020: number; review: number; net: number; open: number };
  const full = async (client: PgClient, orderId: string): Promise<Final> => ({ ...(await snap(client, orderId)), open: await openRows(client, orderId) });
  /** どの順でも同じ最後の円: 返金 16,875円（B）と負けた取り消し 10,000円と A の0円の終わり（明日、10,000円）で 2130 = 0。 */
  const SAME: Final = { payable: 0, d4020: 28750, review: 0, net: 11875, open: 0 };

  /** 注文の準備（負け・A の0円の終わり（負けた日の明日）まで）。write が 'create' なら返品 B はまだ受け取っていない。 */
  async function prepare(setup: PgClient, write: Write) {
    const s = await seedConsult(setup, 10000, true, write === 'decide');
    await lose(setup, s.dispute);
    await setup.query('begin');
    await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await seedZeroClose(setup, s.a!, 10000, 0, await jstTomorrow(setup));
    await setup.query('commit');
    return s;
  }
  type Seed = Awaited<ReturnType<typeof prepare>>;
  /** 返金を作る書き込み（write）。'decide' は相談の返品の返金を決め、'create' は返品を受け取って返金を作る。返金の番号を返す。 */
  async function write(client: PgClient, s: Seed, how: Write): Promise<string> {
    if (how === 'decide') return (await decide(client, s)).refund_id as string;
    return (await receiveNow(client, s.flow)).refund_id as string;
  }
  /** 返金を成功にして係を流し、最後の円を返す。 */
  async function finish(setup: PgClient, s: Seed, refundId: string): Promise<Final> {
    await succeedRefund(setup, refundId, { at: nowIso() });
    await settle(setup);
    return full(setup, s.orderId);
  }

  for (const how of ['decide', 'create'] as const) {
    const label = how === 'decide' ? '返品の返金を決める（admin_refund_return の入口）' : '返品を受け取って返金を作る（admin_receive_return の入口）';

    test(`FREQ-643-AC-10: 計上係と同じ注文の返金の書き込み（${label}）は、どちらが先でも 2130 が負にならず、最後の 2130 は同じ（0）で、開いた待ちも残らない`, async () => {
      await withClients(async ({ setup }) => {
        const finals: Record<string, Final> = {};
        for (const first of ['poster', 'writer'] as const) {
          const s = await prepare(setup, how);
          let refundId: string;
          if (first === 'poster') {
            await settle(setup);
            expect((await full(setup, s.orderId)).payable).toBeGreaterThanOrEqual(0);
            refundId = await write(setup, s, how);
          } else {
            refundId = await write(setup, s, how);
            await settle(setup);
            expect((await full(setup, s.orderId)).payable).toBeGreaterThanOrEqual(0);
          }
          finals[first] = await finish(setup, s, refundId);
        }
        expect(finals).toEqual({ poster: SAME, writer: SAME });
      });
    });

    for (const holder of ['poster', 'writer'] as const) {
      test(`FREQ-643-AC-10: 計上係と同じ注文の返金の書き込み（${label}）を2つの接続で同時に流す（${holder === 'poster' ? '計上係が先に取引を持つ' : '書き込みが先に取引を持つ'}）と、待った方は固まらずに終わり、2130 が負にならず、最後は直列と同じ円になる`, async () => {
        await withClients(async ({ setup, a, b, observer }) => {
          const s = await prepare(setup, how);
          const pidA = await pidOf(a);
          const pidB = await pidOf(b);
          let refundId: string;
          if (holder === 'poster') {
            await a.query('begin');
            await run(a);
            const writing = write(b, s, how);
            expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
            await a.query('commit');
            refundId = await writing;
          } else {
            await b.query('begin');
            refundId = await write(b, s, how);
            const posting = run(a);
            expect(await waitUntilBlocked(observer, pidA)).toContain(pidB);
            await b.query('commit');
            await posting;
          }
          expect((await full(setup, s.orderId)).payable).toBeGreaterThanOrEqual(0);
          expect(await finish(setup, s, refundId)).toEqual(SAME);
        });
      });
    }
  }

  test('FREQ-643-AC-10: 計上係を2つの接続で同時に流しても、dispute_lost の側（負けた後の返品の0円の終わり）の決定の仕訳は1本で、重ならない', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const s = await seedLostOrder(setup, 10000, 4000);
      // 負けを入れて C を先に入れる（pay 4,000）。その後の0円の終わり（今日）を A・B が同時に流す
      await addDisputeHistory(setup, { disputeId: s.dp, status: 'lost', occurredAt: nowIso(), stripeEventCreatedAt: nowIso(), eventType: 'charge.dispute.closed' });
      await settle(setup);
      expect(await count(setup, `dispute_event:${s.dp}:confirmed:lost`)).toBe(1);
      expect(await snap(setup, s.o.orderId)).toEqual({ payable: 6000, d4020: 10000, review: 0, net: 0 });
      const close = await closeOn(setup, s.o, 10000, s.today);

      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await run(a);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first).toMatchObject({ returns: 1 });
      expect(await second).toMatchObject({ returns: 0 });
      expect(await count(setup, `return_amount_decided:${close.factId}`)).toBe(1);
      expect(await snap(setup, s.o.orderId)).toEqual({ payable: 0, d4020: 4000, review: 0, net: 6000 });
      expect(await openRows(setup, s.o.orderId)).toBe(0);
    });
  });

  test('FREQ-643-AC-10: 計上係を2つの接続で同時に流しても、return_closed_after_lost の側（C と直し）は C が1本・直しが1本で、重ならない', async () => {
    await withClients(async ({ setup, a, b, observer }) => {
      const s = await seedLostOrder(setup, 10000, 4000);
      // 0円の終わりは負けた日（今日）より後（明日）。先にその仕訳を入れ、負けを入れる。C と直しは A・B が同時に流す
      const tomorrow = await jstTomorrow(setup);
      await setup.query('begin');
      await setup.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
      const close = await seedZeroClose(setup, s.o, 10000, 0, tomorrow);
      await postAutoEntry(setup, { date: tomorrow, kind: 'return_amount_decided', parts: [close.factId], sourceTable: 'accounting_return_facts', sourceId: close.factId,
        lines: [{ account: '2130', debit: 10000, sub: 'return_refund', orderId: s.o.orderId }, { account: '4020', credit: 10000, orderId: s.o.orderId }] });
      await setup.query('commit');
      await addDisputeHistory(setup, { disputeId: s.dp, status: 'lost', occurredAt: nowIso(), stripeEventCreatedAt: nowIso(), eventType: 'charge.dispute.closed' });
      expect(await snap(setup, s.o.orderId)).toEqual({ payable: 0, d4020: 0, review: 0, net: 10000 });

      const pidA = await pidOf(a);
      const pidB = await pidOf(b);
      await a.query('begin');
      const first = await run(a);
      const second = run(b);
      expect(await waitUntilBlocked(observer, pidB)).toContain(pidA);
      await a.query('commit');
      expect(first).toMatchObject({ disputes: 1 });
      expect(await second).toMatchObject({ disputes: 0 });
      expect(await count(setup, `dispute_event:${s.dp}:confirmed:lost`)).toBe(1);
      expect(await count(setup, `dispute_event:closefix:${s.dp}:1`)).toBe(1);
      expect(await snap(setup, s.o.orderId)).toEqual({ payable: 0, d4020: 4000, review: 0, net: 6000 });
      expect(await openRows(setup, s.o.orderId)).toBe(0);
    });
  });
});
