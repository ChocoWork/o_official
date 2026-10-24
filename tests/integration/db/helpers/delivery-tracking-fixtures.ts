import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { randomUUID } from 'node:crypto';
import { isInTransaction, withGroupG1FixtureTransaction } from './group-g1-fixtures';
import { connectLocalDb, type PgClient } from './local-db';
import { createCatalogFixture, insertOrderWithLines, shipFixtureOrder, uniqueSuffix, withFixtureConsumption } from './order-fixtures';

/** 管理 RPC の実装と独立して記録の守りを試すため、発送の行だけを SQL で作る。商品行は呼び出し側が用意する。配送業者か番号が空の行は、表の決まりで旧データの写し（legacy）だけが持てるので legacy で作る。 */
export async function insertDeliveryFixture(
  client: PgClient,
  input: {
    orderId: string;
    shippedAt: string;
    carrier?: ShippingCarrierId | null;
    trackingNumber?: string | null;
    notifyCustomer?: boolean;
    deliveredAt?: string;
  },
): Promise<{ fulfillmentId: string }> {
  const result = await client.query(
    `insert into public.order_fulfillments
       (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer,
        completes_order, shipped_at, delivery_status_at, delivery_status, delivered_at, legacy)
     select $1, coalesce(max(number), 0) + 1, gen_random_uuid(), $3, $4, $5, false, $2,
            coalesce($6::timestamptz, $2), case when $6::timestamptz is null then 'confirmed' else 'delivered' end, $6, ($3::text is null or $4::text is null)
     from public.order_fulfillments where order_id = $1
     returning id`,
    [input.orderId, input.shippedAt, input.carrier === undefined ? 'yamato' : input.carrier,
      input.trackingNumber === undefined ? 'DELIVERY-123' : input.trackingNumber, input.notifyCustomer ?? false,
      input.deliveredAt ?? null],
  );
  return { fulfillmentId: result.rows[0].id as string };
}

export async function createDeliveryActor(client: PgClient): Promise<{ id: string; email: string }> {
  const email = `delivery-admin-${uniqueSuffix()}@example.com`;
  const result = await client.query(
    `insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), $1, '{}'::jsonb, now(), now()) returning id`, [email],
  );
  return { id: result.rows[0].id as string, email };
}

export async function createDeliveryOrder(client: PgClient, quantity = 3) {
  const catalog = await createCatalogFixture(client, { stock: quantity });
  const order = await insertOrderWithLines(client, {
    status: 'paid', paidAmount: quantity * 5000,
    lines: [{ itemId: catalog.itemId, variantId: catalog.variantId, quantity, fulfillmentType: 'stock' }],
  });
  return { ...order, orderItemId: order.orderItemIds[0], ...catalog };
}

export type DeliveryTarget = { orderId: string; fulfillmentId: string; actorId: string };
export type TrackingEdit = DeliveryTarget & {
  requestKey: string; carrier: string; trackingNumber: string; notifyCustomer: boolean;
};
export type ManualDelivery = DeliveryTarget & {
  requestKey: string; deliveredOn: string; notifyCustomer: boolean;
};

/** 発送の材料は G-1 の割当を消費して作る（旧の発送の関数は Task 14 で止める）。戻り値の形は旧の関数と同じ */
export async function createDeliveryFulfillment(client: PgClient, input: {
  orderId: string; actorId: string; requestKey?: string; carrier?: string; trackingNumber?: string;
  notifyCustomer?: boolean; lines: Array<{ order_item_id: string; quantity: number }>;
}) {
  const row = await shipFixtureOrder(client, {
    orderId: input.orderId, actorId: input.actorId, requestKey: input.requestKey ?? randomUUID(),
    carrier: (input.carrier ?? 'yamato') as 'yamato' | 'sagawa' | 'japanpost',
    trackingNumber: input.trackingNumber ?? 'Delivery-123', notifyCustomer: input.notifyCustomer ?? false, lines: input.lines,
  });
  return { rows: [row], rowCount: 1 };
}

