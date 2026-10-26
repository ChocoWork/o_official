/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithLines } from './helpers/order-fixtures';
import { seedGroupG1Allocation, setOrderStatusForFixture, withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';
import { setGroupG3PaidAt } from './helpers/group-g3-fixtures';
import { seedGroupG4SwapPair } from './helpers/group-g4-fixtures';
import { createPurchaseFlow } from './helpers/purchase-order-flow';

/**
 * G-4 Task 4 (FREQ-523-AC-04): the allocation swap under real concurrency. Committed fresh material per scenario; every
 * observation is scoped to that material's ids. No sleeps decide anything: pg_blocking_pids AND the ungranted common advisory
 * in pg_locks must be observed while the contender is still waiting, before any blocker is released.
 */
jest.setTimeout(120000);
type Op = (client: PgClient) => ReturnType<PgClient['query']>;
type Rows = Awaited<ReturnType<PgClient['query']>>['rows'];
type Outcome = { ok: true; rows: Rows } | { ok: false; code?: string; message?: string };
type Pair = Awaited<ReturnType<typeof seedGroupG4SwapPair>>;
const exceedsDonor = { code: '22023', message: 'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR' };
const exceedsTaker = { code: '22023', message: 'GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER' };

describeLocalDb('G-4 Task 4: allocation swap and its interacting G-1/G-3 entries', (db) => {
  const flow = createPurchaseFlow(db);
  const committed = <T>(run: () => Promise<T>) => withGroupG1FixtureTransaction(db(), run);
  const connections: PgClient[] = [];

  async function client() {
    const c = await connectLocalDb();
    connections.push(c);
    await c.query("set statement_timeout='20s'");
    return c;
  }
  afterEach(async () => {
    // Release every blocker before closing, even when an assertion failed in the middle of a scenario.
    for (const c of connections.splice(0)) {
      await c.query('rollback').catch(() => undefined);
      await c.end().catch(() => undefined);
    }
    await db().query('rollback');
  });
  const pid = async (c: PgClient) => Number((await c.query('select pg_backend_pid() as pid')).rows[0].pid);
  async function waitBlocked(waiter: number, blockers: number[]) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const row = (await db().query(`select
        exists(select 1 from unnest(pg_catalog.pg_blocking_pids($1::int)) b(pid) where b.pid=any($2::int[])) as blocked,
        exists(select 1 from pg_catalog.pg_locks where pid=$1 and locktype='advisory'
          and classid=190521 and objid=1 and objsubid=2 and mode='ExclusiveLock' and not granted) as advisory`, [waiter, blockers])).rows[0];
      if (row.blocked && row.advisory) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G4_ADVISORY_WAIT_NOT_OBSERVED');
  }
  /** Capture only error identifiers, recovering expected errors with SAVEPOINT. */
  async function invoke(c: PgClient, op: Op): Promise<Outcome> {
    await c.query('savepoint g4_operation');
    try {
      const result = await op(c);
      await c.query('release savepoint g4_operation');
      return { ok: true, rows: result.rows };
    } catch (caught) {
      const e = caught as { code?: string; message?: string };
      await c.query('rollback to savepoint g4_operation');
      await c.query('release savepoint g4_operation');
      return { ok: false, code: e.code, message: /^[A-Z_]+$/.test(e.message ?? '') ? e.message : 'DATABASE_ERROR' };
    }
  }
  async function finish(c: PgClient, outcome: Outcome) {
    if (outcome.ok) {
      await c.query('set constraints all immediate');
      await c.query('commit');
    } else await c.query('rollback');
  }
  const resultOf = (o: Outcome) => o.ok ? 'ok' : { code: o.code, message: o.message };
  const noDeadlock = (...outcomes: Outcome[]) => expect(outcomes.map((o) => o.ok ? 'ok' : o.code)).not.toContain('40P01');
  function successful(o: Outcome): Rows {
    expect(resultOf(o)).toBe('ok');
    if (!o.ok) throw new Error('G4_EXPECTED_SUCCESS');
    return o.rows;
  }

  /** Queue both live contenders behind a gate; also observe the loser waiting on the winner. */
  async function race(first: Op, second: Op) {
    const gate = await client(); const a = await client(); const b = await client();
    const [gp, ap, bp] = [await pid(gate), await pid(a), await pid(b)];
    await gate.query('begin'); await gate.query('select pg_advisory_xact_lock(190521,1)');
    await a.query('begin'); await b.query('begin');
    const pa = invoke(a, first); await waitBlocked(ap, [gp]);
    const pb = invoke(b, second); await waitBlocked(bp, [gp, ap]);
    await gate.query('rollback');
    const aWon = await Promise.race([pa.then(() => true), pb.then(() => false)]);
    const [winner, loser, wc, lc, wp, lp] = aWon ? [pa, pb, a, b, ap, bp] : [pb, pa, b, a, bp, ap];
    const winnerOutcome = await winner;
    // A winner whose call failed rolled back to its savepoint and so released the advisory it had just taken: there is nothing
    // left to wait on (both contenders were already proven to wait behind the gate). Only a successful winner keeps the lock.
    if (winnerOutcome.ok) await waitBlocked(lp, [wp]);
    await finish(wc, winnerOutcome);
    await finish(lc, await loser);
    const outcomes = [await pa, await pb] as const;
    noDeadlock(...outcomes);
    return outcomes;
  }
  /** Same race, but the swap queues first or second behind the gate; the result is always [swap, other]. */
  async function raceSwap(swapFirst: boolean, swapOp: Op, otherOp: Op) {
    if (swapFirst) return race(swapOp, otherOp);
    const [other, swapped] = await race(otherOp, swapOp);
    return [swapped, other] as const;
  }

  async function material(options: Parameters<typeof seedGroupG4SwapPair>[1] = {}) {
    return committed(async () => {
      const actor = await flow.manager();
      const fx = await seedGroupG4SwapPair(db(), options);
      return { actor, ...fx };
    });
  }
  const swapIds = (actor: string, order: string, taker: string, donor: string, quantity = 2, key = randomUUID()): Op => (c) => c.query(
    'select public.admin_swap_order_allocations($1,$2,$3,$4,$5,$6,$7) as r', [order, taker, donor, quantity, 'concurrency swap', actor, key]);
  const swap = (actor: string, fx: Pair, quantity = 2, key = randomUUID()) =>
    swapIds(actor, fx.taker.orderId, fx.taker.orderItemId, fx.donor.orderItemId, quantity, key);

  async function totals(variantId: number) {
    return (await db().query(`select v.stock_quantity::int as f,
      coalesce(sum(a.remaining_quantity) filter(where a.kind='paid'),0)::int as a,
      coalesce(sum(a.remaining_quantity) filter(where a.kind='payment_hold'),0)::int as h
      from public.item_variants v left join public.order_item_allocations a on a.variant_id=v.id
      where v.id=$1 group by v.id`, [variantId])).rows[0] as { f: number; a: number; h: number };
  }
  const hand = async (variantId: number) => { const t = await totals(variantId); return t.f + t.a + t.h; };
  async function states(orderId: string, itemId: string) {
    return Object.fromEntries((await db().query(`select status, sum(unit_to-unit_from)::int as n
      from private.group_g_item_state_ranges(array[$1::uuid]) where order_item_id=$2 group by status`, [orderId, itemId]))
      .rows.map((row) => [row.status as string, row.n as number]));
  }
  const allocated = async (itemId: string) => Number((await db().query(`select coalesce(sum(remaining_quantity),0)::int as n
    from public.order_item_allocations where order_item_id=$1 and kind='paid'`, [itemId])).rows[0].n);
  const consumes = async (itemId: string) => Number((await db().query(`select coalesce(sum(e.quantity),0)::int as n
    from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
    where a.order_item_id=$1 and e.event_type='consume'`, [itemId])).rows[0].n);
  async function sane(...variantIds: number[]) {
    for (const variantId of variantIds) {
      expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [variantId])).rows).toEqual([]);
      expect((await totals(variantId)).f).toBeGreaterThanOrEqual(0);
      expect((await db().query(`select count(*)::int as n from public.order_item_allocations where variant_id=$1
        and (remaining_quantity<0 or remaining_quantity>quantity)`, [variantId])).rows[0].n).toBe(0);
    }
  }
  const pairs = async (fx: Pair) => ({ donor: await states(fx.donor.orderId, fx.donor.orderItemId),
    taker: await states(fx.taker.orderId, fx.taker.orderItemId) });

  test('FREQ-523-AC-04: 入替は共通advisoryを待つ間、両注文・明細・割当・variantの行lockを持たず、解放後に保存則を保って完了する', async () => {
    const fx = await material();
    const before = await totals(fx.variantId);
    const a = await client(); const b = await client(); const c = await client();
    const [ap, bp] = [await pid(a), await pid(b)];
    await a.query('begin'); await a.query('select pg_advisory_xact_lock(190521,1)');
    await b.query('begin');
    const pending = invoke(b, swap(fx.actor, fx));
    await waitBlocked(bp, [ap]);
    await c.query('begin');
    const orderIds = [fx.donor.orderId, fx.taker.orderId];
    const itemIds = [fx.donor.orderItemId, fx.taker.orderItemId];
    const probes: Array<[string, unknown[]]> = [
      ['select id from public.orders where id=any($1::uuid[]) for update nowait', [orderIds]],
      ['select id from public.order_items where id=any($1::uuid[]) for update nowait', [itemIds]],
      ['select id from public.order_items where order_id=any($1::uuid[]) for update nowait', [orderIds]],
      ['select id from public.order_item_allocations where order_item_id=any($1::uuid[]) for update nowait', [itemIds]],
      ['select id from public.item_variants where id=$1 for update nowait', [fx.variantId]],
    ];
    for (const [sql, params] of probes) expect((await c.query(sql, params)).rows.length).toBeGreaterThan(0);
    await c.query('rollback'); await a.query('rollback');
    const outcome = await pending; successful(outcome); await finish(b, outcome); noDeadlock(outcome);
    expect(await totals(fx.variantId)).toEqual(before);
    expect(await pairs(fx)).toEqual({ donor: { in_production: 2, ready: 1 }, taker: { ready: 2 } });
    await sane(fx.variantId);
  });

  test('FREQ-523-AC-04: 同じ出し手を2つの受け手が同時に入れ替えると、数が足りる分だけ成功し、割当の総数とFが保たれ、deadlockが0', async () => {
    const first = await material({ donorQuantity: 3, takerQuantity: 2 });
    const second = await committed(() => seedGroupG4SwapPair(db(), { catalog: first, donorQuantity: 3, takerQuantity: 2 }));
    const before = await totals(first.variantId);
    const outcomes = await race(swapIds(first.actor, first.taker.orderId, first.taker.orderItemId, first.donor.orderItemId),
      swapIds(first.actor, second.taker.orderId, second.taker.orderItemId, first.donor.orderItemId));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map(resultOf)).toEqual([exceedsDonor]);
    expect(await totals(first.variantId)).toEqual(before);
    expect(await allocated(first.donor.orderItemId)).toBe(1);
    expect(await allocated(first.taker.orderItemId) + await allocated(second.taker.orderItemId)).toBe(2);
    expect(await allocated(second.donor.orderItemId)).toBe(3);
    await sane(first.variantId);
  });

  test('FREQ-523-AC-04: 注文の組が逆の2つの入替（別variantで donor=o1,taker=o2 と donor=o2,taker=o1）は両方成功し、deadlockが0', async () => {
    const fx = await committed(async () => {
      const actor = await flow.manager();
      const x = await createCatalogFixture(db(), { stock: 3 });
      const y = await createCatalogFixture(db(), { stock: 3 });
      const make = async (xQuantity: number, yQuantity: number, createdAt: string) => {
        const order = await insertOrderWithLines(db(), { status: 'pending', createdAt, lines: [
          { itemId: x.itemId, variantId: x.variantId, quantity: xQuantity, fulfillmentType: 'stock', reserved: false },
          { itemId: y.itemId, variantId: y.variantId, quantity: yQuantity, fulfillmentType: 'stock', reserved: false }] });
        await setGroupG3PaidAt(db(), order.orderId, '2026-10-20T00:00:00Z');
        await setOrderStatusForFixture(db(), [order.orderId], 'paid', { paidAmount: PRICE * (xQuantity + yQuantity) });
        return order;
      };
      const o1 = await make(3, 2, '2026-10-18T00:00:00Z');
      const o2 = await make(2, 3, '2026-10-19T00:00:00Z');
      await seedGroupG1Allocation(db(), { orderItemId: o1.orderItemIds[0], quantity: 3, kind: 'paid' });
      await seedGroupG1Allocation(db(), { orderItemId: o2.orderItemIds[1], quantity: 3, kind: 'paid' });
      return { actor, x, y, o1, o2 };
    });
    const before = [await totals(fx.x.variantId), await totals(fx.y.variantId)];
    const outcomes = await race(
      swapIds(fx.actor, fx.o2.orderId, fx.o2.orderItemIds[0], fx.o1.orderItemIds[0]),
      swapIds(fx.actor, fx.o1.orderId, fx.o1.orderItemIds[1], fx.o2.orderItemIds[1]));
    expect(outcomes.map(resultOf)).toEqual(['ok', 'ok']);
    expect([await totals(fx.x.variantId), await totals(fx.y.variantId)]).toEqual(before);
    expect(await states(fx.o1.orderId, fx.o1.orderItemIds[0])).toEqual({ in_production: 2, ready: 1 });
    expect(await states(fx.o2.orderId, fx.o2.orderItemIds[0])).toEqual({ ready: 2 });
    expect(await states(fx.o1.orderId, fx.o1.orderItemIds[1])).toEqual({ ready: 2 });
    expect(await states(fx.o2.orderId, fx.o2.orderItemIds[1])).toEqual({ in_production: 2, ready: 1 });
    await sane(fx.x.variantId, fx.y.variantId);
  });

  test.each([[true], [false]])('FREQ-523-AC-04: 入替と出し手の票の発送確定は、各順序で片方だけ成功し、消費の裏付けと保存則が合い、deadlockが0（入替が先=%s）', async (swapFirst) => {
    const fx = await material({ donorQuantity: 3, takerQuantity: 2 });
    const slip = (await db().query('select public.admin_save_shipment_slip_draft(null,null,$1::jsonb,$2,$3) as r',
      [JSON.stringify([{ orderItemId: fx.donor.orderItemId, quantity: 3 }]), fx.actor, randomUUID()])).rows[0].r as { id: string; version: number };
    const today = await flow.today();
    const confirm: Op = (c) => c.query('select public.admin_confirm_shipment_slip($1,$2,null,null,$3::date,false,$4,$5) as r',
      [slip.id, slip.version, today, fx.actor, randomUUID()]);
    const outcomes = await raceSwap(swapFirst, swap(fx.actor, fx), confirm);
    expect(outcomes.map(resultOf)).toEqual(swapFirst
      ? ['ok', { code: '22023', message: 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' }]
      : [exceedsDonor, 'ok']);
    if (swapFirst) {
      // The swap came first: the draft is stale, nothing was shipped and the stock is unchanged.
      expect(await consumes(fx.donor.orderItemId)).toBe(0);
      expect(await hand(fx.variantId)).toBe(3);
      expect(await totals(fx.variantId)).toEqual({ f: 0, a: 3, h: 0 });
      expect(await pairs(fx)).toEqual({ donor: { in_production: 2, ready: 1 }, taker: { ready: 2 } });
    } else {
      // The confirmation came first: all three units were consumed and the swap found nothing ready to give.
      expect(await consumes(fx.donor.orderItemId)).toBe(3);
      expect(await hand(fx.variantId)).toBe(0);
      expect(await allocated(fx.taker.orderItemId)).toBe(0);
      expect(await totals(fx.variantId)).toEqual({ f: 0, a: 0, h: 0 });
      expect(await pairs(fx)).toEqual({ donor: { shipped: 3 }, taker: { in_production: 2 } });
    }
    expect((await db().query(`select coalesce(sum(fl.quantity),0)::int n
      from public.order_fulfillment_lines fl join public.order_fulfillments f on f.id=fl.fulfillment_id
      where fl.order_item_id=$1 and f.cancelled_at is null`, [fx.donor.orderItemId])).rows[0].n)
      .toBe(swapFirst ? 0 : 3);
    await sane(fx.variantId);
  });

  test.each([[true], [false]])('FREQ-523-AC-04: 入替と同じvariantの入荷（FIFO）は、各順序で保存則と最古優先が保たれ、deadlockが0（入替が先=%s）', async (swapFirst) => {
    const fx = await material({ donorQuantity: 3, takerQuantity: 2 });
    const restock: Op = (c) => c.query(`select public.admin_record_stock_movement($1::bigint,$2::bigint,2,'restock',null,$3::uuid,$4::uuid,null) as r`,
      [fx.itemId, fx.variantId, fx.actor, randomUUID()]);
    const outcomes = await raceSwap(swapFirst, swap(fx.actor, fx), restock);
    expect(resultOf(outcomes[1])).toBe('ok');
    expect(resultOf(outcomes[0])).toEqual(swapFirst ? 'ok' : exceedsTaker);
    // Only the order waiting at the time of arrival receives FIFO units; an existing allocation is never taken back.
    expect((await db().query(`select a.order_item_id,sum(e.quantity)::int n
      from public.order_item_allocation_events e join public.order_item_allocations a on a.id=e.allocation_id
      where a.variant_id=$1 and e.event_type='allocate' and e.reason='fifo' group by a.order_item_id`, [fx.variantId])).rows)
      .toEqual([{ order_item_id: swapFirst ? fx.donor.orderItemId : fx.taker.orderItemId, n: 2 }]);
    expect(await totals(fx.variantId)).toEqual({ f: 0, a: 5, h: 0 });
    expect(await pairs(fx)).toEqual({ donor: { ready: 3 }, taker: { ready: 2 } });
    await sane(fx.variantId);
  });

  // The advisory queue is first come first served, so the order the two calls queue behind the gate fixes who runs first.
  test.each([[true], [false]])('FREQ-523-AC-04: 入替と出し手の返金開始（begin_order_refund）の競合は、返金が必ず成功し、入替は先なら成功・後なら申請中の拒否で、保存則が保たれ、deadlockが0（入替が先=%s）', async (swapFirst) => {
    const fx = await material({ donorQuantity: 3, takerQuantity: 2 });
    const refund: Op = (c) => c.query(`select * from public.begin_order_refund($1::uuid,'admin',$2::uuid,$3::jsonb,true,0,${PRICE},null,null,null,false,$4::uuid,null)`,
      [fx.donor.orderId, randomUUID(), JSON.stringify([{ order_item_id: fx.donor.orderItemId, quantity: 1, before_shipment: true }]), fx.actor]);
    const outcomes = await raceSwap(swapFirst, swap(fx.actor, fx), refund);
    expect(resultOf(outcomes[1])).toBe('ok');
    if (swapFirst) successful(outcomes[0]);
    else expect(resultOf(outcomes[0])).toEqual({ code: '22023', message: 'GROUP_G_SWAP_DONOR_PENDING_REQUEST' });
    expect(await hand(fx.variantId)).toBe(3);
    expect(await allocated(fx.taker.orderItemId)).toBe(swapFirst ? 2 : 0);
    expect(await allocated(fx.donor.orderItemId)).toBe(swapFirst ? 1 : 3);
    await sane(fx.variantId);
  });

  test.each([[true], [false]])('FREQ-523-AC-04: 入替と受け手の入金の競合は、入金が必ず成功し、入替は先なら未入金の拒否・後なら成功で、保存則が保たれ、deadlockが0（入替が先=%s）', async (swapFirst) => {
    const fx = await material({ donorQuantity: 3, takerQuantity: 2, takerStatus: 'pending' });
    const pay: Op = (c) => c.query(`select updated, amount_matches from public.mark_order_paid($1::uuid,'pending',$2::text,
      (select total_amount from public.orders where id=$1::uuid),'jpy',false,'order_confirmed',null)`,
    [fx.taker.orderId, `pi_${randomUUID().replaceAll('-', '')}`]);
    const outcomes = await raceSwap(swapFirst, swap(fx.actor, fx), pay);
    expect(successful(outcomes[1])).toEqual([{ updated: true, amount_matches: true }]);
    if (swapFirst) expect(resultOf(outcomes[0])).toEqual({ code: '22023', message: 'GROUP_G_SWAP_ORDER_NOT_PAID' });
    else successful(outcomes[0]);
    expect(await hand(fx.variantId)).toBe(3);
    expect(await allocated(fx.taker.orderItemId)).toBe(swapFirst ? 0 : 2);
    expect(await allocated(fx.donor.orderItemId)).toBe(swapFirst ? 3 : 1);
    await sane(fx.variantId);
  });

  test('FREQ-523-AC-04: 同じ鍵・同じ入力の入替が同時に来ても1回だけ実行され、もう一方は同じ結果をreplayed:trueで返す', async () => {
    const fx = await material({ donorQuantity: 3, takerQuantity: 2 }); const key = randomUUID();
    const outcomes = await race(swap(fx.actor, fx, 2, key), swap(fx.actor, fx, 2, key));
    const results = outcomes.map((o) => successful(o)[0].r);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect({ ...results[0], replayed: false }).toEqual({ ...results[1], replayed: false });
    expect((await db().query("select count(*)::int as n from private.group_g_operations where request_key=$1 and operation='allocation_swap'", [key])).rows[0].n).toBe(1);
    expect((await db().query("select count(*)::int as n from public.order_item_allocation_events where operation_id=$1 and event_type='transfer'", [results[0].operationId])).rows[0].n).toBe(2);
    expect(await pairs(fx)).toEqual({ donor: { in_production: 2, ready: 1 }, taker: { ready: 2 } });
    await sane(fx.variantId);
  });
});
