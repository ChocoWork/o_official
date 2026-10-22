import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderEmailKind } from '@/lib/orders/email/order-email-types';
import { connectLocalDb, type PgClient } from './local-db';
import { createDeliveryActor, insertDeliveryFixture } from './delivery-tracking-fixtures';
import {
  addItemVariant, createCatalogFixture, createShippedOrderFixture, insertCancelRequest, insertRefundRecord,
  insertReturnReceipt, insertReturnRecord, insertReturnRefund,
  PRICE, uniqueSuffix,
} from './order-fixtures';

/** 実在の顧客の値を使わず、公開材料への混入だけを検出する。 */
export const ORDER_STATUS_PRIVATE_SENTINEL = 'ORDER-STATUS-PRIVATE-SENTINEL';

export const ORDER_STATUS_INTERNAL_SENTINEL = 'ORDER-STATUS-INTERNAL-SENTINEL';

/** 元の CREATE 文だけを取り出す。本文と属性はそのまま、名前だけを取引内の一時関数へ替える。 */
export async function installLegacyCustomerReturns(db: PgClient): Promise<void> {
  const source = await readFile(resolve(process.cwd(),
    'supabase/migrations/20261020144842_order_return_customer_requests.sql'), 'utf8');
  const statements = [...source.matchAll(
    /^CREATE OR REPLACE FUNCTION public\.get_customer_order_returns\(_order_id uuid, _customer_id uuid\)\r?\n[\s\S]*?^\$\$;/gm,
  )];
  if (statements.length !== 1) throw new Error('ORDER_STATUS_LEGACY_CREATE_COUNT_MISMATCH');
  const statement = statements[0][0].replace('public.get_customer_order_returns', 'pg_temp.customer_returns_before');
  await db.query(statement);
}

/** 各試験の取引内だけで使う。実在の返送先を読まず、設定と期限を明示する。 */
export async function setOrderStatusReturnSettings(db: PgClient, hasAddress: boolean): Promise<void> {
  const result = await db.query(
    `update public.shop_return_settings
     set requests_enabled=true,request_types='returns_and_cancellations',window_days=7,
         window_start='each_item',delivery_buffer_days=3,
         return_address_name=$1,return_address_postal_code=$2,return_address_line=$1,return_address_phone=$3
     where id=1`,
    [hasAddress ? ORDER_STATUS_PRIVATE_SENTINEL : null, hasAddress ? '9999999' : null,
      hasAddress ? '03-0000-0000' : null],
  );
  if (result.rowCount !== 1) throw new Error('ORDER_STATUS_RETURN_SETTINGS_MISSING');
}

export type OrderStatusReturnScenario =
  | 'requested' | 'accepted' | 'closed' | 'declined' | 'cancelled'
  | 'exchange_pending' | 'exchange_shipped' | 'partially_received' | 'inspecting'
  | 'awaiting_fee' | 'awaiting_fee_and_partial' | 'refund_preparing' | 'refund_pending' | 'returned' | 'sent_back';

