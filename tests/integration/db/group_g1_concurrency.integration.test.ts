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
    refundId?: string;
    /** Task 9: run on B (after BEGIN, before the entry) to open the cancel request settings for that transaction only. */
    prepare?: string;
    cancelRequestId?: string;
    returnId?: string;
    receiptId?: string;
    exchangeVariants?: number[];
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

  // Task 8 public writers (refund begin, refund result, external refund, refund error). The material is a paid
  // order with its A; the refund rows already committed by the setup must also stay free for C.
  async function awaitingRefund(p: Awaited<ReturnType<typeof paidOrder>>) {
    return (await db().query(`select refund_id from public.begin_order_refund($1::uuid,'order_cancel',$2::uuid,'[]'::jsonb,true,
      null,null,null,null,'customer_request',false,$3::uuid,null)`, [p.orderId, randomUUID(), await actorId()])).rows[0].refund_id as string;
  }
  const TASK8_ENTRIES: Array<{ name: string; setup: () => Promise<Task6Material>; check: (rows: any[]) => void }> = [
    { name: 'public.begin_order_refund', setup: async () => {
      const p = await paidOrder();
      return { sql: `select status, replayed from public.begin_order_refund($1::uuid,'order_cancel',$2::uuid,'[]'::jsonb,true,
          null,null,null,null,'customer_request',false,$3::uuid,null)`, params: [p.orderId, randomUUID(), await actorId()],
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId] };
    }, check: (rows) => expect(rows).toEqual([{ status: 'awaiting_response', replayed: false }]) },
    { name: 'public.record_order_refund_result', setup: async () => {
      const p = await paidOrder();
      const refundId = await awaitingRefund(p);
      return { sql: `select status, newly_accepted from public.record_order_refund_result($1::uuid,$2::text,'succeeded',
          null,null,null,'card',null,null)`, params: [refundId, `re_${refundId.replaceAll('-', '')}`],
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId], refundId };
    }, check: (rows) => expect(rows).toEqual([{ status: 'succeeded', newly_accepted: true }]) },
    { name: 'public.record_external_order_refund', setup: async () => {
      const p = await paidOrder();
      return { sql: `select created, status from public.record_external_order_refund($1::uuid,$2::text,$3::integer,'succeeded',
          null,null,null,'card',null,null,null,now())`, params: [p.orderId, `re_${randomUUID().replaceAll('-', '')}`, 1000],
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId] };
    }, check: (rows) => expect(rows).toEqual([{ created: true, status: 'succeeded' }]) },
    { name: 'public.mark_order_refund_error', setup: async () => {
      const p = await paidOrder();
      const refundId = await awaitingRefund(p);
      return { sql: `select outcome from public.mark_order_refund_error($1::uuid,'not_found_in_stripe',false)`, params: [refundId],
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId], refundId };
    }, check: (rows) => expect(rows).toEqual([{ outcome: 'errored' }]) },
  ];

  // Task 9 public writers (cancel request intake, decline, close, resolve). The committed request (and the resolving
  // refund) must stay free for C while B waits; the request rows come after the refund rows in the closure.
  async function requestedOrder() {
    const p = await paidOrder();
    const itemId = (await db().query('select id from public.order_items where order_id=$1', [p.orderId])).rows[0].id as string;
    const request = await insertCancelRequest(db(), { orderId: p.orderId, lines: [{ orderItemId: itemId, quantity: 1 }] });
    return { p, itemId, cancelRequestId: request.cancelRequestId };
  }
  const TASK9_ENTRIES: Array<{ name: string; setup: () => Promise<Task6Material>; check: (rows: any[]) => void }> = [
    { name: 'public.customer_request_cancel', setup: async () => {
      const p = await paidOrder();
      const owner = (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
        values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-cancel-${randomUUID()}@example.com`])).rows[0].id as string;
      await db().query('update public.orders set user_id=$1 where id=$2', [owner, p.orderId]);
      const itemId = (await db().query('select id from public.order_items where order_id=$1', [p.orderId])).rows[0].id as string;
      return { sql: 'select status, replayed from public.customer_request_cancel($1::uuid,$2::uuid,$3::uuid,$4::jsonb,null)',
        params: [p.orderId, owner, randomUUID(), JSON.stringify([{ order_item_id: itemId, quantity: 1 }])],
        prepare: `update public.shop_return_settings set requests_enabled=true, request_types='returns_and_cancellations' where id=1`,
        itemId: p.fx.itemId, variantId: p.fx.variantId, orderIds: [p.orderId] };
    }, check: (rows) => expect(rows).toEqual([{ status: 'requested', replayed: false }]) },
    { name: 'public.admin_decline_cancel_request', setup: async () => {
      const r = await requestedOrder();
      return { sql: `select status from public.admin_decline_cancel_request($1::uuid,$2::uuid,'other','受付できません。')`,
        params: [r.cancelRequestId, await actorId()], itemId: r.p.fx.itemId, variantId: r.p.fx.variantId, orderIds: [r.p.orderId],
        cancelRequestId: r.cancelRequestId };
    }, check: (rows) => expect(rows).toEqual([{ status: 'declined' }]) },
    { name: 'public.admin_close_cancel_request', setup: async () => {
      const r = await requestedOrder();
      return { sql: 'select status from public.admin_close_cancel_request($1::uuid,$2::uuid)',
        params: [r.cancelRequestId, await actorId()], itemId: r.p.fx.itemId, variantId: r.p.fx.variantId, orderIds: [r.p.orderId],
        cancelRequestId: r.cancelRequestId };
    }, check: (rows) => expect(rows).toEqual([{ status: 'closed' }]) },
    { name: 'public.admin_resolve_cancel_request', setup: async () => {
      const r = await requestedOrder();
      const refundId = await awaitingRefund(r.p);
      return { sql: 'select status from public.admin_resolve_cancel_request($1::uuid,$2::uuid,$3::uuid,false)',
        params: [r.cancelRequestId, await actorId(), refundId], itemId: r.p.fx.itemId, variantId: r.p.fx.variantId,
        orderIds: [r.p.orderId], refundId, cancelRequestId: r.cancelRequestId };
    }, check: (rows) => expect(rows).toEqual([{ status: 'resolved' }]) },
  ];

  // Task 10: input-only exchange variants must be part of the initial closure too.
  const RETURN_SETTINGS = `update public.shop_return_settings set requests_enabled=true,
    request_types='returns_and_cancellations',return_address_name='fixture',return_address_postal_code='1000001',
    return_address_line='fixture',return_address_phone='0312345678' where id=1`;
  const TASK10_ENTRIES: Array<{ name: string; setup: () => Promise<Task6Material>; check: (rows: any[]) => void }> =
    ['customer_request_return', 'admin_create_return', 'admin_approve_return', 'admin_decline_return', 'admin_cancel_return'].map(name => ({
      name: `public.${name}`, setup: async () => {
        const fx = await withGroupG1FixtureTransaction(db(), async () => {
          const f = await createShippedOrderFixture(db(), { lines: [{ quantity: 5 }],
            shipments: [{ lines: [{ lineIndex: 0, quantity: 3 }] }] });
          const owner = await actorId();
          await db().query('update public.orders set user_id=$1 where id=$2', [owner, f.orderId]);
          const exchange = await addItemVariant(db(), { itemId: f.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 0 });
          const waiting = await insertOrderWithLines(db(), { status: 'paid', lines: [{ itemId: f.itemIds[0],
            variantId: exchange.variantId, quantity: 1, fulfillmentType: 'backorder', reserved: false }] });
          const existing = name.startsWith('admin_') && name !== 'admin_create_return'
            ? await insertReturnRecord(db(), { orderId: f.orderId,
              status: name === 'admin_cancel_return' ? 'open' : 'requested',
              lines: [{ fulfillmentId: f.fulfillments[0].id, orderItemId: f.orderItemIds[0], quantity: 1 }] }) : undefined;
          return { f, owner, exchange, waiting, existing };
        });
        const base = { fulfillment_id: fx.f.fulfillments[0].id, order_item_id: fx.f.orderItemIds[0], quantity: 1, reason: 'defective' };
        let sql: string;
        let params: unknown[];
        if (name === 'customer_request_return') {
          sql = 'select status,replayed from public.customer_request_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb)';
          params = [fx.f.orderId, fx.owner, randomUUID(), JSON.stringify([{ ...base, customer_note: 'fixture',
            requested_resolution: 'exchange', requested_exchange_variant_id: fx.exchange.variantId, photos: [] }])];
        } else if (name === 'admin_create_return') {
          sql = `select status,replayed from public.admin_create_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb,
            'customer_ships','shop',null,null,0,0,0,0,null,false)`;
          params = [fx.f.orderId, fx.owner, randomUUID(), JSON.stringify([{ ...base, reason_note: null,
            resolution: 'exchange', exchange_variant_id: fx.exchange.variantId, exchange_method: 'make' }])];
        } else if (name === 'admin_approve_return') {
          sql = `select status from public.admin_approve_return($1::uuid,$2::uuid,$3::jsonb,
            'customer_ships','shop',null,null,0,0,0,0,null,false)`;
          params = [fx.existing!.returnId, fx.owner, JSON.stringify([{ return_line_id: fx.existing!.lineIds[0],
            resolution: 'exchange', exchange_variant_id: fx.exchange.variantId, exchange_method: 'make' }])];
        } else {
          sql = name === 'admin_decline_return'
            ? `select status from public.admin_decline_return($1::uuid,$2::uuid,'other','fixture')`
            : 'select status from public.admin_cancel_return($1::uuid,$2::uuid)';
          params = [fx.existing!.returnId, fx.owner];
        }
        const usesExchange = ['customer_request_return', 'admin_create_return', 'admin_approve_return'].includes(name);
        return { sql, params, prepare: `${RETURN_SETTINGS}; update public.shop_return_reason_settings set shown=true,
          photo='optional',resolutions='refund_and_exchange',out_of_stock_exchange='make' where reason='defective'`,
          itemId: fx.f.itemIds[0], variantId: fx.f.variantIds[0],
          orderIds: usesExchange ? [fx.f.orderId, fx.waiting.orderId].sort() : [fx.f.orderId],
          returnId: fx.existing?.returnId, exchangeVariants: usesExchange ? [fx.exchange.variantId] : [] };
      }, check: rows => expect(rows).toEqual([name === 'customer_request_return' ? { status: 'requested', replayed: false }
        : name === 'admin_create_return' ? { status: 'open', replayed: false }
          : { status: name === 'admin_approve_return' ? 'open' : name === 'admin_decline_return' ? 'declined' : 'cancelled' }]),
    }));

  const TASK11_ENTRIES: Array<{ name: string; setup: () => Promise<Task6Material>; check: (rows: any[]) => void }> =
    ['admin_receive_return', 'admin_inspect_return', 'admin_close_return_missing', 'admin_reopen_return', 'admin_refund_return'].map(name => ({
      name: `public.${name}`, setup: async () => {
        const actor = await actorId();
        const material = await withGroupG1FixtureTransaction(db(), async () => {
          const f = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }] });
          const exchange = name === 'admin_receive_return'
            ? await addItemVariant(db(), { itemId: f.itemIds[0], colorName: 'WHITE', sizeLabel: 'L', stock: 0 }) : undefined;
          const neighbour = exchange ? await insertOrderWithLines(db(), { status: 'paid', lines: [{
            itemId: f.itemIds[0], variantId: exchange.variantId, quantity: 1, fulfillmentType: 'backorder', reserved: false,
          }] }) : undefined;
          const refund = await insertRefundRecord(db(), { orderId: f.orderId, status: 'failed',
            lines: [{ orderItemId: f.orderItemIds[0], quantity: 1, beforeShipment: false }] });
          const ret = await insertReturnRecord(db(), { orderId: f.orderId, lines: [{
            fulfillmentId: f.fulfillments[0].id, orderItemId: f.orderItemIds[0], quantity: 1,
            resolution: exchange ? 'exchange' : 'refund', exchangeVariantId: exchange?.variantId, exchangeMethod: exchange ? 'make' : undefined,
          }] });
          let receiptId: string | undefined;
          if (name === 'admin_inspect_return') {
            const receipt = await insertReturnReceipt(db(), { returnId: ret.returnId, lines: [{
              returnLineId: ret.lineIds[0], quantity: 1, disposition: 'pending_inspection',
            }] });
            receiptId = receipt.receiptId;
          } else if (name === 'admin_refund_return') {
            const receipt = (await db().query(`select * from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,
              $4::jsonb,'[]'::jsonb,'consult',null,0,null,false,null,null,null)`, [ret.returnId, actor, randomUUID(),
            JSON.stringify([{ return_line_id: ret.lineIds[0], quantity: 1, disposition: 'not_restocked' }])])).rows[0];
            receiptId = receipt.receipt_id as string;
          }
          if (name === 'admin_reopen_return') await db().query('select * from public.admin_close_return_missing($1,$2,$3)',
            [ret.returnId, actor, randomUUID()]);
          return { f, ret, receiptId, refund, exchange, neighbour };
        });
        const { f, ret } = material;
        const params: unknown[] = [ret.returnId, actor, randomUUID()];
        let sql = `select replayed from public.${name}($1::uuid,$2::uuid,$3::uuid)`;
        if (name === 'admin_receive_return') {
          sql = `select replayed from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,$4::jsonb,
            '[]'::jsonb,'consult',null,0,null,false,null,null,null)`;
          params.push(JSON.stringify([{ return_line_id: ret.lineIds[0], quantity: 1, disposition: 'restocked' }]));
        } else if (name === 'admin_inspect_return') {
          sql = 'select replayed from public.admin_inspect_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb)';
          params.push(JSON.stringify([{ return_line_id: ret.lineIds[0], restocked: 1, not_restocked: 0 }]));
        } else if (name === 'admin_refund_return') {
          sql = 'select replayed from public.admin_refund_return($1::uuid,$2::uuid,$3::uuid,0,0,null,false)';
        }
        return { sql, params, itemId: f.itemIds[0], variantId: f.variantIds[0],
          orderIds: [f.orderId, ...(material.neighbour ? [material.neighbour.orderId] : [])].sort(), returnId: ret.returnId,
          receiptId: material.receiptId, refundId: material.refund.refundId,
          exchangeVariants: material.exchange ? [material.exchange.variantId] : [] };
      }, check: rows => expect(rows).toEqual([{ replayed: false }]),
    }));

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

  test.each([...TASK6_ENTRIES, ...TASK7_ENTRIES, ...TASK8_ENTRIES, ...TASK9_ENTRIES, ...TASK10_ENTRIES, ...TASK11_ENTRIES])('$name waits for advisory before locking any existing business row', async ({ setup, check }) => {
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
      if (material.prepare) await b.query(material.prepare);
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
      if (material.refundId) {
        probes.push(['select id from public.order_refunds where id=$1 for update nowait', [material.refundId]]);
        probes.push(['select id from public.order_refund_lines where refund_id=$1 for update nowait', [material.refundId]]);
      }
      if (material.cancelRequestId) {
        probes.push(['select id from public.order_cancel_requests where id=$1 for update nowait', [material.cancelRequestId]]);
        probes.push(['select id from public.order_cancel_request_lines where cancel_request_id=$1 for update nowait',
          [material.cancelRequestId]]);
      }
      if (material.returnId) {
        probes.push(['select id from public.order_returns where id=$1 for update nowait', [material.returnId]]);
        probes.push(['select id from public.order_return_lines where return_id=$1 for update nowait', [material.returnId]]);
      }
      if (material.receiptId) {
        probes.push(['select id from public.order_return_receipts where id=$1 for update nowait', [material.receiptId]]);
        probes.push(['select id from public.order_return_receipt_lines where receipt_id=$1 for update nowait', [material.receiptId]]);
      }
      if (material.exchangeVariants?.length) probes.push([
        'select id from public.item_variants where id=any($1::bigint[]) for update nowait', [material.exchangeVariants],
      ]);
      for (const [probe, params] of probes) expect((await c.query(probe, params)).rowCount).toBeGreaterThan(0);
      await c.query('rollback');
      await a.query('rollback');
      check((await pending).rows);
      await b.query('set constraints all immediate');
      // Verify input-only exchange rows and their waiting order are held by the completed body.
      await c.query('begin');
      for (const [sql, params] of [
        ...(material.exchangeVariants ?? []).map(id => ['select id from public.item_variants where id=$1 for update nowait', [id]] as const),
        ...material.orderIds.map(id => ['select id from public.orders where id=$1 for update nowait', [id]] as const),
      ]) {
        await c.query('savepoint closure_locked');
        await expect(c.query(sql, [...params])).rejects.toMatchObject({ code: '55P03' });
        await c.query('rollback to savepoint closure_locked');
        await c.query('release savepoint closure_locked');
      }
      await c.query('rollback');
    } finally {
      await a.query('rollback');
      if (pending) await pending.catch(() => {});
      await b.query('rollback');
      await c.query('rollback');
      await Promise.all([a.end(), b.end(), c.end()]);
      // B rolled back: keep no committed open cancel request or awaiting refund in the global sweep lists.
      if (material.cancelRequestId) {
        await db().query(`update public.order_cancel_requests set status='closed', closed_at=now(), closed_by=gen_random_uuid()
          where id=$1 and status='requested'`, [material.cancelRequestId]);
      }
      if (material.refundId) {
        await db().query(`update public.order_refunds set status='error', errored_at=now()
          where id=$1 and status='awaiting_response'`, [material.refundId]);
      }
      if (material.returnId) await db().query(`update public.order_returns set
        status=case when status='requested' then 'declined' else 'cancelled' end,
        declined_at=case when status='requested' then now() else declined_at end,
        decline_reason=case when status='requested' then 'other' else decline_reason end,
        decline_message=case when status='requested' then 'fixture cleanup' else decline_message end,
        cancelled_at=case when status='open' then now() else cancelled_at end
        where id=$1 and status in ('requested','open')`, [material.returnId]);
    }
  });

  // Task 7 carry-over: every public exception entry takes the common lock, whatever the reason.
  test.each(['public.record_payment_exception', 'public.resolve_payment_exception_by_system'])(
    '%s holds the common advisory lock for a non-mismatch reason', async (name) => {
      const p = await paidOrder();
      const ref = `re_${randomUUID().replaceAll('-', '')}`;
      let exceptionId: string | undefined;
      if (name === 'public.resolve_payment_exception_by_system') {
        exceptionId = (await db().query(`insert into public.payment_exceptions (payment_ref, reason, detail, order_id)
          values ($1, 'refund_failed', 'declined', $2) returning id`, [ref, p.orderId])).rows[0].id as string;
      }
      const b = await client();
      const c = await client();
      try {
        await b.query('begin');
        const waiter = await pid(b);
        const rows = name === 'public.record_payment_exception'
          ? (await b.query(`select is_new, is_resolved from public.record_payment_exception($1::text,'refund_failed','declined',
              null,null,null,$2::uuid)`, [ref, p.orderId])).rows
          : (await b.query(`select public.resolve_payment_exception_by_system($1::uuid,'auto') as resolved`, [exceptionId])).rows;
        expect(rows).toEqual(name === 'public.record_payment_exception'
          ? [{ is_new: true, is_resolved: false }] : [{ resolved: true }]);
        const held = (await c.query(`select exists(select 1 from pg_catalog.pg_locks where pid=$1::int and locktype='advisory'
          and classid=190521 and objid=1 and objsubid=2 and mode='ExclusiveLock' and granted) as held`, [waiter])).rows[0].held;
        expect(held).toBe(true);
        // The order closure is held too: another connection cannot take the order row.
        await c.query('begin');
        await expect(c.query('select id from public.orders where id=$1 for update nowait', [p.orderId]))
          .rejects.toMatchObject({ code: '55P03' });
      } finally {
        await c.query('rollback');
        await b.query('rollback');
        await Promise.all([b.end(), c.end()]);
        if (exceptionId) {
          await db().query(`update public.payment_exceptions set resolved_at=now(), resolution_note='test cleanup'
            where id=$1 and resolved_at is null`, [exceptionId]);
        }
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

  // Task 9: a cancel request decline against a receipt of the same variant, in both orders. Neither waits on the
  // other's rows in reverse order (both complete), and the units are conserved: F + A equals the received units.
  test.each(['receipt first', 'decline first'])('cancel request decline vs receipt (%s): no reverse wait, quantities conserved', async (first) => {
    const fx = await withGroupG1FixtureTransaction(db(), async () => {
      const catalog = await createCatalogFixture(db(), { stock: 0 });
      const line = (createdAt: string, quantity: number) => insertOrderWithLines(db(), { status: 'paid', createdAt, lines: [{
        itemId: catalog.itemId, variantId: catalog.variantId, quantity, fulfillmentType: 'stock' as const, reserved: false,
      }] });
      const older = await line('2026-01-01', 2);
      const newer = await line('2026-02-01', 1);
      const request = await insertCancelRequest(db(), { orderId: older.orderId, lines: [{ orderItemId: older.orderItemIds[0], quantity: 2 }] });
      return { variant: catalog.variantId, older, newer, cancelRequestId: request.cancelRequestId };
    });
    const who = await actorId();
    const a = await client();
    const b = await client();
    let second: Promise<unknown> | undefined;
    const decline = (c: PgClient) => c.query(`select status from public.admin_decline_cancel_request($1::uuid,$2::uuid,'other','受付できません。')`,
      [fx.cancelRequestId, who]);
    const twoReceipts = async (c: PgClient) => (await receipt(c, [fx.variant])) + (await receipt(c, [fx.variant]));
    try {
      await a.query('begin');
      await b.query('begin');
      const [blocker, waiter] = [await pid(a), await pid(b)];
      if (first === 'receipt first') {
        // The older order's units are requested: the first unit goes to the newer order, the second stays free.
        expect(await twoReceipts(a)).toBe(1);
        second = decline(b);
      } else {
        expect((await decline(a)).rows).toEqual([{ status: 'declined' }]);
        second = twoReceipts(b);
      }
      void second.catch(() => {});
      await waitForAdvisory(db(), waiter, blocker);
      await a.query('commit');
      if (first === 'receipt first') {
        await expect(second).resolves.toMatchObject({ rows: [{ status: 'declined' }] });
      } else {
        // After the decline the older order is waiting again and, being older, takes both units.
        await expect(second).resolves.toBe(2);
      }
      await b.query('commit');
      const quantities = (await db().query(`select oi.order_id, coalesce(sum(al.remaining_quantity),0)::int as n
        from public.order_items oi left join public.order_item_allocations al on al.order_item_id=oi.id and al.kind='paid'
        where oi.order_id=any($1::uuid[]) group by oi.order_id`, [[fx.older.orderId, fx.newer.orderId]])).rows;
      const byOrder: Record<string, number> = Object.fromEntries(quantities.map((row) => [row.order_id as string, Number(row.n)]));
      expect(byOrder).toEqual(first === 'receipt first'
        ? { [fx.older.orderId]: 1, [fx.newer.orderId]: 1 } : { [fx.older.orderId]: 2, [fx.newer.orderId]: 0 });
      const free = Number((await db().query('select stock_quantity from public.item_variants where id=$1', [fx.variant])).rows[0].stock_quantity);
      expect(free + Object.values(byOrder).reduce((sum, n) => sum + n, 0)).toBe(2);
      expect(free).toBe(0);
      expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [fx.variant])).rows).toEqual([]);
    } finally {
      await a.query('rollback');
      if (second) await second.catch(() => {});
      await b.query('rollback');
      await Promise.all([a.end(), b.end()]);
    }
  });

  test.each([
    ['payment', true], ['payment', false], ['fifo', true], ['fifo', false],
  ] as const)('return receipt vs %s (return first=%s): no double restock, nonnegative F, oldest waiting wins', async (peer, returnFirst) => {
    const fx = await withGroupG1FixtureTransaction(db(), async () => {
      const f = await createShippedOrderFixture(db(), { lines: [{ quantity: 1, extraStock: 1 }] });
      const owner = await actorId();
      await db().query(`insert into public.user_roles(user_id,role_id)
        select $1,id from public.roles where code='admin' on conflict do nothing`, [owner]);
      const ret = await insertReturnRecord(db(), { orderId: f.orderId, lines: [{
        fulfillmentId: f.fulfillments[0].id, orderItemId: f.orderItemIds[0], quantity: 1,
      }] });
      const older = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-01-01', lines: [{
        itemId: f.itemIds[0], variantId: f.variantIds[0], quantity: 1, fulfillmentType: 'backorder', reserved: false,
      }] });
      const newer = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-02-01', lines: [{
        itemId: f.itemIds[0], variantId: f.variantIds[0], quantity: 1, fulfillmentType: 'backorder', reserved: false,
      }] });
      const draft = await createDraft(db(), { itemId: f.itemIds[0], quantity: 1 });
      const paymentOrderId = await placeOrder(draft);
      const paidAt = (await db().query('select paid_at from public.orders where id=$1', [f.orderId])).rows[0].paid_at;
      return { f, ret, owner, older, newer, draft, paymentOrderId, paidAt };
    });
    const key = randomUUID();
    const receive = (c: PgClient) => c.query(`select replayed from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,
      $4::jsonb,'[]'::jsonb,'consult',null,0,null,false,null,null,null)`, [fx.ret.returnId, fx.owner, key,
    JSON.stringify([{ return_line_id: fx.ret.lineIds[0], quantity: 1, disposition: 'restocked' }])]);
    const other = (c: PgClient) => peer === 'fifo'
      ? c.query(`select public.admin_record_stock_movement($1::bigint,$2::bigint,1,'restock',null,$3::uuid,$4::uuid,null) as result`,
        [fx.f.itemIds[0], fx.f.variantIds[0], fx.owner, randomUUID()])
      : c.query(`select updated,amount_matches from public.mark_order_paid($1::uuid,'payment_in_progress',
        $2::text,$3::integer,'jpy',true,'order_confirmed',null)`,
      [fx.paymentOrderId, `pi_${randomUUID().replaceAll('-', '')}`, fx.draft.totalAmount]);
    const a = await client(); const b = await client();
    let second: Promise<unknown> | undefined;
    try {
      const [blocker, waiter] = [await pid(a), await pid(b)];
      await a.query('begin'); await b.query('begin');
      const first = returnFirst ? await receive(a) : await other(a);
      if (returnFirst) expect(first.rows).toEqual([{ replayed: false }]);
      else if (peer === 'payment') expect(first.rows).toEqual([{ updated: true, amount_matches: true }]);
      else expect(first.rows[0].result).toMatchObject({ allocatedQuantity: 1, replayed: false });
      second = returnFirst ? other(b) : receive(b);
      void second.catch(() => {});
      await waitForAdvisory(db(), waiter, blocker);
      await a.query('commit');
      const completed = await second as Awaited<ReturnType<PgClient['query']>>;
      if (!returnFirst) expect(completed.rows).toEqual([{ replayed: false }]);
      else if (peer === 'payment') expect(completed.rows).toEqual([{ updated: true, amount_matches: true }]);
      else expect(completed.rows[0].result).toMatchObject({ allocatedQuantity: 1, replayed: false });
      expect((await receive(b)).rows).toEqual([{ replayed: true }]);
      await b.query('set constraints all immediate'); await b.query('commit');
      const quantities = (await db().query(`select oi.order_id,a.kind,sum(a.remaining_quantity)::int n
        from public.order_items oi join public.order_item_allocations a on a.order_item_id=oi.id
        where oi.order_id=any($1::uuid[]) and a.remaining_quantity>0 group by oi.order_id,a.kind order by oi.order_id`,
      [[fx.f.orderId, fx.older.orderId, fx.newer.orderId, fx.paymentOrderId]])).rows;
      const expected = [
        { order_id: fx.older.orderId, kind: 'paid', n: 1 },
        { order_id: fx.paymentOrderId, kind: peer === 'payment' ? 'paid' : 'payment_hold', n: 1 },
        ...(peer === 'fifo' ? [{ order_id: fx.newer.orderId, kind: 'paid', n: 1 }] : []),
      ].sort((x, y) => x.order_id.localeCompare(y.order_id));
      expect(quantities).toEqual(expected);
      const free = Number((await db().query('select stock_quantity from public.item_variants where id=$1', [fx.f.variantIds[0]])).rows[0].stock_quantity);
      expect(free).toBe(0);
      expect(quantities.reduce((sum, row) => sum + row.n, free)).toBe(peer === 'fifo' ? 3 : 2);
      expect((await db().query("select count(*)::int n,sum(delta)::int delta from public.stock_movements where return_id=$1 and reason='return'",
        [fx.ret.returnId])).rows).toEqual([{ n: 1, delta: 1 }]);
      expect((await db().query("select count(*)::int n from private.group_g_operations where operation='admin_receive_return' and request_key=$1",
        [key])).rows).toEqual([{ n: 1 }]);
      expect((await db().query('select paid_at from public.orders where id=$1', [fx.f.orderId])).rows[0].paid_at).toEqual(fx.paidAt);
      expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [fx.f.variantIds[0]])).rows).toEqual([]);
    } finally {
      await a.query('rollback');
      if (second) await second.catch(() => {});
      await b.query('rollback'); await Promise.all([a.end(), b.end()]);
    }
  });

  test.each([
    ['payment', true], ['payment', false], ['fifo', true], ['fifo', false],
  ] as const)('return request vs %s (return first=%s): no deadlock, no double allocation, oldest waiting wins', async (peer, returnFirst) => {
    const fx = await withGroupG1FixtureTransaction(db(), async () => {
      // Restore only the settings this fixture's earlier version committed. Use the reset baseline from
      // 20261012235910_order_return_records.sql:467-530; the competing RPCs below never change settings.
      await db().query(`update public.shop_return_settings set requests_enabled=default,request_types=default,
        return_address_name=null,return_address_postal_code=null,return_address_line=null,return_address_phone=null where id=1`);
      await db().query(`update public.shop_return_reason_settings set shown=true,photo='required',
        resolutions='refund_and_exchange',out_of_stock_exchange='make' where reason='defective'`);
      const f = await createShippedOrderFixture(db(), { lines: [{ quantity: 5, extraStock: 1 }],
        shipments: [{ lines: [{ lineIndex: 0, quantity: 3 }] }] });
      const owner = await actorId();
      await db().query(`insert into public.user_roles(user_id,role_id)
        select $1,id from public.roles where code='admin' on conflict do nothing`, [owner]);
      await db().query('update public.orders set user_id=$1 where id=$2', [owner, f.orderId]);
      const older = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-01-01', lines: [{
        itemId: f.itemIds[0], variantId: f.variantIds[0], quantity: 1, fulfillmentType: 'backorder', reserved: false,
      }] });
      const newer = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-02-01', lines: [{
        itemId: f.itemIds[0], variantId: f.variantIds[0], quantity: 1, fulfillmentType: 'backorder', reserved: false,
      }] });
      const draft = await createDraft(db(), { itemId: f.itemIds[0], quantity: 1 });
      const paymentOrderId = await placeOrder(draft);
      return { f, owner, older, newer, draft, paymentOrderId };
    });
    const a = await client();
    const b = await client();
    let second: Promise<unknown> | undefined;
    const request = async (c: PgClient) => {
      const result = await c.query('select status,replayed from public.customer_request_return($1::uuid,$2::uuid,$3::uuid,$4::jsonb)',
        [fx.f.orderId, fx.owner, randomUUID(), JSON.stringify([{ fulfillment_id: fx.f.fulfillments[0].id,
          order_item_id: fx.f.orderItemIds[0], quantity: 1, reason: 'other', customer_note: 'fixture',
          requested_resolution: 'refund', requested_exchange_variant_id: null, photos: [] }])]);
      expect(result.rows).toEqual([{ status: 'requested', replayed: false }]);
    };
    const other = async (c: PgClient) => {
      if (peer === 'fifo') expect((await c.query(`select public.admin_record_stock_movement($1::bigint,$2::bigint,
        1,'restock',null,$3::uuid,$4::uuid,null) as result`,
      [fx.f.itemIds[0], fx.f.variantIds[0], fx.owner, randomUUID()])).rows[0].result)
        .toMatchObject({ allocatedQuantity: 1, releasedQuantity: 0, replayed: false });
      else expect((await c.query(`select updated,amount_matches from public.mark_order_paid($1::uuid,'payment_in_progress',
        $2::text,$3::integer,'jpy',true,'order_confirmed',null)`,
      [fx.paymentOrderId, `pi_${randomUUID().replaceAll('-', '')}`, fx.draft.totalAmount])).rows)
        .toEqual([{ updated: true, amount_matches: true }]);
    };
    try {
      await a.query('begin');
      await b.query('begin');
      const [blocker, waiter] = [await pid(a), await pid(b)];
      if (returnFirst) await request(a); else await other(a);
      second = returnFirst ? other(b) : request(b);
      void second.catch(() => {});
      await waitForAdvisory(db(), waiter, blocker);
      await a.query('commit');
      await second;
      await b.query('commit');
      const quantities = (await db().query(`select oi.order_id,a.kind,sum(a.remaining_quantity)::int n
        from public.order_items oi join public.order_item_allocations a on a.order_item_id=oi.id
        where oi.order_id=any($1::uuid[]) and a.remaining_quantity>0 group by oi.order_id,a.kind`,
      [[fx.f.orderId, fx.older.orderId, fx.newer.orderId, fx.paymentOrderId]])).rows;
      const expected = [
        { order_id: fx.f.orderId, kind: 'paid', n: 2 },
        { order_id: fx.paymentOrderId, kind: peer === 'payment' ? 'paid' : 'payment_hold', n: 1 },
        ...(peer === 'fifo' ? [{ order_id: fx.older.orderId, kind: 'paid', n: 1 }] : []),
      ];
      expect(quantities.sort((x, y) => x.order_id.localeCompare(y.order_id)))
        .toEqual(expected.sort((x, y) => x.order_id.localeCompare(y.order_id)));
      const free = Number((await db().query('select stock_quantity from public.item_variants where id=$1', [fx.f.variantIds[0]])).rows[0].stock_quantity);
      expect(free).toBe(0);
      expect(quantities.reduce((sum, row) => sum + row.n, free)).toBe(peer === 'fifo' ? 4 : 3);
      expect((await db().query(`select status,sum(quantity)::int n from public.list_admin_order_item_states($1::uuid[])
        group by status order by status`, [[fx.f.orderId]])).rows)
        .toEqual([{ status: 'ready', n: 2 }, { status: 'return_requested', n: 1 }, { status: 'shipped', n: 2 }]);
      expect((await db().query('select * from public.verify_stock_integrity() where variant_id=$1', [fx.f.variantIds[0]])).rows).toEqual([]);
    } finally {
      await a.query('rollback');
      if (second) await second.catch(() => {});
      await b.query('rollback');
      await Promise.all([a.end(), b.end()]);
    }
  });
});
