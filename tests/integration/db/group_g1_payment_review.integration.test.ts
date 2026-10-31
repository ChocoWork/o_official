/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import { PRICE, createCatalogFixture, insertOrderWithLines, variantStock } from './helpers/order-fixtures';

/**
 * G-1 Task 7: 支払額の違いの要対応と保留（同じ取引で作る）、検知回数と初回の dispatch、人とシステムの解決（同じ取引で保留を外す）。
 * 試験ごとに BEGIN … ROLLBACK（共通の押さえを先に取る）。想定する拒否は SAVEPOINT で回収する。
 */
describeLocalDb('G-1 Task 7: payment-review hold, dispatch and both resolvers', (db) => {
  let actor: string;

  beforeEach(async () => {
    await db().query('begin');
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    actor = (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-review-${randomUUID()}@example.com`])).rows[0].id;
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

  const pi = () => `pi_${randomUUID().replaceAll('-', '')}`;

  async function markPaid(orderId: string, payment: string, amount: number) {
    return (await db().query(
      `select updated, amount_matches, needs_review from public.mark_order_paid(
         $1::uuid, 'payment_in_progress', $2::text, $3::integer, 'jpy', true, 'order_confirmed', null)`,
      [orderId, payment, amount],
    )).rows[0];
  }

  /** TS の recordException と同じ引数（paymentRef は Session、無ければ PaymentIntent） */
  async function record(args: { ref: string; reason: string; orderId: string | null; session?: string | null; pi?: string | null; detail?: string | null }) {
    return (await db().query(
      `select exception_id, is_new, is_resolved
       from public.record_payment_exception($1::text, $2::text, $3::text, $4::text, $5::text, null, $6::uuid)`,
      [args.ref, args.reason, args.detail ?? null, args.session ?? null, args.pi ?? null, args.orderId],
    )).rows[0] as { exception_id: string; is_new: boolean; is_resolved: boolean };
  }

  async function exceptionsOf(orderId: string) {
    return (await db().query(`select id, payment_ref, reason, detection_count, resolved_at is not null as resolved
      from public.payment_exceptions where order_id = $1 order by reason`, [orderId])).rows;
  }

  async function holdsOf(exceptionId: string) {
    return (await db().query(`select id, request_key, result from private.group_g_operations
      where operation = 'payment_review_hold' and exception_id = $1`, [exceptionId])).rows;
  }

  async function releasesOf(holdId: string) {
    return (await db().query(`select request_key, actor_id, result from private.group_g_operations
      where operation = 'payment_review_release' and cause_type = 'payment_review_hold' and cause_id = $1`, [holdId])).rows;
  }

  async function dispatches(exceptionId: string) {
    return (await db().query(`select request_key from private.group_g_operations
      where operation = 'payment_exception_dispatch' and cause_type = 'payment_exception' and cause_id = $1`, [exceptionId])).rows;
  }

  /** brief の式: 閉じた要対応に、外していない保留が残っていない（この試験の要対応に限る） */
  async function closedWithOpenHold(exceptionIds: string[]) {
    return (await db().query(`select count(*)::int as n from private.group_g_operations h
      join public.payment_exceptions e on e.id = h.exception_id
      where h.operation = 'payment_review_hold' and e.resolved_at is not null and e.id = any($1::uuid[])
        and not exists (select 1 from private.group_g_operations r where r.operation = 'payment_review_release'
          and r.cause_type = 'payment_review_hold' and r.cause_id = h.id::text)`, [exceptionIds])).rows[0].n as number;
  }

  async function paidOf(orderItemId: string) {
    return (await db().query(`select coalesce(sum(remaining_quantity),0)::int as n from public.order_item_allocations
      where order_item_id = $1 and kind = 'paid'`, [orderItemId])).rows[0].n as number;
  }

  async function reasonsOf(orderId: string, orderItemId: string) {
    return (await db().query(`select status, quantity, blocked_reasons from public.list_admin_order_item_states($1)
      where order_item_id = $2 order by status`, [[orderId], orderItemId])).rows;
  }

  /**
   * 2明細の未入金の注文: 明細1は variant 1 の H1（本人の確保）、明細2は variant 2 で未確保（空き在庫1）。
   * 金額の違いで入金済みにすると、本人の A1 は保ち、明細2は保留で新しい FIFO から外れる。
   */
  async function mismatchOrder() {
    const v1 = await createCatalogFixture(db(), { stock: 1 });
    const v2 = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'payment_in_progress', lines: [
      { itemId: v1.itemId, variantId: v1.variantId, quantity: 1, fulfillmentType: 'stock' },
      { itemId: v2.itemId, variantId: v2.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false },
    ] });
    const session = (await db().query('select checkout_session_id from public.orders where id = $1', [o.orderId])).rows[0]
      .checkout_session_id as string;
    const payment = pi();
    expect(await markPaid(o.orderId, payment, PRICE * 2 + 1)).toEqual({ updated: true, amount_matches: false, needs_review: false });
    await flush();
    const [exception] = await exceptionsOf(o.orderId);
    return { o, v1, v2, session, payment, exception, held: o.orderItemIds[0], waiting: o.orderItemIds[1] };
  }

  test('金額の違い: 入金と同じ取引で要対応と保留を1つずつ作り、本人の A は保ち、新しい FIFO から外す', async () => {
    const m = await mismatchOrder();

    expect(m.exception).toEqual({ id: expect.any(String), payment_ref: m.session, reason: 'paid_amount_mismatch',
      detection_count: 1, resolved: false });
    const holds = await holdsOf(m.exception.id);
    expect(holds).toEqual([{ id: expect.any(String), request_key: expect.any(String),
      result: { active: true, order_id: m.o.orderId } }]);
    expect(await releasesOf(holds[0].id)).toEqual([]);
    // DB が先に作った要対応は、まだ dispatch していない（TS の初回の記録が自動の返金権を持つ）
    expect(await dispatches(m.exception.id)).toEqual([]);
    expect(await paidOf(m.held)).toBe(1);
    expect(await paidOf(m.waiting)).toBe(0);
    expect(await variantStock(db(), m.v2.variantId)).toBe(1);
    expect(await reasonsOf(m.o.orderId, m.waiting)).toEqual([
      { status: 'in_production', quantity: 1, blocked_reasons: ['payment_review'] },
    ]);
    // 注文確認のメールは送らない
    expect((await db().query(`select count(*)::int as n from private.order_email_outbox where order_id = $1 and kind = 'paid'`,
      [m.o.orderId])).rows[0].n).toBe(0);
  });

  test('DB が先に作った要対応: TS の初回の記録は同じ行で is_new=true・回数1、再送は false・回数2（参照の違いでも同じ行）', async () => {
    const m = await mismatchOrder();

    // Session の無い写し（payment_intent 系の通知）では、TS の参照は PaymentIntent になる
    const first = await record({ ref: m.payment, reason: 'paid_amount_mismatch', orderId: m.o.orderId, pi: m.payment });
    expect(first).toEqual({ exception_id: m.exception.id, is_new: true, is_resolved: false });
    expect((await exceptionsOf(m.o.orderId))[0].detection_count).toBe(1);
    expect(await dispatches(m.exception.id)).toEqual([
      { request_key: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ]);
    expect((await db().query(`select pg_catalog.md5('exception-dispatch:' || $1::text)::uuid::text as k`, [m.exception.id])).rows[0].k)
      .toBe((await dispatches(m.exception.id))[0].request_key);

    const again = await record({ ref: m.session, reason: 'paid_amount_mismatch', orderId: m.o.orderId, session: m.session, pi: m.payment });
    expect(again).toEqual({ exception_id: m.exception.id, is_new: false, is_resolved: false });
    expect(await exceptionsOf(m.o.orderId)).toEqual([{ ...m.exception, detection_count: 2 }]);
    expect(await holdsOf(m.exception.id)).toHaveLength(1);
    expect(await dispatches(m.exception.id)).toHaveLength(1);
  });

  test('照合が先に記録する金額の違い（入金済み×入金済み）も要対応と保留を同時に作る。ほかの理由は保留を作らない', async () => {
    const c = await createCatalogFixture(db(), { stock: 0 });
    const o = await insertOrderWithLines(db(), { status: 'paid', paymentIntentId: pi(),
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    const session = (await db().query('select checkout_session_id from public.orders where id = $1', [o.orderId])).rows[0].checkout_session_id;

    const first = await record({ ref: session, reason: 'paid_amount_mismatch', orderId: o.orderId, session, detail: 'zero_amount' });
    expect(first).toMatchObject({ is_new: true, is_resolved: false });
    expect(await holdsOf(first.exception_id)).toHaveLength(1);
    expect((await db().query('select detail, detection_count from public.payment_exceptions where id = $1', [first.exception_id])).rows[0])
      .toEqual({ detail: 'zero_amount', detection_count: 1 });
    expect(await record({ ref: session, reason: 'paid_amount_mismatch', orderId: o.orderId, session }))
      .toEqual({ exception_id: first.exception_id, is_new: false, is_resolved: false });

    const refund = await record({ ref: `re_${randomUUID()}`, reason: 'refund_failed', orderId: o.orderId, detail: 'expired_or_canceled_card' });
    expect(refund).toMatchObject({ is_new: true, is_resolved: false });
    expect(await holdsOf(refund.exception_id)).toEqual([]);
    expect(await record({ ref: `re_${randomUUID()}`, reason: 'refund_failed', orderId: null })).toMatchObject({ is_new: true });
    await flush();
  });

  test('人の解決: 同じ取引で保留を外し（release 1回）、通常の FIFO で割り当てる。再送は何もしない', async () => {
    const m = await mismatchOrder();
    const [hold] = await holdsOf(m.exception.id);

    const res = (await db().query(
      `select resolved, order_id, cancelled_from from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)`,
      [m.exception.id, actor, '差額を返金した'],
    )).rows[0];
    await flush();

    expect(res).toEqual({ resolved: true, order_id: m.o.orderId, cancelled_from: null });
    expect(await releasesOf(hold.id)).toEqual([{
      request_key: (await db().query(`select pg_catalog.md5('review-release:' || $1::text)::uuid::text as k`, [hold.id])).rows[0].k,
      actor_id: actor, result: { active: false },
    }]);
    expect(await closedWithOpenHold([m.exception.id])).toBe(0);
    expect(await paidOf(m.waiting)).toBe(1);
    expect(await variantStock(db(), m.v2.variantId)).toBe(0);
    expect(await reasonsOf(m.o.orderId, m.waiting)).toEqual([{ status: 'ready', quantity: 1, blocked_reasons: [] }]);
    const ops = (await db().query(`select id, actor_id from private.group_g_operations
      where operation = 'resolve_payment_exception' and cause_id = $1`, [m.exception.id])).rows;
    expect(ops).toEqual([{ id: expect.any(String), actor_id: actor }]);
    expect((await db().query(`select sequence, from_status, to_status from public.order_item_state_events
      where operation_id = $1 order by sequence`, [ops[0].id])).rows)
      .toEqual([{ sequence: 2, from_status: 'in_production', to_status: 'ready' }]);

    const replay = (await db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, null)',
      [m.exception.id, actor])).rows[0];
    expect(replay.resolved).toBe(false);
    expect(await releasesOf(hold.id)).toHaveLength(1);
  });

  test('システムの解決も同じ結果（保留を外して FIFO）。明示の NULL メモの呼び出しも通る', async () => {
    const m = await mismatchOrder();
    const [hold] = await holdsOf(m.exception.id);

    expect((await db().query('select public.resolve_payment_exception_by_system($1::uuid, null::text) as ok', [m.exception.id])).rows[0].ok)
      .toBe(true);
    await flush();

    expect(await releasesOf(hold.id)).toEqual([expect.objectContaining({ actor_id: null, result: { active: false } })]);
    expect(await closedWithOpenHold([m.exception.id])).toBe(0);
    expect(await paidOf(m.waiting)).toBe(1);
    expect((await db().query('select resolved_by, resolved_at is not null as resolved from public.payment_exceptions where id = $1',
      [m.exception.id])).rows[0]).toEqual({ resolved_by: null, resolved: true });
    expect((await db().query('select public.resolve_payment_exception_by_system($1::uuid, $2::text) as ok',
      [m.exception.id, '再送'])).rows[0].ok).toBe(false);
    expect(await releasesOf(hold.id)).toHaveLength(1);
  });

  test('要確認を確認済みにするだけでは保留を外さず、FIFO からも外れたまま', async () => {
    const m = await mismatchOrder();
    const [hold] = await holdsOf(m.exception.id);
    await db().query(`update public.orders set review_reason = 'stock_not_reserved', review_marked_at = now() where id = $1`, [m.o.orderId]);

    expect((await db().query('select public.mark_order_reviewed($1::uuid, $2::uuid) as reviewed', [m.o.orderId, actor])).rows[0].reviewed)
      .toBe(true);
    await flush();

    expect(await releasesOf(hold.id)).toEqual([]);
    expect(await paidOf(m.waiting)).toBe(0);
    expect(await reasonsOf(m.o.orderId, m.waiting)).toEqual([
      { status: 'in_production', quantity: 1, blocked_reasons: ['payment_review'] },
    ]);
  });

  test.each([
    ['要対応の作成', 'public.payment_exceptions', ''],
    ['保留の作成', 'private.group_g_operations', `when (new.operation = 'payment_review_hold')`],
  ])('%sの故障で、入金・要対応・保留のどれも残らない', async (_name, table, condition) => {
    const c1 = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'payment_in_progress',
      lines: [{ itemId: c1.itemId, variantId: c1.variantId, quantity: 1, fulfillmentType: 'stock' }] });
    await flush();

    await db().query('savepoint fault');
    await db().query(`create function public.g1_task7_fault() returns trigger language plpgsql as
      $f$ begin raise exception 'G1_TASK7_FAULT' using errcode = 'P0001'; end $f$`);
    await db().query(`create trigger g1_task7_fault before insert on ${table} for each row ${condition}
      execute function public.g1_task7_fault()`);
    await expect(markPaid(o.orderId, pi(), PRICE + 1)).rejects.toMatchObject({ message: 'G1_TASK7_FAULT' });
    await db().query('rollback to savepoint fault');
    await db().query('release savepoint fault');

    expect(await exceptionsOf(o.orderId)).toEqual([]);
    expect((await db().query(`select count(*)::int as n from private.group_g_operations
      where operation = 'payment_review_hold' and result->>'order_id' = $1`, [o.orderId])).rows[0].n).toBe(0);
    expect((await db().query('select status::text as status, paid_at from public.orders where id = $1', [o.orderId])).rows[0])
      .toEqual({ status: 'payment_in_progress', paid_at: null });
    expect((await db().query(`select kind from public.order_item_allocations where order_item_id = $1`, [o.orderItemIds[0]])).rows)
      .toEqual([{ kind: 'payment_hold' }]);
  });

  test('取消を伴う人の解決: H を外して古い待ち注文へ FIFO し、公開の解放 RPC を入れ子で呼ばない', async () => {
    const c = await createCatalogFixture(db(), { stock: 1 });
    const unpaid = await insertOrderWithLines(db(), { status: 'pending', createdAt: '2026-03-01',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock' }] });
    const older = await insertOrderWithLines(db(), { status: 'paid', createdAt: '2026-01-01',
      lines: [{ itemId: c.itemId, variantId: c.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    const exception = await record({ ref: `cs_${randomUUID()}`, reason: 'unexpected_state', orderId: unpaid.orderId });
    await flush();

    const res = (await db().query(
      `select resolved, order_id, cancelled_from::text as cancelled_from
       from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text, true, 'other', false)`,
      [exception.exception_id, actor, 'Stripe に支払いが無い'],
    )).rows[0];
    await flush();

    expect(res).toEqual({ resolved: true, order_id: unpaid.orderId, cancelled_from: 'pending' });
    expect((await db().query('select status::text as status, cancel_reason from public.orders where id = $1', [unpaid.orderId])).rows[0])
      .toEqual({ status: 'cancelled', cancel_reason: 'other' });
    expect(await paidOf(older.orderItemIds[0])).toBe(1);
    expect(await variantStock(db(), c.variantId)).toBe(0);
    expect((await db().query(`select count(*)::int as n from private.group_g_operations where operation = 'release_stock_for_unpaid_order'
      and cause_id = $1`, [unpaid.orderId])).rows[0].n).toBe(0);
    expect((await db().query(`select count(*)::int as n from private.group_g_operations where operation = 'resolve_payment_exception'
      and cause_id = $1`, [exception.exception_id])).rows[0].n).toBe(1);

    const src = (await db().query(`select prosrc from pg_proc
      where oid = 'private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)'::regprocedure`)).rows[0].prosrc as string;
    expect(src).not.toMatch(/release_stock_for_unpaid_order/);
    expect(src.indexOf('private.lock_group_g_inventory')).toBeGreaterThan(0);
    expect(src.indexOf('private.group_h_lock_acceptance(NULL, v_order_id)')).toBeGreaterThan(0);
    expect(src.indexOf('private.group_h_lock_acceptance(NULL, v_order_id)')).toBeLessThan(src.indexOf('private.lock_group_g_inventory'));
    expect(src.indexOf('private.lock_group_g_inventory')).toBeLessThan(src.indexOf('FOR UPDATE'));
  });

  test.each([null, '', '   '])('返金の失敗の手動解決は空のメモ（%j）を拒否する（J-04）', async (note) => {
    const exception = await record({ ref: `re_${randomUUID()}`, reason: 'refund_failed', orderId: null });

    expect(await rejected(() => db().query('select resolved from public.resolve_payment_exception($1::uuid, $2::uuid, $3::text)',
      [exception.exception_id, actor, note]))).toEqual({ code: '22023', message: 'RESOLUTION_NOTE_REQUIRED' });
    expect((await db().query('select resolved_at from public.payment_exceptions where id = $1', [exception.exception_id])).rows[0].resolved_at)
      .toBeNull();
  });

  test('公開の入口は service_role 専用の SECURITY INVOKER、本体と保留を外す core は private（core は service_role も不可）', async () => {
    const rows = (await db().query(`select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname in ('record_payment_exception','resolve_payment_exception',
        'resolve_payment_exception_by_system','mark_order_reviewed','release_group_g_payment_review_holds')
      order by 1`)).rows;
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      const isPrivate = row.signature.startsWith('private.');
      const isCore = row.signature.startsWith('private.release_group_g_payment_review_holds');
      expect(row).toMatchObject({ prosecdef: isPrivate, proconfig: ['search_path=""'], anon: false, authenticated: false,
        service_role: !isCore });
    }
  });
});