/** 既存の表の守りを通して、旧 JSON の全分岐に使う合成の返品を作る。設定は呼び出し側が決める。 */
export async function createOrderStatusReturnsFixture(
  db: PgClient,
  scenario: OrderStatusReturnScenario = 'accepted',
  options: { guest?: boolean; shippedDaysAgo?: number } = {},
) {
  const shippedAt = (await db.query(
    "select (pg_catalog.now()-$1::integer*interval '1 day')::text as value", [options.shippedDaysAgo ?? 0],
  )).rows[0].value as string;
  const order = await createShippedOrderFixture(db, {
    lines: scenario === 'sent_back' ? [{ quantity: 4 }, { quantity: 2 }] : [{ quantity: 4 }],
    shipments: [{ lines: scenario === 'sent_back' ? [{ lineIndex: 0, quantity: 4 }, { lineIndex: 1, quantity: 2 }]
      : [{ lineIndex: 0, quantity: 4 }], shippedAt }],
  });
  const customerId = options.guest ? null : (await createDeliveryActor(db)).id;
  if (customerId) await db.query('update public.orders set user_id=$1 where id=$2', [customerId, order.orderId]);
  const status = ['requested', 'closed', 'declined', 'cancelled'].includes(scenario)
    ? scenario as 'requested' | 'closed' | 'declined' | 'cancelled' : scenario === 'returned' ? 'closed' : 'open';
  const created = await insertReturnRecord(db, {
    orderId: order.orderId, status, lines: [],
    feeDueAmount: scenario === 'awaiting_fee' || scenario === 'awaiting_fee_and_partial' ? 500 : 0,
  });
  if (scenario === 'declined') {
    await db.query('update public.order_returns set decline_message=$2 where id=$1', [created.returnId, '返品のお断りのご案内']);
  }
  const exchange = ['requested', 'exchange_pending', 'exchange_shipped'].includes(scenario);
  const requestedVariant = exchange ? (await addItemVariant(db, {
    itemId: order.itemIds[0], colorName: 'WHITE', sizeLabel: 'L',
  })).variantId : null;
  const confirmedVariant = scenario.startsWith('exchange_') ? (await addItemVariant(db, {
    itemId: order.itemIds[0], colorName: 'BLUE', sizeLabel: 'S',
  })).variantId : requestedVariant;
  const lineIds: string[] = [];
  for (const [index, orderItemId] of order.orderItemIds.entries()) {
    const line = await db.query(
      `insert into public.order_return_lines
         (return_id,fulfillment_id,order_item_id,quantity,reason,reason_note,customer_note,
          requested_resolution,requested_exchange_variant_id,resolution,exchange_variant_id,exchange_method)
       values ($1,$2,$3,$4,'defective',$5,$5,$6,$7,$6,$8,$9) returning id`,
      [created.returnId, order.fulfillments[0].id, orderItemId, scenario === 'sent_back' ? 1 : 2,
        ORDER_STATUS_INTERNAL_SENTINEL, exchange ? 'exchange' : 'refund', requestedVariant, confirmedVariant,
        exchange ? 'stock' : null],
    );
    lineIds.push(line.rows[0].id as string);
    if (scenario === 'sent_back') {
      const receipt = await db.query(
        `insert into public.order_return_receipts
           (return_id,request_key,request_fingerprint,kind,refund_choice,sent_back_message,
            sent_back_carrier,sent_back_tracking_number,note,actor_id,created_at)
         values ($1,pg_catalog.gen_random_uuid(),'fixture','receive','none',$2,$3,$4,$5,
                 pg_catalog.gen_random_uuid(),pg_catalog.now()+$6::integer*interval '1 second') returning id`,
        [created.returnId, index === 0 ? '返送のご案内' : null, index === 0 ? 'yamato' : null,
          index === 0 ? ORDER_STATUS_PRIVATE_SENTINEL : null, ORDER_STATUS_INTERNAL_SENTINEL, index],
      );
      await db.query(
        `insert into public.order_return_receipt_lines (receipt_id,return_line_id,disposition,quantity)
         values ($1,$2,'sent_back',1)`, [receipt.rows[0].id, lineIds[index]],
      );
    }
  }
  if (['partially_received', 'awaiting_fee_and_partial', 'inspecting', 'refund_preparing', 'refund_pending', 'returned'].includes(scenario)) {
    await insertReturnReceipt(db, {
      returnId: created.returnId,
      lines: [{ returnLineId: lineIds[0], disposition: scenario === 'inspecting' ? 'pending_inspection' : 'restocked',
        quantity: scenario === 'partially_received' || scenario === 'awaiting_fee_and_partial' ? 1 : 2 }],
    });
  }
  if (scenario === 'refund_pending' || scenario === 'returned') {
    await insertReturnRefund(db, {
      orderId: order.orderId, returnId: created.returnId, status: scenario === 'returned' ? 'succeeded' : 'pending',
      amount: 8000, lines: [{ orderItemId: order.orderItemIds[0], quantity: 2, amount: 8000 }],
    });
  }
  if (scenario.startsWith('exchange_')) {
    await insertReturnReceipt(db, { returnId: created.returnId,
      lines: [{ returnLineId: lineIds[0], disposition: 'restocked', quantity: 2 }] });
    const item = await db.query(
      `insert into public.order_items
         (order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,fulfillment_type,
          line_kind,exchange_return_line_id,exchange_paid_amount)
       values ($1,$2,$3,'交換の試験商品',0,'BLUE','S',2,0,'stock','exchange',$4,10000) returning id`,
      [order.orderId, order.itemIds[0], confirmedVariant, lineIds[0]],
    );
    if (scenario === 'exchange_shipped') {
      const shipment = await db.query(
        `insert into public.order_fulfillments
           (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at)
         values ($1,2,pg_catalog.gen_random_uuid(),'yamato','EXCHANGE-123',false,false,pg_catalog.now()) returning id`,
        [order.orderId],
      );
      await db.query('insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity) values ($1,$2,2)',
        [shipment.rows[0].id, item.rows[0].id]);
    }
  }
  return { ...order, customerId, returnId: created.returnId, lineIds };
}

