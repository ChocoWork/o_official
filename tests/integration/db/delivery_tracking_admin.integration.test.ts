/** @jest-environment node */
import { randomUUID } from 'node:crypto';
import { describeLocalDb, type PgClient } from './helpers/local-db';
import { createCatalogFixture, createShippedOrderFixture, insertOrderWithLines, insertRefundRecord, insertReturnRecord } from './helpers/order-fixtures';
import {
  createDeliveryActor, createDeliveryOrder, createDeliveryFulfillment, deliveryClock, deliveryEvents,
  deliveryRecord, deliveryRegistrations, deliveryShipment, expectDeliveryRejected, insertDeliveryAttention,
  insertDeliveryFixture, insertDeliveryRegistration, markDeliveryDelivered, setDeliveryTracking,
  updateDeliveryTracking, waitForDeliveryLock, withDeliveryConnections, type TrackingEdit, type ManualDelivery,
} from './helpers/delivery-tracking-fixtures';

/** 移行 B の管理操作・読み出しの契約。DB の実行と RED/GREEN の確認は controller が行う。 */
jest.setTimeout(30000);

const ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/London'];
const DELIVERY_KINDS = ['out_for_delivery', 'delivered', 'shipping_update'];
const editOf = (target: { orderId: string; fulfillmentId: string; actorId: string }, extra: Partial<TrackingEdit> = {}): TrackingEdit => ({
  ...target, requestKey: randomUUID(), carrier: 'sagawa', trackingNumber: 'Corrected-456', notifyCustomer: true, ...extra,
});
const manualOf = (target: { orderId: string; fulfillmentId: string; actorId: string; clock: { yesterday: string } }, extra: Partial<ManualDelivery> = {}): ManualDelivery => ({
  ...target, requestKey: randomUUID(), deliveredOn: target.clock.yesterday, notifyCustomer: false, ...extra,
});
const iso = (value: Date | string) => new Date(value).toISOString();

async function emails(client: PgClient, fulfillmentId: string) {
  return (await client.query('select * from private.order_email_outbox where fulfillment_id=$1 order by kind,tracking_version', [fulfillmentId])).rows;
}

async function attention(client: PgClient, fulfillmentId: string) {
  return (await client.query('select * from public.order_fulfillment_attention where fulfillment_id=$1 order by opened_at,id', [fulfillmentId])).rows;
}

async function settings(client: PgClient) {
  return (await client.query('select * from public.get_delivery_tracking_settings()')).rows[0];
}

async function summary(client: PgClient, orderId: string) {
  return (await client.query('select * from public.list_order_delivery_summaries($1::uuid[])', [[orderId]])).rows[0];
}

async function detail(client: PgClient, orderId: string) {
  return (await client.query('select public.get_order_delivery_detail($1) as detail', [orderId])).rows[0].detail;
}

/** 動いているメールを個別に用意し、別の試験の outbox を claim しない。 */
async function sendingEmail(client: PgClient, target: { orderId: string; fulfillmentId: string }, kind: string, version: number, changeId: string | null = null) {
  const token = randomUUID();
  const row = (await client.query(
    `insert into private.order_email_outbox
       (order_id,kind,origin,fulfillment_id,tracking_version,tracking_change_id,status,attempts,lease_token,lease_expires_at)
     values ($1,$2,'auto',$3,$4,$5,'sending',1,$6,now()+interval '5 minutes') returning id`,
    [target.orderId, kind, target.fulfillmentId, version, changeId, token],
  )).rows[0];
  return { id: row.id as string, token };
}