export function updateDeliveryTracking(client: PgClient, input: TrackingEdit) {
  return client.query('select * from public.admin_update_fulfillment_tracking($1,$2,$3,$4,$5,$6,$7)', [
    input.orderId, input.fulfillmentId, input.actorId, input.requestKey, input.carrier, input.trackingNumber, input.notifyCustomer,
  ]);
}

export function markDeliveryDelivered(client: PgClient, input: ManualDelivery) {
  return client.query('select * from public.admin_mark_fulfillment_delivered($1,$2,$3,$4,$5::date,$6)', [
    input.orderId, input.fulfillmentId, input.actorId, input.requestKey, input.deliveredOn, input.notifyCustomer,
  ]);
}

/**
 * 合成の材料（訂正・手で配達済み・発送の取消）の共通の枠。旧の3関数は Task 14 で止まるので呼ばない。
 * 共通の鍵 → 注文 → その注文の発送（id 順）の順に取ってから書き、品物の状態の差分を fixture の操作として同じ取引に残す。
 */
async function syntheticDeliveryChange<T>(
  client: PgClient,
  input: { orderId: string; fulfillmentId: string; actorId: string | null; operation: string },
  write: () => Promise<T>,
): Promise<T> {
  if (await isInTransaction(client)) {
    await client.query('select pg_catalog.pg_advisory_xact_lock(190521,1)');
  }
  return withGroupG1FixtureTransaction(client, async () => {
    await client.query('select id from public.orders where id=$1 for update', [input.orderId]);
    await client.query('select id from public.order_fulfillments where order_id=$1 order by id for update', [input.orderId]);
    const before = (await client.query('select private.capture_group_g_item_states($1) as states', [[input.orderId]])).rows[0].states;
    const result = await write();
    const operationId = randomUUID();
    await client.query(`insert into private.group_g_operations (id,operation,request_key,fingerprint,cause_type,cause_id,actor_id,result)
      values ($1,$2,gen_random_uuid(),repeat('e',64),'fulfillment',$3,$4,'{}')`,
    [operationId, input.operation, input.fulfillmentId, input.actorId]);
    await client.query('select private.record_group_g_item_state_changes($1,$2,$3,1,$4,$5)',
      [JSON.stringify(before), [input.orderId], operationId, input.operation, input.actorId]);
    return result;
  });
}

/**
 * 伝票番号の訂正の合成（旧の admin_update_fulfillment_tracking の成功を確かめる物ではない）。
 * 見える結果は旧の関数と同じにする: 直しの記録・版+1・受付済みへ戻す（届いた時刻は空）・tracking_edit の出来事・
 * 前の版の止めていない登録を replaced（外への停止の印も同じ private 関数で付ける）・追跡オンなら新しい版の pending・
 * 要対応を閉じる・全部を送った発送なら注文の写し・通知オンなら shipping_update のメール。
 */