/** 配送先は後から変更できないので、電話と持ち主は INSERT 時に決める。 */
export async function createOrderStatusFixture(
  db: PgClient,
  input: { status?: OrderStatus; phone?: string | null; customerId?: string | null } = {},
): Promise<{ orderId: string; orderItemId: string }> {
  const catalog = await createCatalogFixture(db, { stock: 0 });
  const suffix = uniqueSuffix();
  const order = await db.query(
    `insert into public.orders
       (session_id, checkout_session_id, user_id, status, subtotal_amount, shipping_amount,
        discount_amount, total_amount, paid_amount, currency, shipping_email, shipping_full_name,
        shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone)
     values ($1,$2,$3,$4::public.order_status,$5,0,0,$5,$5,'jpy',
             $6,$7,$8,$7,$7,$7,$7,$9) returning id`,
    [`order-status-${suffix}`, `cs_order_status_${suffix}`, input.customerId ?? null, input.status ?? 'paid', PRICE,
      'order-status-private@example.invalid', ORDER_STATUS_PRIVATE_SENTINEL, '9999999',
      input.phone === undefined ? '+81 (90) 1234-5678' : input.phone],
  );
  const orderId = order.rows[0].id as string;
  const line = await db.query(
    `insert into public.order_items
       (order_id,item_id,variant_id,item_name,item_price,item_image_url,color,size,quantity,line_total,fulfillment_type)
     values ($1,$2,$3,'公開用の試験商品',$4,'https://example.invalid/item.png','BLACK','M',1,$4,'stock') returning id`,
    [orderId, catalog.itemId, catalog.variantId, PRICE],
  );
  return { orderId, orderItemId: line.rows[0].id as string };
}

/** postgres の試験接続だけが使う。時刻は DB の文字列表現を渡し、精度を落とさない。 */
export async function setOrderStatusLinkState(
  db: PgClient,
  input: { orderId: string; verifyUntil: string | null; failedAttempts: number },
): Promise<void> {
  const result = await db.query(
    'update private.order_status_links set verify_until=$2::timestamptz,failed_attempts=$3 where order_id=$1',
    [input.orderId, input.verifyUntil, input.failedAttempts],
  );
  if (result.rowCount !== 1) throw new Error('ORDER_STATUS_FIXTURE_LINK_MISSING');
}

export async function orderStatusClock(db: PgClient): Promise<{ now: string; past: string; future: string; farFuture: string }> {
  return (await db.query(
    `select pg_catalog.now()::text as now, (pg_catalog.now()-interval '1 day')::text as past,
       (pg_catalog.now()+interval '1 day')::text as future,
       (pg_catalog.now()+interval '90 days')::text as "farFuture"`,
  )).rows[0];
}

export async function ensureOrderStatusLink(db: PgClient, orderId: string): Promise<string> {
  return (await db.query('select public.ensure_order_status_link($1) as token', [orderId])).rows[0].token as string;
}

export async function readOrderStatusLinkState(db: PgClient, orderId: string): Promise<{
  verifyUntil: string | null; failedAttempts: number;
}> {
  const row = (await db.query(
    'select verify_until::text as "verifyUntil",failed_attempts as "failedAttempts" from private.order_status_links where order_id=$1',
    [orderId],
  )).rows[0];
  if (!row) throw new Error('ORDER_STATUS_FIXTURE_LINK_MISSING');
  return row;
}

export async function verifyOrderStatusPhone(db: PgClient, token: string, lastFour: string) {
  return (await db.query('select * from public.verify_order_status_phone($1,$2)', [token, lastFour])).rows as Array<{
    result: string; verify_until: Date | null; failed_attempts: number;
  }>;
}

