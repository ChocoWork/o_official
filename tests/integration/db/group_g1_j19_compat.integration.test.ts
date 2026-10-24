/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeLocalDb } from './helpers/local-db';
import {
  createCatalogFixture, createDraft, createShippedOrderFixture, insertCancelRequest, insertOrderWithLines, insertReturnRecord,
  shipFixtureOrder,
} from './helpers/order-fixtures';
import { cancelDeliveryFixture } from './helpers/delivery-tracking-fixtures';
import { setOrderStatusForFixture } from './helpers/group-g1-fixtures';

/**
 * J-19 との両立（Task 16 の 16）。保留中の supabase/pending/harden_order_state_transitions.sql（注文の状態の変更に理由が要る・
 * 設計書 4-1 の表に無い移り方を断る）は開店の準備で当てる。G-1 の状態を変える関数と DB の材料が、それを当てた DB でも通ることを、
 * 試験ごとの取引の中で保留の SQL を当て（自身の BEGIN/COMMIT を外す）、流れを動かし、最後に必ず戻して確かめる。
 * 保留の SQL を当てない DB では、ほかの G-1 の suite が同じ流れを確かめる（どちらの DB でも通る）。
 */
jest.setTimeout(60000);

const J19_SQL = fs.readFileSync(path.join(process.cwd(), 'supabase/pending/harden_order_state_transitions.sql'), 'utf8');
const J19_BODY = J19_SQL.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

