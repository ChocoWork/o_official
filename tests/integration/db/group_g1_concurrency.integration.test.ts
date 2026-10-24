/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { addItemVariant, createCatalogFixture, createDraft, createShippedOrderFixture, insertOrderWithLines,
  insertReturnRecord, insertReturnReceipt, insertRefundRecord, insertCancelRequest } from './helpers/order-fixtures';
import { withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';

// This inventory is Task 4's entry point. Tasks 5-13 must add their public writers to the same boundary test.
const ENTRIES = [{ name: 'private.lock_group_g_inventory(bigint[],uuid[],uuid)',
  sql: 'select private.lock_group_g_inventory($1::bigint[],$2::uuid[],$3::uuid)' }];

describeLocalDb('G-1 advisory-first locking across separate connections', (db) => {
  async function client() {
    const c = await connectLocalDb();
    await c.query("set statement_timeout='10s'");
    return c;
  }

  async function waitForAdvisory(observer: PgClient, waiter: number, blocker: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = (await observer.query(`select $2::int=any(pg_catalog.pg_blocking_pids($1::int)) as blocked,
        exists(select 1 from pg_catalog.pg_locks where pid=$3::int and locktype='advisory'
          and classid=190521 and objid=1 and objsubid=2 and not granted) as advisory`, [waiter, blocker, waiter])).rows[0];
      if (r.blocked && r.advisory) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('G1_ADVISORY_WAIT_NOT_OBSERVED');
  }

  async function pid(c: PgClient) { return (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number; }

  test.each(ENTRIES)('$name waits for advisory before locking any existing business row', async ({ sql }) => {
    const material = await withGroupG1FixtureTransaction(db(), async () => {
      const fx = await createShippedOrderFixture(db(), { lines: [{ quantity: 4 }], shipments: [{ lines: [{ lineIndex: 0, quantity: 1 }] }] });
      const draft = await createDraft(db(), { itemId: fx.itemIds[0] });
      const exchange = { itemId: fx.itemIds[0], ...(await addItemVariant(db(), {
        itemId: fx.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 0,
      })) };
      const extra = await createCatalogFixture(db(), { stock: 0 });
      const waiting = await insertOrderWithLines(db(), { status: 'paid', lines: [
        { itemId: exchange.itemId, variantId: exchange.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false },
        { itemId: extra.itemId, variantId: extra.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false },
      ] });
      const ret = await insertReturnRecord(db(), { orderId: fx.orderId, lines: [{ orderItemId: fx.orderItemIds[0],
        fulfillmentId: fx.fulfillments[0].id, quantity: 1, resolution: 'exchange', exchangeVariantId: exchange.variantId }] });
      await insertReturnReceipt(db(), { returnId: ret.returnId, lines: [{ returnLineId: ret.lineIds[0], quantity: 1, disposition: 'pending_inspection' }] });
      await insertRefundRecord(db(), { orderId: fx.orderId, lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }] });
      await insertCancelRequest(db(), { orderId: fx.orderId, lines: [{ orderItemId: fx.orderItemIds[0], quantity: 1 }] });
      return { ...fx, draftId: draft.draftId, exchangeVariant: exchange.variantId, extraVariant: extra.variantId,
        closedItems: [...fx.itemIds, exchange.itemId, extra.itemId],
        closedVariants: [...fx.variantIds, exchange.variantId, extra.variantId],
        closedOrders: [fx.orderId, waiting.orderId].sort() };
    });
    const a = await client();
    const b = await client();
    const c = await client();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query('begin');
      await a.query('select pg_advisory_xact_lock(190521,1)');
      await b.query('begin');
      const blocker = await pid(a);
      const waiter = await pid(b);
      pending = b.query(sql, [[...material.variantIds].reverse(), [material.orderId], material.draftId]);
      // Attach a handler immediately so a timeout cannot become an unhandled rejection during observation.
      void pending.catch(() => {});
      await waitForAdvisory(c, waiter, blocker);
      await c.query('begin');
      const probes: Array<[string, unknown[]]> = [
        ['select id from public.checkout_drafts where id=$1 for update nowait', [material.draftId]],
        ['select id from public.items where id=any($1::bigint[]) for update nowait', [material.closedItems]],
        ['select id from public.item_variants where id=any($1::bigint[]) for update nowait', [material.closedVariants]],
        ['select id from public.orders where id=any($1::uuid[]) for update nowait', [material.closedOrders]],
        ['select id from public.order_items where order_id=any($1::uuid[]) for update nowait', [material.closedOrders]],
        ['select id from public.order_item_allocations where order_item_id=any($1::uuid[]) for update nowait', [material.orderItemIds]],
        ['select id from public.order_returns where order_id=$1 for update nowait', [material.orderId]],
        ['select l.id from public.order_return_lines l join public.order_returns r on r.id=l.return_id where r.order_id=$1 for update of l nowait', [material.orderId]],
        ['select x.id from public.order_return_receipts x join public.order_returns r on r.id=x.return_id where r.order_id=$1 for update of x nowait', [material.orderId]],
        ['select l.id from public.order_return_receipt_lines l join public.order_return_lines x on x.id=l.return_line_id join public.order_returns r on r.id=x.return_id where r.order_id=$1 for update of l nowait', [material.orderId]],
        ['select id from public.order_refunds where order_id=$1 for update nowait', [material.orderId]],
        ['select l.id from public.order_refund_lines l join public.order_refunds r on r.id=l.refund_id where r.order_id=$1 for update of l nowait', [material.orderId]],
        ['select id from public.order_cancel_requests where order_id=$1 for update nowait', [material.orderId]],
        ['select l.order_item_id from public.order_cancel_request_lines l join public.order_cancel_requests r on r.id=l.cancel_request_id where r.order_id=$1 for update of l nowait', [material.orderId]],
      ];
      for (const [probe, params] of probes) expect((await c.query(probe, params)).rowCount).toBeGreaterThan(0);
      await c.query('rollback');
      await a.query('rollback');
      await expect(pending).resolves.toMatchObject({ rows: [{ lock_group_g_inventory: material.closedOrders }] });
      await b.query('set constraints all immediate');
      // The exchange variant belongs to the closed target set even though it has no order item yet.
      await c.query('begin');
      await c.query('savepoint locked_variant');
      await expect(c.query('select id from public.item_variants where id=$1 for update nowait', [material.extraVariant]))
        .rejects.toMatchObject({ code: '55P03' });
      await c.query('rollback to savepoint locked_variant');
    } finally {
      await a.query('rollback');
      if (pending) await pending.catch(() => {});
      await b.query('rollback');
      await c.query('rollback');
      await Promise.all([a.end(), b.end(), c.end()]);
    }
  });

  async function waitingOrders(variants = 1) {
    return withGroupG1FixtureTransaction(db(), async () => {
      const catalogs = [];
      for (let i = 0; i < variants; i++) catalogs.push(await createCatalogFixture(db(), { stock: 0 }));
      const orders = [];
      for (let i = 0; i < 2; i++) {
        const o = await insertOrderWithLines(db(), { status: 'paid', createdAt: `2026-0${i + 1}-01`, lines: catalogs.map((c) => ({
          itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'stock' as const, reserved: false,
        })) });
        orders.push(o);
      }
      return { variants: catalogs.map((c) => c.variantId), orders };
    });
  }

  async function receipt(c: PgClient, variants: number[]) {
    const orderIds = (await c.query('select private.lock_group_g_inventory($1,$2) as ids', [variants, []])).rows[0].ids;
    const before = (await c.query('select private.capture_group_g_item_states($1) as states', [orderIds])).rows[0].states;
    const op = randomUUID();
    await c.query(`insert into private.group_g_operations(id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values($1,'concurrency_test',$2,repeat('c',64),'test',$3,'{}')`, [op, randomUUID(), op]);
    for (const v of variants) await c.query(`insert into public.stock_movements(variant_id,delta,reason) values($1,1,'restock')`, [v]);
    const n = (await c.query('select private.allocate_group_g_fifo($1,$2,$3) as n', [variants, op, null])).rows[0].n;
    await c.query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)', [JSON.stringify(before), orderIds, op, 'fifo', null]);
    return n as number;
  }

  test.each([1, 2])('two receipts with %i variant(s), reverse input order, serialize with no double allocation', async (count) => {
    const fx = await waitingOrders(count);
    const a = await client();
    const b = await client();
    let second: Promise<number> | undefined;
    try {
      await a.query('begin');
      expect(await receipt(a, fx.variants)).toBe(count);
      await b.query('begin');
      const waiter = await pid(b);
      const blocker = await pid(a);
      second = receipt(b, [...fx.variants].reverse());
      void second.catch(() => {});
      await waitForAdvisory(db(), waiter, blocker);
      await a.query('commit');
      expect(await second).toBe(count);
      await b.query('commit');
      const quantities = (await db().query(`select oi.order_id,oi.variant_id,coalesce(sum(a.remaining_quantity),0)::int as n
        from public.order_items oi left join public.order_item_allocations a on a.order_item_id=oi.id
        where oi.order_id=any($1::uuid[]) group by oi.id order by oi.order_id,oi.variant_id`, [fx.orders.map((o) => o.orderId)])).rows;
      for (const row of quantities) expect(row.n).toBe(row.order_id === fx.orders[0].orderId ? 2 : 0);
      expect((await db().query('select stock_quantity from public.item_variants where id=any($1::bigint[])', [fx.variants])).rows.map((r) => r.stock_quantity)).toEqual(fx.variants.map(() => 0));
      expect((await db().query('select * from public.verify_stock_integrity() where variant_id=any($1::bigint[])', [fx.variants])).rows).toEqual([]);
    } finally {
      await a.query('rollback');
      if (second) await second.catch(() => {});
      await b.query('rollback');
      await Promise.all([a.end(), b.end()]);
    }
  });
});
