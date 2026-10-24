/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { connectLocalDb, describeLocalDb, type PgClient } from './helpers/local-db';
import { addItemVariant, createCatalogFixture, createDraft, createShippedOrderFixture, insertOrderWithLines,
  insertReturnRecord, insertReturnReceipt, insertRefundRecord, insertCancelRequest } from './helpers/order-fixtures';
import { withGroupG1FixtureTransaction } from './helpers/group-g1-fixtures';

// This inventory is Task 4's entry point. Tasks 5-13 must add their public writers to the same boundary test
// (Task 6's checkout/awaiting/release/admin cancel/guest link writers are in TASK6_ENTRIES below).
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
      // The open return's exchange variant and the related waiting order's other variant
      // belong to the active closure; closed historical orders must not extend it.
      await c.query('begin');
      for (const variantId of [material.exchangeVariant, material.extraVariant]) {
        await c.query('savepoint locked_variant');
        await expect(c.query('select id from public.item_variants where id=$1 for update nowait', [variantId]))
          .rejects.toMatchObject({ code: '55P03' });
        await c.query('rollback to savepoint locked_variant');
        await c.query('release savepoint locked_variant');
      }
    } finally {
      await a.query('rollback');
      if (pending) await pending.catch(() => {});
      await b.query('rollback');
      await c.query('rollback');
      await Promise.all([a.end(), b.end(), c.end()]);
    }
  });

  test('locks waiting orders without locking shared-variant closed history, unless that history is explicitly named', async () => {
    const material = await withGroupG1FixtureTransaction(db(), async () => {
      const historical = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }, { quantity: 1 }] });
      const closedExchange = await createCatalogFixture(db(), { stock: 0 });
      await insertReturnRecord(db(), { orderId: historical.orderId, status: 'closed', lines: [{
        orderItemId: historical.orderItemIds[0], fulfillmentId: historical.fulfillments[0].id,
        quantity: 1, resolution: 'exchange', exchangeVariantId: closedExchange.variantId,
      }] });
      const waiting = await insertOrderWithLines(db(), { status: 'paid', lines: [{
        itemId: historical.itemIds[0], variantId: historical.variantIds[0], quantity: 1,
        fulfillmentType: 'backorder', reserved: false,
      }] });
      return { historical, waiting, closedExchange };
    });
    const holder = await client();
    const observer = await client();
    try {
      for (const explicitlyNamed of [false, true]) {
        await holder.query('begin');
        const result = await holder.query('select private.lock_group_g_inventory($1,$2) as ids',
          [[material.historical.variantIds[0]], explicitlyNamed ? [material.historical.orderId] : []]);
        expect(result.rows[0].ids).toEqual([
          material.waiting.orderId, ...(explicitlyNamed ? [material.historical.orderId] : []),
        ].sort());
        await observer.query('begin');
        if (!explicitlyNamed) {
          // These succeed while the inventory transaction still owns advisory/variant locks.
          expect((await observer.query('select id from public.orders where id=$1 for update nowait',
            [material.historical.orderId])).rowCount).toBe(1);
          expect((await observer.query('select id from public.order_items where order_id=$1 for update nowait',
            [material.historical.orderId])).rowCount).toBe(2);
          expect((await observer.query('select id from public.item_variants where id=$1 for update nowait',
            [material.historical.variantIds[1]])).rowCount).toBe(1);
        }
        // Even an explicitly named history order does not expand through its closed return.
        expect((await observer.query('select id from public.item_variants where id=$1 for update nowait',
          [material.closedExchange.variantId])).rowCount).toBe(1);
        for (const id of [material.waiting.orderId, ...(explicitlyNamed ? [material.historical.orderId] : [])]) {
          await observer.query('savepoint locked_order');
          await expect(observer.query('select id from public.orders where id=$1 for update nowait', [id]))
            .rejects.toMatchObject({ code: '55P03' });
          await observer.query('rollback to savepoint locked_order');
          await observer.query('release savepoint locked_order');
        }
        await observer.query('rollback');
        await holder.query('rollback');
      }
    } finally {
      await observer.query('rollback');
      await holder.query('rollback');
      await Promise.all([holder.end(), observer.end()]);
    }
  });

  // Task 6 public writers: B waits on the advisory with valid input while C can still take every existing row.
  type Task6Material = {
    sql: string; params: unknown[]; draftId?: string; itemId: number; variantId: number; orderIds: string[]; exceptionId?: string;
  };
  const TASK6_ENTRIES: Array<{ name: string; setup: () => Promise<Task6Material>; check: (rows: any[]) => void }> = [
    { name: 'public.place_order_from_checkout_draft', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const held = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
      const heldOrder = await placeOrder(held);
      const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
      return { sql: `select * from public.place_order_from_checkout_draft($1::uuid,$2::text,$3::text,$4::integer,0,'jpy',now(),null::text)`,
        params: [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount], draftId: draft.draftId,
        itemId: fx.itemId, variantId: fx.variantId, orderIds: [heldOrder] };
    }, check: (rows) => expect(rows[0]).toMatchObject({ created: true, rejection: null }) },
    { name: 'public.mark_order_awaiting_payment', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const orderId = await placeOrder(await createDraft(db(), { itemId: fx.itemId, quantity: 1 }));
      return { sql: 'select * from public.mark_order_awaiting_payment($1::uuid,$2::text,null)', params: [orderId, `pi_${randomUUID()}`],
        itemId: fx.itemId, variantId: fx.variantId, orderIds: [orderId] };
    }, check: (rows) => expect(rows).toEqual([{ updated: true }]) },
    { name: 'public.release_stock_for_unpaid_order', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const orderId = await placeOrder(await createDraft(db(), { itemId: fx.itemId, quantity: 1 }));
      return { sql: `select released from public.release_stock_for_unpaid_order($1::uuid,'payment_in_progress','abandoned','stripe_checkout_expired')`,
        params: [orderId], itemId: fx.itemId, variantId: fx.variantId, orderIds: [orderId] };
    }, check: (rows) => expect(rows).toEqual([{ released: true }]) },
    { name: 'public.admin_cancel_failed_order', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const orderId = await placeOrder(await createDraft(db(), { itemId: fx.itemId, quantity: 1 }));
      await db().query(`select released from public.release_stock_for_unpaid_order($1::uuid,'payment_in_progress','failed','stripe_payment_failed')`, [orderId]);
      return { sql: `select status::text as status from public.admin_cancel_failed_order($1::uuid,$2::uuid,'customer_request',null)`,
        params: [orderId, await actorId()], itemId: fx.itemId, variantId: fx.variantId, orderIds: [orderId] };
    }, check: (rows) => expect(rows).toEqual([{ status: 'cancelled' }]) },
    { name: 'public.link_guest_orders', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const email = `g1-link-lock-${randomUUID()}@example.com`;
      const user = (await db().query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
        values (gen_random_uuid(), $1, now(), '{}'::jsonb, now(), now()) returning id`, [email])).rows[0].id as string;
      const orders = [];
      for (let i = 0; i < 2; i++) {
        orders.push((await insertOrderWithLines(db(), { status: 'pending', shippingEmail: email, lines: [
          { itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'stock' },
        ] })).orderId);
      }
      return { sql: 'select id from public.link_guest_orders($1::uuid,$2::text)', params: [user, email],
        itemId: fx.itemId, variantId: fx.variantId, orderIds: orders.sort() };
    }, check: (rows) => expect(rows).toHaveLength(2) },
  ];

  // Task 7 public writers (payment, cancelled-order payment, exception record, both resolvers, review mark).
  async function paidOrder(amountDelta = 0) {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
    const orderId = await placeOrder(draft);
    const pi = `pi_${randomUUID().replaceAll('-', '')}`;
    await db().query(`select updated from public.mark_order_paid($1::uuid,'payment_in_progress',$2::text,$3::integer,
      'jpy',true,'order_confirmed',null)`, [orderId, pi, draft.totalAmount + amountDelta]);
    const exceptionId = (await db().query(
      `select id from public.payment_exceptions where order_id=$1 and reason='paid_amount_mismatch'`, [orderId],
    )).rows[0]?.id as string | undefined;
    return { fx, draft, orderId, pi, exceptionId };
  }
  const TASK7_ENTRIES: Array<{ name: string; setup: () => Promise<Task6Material>; check: (rows: any[]) => void }> = [
    { name: 'public.mark_order_paid', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
      const orderId = await placeOrder(draft);
      return { sql: `select updated, amount_matches, needs_review from public.mark_order_paid($1::uuid,'payment_in_progress',
          $2::text,$3::integer,'jpy',true,'order_confirmed',null)`,
        params: [orderId, `pi_${randomUUID()}`, draft.totalAmount], itemId: fx.itemId, variantId: fx.variantId, orderIds: [orderId] };
    }, check: (rows) => expect(rows).toEqual([{ updated: true, amount_matches: true, needs_review: false }]) },
    { name: 'public.record_cancelled_order_paid_amount', setup: async () => {
      const fx = await createCatalogFixture(db(), { stock: 3 });
      const draft = await createDraft(db(), { itemId: fx.itemId, quantity: 1 });
      const orderId = await placeOrder(draft);
      await db().query(`select released from public.release_stock_for_unpaid_order($1::uuid,'payment_in_progress','cancelled',
        'admin_cancel',$2::uuid,null,'customer_request',null,false)`, [orderId, await actorId()]);
      return { sql: 'select public.record_cancelled_order_paid_amount($1::uuid,$2::text,$3::integer) as written',
        params: [orderId, `pi_${randomUUID().replaceAll('-', '')}`, draft.totalAmount],
        itemId: fx.itemId, variantId: fx.variantId, orderIds: [orderId] };
    }, check: (rows) => expect(rows).toEqual([{ written: true }]) },
    { name: 'public.record_payment_exception', setup: async () => {
      const p = await paidOrder();
      return { sql: `select is_new, is_resolved from public.record_payment_exception($1::text,'paid_amount_mismatch',null,$1::text,
          $2::text,null,$3::uuid)`, params: [p.draft.checkoutSessionId, p.pi, p.orderId],
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId] };
    }, check: (rows) => expect(rows).toEqual([{ is_new: true, is_resolved: false }]) },
    { name: 'public.resolve_payment_exception', setup: async () => {
      const p = await paidOrder(1);
      return { sql: `select resolved from public.resolve_payment_exception($1::uuid,$2::uuid,'checked')`,
        params: [p.exceptionId, await actorId()], itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId],
        exceptionId: p.exceptionId };
    }, check: (rows) => expect(rows).toEqual([{ resolved: true }]) },
    { name: 'public.resolve_payment_exception_by_system', setup: async () => {
      const p = await paidOrder(1);
      return { sql: `select public.resolve_payment_exception_by_system($1::uuid,'auto') as resolved`,
        params: [p.exceptionId], itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId], exceptionId: p.exceptionId };
    }, check: (rows) => expect(rows).toEqual([{ resolved: true }]) },
    { name: 'public.mark_order_reviewed', setup: async () => {
      const p = await paidOrder();
      await db().query(`update public.orders set review_reason='stock_not_reserved', review_marked_at=now() where id=$1`, [p.orderId]);
      return { sql: 'select public.mark_order_reviewed($1::uuid,$2::uuid) as reviewed', params: [p.orderId, await actorId()],
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId] };
    }, check: (rows) => expect(rows).toEqual([{ reviewed: true }]) },
  ];

  let actor: string | undefined;
  async function actorId() {
    actor ??= (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-lock-${randomUUID()}@example.com`])).rows[0].id as string;
    return actor;
  }

  async function placeOrder(draft: { draftId: string; checkoutSessionId: string; cartSessionId: string; totalAmount: number }) {
    return (await db().query(
      `select order_id from public.place_order_from_checkout_draft($1::uuid,$2::text,$3::text,$4::integer,0,'jpy',now(),null::text)`,
      [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
    )).rows[0].order_id as string;
  }

  test.each([...TASK6_ENTRIES, ...TASK7_ENTRIES])('$name waits for advisory before locking any existing business row', async ({ setup, check }) => {
    const material = await setup();
    const a = await client();
    const b = await client();
    const c = await client();
    let pending: Promise<{ rows: any[] }> | undefined;
    try {
      const [blocker, waiter] = [await pid(a), await pid(b)];
      await a.query('begin');
      await a.query('select pg_advisory_xact_lock(190521,1)');
      await b.query('begin');
      pending = b.query(material.sql, material.params);
      void pending.catch(() => {});
      await waitForAdvisory(c, waiter, blocker);
      await c.query('begin');
      const probes: Array<[string, unknown[]]> = [
        ['select id from public.items where id=$1 for update nowait', [material.itemId]],
        ['select id from public.item_variants where id=$1 for update nowait', [material.variantId]],
        ['select id from public.orders where id=any($1::uuid[]) for update nowait', [material.orderIds]],
        ['select id from public.order_items where order_id=any($1::uuid[]) for update nowait', [material.orderIds]],
        [`select a.id from public.order_item_allocations a join public.order_items oi on oi.id=a.order_item_id
          where oi.order_id=any($1::uuid[]) for update of a nowait`, [material.orderIds]],
      ];
      if (material.draftId) probes.unshift(['select id from public.checkout_drafts where id=$1 for update nowait', [material.draftId]]);
      if (material.exceptionId) probes.push(['select id from public.payment_exceptions where id=$1 for update nowait', [material.exceptionId]]);
      for (const [probe, params] of probes) expect((await c.query(probe, params)).rowCount).toBeGreaterThan(0);
      await c.query('rollback');
      await a.query('rollback');
      check((await pending).rows);
      await b.query('set constraints all immediate');
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