/** エラー本文・DETAIL は比較や失敗表示へ持ち出さない。拒否の後は必ず SAVEPOINT へ戻す。 */
export async function orderStatusSqlError(db: PgClient, sql: string, params: unknown[] = []): Promise<{
  code: string | undefined; symbol: string | undefined;
}> {
  await db.query('savepoint order_status_rejected');
  let failure: { code?: string; message?: string } | undefined;
  try {
    await db.query(sql, params);
  } catch (error) {
    failure = error as { code?: string; message?: string };
  } finally {
    await db.query('rollback to savepoint order_status_rejected');
    await db.query('release savepoint order_status_rejected');
  }
  if (!failure) throw new Error('ORDER_STATUS_EXPECTED_REJECTION');
  const symbol = ['ORDER_STATUS_ARGUMENT_INVALID', 'ORDER_NOT_FOUND'].find((value) => failure?.message === value);
  return { code: failure.code, symbol };
}

export async function asOrderStatusRole<T>(
  db: PgClient,
  role: 'anon' | 'authenticated' | 'service_role',
  action: () => Promise<T>,
): Promise<T> {
  await db.query('savepoint order_status_role');
  try {
    await db.query("select pg_catalog.set_config('role',$1,true)", [role]);
    return await action();
  } finally {
    await db.query('rollback to savepoint order_status_role');
    await db.query('release savepoint order_status_role');
  }
}

