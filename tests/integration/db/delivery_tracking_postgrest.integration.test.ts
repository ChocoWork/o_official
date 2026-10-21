/** @jest-environment node */
/**
 * E-4 Task 4: 本物のローカル PostgREST で、名前つき引数・TABLE 配列・jsonb・integer と TS の変換を照合する。
 * fulfillment_postgrest.integration.test.ts と同じく、接続先未設定は skip、非ローカルは失敗させる。
 * SQL の準備も PostgREST の書き込みも commit される。--runInBand 専用で、毎回共有の配送状態を戻す。
 * 注文・発送・出来事の追記記録は消さず、controller の次の reset で捨てる。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  createFulfillment,
  FulfillmentOperationError,
} from '@/lib/orders/fulfillment/fulfillment-store';
import {
  claimDeliveryTracking,
  expireDeliveryTracking,
  getDeliveryTrackingSettings,
  getOrderDeliveryDetail,
  listDeliveryAttention,
  listOrderDeliverySummaries,
  markFulfillmentDelivered,
  recordDeliveryReadResult,
  recordDeliveryRegistrationResult,
  recordDeliveryStopResult,
  resolveDeliveryAttention,
  setDeliveryTracking,
  signalDeliveryTracking,
  takeDeliveryProviderSlot,
  updateFulfillmentTracking,
  type DeliveryStore,
} from '@/lib/orders/tracking/delivery-store';
import type { DeliveryReadResult, TrackingClaim } from '@/lib/orders/tracking/delivery-types';
import { describeLocalDb, isLocalDatabase } from './helpers/local-db';
import {
  createDeliveryActor,
  createDeliveryOrder,
  deferOtherDeliveryRegistrations,
  deliveryShipment,
  insertDeliveryAttention,
  leaseDeliveryRegistration,
  patchDeliveryRegistration,
  restoreCommittedDeliveryState,
  trackedShipment,
} from './helpers/delivery-tracking-fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
jest.setTimeout(30000);

const LOCAL_API_URL = process.env.LOCAL_SUPABASE_URL;
const LOCAL_SERVICE_ROLE_KEY = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Reply = { name: string; args: Record<string, unknown> | undefined; data: unknown };

describeLocalDb('integration: 配送の関数を実際の PostgREST に通す', (db) => {
  if (!LOCAL_API_URL || !LOCAL_SERVICE_ROLE_KEY) {
    test.skip('LOCAL_SUPABASE_URL・LOCAL_SUPABASE_SERVICE_ROLE_KEY 未設定のためスキップ', () => {});
    return;
  }
  if (!isLocalDatabase(LOCAL_API_URL)) {
    test('ローカルの API 以外では実行しない', () => {
      throw new Error('消せない試験注文が残るため、localhost 以外の LOCAL_SUPABASE_URL では実行しない');
    });
    return;
  }

  const apiUrl = LOCAL_API_URL;
  const serviceRoleKey = LOCAL_SERVICE_ROLE_KEY;
  let client: SupabaseClient;
  let actor: { id: string; email: string };
  let store: DeliveryStore;
  let replies: Reply[];

  beforeAll(async () => {
    client = createClient(apiUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    actor = await createDeliveryActor(db());
  });

  beforeEach(() => {
    replies = [];
    // 答えを差し替えない。本物の RPC の返却値を記録して、変換前と後を同じ HTTP 呼び出しで照らす。
    store = {
      rpc: async (name: string, args?: Record<string, unknown>) => {
        const result = await client.rpc(name, args);
        replies.push({ name, args, data: result.data });
        return result;
      },
    } as unknown as DeliveryStore;
  });

  afterEach(async () => {
    // claim の他行をロックする試験が途中で落ちても、先に鍵を必ず解放する。
    await db().query('rollback');
    try {
      // helper が消さない要対応も閉じてから、登録・配送メール・設定・provider の枠を戻す。
      const result = await client.rpc('admin_set_delivery_tracking', { _enabled: false, _actor_id: actor.id });
      if (result.error) throw new Error(`delivery cleanup failed: ${result.error.code ?? 'unknown'}`);
    } finally {
      await restoreCommittedDeliveryState(db());
    }
  });

  function reply(name: string): Reply {
    const found = replies.findLast((row) => row.name === name);
    if (!found) throw new Error(`RPC was not called: ${name}`);
    return found;
  }

  async function rawRpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const result = await client.rpc(name, args);
    // DB の生の本文・接続情報をテストの失敗表示へ出さない。
    if (result.error) throw new Error(`RPC failed: ${name} (${result.error.code ?? 'unknown'})`);
    return result.data;
  }

  function claimFor(target: Awaited<ReturnType<typeof trackedShipment>>, lease: Awaited<ReturnType<typeof leaseDeliveryRegistration>>): TrackingClaim {
    return {
      fulfillmentId: target.fulfillmentId, trackingVersion: lease.tracking_version,
      carrier: target.carrier ?? 'yamato', trackingNumber: target.trackingNumber.toUpperCase(),
      action: 'read', leaseToken: lease.lease_token, signalRevision: 0, attempts: 0, readAttempts: 0,
      expiresAt: new Date(Date.parse(target.shippedAt) + 30 * 86400000).toISOString(),
    };
  }

  function readResult(at: string, status: DeliveryReadResult['status'] = 'out_for_delivery'): DeliveryReadResult {
    return {
      outcome: 'ok', status, providerStatus: 'OutForDelivery', providerSubStatus: null,
      happenedAt: at, deliveredAt: null, readAt: at, errorCode: null,
    };
  }

  test('設定の TABLE 配列と backfill_count/backfilled_count を camelCase で読む', async () => {
    await deliveryShipment(db(), { trackingNumber: `SET-${randomUUID()}` });
    const count = (await db().query('select count(*)::integer as count from private.delivery_tracking_backfill_targets()')).rows[0].count as number;
    const settings = await getDeliveryTrackingSettings(store);
    expect(settings).toEqual({ enabled: false, updatedAt: null, updatedByEmail: null, backfillCount: count });
    expect(reply('get_delivery_tracking_settings').data).toEqual([{
      enabled: false, updated_at: null, updated_by_email: null, backfill_count: count,
    }]);

    const changed = await setDeliveryTracking(store, { enabled: true, actorId: actor.id });
    expect(changed).toEqual({ enabled: true, updatedAt: expect.any(String), updatedBy: actor.id, backfilledCount: count });
    expect(reply('admin_set_delivery_tracking')).toEqual({
      name: 'admin_set_delivery_tracking', args: { _enabled: true, _actor_id: actor.id },
      data: [{ enabled: true, updated_at: changed.updatedAt, updated_by: actor.id, backfilled_count: count }],
    });
    expect(await getDeliveryTrackingSettings(store)).toEqual({
      enabled: true, updatedAt: changed.updatedAt, updatedByEmail: actor.email, backfillCount: 0,
    });
  });

  test('別の注文の番号をRPCへ混ぜず17個のclaim列を読む', async () => {
    const target = await deliveryShipment(db(), { notifyCustomer: true, trackingNumber: `OLD-${randomUUID()}` });
    const other = await deliveryShipment(db(), { trackingNumber: `OTHER-${randomUUID()}` });
    const input = {
      orderId: target.orderId, fulfillmentId: target.fulfillmentId, actorId: actor.id, requestKey: randomUUID(),
      carrier: 'japanpost' as const, trackingNumber: `NEW-${randomUUID()}`, notifyCustomer: true,
    };
    const changed = await updateFulfillmentTracking(store, input);
    expect(changed).toEqual({ trackingChangeId: expect.stringMatching(UUID_PATTERN), trackingVersion: 2, replayed: false });
    expect(reply('admin_update_fulfillment_tracking')).toEqual({
      name: 'admin_update_fulfillment_tracking', args: {
        _order_id: target.orderId, _fulfillment_id: target.fulfillmentId, _actor_id: actor.id,
        _request_key: input.requestKey, _shipping_carrier: 'japanpost',
        _tracking_number: input.trackingNumber, _notify_customer: true,
      }, data: [{ tracking_change_id: changed.trackingChangeId, tracking_version: 2, replayed: false }],
    });
    expect(await updateFulfillmentTracking(store, input)).toEqual({ ...changed, replayed: true });
    expect((await getOrderDeliveryDetail(store, other.orderId)).fulfillments[0].trackingVersion).toBe(1);

    const emailId = (await db().query(
      "select id from private.order_email_outbox where tracking_change_id=$1 and kind='shipping_update'",
      [changed.trackingChangeId],
    )).rows[0].id as string;
    // 他ファイルが残した送信待ちは変えずに SKIP LOCKED の対象にして、自分のメールだけを借りる。
    await db().query('begin');
    await db().query(
      "select id from private.order_email_outbox where id<>$1 and status in ('pending','retry_wait') for update", [emailId],
    );
    const claimed = await rawRpc('claim_order_email', { _lease_seconds: 60 }) as Array<Record<string, unknown>>;
    expect(claimed).toHaveLength(1);
    expect(Object.keys(claimed[0]).sort()).toEqual([
      'email_id', 'order_id', 'kind', 'variant', 'origin', 'attempts', 'lease_token', 'subject', 'body_text',
      'payment_expired_sent', 'fulfillment_id', 'refund_id', 'return_id', 'return_receipt_id',
      'cancel_request_id', 'tracking_version', 'tracking_change_id',
    ].sort());
    expect(claimed[0]).toEqual({
      email_id: emailId, order_id: target.orderId, kind: 'shipping_update', variant: null, origin: 'auto', attempts: 1,
      lease_token: expect.stringMatching(UUID_PATTERN), subject: null, body_text: null, payment_expired_sent: false,
      fulfillment_id: target.fulfillmentId, refund_id: null, return_id: null, return_receipt_id: null,
      cancel_request_id: null, tracking_version: 2, tracking_change_id: changed.trackingChangeId,
    });
    const refused = await client.rpc('skip_order_email', {
      _email_id: emailId, _lease_token: claimed[0].lease_token, _reason: 'superseded',
    });
    expect(refused.error?.code).toBe('22023');
    expect(refused.error?.message === 'SUPERSEDE_NOT_ALLOWED').toBe(true);
    expect(await rawRpc('skip_order_email', {
      _email_id: emailId, _lease_token: claimed[0].lease_token, _reason: 'no_recipient',
    })).toBe(true);
    await db().query('rollback');
  });

  test('手で配達済みの TABLE と詳細の JSON の出来事・直し・登録の配列を読む', async () => {
    const originalTrackingNumber = `DETAIL-${randomUUID()}`;
    const target = await deliveryShipment(db(), { notifyCustomer: true, trackingNumber: originalTrackingNumber });
    await setDeliveryTracking(store, { enabled: true, actorId: actor.id });
    const changed = await updateFulfillmentTracking(store, {
      orderId: target.orderId, fulfillmentId: target.fulfillmentId, actorId: actor.id, requestKey: randomUUID(),
      carrier: 'sagawa', trackingNumber: `DETAIL-NEW-${randomUUID()}`, notifyCustomer: true,
    });
    const input = {
      orderId: target.orderId, fulfillmentId: target.fulfillmentId, actorId: actor.id,
      requestKey: randomUUID(), deliveredOn: target.clock.today, notifyCustomer: true,
    };
    const delivered = await markFulfillmentDelivered(store, input);
    expect(delivered).toEqual({ eventId: expect.stringMatching(UUID_PATTERN), deliveredAt: expect.any(String), replayed: false });
    expect(reply('admin_mark_fulfillment_delivered')).toEqual({
      name: 'admin_mark_fulfillment_delivered', args: {
        _order_id: target.orderId, _fulfillment_id: target.fulfillmentId, _actor_id: actor.id,
        _request_key: input.requestKey, _delivered_on: target.clock.today, _notify_customer: true,
      }, data: [{ event_id: delivered.eventId, delivered_at: delivered.deliveredAt, replayed: false }],
    });
    expect(await markFulfillmentDelivered(store, input)).toEqual({ ...delivered, replayed: true });
    const detail = await getOrderDeliveryDetail(store, target.orderId);
    const raw = reply('get_order_delivery_detail').data as { enabled: boolean; fulfillments: Array<Record<string, any>> };
    expect(reply('get_order_delivery_detail').args).toEqual({ _order_id: target.orderId });
    expect(Array.isArray(raw.fulfillments)).toBe(true);
    expect(detail.enabled).toBe(true);
    expect(detail.fulfillments).toHaveLength(1);
    const row = detail.fulfillments[0];
    expect(row).toEqual({
      fulfillmentId: target.fulfillmentId, number: 1, carrier: 'sagawa', trackingNumber: raw.fulfillments[0].tracking_number,
      notifyCustomer: true, shippedAt: raw.fulfillments[0].shipped_at, cancelledAt: null, trackingVersion: 2,
      deliveryStatus: 'delivered', deliveryStatusAt: delivered.deliveredAt, deliveredAt: delivered.deliveredAt,
      deliveredSource: 'manual', registration: {
        state: 'stopped', failureKind: null, stopReason: 'delivered', expiresAt: raw.fulfillments[0].registration.expires_at,
      },
      events: expect.arrayContaining([
        expect.objectContaining({ id: delivered.eventId, trackingVersion: 2, status: 'delivered', source: 'manual', actorEmail: actor.email }),
        expect.objectContaining({ trackingVersion: 2, status: 'confirmed', source: 'tracking_edit' }),
      ]),
      trackingChanges: [{
        id: changed.trackingChangeId, fromCarrier: 'yamato', fromTrackingNumber: originalTrackingNumber,
        toCarrier: 'sagawa', toTrackingNumber: raw.fulfillments[0].tracking_number, trackingVersion: 2,
        notifyCustomer: true, changedAt: raw.fulfillments[0].tracking_changes[0].changed_at,
        actorEmail: actor.email, emailStatus: 'pending',
      }],
    });
    expect(row.events).toHaveLength(2);
    expect(raw.fulfillments[0].events).toHaveLength(2);
    expect(raw.fulfillments[0].tracking_changes).toHaveLength(1);
  });

  test('uuid[] の集計 TABLE を元の大文字キーへ戻し、発送なしを配達済みにしない', async () => {
    const target = await deliveryShipment(db());
    const empty = await createDeliveryOrder(db());
    const unknown = randomUUID();
    const upperId = target.orderId.toUpperCase();
    const summaries = await listOrderDeliverySummaries(store, [upperId, empty.orderId, unknown]);
    expect(reply('list_order_delivery_summaries').args).toEqual({ _order_ids: [target.orderId, empty.orderId, unknown] });
    expect(reply('list_order_delivery_summaries').data).toEqual(expect.arrayContaining([
      { order_id: target.orderId, active_count: 1, delivered_count: 0, attention_kind: null },
      { order_id: empty.orderId, active_count: 0, delivered_count: 0, attention_kind: null },
    ]));
    expect(summaries.get(upperId)).toEqual({ activeCount: 1, deliveredCount: 0, attentionKind: null });
    expect(summaries.get(empty.orderId)).toEqual({ activeCount: 0, deliveredCount: 0, attentionKind: null });
    expect(summaries.get(unknown)).toEqual({ activeCount: 0, deliveredCount: 0, attentionKind: null });
  });

  test('要対応の JSON 配列と全件数・resolved/already_resolved の TABLE を読む', async () => {
    const target = await deliveryShipment(db());
    const attentionId = await insertDeliveryAttention(db(), target.fulfillmentId, 'delivery_failure');
    await insertDeliveryAttention(db(), target.fulfillmentId, 'attempted_delivery');
    const expectedTotal = (await db().query('select count(*)::integer as count from public.order_fulfillment_attention where resolved_at is null')).rows[0].count as number;
    const listed = await listDeliveryAttention(store, 1);
    expect(reply('list_delivery_attention').args).toEqual({ _limit: 1 });
    const raw = reply('list_delivery_attention').data as { items: Array<Record<string, unknown>>; total: number };
    expect(raw.items).toHaveLength(1);
    expect(raw.total).toBe(expectedTotal);
    expect(listed).toEqual({ items: [{
      id: raw.items[0].id, orderId: raw.items[0].order_id, orderNumber: raw.items[0].order_number,
      fulfillmentId: raw.items[0].fulfillment_id, fulfillmentNumber: raw.items[0].fulfillment_number,
      kind: raw.items[0].kind, openedAt: raw.items[0].opened_at, status: raw.items[0].status,
    }], total: expectedTotal });
    expect(await resolveDeliveryAttention(store, { attentionId, actorId: actor.id })).toEqual({ outcome: 'resolved' });
    expect(reply('admin_resolve_delivery_attention')).toEqual({
      name: 'admin_resolve_delivery_attention', args: { _attention_id: attentionId, _actor_id: actor.id },
      data: [{ outcome: 'resolved' }],
    });
    expect(await resolveDeliveryAttention(store, { attentionId, actorId: actor.id })).toEqual({ outcome: 'already_resolved' });
  });

  test('claim の10列・登録結果・signal の整数・読み直しの JSON を通す', async () => {
    await setDeliveryTracking(store, { enabled: true, actorId: actor.id });
    const target = await trackedShipment(db(), { state: 'pending', everRegistered: false });
    await deferOtherDeliveryRegistrations(db(), [target.fulfillmentId]);
    const claims = await claimDeliveryTracking(store, { limit: 40, leaseSeconds: 60 });
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(reply('claim_delivery_tracking')).toEqual({
      name: 'claim_delivery_tracking', args: { _limit: 40, _lease_seconds: 60 },
      data: [{
        fulfillment_id: target.fulfillmentId, tracking_version: 1, carrier: 'yamato',
        tracking_number: target.trackingNumber.toUpperCase(), action: 'register', lease_token: claim.leaseToken,
        signal_revision: 0, attempts: 0, read_attempts: 0, expires_at: claim.expiresAt,
      }],
    });
    expect(claim).toEqual({
      fulfillmentId: target.fulfillmentId, trackingVersion: 1, carrier: 'yamato',
      trackingNumber: target.trackingNumber.toUpperCase(), action: 'register', leaseToken: expect.stringMatching(UUID_PATTERN),
      signalRevision: 0, attempts: 0, readAttempts: 0, expiresAt: expect.any(String),
    });
    expect(await recordDeliveryRegistrationResult(store, claim, 'registered', null)).toEqual({ applied: true, state: 'registered' });
    expect(reply('record_delivery_registration_result')).toEqual({
      name: 'record_delivery_registration_result', args: {
        _fulfillment_id: target.fulfillmentId, _tracking_version: 1, _lease_token: claim.leaseToken,
        _outcome: 'registered', _error_code: null,
      }, data: [{ applied: true, state: 'registered' }],
    });
    const signals = [{ carrier: 100062 as const, number: target.trackingNumber.toLowerCase(), event: 'TRACKING_UPDATED' as const }];
    expect(await signalDeliveryTracking(store, signals)).toBe(1);
    expect(reply('signal_delivery_tracking')).toEqual({ name: 'signal_delivery_tracking', args: { _signals: signals }, data: 1 });

    const [readClaim] = await claimDeliveryTracking(store, { limit: 40, leaseSeconds: 60 });
    expect(readClaim).toMatchObject({ fulfillmentId: target.fulfillmentId, action: 'read', signalRevision: 1 });
    const at = (await db().query('select now() as now')).rows[0].now.toISOString() as string;
    const result = readResult(at);
    expect(await recordDeliveryReadResult(store, readClaim, result)).toEqual({ applied: true, changed: true, stopped: false });
    expect(reply('record_delivery_read_result')).toEqual({
      name: 'record_delivery_read_result', args: {
        _fulfillment_id: target.fulfillmentId, _tracking_version: 1, _lease_token: readClaim.leaseToken,
        _result: { outcome: 'ok', status: 'out_for_delivery', provider_status: 'OutForDelivery', provider_sub_status: null,
          happened_at: at, delivered_at: null, read_at: at, error_code: null },
      }, data: [{ applied: true, changed: true, stopped: false }],
    });
  });

  test.each(['token', 'lease', 'version'] as const)('%s の不一致で登録・読み直し・停止を適用しない', async (kind) => {
    await setDeliveryTracking(store, { enabled: true, actorId: actor.id });
    const pending = await trackedShipment(db(), { state: 'pending', everRegistered: false });
    const registered = await trackedShipment(db());
    const stopped = await trackedShipment(db(), { state: 'stopped', stopReason: 'replaced' });
    await patchDeliveryRegistration(db(), stopped.fulfillmentId, 'provider_stop_pending=true');
    const targets = [pending, registered, stopped];
    const claims: TrackingClaim[] = [];
    for (const target of targets) {
      const lease = await leaseDeliveryRegistration(db(), target.fulfillmentId);
      if (kind === 'lease') await patchDeliveryRegistration(db(), target.fulfillmentId, "lease_expires_at=now()-interval '1 second'");
      const claim = claimFor(target, lease);
      claims.push({ ...claim, ...(kind === 'token' ? { leaseToken: randomUUID() } : {}),
        ...(kind === 'version' ? { trackingVersion: 2 } : {}) });
    }
    // controller の決定: applied=false の時は、行なしの state=null も TS でそのまま返す。
    const registration = await rawRpc('record_delivery_registration_result', {
      _fulfillment_id: claims[0].fulfillmentId, _tracking_version: claims[0].trackingVersion,
      _lease_token: claims[0].leaseToken, _outcome: 'registered', _error_code: null,
    });
    expect(registration).toEqual([{ applied: false, state: kind === 'version' ? null : 'pending' }]);
    expect(await recordDeliveryRegistrationResult(store, claims[0], 'registered', null))
      .toEqual({ applied: false, state: kind === 'version' ? null : 'pending' });
    const at = (await db().query('select now() as now')).rows[0].now.toISOString() as string;
    expect(await recordDeliveryReadResult(store, claims[1], readResult(at))).toEqual({ applied: false, changed: false, stopped: false });
    expect(await recordDeliveryStopResult(store, claims[2], true, null)).toBe(false);
  });

  test('追跡オフの登録結果は applied=false/state=null を TS でも保つ', async () => {
    const target = await deliveryShipment(db());
    const token = randomUUID();
    expect(await rawRpc('record_delivery_registration_result', {
      _fulfillment_id: target.fulfillmentId, _tracking_version: 1, _lease_token: token,
      _outcome: 'registered', _error_code: null,
    })).toEqual([{ applied: false, state: null }]);
    const claim: TrackingClaim = {
      fulfillmentId: target.fulfillmentId, trackingVersion: 1, carrier: 'yamato', trackingNumber: 'DELIVERY-123',
      action: 'register', leaseToken: token, signalRevision: 0, attempts: 0, readAttempts: 0,
      expiresAt: new Date(Date.parse(target.shippedAt) + 30 * 86400000).toISOString(),
    };
    expect(await recordDeliveryRegistrationResult(store, claim, 'registered', null)).toEqual({ applied: false, state: null });
  });

  test('追跡オンでも発送なしの登録結果は applied=false/state=null', async () => {
    await setDeliveryTracking(store, { enabled: true, actorId: actor.id });
    const claim: TrackingClaim = {
      fulfillmentId: randomUUID(), trackingVersion: 1, carrier: 'yamato', trackingNumber: 'MISSING-123',
      action: 'register', leaseToken: randomUUID(), signalRevision: 0, attempts: 0, readAttempts: 0,
      expiresAt: '2026-11-20T03:00:00.000Z',
    };
    expect(await recordDeliveryRegistrationResult(store, claim, 'registered', null)).toEqual({ applied: false, state: null });
  });

  test('停止結果の boolean と期限切れ・provider 枠の integer を実際に読む', async () => {
    await setDeliveryTracking(store, { enabled: true, actorId: actor.id });
    const stopped = await trackedShipment(db(), { state: 'stopped', stopReason: 'replaced' });
    await patchDeliveryRegistration(db(), stopped.fulfillmentId, 'provider_stop_pending=true');
    const lease = await leaseDeliveryRegistration(db(), stopped.fulfillmentId);
    const claim = claimFor(stopped, lease);
    expect(await recordDeliveryStopResult(store, claim, true, null)).toBe(true);
    expect(reply('record_delivery_stop_result')).toEqual({
      name: 'record_delivery_stop_result', args: {
        _fulfillment_id: stopped.fulfillmentId, _tracking_version: 1, _lease_token: lease.lease_token,
        _succeeded: true, _error_code: null,
      }, data: true,
    });
    expect(await recordDeliveryStopResult(store, claim, true, null)).toBe(false);
    const expired = await trackedShipment(db(), { expiresAt: '2000-01-01T00:00:00Z' });
    expect(await expireDeliveryTracking(store, 1000)).toBe(1);
    expect(reply('expire_delivery_tracking')).toEqual({ name: 'expire_delivery_tracking', args: { _limit: 1000 }, data: 1 });
    const state = (await db().query(
      'select state,stop_reason from private.fulfillment_tracking_registrations where fulfillment_id=$1', [expired.fulfillmentId],
    )).rows[0];
    expect(state).toEqual({ state: 'stopped', stop_reason: 'expired' });
    await db().query("update private.delivery_tracking_provider_gate set next_call_at=now()-interval '1 second'");
    expect(await takeDeliveryProviderSlot(store)).toBe(0);
    expect(reply('take_delivery_provider_slot').data).toBe(0);
    const next = await takeDeliveryProviderSlot(store);
    expect(Number.isInteger(next)).toBe(true);
    expect(next).toBeGreaterThanOrEqual(0);
  });

  test('既存の作成 RPC の再送不一致は今の発送窓口どおり操作拒否', async () => {
    const order = await createDeliveryOrder(db());
    const input = {
      orderId: order.orderId, actorId: actor.id, requestKey: randomUUID(), carrier: 'yamato' as const,
      trackingNumber: `CREATE-${randomUUID()}`, notifyCustomer: false,
      lines: [{ orderItemId: order.orderItemId, quantity: 1 }],
    };
    const created = await createFulfillment(client, input);
    expect(await createFulfillment(client, input)).toEqual({ ...created, replayed: true });
    const refusal: unknown = await createFulfillment(client, { ...input, trackingNumber: 'DIFFERENT-123' })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FulfillmentOperationError);
    expect(refusal).toMatchObject({ code: 'fulfillment_request_mismatch' });
    expect(await rawRpc('admin_cancel_fulfillment', {
      _order_id: order.orderId, _fulfillment_id: created.fulfillmentId, _actor_id: actor.id,
    })).toEqual([{ outcome: 'cancelled', order_status: 'paid' }]);
  });
});
