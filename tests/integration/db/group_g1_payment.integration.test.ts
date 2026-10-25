/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithLines, variantStock } from './helpers/order-fixtures';

/**
 * G-1 Task 7: 入金（H→A を先に・案A）、初めての入金の時刻 paid_at（一度だけ・誰も変えられない）、
 * 期限後の入金と取消後の入金、NULL variant の要確認。試験ごとに BEGIN … ROLLBACK（共通の押さえを先に取る）。
 */
describeLocalDb('G-1 Task 7: payment, H->A and the first paid_at', (db) => {
  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  });
  afterEach(async () => { await db().query('rollback'); });

  async function flush() {
    await db().query('set constraints group_g_allocation_bounds, group_g_stock_movement_consistency immediate');
    await db().query('set constraints all deferred');
  }

  async function rejected(run: () => Promise<unknown>) {
    await db().query('savepoint expected_failure');
    try {
      await run();
      await flush();
      return {};
    } catch (e) {
      const error = e as { code?: string; message?: string };
      return { code: error.code, message: error.message };
    } finally {
      await db().query('rollback to savepoint expected_failure');
      await db().query('release savepoint expected_failure');
    }
  }

  async function markPaid(orderId: string, expected: string, pi: string, amount: number, event: string | null = null) {
    return (await db().query(
      `select updated, amount_matches, needs_review from public.mark_order_paid(
         $1::uuid, $2::public.order_status, $3::text, $4::integer, 'jpy', true, 'order_confirmed', $5::text)`,
      [orderId, expected, pi, amount, event],
    )).rows[0];
  }

  async function paidAt(orderId: string): Promise<number | null> {
    const at = (await db().query('select paid_at from public.orders where id = $1', [orderId])).rows[0].paid_at as Date | null;
    return at === null ? null : at.getTime();
  }

  async function allocations(orderItemId: string) {
    return (await db().query(`select kind, sum(remaining_quantity)::int as n from public.order_item_allocations
      where order_item_id = $1 and remaining_quantity > 0 group by kind order by kind`, [orderItemId])).rows;
  }

  async function states(orderId: string) {
    return (await db().query(`select order_item_id, status, quantity, blocked_reasons
      from public.list_admin_order_item_states($1) order by order_item_id, status`, [[orderId]])).rows;
  }

  async function operations(operation: string, causeId: string) {
    return (await db().query('select id, result from private.group_g_operations where operation = $1 and cause_id = $2',
      [operation, causeId])).rows;
  }

  /** 入荷（共通の押さえ・台帳の restock・FIFO・状態の履歴を1つの操作で） */
  async function receipt(variantId: number, quantity: number) {
    const orders = (await db().query('select private.lock_group_g_inventory($1,$2) as ids', [[variantId], []])).rows[0].ids;
    const before = (await db().query('select private.capture_group_g_item_states($1) as states', [orders])).rows[0].states;
    const op = randomUUID();
    await db().query(`insert into private.group_g_operations (id,operation,request_key,fingerprint,cause_type,cause_id,result)
      values ($1,'payment_test_receipt',$2,repeat('e',64),'test',$3,'{}')`, [op, randomUUID(), op]);
    await db().query(`insert into public.stock_movements (variant_id,delta,reason) values ($1,$2,'restock')`, [variantId, quantity]);
    const n = (await db().query('select private.allocate_group_g_fifo($1,$2,$3) as n', [[variantId], op, null])).rows[0].n;
    await db().query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)', [JSON.stringify(before), orders, op, 'fifo', null]);
    await flush();
    return n as number;
  }

  const pi = () => `pi_${randomUUID().replaceAll('-', '')}`;

  test('案A: 古い待ち2・新しい H2 → 新しい本人が A2 を保ち古い方は0、次の入荷2で古い方が2', async () => {
    const c = await createCatalogFixture(db(), { stock: 2 });
    const young = await insertOrderWithLines(db(), { status: 'payment_in_progress', createdAt: '2026-02-01',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'stock' }] });
    const old = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-01-01',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'stock', reserved: false }] });
    await flush();
    expect(await allocations(young.orderItemIds[0])).toEqual([{ kind: 'payment_hold', n: 2 }]);
    const movementsBefore = (await db().query('select count(*)::int as n from public.stock_movements where variant_id = $1', [c.variantId])).rows[0].n;

    expect(await markPaid(young.orderId, 'payment_in_progress', pi(), PRICE * 2))
      .toEqual({ updated: true, amount_matches: true, needs_review: false });
    await flush();

    expect(await allocations(young.orderItemIds[0])).toEqual([{ kind: 'paid', n: 2 }]);
    expect(await allocations(old.orderItemIds[0])).toEqual([]);
    expect(await variantStock(db(), c.variantId)).toBe(0);
    // H → A は台帳を足さない（promote だけ）
    expect((await db().query('select count(*)::int as n from public.stock_movements where variant_id = $1', [c.variantId])).rows[0].n)
      .toBe(movementsBefore);
    const [op] = await operations('mark_order_paid', young.orderId);
    expect(op.result).toMatchObject({ promoted_quantity: 2, allocated_quantity: 0, amount_matches: true });
    expect((await db().query(`select e.event_type, e.quantity from public.order_item_allocation_events e
      join public.order_item_allocations a on a.id = e.allocation_id
      where a.order_item_id = $1 and e.operation_id = $2`, [young.orderItemIds[0], op.id])).rows)
      .toEqual([{ event_type: 'promote', quantity: 2 }]);

    expect(await receipt(c.variantId, 2)).toBe(2);
    expect(await allocations(old.orderItemIds[0])).toEqual([{ kind: 'paid', n: 2 }]);
    expect(await allocations(young.orderItemIds[0])).toEqual([{ kind: 'paid', n: 2 }]);
  });

  test('初めての入金の時刻: 正常・0円・金額不一致で一度だけ書き、再送・CAS 不一致・別の更新では変わらない', async () => {
    const c = await createCatalogFixture(db(), { stock: 3 });
    const normal = await insertOrderWithLines(db(), { status: 'payment_in_progress',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock' }] });
    // 0円: 注文の合計は正（orders_total_amount_check）で、Stripe が受け取った額が0の入金（zero_amount_complete）
    const zero = await insertOrderWithLines(db(), { status: 'payment_in_progress',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock' }] });
    const mismatch = await insertOrderWithLines(db(), { status: 'payment_in_progress',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock' }] });
    const normalPi = pi();

    expect(await paidAt(normal.orderId)).toBeNull();
    expect(await markPaid(normal.orderId, 'payment_in_progress', normalPi, PRICE, 'evt_g1_paid_at'))
      .toEqual({ updated: true, amount_matches: true, needs_review: false });
    expect(await markPaid(zero.orderId, 'payment_in_progress', pi(), 0))
      .toEqual({ updated: true, amount_matches: false, needs_review: false });
    expect(await markPaid(mismatch.orderId, 'payment_in_progress', pi(), PRICE + 1))
      .toEqual({ updated: true, amount_matches: false, needs_review: false });
    await flush();
    const first = await paidAt(normal.orderId);
    expect(first).not.toBeNull();
    expect(await paidAt(zero.orderId)).not.toBeNull();
    expect(await paidAt(mismatch.orderId)).not.toBeNull();

    // 再送（同じ event）・CAS 不一致は何も書かない（操作も増えない）
    expect(await markPaid(normal.orderId, 'payment_in_progress', normalPi, PRICE, 'evt_g1_paid_at'))
      .toEqual({ updated: false, amount_matches: null, needs_review: null });
    expect(await markPaid(normal.orderId, 'pending', normalPi, PRICE))
      .toEqual({ updated: false, amount_matches: null, needs_review: null });
    expect(await paidAt(normal.orderId)).toBe(first);
    expect(await operations('mark_order_paid', normal.orderId)).toHaveLength(1);

    // 入金の後の別の列の更新（要確認など）は paid_at を変えない
    await db().query(`update public.orders set review_reason = 'stock_not_reserved', review_marked_at = now() where id = $1`,
      [normal.orderId]);
    expect(await paidAt(normal.orderId)).toBe(first);
  });

  test('paid_at の変更・NULL 戻しは誰からでも GROUP_G_PAID_AT_IMMUTABLE / 55000（service_role の直接の UPDATE も）', async () => {
    const c = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'payment_in_progress',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock' }] });
    await markPaid(o.orderId, 'payment_in_progress', pi(), PRICE);
    const first = await paidAt(o.orderId);
    const immutable = { code: '55000', message: 'GROUP_G_PAID_AT_IMMUTABLE' };

    expect(await rejected(() => db().query(
      `update public.orders set paid_at = paid_at + interval '1 day' where id = $1`, [o.orderId]))).toEqual(immutable);
    expect(await rejected(() => db().query('update public.orders set paid_at = null where id = $1', [o.orderId]))).toEqual(immutable);
    expect(await rejected(async () => {
      await db().query('set local role service_role');
      await db().query('update public.orders set paid_at = null where id = $1', [o.orderId]);
    })).toEqual(immutable);
    expect(await rejected(async () => {
      await db().query('set local role service_role');
      await db().query('update public.orders set paid_at = now() - interval \'1 day\' where id = $1', [o.orderId]);
    })).toEqual(immutable);
    expect((await db().query('select current_user as u')).rows[0].u).toBe('postgres');
    expect(await paidAt(o.orderId)).toBe(first);
  });

  test('期限後の入金: 期限切れ → 受注生産中、割り当てた分だけ準備中。paid_at を書く', async () => {
    const c = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'pending',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'stock', reserved: false }] });
    await db().query(`select released from public.release_stock_for_unpaid_order(
      $1::uuid, 'pending', 'failed', 'stripe_voucher_expired')`, [o.orderId]);
    await flush();
    expect((await states(o.orderId)).map((r) => ({ status: r.status, quantity: r.quantity })))
      .toEqual([{ status: 'payment_expired', quantity: 2 }]);

    expect(await markPaid(o.orderId, 'failed', pi(), PRICE * 2)).toEqual({ updated: true, amount_matches: true, needs_review: false });
    await flush();

    expect(await paidAt(o.orderId)).not.toBeNull();
    expect((await states(o.orderId)).map((r) => ({ status: r.status, quantity: r.quantity })))
      .toEqual([{ status: 'in_production', quantity: 1 }, { status: 'ready', quantity: 1 }]);
    expect(await variantStock(db(), c.variantId)).toBe(0);
    const [op] = await operations('mark_order_paid', o.orderId);
    expect((await db().query(`select sequence, from_status, to_status, quantity from public.order_item_state_events
      where operation_id = $1 order by sequence, unit_from`, [op.id])).rows).toEqual([
      { sequence: 1, from_status: 'payment_expired', to_status: 'in_production', quantity: 2 },
      { sequence: 2, from_status: 'in_production', to_status: 'ready', quantity: 1 },
    ]);
  });

  test('取消後の入金: 受け取った額と paid_at を一度だけ書き、再送では変えない', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const o = await insertOrderWithLines(db(), { status: 'cancelled',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    const payment = pi();
    const write = () => db().query('select public.record_cancelled_order_paid_amount($1::uuid,$2::text,$3::integer) as written',
      [o.orderId, payment, PRICE]);

    expect((await write()).rows[0].written).toBe(true);
    await flush();
    const first = await paidAt(o.orderId);
    expect(first).not.toBeNull();
    expect((await write()).rows[0].written).toBe(false);
    expect(await paidAt(o.orderId)).toBe(first);
    expect(await operations('record_cancelled_order_paid_amount', o.orderId)).toHaveLength(1);
    expect((await db().query('select status::text as status, paid_amount from public.orders where id = $1', [o.orderId])).rows[0])
      .toEqual({ status: 'cancelled', paid_amount: PRICE });
  });

  test('取消後の入金とエの自動の返金: 取消済みのまま。状態の履歴は増えず、受注生産は0 (paid_at や paid_amount で入金済みに戻さない)', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const o = await insertOrderWithLines(db(), { status: 'cancelled',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 2, fulfillmentType: 'stock', reserved: false }] });
    const stateEvents = async () => (await db().query(`select count(*)::int as n from public.order_item_state_events e
      join public.order_items oi on oi.id = e.order_item_id where oi.order_id = $1`, [o.orderId])).rows[0].n as number;
    const waiting = async () => (await db().query('select waiting from public.list_group_g_variant_inventory($1)',
      [[c.variantId]])).rows[0].waiting as number;
    const view = async () => (await states(o.orderId)).map((r) => ({ status: r.status, quantity: r.quantity, blocked_reasons: r.blocked_reasons }));
    const cancelled = [{ status: 'cancelled', quantity: 2, blocked_reasons: [] }];

    expect(await view()).toEqual(cancelled);
    expect(await waiting()).toBe(0);
    const events = await stateEvents();

    // 取消後に届いた入金: 受け取った額と paid_at が付いても、未発送で割当の無い分は取消済みのまま
    expect((await db().query('select public.record_cancelled_order_paid_amount($1::uuid,$2::text,$3::integer) as written',
      [o.orderId, pi(), PRICE * 2])).rows[0].written).toBe(true);
    await flush();
    expect(await paidAt(o.orderId)).not.toBeNull();
    expect(await view()).toEqual(cancelled);
    expect(await waiting()).toBe(0);
    expect(await stateEvents()).toBe(events);

    // エ: 取消済みの注文への入金の自動の全額返金（行なし）は、返事待ちでも成功の後でも取消済みのまま
    const refundId = (await db().query(`select refund_id from public.begin_order_refund(
      $1::uuid, 'auto_cancelled_order_payment', null::uuid, '[]'::jsonb, true, 0, 0, null::text, null::text, null::text, true,
      null::uuid, $2::integer)`, [o.orderId, PRICE * 2])).rows[0].refund_id as string;
    await flush();
    expect(await view()).toEqual(cancelled);
    expect(await waiting()).toBe(0);
    expect(await stateEvents()).toBe(events);

    await db().query(`select * from public.record_order_refund_result($1::uuid, $2::text, 'succeeded', null, null, null,
      'card', null, null)`, [refundId, `re_${refundId.replaceAll('-', '')}`]);
    await flush();
    expect(await view()).toEqual(cancelled);
    expect(await waiting()).toBe(0);
    expect(await stateEvents()).toBe(events);
  });

  test('NULL variant: 既存の要確認（stock_not_reserved）にし、確認済みにしても variant_missing のまま FIFO の外', async () => {
    const actor = (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-payment-${randomUUID()}@example.com`])).rows[0].id;
    const c = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'payment_in_progress', lines: [
      { itemId: c.itemId, variantId: null, quantity: 1, fulfillmentType: 'stock', reserved: false },
      { itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false },
    ] });
    const [missingLine, normalLine] = o.orderItemIds;

    expect(await markPaid(o.orderId, 'payment_in_progress', pi(), PRICE * 2))
      .toEqual({ updated: true, amount_matches: true, needs_review: true });
    await flush();
    const order = (await db().query('select review_reason, review_marked_at, reviewed_at from public.orders where id = $1', [o.orderId])).rows[0];
    expect(order.review_reason).toBe('stock_not_reserved');
    expect(order.review_marked_at).not.toBeNull();
    // 通常の明細は FIFO で割り当て、NULL の明細は割り当てない
    expect(await allocations(normalLine)).toEqual([{ kind: 'paid', n: 1 }]);
    expect(await allocations(missingLine)).toEqual([]);
    const missingState = () => states(o.orderId).then((rows) => rows.filter((r) => r.order_item_id === missingLine));
    expect(await missingState()).toEqual([
      { order_item_id: missingLine, status: 'in_production', quantity: 1, blocked_reasons: ['variant_missing'] },
    ]);

    expect((await db().query('select public.mark_order_reviewed($1::uuid,$2::uuid) as reviewed', [o.orderId, actor])).rows[0].reviewed)
      .toBe(true);
    expect((await db().query('select public.mark_order_reviewed($1::uuid,$2::uuid) as reviewed', [o.orderId, actor])).rows[0].reviewed)
      .toBe(false);
    expect(await missingState()).toEqual([
      { order_item_id: missingLine, status: 'in_production', quantity: 1, blocked_reasons: ['variant_missing'] },
    ]);
    expect(await allocations(missingLine)).toEqual([]);
    expect((await db().query(`select count(*)::int as n from private.group_g_operations
      where operation = 'mark_order_reviewed' and cause_id like $1`, [`${o.orderId}:%`])).rows[0].n).toBe(1);
  });

  test('公開の入口は service_role 専用の SECURITY INVOKER で、本体は private の SECURITY DEFINER（search_path 空）', async () => {
    const rows = (await db().query(`select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig,
        p.proowner::regrole::text as owner,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname in ('mark_order_paid','record_cancelled_order_paid_amount')
      order by 1`)).rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const isPrivate = row.signature.startsWith('private.');
      expect(row).toMatchObject({ prosecdef: isPrivate, proconfig: ['search_path=""'], owner: 'postgres',
        anon: false, authenticated: false, service_role: true });
    }
    // 下書きへ支払いの番号を書き戻さない。入金の本体は共通の押さえ（lock helper）を最初の行の操作より前に取る
    const src = (await db().query(`select prosrc from pg_proc
      where oid = 'private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)'::regprocedure`)).rows[0].prosrc as string;
    expect(src).not.toMatch(/UPDATE public\.checkout_drafts/);
    expect(src.indexOf('private.lock_group_g_inventory')).toBeGreaterThan(0);
    expect(src.indexOf('private.lock_group_g_inventory')).toBeLessThan(src.indexOf('FROM public.orders AS o WHERE o.id = _order_id'));
  });
});
