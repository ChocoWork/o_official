/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createDraft } from './helpers/order-fixtures';
import { withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';
import { createPurchaseFlow, EXCEEDS_REMAINING, VERSION_CONFLICT } from './helpers/purchase-order-flow';
import { withCleanup } from './helpers/with-cleanup';

/**
 * G-2 Task 9（FREQ-540-AC-08・FREQ-529-AC-03・FREQ-529-AC-05）: 発注書の全入口の別接続の並行試験。
 * 材料は先に確定させ（別の取引で commit）、別の接続 A・B・C で次を確かめる。待ちは sleep でなく pg_blocking_pids と pg_locks
 * （待つ側の advisory が granted = false）を、待っている間に標本して確かめてから解放する（終わった後では確かめない）。
 *   1. 新9関数それぞれ: A が共通 advisory(190521,1) だけを持つ → B が有効な入力で始める → B が advisory で待つ →
 *      C が対象の行（発注書・明細・variant・item・待ちの注文）を FOR UPDATE NOWAIT で取れる（B は先に行の鍵を持っていない）→
 *      A を放す → B が完了し、数量が保存則を満たす。
 *   2. 受け取り対受け取り（未納5に3+3を別キー）・同キーの同時2本・数量確定対受け取り・通常入荷（G-1）対受け取り・
 *      受け取り対入金・受け取り対返金・variant の並びが逆の2つの発注書・受け取りの取消対入金/FIFO/棚卸減。
 * deadlock は SQLSTATE 40P01 を返した接続が無いこと（全て statement_timeout の内に終わること）で見る。
 * 材料と結果は commit する（別接続から見えるため）。発注書・受取・注文・原本の予約／添付／版は追記専用や削除禁止で消せないので、
 * 同じ DB に残る。この試験は番号・件数でなく自分の id だけを見る。他の DB 試験（group_g2_purchase_model・group_g2_purchase_documents など）も
 * 自分の発注書・自分の id に絞って数える／検索するので、この試験の後でも、この試験を何度流した DB でも通る。
 * DB 試験は --runInBand で流す（別接続の待ちを標本するので、同じ DB を使う他の試験と並べて流さない）。
 * G-3 以降: 受け取りと取消の結果（FIFO の割当・台帳の理由）や書込み関数の鍵の順を G-3 が変えるなら、この試験の期待も同じコミットで直す。
 */
jest.setTimeout(120000);

type Probe = [string, unknown[]];
type Op = (c: PgClient) => Promise<{ rows: any[] }>;
type Outcome = { ok: true; rows: any[] } | { ok: false; code?: string; message?: string; detail?: string };
type Prepared = {
  sql: string;
  params: unknown[];
  /** C が NOWAIT で取れるはずの行（B が待っている間は B も他の接続も持っていない） */
  probes: Probe[];
  /** B が完了し commit した後に、B の関数が返した行から数量が保存則を満たすことを確かめる */
  check: (rows: any[]) => Promise<void>;
};

describeLocalDb('G-2 Task 9: 発注書の全入口の別接続の並行', (db) => {
  const flow = createPurchaseFlow(db);
  const committed = <T>(run: () => Promise<T>) => withGroupG1FixtureTransaction(db(), run);

  // ---- 接続と待ちの道具 ----

  const opened: PgClient[] = [];
  /** 別の接続。後始末は作った順（最初の接続が先に放され、待っている接続が進む） */
  async function client(): Promise<PgClient> {
    const c = await connectLocalDb();
    await c.query("set statement_timeout='20s'");
    opened.push(c);
    return c;
  }
  /** 作った接続を作った順に戻して閉じる（待っている接続があっても、先の接続が放されて進む）。何度呼んでもよい */
  async function releaseClients() {
    for (const c of opened.splice(0)) {
      await c.query('rollback').catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  }
  afterEach(async () => {
    await releaseClients();
    await db().query('rollback');
  });

  const pid = async (c: PgClient) => (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number;

  /** waiter が blockers のどれかに待たされ、かつ共通 advisory を granted = false で待っていることを、待っている間に確かめる */
  async function waitBlocked(observer: PgClient, waiter: number, blockers: number[]) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const row = (await observer.query(`select
          exists(select 1 from unnest(pg_catalog.pg_blocking_pids($1::int)) as b(pid) where b.pid = any($2::int[])) as blocked,
          exists(select 1 from pg_catalog.pg_locks where pid = $1::int and locktype = 'advisory'
            and classid = 190521 and objid = 1 and objsubid = 2 and not granted) as advisory`, [waiter, blockers])).rows[0];
      if (row.blocked && row.advisory) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G2_ADVISORY_WAIT_NOT_OBSERVED');
  }

  const settle = (promise: Promise<{ rows: any[] }>): Promise<Outcome> => promise.then(
    (result): Outcome => ({ ok: true, rows: result.rows }),
    (error: { code?: string; message?: string; detail?: string }): Outcome => ({ ok: false, code: error.code, message: error.message, detail: error.detail }),
  );

  /** 成功なら遅延の確かめを発火させて commit、失敗なら rollback */
  async function finish(c: PgClient, outcome: Outcome) {
    if (outcome.ok) {
      await c.query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
      await c.query('commit');
    } else {
      await c.query('rollback');
    }
  }

  const failure = (outcome: Outcome) => (outcome.ok ? 'ok' : { code: outcome.code, message: outcome.message });
  /** deadlock（40P01）で終わった接続が無い */
  const noDeadlock = (...outcomes: Outcome[]) => expect(outcomes.map((o) => (o.ok ? 'ok' : o.code))).not.toContain('40P01');

  /** A が先に操作して取引を開いたまま、B が共通 advisory を待つ。待ちを確かめてから A を commit して B を進める */
  async function serial(first: Op, second: Op) {
    const a = await client();
    const b = await client();
    const [blocker, waiter] = [await pid(a), await pid(b)];
    await a.query('begin');
    await b.query('begin');
    const firstOutcome = await settle(first(a));
    const pending = settle(second(b));
    await waitBlocked(db(), waiter, [blocker]);
    await finish(a, firstOutcome);
    const secondOutcome = await pending;
    await finish(b, secondOutcome);
    noDeadlock(firstOutcome, secondOutcome);
    return { first: firstOutcome, second: secondOutcome };
  }

  /**
   * 門番が共通 advisory だけを持つ間に、2 本を順に始めて両方の待ちを確かめ、門を放す。先に進んだ方の取引は開いたままで、
   * もう一方がその取引を待つ（これも標本する）。勝った方を commit すると負けた方が進む。
   */
  async function race(first: Op, second: Op) {
    const gate = await client();
    const b1 = await client();
    const b2 = await client();
    const [gatePid, p1, p2] = [await pid(gate), await pid(b1), await pid(b2)];
    await gate.query('begin');
    await gate.query('select pg_advisory_xact_lock(190521,1)');
    await b1.query('begin');
    await b2.query('begin');
    const firstPending = settle(first(b1));
    await waitBlocked(db(), p1, [gatePid]);
    const secondPending = settle(second(b2));
    await waitBlocked(db(), p2, [gatePid, p1]);
    await gate.query('rollback');
    const firstWon = await Promise.race([firstPending.then(() => true), secondPending.then(() => false)]);
    const [winner, loser, winnerConn, loserConn, winnerPid, loserPid] = firstWon ? [firstPending, secondPending, b1, b2, p1, p2] : [secondPending, firstPending, b2, b1, p2, p1];
    await waitBlocked(db(), loserPid, [winnerPid]);
    const winnerOutcome = await winner;
    await finish(winnerConn, winnerOutcome);
    const loserOutcome = await loser;
    await finish(loserConn, loserOutcome);
    const outcomes = { first: await firstPending, second: await secondPending };
    noDeadlock(outcomes.first, outcomes.second);
    return { ...outcomes, firstWon };
  }

  // ---- 材料 ----

  const today = () => flow.today();

  async function placeOrder(draft: { draftId: string; checkoutSessionId: string; cartSessionId: string; totalAmount: number }) {
    return (await db().query(
      `select order_id from public.place_order_from_checkout_draft($1::uuid,$2::text,$3::text,$4::integer,0,'jpy',now(),null::text)`,
      [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
    )).rows[0].order_id as string;
  }

  /** 1 点を仮確保した支払い前の注文（空き在庫 -1・仮確保 +1） */
  async function holdOrder(fixture: { itemId: number }) {
    const draft = await createDraft(db(), { itemId: fixture.itemId, quantity: 1 });
    return { orderId: await placeOrder(draft), draft };
  }

  const pay = (hold: { orderId: string; draft: { totalAmount: number } }): Op => (c) => c.query(
    `select updated, amount_matches from public.mark_order_paid($1::uuid,'payment_in_progress',$2::text,$3::integer,'jpy',true,'order_confirmed',null)`,
    [hold.orderId, `pi_${randomUUID().replaceAll('-', '')}`, hold.draft.totalAmount],
  );

  const stockEntry = (fixture: { itemId: number; variantId: number }, actor: string, delta: number, expectedRelease: number | null = null): Op => (c) => c.query(
    `select public.admin_record_stock_movement($1::bigint,$2::bigint,$3::integer,$4::text,$5::text,$6::uuid,$7::uuid,$8::integer) as result`,
    [fixture.itemId, fixture.variantId, delta, delta > 0 ? 'restock' : 'adjustment', delta > 0 ? null : '棚卸', actor, randomUUID(), expectedRelease],
  );

  const receiveOp = (input: { orderId: string; version: number; lines: Array<{ lineId: string; quantity: number }>; actor: string; key?: string; receivedOn: string }): Op => (c) => c.query(
    'select public.admin_receive_purchase_order($1::uuid,$2::integer,$3::date,$4::text,$5::jsonb,$6::uuid,$7::uuid) as r',
    [input.orderId, input.version, input.receivedOn, null, JSON.stringify(input.lines), input.actor, input.key ?? randomUUID()],
  );

  const reverseOp = (input: { orderId: string; version: number; receiptId: string; receiptLineId: string; quantity: number; expected: number | null; actor: string }): Op => (c) => c.query(
    'select public.admin_reverse_purchase_order_receipt($1::uuid,$2::integer,$3::uuid,$4::jsonb,$5::text,$6::integer,$7::uuid,$8::uuid) as r',
    [input.orderId, input.version, input.receiptId, JSON.stringify([{ receiptLineId: input.receiptLineId, quantity: input.quantity }]),
      '数量の訂正', input.expected, input.actor, randomUUID()],
  );

  const confirmOp = (input: { orderId: string; version: number; lines: Array<{ lineId: string; quantity: number }>; reason: string | null; actor: string }): Op => (c) => c.query(
    'select public.admin_confirm_purchase_order_quantities($1::uuid,$2::integer,$3::jsonb,$4::text,$5::uuid,$6::uuid) as r',
    [input.orderId, input.version, JSON.stringify(input.lines.map((line) => ({ ...line, unitPriceYen: null }))), input.reason, input.actor, randomUUID()],
  );

  /** 数量確定済みの発注書（1 行・variant は渡された物）を作って返す */
  async function confirmedOrder(actor: string, lines: Array<{ variantId: number; quantity: number }>) {
    const order = await flow.create(actor, lines.map((line) => flow.lineOf(line.variantId, line.quantity)));
    const created = await flow.linesOf(order.id);
    await flow.confirmQuantities(actor, order.id, created, lines.map((line) => line.quantity));
    return { order, lines: await flow.linesOf(order.id), version: (await flow.orderRow(order.id)).version };
  }

  /** variant の空き在庫 F・割当 A・仮確保 H と、注文ごとの割当の残り */
  async function stateOf(variantId: number) {
    const totals = await flow.totals(variantId);
    const byOrder = (await db().query(`select oi.order_id, a.kind, sum(a.remaining_quantity)::int as n
      from public.order_item_allocations a join public.order_items oi on oi.id = a.order_item_id
      where a.variant_id = $1 and a.remaining_quantity > 0 group by oi.order_id, a.kind`, [variantId])).rows as Array<{ order_id: string; kind: string; n: number }>;
    return { ...totals, byOrder: Object.fromEntries(byOrder.map((row) => [`${row.order_id}:${row.kind}`, row.n])) as Record<string, number> };
  }

  /** 空き在庫は負でなく、台帳の合計と在庫が合い、割当の残りは 0 以上で割当の数を超えない */
  async function expectSane(variantIds: number[]) {
    for (const variantId of variantIds) {
      expect({ variantId, rows: (await db().query('select * from public.verify_stock_integrity() where variant_id = $1', [variantId])).rows })
        .toEqual({ variantId, rows: [] });
      expect({ variantId, broken: (await db().query(`select count(*)::int as n from public.order_item_allocations
        where variant_id = $1 and (remaining_quantity < 0 or remaining_quantity > quantity)`, [variantId])).rows[0].n }).toEqual({ variantId, broken: 0 });
      expect((await flow.totals(variantId)).f).toBeGreaterThanOrEqual(0);
    }
  }

  const operationCount = async (operation: string, key: string) => (await db().query(
    'select count(*)::int as n from private.group_g_operations where operation = $1 and request_key = $2::uuid', [operation, key])).rows[0].n as number;

  const receiptCount = async (orderId: string) => (await db().query(
    'select count(*)::int as n from public.purchase_order_receipts where purchase_order_id = $1', [orderId])).rows[0].n as number;

  // ---- 1. 新9関数それぞれ: 共通 advisory を最初に取り、行の鍵はその後 ----

  const variantProbes = (variantIds: number[], itemIds: number[]): Probe[] => [
    ['select id from public.item_variants where id = any($1::bigint[]) for update nowait', [variantIds]],
    ['select id from public.items where id = any($1::bigint[]) for update nowait', [itemIds]],
  ];
  const purchaseProbes = (orderId: string): Probe[] => [
    ['select id from public.purchase_orders where id = $1::uuid for update nowait', [orderId]],
    ['select id from public.purchase_order_lines where purchase_order_id = $1::uuid for update nowait', [orderId]],
  ];
  const orderProbes = (orderIds: string[]): Probe[] => [
    ['select id from public.orders where id = any($1::uuid[]) for update nowait', [orderIds]],
    ['select id from public.order_items where order_id = any($1::uuid[]) for update nowait', [orderIds]],
  ];
  const reserve = async (orderId: string, actor: string, fileName: string) => (await db().query(
    'select public.admin_reserve_purchase_order_attachment($1::uuid,$2::text,$3::text,$4::uuid,$5::uuid,$6::uuid) as r',
    [orderId, 'invoice', fileName, null, actor, randomUUID()])).rows[0].r as { reservationId: string; storagePath: string };
  const attach = async (reservationId: string, orderId: string, actor: string) => (await db().query(
    `select public.admin_attach_purchase_order_document($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::text,$7::date,$8::bigint,$9::text,$10::text,$11::uuid,$12::uuid) as r`,
    [reservationId, orderId, 'application/pdf', 1000, 'ab'.repeat(32), 'server', '2026-10-25', 5000, 'JPY', '工場A', actor, randomUUID()])).rows[0].r as { attachmentId: string };

  const ENTRIES: Array<{ name: string; prepare: () => Promise<Prepared> }> = [
    { name: 'public.admin_create_purchase_order', prepare: async () => {
      const fx = await committed(async () => {
        const actor = await flow.manager();
        const stocked = await createCatalogFixture(db(), { stock: 2 });
        const waited = await createCatalogFixture(db(), { stock: 0 });
        return { actor, stocked, waited, waiting: await flow.waitingOrder(waited, 1, '2026-01-01') };
      });
      const variantIds = [fx.stocked.variantId, fx.waited.variantId];
      const before = await Promise.all(variantIds.map((id) => flow.totals(id)));
      return {
        sql: 'select public.admin_create_purchase_order($1::text, $2::text, $3::jsonb, $4::uuid, $5::uuid) as r',
        params: ['工場A', null, JSON.stringify(variantIds.map((variantId) => ({ variantId, quantity: 2 }))), fx.actor, randomUUID()],
        probes: [...variantProbes(variantIds, [fx.stocked.itemId, fx.waited.itemId]), ...orderProbes([fx.waiting.orderId])],
        check: async (rows) => {
          const created = rows[0].r as { id: string; version: number; replayed: boolean };
          expect(created).toMatchObject({ version: 1, replayed: false });
          expect((await flow.linesOf(created.id)).map((line) => [line.variant_id, line.provisional_quantity])).toEqual(variantIds.map((id) => [id, 2]));
          expect(await Promise.all(variantIds.map((id) => flow.totals(id)))).toEqual(before);
        },
      };
    } },
    { name: 'public.admin_update_purchase_order_header', prepare: async () => {
      const fx = await committed(() => flow.setup([3, 2], { confirm: false }));
      const variantIds = fx.fixtures.map((f) => f.variantId);
      return {
        sql: 'select public.admin_update_purchase_order_header($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::uuid,$7::uuid) as r',
        params: [fx.order.id, fx.version, '工場B', null, '発注先の訂正', fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(variantIds, fx.fixtures.map((f) => f.itemId))],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ version: 2, replayed: false });
          expect(await flow.orderRow(fx.order.id)).toMatchObject({ supplier_name: '工場B', version: 2, stage: 'ordered' });
          expect(await Promise.all(variantIds.map((id) => flow.totals(id)))).toEqual(variantIds.map(() => ({ f: 0, a: 0, h: 0 })));
        },
      };
    } },
    { name: 'public.admin_confirm_purchase_order_quantities', prepare: async () => {
      const fx = await committed(() => flow.setup([3, 2], { confirm: false }));
      const variantIds = fx.fixtures.map((f) => f.variantId);
      return {
        sql: 'select public.admin_confirm_purchase_order_quantities($1::uuid,$2::integer,$3::jsonb,$4::text,$5::uuid,$6::uuid) as r',
        params: [fx.order.id, fx.version, JSON.stringify(fx.lines.map((line, index) => ({ lineId: line.id, quantity: [3, 2][index], unitPriceYen: null }))), null, fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(variantIds, fx.fixtures.map((f) => f.itemId))],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ version: 2, replayed: false });
          expect(await flow.orderRow(fx.order.id)).toMatchObject({ stage: 'quantity_confirmed', version: 2 });
          expect((await flow.linesOf(fx.order.id)).map((line) => [line.confirmed_quantity, line.outstanding_quantity, line.received_quantity])).toEqual([[3, 3, 0], [2, 2, 0]]);
          expect(await Promise.all(variantIds.map((id) => flow.totals(id)))).toEqual(variantIds.map(() => ({ f: 0, a: 0, h: 0 })));
        },
      };
    } },
    { name: 'public.admin_short_close_purchase_order', prepare: async () => {
      const fx = await committed(() => flow.setup([3, 2]));
      const variantIds = fx.fixtures.map((f) => f.variantId);
      return {
        sql: 'select public.admin_short_close_purchase_order($1::uuid,$2::integer,$3::uuid[],$4::text,$5::uuid,$6::uuid) as r',
        params: [fx.order.id, fx.version, fx.lines.map((line) => line.id), '打切り', fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(variantIds, fx.fixtures.map((f) => f.itemId))],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ replayed: false });
          expect((await flow.linesOf(fx.order.id)).map((line) => [line.confirmed_quantity, line.outstanding_quantity, line.received_quantity])).toEqual([[0, 0, 0], [0, 0, 0]]);
          const closed = (await db().query(`select count(*)::int as n, coalesce(sum(sc.closed_quantity), 0)::int as quantity
            from public.purchase_order_short_closures sc join public.purchase_order_lines l on l.id = sc.line_id where l.purchase_order_id = $1`, [fx.order.id])).rows[0];
          expect(closed).toEqual({ n: 2, quantity: 5 });
          expect(await Promise.all(variantIds.map((id) => flow.totals(id)))).toEqual(variantIds.map(() => ({ f: 0, a: 0, h: 0 })));
        },
      };
    } },
    { name: 'public.admin_receive_purchase_order', prepare: async () => {
      const fx = await committed(async () => {
        const setup = await flow.setup([3, 2]);
        return { ...setup, older: await flow.waitingOrder(setup.fixtures[0], 2, '2026-01-01'), newer: await flow.waitingOrder(setup.fixtures[0], 2, '2026-02-01') };
      });
      const variantIds = fx.fixtures.map((f) => f.variantId);
      return {
        sql: 'select public.admin_receive_purchase_order($1::uuid,$2::integer,$3::date,$4::text,$5::jsonb,$6::uuid,$7::uuid) as r',
        params: [fx.order.id, fx.version, await today(), null, JSON.stringify(flow.receiveLines(fx.lines, [3, 2])), fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(variantIds, fx.fixtures.map((f) => f.itemId)), ...orderProbes([fx.older.orderId, fx.newer.orderId])],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ allocatedQuantity: 3, replayed: false });
          expect((await flow.linesOf(fx.order.id)).map((line) => [line.received_quantity, line.outstanding_quantity])).toEqual([[3, 0], [2, 0]]);
          // 受け取った 3 点は古い待ち注文から（2 点・1 点）、もう 1 つの variant の 2 点は空き在庫。F + A が受け取った数に等しい
          expect(await flow.totals(variantIds[0])).toEqual({ f: 0, a: 3, h: 0 });
          expect(await flow.totals(variantIds[1])).toEqual({ f: 2, a: 0, h: 0 });
          expect([await flow.allocated(fx.older.line), await flow.allocated(fx.newer.line)]).toEqual([2, 1]);
          await expectSane(variantIds);
        },
      };
    } },
    { name: 'public.admin_reverse_purchase_order_receipt', prepare: async () => {
      const fx = await committed(async () => {
        const setup = await flow.setup([3]);
        const received = await flow.receive({ actor: setup.actor, orderId: setup.order.id, version: setup.version, lines: flow.receiveLines(setup.lines, [3]) });
        return { ...setup, received, receiptLines: await flow.receiptLinesOf(received.receiptId) };
      });
      const variantId = fx.fixtures[0].variantId;
      return {
        sql: 'select public.admin_reverse_purchase_order_receipt($1::uuid,$2::integer,$3::uuid,$4::jsonb,$5::text,$6::integer,$7::uuid,$8::uuid) as r',
        params: [fx.order.id, fx.received.version, fx.received.receiptId, JSON.stringify([{ receiptLineId: fx.receiptLines[0].id, quantity: 3 }]), '数量の取消', null, fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes([variantId], [fx.fixtures[0].itemId])],
        check: async (rows) => {
          // 空き在庫が足りるので割当は外さない
          expect(rows[0].r).toMatchObject({ releasedQuantity: 0, replayed: false });
          expect((await flow.linesOf(fx.order.id)).map((line) => [line.received_quantity, line.outstanding_quantity])).toEqual([[0, 3]]);
          expect(await flow.totals(variantId)).toEqual({ f: 0, a: 0, h: 0 });
          expect(await receiptCount(fx.order.id)).toBe(2);
          await expectSane([variantId]);
        },
      };
    } },
    // 原本の 3 関数: 予約・添付・版は追記専用で消せない。確定した行は同じ DB に残り、他の DB 試験は自分の発注書だけを見る
    { name: 'public.admin_reserve_purchase_order_attachment', prepare: async () => {
      const fx = await committed(() => flow.setup([2]));
      return {
        sql: 'select public.admin_reserve_purchase_order_attachment($1::uuid,$2::text,$3::text,$4::uuid,$5::uuid,$6::uuid) as r',
        params: [fx.order.id, 'quote', 'quote.pdf', null, fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(fx.fixtures.map((f) => f.variantId), fx.fixtures.map((f) => f.itemId))],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ replayed: false });
          expect(String(rows[0].r.storagePath).startsWith(`${fx.order.id}/`)).toBe(true);
          expect((await db().query('select count(*)::int as n from public.purchase_order_attachment_reservations where purchase_order_id = $1', [fx.order.id])).rows).toEqual([{ n: 1 }]);
          // 発注書そのものは動かない
          expect((await flow.orderRow(fx.order.id)).version).toBe(fx.version);
        },
      };
    } },
    { name: 'public.admin_attach_purchase_order_document', prepare: async () => {
      const fx = await committed(async () => {
        const setup = await flow.setup([2]);
        return { ...setup, reserved: await reserve(setup.order.id, setup.actor, 'invoice.pdf') };
      });
      return {
        sql: `select public.admin_attach_purchase_order_document($1::uuid,$2::uuid,$3::text,$4::bigint,$5::text,$6::text,$7::date,$8::bigint,$9::text,$10::text,$11::uuid,$12::uuid) as r`,
        params: [fx.reserved.reservationId, fx.order.id, 'application/pdf', 1000, 'ab'.repeat(32), 'server', '2026-10-25', 5000, 'JPY', '工場A', fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(fx.fixtures.map((f) => f.variantId), fx.fixtures.map((f) => f.itemId))],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ revisionNo: 1, replayed: false });
          expect((await db().query(`select count(*)::int as n from public.purchase_order_attachments a
            join public.purchase_order_attachment_revisions r on r.attachment_id = a.id where a.purchase_order_id = $1 and r.revision_no = 1`, [fx.order.id])).rows).toEqual([{ n: 1 }]);
          expect((await flow.orderRow(fx.order.id)).version).toBe(fx.version);
        },
      };
    } },
    { name: 'public.admin_revise_purchase_order_document', prepare: async () => {
      const fx = await committed(async () => {
        const setup = await flow.setup([2]);
        const reserved = await reserve(setup.order.id, setup.actor, 'invoice.pdf');
        return { ...setup, attached: await attach(reserved.reservationId, setup.order.id, setup.actor) };
      });
      return {
        sql: `select public.admin_revise_purchase_order_document($1::uuid,$2::uuid,$3::date,$4::bigint,$5::text,$6::text,$7::boolean,$8::text,$9::uuid,$10::uuid) as r`,
        params: [fx.attached.attachmentId, fx.order.id, '2026-10-26', 6000, 'JPY', '工場A', false, '金額の訂正', fx.actor, randomUUID()],
        probes: [...purchaseProbes(fx.order.id), ...variantProbes(fx.fixtures.map((f) => f.variantId), fx.fixtures.map((f) => f.itemId))],
        check: async (rows) => {
          expect(rows[0].r).toMatchObject({ revisionNo: 2, replayed: false });
          expect((await db().query('select revision_no, amount_yen::int as amount from public.purchase_order_attachment_revisions where attachment_id = $1 order by revision_no', [fx.attached.attachmentId])).rows)
            .toEqual([{ revision_no: 1, amount: 5000 }, { revision_no: 2, amount: 6000 }]);
          expect((await flow.orderRow(fx.order.id)).version).toBe(fx.version);
        },
      };
    } },
  ];

  test.each(ENTRIES)('FREQ-540-AC-08: $name は、別接続が共通 advisory だけを持つ間は行の鍵を取らずに advisory で待ち、放されると完了して数量が保存則を満たす', async ({ prepare }) => {
    const material = await prepare();
    const a = await client();
    const b = await client();
    const c = await client();
    const [blocker, waiter] = [await pid(a), await pid(b)];
    await a.query('begin');
    await a.query('select pg_advisory_xact_lock(190521,1)');
    await b.query('begin');
    const pending = settle(b.query(material.sql, material.params));
    await waitBlocked(db(), waiter, [blocker]);
    // A は共通 advisory のほかに、行の鍵もテーブルの鍵も持たない
    expect((await db().query(`select locktype, mode, granted from pg_catalog.pg_locks
      where pid = $1::int and locktype in ('advisory', 'relation', 'tuple', 'page')`, [blocker])).rows)
      .toEqual([{ locktype: 'advisory', mode: 'ExclusiveLock', granted: true }]);
    // B が待っている間に、C は B がこれから取る行を先に取れる（B は先に行の鍵を持っていない）
    await c.query('begin');
    for (const [sql, params] of material.probes) {
      const taken = (await c.query(sql, params)).rowCount;
      expect({ sql, taken: taken > 0 }).toEqual({ sql, taken: true });
    }
    await c.query('rollback');
    await a.query('rollback');
    const outcome = await pending;
    expect(failure(outcome)).toBe('ok');
    await finish(b, outcome);
    if (outcome.ok) await material.check(outcome.rows);
  });

  // ---- 2. 受け取り対受け取り（FREQ-529-AC-03） ----

  /** 未納 5 の 1 行の発注書 */
  const fiveOrder = () => committed(() => flow.setup([5]));

  test('FREQ-529-AC-03: 同じ発注書へ未納5に対し3+3を別キーで受け取り、2本目が先の受け取りの版を読み直した再送（版+1）なら、片方だけ成功(在庫+3)、もう片方は GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING かつ deadlock 0（同じ画面の版の同時送信は GROUP_G_PO_VERSION_CONFLICT で、次の2つの試験）', async () => {
    const fx = await fiveOrder();
    const receivedOn = await today();
    const lines = [{ lineId: fx.lines[0].id, quantity: 3 }];
    const base = { orderId: fx.order.id, lines, actor: fx.actor, receivedOn };
    // 2 本目は、先の受け取りが作る版（+1）で送る。版の確かめを通った後の未納の確かめ（超過）だけを見る
    const { first, second } = await serial(
      receiveOp({ ...base, version: fx.version }),
      receiveOp({ ...base, version: fx.version + 1 }),
    );
    expect(failure(first)).toBe('ok');
    expect(failure(second)).toEqual({ code: EXCEEDS_REMAINING.code, message: EXCEEDS_REMAINING.message });
    expect(await flow.totals(fx.fixtures[0].variantId)).toEqual({ f: 3, a: 0, h: 0 });
    expect((await flow.linesOf(fx.order.id)).map((line) => [line.received_quantity, line.outstanding_quantity])).toEqual([[3, 2]]);
    expect(await receiptCount(fx.order.id)).toBe(1);
    await expectSane([fx.fixtures[0].variantId]);
  });

  test('FREQ-529-AC-03: 同じ画面の版（版違い）で3+3を別キーで続けて送ると片方だけ成功(在庫+3)、もう片方は GROUP_G_PO_VERSION_CONFLICT かつ deadlock 0', async () => {
    const fx = await fiveOrder();
    const base = { orderId: fx.order.id, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today(), version: fx.version };
    const { first, second } = await serial(receiveOp(base), receiveOp(base));
    expect(failure(first)).toBe('ok');
    expect(failure(second)).toEqual({ code: VERSION_CONFLICT.code, message: VERSION_CONFLICT.message });
    expect(await flow.totals(fx.fixtures[0].variantId)).toEqual({ f: 3, a: 0, h: 0 });
    expect(await receiptCount(fx.order.id)).toBe(1);
    await expectSane([fx.fixtures[0].variantId]);
  });

  test('FREQ-529-AC-03: 2 本を同時に待たせて放しても（先に進んだ方が取引を開いたまま、もう一方がそれを待つ）片方だけ成功(在庫+3)、もう片方は GROUP_G_PO_VERSION_CONFLICT かつ deadlock 0', async () => {
    const fx = await fiveOrder();
    const base = { orderId: fx.order.id, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today(), version: fx.version };
    const result = await race(receiveOp(base), receiveOp(base));
    const outcomes = [result.first, result.second];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map(failure)).toEqual([{ code: VERSION_CONFLICT.code, message: VERSION_CONFLICT.message }]);
    expect(await flow.totals(fx.fixtures[0].variantId)).toEqual({ f: 3, a: 0, h: 0 });
    expect(await receiptCount(fx.order.id)).toBe(1);
    await expectSane([fx.fixtures[0].variantId]);
  });

  test('FREQ-529-AC-03: 同じキーの同時2本の受け取りは1回だけ実行され（在庫+3・受取1件・操作の記録1件）、2本目は同じ結果を replayed で返す', async () => {
    const fx = await fiveOrder();
    const key = randomUUID();
    const op = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today(), key });
    const { first, second } = await serial(op, op);
    expect(failure(first)).toBe('ok');
    expect(failure(second)).toBe('ok');
    const [one, two] = [first, second].map((o) => (o.ok ? o.rows[0].r : null));
    expect(one).toMatchObject({ replayed: false });
    expect(two).toMatchObject({ replayed: true, receiptId: one.receiptId, version: one.version });
    expect(await flow.totals(fx.fixtures[0].variantId)).toEqual({ f: 3, a: 0, h: 0 });
    expect(await receiptCount(fx.order.id)).toBe(1);
    expect(await operationCount('purchase_order_receive', key)).toBe(1);
    await expectSane([fx.fixtures[0].variantId]);
  });

  test('FREQ-529-AC-03: 同じキーの同時2本の発注書の作成は1件だけ作られ、2本目は同じ id を replayed で返す', async () => {
    const fx = await committed(async () => ({ actor: await flow.manager(), fixture: await createCatalogFixture(db(), { stock: 0 }) }));
    const key = randomUUID();
    const create: Op = (c) => c.query('select public.admin_create_purchase_order($1::text,$2::text,$3::jsonb,$4::uuid,$5::uuid) as r',
      ['工場A', null, JSON.stringify([{ variantId: fx.fixture.variantId, quantity: 4 }]), fx.actor, key]);
    const { first, second } = await serial(create, create);
    expect(failure(first)).toBe('ok');
    expect(failure(second)).toBe('ok');
    const [one, two] = [first, second].map((o) => (o.ok ? o.rows[0].r : null));
    expect(one).toMatchObject({ replayed: false });
    expect(two).toMatchObject({ replayed: true, id: one.id, number: one.number });
    expect((await db().query('select count(*)::int as n from public.purchase_order_lines where variant_id = $1', [fx.fixture.variantId])).rows[0].n).toBe(1);
    expect(await operationCount('purchase_order_create', key)).toBe(1);
  });

  // ---- 3. 数量確定対受け取り ----

  test.each([['受け取りが先', true], ['数量の訂正が先', false]] as const)(
    'FREQ-529-AC-03: 数量の訂正と受け取りを同じ画面の版から送ると（%s）一方だけが通り、もう一方は GROUP_G_PO_VERSION_CONFLICT。保存された数量と在庫は通った方だけの結果',
    async (_name, receiveFirst) => {
      const fx = await fiveOrder();
      const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today() });
      const correct = confirmOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 4 }], reason: '数量の訂正', actor: fx.actor });
      const { first, second } = await serial(receiveFirst ? receive : correct, receiveFirst ? correct : receive);
      expect(failure(first)).toBe('ok');
      expect(failure(second)).toEqual({ code: VERSION_CONFLICT.code, message: VERSION_CONFLICT.message });
      const variantId = fx.fixtures[0].variantId;
      const [line] = await flow.linesOf(fx.order.id);
      if (receiveFirst) {
        expect([line.confirmed_quantity, line.received_quantity]).toEqual([5, 3]);
        expect(await flow.totals(variantId)).toEqual({ f: 3, a: 0, h: 0 });
        expect(await receiptCount(fx.order.id)).toBe(1);
      } else {
        expect([line.confirmed_quantity, line.received_quantity]).toEqual([4, 0]);
        expect(await flow.totals(variantId)).toEqual({ f: 0, a: 0, h: 0 });
        expect(await receiptCount(fx.order.id)).toBe(0);
      }
      await expectSane([variantId]);
    },
  );

  test.each([['受け取りが先', true], ['打切りが先', false]] as const)(
    'FREQ-529-AC-03: 残りの打切りと受け取りを同じ画面の版から送ると（%s）一方だけが通り、もう一方は GROUP_G_PO_VERSION_CONFLICT。負けた方は在庫も数量も動かさない',
    async (_name, receiveFirst) => {
      const fx = await fiveOrder();
      const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today() });
      const close: Op = (c) => c.query('select public.admin_short_close_purchase_order($1::uuid,$2::integer,$3::uuid[],$4::text,$5::uuid,$6::uuid) as r',
        [fx.order.id, fx.version, [fx.lines[0].id], '打切り', fx.actor, randomUUID()]);
      const { first, second } = await serial(receiveFirst ? receive : close, receiveFirst ? close : receive);
      expect(failure(first)).toBe('ok');
      expect(failure(second)).toEqual({ code: VERSION_CONFLICT.code, message: VERSION_CONFLICT.message });
      const variantId = fx.fixtures[0].variantId;
      const [line] = await flow.linesOf(fx.order.id);
      const closures = (await db().query(`select count(*)::int as n, coalesce(sum(closed_quantity), 0)::int as quantity
        from public.purchase_order_short_closures where line_id = $1`, [line.id])).rows[0];
      if (receiveFirst) {
        // 受け取りだけが通った: 打切りは何も残らない
        expect([line.confirmed_quantity, line.received_quantity, line.outstanding_quantity]).toEqual([5, 3, 2]);
        expect(await flow.totals(variantId)).toEqual({ f: 3, a: 0, h: 0 });
        expect(await receiptCount(fx.order.id)).toBe(1);
        expect(closures).toEqual({ n: 0, quantity: 0 });
      } else {
        // 打切りだけが通った: 受け取りは在庫も受取も残らない
        expect([line.confirmed_quantity, line.received_quantity, line.outstanding_quantity]).toEqual([0, 0, 0]);
        expect(await flow.totals(variantId)).toEqual({ f: 0, a: 0, h: 0 });
        expect(await receiptCount(fx.order.id)).toBe(0);
        expect(closures).toEqual({ n: 1, quantity: 5 });
      }
      await expectSane([variantId]);
    },
  );

  // ---- 4. G-1 の入荷（admin_record_stock_movement）対受け取り ----

  async function stockAndReceiptMaterial() {
    return committed(async () => {
      const actor = await flow.manager();
      const fixture = await createCatalogFixture(db(), { stock: 0 });
      const older = await flow.waitingOrder(fixture, 2, '2026-01-01');
      const newer = await flow.waitingOrder(fixture, 2, '2026-02-01');
      const confirmed = await confirmedOrder(actor, [{ variantId: fixture.variantId, quantity: 3 }]);
      return { actor, fixture, older, newer, ...confirmed };
    });
  }

  async function expectOldestFirst(fx: Awaited<ReturnType<typeof stockAndReceiptMaterial>>) {
    // 入荷 2 点 + 受け取り 3 点 = 5 点。古い待ち注文 2 点・新しい待ち注文 2 点が満たされ、1 点が空き在庫に残る
    expect(await flow.totals(fx.fixture.variantId)).toEqual({ f: 1, a: 4, h: 0 });
    expect([await flow.allocated(fx.older.line), await flow.allocated(fx.newer.line)]).toEqual([2, 2]);
    expect((await flow.linesOf(fx.order.id)).map((line) => [line.received_quantity, line.outstanding_quantity])).toEqual([[3, 0]]);
    await expectSane([fx.fixture.variantId]);
  }

  test.each([['入荷が先', true], ['受け取りが先', false]] as const)(
    'FREQ-529-AC-03: 同じ variant への通常入荷（admin_record_stock_movement）と発注の受け取りを競合させても（%s）在庫は合計し、古い待ち注文から順に割り当たる',
    async (_name, stockFirst) => {
      const fx = await stockAndReceiptMaterial();
      const stock = stockEntry(fx.fixture, fx.actor, 2);
      const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today() });
      const { first, second } = await serial(stockFirst ? stock : receive, stockFirst ? receive : stock);
      expect(failure(first)).toBe('ok');
      expect(failure(second)).toBe('ok');
      const results = (o: Outcome) => (o.ok ? (o.rows[0].result ?? o.rows[0].r) : null);
      // 先の操作が古い待ち注文から割り当て、後の操作が残りを埋める。入荷が先なら 2 点（古い 2）→ 受け取り 3 点（新しい 2 + 空き 1）、
      // 受け取りが先なら 3 点（古い 2 + 新しい 1）→ 入荷 2 点（新しい 1 + 空き 1）。どちらでも最後は同じ
      expect([results(first).allocatedQuantity, results(second).allocatedQuantity]).toEqual(stockFirst ? [2, 2] : [3, 1]);
      await expectOldestFirst(fx);
    },
  );

  test('FREQ-529-AC-03: 同じ variant への通常入荷と発注の受け取りを同時に待たせて放しても、片方が先に完了し、在庫は合計して古い待ち注文から順に割り当たる（deadlock 0）', async () => {
    const fx = await stockAndReceiptMaterial();
    const stock = stockEntry(fx.fixture, fx.actor, 2);
    const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 3 }], actor: fx.actor, receivedOn: await today() });
    const result = await race(stock, receive);
    expect(failure(result.first)).toBe('ok');
    expect(failure(result.second)).toBe('ok');
    await expectOldestFirst(fx);
  });

  // ---- 5. 受け取り対入金（mark_order_paid 経路） ----

  async function paymentMaterial() {
    return committed(async () => {
      const actor = await flow.manager();
      const fixture = await createCatalogFixture(db(), { stock: 1 });
      const hold = await holdOrder(fixture);
      const older = await flow.waitingOrder(fixture, 1, '2026-01-01');
      const newer = await flow.waitingOrder(fixture, 1, '2026-02-01');
      const confirmed = await confirmedOrder(actor, [{ variantId: fixture.variantId, quantity: 1 }]);
      return { actor, fixture, hold, older, newer, ...confirmed };
    });
  }

  async function expectPaymentAndReceipt(fx: Awaited<ReturnType<typeof paymentMaterial>>) {
    const state = await stateOf(fx.fixture.variantId);
    // 受け取った 1 点は古い待ち注文へ、入金した注文は自分の仮確保の 1 点が支払い済みの割当になる。二重の割当は無く、新しい待ち注文は待ったまま
    expect({ f: state.f, a: state.a, h: state.h }).toEqual({ f: 0, a: 2, h: 0 });
    expect(state.byOrder).toEqual({ [`${fx.older.orderId}:paid`]: 1, [`${fx.hold.orderId}:paid`]: 1 });
    expect(await flow.allocated(fx.newer.line)).toBe(0);
    await expectSane([fx.fixture.variantId]);
  }

  test.each([['入金が先', true], ['受け取りが先', false]] as const)(
    'FREQ-529-AC-03: 同じ variant への発注の受け取りと入金（mark_order_paid）を競合させても（%s）二重に割り当たらず、古い待ち注文が先に満たされる',
    async (_name, payFirst) => {
      const fx = await paymentMaterial();
      const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 1 }], actor: fx.actor, receivedOn: await today() });
      const payment = pay(fx.hold);
      const { first, second } = await serial(payFirst ? payment : receive, payFirst ? receive : payment);
      expect(failure(first)).toBe('ok');
      expect(failure(second)).toBe('ok');
      const [paid, received] = payFirst ? [first, second] : [second, first];
      expect(paid.ok && paid.rows).toEqual([{ updated: true, amount_matches: true }]);
      expect(received.ok && received.rows[0].r).toMatchObject({ allocatedQuantity: 1, replayed: false });
      await expectPaymentAndReceipt(fx);
    },
  );

  test('FREQ-529-AC-03: 発注の受け取りと入金を同時に待たせて放しても、二重に割り当たらず古い待ち注文が先に満たされる（deadlock 0）', async () => {
    const fx = await paymentMaterial();
    const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 1 }], actor: fx.actor, receivedOn: await today() });
    const result = await race(receive, pay(fx.hold));
    expect(failure(result.first)).toBe('ok');
    expect(failure(result.second)).toBe('ok');
    await expectPaymentAndReceipt(fx);
  });

  // ---- 6. 受け取り対返金の結果の記録（record_order_refund_result。取消の返金が受理されると割当が外れて在庫へ戻る書き手） ----

  test.each([['返金の結果の記録が先', 'refund'], ['受け取りが先', 'receive'], ['同時に待たせて放す', 'race']] as const)(
    'FREQ-529-AC-03: 同じ variant への発注の受け取りと支払い済みの注文の取消返金の受理（record_order_refund_result）を競合させても（%s）空いた1点と受け取った1点は合計し、古い待ち注文だけが満たされる',
    async (_name, order) => {
      const fx = await committed(async () => {
        const actor = await flow.manager();
        const fixture = await createCatalogFixture(db(), { stock: 1 });
        const paying = await holdOrder(fixture);
        await pay(paying)(db());
        const older = await flow.waitingOrder(fixture, 1, '2026-01-01');
        const confirmed = await confirmedOrder(actor, [{ variantId: fixture.variantId, quantity: 1 }]);
        // 取消の返金を始めるだけでは割当は外れない（返金の結果が受理された時に外れて在庫へ戻る）。始めた返金は材料として確定する
        const refundId = (await db().query(`select refund_id from public.begin_order_refund($1::uuid,'order_cancel',$2::uuid,'[]'::jsonb,true,
          null,null,null,null,'customer_request',false,$3::uuid,null)`, [paying.orderId, randomUUID(), actor])).rows[0].refund_id as string;
        return { actor, fixture, paying, older, refundId, ...confirmed };
      });
      expect(await flow.totals(fx.fixture.variantId)).toEqual({ f: 0, a: 1, h: 0 });
      const refund: Op = (c) => c.query(`select status, newly_accepted from public.record_order_refund_result($1::uuid,$2::text,'succeeded',
        null,null,null,'card',null,null)`, [fx.refundId, `re_${fx.refundId.replaceAll('-', '')}`]);
      const receive = receiveOp({ orderId: fx.order.id, version: fx.version, lines: [{ lineId: fx.lines[0].id, quantity: 1 }], actor: fx.actor, receivedOn: await today() });
      await withCleanup(async () => {
        let accepted: Outcome;
        if (order === 'race') {
          const raced = await race(refund, receive);
          expect(failure(raced.first)).toBe('ok');
          expect(failure(raced.second)).toBe('ok');
          accepted = raced.first;
        } else {
          const { first, second } = await serial(order === 'refund' ? refund : receive, order === 'refund' ? receive : refund);
          expect(failure(first)).toBe('ok');
          expect(failure(second)).toBe('ok');
          accepted = order === 'refund' ? first : second;
        }
        expect(accepted.ok && accepted.rows).toEqual([{ status: 'succeeded', newly_accepted: true }]);
        // 取り消した注文の割当は外れ、待っていた古い注文が 1 点を得る。もう 1 点は空き在庫（どの順でも同じ最後の状態）
        const state = await stateOf(fx.fixture.variantId);
        expect({ f: state.f, a: state.a, h: state.h }).toEqual({ f: 1, a: 1, h: 0 });
        expect(state.byOrder).toEqual({ [`${fx.older.orderId}:paid`]: 1 });
        await expectSane([fx.fixture.variantId]);
      }, async () => {
        // serial()／race() が途中で投げても、相手の取引（返金の行の鍵や共通の鍵）を開いたままにして、この更新が待たないよう先に放す
        await releaseClients();
        // 返金の記録を宙に浮かせない（追いかけの一覧に残さない）。受理された返金はここで何も変わらない。
        // 試験が受理の前に落ちた時だけ、始めた返金を終わりにする。この更新が G-1 の守りに断られたら、試験が通っていても失敗にする（withCleanup）
        await db().query(`update public.order_refunds set status = 'error', errored_at = now()
          where order_id = $1 and status = 'awaiting_response'`, [fx.paying.orderId]);
      });
    },
  );

  // ---- 7. variant の並びが逆の 2 つの発注書 ----

  async function twoOrdersMaterial() {
    return committed(async () => {
      const actor = await flow.manager();
      const first = await createCatalogFixture(db(), { stock: 0 });
      const second = await createCatalogFixture(db(), { stock: 0 });
      const waiting = {
        firstOlder: await flow.waitingOrder(first, 3, '2026-01-01'), firstNewer: await flow.waitingOrder(first, 2, '2026-02-01'),
        secondOlder: await flow.waitingOrder(second, 4, '2026-01-01'), secondNewer: await flow.waitingOrder(second, 3, '2026-02-01'),
      };
      // 1 つ目は [first 3, second 2]、2 つ目は variant の並びが逆の [second 4, first 1]
      const one = await confirmedOrder(actor, [{ variantId: first.variantId, quantity: 3 }, { variantId: second.variantId, quantity: 2 }]);
      const two = await confirmedOrder(actor, [{ variantId: second.variantId, quantity: 4 }, { variantId: first.variantId, quantity: 1 }]);
      return { actor, first, second, waiting, one, two };
    });
  }

  async function expectTwoOrdersReceived(fx: Awaited<ReturnType<typeof twoOrdersMaterial>>) {
    // first は 3 + 1 = 4 点（古い 3 + 新しい 1）、second は 2 + 4 = 6 点（古い 4 + 新しい 2）。空き在庫は残らない
    expect(await flow.totals(fx.first.variantId)).toEqual({ f: 0, a: 4, h: 0 });
    expect(await flow.totals(fx.second.variantId)).toEqual({ f: 0, a: 6, h: 0 });
    expect([
      await flow.allocated(fx.waiting.firstOlder.line), await flow.allocated(fx.waiting.firstNewer.line),
      await flow.allocated(fx.waiting.secondOlder.line), await flow.allocated(fx.waiting.secondNewer.line),
    ]).toEqual([3, 1, 4, 2]);
    expect((await flow.linesOf(fx.one.order.id)).map((line) => line.received_quantity)).toEqual([3, 2]);
    expect((await flow.linesOf(fx.two.order.id)).map((line) => line.received_quantity)).toEqual([4, 1]);
    await expectSane([fx.first.variantId, fx.second.variantId]);
  }

  const receiveAll = (fx: Awaited<ReturnType<typeof twoOrdersMaterial>>, which: 'one' | 'two', receivedOn: string): Op => {
    const part = fx[which];
    return receiveOp({ orderId: part.order.id, version: part.version, actor: fx.actor, receivedOn,
      lines: flow.receiveLines(part.lines, part.lines.map((line) => line.confirmed_quantity ?? 0)) });
  };

  test('FREQ-529-AC-03: variant の入力順が逆の2つの発注書の受け取りを続けて送っても、同時に待たせて放しても、deadlock 0・二重に割り当たらない', async () => {
    const serialFx = await twoOrdersMaterial();
    const receivedOn = await today();
    const sequential = await serial(receiveAll(serialFx, 'one', receivedOn), receiveAll(serialFx, 'two', receivedOn));
    expect(failure(sequential.first)).toBe('ok');
    expect(failure(sequential.second)).toBe('ok');
    await expectTwoOrdersReceived(serialFx);

    const raceFx = await twoOrdersMaterial();
    const raced = await race(receiveAll(raceFx, 'one', receivedOn), receiveAll(raceFx, 'two', receivedOn));
    expect(failure(raced.first)).toBe('ok');
    expect(failure(raced.second)).toBe('ok');
    await expectTwoOrdersReceived(raceFx);
  });

  // ---- 8. 受け取りの取消対入金・FIFO・棚卸減（FREQ-529-AC-05） ----

  /**
   * 空き在庫 0・古い待ち注文 2 点・新しい待ち注文 2 点に 3 点を受け取った状態（古い 2 点・新しい 1 点が割当済み）から、
   * 2 点を取り消す（割当を 2 点外す入力、確認の数 2）。入金の相手には支払い前の注文の仮確保 1 点を足す。
   */
  async function reverseMaterial(withHold: boolean) {
    const fx = await committed(async () => {
      const actor = await flow.manager();
      const fixture = await createCatalogFixture(db(), { stock: withHold ? 1 : 0 });
      const hold = withHold ? await holdOrder(fixture) : null;
      const older = await flow.waitingOrder(fixture, 2, '2026-01-01');
      const newer = await flow.waitingOrder(fixture, 2, '2026-02-01');
      const confirmed = await confirmedOrder(actor, [{ variantId: fixture.variantId, quantity: 3 }]);
      const received = await flow.receive({ actor, orderId: confirmed.order.id, version: confirmed.version, lines: flow.receiveLines(confirmed.lines, [3]) });
      const receiptLines = await flow.receiptLinesOf(received.receiptId);
      return { actor, fixture, hold, older, newer, ...confirmed, received, receiptLine: receiptLines[0] };
    });
    expect(await flow.totals(fx.fixture.variantId)).toEqual({ f: 0, a: 3, h: withHold ? 1 : 0 });
    expect([await flow.allocated(fx.older.line), await flow.allocated(fx.newer.line)]).toEqual([2, 1]);
    return fx;
  }

  test.each([
    ['入金', 'reverse', true], ['入金', 'peer', true], ['入金', 'race', true],
    ['FIFO（通常入荷）', 'reverse', false], ['FIFO（通常入荷）', 'peer', false], ['FIFO（通常入荷）', 'race', false],
    ['棚卸減（admin_record_stock_movement）', 'reverse', false], ['棚卸減（admin_record_stock_movement）', 'peer', false], ['棚卸減（admin_record_stock_movement）', 'race', false],
  ] as const)(
    'FREQ-529-AC-05: 受け取りの取消（割当を外す入力、確認の数つき）と、同じvariantの注文の%s を競合させても（順: %s）空き在庫は負にならず、同じ割当を二つの操作が外すことは無く（保存則 F+A+H が合う）、deadlock 0',
    async (peer, order, withHold) => {
      const fx = await reverseMaterial(withHold);
      const kind = peer === '入金' ? 'payment' : peer.startsWith('FIFO') ? 'restock' : 'decrease';
      const reverse = reverseOp({ orderId: fx.order.id, version: fx.received.version, receiptId: fx.received.receiptId, receiptLineId: fx.receiptLine.id, quantity: 2, expected: 2, actor: fx.actor });
      const other: Op = kind === 'payment' ? pay(fx.hold!) : stockEntry(fx.fixture, fx.actor, kind === 'restock' ? 1 : -1, kind === 'restock' ? null : 1);
      let outcomes: Outcome[];
      if (order === 'race') {
        const raced = await race(reverse, other);
        outcomes = [raced.first, raced.second];
      } else {
        const result = await serial(order === 'reverse' ? reverse : other, order === 'reverse' ? other : reverse);
        outcomes = order === 'reverse' ? [result.first, result.second] : [result.second, result.first];
      }
      const [reversed, peerOutcome] = outcomes;
      expect(failure(reversed)).toBe('ok');
      expect(failure(peerOutcome)).toBe('ok');
      // どの順でも取消が外すのは 2 点（確認の数のとおり）で、相手の操作の結果も決まった数になる
      expect(reversed.ok && reversed.rows[0].r).toMatchObject({ releasedQuantity: 2, replayed: false });
      if (kind === 'restock') expect(peerOutcome.ok && peerOutcome.rows[0].result).toMatchObject({ allocatedQuantity: 1, releasedQuantity: 0 });
      if (kind === 'decrease') expect(peerOutcome.ok && peerOutcome.rows[0].result).toMatchObject({ releasedQuantity: 1, allocatedQuantity: 0 });

      const state = await stateOf(fx.fixture.variantId);
      // 保存則: 入荷 3 点 - 取消 2 点 + 相手の増減（入金は仮確保の持ち替えで増減なし）に、はじめの仮確保 1 点（入金の時だけ）を足した合計
      const base = withHold ? 1 : 0;
      expect(state.f + state.a + state.h).toBe(base + 3 - 2 + (kind === 'restock' ? 1 : 0) - (kind === 'decrease' ? 1 : 0));
      expect(state.f).toBe(0);
      expect(state.h).toBe(0);
      // 注文ごとの割当の合計は A に等しく、誰の割当が残ったかも決まっている
      expect(Object.values(state.byOrder).reduce((sum, quantity) => sum + quantity, 0)).toBe(state.a);
      const olderKey = `${fx.older.orderId}:paid`;
      if (kind === 'restock') expect(state.byOrder).toEqual({ [olderKey]: 2 });
      if (kind === 'decrease') expect(state.byOrder).toEqual({});
      if (kind === 'payment') {
        const holdKey = `${fx.hold!.orderId}:paid`;
        // 取消が先: 新しい待ち注文の 1 点と古い待ち注文の 1 点が外れ、その後で仮確保が支払い済みになる。
        // 入金が先: 入金した注文が一番新しいので最初に外れ、次に新しい待ち注文が外れて、古い待ち注文の 2 点が残る
        const reverseFirst = { [olderKey]: 1, [holdKey]: 1 };
        const paymentFirst = { [olderKey]: 2 };
        if (order === 'reverse') expect(state.byOrder).toEqual(reverseFirst);
        else if (order === 'peer') expect(state.byOrder).toEqual(paymentFirst);
        else expect([reverseFirst, paymentFirst]).toContainEqual(state.byOrder);
      }
      expect((await flow.linesOf(fx.order.id)).map((line) => line.received_quantity)).toEqual([1]);
      await expectSane([fx.fixture.variantId]);
    },
  );
});