describe('J-19 の保留の SQL の形（DB なし）', () => {
  test('取引の印は先頭の BEGIN と末尾の COMMIT の1組だけで、外した本文に取引の文が残らない', () => {
    expect(J19_SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(J19_SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(J19_BODY).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;\s*$/im);
    expect(J19_BODY).toContain('ORDER_STATUS_CHANGE_REQUIRES_REASON');
  });
});

describeLocalDb('G-1 Task 16: J-19（状態の変更の理由と移り方）を当てた DB でも G-1 の流れが通る', (db) => {
  let actor: string;

  beforeEach(async () => {
    await db().query('begin');
    // The common advisory first, then the pending J-19 SQL, all inside this transaction (rolled back below).
    await db().query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
    await db().query(J19_BODY);
    actor = (await db().query(`insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
      values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [`g1-j19-${randomUUID()}@example.com`])).rows[0].id;
  });
  afterEach(async () => {
    await db().query('rollback');
  });

  async function status(orderId: string): Promise<string> {
    return (await db().query('select status::text as status from public.orders where id = $1', [orderId])).rows[0].status;
  }

  async function flush() {
    await db().query('set constraints all immediate');
    await db().query('set constraints all deferred');
  }

  async function placed(quantity = 1) {
    const fx = await createCatalogFixture(db(), { stock: 3 });
    const draft = await createDraft(db(), { itemId: fx.itemId, quantity });
    const orderId = (await db().query(
      `select order_id from public.place_order_from_checkout_draft($1::uuid,$2::text,$3::text,$4::integer,0,'jpy',now(),null::text)`,
      [draft.draftId, draft.checkoutSessionId, draft.cartSessionId, draft.totalAmount],
    )).rows[0].order_id as string;
    const orderItemId = (await db().query('select id from public.order_items where order_id = $1', [orderId])).rows[0].id as string;
    return { fx, draft, orderId, orderItemId };
  }

  const newPi = () => `pi_${randomUUID().replaceAll('-', '')}`;

  async function markPaid(orderId: string, expected: string, amount: number, pi = newPi()) {
    return (await db().query(`select updated from public.mark_order_paid($1::uuid,$2::public.order_status,$3::text,$4::integer,
      'jpy',true,'order_confirmed',null)`, [orderId, expected, pi, amount])).rows[0];
  }

  async function awaiting(orderId: string, pi = newPi()) {
    return (await db().query('select updated from public.mark_order_awaiting_payment($1::uuid,$2::text,null)',
      [orderId, pi])).rows[0];
  }

  async function fullRefund(orderId: string) {
    return (await db().query(`select refund_id from public.begin_order_refund($1::uuid,'order_cancel',$2::uuid,'[]'::jsonb,true,
      null,null,null,null,'customer_request',false,$3::uuid,null)`, [orderId, randomUUID(), actor])).rows[0].refund_id as string;
  }

  async function refundResult(refundId: string, stripeStatus: string) {
    return (await db().query(`select status from public.record_order_refund_result($1::uuid,$2::text,$3::text,
      null,null,null,'card',null,null)`, [refundId, `re_${refundId.replaceAll('-', '')}`, stripeStatus])).rows[0];
  }

  test('この取引では J-19 が効いている（理由の無い状態の変更・表に無い移り方を断る）', async () => {
    const o = await placed();
    await db().query('savepoint no_reason');
    await expect(db().query("update public.orders set status = 'pending' where id = $1", [o.orderId]))
      .rejects.toMatchObject({ code: '23514', message: 'ORDER_STATUS_CHANGE_REQUIRES_REASON' });
    await db().query('rollback to savepoint no_reason');
    await db().query('savepoint not_allowed');
    await expect(setOrderStatusForFixture(db(), [o.orderId], 'shipped'))
      .rejects.toMatchObject({ code: '23514', message: 'ORDER_STATUS_TRANSITION_NOT_ALLOWED:payment_in_progress->shipped' });
    await db().query('rollback to savepoint not_allowed');
  });

  test('受付 → 入金待ち → 入金 → 発送（材料）→ 発送の取消（材料）', async () => {
    const o = await placed();
    expect(await status(o.orderId)).toBe('payment_in_progress');
    const pi = newPi();
    expect(await awaiting(o.orderId, pi)).toEqual({ updated: true });
    expect(await status(o.orderId)).toBe('pending');
    expect(await markPaid(o.orderId, 'pending', o.draft.totalAmount, pi)).toEqual({ updated: true });
    expect(await status(o.orderId)).toBe('paid');
    const shipped = await shipFixtureOrder(db(), { orderId: o.orderId, actorId: actor, lines: [{ order_item_id: o.orderItemId, quantity: 1 }] });
    expect(shipped).toMatchObject({ completes_order: true, order_status: 'shipped' });
    await cancelDeliveryFixture(db(), { orderId: o.orderId, fulfillmentId: shipped.fulfillment_id, actorId: actor });
    expect(await status(o.orderId)).toBe('paid');
    await flush();
  });

  test('未入金の解放: 放棄・入金待ちの失敗 → 管理者の取消・管理者の取消（支払い手続き中）', async () => {
    const abandoned = await placed();
    await db().query(`select released from public.release_stock_for_unpaid_order($1::uuid,'payment_in_progress','abandoned',
      'stripe_checkout_expired')`, [abandoned.orderId]);
    expect(await status(abandoned.orderId)).toBe('abandoned');

    const failed = await placed();
    await awaiting(failed.orderId);
    expect((await db().query(`select released from public.release_stock_for_unpaid_order($1::uuid,'pending','failed',
      'stripe_voucher_expired')`, [failed.orderId])).rows[0]).toEqual({ released: true });
    expect(await status(failed.orderId)).toBe('failed');
    expect((await db().query(`select status::text as status from public.admin_cancel_failed_order($1::uuid,$2::uuid,'customer_request',null)`,
      [failed.orderId, actor])).rows[0]).toEqual({ status: 'cancelled' });

    const cancelled = await placed();
    await db().query(`select released from public.release_stock_for_unpaid_order($1::uuid,'payment_in_progress','cancelled',
      'admin_cancel',$2::uuid,null,'customer_request',null,false)`, [cancelled.orderId, actor]);
    expect(await status(cancelled.orderId)).toBe('cancelled');
    await flush();
  });

  test('全額の返金で取消、返金の失敗で入金済みへ戻す', async () => {
    const o = await placed();
    await markPaid(o.orderId, 'payment_in_progress', o.draft.totalAmount);
    const refundId = await fullRefund(o.orderId);
    expect(await refundResult(refundId, 'succeeded')).toEqual({ status: 'succeeded' });
    expect(await status(o.orderId)).toBe('cancelled');
    expect(await refundResult(refundId, 'failed')).toEqual({ status: 'failed' });
    expect(await status(o.orderId)).toBe('paid');
    await flush();
  });

  test('支払いの要対応の解決で未入金の注文を取り消す', async () => {
    const o = await placed();
    await awaiting(o.orderId);
    const exception = (await db().query(`select exception_id from public.record_payment_exception($1::text,'unexpected_state',
      null,null,null,null,$2::uuid)`, [`cs_${randomUUID()}`, o.orderId])).rows[0].exception_id as string;
    expect((await db().query(`select resolved, cancelled_from::text as cancelled_from
      from public.resolve_payment_exception($1::uuid,$2::uuid,'Stripe に支払いが無い',true,'other',false)`, [exception, actor])).rows[0])
      .toEqual({ resolved: true, cancelled_from: 'pending' });
    expect(await status(o.orderId)).toBe('cancelled');
    await flush();
  });

  test('取消の申請の解決と、その返金の成功で取消', async () => {
    const o = await placed();
    await markPaid(o.orderId, 'payment_in_progress', o.draft.totalAmount);
    const request = await insertCancelRequest(db(), { orderId: o.orderId, lines: [{ orderItemId: o.orderItemId, quantity: 1 }] });
    const refundId = await fullRefund(o.orderId);
    expect((await db().query('select status from public.admin_resolve_cancel_request($1::uuid,$2::uuid,$3::uuid,false)',
      [request.cancelRequestId, actor, refundId])).rows[0]).toEqual({ status: 'resolved' });
    await refundResult(refundId, 'succeeded');
    expect(await status(o.orderId)).toBe('cancelled');
    await flush();
  });

  // Review M3: the remaining refund / return writers, including the J-19-gated shipped -> paid reasons.
  test('返金のエラー・外からの全額の返金', async () => {
    const errored = await placed();
    await markPaid(errored.orderId, 'payment_in_progress', errored.draft.totalAmount);
    const refundId = await fullRefund(errored.orderId);
    expect((await db().query(`select outcome from public.mark_order_refund_error($1::uuid,'not_found_in_stripe',true)`, [refundId])).rows)
      .toEqual([{ outcome: 'errored' }]);
    expect(await status(errored.orderId)).toBe('paid');

    const external = await placed();
    await markPaid(external.orderId, 'payment_in_progress', external.draft.totalAmount);
    expect((await db().query(`select created, status from public.record_external_order_refund($1::uuid,$2::text,$3::integer,'succeeded',
      null,null,null,'card',null,null,null,now())`, [external.orderId, `re_${randomUUID().replaceAll('-', '')}`, external.draft.totalAmount])).rows)
      .toEqual([{ created: true, status: 'succeeded' }]);
    expect(await status(external.orderId)).toBe('cancelled');
    await flush();
  });

  test('発送前の返金の失敗で、発送済みの注文が入金済みへ戻る（refund_failed_reopened）', async () => {
    const o = await placed(2);
    await markPaid(o.orderId, 'payment_in_progress', o.draft.totalAmount);
    const refundId = (await db().query(`select refund_id from public.begin_order_refund($1::uuid,'admin',$2::uuid,$3::jsonb,true,0,
      5000,null,null,null,false,$4::uuid,null)`, [o.orderId, randomUUID(),
      JSON.stringify([{ order_item_id: o.orderItemId, quantity: 1, before_shipment: true }]), actor])).rows[0].refund_id as string;
    expect(await refundResult(refundId, 'succeeded')).toEqual({ status: 'succeeded' });
    expect(await status(o.orderId)).toBe('paid');
    expect(await shipFixtureOrder(db(), { orderId: o.orderId, actorId: actor, lines: [{ order_item_id: o.orderItemId, quantity: 1 }] }))
      .toMatchObject({ completes_order: true, order_status: 'shipped' });
    expect(await refundResult(refundId, 'failed')).toEqual({ status: 'failed' });
    expect(await status(o.orderId)).toBe('paid');
    expect((await db().query(`select reason from public.order_revisions where order_id = $1 order by id desc limit 1`, [o.orderId])).rows)
      .toEqual([{ reason: 'refund_failed_reopened' }]);
    await flush();
  });

  test('返品の受取で交換の品を足すと、発送済みの注文が入金済みへ戻る（return_exchange_added）。返品の返金も通る', async () => {
    await db().query('update public.shop_return_settings set inspection_enabled=true where id=1');
    await db().query("update public.shop_return_reason_settings set out_of_stock_exchange='make' where reason='defective'");
    const exchange = await createShippedOrderFixture(db(), { lines: [{ quantity: 1, extraStock: 1 }] });
    expect(await status(exchange.orderId)).toBe('shipped');
    const exchangeReturn = await insertReturnRecord(db(), { orderId: exchange.orderId, lines: [{ fulfillmentId: exchange.fulfillments[0].id,
      orderItemId: exchange.orderItemIds[0], quantity: 1, resolution: 'exchange', exchangeVariantId: exchange.variantIds[0], exchangeMethod: 'stock' }] });
    const received = (await db().query(`select * from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,
      $4::jsonb,'[]'::jsonb,'none',null,0,null,true,'fixture',null,null)`, [exchangeReturn.returnId, actor, randomUUID(),
      JSON.stringify([{ return_line_id: exchangeReturn.lineIds[0], disposition: 'restocked', quantity: 1 }])])).rows[0];
    expect(received.exchange_order_item_ids).toHaveLength(1);
    expect(await status(exchange.orderId)).toBe('paid');
    expect((await db().query(`select reason from public.order_revisions where order_id = $1 order by id desc limit 1`, [exchange.orderId])).rows)
      .toEqual([{ reason: 'return_exchange_added' }]);

    const refunded = await createShippedOrderFixture(db(), { lines: [{ quantity: 1 }] });
    const refundReturn = await insertReturnRecord(db(), { orderId: refunded.orderId, lines: [{ fulfillmentId: refunded.fulfillments[0].id,
      orderItemId: refunded.orderItemIds[0], quantity: 1, resolution: 'refund' }] });
    await db().query(`select * from public.admin_receive_return($1::uuid,$2::uuid,true,$3::uuid,
      $4::jsonb,'[]'::jsonb,'consult',null,0,null,true,'fixture',null,null)`, [refundReturn.returnId, actor, randomUUID(),
      JSON.stringify([{ return_line_id: refundReturn.lineIds[0], disposition: 'restocked', quantity: 1 }])]);
    const decided = (await db().query('select * from public.admin_refund_return($1::uuid,$2::uuid,$3::uuid,$4::integer,0,null,false)',
      [refundReturn.returnId, actor, randomUUID(), 5000])).rows[0];
    expect(decided.refund_id).toEqual(expect.any(String));
    expect(await refundResult(decided.refund_id, 'succeeded')).toEqual({ status: 'succeeded' });
    // 1点の注文を返品で全額返金すると、既存の決まりどおり注文は取消になる（J-19 の下でも通る）
    expect(await status(refunded.orderId)).toBe('cancelled');
    await flush();
  });

  test('DB の材料: 状態を直に変える道具は理由を付ける（入金待ち → 入金済み）', async () => {
    const fx = await createCatalogFixture(db(), { stock: 1 });
    const o = await insertOrderWithLines(db(), { status: 'pending',
      lines: [{ itemId: fx.itemId, variantId: fx.variantId, quantity: 1, fulfillmentType: 'stock', reserved: false }] });
    await setOrderStatusForFixture(db(), [o.orderId], 'paid', { paidAmount: 5000 });
    expect(await status(o.orderId)).toBe('paid');
    expect((await db().query("select coalesce(current_setting('app.order_change_reason', true), '') as reason")).rows[0].reason).toBe('');
  });
});