/** 完了関数だけを試す。各種類の既存 CHECK/FK を満たす材料を、本物の表へ用意する。 */
export async function createOrderStatusEmail(db: PgClient, orderId: string, kind: OrderEmailKind, withOldBody = false): Promise<{
  emailId: string; leaseToken: string;
}> {
  const variant = kind === 'paid' ? 'order_confirmed' : kind === 'canceled' ? 'paid' : kind === 'refund' ? 'standard' : null;
  let fulfillmentId: string | null = null;
  let refundId: string | null = null;
  let returnId: string | null = null;
  let receiptId: string | null = null;
  let cancelRequestId: string | null = null;
  let trackingVersion: number | null = null;
  let trackingChangeId: string | null = null;
  if (['shipped', 'out_for_delivery', 'delivered', 'shipping_update'].includes(kind)) {
    const clock = await orderStatusClock(db);
    ({ fulfillmentId } = await insertDeliveryFixture(db, { orderId, shippedAt: clock.now }));
    if (kind !== 'shipped') trackingVersion = kind === 'shipping_update' ? 2 : 1;
    if (kind === 'shipping_update') {
      trackingChangeId = (await db.query(
        `insert into public.order_fulfillment_tracking_changes
           (fulfillment_id,from_carrier,to_carrier,from_tracking_number,to_tracking_number,
            tracking_version,notify_customer,request_key,request_fingerprint,changed_by)
         values ($1,'yamato','sagawa','OLD-123','NEW-123',2,true,pg_catalog.gen_random_uuid(),'fixture',pg_catalog.gen_random_uuid()) returning id`,
        [fulfillmentId],
      )).rows[0].id as string;
    }
  }
  // refund_check は、返金のお知らせと支払い済みの取消の両方で返金の番号を必須にする。
  if (kind === 'refund' || (kind === 'canceled' && variant === 'paid')) {
    ({ refundId } = await insertRefundRecord(db, { orderId }));
  }
  if (kind.startsWith('return_')) {
    ({ returnId } = await insertReturnRecord(db, { orderId, lines: [] }));
    if (['return_received', 'return_sent_back', 'return_refund_pending_shop'].includes(kind)) {
      ({ receiptId } = await insertReturnReceipt(db, { returnId, lines: [] }));
    }
  }
  if (kind.startsWith('cancel_request_')) {
    ({ cancelRequestId } = await insertCancelRequest(db, { orderId, lines: [] }));
  }
  const leaseToken = randomUUID();
  const result = await db.query(
    `insert into private.order_email_outbox
       (order_id,kind,variant,origin,status,attempts,lease_token,lease_expires_at,
        fulfillment_id,refund_id,return_id,return_receipt_id,cancel_request_id,tracking_version,tracking_change_id,subject,body_text)
     values ($1,$2,$3,'auto','sending',1,$4,pg_catalog.now()+interval '5 minutes',
             $5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [orderId, kind, variant, leaseToken, fulfillmentId, refundId, returnId, receiptId, cancelRequestId,
      trackingVersion, trackingChangeId, withOldBody ? '旧件名' : null, withOldBody ? 'リンク無しの保存済み本文' : null],
  );
  return { emailId: result.rows[0].id as string, leaseToken };
}

export async function completeOrderStatusEmail(db: PgClient, email: { emailId: string; leaseToken: string }): Promise<boolean> {
  return (await db.query('select public.complete_order_email($1,$2,$3) as completed',
    [email.emailId, email.leaseToken, `order-status-fixture-message-${email.emailId}`])).rows[0].completed as boolean;
}

export type OrderStatusPause = {
  paused: boolean; reason: string | null; paused_at: string | null; next_probe_at: string | null; updated_at: string;
};

export async function readOrderStatusPause(db: PgClient): Promise<OrderStatusPause> {
  return (await db.query(
    'select paused,reason,paused_at::text,next_probe_at::text,updated_at::text from private.order_email_send_pause where id',
  )).rows[0];
}

/**
 * 確定した合成注文のリンクとメールだけを消し、共有 pause を試験前へ戻す。
 * 法定の注文・明細は E-4 と同じく削除せず、controller の次の reset で捨てる。
 * 移行 A 前の RED でも、存在しないリンク表の cleanup で元の失敗を隠さない。
 */
export async function restoreCommittedOrderStatusState(db: PgClient, orderIds: string[], pause: OrderStatusPause): Promise<void> {
  await db.query('begin');
  try {
    if ((await db.query("select pg_catalog.to_regclass('private.order_status_links') is not null as present")).rows[0].present) {
      await db.query('delete from private.order_status_links where order_id=any($1::uuid[])', [orderIds]);
    }
    await db.query('delete from private.order_email_outbox where order_id=any($1::uuid[])', [orderIds]);
    await db.query(
      `update private.order_email_send_pause set paused=$1,reason=$2,paused_at=$3::timestamptz,
         next_probe_at=$4::timestamptz,updated_at=$5::timestamptz where id`,
      [pause.paused, pause.reason, pause.paused_at, pause.next_probe_at, pause.updated_at],
    );
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

/** 待ち時間で競合を推測せず、DB が示す実際のブロッカーを観測する。期限を待つ試験はしない。 */
export async function waitForOrderStatusLock(observer: PgClient, waitingPid: number, blockingPid: number): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const row = (await observer.query(
      'select $2::integer=any(pg_catalog.pg_blocking_pids($1)) as blocked', [waitingPid, blockingPid],
    )).rows[0];
    if (row.blocked) return;
  }
  throw new Error('ORDER_STATUS_EXPECTED_LOCK_WAIT');
}

export async function withOrderStatusConnections<T>(action: (
  first: PgClient, second: PgClient, pids: number[], committedOrderIds: string[],
) => Promise<T>): Promise<T> {
  const first = await connectLocalDb();
  let second: PgClient | undefined;
  let pause: OrderStatusPause | undefined;
  const orderIds: string[] = [];
  try {
    second = await connectLocalDb();
    for (const db of [first, second]) await db.query("set statement_timeout='8s'");
    pause = await readOrderStatusPause(first);
    const pids = [(await first.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number,
      (await second.query('select pg_catalog.pg_backend_pid() as pid')).rows[0].pid as number];
    return await action(first, second, pids, orderIds);
  } finally {
    try {
      // どちらが鍵を持っていても先に解放できるよう、両接続へ rollback を送る。
      const rolledBack = await Promise.allSettled([first.query('rollback'), ...(second ? [second.query('rollback')] : [])]);
      if (pause) await restoreCommittedOrderStatusState(first, orderIds, pause);
      if (rolledBack.some((result) => result.status === 'rejected')) throw new Error('ORDER_STATUS_ROLLBACK_FAILED');
    } finally {
      const closed = await Promise.allSettled([first.end(), ...(second ? [second.end()] : [])]);
      if (closed.some((result) => result.status === 'rejected')) throw new Error('ORDER_STATUS_CONNECTION_CLOSE_FAILED');
    }
  }
}