export async function correctDeliveryTrackingFixture(client: PgClient, input: TrackingEdit) {
  return syntheticDeliveryChange(client, { ...input, operation: 'fixture_tracking_correction' }, async () => {
    const current = (await client.query(
      `select shipping_carrier, tracking_number, tracking_version, cancelled_at, completes_order
       from public.order_fulfillments where id=$1 and order_id=$2`, [input.fulfillmentId, input.orderId],
    )).rows[0];
    if (!current || current.cancelled_at !== null || (current.shipping_carrier === input.carrier
      && String(current.tracking_number ?? '').toUpperCase() === input.trackingNumber.toUpperCase())) {
      throw new Error('GROUP_G_FIXTURE_TRACKING_CORRECTION_INVALID');
    }
    const version = Number(current.tracking_version) + 1;
    const changeId = (await client.query(
      `insert into public.order_fulfillment_tracking_changes
         (fulfillment_id, from_carrier, to_carrier, from_tracking_number, to_tracking_number, tracking_version,
          notify_customer, request_key, request_fingerprint, changed_by, changed_at)
       select f.id, f.shipping_carrier, $2::text, f.tracking_number, $3::text, f.tracking_version + 1, $4::boolean, $5::uuid,
         md5(jsonb_build_object('order_id', f.order_id, 'fulfillment_id', f.id, 'shipping_carrier', $2::text,
           'tracking_number', $3::text, 'notify_customer', $4::boolean)::text), $6::uuid, now()
       from public.order_fulfillments f where f.id = $1 returning id`,
      [input.fulfillmentId, input.carrier, input.trackingNumber, input.notifyCustomer, input.requestKey, input.actorId],
    )).rows[0].id as string;
    await client.query("select set_config('app.fulfillment_change', 'tracking_edit', true)");
    await client.query(
      `update public.order_fulfillments set shipping_carrier=$2::text, tracking_number=$3::text, notify_customer=$4::boolean,
         delivery_status='confirmed', delivery_status_at=now(), delivered_at=null, tracking_version=tracking_version+1
       where id=$1`, [input.fulfillmentId, input.carrier, input.trackingNumber, input.notifyCustomer],
    );
    await client.query("select set_config('app.fulfillment_change', '', true)");
    await client.query(
      `insert into public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source)
       values ($1, $2, 'confirmed', now(), 'tracking_edit')`, [input.fulfillmentId, version],
    );
    await client.query("select private.stop_fulfillment_registrations($1, 'replaced')", [input.fulfillmentId]);
    await client.query(
      `insert into private.fulfillment_tracking_registrations (fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
       select $1, $2, $3::text, upper($4::text), now() + interval '30 days'
       from public.shop_settings where id = 1 and delivery_tracking_enabled`,
      [input.fulfillmentId, version, input.carrier, input.trackingNumber],
    );
    await client.query('select private.close_delivery_attention($1)', [input.fulfillmentId]);
    if (current.completes_order) {
      await client.query("select set_config('app.order_actor_id', $1::text, true)", [input.actorId]);
      await client.query("select set_config('app.order_change_reason', 'admin_update_fulfillment_tracking', true)");
      await client.query(
        "update public.orders set shipping_carrier=$2::text, tracking_number=$3::text where id=$1 and status='shipped'",
        [input.orderId, input.carrier, input.trackingNumber],
      );
    }
    if (input.notifyCustomer) {
      await client.query("select private.enqueue_delivery_email($1, $2, 'shipping_update', $3)", [input.fulfillmentId, version, changeId]);
    }
    return { tracking_change_id: changeId, tracking_version: version };
  });
}

/**
 * 手で配達済みにする操作の合成（旧の admin_mark_fulfillment_delivered の成功を確かめる物ではない）。
 * 届いた日の日本時間の正午を発送した時刻と今で挟み、manual の出来事・今の版の登録を delivered で止める・要対応を閉じる・
 * 発送と入力の通知が両方オンなら配達済みのメール、を旧の関数と同じに残す。
 */