describeLocalDb('integration: 配送のお店の関数（移行 B）', (db) => {
  beforeEach(async () => { await db().query('begin'); });
  afterEach(async () => { await db().query('rollback'); });

  test('追跡オフの発送はconfirmedの出来事だけ作る', async () => {
    const actor = await createDeliveryActor(db());
    await setDeliveryTracking(db(), false, actor.id);
    const order = await createDeliveryOrder(db());
    const result = (await createDeliveryFulfillment(db(), {
      ...order, actorId: actor.id, notifyCustomer: true, lines: [{ order_item_id: order.orderItemId, quantity: 1 }],
    })).rows[0];
    expect(Object.keys(result)).toEqual(['fulfillment_id', 'number', 'completes_order', 'order_status', 'replayed']);
    expect(result).toMatchObject({ number: 1, completes_order: false, order_status: 'paid', replayed: false });
    const fulfillment = await deliveryRecord(db(), result.fulfillment_id);
    const events = await deliveryEvents(db(), result.fulfillment_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'confirmed', source: 'shipment', tracking_version: 1 });
    expect(iso(events[0].happened_at)).toBe(iso(fulfillment.shipped_at));
    expect(iso(fulfillment.delivery_status_at)).toBe(iso(fulfillment.shipped_at));
    expect(fulfillment).toMatchObject({ tracking_version: 1, delivery_status: 'confirmed', delivered_at: null });
    expect(fulfillment.request_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await deliveryRegistrations(db(), fulfillment.id)).toHaveLength(0);
    expect((await emails(db(), fulfillment.id)).map((row) => row.kind)).toEqual(['shipped']);
  });

  test('オンの発送と取り込みは同じ取引でpendingを作る', async () => {
    const old = await deliveryShipment(db(), { trackingNumber: 'old-Abc' });
    const before = await settings(db());
    expect(Object.keys(before)).toEqual(['enabled', 'updated_at', 'updated_by_email', 'backfill_count']);
    const toggled = await setDeliveryTracking(db(), true, old.actorId);
    expect(Object.keys(toggled)).toEqual(['enabled', 'updated_at', 'updated_by', 'backfilled_count']);
    expect(toggled).toMatchObject({ enabled: true, updated_by: old.actorId, backfilled_count: before.backfill_count });
    const order = await createDeliveryOrder(db());
    const created = (await createDeliveryFulfillment(db(), {
      ...order, actorId: old.actorId, trackingNumber: 'new-Abc', lines: [{ order_item_id: order.orderItemId, quantity: 1 }],
    })).rows[0];
    for (const id of [old.fulfillmentId, created.fulfillment_id]) {
      const registrations = await deliveryRegistrations(db(), id);
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({ state: 'pending', ever_registered: false, tracking_version: 1 });
      const record = await deliveryRecord(db(), id);
      expect(registrations[0].tracking_number).toBe(record.tracking_number.toUpperCase());
      expect(iso(registrations[0].expires_at)).toBe(new Date(new Date(record.shipped_at).getTime() + 30 * 86400000).toISOString());
    }
    // 同じ取引の変更が savepoint の巻き戻しでも一緒に戻ることを確かめる。
    await db().query('savepoint atomic_delivery');
    const rolledBack = (await createDeliveryFulfillment(db(), {
      ...order, actorId: old.actorId, lines: [{ order_item_id: order.orderItemId, quantity: 1 }],
    })).rows[0].fulfillment_id;
    expect(await deliveryRegistrations(db(), rolledBack)).toHaveLength(1);
    expect(await deliveryEvents(db(), rolledBack)).toHaveLength(1);
    await db().query('rollback to savepoint atomic_delivery');
    for (const table of ['public.order_fulfillments', 'public.order_fulfillment_events', 'private.fulfillment_tracking_registrations']) {
      expect((await db().query(`select count(*)::integer as n from ${table} where ${table.endsWith('order_fulfillments') ? 'id' : 'fulfillment_id'}=$1`, [rolledBack])).rows[0].n).toBe(0);
    }
  });

  test('30日の境目はexpires_atより前だけ取り込む', async () => {
    // JSのDateで丸めると完全一致ではなくなるため、DBの精度のまま境目を作る。
    const times = (await db().query(`select (now()-$1::interval+$2::interval)::text as before,
      (now()-$1::interval)::text as boundary,(now()-$1::interval-$2::interval)::text as after`, ['30 days', '1 microsecond'])).rows[0];
    const before = await deliveryShipment(db(), { shippedAt: times.before });
    const boundary = await deliveryShipment(db(), { shippedAt: times.boundary });
    const after = await deliveryShipment(db(), { shippedAt: times.after });
    const targets = (await db().query('select * from private.delivery_tracking_backfill_targets()')).rows;
    expect(targets.some((row) => row.fulfillment_id === before.fulfillmentId)).toBe(true);
    const atBoundaryIncluded = targets.some((row) => row.fulfillment_id === boundary.fulfillmentId);
    expect(atBoundaryIncluded).toBe(false);
    expect(targets.some((row) => row.fulfillment_id === after.fulfillmentId)).toBe(false);
    const updated = (await updateDeliveryTracking(db(), editOf(after))).rows[0];
    const change = (await db().query('select * from public.order_fulfillment_tracking_changes where id=$1', [updated.tracking_change_id])).rows[0];
    await setDeliveryTracking(db(), true, before.actorId);
    const correctedVersion = (await deliveryRegistrations(db(), after.fulfillmentId)).find((row) => row.tracking_version === 2);
    const correctedAtPlus30Days = new Date(new Date(change.changed_at).getTime() + 30 * 86400000).toISOString();
    expect(iso(correctedVersion.expires_at)).toBe(correctedAtPlus30Days);
    expect(await deliveryRegistrations(db(), boundary.fulfillmentId)).toHaveLength(0);
  });

  test('配達済み・取消・番号なし・既存の版は取り込まない', async () => {
    const valid = await deliveryShipment(db());
    const delivered = await deliveryShipment(db(), { deliveredAt: `${valid.clock.yesterday}T12:00:00+09:00` });
    const cancelled = await deliveryShipment(db());
    await db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [cancelled.orderId, cancelled.fulfillmentId, cancelled.actorId]);
    const noNumber = await deliveryShipment(db(), { trackingNumber: null });
    const noCarrier = await deliveryShipment(db(), { carrier: null });
    const existing = await deliveryShipment(db());
    await insertDeliveryRegistration(db(), existing.fulfillmentId);
    const before = await settings(db());
    const eligibleWithoutRegistrationCount = (await db().query('select count(*)::integer as n from private.delivery_tracking_backfill_targets()')).rows[0].n;
    expect(before.backfill_count).toBe(eligibleWithoutRegistrationCount);
    const { backfilled_count } = await setDeliveryTracking(db(), true, valid.actorId);
    expect(backfilled_count).toBe(eligibleWithoutRegistrationCount);
    expect(await deliveryRegistrations(db(), valid.fulfillmentId)).toHaveLength(1);
    for (const target of [delivered, cancelled, noNumber, noCarrier]) expect(await deliveryRegistrations(db(), target.fulfillmentId)).toHaveLength(0);
    expect(await deliveryRegistrations(db(), existing.fulfillmentId)).toHaveLength(1);
    expect((await setDeliveryTracking(db(), true, valid.actorId)).backfilled_count).toBe(0);
  });

  test('再オンは期限内のdisabledを同じ行のままpendingへ戻す', async () => {
    const target = await deliveryShipment(db());
    await insertDeliveryRegistration(db(), target.fulfillmentId, { state: 'stopped', stopReason: 'disabled', everRegistered: true });
    await db().query(
      `update private.fulfillment_tracking_registrations set attempts=5,read_attempts=3,retry_allowed=false,
       lease_token=gen_random_uuid(),lease_expires_at=now()+interval '1 minute',next_run_at=now()+interval '1 day'
       where fulfillment_id=$1`, [target.fulfillmentId],
    );
    const original = (await deliveryRegistrations(db(), target.fulfillmentId))[0];
    const expired = await deliveryShipment(db());
    await insertDeliveryRegistration(db(), expired.fulfillmentId, { state: 'stopped', stopReason: 'disabled', expiresAt: iso(target.clock.now) });
    const stopped = [];
    for (const reason of ['delivered', 'expired', 'replaced', 'cancelled', 'provider_stopped']) {
      const fixture = await deliveryShipment(db());
      await insertDeliveryRegistration(db(), fixture.fulfillmentId, { state: 'stopped', stopReason: reason });
      stopped.push({ ...fixture, reason });
    }
    const before = await settings(db());
    expect(before.backfill_count).toBe((await db().query('select count(*)::integer as n from private.delivery_tracking_backfill_targets()')).rows[0].n);
    expect((await setDeliveryTracking(db(), true, target.actorId)).backfilled_count).toBe(before.backfill_count);
    const [reactivated] = await deliveryRegistrations(db(), target.fulfillmentId);
    expect(await deliveryRegistrations(db(), target.fulfillmentId)).toHaveLength(1);
    expect(reactivated).toMatchObject({ state: 'pending', stop_reason: null, stopped_at: null, attempts: 0,
      read_attempts: 0, retry_allowed: true, failure_kind: null, lease_token: null, lease_expires_at: null, ever_registered: true });
    expect(iso(reactivated.next_run_at)).toBe(iso(target.clock.now));
    expect(reactivated.expires_at).toEqual(original.expires_at);
    expect(reactivated.registered_at).toEqual(original.registered_at);
    expect((await deliveryRegistrations(db(), expired.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: 'disabled' });
    for (const fixture of stopped) expect((await deliveryRegistrations(db(), fixture.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: fixture.reason });
  });

  test('オフは開いた配送の要対応をautoで閉じる', async () => {
    const target = await deliveryShipment(db());
    await setDeliveryTracking(db(), true, target.actorId);
    const stopped = await deliveryShipment(db());
    await insertDeliveryRegistration(db(), stopped.fulfillmentId, { state: 'stopped', stopReason: 'delivered' });
    await markDeliveryDelivered(db(), manualOf(target));
    const active = await deliveryShipment(db());
    await insertDeliveryRegistration(db(), active.fulfillmentId, { state: 'registered', everRegistered: true });
    await db().query(`update private.fulfillment_tracking_registrations set lease_token=gen_random_uuid(),
      lease_expires_at=now()+interval '5 minutes',provider_stop_pending=true where fulfillment_id=any($1::uuid[])`,
    [[target.fulfillmentId, stopped.fulfillmentId, active.fulfillmentId]]);
    await insertDeliveryAttention(db(), active.fulfillmentId);
    await insertDeliveryAttention(db(), target.fulfillmentId, 'tracking_stalled');
    const eventsBefore = await deliveryEvents(db(), target.fulfillmentId);
    const recordBefore = await deliveryRecord(db(), target.fulfillmentId);
    await setDeliveryTracking(db(), false, target.actorId);
    const openAttention = [...await attention(db(), active.fulfillmentId), ...await attention(db(), target.fulfillmentId)].filter((row) => row.resolved_at === null);
    expect(openAttention).toHaveLength(0);
    for (const id of [active.fulfillmentId, target.fulfillmentId]) {
      expect((await attention(db(), id))[0]).toMatchObject({ resolution: 'auto', resolved_by: null });
    }
    expect((await deliveryRegistrations(db(), active.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: 'disabled' });
    for (const id of [target.fulfillmentId, stopped.fulfillmentId, active.fulfillmentId]) {
      expect((await deliveryRegistrations(db(), id))[0]).toMatchObject({ lease_token: null, lease_expires_at: null, provider_stop_pending: false });
    }
    const eventsAfter = await deliveryEvents(db(), target.fulfillmentId);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(await deliveryRecord(db(), target.fulfillmentId)).toEqual(recordBefore);
  });

  test('番号の直しは配達済みでも新しい版のconfirmedへ戻す', async () => {
    const target = await deliveryShipment(db(), { notifyCustomer: true });
    await setDeliveryTracking(db(), true, target.actorId);
    await markDeliveryDelivered(db(), manualOf(target));
    await insertDeliveryAttention(db(), target.fulfillmentId, 'tracking_stalled');
    const result = (await updateDeliveryTracking(db(), editOf(target))).rows[0];
    expect(Object.keys(result)).toEqual(['tracking_change_id', 'tracking_version', 'replayed']);
    expect(result).toMatchObject({ tracking_version: 2, replayed: false });
    const updated = await deliveryRecord(db(), target.fulfillmentId);
    expect(updated).toMatchObject({ tracking_version: 2, delivery_status: 'confirmed', delivered_at: null,
      shipping_carrier: 'sagawa', tracking_number: 'Corrected-456', notify_customer: true });
    const change = (await db().query('select * from public.order_fulfillment_tracking_changes where id=$1', [result.tracking_change_id])).rows[0];
    expect(change).toMatchObject({ from_carrier: 'yamato', to_carrier: 'sagawa', from_tracking_number: 'DELIVERY-123',
      to_tracking_number: 'Corrected-456', tracking_version: 2, changed_by: target.actorId });
    expect(iso(updated.delivery_status_at)).toBe(iso(change.changed_at));
    const [oldRegistration, newRegistration] = await deliveryRegistrations(db(), target.fulfillmentId);
    // 配達済みで止まっていた版は、直しの後も delivered のまま。外への停止の印も付かない
    expect(oldRegistration).toMatchObject({ state: 'stopped', stop_reason: 'delivered', provider_stop_pending: false });
    expect(newRegistration).toMatchObject({ state: 'pending', tracking_version: 2, tracking_number: 'CORRECTED-456' });
    expect((await deliveryEvents(db(), target.fulfillmentId)).filter((row) => row.source === 'tracking_edit')).toMatchObject([
      { status: 'confirmed', tracking_version: 2 },
    ]);
    expect((await attention(db(), target.fulfillmentId))[0]).toMatchObject({ resolution: 'auto' });
    const shippingUpdate = (await emails(db(), target.fulfillmentId)).filter((row) => row.kind === 'shipping_update');
    const shippingUpdateCount = shippingUpdate.length;
    expect(shippingUpdateCount).toBe(1);
    expect(shippingUpdate[0]).toMatchObject({ tracking_change_id: result.tracking_change_id, tracking_version: 2, variant: null });
  });

  test('同じキーの再送は元の結果、違う入力はDELIVERY_REQUEST_MISMATCH', async () => {
    const target = await deliveryShipment(db());
    const input = editOf(target);
    const first = (await updateDeliveryTracking(db(), input)).rows[0];
    const otherActor = await createDeliveryActor(db());
    const replay = (await updateDeliveryTracking(db(), { ...input, actorId: otherActor.id })).rows[0];
    expect(replay.replayed).toBe(true);
    expect(replay).toEqual({ ...first, replayed: true });
    for (const changed of [{ carrier: 'japanpost' }, { trackingNumber: 'Different-789' }, { notifyCustomer: false }]) {
      await expectDeliveryRejected(db(), () => updateDeliveryTracking(db(), { ...input, ...changed }), 'DELIVERY_REQUEST_MISMATCH');
    }
    expect((await db().query('select * from public.order_fulfillment_tracking_changes where fulfillment_id=$1', [target.fulfillmentId])).rows).toHaveLength(1);
    expect((await emails(db(), target.fulfillmentId)).filter((row) => row.kind === 'shipping_update')).toHaveLength(1);
    // 現在の版と状態が変わっても、元の要求の答えは変えない。
    await markDeliveryDelivered(db(), manualOf(target));
    await updateDeliveryTracking(db(), editOf(target, { trackingNumber: 'Third-789' }));
    expect((await updateDeliveryTracking(db(), input)).rows[0]).toEqual({ ...first, replayed: true });
  });

  test('発送の作成の再送は番号の直しの後も同じ発送を返す', async () => {
    const order = await createDeliveryOrder(db(), 2);
    const actor = await createDeliveryActor(db());
    const input = { ...order, actorId: actor.id, requestKey: randomUUID(), carrier: 'yamato', trackingNumber: 'Original-123',
      notifyCustomer: true, lines: [{ order_item_id: order.orderItemId, quantity: 2 }] };
    const created = (await createDeliveryFulfillment(db(), input)).rows[0];
    const original = await deliveryRecord(db(), created.fulfillment_id);
    const correctedTrackingNumber = 'Corrected-456';
    await updateDeliveryTracking(db(), editOf({ ...order, actorId: actor.id, fulfillmentId: created.fulfillment_id }, { trackingNumber: correctedTrackingNumber, notifyCustomer: false }));
    const createReplay = (await createDeliveryFulfillment(db(), input)).rows[0];
    expect(createReplay.fulfillment_id).toBe(created.fulfillment_id);
    expect(createReplay).toEqual({ ...created, replayed: true });
    const current = await deliveryRecord(db(), created.fulfillment_id);
    expect(current.tracking_number).toBe(correctedTrackingNumber);
    expect(current.request_fingerprint).toBe(original.request_fingerprint);
    expect((await db().query('select * from public.order_fulfillments where order_id=$1', [order.orderId])).rows).toHaveLength(1);
  });

  test('古いNULL指紋は直す前に保存し、元の作成要求を再送できる', async () => {
    const target = await deliveryShipment(db());
    const before = await deliveryRecord(db(), target.fulfillmentId);
    expect(before.request_fingerprint).toBeNull();
    await updateDeliveryTracking(db(), editOf(target));
    const after = await deliveryRecord(db(), target.fulfillmentId);
    expect(after.request_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    const replay = (await createDeliveryFulfillment(db(), {
      ...target, requestKey: before.request_key, trackingNumber: before.tracking_number,
      lines: [{ order_item_id: target.orderItemId, quantity: 1 }],
    })).rows[0];
    expect(replay).toMatchObject({ fulfillment_id: target.fulfillmentId, replayed: true });
    expect((await deliveryRecord(db(), target.fulfillmentId)).tracking_number).toBe('Corrected-456');
  });

  test('作成の指紋は商品行の順とactorに左右されず、別注文や変更した入力を断る', async () => {
    const catalog = await createCatalogFixture(db(), { stock: 4 });
    const order = await insertOrderWithLines(db(), { status: 'paid', paidAmount: 20000,
      lines: [1, 2].map(() => ({ itemId: catalog.itemId, variantId: catalog.variantId, quantity: 2, fulfillmentType: 'stock' as const })) });
    const actor = await createDeliveryActor(db());
    const input = { ...order, actorId: actor.id, requestKey: randomUUID(), carrier: 'yamato', trackingNumber: 'Create-123', notifyCustomer: false,
      lines: order.orderItemIds.map((order_item_id) => ({ order_item_id, quantity: 1 })) };
    const first = (await createDeliveryFulfillment(db(), input)).rows[0];
    expect((await createDeliveryFulfillment(db(), { ...input, actorId: (await createDeliveryActor(db())).id, lines: [...input.lines].reverse() })).rows[0]).toEqual({ ...first, replayed: true });
    const other = await createDeliveryOrder(db());
    for (const changed of [
      { trackingNumber: 'Create-456' }, { notifyCustomer: true }, { carrier: 'sagawa' },
      { lines: [{ ...input.lines[0], quantity: 2 }, input.lines[1]] },
      { orderId: other.orderId, lines: [{ order_item_id: other.orderItemId, quantity: 1 }] },
    ]) await expectDeliveryRejected(db(), () => createDeliveryFulfillment(db(), { ...input, ...changed }), 'FULFILLMENT_REQUEST_MISMATCH', '22023');
  });

  test('手の再送は同じイベントを返し、日付や通知の違う入力を断る', async () => {
    const target = await deliveryShipment(db(), { notifyCustomer: true });
    const input = manualOf(target, { notifyCustomer: true });
    const first = (await markDeliveryDelivered(db(), input)).rows[0];
    expect(Object.keys(first)).toEqual(['event_id', 'delivered_at', 'replayed']);
    const actor = await createDeliveryActor(db());
    expect((await markDeliveryDelivered(db(), { ...input, actorId: actor.id })).rows[0]).toEqual({ ...first, replayed: true });
    for (const changed of [{ deliveredOn: target.clock.today }, { notifyCustomer: false }]) {
      await expectDeliveryRejected(db(), () => markDeliveryDelivered(db(), { ...input, ...changed }), 'DELIVERY_REQUEST_MISMATCH');
    }
    await expectDeliveryRejected(db(), () => markDeliveryDelivered(db(), { ...input, requestKey: randomUUID() }), 'DELIVERY_ALREADY_DELIVERED');
    expect((await deliveryEvents(db(), target.fulfillmentId)).filter((row) => row.source === 'manual')).toHaveLength(1);
    expect((await emails(db(), target.fulfillmentId)).filter((row) => row.kind === 'delivered')).toHaveLength(1);
    await updateDeliveryTracking(db(), editOf(target));
    expect((await markDeliveryDelivered(db(), input)).rows[0]).toEqual({ ...first, replayed: true });
    expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({ delivery_status: 'confirmed', delivered_at: null, tracking_version: 2 });
  });

  test.each(['別注文', '別発送'])('同じrequest_keyを%sで使っても他の結果を返さない', async (scope) => {
    const first = await deliveryShipment(db());
    const second = scope === '別注文' ? await deliveryShipment(db()) : {
      ...first, ...await insertDeliveryFixture(db(), { orderId: first.orderId, shippedAt: first.shippedAt }),
    };
    const edit = editOf(first);
    await updateDeliveryTracking(db(), edit);
    await expectDeliveryRejected(db(), () => updateDeliveryTracking(db(), { ...edit, orderId: second.orderId, fulfillmentId: second.fulfillmentId }), 'DELIVERY_REQUEST_MISMATCH');
    const manual = manualOf(first);
    await markDeliveryDelivered(db(), manual);
    await expectDeliveryRejected(db(), () => markDeliveryDelivered(db(), { ...manual, orderId: second.orderId, fulfillmentId: second.fulfillmentId }), 'DELIVERY_REQUEST_MISMATCH');
    expect(await deliveryRecord(db(), second.fulfillmentId)).toMatchObject({ tracking_version: 1, delivery_status: 'confirmed', delivered_at: null });
  });

  test.each([false, true])('completes_order=%sの発送の直しは注文の写しの条件を守る', async (complete) => {
    const order = await createDeliveryOrder(db(), 2);
    const actor = await createDeliveryActor(db());
    const created = (await createDeliveryFulfillment(db(), { ...order, actorId: actor.id,
      lines: [{ order_item_id: order.orderItemId, quantity: complete ? 2 : 1 }] })).rows[0];
    const before = (await db().query('select status,shipped_at,shipping_carrier,tracking_number from public.orders where id=$1', [order.orderId])).rows[0];
    await updateDeliveryTracking(db(), editOf({ ...order, fulfillmentId: created.fulfillment_id, actorId: actor.id }));
    const after = (await db().query('select status,shipped_at,shipping_carrier,tracking_number from public.orders where id=$1', [order.orderId])).rows[0];
    expect(created.completes_order).toBe(complete);
    expect(after).toEqual(complete ? { ...before, shipping_carrier: 'sagawa', tracking_number: 'Corrected-456' } : before);
  });

  test('全部送り終えた注文でも部分発送の直しは最後の発送の写しを変えない', async () => {
    const order = await createDeliveryOrder(db(), 2);
    const actor = await createDeliveryActor(db());
    const input = { ...order, actorId: actor.id, lines: [{ order_item_id: order.orderItemId, quantity: 1 }] };
    const partial = (await createDeliveryFulfillment(db(), { ...input, trackingNumber: 'Partial-123' })).rows[0];
    await createDeliveryFulfillment(db(), { ...input, trackingNumber: 'Final-456' });
    await updateDeliveryTracking(db(), editOf({ ...order, actorId: actor.id, fulfillmentId: partial.fulfillment_id }));
    expect((await db().query('select status,shipping_carrier,tracking_number from public.orders where id=$1', [order.orderId])).rows[0])
      .toEqual({ status: 'shipped', shipping_carrier: 'yamato', tracking_number: 'Final-456' });
  });

  test('版2の手の配達済みも配送業者・番号・版を変えない', async () => {
    const target = await deliveryShipment(db());
    await updateDeliveryTracking(db(), editOf(target, { carrier: 'japanpost', trackingNumber: 'MixedCase-789', notifyCustomer: false }));
    const before = await deliveryRecord(db(), target.fulfillmentId);
    await markDeliveryDelivered(db(), manualOf(target));
    expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({ shipping_carrier: before.shipping_carrier,
      tracking_number: before.tracking_number, tracking_version: 2, notify_customer: before.notify_customer, delivery_status: 'delivered' });
  });

  test.each([false, true])('追跡%sで番号を直した時の通知選択と新しい登録を保存する', async (enabled) => {
    const target = await deliveryShipment(db(), { notifyCustomer: true });
    await setDeliveryTracking(db(), enabled, target.actorId);
    await updateDeliveryTracking(db(), editOf(target, { notifyCustomer: false }));
    expect((await deliveryRecord(db(), target.fulfillmentId)).notify_customer).toBe(false);
    expect((await emails(db(), target.fulfillmentId)).filter((row) => row.kind === 'shipping_update')).toHaveLength(0);
    const registrations = await deliveryRegistrations(db(), target.fulfillmentId);
    expect(registrations.filter((row) => row.tracking_version === 2)).toHaveLength(enabled ? 1 : 0);
  });

  async function expectClampedManualNoon(zone: string) {
    await db().query("select set_config('TimeZone',$1,true)", [zone]);
    const clock = await deliveryClock(db());
    for (const hour of ['09:00:00', '15:00:00']) {
      const target = await deliveryShipment(db(), { shippedAt: `${clock.two_days_ago}T${hour}+09:00` });
      const result = (await markDeliveryDelivered(db(), manualOf(target, { deliveredOn: clock.two_days_ago }))).rows[0];
      const clampedNoonJst = iso(`${clock.two_days_ago}T${hour === '15:00:00' ? hour : '12:00:00'}+09:00`);
      expect(iso(result.delivered_at)).toBe(clampedNoonJst);
    }
    const today = await deliveryShipment(db(), { shippedAt: `${clock.today}T00:00:00+09:00` });
    const result = (await markDeliveryDelivered(db(), manualOf(today, { deliveredOn: clock.today }))).rows[0];
    expect(iso(result.delivered_at)).toBe(new Date(Math.min(new Date(`${clock.today}T12:00:00+09:00`).getTime(), clock.now.getTime())).toISOString());
    const record = await deliveryRecord(db(), today.fulfillmentId);
    expect(iso(record.delivery_status_at)).toBe(iso(result.delivered_at));
    expect(iso(record.delivered_at)).toBe(iso(result.delivered_at));
  }

  test('手の正午を発送と今で挟む', async () => { await expectClampedManualNoon('UTC'); });
  test.each(ZONES.slice(1))('JSTの日付と上下限はDB timezone=%sでも変わらない', async (zone) => { await expectClampedManualNoon(zone); });

  // 関数の now() は変えられないので、発送日の午前（正午が下限より後）と午後（発送した時刻が下限）は発送の時刻で、
  // 今日（正午と今の小さい方）は DB の now() で、本物の関数の結果を JS の期待と照らす（上の expectClampedManualNoon）。

  test.each(ZONES)('未来日・発送日前・実在しない日付を断る（DB timezone=%s）', async (zone) => {
    await db().query("select set_config('TimeZone',$1,true)", [zone]);
    const target = await deliveryShipment(db(), { shippedAt: `${(await deliveryClock(db())).yesterday}T09:00:00+09:00` });
    for (const deliveredOn of [target.clock.tomorrow, target.clock.two_days_ago]) {
      await expectDeliveryRejected(db(), () => markDeliveryDelivered(db(), manualOf(target, { deliveredOn })), 'DELIVERY_DATE_INVALID', '22023');
    }
    // date引数へ届く前にPostgresが拒む値。routeでC-4へ訳す検証はTask 9の範囲。
    await db().query('savepoint invalid_delivery_date');
    await expect(markDeliveryDelivered(db(), manualOf(target, { deliveredOn: '2026-02-30' }))).rejects.toMatchObject({ code: '22008' });
    await db().query('rollback to savepoint invalid_delivery_date');
  });

  test.each([[false, false, 0], [false, true, 0], [true, false, 0], [true, true, 1]] as const)(
    '手の通知は発送notify=%sと入力notify=%sの両方だけ（%s通）', async (shipmentNotify, inputNotify, count) => {
      const target = await deliveryShipment(db(), { notifyCustomer: shipmentNotify });
      await setDeliveryTracking(db(), true, target.actorId);
      await insertDeliveryAttention(db(), target.fulfillmentId);
      const before = await deliveryRecord(db(), target.fulfillmentId);
      const result = (await markDeliveryDelivered(db(), manualOf(target, { notifyCustomer: inputNotify }))).rows[0];
      const after = await deliveryRecord(db(), target.fulfillmentId);
      expect(after).toMatchObject({ delivery_status: 'delivered', shipping_carrier: before.shipping_carrier,
        tracking_number: before.tracking_number, tracking_version: before.tracking_version, notify_customer: shipmentNotify });
      const events = (await deliveryEvents(db(), target.fulfillmentId)).filter((row) => row.source === 'manual');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: result.event_id, created_by: target.actorId, status: 'delivered', tracking_version: 1 });
      expect(events[0].request_key).toBeTruthy();
      expect(events[0].request_fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect((await deliveryRegistrations(db(), target.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: 'delivered' });
      expect((await attention(db(), target.fulfillmentId))[0]).toMatchObject({ resolution: 'auto' });
      expect((await emails(db(), target.fulfillmentId)).filter((row) => row.kind === 'delivered')).toHaveLength(count);
    },
  );

  test.each(['直し', '手で配達済み'])('取り消した発送への%sはDELIVERY_FULFILLMENT_CANCELLED', async (operation) => {
    const target = await deliveryShipment(db());
    await db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId]);
    const before = await deliveryRecord(db(), target.fulfillmentId);
    await expectDeliveryRejected(db(), () => operation === '直し' ? updateDeliveryTracking(db(), editOf(target)) : markDeliveryDelivered(db(), manualOf(target)), 'DELIVERY_FULFILLMENT_CANCELLED');
    expect(await deliveryRecord(db(), target.fulfillmentId)).toEqual(before);
    expect(await deliveryEvents(db(), target.fulfillmentId)).toHaveLength(0);
  });

  test('同じ値の番号は通知だけ変えても断り、所属と存在を先に確かめる', async () => {
    const target = await deliveryShipment(db());
    const other = await deliveryShipment(db());
    await expectDeliveryRejected(db(), () => updateDeliveryTracking(db(), editOf(target, { carrier: 'yamato', trackingNumber: 'DELIVERY-123' })), 'DELIVERY_TRACKING_UNCHANGED');
    for (const operation of ['直し', '手で配達済み']) {
      const run = (extra: Partial<TrackingEdit & ManualDelivery>) => operation === '直し' ? updateDeliveryTracking(db(), editOf(target, extra)) : markDeliveryDelivered(db(), manualOf(target, extra));
      await expectDeliveryRejected(db(), () => run({ orderId: randomUUID() }), 'ORDER_NOT_FOUND', 'P0002');
      await expectDeliveryRejected(db(), () => run({ fulfillmentId: randomUUID() }), 'FULFILLMENT_NOT_FOUND', 'P0002');
      await expectDeliveryRejected(db(), () => run({ fulfillmentId: other.fulfillmentId }), 'FULFILLMENT_NOT_FOUND', 'P0002');
    }
  });

  test.each([true, false])('abc123 → ABC123はDELIVERY_TRACKING_UNCHANGEDで断り、版・出来事・直しの記録・メールを増やさない（通知%s）', async (notifyCustomer) => {
    const target = await deliveryShipment(db(), { trackingNumber: 'abc123', notifyCustomer: true });
    await setDeliveryTracking(db(), true, target.actorId);
    await markDeliveryDelivered(db(), manualOf(target, { notifyCustomer: true }));
    const changes = async () => (await db().query(
      'select * from public.order_fulfillment_tracking_changes where fulfillment_id=$1 order by changed_at,id', [target.fulfillmentId],
    )).rows;
    const before = {
      record: await deliveryRecord(db(), target.fulfillmentId),
      events: await deliveryEvents(db(), target.fulfillmentId),
      changes: await changes(),
      emails: await emails(db(), target.fulfillmentId),
      registrations: await deliveryRegistrations(db(), target.fulfillmentId),
    };
    expect(before.record).toMatchObject({ tracking_number: 'abc123', tracking_version: 1, delivery_status: 'delivered' });
    expect(before.record.delivered_at).not.toBeNull();
    await expectDeliveryRejected(db(), () => updateDeliveryTracking(db(), editOf(target, {
      carrier: 'yamato', trackingNumber: 'ABC123', notifyCustomer,
    })), 'DELIVERY_TRACKING_UNCHANGED', '22023');
    expect(await deliveryRecord(db(), target.fulfillmentId)).toEqual(before.record);
    expect(await deliveryEvents(db(), target.fulfillmentId)).toEqual(before.events);
    expect(await changes()).toEqual(before.changes);
    expect(await emails(db(), target.fulfillmentId)).toEqual(before.emails);
    expect(await deliveryRegistrations(db(), target.fulfillmentId)).toEqual(before.registrations);
  });

  test('新しい管理操作はNULLと不正な業者・番号をC-4で断る', async () => {
    const target = await deliveryShipment(db());
    const tracking: unknown[] = [target.orderId, target.fulfillmentId, target.actorId, randomUUID(), 'sagawa', 'Valid-123', true];
    const manual: unknown[] = [target.orderId, target.fulfillmentId, target.actorId, randomUUID(), target.clock.yesterday, false];
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      const params = [...tracking];
      params[index] = null;
      await expectDeliveryRejected(db(), () => db().query('select * from public.admin_update_fulfillment_tracking($1,$2,$3,$4,$5,$6,$7)', params), 'DELIVERY_ARGUMENT_INVALID', '22023');
    }
    for (const index of [0, 1, 2, 3, 5]) {
      const params = [...manual];
      params[index] = null;
      await expectDeliveryRejected(db(), () => db().query('select * from public.admin_mark_fulfillment_delivered($1,$2,$3,$4,$5::date,$6)', params), 'DELIVERY_ARGUMENT_INVALID', '22023');
    }
    for (const changed of [{ carrier: 'other' }, { trackingNumber: '' }, { trackingNumber: 'A'.repeat(65) }, { trackingNumber: '番号' }]) {
      await expectDeliveryRejected(db(), () => updateDeliveryTracking(db(), editOf(target, changed)), 'DELIVERY_ARGUMENT_INVALID', '22023');
    }
  });

  test.each(['requested', 'open', 'closed'] as const)('取消は%sの返品がある発送を断る', async (status) => {
    const target = await deliveryShipment(db());
    await insertReturnRecord(db(), { orderId: target.orderId, status,
      lines: [{ fulfillmentId: target.fulfillmentId, orderItemId: target.orderItemId, quantity: 1 }] });
    await expectDeliveryRejected(db(), () => db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId]), 'FULFILLMENT_HAS_RETURN', '22023');
    expect((await deliveryRecord(db(), target.fulfillmentId)).cancelled_at).toBeNull();
  });

  test('取消は発送後の返金がある発送を断る', async () => {
    const target = await deliveryShipment(db());
    await insertRefundRecord(db(), { orderId: target.orderId, lines: [{ orderItemId: target.orderItemId, quantity: 1, beforeShipment: false, amount: 1000 }] });
    await expectDeliveryRejected(db(), () => db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId]), 'FULFILLMENT_REFUNDED', '22023');
  });

  test('発送作成は交換の支払いの保留を保つ', async () => {
    const order = await createShippedOrderFixture(db(), { lines: [{ quantity: 1, extraStock: 1 }] });
    const actor = await createDeliveryActor(db());
    const returned = await insertReturnRecord(db(), { orderId: order.orderId, exchangeFee: 300,
      lines: [{ fulfillmentId: order.fulfillments[0].id, orderItemId: order.orderItemIds[0], quantity: 1,
        resolution: 'exchange', exchangeVariantId: order.variantIds[0], exchangeMethod: 'stock' }] });
    // 状態と在庫を手で似せず、既存の受け取り関数が作った支払い待ちの交換品を使う。
    const received = (await db().query(`select * from public.admin_receive_return(
      $1,$2,true,$3,$4::jsonb,'[]'::jsonb,'none',null,0,null,false,null,null,null)`,
    [returned.returnId, actor.id, randomUUID(), JSON.stringify([{ return_line_id: returned.lineIds[0], disposition: 'not_restocked', quantity: 1 }])])).rows[0];
    expect(received.fee_due_amount).toBe(300);
    const exchange = received.exchange_order_item_ids[0] as string;
    await expectDeliveryRejected(db(), () => createDeliveryFulfillment(db(), { orderId: order.orderId, actorId: actor.id,
      lines: [{ order_item_id: exchange, quantity: 1 }] }), 'FULFILLMENT_EXCHANGE_ON_HOLD', '22023');
    await db().query('select * from public.admin_record_return_fee_payment($1,$2,null,false)', [returned.returnId, actor.id]);
    expect((await createDeliveryFulfillment(db(), { orderId: order.orderId, actorId: actor.id,
      lines: [{ order_item_id: exchange, quantity: 1 }] })).rows[0].replayed).toBe(false);
  });

  test('取消成功は登録cancelled・attention auto・配送メールskippedを同時に残す', async () => {
    const target = await deliveryShipment(db());
    await insertDeliveryRegistration(db(), target.fulfillmentId, { state: 'registered', everRegistered: true });
    await insertDeliveryAttention(db(), target.fulfillmentId);
    const change = (await updateDeliveryTracking(db(), editOf(target, { notifyCustomer: false }))).rows[0];
    const replacedBefore = (await deliveryRegistrations(db(), target.fulfillmentId))[0];
    await insertDeliveryRegistration(db(), target.fulfillmentId, { version: 2 });
    await insertDeliveryAttention(db(), target.fulfillmentId, 'tracking_stalled');
    for (const [index, kind] of DELIVERY_KINDS.entries()) {
      await db().query(`insert into private.order_email_outbox
        (order_id,kind,origin,fulfillment_id,tracking_version,tracking_change_id,status)
        values ($1,$2,'auto',$3,2,$4,$5)`, [target.orderId, kind, target.fulfillmentId, kind === 'shipping_update' ? change.tracking_change_id : null, index === 1 ? 'retry_wait' : 'pending']);
    }
    const eventsBefore = await deliveryEvents(db(), target.fulfillmentId);
    const result = (await db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId])).rows[0];
    expect(result).toMatchObject({ outcome: 'cancelled', order_status: 'paid' });
    // 直しで止めた版1は replaced のまま（取消で付け替えない）。取消で止めたのは、止めていなかった版2だけ
    const [replaced, cancelled] = await deliveryRegistrations(db(), target.fulfillmentId);
    expect(replaced).toEqual(replacedBefore);
    expect(replaced).toMatchObject({ state: 'stopped', stop_reason: 'replaced', lease_token: null, lease_expires_at: null });
    expect(cancelled).toMatchObject({ state: 'stopped', stop_reason: 'cancelled', lease_token: null, lease_expires_at: null, provider_stop_pending: false });
    for (const row of await attention(db(), target.fulfillmentId)) expect(row).toMatchObject({ resolution: 'auto', resolved_by: null });
    const queued = await emails(db(), target.fulfillmentId);
    expect(queued).toHaveLength(3);
    for (const row of queued) expect(row).toMatchObject({ status: 'skipped', last_error_code: 'fulfillment_cancelled' });
    expect(await deliveryEvents(db(), target.fulfillmentId)).toEqual(eventsBefore);
    expect((await db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId])).rows[0].outcome).toBe('already_cancelled');
  });

  // 直し・取消が止めるのは、止めていない行だけ。外への停止の印は、一度でも登録できた行で、
  // 同じ（配送業者, 番号）の止めていない行がほかの発送に無い時だけ立てる。
  describe.each(['直し', '取消'] as const)('登録の止め方（%s）', (operation) => {
    const reason = operation === '直し' ? 'replaced' : 'cancelled';
    const stopBy = async (target: Awaited<ReturnType<typeof deliveryShipment>>) => {
      if (operation === '直し') await updateDeliveryTracking(db(), editOf(target, { notifyCustomer: false }));
      else await db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId]);
    };

    test.each(['delivered', 'expired', 'disabled', 'provider_stopped'])('すでに%sで止まった行は理由も時刻も変えず、印を付けない', async (stopReason) => {
      const target = await deliveryShipment(db());
      await insertDeliveryRegistration(db(), target.fulfillmentId, { state: 'stopped', stopReason, everRegistered: true });
      const before = await deliveryRegistrations(db(), target.fulfillmentId);
      await stopBy(target);
      const after = await deliveryRegistrations(db(), target.fulfillmentId);
      expect(after).toEqual(before);
      expect(after[0]).toMatchObject({ state: 'stopped', stop_reason: stopReason, provider_stop_pending: false });
    });

    test('登録済みの止めていない行は理由を付けて止め、外への停止の印を立てて借りの印を消す', async () => {
      const target = await deliveryShipment(db());
      await insertDeliveryRegistration(db(), target.fulfillmentId, { state: 'registered', everRegistered: true });
      await db().query(`update private.fulfillment_tracking_registrations set lease_token=gen_random_uuid(),
        lease_expires_at=now()+interval '5 minutes',next_run_at=now()+interval '6 hours' where fulfillment_id=$1`, [target.fulfillmentId]);
      await stopBy(target);
      const [row] = await deliveryRegistrations(db(), target.fulfillmentId);
      expect(row).toMatchObject({ state: 'stopped', stop_reason: reason, provider_stop_pending: true, lease_token: null, lease_expires_at: null });
      expect(iso(row.stopped_at)).toBe(iso(target.clock.now));
      expect(iso(row.next_run_at)).toBe(iso(target.clock.now));
    });

    test('同じ配送業者で大文字小文字だけ違う番号の止めていない行がほかの発送にあれば、印を立てない', async () => {
      const target = await deliveryShipment(db(), { trackingNumber: 'SHARED-ab-1' });
      const other = await deliveryShipment(db(), { trackingNumber: 'shared-AB-1' });
      for (const shipment of [target, other]) await insertDeliveryRegistration(db(), shipment.fulfillmentId, { state: 'registered', everRegistered: true });
      await stopBy(target);
      expect((await deliveryRegistrations(db(), target.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: reason, provider_stop_pending: false });
      expect((await deliveryRegistrations(db(), other.fulfillmentId))[0]).toMatchObject({ state: 'registered', provider_stop_pending: false });
    });

    test.each([
      ['ほかの発送の行がすでに止まっている', { state: 'stopped' as const, stopReason: 'delivered', carrier: 'yamato' as const }],
      ['ほかの発送の行が配送業者の違う同じ番号', { state: 'registered' as const, carrier: 'sagawa' as const }],
    ])('%sなら印を立てる', async (_name, shape) => {
      const target = await deliveryShipment(db(), { trackingNumber: 'SHARED-ab-2' });
      const other = await deliveryShipment(db(), { trackingNumber: 'shared-AB-2', carrier: shape.carrier });
      await insertDeliveryRegistration(db(), target.fulfillmentId, { state: 'registered', everRegistered: true });
      await insertDeliveryRegistration(db(), other.fulfillmentId, { state: shape.state, stopReason: 'stopReason' in shape ? shape.stopReason : undefined, everRegistered: true });
      await stopBy(target);
      expect((await deliveryRegistrations(db(), target.fulfillmentId))[0]).toMatchObject({ state: 'stopped', stop_reason: reason, provider_stop_pending: true });
    });

    test('一度も登録できていない行は止めるが、印を立てない', async () => {
      const target = await deliveryShipment(db());
      await insertDeliveryRegistration(db(), target.fulfillmentId, { state: 'pending' });
      await stopBy(target);
      expect((await deliveryRegistrations(db(), target.fulfillmentId))[0]).toMatchObject({
        state: 'stopped', stop_reason: reason, provider_stop_pending: false, ever_registered: false,
      });
    });
  });

  test('要対応の手の解決の再送は別の新しいattentionを閉じない', async () => {
    const target = await deliveryShipment(db());
    const id = await insertDeliveryAttention(db(), target.fulfillmentId);
    const resolve = (attentionId: string) => db().query('select * from public.admin_resolve_delivery_attention($1,$2)', [attentionId, target.actorId]);
    expect((await resolve(id)).rows).toEqual([{ outcome: 'resolved' }]);
    const newId = await insertDeliveryAttention(db(), target.fulfillmentId);
    expect((await resolve(id)).rows).toEqual([{ outcome: 'already_resolved' }]);
    const rows = await attention(db(), target.fulfillmentId);
    expect(rows.find((row) => row.id === id)).toMatchObject({ resolution: 'manual', resolved_by: target.actorId });
    expect(rows.find((row) => row.id === newId)).toMatchObject({ resolution: null, resolved_at: null });
    await expectDeliveryRejected(db(), () => resolve(randomUUID()), 'DELIVERY_ATTENTION_NOT_FOUND', 'P0002');
  });

  test('読む物は管理用のactor・sub_status・旧版・メール状態をsnake_caseで返す', async () => {
    const target = await deliveryShipment(db());
    await setDeliveryTracking(db(), true, target.actorId);
    await db().query(`insert into public.order_fulfillment_events (fulfillment_id,tracking_version,status,happened_at,source,provider_sub_status)
      values ($1,1,'failure',now()-interval '1 day','tracking','EXCEPTION_001')`, [target.fulfillmentId]);
    const change = (await updateDeliveryTracking(db(), editOf(target))).rows[0];
    await markDeliveryDelivered(db(), manualOf(target));
    const result = await detail(db(), target.orderId);
    expect(Object.keys(result).sort()).toEqual(['enabled', 'fulfillments']);
    expect(result.enabled).toBe(true);
    expect(result.fulfillments).toHaveLength(1);
    const fulfillment = result.fulfillments[0];
    expect(Object.keys(fulfillment).sort()).toEqual(['fulfillment_id', 'number', 'carrier', 'tracking_number', 'notify_customer',
      'shipped_at', 'cancelled_at', 'tracking_version', 'delivery_status', 'delivery_status_at', 'delivered_at', 'delivered_source',
      'registration', 'events', 'tracking_changes'].sort());
    expect(fulfillment).toMatchObject({ fulfillment_id: target.fulfillmentId, tracking_version: 2, delivered_source: 'manual' });
    expect(fulfillment.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ tracking_version: 1, source: 'tracking', provider_sub_status: 'EXCEPTION_001', actor_email: null }),
      expect.objectContaining({ tracking_version: 2, source: 'manual', actor_email: target.actorEmail }),
    ]));
    expect(fulfillment.tracking_changes).toEqual([expect.objectContaining({ id: change.tracking_change_id, actor_email: target.actorEmail, email_status: 'pending' })]);
    // 一度も 17TRACK に登録しないまま手で配達済みにしたので ever_registered は偽
    expect(fulfillment.registration).toMatchObject({ state: 'stopped', stop_reason: 'delivered', ever_registered: false });
    // C-2 の DeliveryEvent・TrackingChange・DeliveryRegistration を snake_case にした字だけを返す。
    for (const event of fulfillment.events) {
      expect(Object.keys(event).sort()).toEqual(['id', 'tracking_version', 'status', 'happened_at', 'recorded_at', 'source',
        'provider_sub_status', 'actor_email'].sort());
    }
    expect(Object.keys(fulfillment.tracking_changes[0]).sort()).toEqual(['id', 'from_carrier', 'from_tracking_number', 'to_carrier',
      'to_tracking_number', 'tracking_version', 'notify_customer', 'changed_at', 'actor_email', 'email_status'].sort());
    expect(Object.keys(fulfillment.registration).sort()).toEqual(['state', 'failure_kind', 'stop_reason', 'expires_at', 'ever_registered'].sort());
    expect((await settings(db())).updated_by_email).toBe(target.actorEmail);
    const empty = await createDeliveryOrder(db());
    expect(await detail(db(), empty.orderId)).toEqual({ enabled: true, fulfillments: [] });
    await expectDeliveryRejected(db(), () => detail(db(), randomUUID()), 'ORDER_NOT_FOUND', 'P0002');
    // 顧客への非公開項目の射影はTask 12。ここはservice_role専用の管理材料を固定する。
  });

  test('登録の ever_registered を返す（一度も登録できずに止まった行と、追跡してから止めた行を区別する）', async () => {
    const cases = [
      { name: 'never', input: { state: 'stopped', stopReason: 'expired', everRegistered: false } as const, expected: false },
      { name: 'tracked', input: { state: 'stopped', stopReason: 'expired', everRegistered: true } as const, expected: true },
      { name: 'active', input: { state: 'registered', everRegistered: true } as const, expected: true },
      { name: 'pending', input: { state: 'pending' } as const, expected: false },
    ];
    for (const { name, input, expected } of cases) {
      const target = await deliveryShipment(db());
      await insertDeliveryRegistration(db(), target.fulfillmentId, input);
      const registration = (await detail(db(), target.orderId)).fulfillments[0].registration;
      expect({ name, everRegistered: registration.ever_registered }).toEqual({ name, everRegistered: expected });
    }
  });

  test('要対応のtotalはlimit前で、集計の優先はfailure→attempted→追跡できない', async () => {
    const target = await deliveryShipment(db());
    const untrackable = await insertDeliveryAttention(db(), target.fulfillmentId, 'tracking_not_found');
    const attempted = await insertDeliveryAttention(db(), target.fulfillmentId, 'attempted_delivery');
    const failure = await insertDeliveryAttention(db(), target.fulfillmentId, 'delivery_failure');
    const baseline = (await db().query('select count(*)::integer as n from public.order_fulfillment_attention where resolved_at is null')).rows[0].n;
    const listed = (await db().query('select public.list_delivery_attention(1) as value')).rows[0].value;
    expect(listed.items).toHaveLength(1);
    expect(listed.total).toBe(baseline);
    const all = (await db().query('select public.list_delivery_attention(100) as value')).rows[0].value;
    const own = all.items.find((row: { id: string }) => row.id === failure);
    expect(own).toMatchObject({ id: failure, order_id: target.orderId, fulfillment_id: target.fulfillmentId, fulfillment_number: 1, kind: 'delivery_failure', status: 'confirmed' });
    expect(Object.keys(own).sort()).toEqual(['id', 'order_id', 'order_number', 'fulfillment_id', 'fulfillment_number', 'kind', 'opened_at', 'status'].sort());
    expect((await summary(db(), target.orderId)).attention_kind).toBe('delivery_failure');
    await db().query('select * from public.admin_resolve_delivery_attention($1,$2)', [failure, target.actorId]);
    expect((await summary(db(), target.orderId)).attention_kind).toBe('attempted_delivery');
    await db().query('select * from public.admin_resolve_delivery_attention($1,$2)', [attempted, target.actorId]);
    expect((await summary(db(), target.orderId)).attention_kind).toBe('tracking_not_found');
    await db().query('select * from public.admin_resolve_delivery_attention($1,$2)', [untrackable, target.actorId]);
    expect((await summary(db(), target.orderId)).attention_kind).toBeNull();
  });

  test('集計は1000行を超える発送も数える', async () => {
    const order = await createDeliveryOrder(db(), 1002);
    const clock = await deliveryClock(db());
    await db().query(`insert into public.order_fulfillments
      (order_id,number,request_key,shipping_carrier,tracking_number,notify_customer,completes_order,shipped_at,
       delivery_status,delivery_status_at,delivered_at)
      select $1,n,gen_random_uuid(),'yamato','BULK-'||n,false,false,$2,'delivered',$3,$3 from generate_series(1,1001) n`,
    [order.orderId, `${clock.two_days_ago}T09:00:00+09:00`, `${clock.yesterday}T12:00:00+09:00`]);
    // 行ごとの数の守り（AFTER INSERT。1行ごとに注文の全発送を数え直す）は 1001 行で二乗に遅くなり、
    // 統計の無い作り直し直後の DB では 24 秒以上かかる。この試験が見るのは関数の数え方で、守りではないので、
    // この取引の間だけ外す（数は 1001 ≤ 1002 で守りを満たす。取引は afterEach で巻き戻り、状態も戻る）。
    await db().query('alter table public.order_fulfillment_lines disable trigger order_fulfillment_lines_bounds_check');
    await db().query(`insert into public.order_fulfillment_lines (fulfillment_id,order_item_id,quantity)
      select id,$2,1 from public.order_fulfillments where order_id=$1`, [order.orderId, order.orderItemId]);
    await db().query('alter table public.order_fulfillment_lines enable trigger order_fulfillment_lines_bounds_check');
    const cancelled = await insertDeliveryFixture(db(), { orderId: order.orderId, shippedAt: `${clock.two_days_ago}T09:00:00+09:00` });
    await db().query('update public.order_fulfillments set cancelled_at=now() where id=$1', [cancelled.fulfillmentId]);
    const result = await summary(db(), order.orderId);
    expect(result).toEqual({ order_id: order.orderId, active_count: 1001, delivered_count: 1001, attention_kind: null });
    const empty = await createDeliveryOrder(db());
    expect(await summary(db(), empty.orderId)).toEqual({ order_id: empty.orderId, active_count: 0, delivered_count: 0, attention_kind: null });
    expect((await detail(db(), order.orderId)).fulfillments).toHaveLength(1002);
  });

  test('読む関数は空の配列と上限を区別する', async () => {
    expect((await db().query("select * from public.list_order_delivery_summaries('{}'::uuid[])" )).rows).toEqual([]);
    expect((await db().query('select * from public.list_order_delivery_summaries($1::uuid[])', [Array.from({ length: 200 }, () => randomUUID())])).rows).toEqual([]);
    await expectDeliveryRejected(db(), () => db().query('select * from public.list_order_delivery_summaries($1::uuid[])', [Array.from({ length: 201 }, () => randomUUID())]), 'TOO_MANY_ORDERS', '22023');
    for (const limit of [0, 101]) await expectDeliveryRejected(db(), () => db().query('select public.list_delivery_attention($1)', [limit]), 'DELIVERY_ARGUMENT_INVALID', '22023');
  });

  test('配送メールの補助は通知・ON・版・直しの所属と二重防止を守る', async () => {
    const target = await deliveryShipment(db(), { notifyCustomer: true });
    const enqueue = async (kind: string, version = 1, changeId: string | null = null) => (await db().query(
      'select private.enqueue_delivery_email($1,$2,$3,$4) as enqueued', [target.fulfillmentId, version, kind, changeId],
    )).rows[0].enqueued;
    expect(await enqueue('out_for_delivery')).toBe(false);
    await setDeliveryTracking(db(), true, target.actorId);
    expect(await enqueue('out_for_delivery')).toBe(true);
    expect(await enqueue('out_for_delivery')).toBe(false);
    await markDeliveryDelivered(db(), manualOf(target));
    expect(await enqueue('out_for_delivery')).toBe(false);
    const other = await deliveryShipment(db());
    const foreignChange = (await updateDeliveryTracking(db(), editOf(other))).rows[0];
    await expectDeliveryRejected(db(), () => enqueue('shipping_update', 1, foreignChange.tracking_change_id), 'DELIVERY_ARGUMENT_INVALID', '22023');
    await expectDeliveryRejected(db(), () => enqueue('shipped'), 'DELIVERY_ARGUMENT_INVALID', '22023');
    const disabledNotify = await deliveryShipment(db(), { notifyCustomer: false });
    expect((await db().query("select private.enqueue_delivery_email($1,1,'out_for_delivery') as enqueued", [disabledNotify.fulfillmentId])).rows[0].enqueued).toBe(false);
  });

  test('管理と読むpublic関数はservice_role専用でprivate補助を公開しない', async () => {
    const signatures = [
      'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)', 'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
      'public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)',
      'public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)', 'public.admin_set_delivery_tracking(boolean,uuid)',
      'public.admin_resolve_delivery_attention(uuid,uuid)', 'public.get_delivery_tracking_settings()',
      'public.list_order_delivery_summaries(uuid[])', 'public.get_order_delivery_detail(uuid)', 'public.list_delivery_attention(integer)',
      'public.skip_order_email(uuid,uuid,text)',
    ];
    for (const signature of signatures) {
      const definition = (await db().query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [signature])).rows[0];
      expect(definition.prosecdef).toBe(true);
      expect(definition.proconfig).toContain('search_path=""');
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db().query('select has_function_privilege($1::text,$2::text,\'EXECUTE\') as allowed', [role, signature])).rows[0].allowed).toBe(role === 'service_role');
      }
    }
    for (const signature of ['private.delivery_tracking_backfill_targets()', 'private.enqueue_delivery_email(uuid,integer,text,uuid)', 'private.fulfillment_line_returnable(uuid)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) expect((await db().query('select has_function_privilege($1::text,$2::text,\'EXECUTE\') as allowed', [role, signature])).rows[0].allowed).toBe(false);
    }
    await db().query('set local role service_role');
    expect((await settings(db())).enabled).toBe(false);
    await db().query('reset role');
  });

  test('移行 B の指紋の補完の後も発送の表の守りtriggerは有効で、操作印なしの直接更新を断る', async () => {
    const target = await deliveryShipment(db());
    const triggers = (await db().query(`select tgname,tgenabled from pg_trigger
      where tgrelid='public.order_fulfillments'::regclass and not tgisinternal`)).rows;
    expect(triggers).toEqual(expect.arrayContaining([expect.objectContaining({ tgname: 'order_fulfillments_cancel_only', tgenabled: 'O' })]));
    for (const trigger of triggers) expect(trigger.tgenabled).toBe('O');
    await expectDeliveryRejected(db(), () => db().query('update public.order_fulfillments set tracking_number=$2 where id=$1', [target.fulfillmentId, 'Direct-999']), 'DELIVERY_RECORD_IMMUTABLE', '55000');
  });

  test.each(DELIVERY_KINDS)('配送メール%sの取消理由は取消済み発送だけ許す', async (kind) => {
    const target = await deliveryShipment(db());
    const change = (await updateDeliveryTracking(db(), editOf(target, { notifyCustomer: false }))).rows[0];
    const email = await sendingEmail(db(), target, kind, 2, kind === 'shipping_update' ? change.tracking_change_id : null);
    const skip = () => db().query('select public.skip_order_email($1,$2,$3) as skipped', [email.id, email.token, 'fulfillment_cancelled']);
    await expectDeliveryRejected(db(), skip, 'SKIP_REASON_NOT_ALLOWED', '22023');
    await db().query('select * from public.admin_cancel_fulfillment($1,$2,$3)', [target.orderId, target.fulfillmentId, target.actorId]);
    expect((await skip()).rows[0].skipped).toBe(true);
  });

  test.each(['out_for_delivery', 'delivered'])('旧版の%sだけsupersededを許す', async (kind) => {
    const target = await deliveryShipment(db());
    const email = await sendingEmail(db(), target, kind, 1);
    const skip = () => db().query('select public.skip_order_email($1,$2,\'superseded\') as skipped', [email.id, email.token]);
    await expectDeliveryRejected(db(), skip, 'SUPERSEDE_NOT_ALLOWED', '22023');
    await updateDeliveryTracking(db(), editOf(target, { notifyCustomer: false }));
    expect((await skip()).rows[0].skipped).toBe(true);
  });

  test('配達済みの配達中だけsupersededを許し、発送の更新には許さない', async () => {
    const target = await deliveryShipment(db());
    const change = (await updateDeliveryTracking(db(), editOf(target, { notifyCustomer: false }))).rows[0];
    const out = await sendingEmail(db(), target, 'out_for_delivery', 2);
    const update = await sendingEmail(db(), target, 'shipping_update', 2, change.tracking_change_id);
    await markDeliveryDelivered(db(), manualOf(target));
    expect((await db().query('select public.skip_order_email($1,$2,\'superseded\') as skipped', [out.id, out.token])).rows[0].skipped).toBe(true);
    await expectDeliveryRejected(db(), () => db().query('select public.skip_order_email($1,$2,\'superseded\')', [update.id, update.token]), 'SUPERSEDE_NOT_ALLOWED', '22023');
  });

  describe('2接続の直列化（commitした見本は次のresetで捨てる）', () => {
    const toggleCases = [false, true].flatMap((initial) => ['作成', '直し'].flatMap((operation) => [false, true].map((toggleFirst) => ({ initial, operation, toggleFirst }))));
    test.each(toggleCases)('設定initial=$initial・$operation・toggle先=$toggleFirst', async ({ initial, operation, toggleFirst }) => {
      await withDeliveryConnections(async (first, second, pids) => {
        await first.query('begin');
        const target = await deliveryShipment(first);
        await setDeliveryTracking(first, initial, target.actorId);
        await first.query('commit');
        let pending: Promise<{ rows: any[]; rowCount: number } | { error: unknown }> | undefined;
        let writtenId = target.fulfillmentId;
        const write = async (client: PgClient) => {
          if (operation === '直し') return updateDeliveryTracking(client, editOf(target));
          const result = await createDeliveryFulfillment(client, { ...target, lines: [{ order_item_id: target.orderItemId, quantity: 1 }] });
          writtenId = result.rows[0].fulfillment_id;
          return result;
        };
        try {
          await first.query('begin');
          await second.query('begin');
          if (toggleFirst) {
            await setDeliveryTracking(first, !initial, target.actorId);
            pending = write(second).catch((error: unknown) => ({ error }));
          } else {
            await write(first);
            await db().query('savepoint delivery_settings_lock');
            try {
              await expect(db().query('select id from public.shop_settings where id=1 for update nowait'))
                .rejects.toMatchObject({ code: '55P03' });
            } finally {
              await db().query('rollback to savepoint delivery_settings_lock');
            }
            pending = second.query('select * from public.admin_set_delivery_tracking($1,$2)', [!initial, target.actorId]).catch((error: unknown) => ({ error }));
          }
          await waitForDeliveryLock(db(), pids[1], pids[0]);
          await first.query('commit');
          const result = await pending;
          expect(result).not.toHaveProperty('error');
          await second.query('commit');
          const registrations = await deliveryRegistrations(db(), writtenId);
          const currentVersion = (await deliveryRecord(db(), writtenId)).tracking_version;
          if (!initial) expect(registrations.find((row) => row.tracking_version === currentVersion)).toMatchObject({ state: 'pending' });
          else expect(registrations.filter((row) => row.state === 'pending')).toHaveLength(0);
          expect((await settings(db())).enabled).toBe(!initial);
        } finally {
          await first.query('rollback');
          if (pending) await pending;
          await second.query('rollback');
          await setDeliveryTracking(first, false, target.actorId);
        }
      });
    });

    test.each(['直しの同じキー', '配達済みの同じキー', '配達済みの別キー'])('%sは注文→発送の鍵で直列にする', async (operation) => {
      await withDeliveryConnections(async (first, second, pids) => {
        await first.query('begin');
        const target = await deliveryShipment(first);
        await setDeliveryTracking(first, false, target.actorId);
        await first.query('commit');
        const edit = editOf(target);
        const manual = manualOf(target);
        const write = (client: PgClient, isSecond: boolean) => operation === '直しの同じキー' ? updateDeliveryTracking(client, edit)
          : markDeliveryDelivered(client, { ...manual, requestKey: isSecond && operation === '配達済みの別キー' ? randomUUID() : manual.requestKey });
        await first.query('begin');
        // 注文だけを先に持ち、後続が注文より先に発送を持たないことも確認する。
        await first.query('select id from public.orders where id=$1 for update', [target.orderId]);
        await second.query('begin');
        const pending = write(second, true).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
        try {
          await waitForDeliveryLock(db(), pids[1], pids[0]);
          await first.query('select id from public.order_fulfillments where id=$1 for update nowait', [target.fulfillmentId]);
          const original = (await write(first, false)).rows[0];
          await first.query('commit');
          const result = await pending;
          if (operation === '配達済みの別キー') {
            expect(result.error).toMatchObject({ message: expect.stringContaining('DELIVERY_ALREADY_DELIVERED') });
            await second.query('rollback');
          } else {
            expect(result.error).toBeNull();
            expect(result.result?.rows[0]).toEqual({ ...original, replayed: true });
            await second.query('commit');
          }
          if (operation === '直しの同じキー') {
            expect((await deliveryRecord(db(), target.fulfillmentId)).tracking_version).toBe(2);
            expect((await db().query('select * from public.order_fulfillment_tracking_changes where fulfillment_id=$1', [target.fulfillmentId])).rows).toHaveLength(1);
            expect((await emails(db(), target.fulfillmentId)).filter((row) => row.kind === 'shipping_update')).toHaveLength(1);
          } else expect((await deliveryEvents(db(), target.fulfillmentId)).filter((row) => row.source === 'manual')).toHaveLength(1);
        } finally {
          await first.query('rollback');
          await pending;
          await second.query('rollback');
        }
      });
    });

    test.each(['直しが先', '配達済みが先'])('直しと手で配達済みの同時操作（%s）', async (order) => {
      await withDeliveryConnections(async (first, second, pids) => {
        await first.query('begin');
        const target = await deliveryShipment(first);
        await setDeliveryTracking(first, false, target.actorId);
        await first.query('commit');
        await first.query('begin');
        await second.query('begin');
        const edit = editOf(target);
        const manual = manualOf(target);
        if (order === '直しが先') await updateDeliveryTracking(first, edit);
        else await markDeliveryDelivered(first, manual);
        const pending = (order === '直しが先' ? markDeliveryDelivered(second, manual) : updateDeliveryTracking(second, edit))
          .then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
        try {
          await waitForDeliveryLock(db(), pids[1], pids[0]);
          await first.query('commit');
          expect((await pending).error).toBeNull();
          await second.query('commit');
          expect(await deliveryRecord(db(), target.fulfillmentId)).toMatchObject({ tracking_version: 2,
            shipping_carrier: 'sagawa', tracking_number: 'Corrected-456', delivery_status: order === '直しが先' ? 'delivered' : 'confirmed' });
          const events = await deliveryEvents(db(), target.fulfillmentId);
          expect(events.filter((row) => row.source === 'manual')).toEqual([
            expect.objectContaining({ tracking_version: order === '直しが先' ? 2 : 1, status: 'delivered' }),
          ]);
          expect(events.filter((row) => row.source === 'tracking_edit')).toHaveLength(1);
        } finally {
          await first.query('rollback');
          await pending;
          await second.query('rollback');
        }
      });
    });
  });
});
