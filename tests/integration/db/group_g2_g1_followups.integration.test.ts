/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { holdsCommonLock, seedGroupG1Allocation, seedGroupG1Shipment, withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';
import { withCleanup } from './helpers/with-cleanup';
import { PRICE, createCatalogFixture, insertCancelRequest, insertOrderWithLines, insertRefundRecord, insertReturnRecord } from './helpers/order-fixtures';

/**
 * G-2 Task 1: G-1 から持ち越した 2 件。
 *  (1) group_g_open_work_order_ids（受注生産の数がありうる注文の先絞り。投影が受注生産と数えうる注文の上位集合）と、
 *      それを使う list_group_g_variant_inventory の waiting（閉じた注文の履歴を毎回投影しない。絞らない投影と同じ数）。
 *      lock_group_g_inventory は変えない。その閉包は、割当（A）も保留（H）も残らない閉じた注文を入れず、開いた注文に加えて
 *      pending・payment_in_progress・期限切れでない失敗の注文も入れる（入金されうる・確保を持ちうるため。
 *      A／H が残る注文は状態に関わらず入る）。
 *  (2) orders.paid_at の最初の値は共通 advisory(190521,1) を持つ接続だけが書ける。
 */
const MIGRATION_DIRECTORY = path.join(process.cwd(), 'supabase/migrations');
const FOUNDATION_FILE = fs.readdirSync(MIGRATION_DIRECTORY).filter((name) => name.endsWith('_group_g2_purchasing_foundation.sql'));

describe('G-2 foundation migration の形（DB なし）', () => {
  test('FREQ-525-AC-03: lock_group_g_inventory は G-2 の移行で置き換えない', () => {
    expect(FOUNDATION_FILE).toHaveLength(1);
    const sql = fs.readFileSync(path.join(MIGRATION_DIRECTORY, FOUNDATION_FILE[0]), 'utf8');
    expect(sql).not.toMatch(/FUNCTION\s+private\.lock_group_g_inventory/i);
    expect(sql).toContain('private.group_g_open_work_order_ids(ARRAY(SELECT w.id FROM wanted AS w))');
  });
});

describeLocalDb('G-2 Task 1: open work orders and the waiting count', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  type Catalog = Awaited<ReturnType<typeof createCatalogFixture>>;

  async function flush() {
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  const backorderLine = (c: Catalog, quantity = 1) =>
    ({ itemId: c.itemId, variantId: c.variantId, quantity, fulfillmentType: 'backorder' as const, reserved: false });
  const shippedInput = () => ({ carrier: 'yamato' as const, trackingNumber: `G2-${randomUUID()}` });

  /** paidAmount を省くと、paid と shipped だけ合計の額を入れる（そのほかの状態は入金の記録なし） */
  async function plainOrder(c: Catalog, status: string, quantity = 1, paidAmount?: number): Promise<string> {
    const shipped = status === 'shipped';
    const amount = paidAmount ?? (shipped || status === 'paid' ? PRICE * quantity : undefined);
    return (await insertOrderWithLines(db(), { status, lines: [backorderLine(c, quantity)],
      ...(amount === undefined ? {} : { paidAmount: amount }),
      ...(shipped ? { shipped: shippedInput() } : {}) })).orderId;
  }

  /** 棚に quantity 点入れて、その分を注文の明細に paid の割当として確保する（A） */
  async function allocatePaid(c: Catalog, orderItemId: string, quantity: number) {
    await db().query(`insert into public.stock_movements (variant_id,delta,reason) values ($1,$2,'restock')`, [c.variantId, quantity]);
    await seedGroupG1Allocation(db(), { orderItemId, quantity, kind: 'paid' });
  }

  /** 発送済みで、全部を発送した注文（共通の押さえの中で作る）。配達まで終えたものにもできる */
  async function shippedOrder(c: Catalog, delivered = true): Promise<{ orderId: string; orderItemId: string; fulfillmentId: string }> {
    const o = await insertOrderWithLines(db(), { status: 'shipped', paidAmount: PRICE, shipped: shippedInput(), lines: [backorderLine(c)] });
    await allocatePaid(c, o.orderItemIds[0], 1);
    const fulfillmentId = await seedGroupG1Shipment(db(), { orderId: o.orderId, lines: [{ orderItemId: o.orderItemIds[0], quantity: 1 }],
      shippedAt: '2026-01-02T00:00:00Z', ...(delivered ? { deliveredAt: '2026-01-04T00:00:00Z' } : {}) });
    return { orderId: o.orderId, orderItemId: o.orderItemIds[0], fulfillmentId };
  }

  /** 発送済みで、未解決の返品・返金・取消申請が無い、実際に配達まで終えた注文 */
  async function deliveredOrder(c: Catalog): Promise<string> {
    return (await shippedOrder(c)).orderId;
  }

  /**
   * 発送済みで、2 点のうち 1 点を発送し、残り 1 点の発送前返金を記録した注文（G-1 の FIFO 試験と同じ作り）。
   * 既定の failed は失敗して残り 1 点が受注生産に戻る形、succeeded は残り 1 点が発送前返金で覆われて取消になる形
   */
  async function preShipmentRefundOrder(c: Catalog, status: 'failed' | 'succeeded' = 'failed'): Promise<string> {
    const o = await insertOrderWithLines(db(), { status: 'shipped', paidAmount: PRICE * 2, shipped: shippedInput(), lines: [backorderLine(c, 2)] });
    await db().query(`insert into public.stock_movements (variant_id,delta,reason) values ($1,1,'restock')`, [c.variantId]);
    await seedGroupG1Allocation(db(), { orderItemId: o.orderItemIds[0], quantity: 1, kind: 'paid' });
    await seedGroupG1Shipment(db(), { orderId: o.orderId, lines: [{ orderItemId: o.orderItemIds[0], quantity: 1 }], shippedAt: '2026-01-02T00:00:00Z' });
    await insertRefundRecord(db(), { orderId: o.orderId, status, lines: [{ orderItemId: o.orderItemIds[0], quantity: 1 }] });
    return o.orderId;
  }
  const failedPreShipmentRefundOrder = (c: Catalog) => preShipmentRefundOrder(c, 'failed');

  /** 注文の明細を 1 回の発送で quantity 点出した記録を直接書く（割当を使わない。入金の記録が無い注文の「発送だけ」の形に使う） */
  async function shipDirectly(orderId: string, orderItemId: string, quantity: number) {
    const id = (await db().query(`insert into public.order_fulfillments
      (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at,delivery_status)
      values ($1,1,$2,'yamato','G2-DIRECT',false,false,'2026-10-20T00:00:00Z','confirmed') returning id`,
    [orderId, randomUUID()])).rows[0].id as string;
    await db().query('insert into public.order_fulfillment_lines values ($1,$2,$3)', [id, orderItemId, quantity]);
  }

  /** 明細の数と明細の番号つきで注文を作る（plainOrder は注文の番号しか返さない） */
  async function orderWithItem(c: Catalog, status: string, quantity: number, paidAmount?: number) {
    const o = await insertOrderWithLines(db(), { status, lines: [backorderLine(c, quantity)],
      ...(paidAmount === undefined ? {} : { paidAmount }), ...(status === 'shipped' ? { shipped: shippedInput() } : {}) });
    return { orderId: o.orderId, orderItemId: o.orderItemIds[0] };
  }

  /**
   * 同じ variant に 3 組の注文を作る。
   *  open: 先絞りが返す注文 11 件（paid・未解決の返品／返金／申請がある発送済み・入金の記録がある pending／failed）
   *  lockOnly: 先絞りは返さないが、lock_group_g_inventory の閉包には入る注文 4 件（入金の記録が無い pending／failed と payment_in_progress 2 件）
   *  closed: どちらも入れない閉じた注文 12 件
   */
  async function mixedOrders(c: Catalog) {
    const open: string[] = [];
    const closed: string[] = [];
    const lockOnly: string[] = [];

    open.push(await plainOrder(c, 'paid'));
    // 入金の記録（paid_amount か paid_at）がある pending／失敗は、投影が入金済みとして数えるので先絞りに残す
    open.push(await plainOrder(c, 'pending', 1, PRICE));
    const pendingWithPaidAt = await plainOrder(c, 'pending');
    await db().query('update public.orders set paid_at = now() where id = $1', [pendingWithPaidAt]);
    open.push(pendingWithPaidAt);
    open.push(await plainOrder(c, 'failed', 1, PRICE));
    lockOnly.push(await plainOrder(c, 'pending'), await plainOrder(c, 'failed'),
      await plainOrder(c, 'payment_in_progress'), await plainOrder(c, 'payment_in_progress', 1, PRICE));
    // 発送済みの注文は全部を発送した本物の形（shippedOrder）で作る。未発送の数が無いので、先絞りに残る理由は未解決の作業だけ
    for (const status of ['requested', 'open'] as const) {
      const id = (await shippedOrder(c)).orderId;
      await insertReturnRecord(db(), { orderId: id, status, lines: [] });
      open.push(id);
    }
    for (const status of ['awaiting_response', 'pending', 'error'] as const) {
      const id = (await shippedOrder(c)).orderId;
      await insertRefundRecord(db(), { orderId: id, status });
      open.push(id);
    }
    const requestedCancel = (await shippedOrder(c)).orderId;
    await insertCancelRequest(db(), { orderId: requestedCancel, lines: [] });
    open.push(requestedCancel);
    open.push(await failedPreShipmentRefundOrder(c));

    // 取消（入金の後の取消で割当も発送も残らないものを含む）・失敗・放棄。取消は割当も発送も無ければ全部が取消の数になる
    closed.push(await plainOrder(c, 'cancelled'), await plainOrder(c, 'cancelled', 1, PRICE));
    for (const status of ['failed', 'abandoned']) {
      closed.push(await plainOrder(c, status), await plainOrder(c, status));
    }
    // lock_group_g_inventory は、期限切れ（stripe_voucher_expired）でない失敗の注文を、まだ入金されうる注文として閉包に入れる。
    // ここでの「失敗」は期限切れで閉じたもの（直近の status の履歴が stripe_voucher_expired）に揃える
    for (const id of closed.slice(2, 4)) {
      await db().query(`insert into public.order_revisions (order_id,operation,before_data,after_data,changed_fields,reason,changed_at)
        values ($1,'status_update','{}',$2::jsonb,$3,'stripe_voucher_expired',$4)`,
      [id, JSON.stringify({ status: 'failed' }), ['status'], '2026-10-24T00:00:00Z']);
    }
    closed.push((await shippedOrder(c, false)).orderId, await deliveredOrder(c));
    const resolvedRefund = (await shippedOrder(c)).orderId;
    await insertRefundRecord(db(), { orderId: resolvedRefund, status: 'succeeded' });
    const closedReturn = (await shippedOrder(c)).orderId;
    await insertReturnRecord(db(), { orderId: closedReturn, status: 'closed', lines: [] });
    const declinedReturn = (await shippedOrder(c)).orderId;
    await insertReturnRecord(db(), { orderId: declinedReturn, status: 'declined', lines: [] });
    const resolvedCancel = (await shippedOrder(c)).orderId;
    await insertCancelRequest(db(), { orderId: resolvedCancel, status: 'resolved', lines: [] });
    closed.push(resolvedRefund, closedReturn, declinedReturn, resolvedCancel);
    await flush();

    expect(open).toHaveLength(11);
    expect(lockOnly).toHaveLength(4);
    expect(closed).toHaveLength(12);
    return { open, closed, lockOnly };
  }

  async function openIds(variantIds: number[] | null): Promise<string[]> {
    return (await db().query('select private.group_g_open_work_order_ids($1::bigint[]) as ids', [variantIds])).rows[0].ids;
  }

  test('FREQ-525-AC-03: group_g_open_work_order_ids は閉じた注文12件と入金の記録が無い pending／failed／payment_in_progress を返さず、paid・入金の記録がある pending／failed・未解決の返金／返品／申請がある shipped の11件を昇順で返す。NULLは全variant', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const { open, closed, lockOnly } = await mixedOrders(c);
    const other = await createCatalogFixture(db(), { stock: 0 });
    const otherOpen = await plainOrder(other, 'paid');
    const otherClosed = await plainOrder(other, 'cancelled');
    await flush();

    const ids = await openIds([c.variantId]);
    expect(ids).toEqual([...open].sort());
    for (const id of [...closed, ...lockOnly, otherOpen, otherClosed]) expect(ids).not.toContain(id);

    // 別の variant の注文は、その variant を指定した時だけ
    expect(await openIds([other.variantId])).toEqual([otherOpen]);
    expect(await openIds([c.variantId, other.variantId, c.variantId])).toEqual([...open, otherOpen].sort());
    // 未知の variant・空の指定は空（全 variant ではない）
    expect(await openIds([])).toEqual([]);
    expect(await openIds([2147483647])).toEqual([]);

    // NULL は全 variant。ほかの試験が残した開いた注文が混ざってもよいので、含む・含まないで確かめる
    const all = await openIds(null);
    expect(all).toEqual([...all].sort());
    for (const id of [...open, otherOpen]) expect(all).toContain(id);
    for (const id of [...closed, ...lockOnly, otherClosed]) expect(all).not.toContain(id);
  });

  test('FREQ-525-AC-03: 発送済みの注文は、未発送で取り消されていない数がある時（発送の記録が無いものを含む）か、未解決の作業がある時だけ先絞りに残る', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const noFulfillment = await plainOrder(c, 'shipped');
    const partiallyShipped = await orderWithItem(c, 'shipped', 2, PRICE * 2);
    await allocatePaid(c, partiallyShipped.orderItemId, 1);
    await seedGroupG1Shipment(db(), { orderId: partiallyShipped.orderId, lines: [{ orderItemId: partiallyShipped.orderItemId, quantity: 1 }],
      shippedAt: '2026-01-02T00:00:00Z' });
    const coveredByRefund = await preShipmentRefundOrder(c, 'succeeded');
    const fullyShipped = (await shippedOrder(c)).orderId;
    const failedRefund = await failedPreShipmentRefundOrder(c);
    // 取消の注文でも、発送の記録があれば先絞りに残る（投影が残りの数を数えうる。数えない形でも落とさない既知の費用）
    const cancelledWithShipment = await orderWithItem(c, 'cancelled', 1, PRICE);
    await shipDirectly(cancelledWithShipment.orderId, cancelledWithShipment.orderItemId, 1);
    await flush();

    const ids = await openIds([c.variantId]);
    expect(ids).toEqual([noFulfillment, partiallyShipped.orderId, failedRefund, cancelledWithShipment.orderId].sort());
    for (const id of [coveredByRefund, fullyShipped]) expect(ids).not.toContain(id);
  });

  // lock_group_g_inventory の閉包は「開いた注文だけ」ではない。入金されうる・確保（H）を持ちうる pending・payment_in_progress・
  // 期限切れでない失敗の注文も入れ、割当（A）か保留（H）が残る注文は状態に関わらず入れる（G-1）。この移行はそれを変えない。
  // 割当も保留も残らない閉じた注文（取消・期限切れの失敗・放棄・未解決なしの発送済み）は入れない
  test('FREQ-525-AC-03: lock_group_g_inventory の閉包に閉じた注文12件は入らず、開いた注文11件に加えて pending・payment_in_progress・期限切れでない失敗の4件が入る', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const { open, closed, lockOnly } = await mixedOrders(c);

    const locked: string[] = (await db().query('select private.lock_group_g_inventory($1,$2) as ids', [[c.variantId], []])).rows[0].ids;

    expect([...locked].sort()).toEqual([...open, ...lockOnly].sort());
    for (const id of closed) expect(locked).not.toContain(id);
  });

  test('FREQ-525-AC-03: list_group_g_variant_inventory の waiting は閉じた注文（取消・失敗・放棄・配達まで終えた発送済み）を数えず、未発送の数がある発送済みの注文は G-1 のとおり数える', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const openPaid = await plainOrder(c, 'paid', 2);
    // 発送の記録が無い発送済みの注文は未発送の数を持つので、G-1 の投影は受注生産と数える（先絞りも残す）
    const unshipped = [await plainOrder(c, 'shipped'), await plainOrder(c, 'shipped'), await plainOrder(c, 'shipped')];
    const closed = [await plainOrder(c, 'cancelled'), await plainOrder(c, 'failed'), await plainOrder(c, 'abandoned'), await deliveredOrder(c)];
    await flush();

    const rows = (await db().query('select * from public.list_group_g_variant_inventory($1)', [[c.variantId]])).rows;
    expect(rows).toEqual([{ variant_id: String(c.variantId), free: 0, paid_allocated: 0, payment_held: 0, on_hand: 0, waiting: 5 }]);

    const states = (await db().query(`select coalesce(sum(s.quantity), 0)::int as waiting
      from public.list_admin_order_item_states($1) as s where s.status = 'in_production'`, [[openPaid, ...unshipped]])).rows[0];
    expect(states.waiting).toBe(5);
    const closedStates = (await db().query(`select count(*)::int as n
      from public.list_admin_order_item_states($1) as s where s.status = 'in_production'`, [closed])).rows[0];
    expect(closedStates.n).toBe(0);
  });

  /** 絞らない投影: その variant の明細を持つ全注文を group_g_item_state_ranges に通した、受注生産の数と、その数を持つ注文の id */
  async function unfilteredProjection(variantId: number) {
    const orderIds = 'array(select distinct x.order_id from public.order_items x where x.variant_id = $1::bigint)';
    const waiting = (await db().query(`select coalesce(sum(s.unit_to - s.unit_from), 0)::int as n
      from private.group_g_item_state_ranges(${orderIds}) s join public.order_items oi on oi.id = s.order_item_id
      where s.status = 'in_production' and oi.variant_id = $1::bigint`, [variantId])).rows[0].n as number;
    const orders = (await db().query(`select distinct s.order_id from private.group_g_item_state_ranges(${orderIds}) s
      join public.order_items oi on oi.id = s.order_item_id
      where s.status = 'in_production' and oi.variant_id = $1::bigint order by 1`, [variantId])).rows.map((row) => row.order_id as string);
    return { waiting, orders };
  }

  test('FREQ-525-AC-03: 先絞りは投影が受注生産と数える注文の上位集合で、list_group_g_variant_inventory の waiting は絞らない投影と variant ごとに同じ', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const c2 = await createCatalogFixture(db(), { stock: 0 });
    const withItem = (status: string, quantity: number, paidAmount?: number) => orderWithItem(c, status, quantity, paidAmount);

    // 受注生産の数を持つ注文
    const paid = await plainOrder(c, 'paid', 2);
    const paidPartial = await withItem('paid', 3, PRICE * 3);
    await allocatePaid(c, paidPartial.orderItemId, 1);
    const pendingPaid = await plainOrder(c, 'pending', 2, PRICE * 2);
    const pendingPaidAt = await plainOrder(c, 'pending');
    await db().query('update public.orders set paid_at = now() where id = $1', [pendingPaidAt]);
    const failedPaid = await plainOrder(c, 'failed', 2, PRICE * 2);
    const paidWithCancelRequest = await withItem('paid', 2, PRICE * 2);
    await insertCancelRequest(db(), { orderId: paidWithCancelRequest.orderId, lines: [{ orderItemId: paidWithCancelRequest.orderItemId, quantity: 1 }] });
    const failedPreShipment = await failedPreShipmentRefundOrder(c);
    // 取消の後でも、paid の割当が残っていれば投影はその分を入金済みとして数える（残りは受注生産）
    const cancelledWithAllocation = await withItem('cancelled', 2, PRICE * 2);
    await allocatePaid(c, cancelledWithAllocation.orderItemId, 1);
    // 入金の記録が無くても、paid の割当だけ・発送だけがあれば投影は入金済みとして数える
    const pendingWithAllocationOnly = await withItem('pending', 2);
    await allocatePaid(c, pendingWithAllocationOnly.orderItemId, 1);
    const failedWithShipmentOnly = await withItem('failed', 2);
    await shipDirectly(failedWithShipmentOnly.orderId, failedWithShipmentOnly.orderItemId, 1);
    // 取消の注文に発送の記録があれば、残りの数を数える
    const cancelledWithShipment = await withItem('cancelled', 2, PRICE * 2);
    await shipDirectly(cancelledWithShipment.orderId, cancelledWithShipment.orderItemId, 1);
    // 発送の記録が無い発送済みの注文は未発送の数を持つ（G-1 は受注生産と数える）
    const shippedNoFulfillment = await plainOrder(c, 'shipped');
    // 受注生産の数を持たない注文（入金の記録が無い・取消・放棄・支払い手続き中・全部発送済み・残りが発送前返金で覆われた発送済み）
    const coveredByRefund = await preShipmentRefundOrder(c, 'succeeded');
    const pendingUnpaid = await plainOrder(c, 'pending');
    const failedUnpaid = await plainOrder(c, 'failed');
    const cancelledAfterPayment = await plainOrder(c, 'cancelled', 1, PRICE);
    const abandonedPaid = await plainOrder(c, 'abandoned', 1, PRICE);
    const inProgressPaid = await plainOrder(c, 'payment_in_progress', 1, PRICE);
    const delivered = await shippedOrder(c);
    const shippedWithReturn = await shippedOrder(c);
    await insertReturnRecord(db(), { orderId: shippedWithReturn.orderId, status: 'open', lines: [{
      fulfillmentId: shippedWithReturn.fulfillmentId, orderItemId: shippedWithReturn.orderItemId, quantity: 1 }] });
    const shippedWithRefund = await shippedOrder(c);
    await insertRefundRecord(db(), { orderId: shippedWithRefund.orderId, status: 'pending',
      lines: [{ orderItemId: shippedWithRefund.orderItemId, quantity: 1, beforeShipment: false }] });
    // 2 つめの variant
    const second = await plainOrder(c2, 'paid');
    const secondPending = await plainOrder(c2, 'pending', 1, PRICE);
    await shippedOrder(c2);
    await flush();

    const producing = [paid, paidPartial.orderId, pendingPaid, pendingPaidAt, failedPaid, paidWithCancelRequest.orderId, failedPreShipment,
      cancelledWithAllocation.orderId, pendingWithAllocationOnly.orderId, failedWithShipmentOnly.orderId, cancelledWithShipment.orderId,
      shippedNoFulfillment];
    const notProducing = [pendingUnpaid, failedUnpaid, cancelledAfterPayment, abandonedPaid, inProgressPaid, delivered.orderId, coveredByRefund];

    for (const [variant, expectedOrders] of [[c.variantId, producing], [c2.variantId, [second, secondPending]]] as const) {
      const projection = await unfilteredProjection(variant);
      const kept = await openIds([variant]);
      const waiting = (await db().query('select waiting from public.list_group_g_variant_inventory($1)', [[variant]])).rows[0].waiting;

      expect(projection.orders).toEqual(expect.arrayContaining([...expectedOrders]));
      expect(kept).toEqual(expect.arrayContaining(projection.orders));
      expect(waiting).toBe(projection.waiting);
    }
    // 先絞りが空でなく、受注生産の数を持つ注文の分は落とさない
    expect((await unfilteredProjection(c.variantId)).waiting).toBeGreaterThanOrEqual(9);
    expect((await unfilteredProjection(c2.variantId)).waiting).toBe(2);
    // 受注生産の数を持たない注文は、投影も先絞りも数えない
    const projectedC = (await unfilteredProjection(c.variantId)).orders;
    const keptC = await openIds([c.variantId]);
    for (const id of notProducing) {
      expect(projectedC).not.toContain(id);
      expect(keptC).not.toContain(id);
    }
    // 未解決の返品・返金がある発送済みは先絞りに残る（受注生産の数は無い）
    expect(keptC).toEqual(expect.arrayContaining([shippedWithReturn.orderId, shippedWithRefund.orderId]));
    expect(projectedC).not.toContain(shippedWithReturn.orderId);
    expect(projectedC).not.toContain(shippedWithRefund.orderId);
  });

  test('置換した関数は署名・所有者・ACL・戻り型・volatility を G-1 のまま保つ', async () => {
    const read = async (sig: string) => (await db().query(`select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
        p.provolatile as volatility, l.lanname as language, p.proconfig as config, pg_get_function_result(p.oid) as result,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute
      from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [sig])).rows[0];
    const table = 'TABLE(variant_id bigint, free integer, paid_allocated integer, payment_held integer, on_hand integer, waiting integer)';
    const search = ['search_path=""'];

    expect(await read('private.list_group_g_variant_inventory(bigint[])')).toEqual({ owner: 'postgres', definer: true, volatility: 's',
      language: 'plpgsql', config: search, result: table, service_role: true, anon: false, authenticated: false, public_can_execute: false });
    expect(await read('public.list_group_g_variant_inventory(bigint[])')).toEqual({ owner: 'postgres', definer: false, volatility: 's',
      language: 'sql', config: search, result: table, service_role: true, anon: false, authenticated: false, public_can_execute: false });
    expect(await read('private.group_g_open_work_order_ids(bigint[])')).toEqual({ owner: 'postgres', definer: true, volatility: 's',
      language: 'sql', config: search, result: 'uuid[]', service_role: false, anon: false, authenticated: false, public_can_execute: false });
    expect(await read('private.guard_group_g_paid_at()')).toEqual({ owner: 'postgres', definer: false, volatility: 'v',
      language: 'plpgsql', config: search, result: 'trigger', service_role: false, anon: false, authenticated: false, public_can_execute: false });
    expect((await db().query(`select t.tgtype::int as type, t.tgenabled::text as enabled from pg_trigger t
      where t.tgrelid = 'public.orders'::regclass and t.tgname = 'orders_paid_at_once'
        and t.tgfoid = 'private.guard_group_g_paid_at()'::regprocedure`)).rows).toEqual([{ type: 19, enabled: 'O' }]);
  });

  // G-2 Task 9（Task 1 の確かめ直しで残った点）: 先絞りの発送済みの注文ごとの合計と、未解決の作業の探し方が引く列には、
  // 先頭の列が全行を覆う索引がすでにある（新しい索引は要らない）。消えたらここで気づく。実測の計画は Task 9 の報告に書いた。
  test('FREQ-525-AC-03: group_g_open_work_order_ids の発送済みの合計・未解決の作業の探し方が引く列には、全行を覆う索引が先頭の列にある', async () => {
    const leading = async (table: string) => (await db().query(`select a.attname::text as column_name
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
      where n.nspname = 'public' and c.relname = $1 and i.indisvalid and i.indpred is null`, [table])).rows.map((row) => row.column_name as string);
    const wanted: Array<[string, string]> = [
      ['order_fulfillment_lines', 'order_item_id'], ['order_refund_lines', 'order_item_id'], ['order_items', 'order_id'],
      ['order_item_allocations', 'order_item_id'], ['order_returns', 'order_id'], ['order_refunds', 'order_id'],
      ['order_cancel_requests', 'order_id'], ['order_fulfillments', 'id'], ['order_refunds', 'id'], ['orders', 'status'],
    ];
    for (const [table, column] of wanted) {
      expect({ table, column, indexed: (await leading(table)).includes(column) }).toEqual({ table, column, indexed: true });
    }
  });
});

describeLocalDb('G-2 Task 1: orders.paid_at needs the common advisory for its first value', (db) => {
  // この組は共通 advisory を取らずに始める（取るのは試験の中で決めた所だけ）
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => {
    await db().query('rollback');
    await db().query('select pg_catalog.pg_advisory_unlock_all()');
  });

  const LOCK_REQUIRED = { code: '55000', message: 'GROUP_G_INVENTORY_LOCK_REQUIRED' };
  const IMMUTABLE = { code: '55000', message: 'GROUP_G_PAID_AT_IMMUTABLE' };

  async function newOrder(status = 'payment_in_progress'): Promise<string> {
    const c = await createCatalogFixture(db(), { stock: 0 });
    return (await insertOrderWithLines(db(), { status,
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'backorder', reserved: false }] })).orderId;
  }

  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try { await run(); return {}; } catch (e) {
      const error = e as { code?: string; message?: string };
      return { code: error.code, message: error.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  const setPaidAt = (orderId: string, value = 'now()') =>
    db().query(`update public.orders set paid_at = ${value} where id = $1`, [orderId]);
  const paidAt = async (orderId: string) =>
    (await db().query('select paid_at from public.orders where id = $1', [orderId])).rows[0].paid_at as Date | null;
  /** 注文が持つ割当（仮確保・支払い済み）の残りの合計 */
  const holdLeft = async (orderId: string) => (await db().query(`select coalesce(sum(a.remaining_quantity), 0)::int as n
    from public.order_item_allocations a join public.order_items oi on oi.id = a.order_item_id where oi.order_id = $1`, [orderId])).rows[0].n as number;

  test('FREQ-535-AC-01: 共通 advisory 無しの NULL→値は GROUP_G_INVENTORY_LOCK_REQUIRED / 55000 で何も書かれない', async () => {
    const orderId = await newOrder();
    expect(await holdsCommonLock(db())).toBe(false);

    expect(await rejected(() => setPaidAt(orderId))).toEqual(LOCK_REQUIRED);
    expect(await paidAt(orderId)).toBeNull();
  });

  test('FREQ-535-AC-01: 共有モードの押さえや別の鍵の押さえでは足りない（ExclusiveLock の (190521,1) だけ）', async () => {
    const orderId = await newOrder();

    await db().query('select pg_catalog.pg_advisory_xact_lock_shared(190521,1)');
    expect(await holdsCommonLock(db())).toBe(false);
    expect(await rejected(() => setPaidAt(orderId))).toEqual(LOCK_REQUIRED);
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,2)');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190522,1)');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521)');
    expect(await holdsCommonLock(db())).toBe(false);
    expect(await rejected(() => setPaidAt(orderId))).toEqual(LOCK_REQUIRED);
    expect(await paidAt(orderId)).toBeNull();
  });

  test('FREQ-535-AC-01: 共通 advisory を持つ取引では NULL→値が通り、値→別の値/NULLは GROUP_G_PAID_AT_IMMUTABLE のまま', async () => {
    const orderId = await newOrder();
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');

    await setPaidAt(orderId);
    const first = await paidAt(orderId);
    expect(first).not.toBeNull();
    expect(await rejected(() => setPaidAt(orderId, "paid_at + interval '1 day'"))).toEqual(IMMUTABLE);
    expect(await rejected(() => setPaidAt(orderId, 'null'))).toEqual(IMMUTABLE);
    // 同じ値の再書込みは通り、値は変わらない
    await db().query('update public.orders set paid_at = paid_at where id = $1', [orderId]);
    expect(await paidAt(orderId)).toEqual(first);
  });

  test('FREQ-535-AC-01: 押さえを手放した後でも、値→別の値/NULL は LOCK_REQUIRED ではなく GROUP_G_PAID_AT_IMMUTABLE（service_role の役も）', async () => {
    const orderId = await newOrder();
    await db().query('select pg_catalog.pg_advisory_lock(190521,1)');
    await setPaidAt(orderId);
    expect((await db().query('select pg_catalog.pg_advisory_unlock(190521,1) as released')).rows[0].released).toBe(true);
    expect(await holdsCommonLock(db())).toBe(false);

    expect(await rejected(() => setPaidAt(orderId, "paid_at + interval '1 day'"))).toEqual(IMMUTABLE);
    expect(await rejected(() => setPaidAt(orderId, 'null'))).toEqual(IMMUTABLE);
    expect(await rejected(async () => {
      await db().query('set local role service_role');
      await setPaidAt(orderId, 'null');
    })).toEqual(IMMUTABLE);
    expect((await db().query('select current_user as u')).rows[0].u).toBe('postgres');
  });

  test('FREQ-535-AC-01: service_role の役でも、押さえが無ければ最初の値は書けず、押さえがあれば書ける', async () => {
    const orderId = await newOrder();

    expect(await rejected(async () => {
      await db().query('set local role service_role');
      await setPaidAt(orderId);
    })).toEqual(LOCK_REQUIRED);

    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await db().query('set local role service_role');
    await setPaidAt(orderId);
    await db().query('reset role');
    expect(await paidAt(orderId)).not.toBeNull();
  });

  test('FREQ-535-AC-01: mark_order_paid の経路は自分で共通 advisory を取るので、押さえの無い取引から呼んでも最初の入金の時刻を書ける', async () => {
    // 材料は先に確定し、押さえを手放してから入金の関数だけを新しい取引で呼ぶ
    await db().query('rollback');
    const orderId = await withGroupG1FixtureTransaction(db(), async () => {
      const c = await createCatalogFixture(db(), { stock: 1 });
      return (await insertOrderWithLines(db(), { status: 'payment_in_progress',
        lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock' }] })).orderId;
    });
    await db().query('begin');
    const abandoned: { released?: { rows: unknown[] } } = {};
    await withCleanup(async () => {
      expect(await holdsCommonLock(db())).toBe(false);

      const result = (await db().query(`select updated, amount_matches, needs_review from public.mark_order_paid(
        $1::uuid, 'payment_in_progress'::public.order_status, $2::text, $3::integer, 'jpy', true, 'order_confirmed', $4::text)`,
      [orderId, `pi_${randomUUID().replaceAll('-', '')}`, PRICE, null])).rows[0];

      expect(result).toEqual({ updated: true, amount_matches: true, needs_review: false });
      expect(await holdsCommonLock(db())).toBe(true);
      expect(await paidAt(orderId)).not.toBeNull();
    }, async () => {
      // 材料は押さえを持たない取引から呼ぶために先に確定した物（注文は消せない）。入金はこの取引ごと戻し、
      // 支払い前の注文は放棄にして仮確保の 1 点を空き在庫へ戻す（試験の後に仮確保を持つ注文を残さない）。
      // 後始末の失敗は、試験が通った時だけ失敗にする（試験の失敗を上書きしない）。結果の確かめは後始末の外で行う
      await db().query('rollback');
      await db().query('select pg_catalog.pg_advisory_unlock_all()');
      abandoned.released = await withGroupG1FixtureTransaction(db(), () => db().query(
        `select released from public.release_stock_for_unpaid_order($1::uuid, 'payment_in_progress', 'abandoned', 'stripe_checkout_expired')`, [orderId]));
    });
    expect(abandoned.released?.rows).toEqual([{ released: true }]);
    expect((await db().query('select status::text as status from public.orders where id = $1', [orderId])).rows).toEqual([{ status: 'abandoned' }]);
    expect(await holdLeft(orderId)).toBe(0);
  });
});