export async function markDeliveredFixture(client: PgClient, input: ManualDelivery) {
  return syntheticDeliveryChange(client, { ...input, operation: 'fixture_manual_delivery' }, async () => {
    const current = (await client.query(
      `select tracking_version, notify_customer, cancelled_at, delivered_at,
         greatest(shipped_at, least(($3::date + time '12:00') at time zone 'Asia/Tokyo', now())) as delivered_at_next
       from public.order_fulfillments where id=$1 and order_id=$2`, [input.fulfillmentId, input.orderId, input.deliveredOn],
    )).rows[0];
    if (!current || current.cancelled_at !== null || current.delivered_at !== null) throw new Error('GROUP_G_FIXTURE_DELIVERY_INVALID');
    await client.query("select set_config('app.fulfillment_change', 'manual', true)");
    await client.query(
      `update public.order_fulfillments set delivery_status='delivered', delivery_status_at=$2::timestamptz, delivered_at=$2::timestamptz
       where id=$1`, [input.fulfillmentId, current.delivered_at_next],
    );
    await client.query("select set_config('app.fulfillment_change', '', true)");
    const eventId = (await client.query(
      `insert into public.order_fulfillment_events
         (fulfillment_id, tracking_version, status, happened_at, source, created_by, request_key, request_fingerprint)
       values ($1::uuid, $2, 'delivered', $3::timestamptz, 'manual', $4::uuid, $5::uuid,
         md5(jsonb_build_object('order_id', $6::uuid, 'fulfillment_id', $1::uuid, 'delivered_on', $7::date,
           'notify_customer', $8::boolean)::text))
       returning id`,
      [input.fulfillmentId, current.tracking_version, current.delivered_at_next, input.actorId, input.requestKey,
        input.orderId, input.deliveredOn, input.notifyCustomer],
    )).rows[0].id as string;
    await client.query(
      `update private.fulfillment_tracking_registrations set state='stopped', stop_reason='delivered', stopped_at=now(),
         failure_kind=null, lease_token=null, lease_expires_at=null
       where fulfillment_id=$1 and tracking_version=$2 and state<>'stopped'`, [input.fulfillmentId, current.tracking_version],
    );
    await client.query('select private.close_delivery_attention($1)', [input.fulfillmentId]);
    if (current.notify_customer && input.notifyCustomer) {
      await client.query("select private.enqueue_delivery_email($1, $2, 'delivered')", [input.fulfillmentId, current.tracking_version]);
    }
    return { event_id: eventId, delivered_at: current.delivered_at_next as Date };
  });
}

/**
 * 発送の取消の合成（旧の admin_cancel_fulfillment の成功を確かめる物ではない）。取消の印・止めていない登録を cancelled・
 * 要対応を閉じる・未発送が戻った発送済みの注文を決済完了へ・送る前の発送のメールの取りやめ、を旧の関数と同じに残す。
 */
export async function cancelDeliveryFixture(client: PgClient, input: DeliveryTarget) {
  return syntheticDeliveryChange(client, { ...input, operation: 'fixture_fulfillment_cancel' }, async () => {
    const current = (await client.query(
      'select cancelled_at from public.order_fulfillments where id=$1 and order_id=$2', [input.fulfillmentId, input.orderId],
    )).rows[0];
    if (!current || current.cancelled_at !== null) throw new Error('GROUP_G_FIXTURE_CANCEL_INVALID');
    await client.query('update public.order_fulfillments set cancelled_at=now(), cancelled_by=$2 where id=$1', [input.fulfillmentId, input.actorId]);
    await client.query("select private.stop_fulfillment_registrations($1, 'cancelled')", [input.fulfillmentId]);
    await client.query('select private.close_delivery_attention($1)', [input.fulfillmentId]);
    const order = (await client.query(
      `select o.status::text as status,
         (select coalesce(sum(l.unshipped), 0)::integer from private.order_line_fulfillment(o.id) as l) as unshipped
       from public.orders as o where o.id=$1`, [input.orderId],
    )).rows[0];
    if (order.status === 'shipped' && Number(order.unshipped) > 0) {
      await client.query("select set_config('app.order_actor_id', $1::text, true)", [input.actorId]);
      await client.query("select set_config('app.order_change_reason', 'admin_cancel_fulfillment', true)");
      await client.query(
        "update public.orders set status='paid', shipped_at=null, shipping_carrier=null, tracking_number=null where id=$1", [input.orderId],
      );
    }
    await client.query(
      `update private.order_email_outbox set status='skipped', finished_at=now(), subject=null, body_text=null,
         body_erased_at=case when subject is not null then now() else body_erased_at end, last_error_code='fulfillment_cancelled'
       where fulfillment_id=$1 and status in ('pending', 'retry_wait')`, [input.fulfillmentId],
    );
  });
}

export async function setDeliveryTracking(client: PgClient, enabled: boolean, actorId: string) {
  return (await client.query('select * from public.admin_set_delivery_tracking($1,$2)', [enabled, actorId])).rows[0];
}

/** 日付はアプリの時計で決めず、同じ取引の DB の now() と JST 日付を使う。 */
export async function deliveryClock(client: PgClient) {
  const result = await client.query(
    `select now() as now, (now() at time zone 'Asia/Tokyo')::date::text as today,
       ((now() at time zone 'Asia/Tokyo')::date - 1)::text as yesterday,
       ((now() at time zone 'Asia/Tokyo')::date - 2)::text as two_days_ago,
       ((now() at time zone 'Asia/Tokyo')::date + 1)::text as tomorrow`,
  );
  return result.rows[0] as { now: Date; today: string; yesterday: string; two_days_ago: string; tomorrow: string };
}

export async function deliveryShipment(client: PgClient, input: {
  shippedAt?: string; quantity?: number; shippedQuantity?: number; notifyCustomer?: boolean;
  carrier?: ShippingCarrierId | null; trackingNumber?: string | null; deliveredAt?: string;
} = {}) {
  const order = await createDeliveryOrder(client, input.quantity ?? 3);
  const actor = await createDeliveryActor(client);
  const clock = await deliveryClock(client);
  const shippedAt = input.shippedAt ?? `${clock.two_days_ago}T09:00:00+09:00`;
  // 発送した数の割当を G-1 で消費してから、発送の行を SQL で作る（旧の発送の関数は Task 14 で止める）
  const shippedQuantity = input.shippedQuantity ?? 1;
  const shipment = await withFixtureConsumption(client, {
    orderId: order.orderId, lines: [{ order_item_id: order.orderItemId, quantity: shippedQuantity }],
  }, async () => {
    const inserted = await insertDeliveryFixture(client, { ...input, orderId: order.orderId, shippedAt });
    await client.query('insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity) values ($1,$2,$3)', [
      inserted.fulfillmentId, order.orderItemId, shippedQuantity,
    ]);
    return inserted;
  });
  return { ...order, ...shipment, actorId: actor.id, actorEmail: actor.email, shippedAt, clock };
}

export async function deliveryRegistrations(client: PgClient, fulfillmentId: string) {
  return (await client.query(
    'select * from private.fulfillment_tracking_registrations where fulfillment_id=$1 order by tracking_version', [fulfillmentId],
  )).rows;
}

export async function deliveryRecord(client: PgClient, fulfillmentId: string) {
  return (await client.query('select * from public.order_fulfillments where id=$1', [fulfillmentId])).rows[0];
}

export async function deliveryEvents(client: PgClient, fulfillmentId: string) {
  return (await client.query(
    'select * from public.order_fulfillment_events where fulfillment_id=$1 order by tracking_version,happened_at,recorded_at,id',
    [fulfillmentId],
  )).rows;
}

export async function insertDeliveryAttention(client: PgClient, fulfillmentId: string, kind = 'delivery_failure') {
  return (await client.query(
    'insert into public.order_fulfillment_attention (fulfillment_id,kind) values ($1,$2) returning id', [fulfillmentId, kind],
  )).rows[0].id as string;
}

/** 別タスクの登録 RPC を使わず、B の停止・再開を試すために予定だけ用意する。 */
export async function insertDeliveryRegistration(client: PgClient, fulfillmentId: string, input: {
  version?: number; state?: 'pending' | 'registered' | 'stopped' | 'failed'; stopReason?: string;
  expiresAt?: string; everRegistered?: boolean;
} = {}) {
  const state = input.state ?? 'pending';
  await client.query(
    `insert into private.fulfillment_tracking_registrations
       (fulfillment_id,tracking_version,carrier,tracking_number,state,stop_reason,stopped_at,
        failure_kind,expires_at,ever_registered,registered_at)
     select f.id,$2,f.shipping_carrier,upper(f.tracking_number),$3,$4,
       case when $3='stopped' then now() end,case when $3='failed' then 'repeated_error' end,
       coalesce($5::timestamptz,f.shipped_at+interval '30 days'),$6,case when $6 then now()-interval '1 day' end
     from public.order_fulfillments f where f.id=$1`,
    [fulfillmentId, input.version ?? 1, state, input.stopReason ?? null, input.expiresAt ?? null, input.everRegistered ?? false],
  );
}

/** 期待された拒否のあとも同じ取引を使い、失敗を握りつぶさず SQLSTATE と記号を比較する。 */
export async function expectDeliveryRejected(client: PgClient, action: () => Promise<unknown>, message: string, code?: string) {
  await client.query('savepoint delivery_admin_rejected');
  try {
    await expect(action()).rejects.toMatchObject({ message: expect.stringContaining(message), ...(code ? { code } : {}) });
  } finally {
    await client.query('rollback to savepoint delivery_admin_rejected');
    await client.query('release savepoint delivery_admin_rejected');
  }
}

/** スリープの長さで競合を推測せず、指定した接続の鍵を実際に待っていることを確かめる。 */
export async function waitForDeliveryLock(observer: PgClient, waitingPid: number, blockingPid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = (await observer.query('select $2::integer=any(pg_blocking_pids($1)) as blocked', [waitingPid, blockingPid])).rows[0];
    if (row.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('配送操作が指定した接続の鍵を待たなかった');
}

/**
 * 2接続の試験が commit した共有の状態を、最初の状態へ戻す。
 * 設定（オフ・更新者と時刻は空）、登録の表（空）、配送3種類のメール（無し）、provider の枠（今から呼べる）は、ほかのファイルの試験が
 * 「最初は…」と全体で確かめる。注文・発送・出来事は消せない記録なので残す（ほかの試験も確定した注文を残している）。
 * 登録の表は削除を拒むトリガーを、この取引の間だけ外す（ownerの接続。本番では使わない）。
 * 前提: DB 結合の試験は --runInBand で流す（並列だと、ほかのファイルの途中の行まで消す）。
 * 配送の行（登録・配送メール・設定の配送3列）を commit する試験を足すファイルは、自分で後始末をすること。
 * 設定は、その試験の前の値でなく「最初の状態」（オフ・更新者と時刻は空）に戻す。
 */
export async function restoreCommittedDeliveryState(client: PgClient) {
  await client.query('begin');
  try {
    await client.query("select set_config('app.delivery_tracking_setting', 'toggle', true)");
    await client.query(`update public.shop_settings set delivery_tracking_enabled = false,
      delivery_tracking_updated_at = null, delivery_tracking_updated_by = null where id = 1`);
    await client.query('alter table private.fulfillment_tracking_registrations disable trigger fulfillment_tracking_registrations_no_delete');
    await client.query('delete from private.fulfillment_tracking_registrations');
    await client.query('alter table private.fulfillment_tracking_registrations enable trigger fulfillment_tracking_registrations_no_delete');
    await client.query("delete from private.order_email_outbox where kind in ('out_for_delivery', 'delivered', 'shipping_update')");
    await client.query('update private.delivery_tracking_provider_gate set next_call_at = pg_catalog.now()');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** 準備と成功結果は commit する。終わったら共有の状態を戻し、消せない注文・発送は controller の次の reset で捨てる。 */
export async function withDeliveryConnections<T>(action: (first: PgClient, second: PgClient, pids: number[]) => Promise<T>) {
  const first = await connectLocalDb();
  let second: PgClient | undefined;
  try {
    second = await connectLocalDb();
    for (const client of [first, second]) await client.query("set statement_timeout='8s'");
    const pids = [(await first.query('select pg_backend_pid() as pid')).rows[0].pid as number,
      (await second.query('select pg_backend_pid() as pid')).rows[0].pid as number];
    return await action(first, second, pids);
  } finally {
    // 先に鍵を持つ接続を戻し、待っていた SQL が終わってからもう片方を閉じる。
    // rollback が投げても共有の状態の後始末は必ず通し、最初に起きた誤りを隠さない。
    try {
      await first.query('rollback').catch(() => undefined);
      if (second) await second.query('rollback').catch(() => undefined);
      await restoreCommittedDeliveryState(first);
    } finally {
      await first.end();
      if (second) await second.end();
    }
  }
}

/** claim_delivery_tracking の1行。bigint の signal_revision は pg が文字列で返す。 */
export type DeliveryClaim = {
  fulfillment_id: string; tracking_version: number; carrier: string; tracking_number: string; action: string;
  lease_token: string; signal_revision: string; attempts: number; read_attempts: number; expires_at: Date;
};
/** 結果を書く関数に渡す、借りの印だけの形（借り出しの1行も、試験が置いた借りも同じ形で渡せる）。 */
export type DeliveryLease = Pick<DeliveryClaim, 'fulfillment_id' | 'tracking_version' | 'lease_token'>;

/**
 * 追跡をオンにする。オンにした時の取り込みは、まだ登録の無い発送へ pending を作るので、
 * 試験が自分の登録を insertDeliveryRegistration で作る時は、発送を作る前に呼ぶ。
 * 他の試験が commit して残した登録（オンにした時の取り込みで増えた物を含む）は1年先に送り、借り出しの試験が件数に左右されないようにする。
 */
export async function enableDeliveryTracking(client: PgClient) {
  const actor = await createDeliveryActor(client);
  await setDeliveryTracking(client, true, actor.id);
  await deferOtherDeliveryRegistrations(client);
  return actor;
}

/** keepFulfillmentIds 以外の登録の時刻を1年先へ送る（オフ→オンで取り込みが増えた後に、自分の発送を除いて呼び直す時に使う）。 */
export async function deferOtherDeliveryRegistrations(client: PgClient, keepFulfillmentIds: string[] = []) {
  await client.query(
    "update private.fulfillment_tracking_registrations set next_run_at = now() + interval '1 year' where fulfillment_id <> all($1::uuid[])",
    [keepFulfillmentIds],
  );
}

/**
 * 発送と現版（版1）の登録を作る。伝票番号は他の試験が commit した行と同じ組にならないよう、既定で試験ごとの番号にする
 * （同じ組に別の追跡中の行があると、借り出しの結果が変わるため）。登録の既定は registered・一度は登録できた行。
 */
export async function trackedShipment(client: PgClient, input: NonNullable<Parameters<typeof deliveryShipment>[1]> & {
  state?: 'pending' | 'registered' | 'stopped' | 'failed'; stopReason?: string; everRegistered?: boolean; expiresAt?: string;
} = {}) {
  const { state, stopReason, everRegistered, expiresAt, ...shipment } = input;
  const trackingNumber = shipment.trackingNumber ?? `SYNC-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const carrier = shipment.carrier === undefined ? 'yamato' : shipment.carrier;
  const target = await deliveryShipment(client, { ...shipment, trackingNumber, carrier });
  const registrationState = state ?? 'registered';
  await insertDeliveryRegistration(client, target.fulfillmentId, {
    state: registrationState, stopReason, expiresAt, everRegistered: everRegistered ?? registrationState !== 'pending',
  });
  return { ...target, trackingNumber, carrier };
}

export async function deliveryRegistration(client: PgClient, fulfillmentId: string, version = 1) {
  return (await client.query(
    'select * from private.fulfillment_tracking_registrations where fulfillment_id=$1 and tracking_version=$2', [fulfillmentId, version],
  )).rows[0];
}

/** 時刻の来た行・期限切れの行などを作るための直接の書き込み。set 句は試験が書く固定の文字列だけを渡し、値は params（$3 から）で渡す。 */
export async function patchDeliveryRegistration(client: PgClient, fulfillmentId: string, setSql: string, version = 1, params: unknown[] = []) {
  await client.query(
    `update private.fulfillment_tracking_registrations set ${setSql} where fulfillment_id=$1 and tracking_version=$2`,
    [fulfillmentId, version, ...params],
  );
}

/** 借り出しを通さずに借りの印だけを置く（結果を書く関数を単独で試す時に使う）。 */
export async function leaseDeliveryRegistration(client: PgClient, fulfillmentId: string, version = 1): Promise<DeliveryLease> {
  const token = randomUUID();
  await patchDeliveryRegistration(
    client, fulfillmentId,
    "lease_token=$3,lease_expires_at=now()+interval '5 minutes',claimed_signal_revision=signal_revision", version, [token],
  );
  return { fulfillment_id: fulfillmentId, tracking_version: version, lease_token: token };
}

/** 借り出し。同じ DB に残った別の試験の行も借りうるので、試験側は claimDeliveryFor で自分の発送だけを見る。 */
export async function claimDelivery(client: PgClient, input: { limit?: number; leaseSeconds?: number } = {}) {
  return (await client.query('select * from public.claim_delivery_tracking($1,$2)', [input.limit ?? 40, input.leaseSeconds ?? 60])).rows as DeliveryClaim[];
}

export async function claimDeliveryFor(client: PgClient, fulfillmentIds: string[], input: { limit?: number; leaseSeconds?: number } = {}) {
  return (await claimDelivery(client, input)).filter((claim) => fulfillmentIds.includes(claim.fulfillment_id));
}

export async function recordRegistrationResult(client: PgClient, lease: DeliveryLease, outcome: string, errorCode: string | null = null) {
  return (await client.query('select * from public.record_delivery_registration_result($1,$2,$3,$4,$5)', [
    lease.fulfillment_id, lease.tracking_version, lease.lease_token, outcome, errorCode,
  ])).rows[0] as { applied: boolean; state: string | null };
}

export async function recordReadResult(client: PgClient, lease: DeliveryLease, result: Record<string, unknown>) {
  return (await client.query('select * from public.record_delivery_read_result($1,$2,$3,$4::jsonb)', [
    lease.fulfillment_id, lease.tracking_version, lease.lease_token, JSON.stringify(result),
  ])).rows[0] as { applied: boolean; changed: boolean; stopped: boolean };
}

export async function recordStopResult(client: PgClient, lease: DeliveryLease, succeeded: boolean, errorCode: string | null = null) {
  return (await client.query('select public.record_delivery_stop_result($1,$2,$3,$4,$5) as applied', [
    lease.fulfillment_id, lease.tracking_version, lease.lease_token, succeeded, errorCode,
  ])).rows[0].applied as boolean;
}

export async function signalDelivery(client: PgClient, signals: Array<{ carrier: number; number: string; event: 'TRACKING_UPDATED' | 'TRACKING_STOPPED' }>) {
  return (await client.query('select public.signal_delivery_tracking($1::jsonb) as matched', [JSON.stringify(signals)])).rows[0].matched as number;
}

export async function expireDelivery(client: PgClient, limit = 1000) {
  return (await client.query('select public.expire_delivery_tracking($1) as stopped', [limit])).rows[0].stopped as number;
}

/** withDeliveryConnections と同じ後始末（先に全部 rollback → 共有の状態を戻す → 閉じる）で、2接続より多い試験に使う。 */
export async function withDeliveryConnectionPool<T>(count: number, action: (clients: PgClient[], pids: number[]) => Promise<T>) {
  const clients: PgClient[] = [];
  try {
    for (let index = 0; index < count; index += 1) clients.push(await connectLocalDb());
    for (const client of clients) await client.query("set statement_timeout='8s'");
    const pids: number[] = [];
    for (const client of clients) pids.push((await client.query('select pg_backend_pid() as pid')).rows[0].pid as number);
    return await action(clients, pids);
  } finally {
    try {
      for (const client of clients) await client.query('rollback').catch(() => undefined);
      if (clients.length > 0) await restoreCommittedDeliveryState(clients[0]);
    } finally {
      for (const client of clients) await client.end();
    }
  }
}
