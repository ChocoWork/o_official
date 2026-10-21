/** @jest-environment node */
import {
  claimDeliveryTracking,
  DeliveryOperationError,
  DeliveryStoreError,
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
import type {
  DeliveryReadResult,
  TrackingClaim,
  UpdateTrackingInput,
} from '@/lib/orders/tracking/delivery-types';

jest.mock('server-only', () => ({}), { virtual: true });

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const FULFILLMENT_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const ACTOR_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'd1b2c3d4-1111-4222-8333-444455556666';
const CHANGE_ID = 'e1b2c3d4-1111-4222-8333-444455556666';
const EVENT_ID = 'f1b2c3d4-1111-4222-8333-444455556666';
const ATTENTION_ID = 'a1b2c3d4-2222-4222-8333-444455556666';
const LEASE_TOKEN = 'b1b2c3d4-2222-4222-8333-444455556666';
const AT = '2026-10-21T03:00:00.000Z';
const EXPIRES_AT = '2026-11-20T03:00:00.000Z';
const INPUT: UpdateTrackingInput = {
  orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY,
  carrier: 'sagawa', trackingNumber: 'New-123', notifyCustomer: false,
};
const CLAIM: TrackingClaim = {
  fulfillmentId: FULFILLMENT_ID, trackingVersion: 2, carrier: 'sagawa', trackingNumber: 'NEW-123',
  action: 'read', leaseToken: LEASE_TOKEN, signalRevision: 7, attempts: 2, readAttempts: 1, expiresAt: EXPIRES_AT,
};
const CLAIM_ROW = {
  fulfillment_id: FULFILLMENT_ID, tracking_version: 2, carrier: 'sagawa', tracking_number: 'NEW-123',
  action: 'read', lease_token: LEASE_TOKEN, signal_revision: 7, attempts: 2, read_attempts: 1, expires_at: EXPIRES_AT,
};
const READ: DeliveryReadResult = {
  outcome: 'ok', status: 'out_for_delivery', providerStatus: 'OutForDelivery', providerSubStatus: null,
  happenedAt: AT, deliveredAt: null, readAt: AT, errorCode: null,
};
const READ_ROW = {
  outcome: 'ok', status: 'out_for_delivery', provider_status: 'OutForDelivery', provider_sub_status: null,
  happened_at: AT, delivered_at: null, read_at: AT, error_code: null,
};

type DbError = { message?: string; code?: string };
function storeWith(data: unknown, error: DbError | null = null) {
  const rpc = jest.fn().mockResolvedValue({ data, error });
  return { store: { rpc } as unknown as DeliveryStore, rpc };
}

async function expectStoreError(promise: Promise<unknown>, operation: string, code?: string | null) {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DeliveryStoreError);
  expect(error).not.toBeInstanceOf(DeliveryOperationError);
  expect(error).toMatchObject({ operation, ...(code === undefined ? {} : { code }) });
}

const FULFILLMENT_ROW = {
  fulfillment_id: FULFILLMENT_ID, number: 1, carrier: 'sagawa', tracking_number: 'New-123',
  notify_customer: false, shipped_at: AT, cancelled_at: null, tracking_version: 2,
  delivery_status: 'confirmed', delivery_status_at: AT, delivered_at: null, delivered_source: null,
  registration: { state: 'registered', failure_kind: null, stop_reason: null, expires_at: EXPIRES_AT },
  events: [{
    id: EVENT_ID, tracking_version: 1, status: 'confirmed', happened_at: AT, recorded_at: AT,
    source: 'shipment', provider_sub_status: null, actor_email: null,
  }],
  tracking_changes: [{
    id: CHANGE_ID, from_carrier: null, from_tracking_number: null, to_carrier: 'sagawa',
    to_tracking_number: 'New-123', tracking_version: 2, notify_customer: false, changed_at: AT,
    actor_email: 'delivery-actor@example.com', email_status: 'pending',
  }],
};
const FULFILLMENT = {
  fulfillmentId: FULFILLMENT_ID, number: 1, carrier: 'sagawa', trackingNumber: 'New-123',
  notifyCustomer: false, shippedAt: AT, cancelledAt: null, trackingVersion: 2,
  deliveryStatus: 'confirmed', deliveryStatusAt: AT, deliveredAt: null, deliveredSource: null,
  registration: { state: 'registered', failureKind: null, stopReason: null, expiresAt: EXPIRES_AT },
  events: [{
    id: EVENT_ID, trackingVersion: 1, status: 'confirmed', happenedAt: AT, recordedAt: AT,
    source: 'shipment', providerSubStatus: null, actorEmail: null,
  }],
  trackingChanges: [{
    id: CHANGE_ID, fromCarrier: null, fromTrackingNumber: null, toCarrier: 'sagawa',
    toTrackingNumber: 'New-123', trackingVersion: 2, notifyCustomer: false, changedAt: AT,
    actorEmail: 'delivery-actor@example.com', emailStatus: 'pending',
  }],
};
const ATTENTION_ROW = {
  id: ATTENTION_ID, order_id: ORDER_ID, order_number: 'ORD-A1B2C3D4', fulfillment_id: FULFILLMENT_ID,
  fulfillment_number: 1, kind: 'delivery_failure', opened_at: AT, status: 'failure',
};

describe('管理操作と読み出しの snake_case 契約', () => {
  test('別の注文の番号をRPCへ混ぜない', async () => {
    const { store, rpc } = storeWith([{ tracking_change_id: CHANGE_ID, tracking_version: 2, replayed: false }]);
    await expect(updateFulfillmentTracking(store, INPUT)).resolves.toEqual({
      trackingChangeId: CHANGE_ID, trackingVersion: 2, replayed: false,
    });
    const exactSnakeCaseInput = {
      _order_id: ORDER_ID, _fulfillment_id: FULFILLMENT_ID, _actor_id: ACTOR_ID, _request_key: REQUEST_KEY,
      _shipping_carrier: 'sagawa', _tracking_number: 'New-123', _notify_customer: false,
    };
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_update_fulfillment_tracking', exactSnakeCaseInput);
    expect(rpc.mock.calls[0][1]._order_id).not.toBe(OTHER_ORDER_ID);
  });

  test('手で配達済みは日付と通知を渡し、event の1行を読む', async () => {
    const { store, rpc } = storeWith([{ event_id: EVENT_ID, delivered_at: AT, replayed: true }]);
    await expect(markFulfillmentDelivered(store, {
      orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY,
      deliveredOn: '2026-10-21', notifyCustomer: true,
    })).resolves.toEqual({ eventId: EVENT_ID, deliveredAt: AT, replayed: true });
    expect(rpc).toHaveBeenCalledWith('admin_mark_fulfillment_delivered', {
      _order_id: ORDER_ID, _fulfillment_id: FULFILLMENT_ID, _actor_id: ACTOR_ID,
      _request_key: REQUEST_KEY, _delivered_on: '2026-10-21', _notify_customer: true,
    });
  });

  test('設定変更は backfilled_count を読む', async () => {
    const { store, rpc } = storeWith([{ enabled: true, updated_at: AT, updated_by: ACTOR_ID, backfilled_count: 3 }]);
    await expect(setDeliveryTracking(store, { enabled: true, actorId: ACTOR_ID })).resolves.toEqual({
      enabled: true, updatedAt: AT, updatedBy: ACTOR_ID, backfilledCount: 3,
    });
    expect(rpc).toHaveBeenCalledWith('admin_set_delivery_tracking', { _enabled: true, _actor_id: ACTOR_ID });
  });

  test.each(['resolved', 'already_resolved'] as const)('要対応は %s を読む', async (outcome) => {
    const { store, rpc } = storeWith([{ outcome }]);
    await expect(resolveDeliveryAttention(store, { attentionId: ATTENTION_ID, actorId: ACTOR_ID }))
      .resolves.toEqual({ outcome });
    expect(rpc).toHaveBeenCalledWith('admin_resolve_delivery_attention', {
      _attention_id: ATTENTION_ID, _actor_id: ACTOR_ID,
    });
  });

  test('設定の読み出しは鍵を加えず、未変更の null と件数0を保つ', async () => {
    const { store, rpc } = storeWith([{ enabled: false, updated_at: null, updated_by_email: null, backfill_count: 0 }]);
    await expect(getDeliveryTrackingSettings(store)).resolves.toEqual({
      enabled: false, updatedAt: null, updatedByEmail: null, backfillCount: 0,
    });
    expect(rpc.mock.calls[0][0]).toBe('get_delivery_tracking_settings');
    expect(rpc.mock.calls[0][1] ?? {}).toEqual({});
  });

  test('注文の jsonb の入れ子・配列・nullable を camelCase に直す', async () => {
    const { store, rpc } = storeWith({ enabled: true, fulfillments: [FULFILLMENT_ROW] });
    await expect(getOrderDeliveryDetail(store, ORDER_ID)).resolves.toEqual({ enabled: true, fulfillments: [FULFILLMENT] });
    expect(rpc).toHaveBeenCalledWith('get_order_delivery_detail', { _order_id: ORDER_ID });
  });

  test('発送なしの jsonb は配列を保つ', async () => {
    const { store } = storeWith({ enabled: false, fulfillments: [] });
    await expect(getOrderDeliveryDetail(store, ORDER_ID)).resolves.toEqual({ enabled: false, fulfillments: [] });
  });

  test('要対応の JSON 配列と limit 前の total を別々に読む', async () => {
    const { store, rpc } = storeWith({ items: [ATTENTION_ROW], total: 12 });
    await expect(listDeliveryAttention(store, 1)).resolves.toEqual({
      items: [{
        id: ATTENTION_ID, orderId: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', fulfillmentId: FULFILLMENT_ID,
        fulfillmentNumber: 1, kind: 'delivery_failure', openedAt: AT, status: 'failure',
      }], total: 12,
    });
    expect(rpc).toHaveBeenCalledWith('list_delivery_attention', { _limit: 1 });
  });
});

describe('worker の7つの RPC', () => {
  test.each(['register', 'retrack', 'read', 'stop'] as const)('10列の claim と action=%s を読む', async (action) => {
    const { store, rpc } = storeWith([{ ...CLAIM_ROW, action }]);
    await expect(claimDeliveryTracking(store, { limit: 40, leaseSeconds: 60 })).resolves.toEqual([{ ...CLAIM, action }]);
    expect(rpc).toHaveBeenCalledWith('claim_delivery_tracking', { _limit: 40, _lease_seconds: 60 });
  });

  test('借りる対象なしの TABLE は空配列', async () => {
    const { store } = storeWith([]);
    await expect(claimDeliveryTracking(store, { limit: 1, leaseSeconds: 30 })).resolves.toEqual([]);
  });

  test.each([
    ['registered', 'registered'], ['invalid_number', 'failed'], ['transient', 'pending'],
    ['account', 'pending'], ['retrack_exhausted', 'failed'],
  ] as const)(
    '登録結果 %s は版と借りの印を含め、状態 %s を読む', async (outcome, state) => {
      const { store, rpc } = storeWith([{ applied: true, state }]);
      await expect(recordDeliveryRegistrationResult(store, { ...CLAIM, action: 'register' }, outcome, 'provider_error'))
        .resolves.toEqual({ applied: true, state });
      expect(rpc).toHaveBeenCalledWith('record_delivery_registration_result', {
        _fulfillment_id: FULFILLMENT_ID, _tracking_version: 2, _lease_token: LEASE_TOKEN,
        _outcome: outcome, _error_code: 'provider_error',
      });
    },
  );

  test('読み直し結果の8キーは snake_case で送り、3つの boolean を読む', async () => {
    const { store, rpc } = storeWith([{ applied: true, changed: true, stopped: false }]);
    await expect(recordDeliveryReadResult(store, CLAIM, READ)).resolves.toEqual({
      applied: true, changed: true, stopped: false,
    });
    expect(rpc).toHaveBeenCalledWith('record_delivery_read_result', {
      _fulfillment_id: FULFILLMENT_ID, _tracking_version: 2, _lease_token: LEASE_TOKEN, _result: READ_ROW,
    });
  });

  test('token の拒否は applied=false を保ち成功へ変えない', async () => {
    const registration = storeWith([{ applied: false, state: 'pending' }]);
    await expect(recordDeliveryRegistrationResult(registration.store, CLAIM, 'registered', null))
      .resolves.toEqual({ applied: false, state: 'pending' });
    const read = storeWith([{ applied: false, changed: false, stopped: false }]);
    await expect(recordDeliveryReadResult(read.store, CLAIM, READ))
      .resolves.toEqual({ applied: false, changed: false, stopped: false });
    const stop = storeWith(false);
    await expect(recordDeliveryStopResult(stop.store, CLAIM, true, null)).resolves.toBe(false);
  });

  test.each([null, 'pending', 'registered', 'stopped', 'failed'] as const)(
    '登録結果の applied=false は state=%s を保つ（controller の nullable 決定）', async (state) => {
      const { store } = storeWith([{ applied: false, state }]);
      await expect(recordDeliveryRegistrationResult(store, CLAIM, 'registered', null))
        .resolves.toEqual({ applied: false, state });
    },
  );

  test('signal の JSON 配列と integer の答えを読む', async () => {
    const { store, rpc } = storeWith(2);
    const signals = [
      { carrier: 100062 as const, number: 'Old-123', event: 'TRACKING_UPDATED' as const },
      { carrier: 100040 as const, number: 'New-123', event: 'TRACKING_STOPPED' as const },
    ];
    await expect(signalDeliveryTracking(store, signals)).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith('signal_delivery_tracking', { _signals: signals });
  });

  test('期限切れの上限を渡し、integer の件数を読む', async () => {
    const { store, rpc } = storeWith(3);
    await expect(expireDeliveryTracking(store, 1000)).resolves.toBe(3);
    expect(rpc).toHaveBeenCalledWith('expire_delivery_tracking', { _limit: 1000 });
  });

  test('外への停止は succeeded と nullable の error_code を渡す', async () => {
    const { store, rpc } = storeWith(true);
    await expect(recordDeliveryStopResult(store, CLAIM, true, null)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_delivery_stop_result', {
      _fulfillment_id: FULFILLMENT_ID, _tracking_version: 2, _lease_token: LEASE_TOKEN,
      _succeeded: true, _error_code: null,
    });
  });

  test.each([0, 334])('provider の枠の integer %s ms を読む', async (waitMs) => {
    const { store, rpc } = storeWith(waitMs);
    await expect(takeDeliveryProviderSlot(store)).resolves.toBe(waitMs);
    expect(rpc.mock.calls[0][0]).toBe('take_delivery_provider_slot');
    expect(rpc.mock.calls[0][1] ?? {}).toEqual({});
  });
});

describe('P17: 集計の取りこぼしを配達済みにしない', () => {
  test('一覧は200注文で分け、1000行の答えを拒む', async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `abcdef01-1111-4222-8333-${index.toString(16).padStart(12, '0')}`);
    const { store, rpc } = storeWith([]);
    rpc.mockImplementation(async (_name: string, args: { _order_ids: string[] }) => ({
      data: args._order_ids.map((order_id) => ({ order_id, active_count: 1, delivered_count: 0, attention_kind: null })),
      error: null,
    }));
    const summaries = await listOrderDeliverySummaries(store, ids);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, 'list_order_delivery_summaries', { _order_ids: ids.slice(0, 200) });
    expect(rpc).toHaveBeenNthCalledWith(2, 'list_order_delivery_summaries', { _order_ids: ids.slice(200) });
    expect(summaries.size).toBe(201);
    expect(summaries.get(ids[200])).toEqual({ activeCount: 1, deliveredCount: 0, attentionKind: null });

    const truncated = storeWith(Array.from({ length: 1000 }, () => ({
      order_id: ORDER_ID, active_count: 1, delivered_count: 1, attention_kind: null,
    })));
    await expectStoreError(listOrderDeliverySummaries(truncated.store, [ORDER_ID]), 'list_order_delivery_summaries');
  });

  test('uuid の大小はそろえて送り、元のキーで読む', async () => {
    const { store, rpc } = storeWith([{ order_id: ORDER_ID, active_count: 2, delivered_count: 1, attention_kind: 'attempted_delivery' }]);
    const upperId = ORDER_ID.toUpperCase();
    const summaries = await listOrderDeliverySummaries(store, [upperId, ORDER_ID]);
    expect(rpc).toHaveBeenCalledWith('list_order_delivery_summaries', { _order_ids: [ORDER_ID] });
    expect([...summaries.keys()]).toEqual([upperId, ORDER_ID]);
    expect(summaries.get(upperId)).toEqual({ activeCount: 2, deliveredCount: 1, attentionKind: 'attempted_delivery' });
    expect(summaries.get(ORDER_ID)).toEqual({ activeCount: 2, deliveredCount: 1, attentionKind: 'attempted_delivery' });
  });

  test('空の注文指定は RPC を呼ばず、空 Map を返す', async () => {
    const { store, rpc } = storeWith([]);
    await expect(listOrderDeliverySummaries(store, [])).resolves.toEqual(new Map());
    expect(rpc).not.toHaveBeenCalled();
  });

  test('行が無い注文の数は0で、配達済みの発送を補わない', async () => {
    const { store } = storeWith([]);
    const summaries = await listOrderDeliverySummaries(store, [ORDER_ID]);
    expect(summaries.get(ORDER_ID)).toEqual({ activeCount: 0, deliveredCount: 0, attentionKind: null });
  });
});

// DeliveryErrorCode の全10記号のうち鍵なしはアプリだけの断り。DB からの9記号と引数の別名を固定する。
const REFUSALS = [
  ['ORDER_NOT_FOUND', 'P0002'], ['FULFILLMENT_NOT_FOUND', 'P0002'],
  ['DELIVERY_ARGUMENT_INVALID', '22023'], ['DELIVERY_REQUEST_MISMATCH', '22023'],
  ['DELIVERY_FULFILLMENT_CANCELLED', '22023'], ['DELIVERY_TRACKING_UNCHANGED', '22023'],
  ['DELIVERY_ALREADY_DELIVERED', '22023'], ['DELIVERY_DATE_INVALID', '22023'],
  ['DELIVERY_ATTENTION_NOT_FOUND', 'P0002'],
] as const;

describe('DB の断りと障害', () => {
  test('DBの断りとDB障害と壊れた答えを分ける', async () => {
    const refused = storeWith(null, { message: 'DELIVERY_TRACKING_UNCHANGED', code: '22023' });
    const refusal: unknown = await updateFulfillmentTracking(refused.store, INPUT).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeliveryOperationError);
    expect(refusal).toMatchObject({ code: 'DELIVERY_TRACKING_UNCHANGED' });
    const unavailable = storeWith(null, { message: 'database unavailable', code: '08006' });
    await expectStoreError(updateFulfillmentTracking(unavailable.store, INPUT), 'admin_update_fulfillment_tracking', '08006');
    const broken = storeWith([{ tracking_change_id: CHANGE_ID }]);
    const brokenResponse: unknown = await updateFulfillmentTracking(broken.store, INPUT).catch((error: unknown) => error);
    expect(brokenResponse).toBeInstanceOf(DeliveryStoreError);
  });

  test.each(REFUSALS)('DB の %s（%s）は操作の断り', async (code, sqlstate) => {
    const { store } = storeWith(null, { message: `error: ${code} (detail)`, code: sqlstate });
    const error: unknown = await updateFulfillmentTracking(store, INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryOperationError);
    expect(error).toMatchObject({ code });
  });

  test('TOO_MANY_ORDERS は DELIVERY_ARGUMENT_INVALID へ訳す', async () => {
    const { store } = storeWith(null, { message: 'TOO_MANY_ORDERS', code: '22023' });
    const error: unknown = await listOrderDeliverySummaries(store, [ORDER_ID]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryOperationError);
    expect(error).toMatchObject({ code: 'DELIVERY_ARGUMENT_INVALID' });
  });

  test('作成の再送の FULFILLMENT_REQUEST_MISMATCH も操作拒否にそろえる', async () => {
    const { store } = storeWith(null, { message: 'FULFILLMENT_REQUEST_MISMATCH', code: '22023' });
    const error: unknown = await updateFulfillmentTracking(store, INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryOperationError);
    expect(error).toMatchObject({ code: 'DELIVERY_REQUEST_MISMATCH' });
  });

  test.each([
    ['SUPERSEDE_NOT_ALLOWED', '22023'], ['DELIVERY_RECORD_APPEND_ONLY', '55000'],
    ['DELIVERY_RECORD_IMMUTABLE', '55000'], ['UNKNOWN_DB_ERROR', 'XX000'],
  ] as const)(
    '%s（%s）は画面用の断りへ訳さず StoreError', async (message, code) => {
      const { store } = storeWith(null, { message, code });
      await expectStoreError(updateFulfillmentTracking(store, INPUT), 'admin_update_fulfillment_tracking', code);
    },
  );

  test('StoreError の表の文には DB の本文を出さない', async () => {
    const marker = 'db-internal-diagnostic-marker';
    const { store } = storeWith(null, { message: marker, code: '23514' });
    const error = await updateFulfillmentTracking(store, INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeliveryStoreError);
    expect(String(error)).not.toContain(marker);
  });
});

type StoreCall = (store: DeliveryStore) => Promise<unknown>;
const SINGLE_ROW_CALLS: ReadonlyArray<readonly [string, StoreCall]> = [
  ['admin_update_fulfillment_tracking', (store) => updateFulfillmentTracking(store, INPUT)],
  ['admin_mark_fulfillment_delivered', (store) => markFulfillmentDelivered(store, {
    orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY,
    deliveredOn: '2026-10-21', notifyCustomer: true,
  })],
  ['admin_set_delivery_tracking', (store) => setDeliveryTracking(store, { enabled: false, actorId: ACTOR_ID })],
  ['admin_resolve_delivery_attention', (store) => resolveDeliveryAttention(store, { attentionId: ATTENTION_ID, actorId: ACTOR_ID })],
  ['get_delivery_tracking_settings', (store) => getDeliveryTrackingSettings(store)],
  ['record_delivery_registration_result', (store) => recordDeliveryRegistrationResult(store, CLAIM, 'registered', null)],
  ['record_delivery_read_result', (store) => recordDeliveryReadResult(store, CLAIM, READ)],
];
const ALL_CALLS: ReadonlyArray<readonly [string, StoreCall]> = [
  ...SINGLE_ROW_CALLS,
  ['list_order_delivery_summaries', (store) => listOrderDeliverySummaries(store, [ORDER_ID])],
  ['get_order_delivery_detail', (store) => getOrderDeliveryDetail(store, ORDER_ID)],
  ['list_delivery_attention', (store) => listDeliveryAttention(store, 10)],
  ['claim_delivery_tracking', (store) => claimDeliveryTracking(store, { limit: 1, leaseSeconds: 60 })],
  ['signal_delivery_tracking', (store) => signalDeliveryTracking(store, [])],
  ['expire_delivery_tracking', (store) => expireDeliveryTracking(store, 1000)],
  ['record_delivery_stop_result', (store) => recordDeliveryStopResult(store, CLAIM, true, null)],
  ['take_delivery_provider_slot', (store) => takeDeliveryProviderSlot(store)],
];

describe('壊れた返却値を成功にしない', () => {
  test.each(ALL_CALLS)('%s は error を空の成功へ変えない', async (operation, call) => {
    const { store } = storeWith(null, { code: '08006', message: 'db-internal-diagnostic-marker' });
    await expectStoreError(call(store), operation, '08006');
  });

  test.each(SINGLE_ROW_CALLS)('%s の0行・2行・null・TABLEでない答えは StoreError', async (operation, call) => {
    for (const value of [[], [{}, {}], null, {}]) {
      const { store } = storeWith(value);
      await expectStoreError(call(store), operation);
    }
  });

  test.each([
    ['tracking_change_id', null], ['tracking_version', 0], ['tracking_version', -1],
    ['tracking_version', 1.5], ['replayed', 'false'],
  ])('番号の直しの %s=%s は StoreError', async (key, value) => {
    const { store } = storeWith([{ tracking_change_id: CHANGE_ID, tracking_version: 2, replayed: false, [key]: value }]);
    await expectStoreError(updateFulfillmentTracking(store, INPUT), 'admin_update_fulfillment_tracking');
  });

  test('手で配達済みの不正時刻は StoreError', async () => {
    const { store } = storeWith([{ event_id: EVENT_ID, delivered_at: 'invalid-time', replayed: false }]);
    await expectStoreError(markFulfillmentDelivered(store, {
      orderId: ORDER_ID, fulfillmentId: FULFILLMENT_ID, actorId: ACTOR_ID, requestKey: REQUEST_KEY,
      deliveredOn: '2026-10-21', notifyCustomer: true,
    }), 'admin_mark_fulfillment_delivered');
  });

  test('設定の負の件数と不正時刻・要対応の未知の outcome を拒む', async () => {
    await expectStoreError(setDeliveryTracking(storeWith([{
      enabled: true, updated_at: AT, updated_by: ACTOR_ID, backfilled_count: -1,
    }]).store, { enabled: true, actorId: ACTOR_ID }), 'admin_set_delivery_tracking');
    await expectStoreError(getDeliveryTrackingSettings(storeWith([{
      enabled: true, updated_at: 'invalid-time', updated_by_email: null, backfill_count: 0,
    }]).store), 'get_delivery_tracking_settings');
    await expectStoreError(resolveDeliveryAttention(storeWith([{ outcome: 'future' }]).store, {
      attentionId: ATTENTION_ID, actorId: ACTOR_ID,
    }), 'admin_resolve_delivery_attention');
  });

  test.each([
    ['carrier', 'future'], ['action', 'future'], ['signal_revision', -1],
    ['signal_revision', Number.MAX_SAFE_INTEGER + 1], ['attempts', -1], ['read_attempts', -1],
    ['tracking_version', 0], ['expires_at', 'invalid-time'], ['lease_token', null],
  ])('claim の %s=%s は StoreError', async (key, value) => {
    const { store } = storeWith([{ ...CLAIM_ROW, [key]: value }]);
    await expectStoreError(claimDeliveryTracking(store, { limit: 1, leaseSeconds: 60 }), 'claim_delivery_tracking');
  });

  test.each([
    ['delivery_status', 'future'], ['delivered_source', 'future'], ['delivery_status_at', 'invalid-time'], ['shipped_at', null],
    ['tracking_version', 0], ['number', -1], ['notify_customer', null],
    ['events', null], ['tracking_changes', {}],
    ['registration', { state: 'future', failure_kind: null, stop_reason: null, expires_at: EXPIRES_AT }],
    ['registration', { state: 'failed', failure_kind: 'future', stop_reason: null, expires_at: EXPIRES_AT }],
    ['registration', { state: 'stopped', failure_kind: null, stop_reason: 'future', expires_at: EXPIRES_AT }],
    ['events', [{ ...FULFILLMENT_ROW.events[0], source: 'future' }]],
    ['events', [{ ...FULFILLMENT_ROW.events[0], status: 'future' }]],
    ['events', [{ ...FULFILLMENT_ROW.events[0], happened_at: 'invalid-time' }]],
    ['tracking_changes', [{ ...FULFILLMENT_ROW.tracking_changes[0], to_carrier: 'future' }]],
    ['tracking_changes', [{ ...FULFILLMENT_ROW.tracking_changes[0], email_status: 'future' }]],
  ])('配送詳細の %s が壊れていれば StoreError', async (key, value) => {
    const { store } = storeWith({ enabled: true, fulfillments: [{ ...FULFILLMENT_ROW, [key as string]: value }] });
    await expectStoreError(getOrderDeliveryDetail(store, ORDER_ID), 'get_order_delivery_detail');
  });

  test.each([
    ['active_count', -1], ['delivered_count', -1], ['delivered_count', 2], ['attention_kind', 'future'],
  ])('集計の %s=%s は StoreError', async (key, value) => {
    const { store } = storeWith([{ order_id: ORDER_ID, active_count: 1, delivered_count: 0, attention_kind: null, [key]: value }]);
    await expectStoreError(listOrderDeliverySummaries(store, [ORDER_ID]), 'list_order_delivery_summaries');
  });

  test.each([
    { items: null, total: 0 }, { items: [], total: -1 },
    { items: [{ ...ATTENTION_ROW, kind: 'future' }], total: 1 },
    { items: [{ ...ATTENTION_ROW, opened_at: 'invalid-time' }], total: 1 },
  ])('要対応の配列・件数・enum・時刻を厳しく読む: %j', async (answer) => {
    const { store } = storeWith(answer);
    await expectStoreError(listDeliveryAttention(store, 10), 'list_delivery_attention');
  });

  test.each(['future', null])('登録が適用された時の状態 %s は StoreError', async (state) => {
    const { store } = storeWith([{ applied: true, state }]);
    await expectStoreError(recordDeliveryRegistrationResult(store, CLAIM, 'registered', null), 'record_delivery_registration_result');
  });

  test.each(['future', undefined])('登録が適用されなくても未知・欠落の state=%s は StoreError', async (state) => {
    const { store } = storeWith([{ applied: false, ...(state === undefined ? {} : { state }) }]);
    await expectStoreError(recordDeliveryRegistrationResult(store, CLAIM, 'registered', null), 'record_delivery_registration_result');
  });

  test.each([-1, 0.5, '1', null, [1]])('integer の代わりの %j は3つの数値 RPC 全部で StoreError', async (answer) => {
    await expectStoreError(signalDeliveryTracking(storeWith(answer).store, []), 'signal_delivery_tracking');
    await expectStoreError(expireDeliveryTracking(storeWith(answer).store, 1000), 'expire_delivery_tracking');
    await expectStoreError(takeDeliveryProviderSlot(storeWith(answer).store), 'take_delivery_provider_slot');
  });

  test('停止の boolean を文字列や TABLE から推測しない', async () => {
    for (const answer of ['false', null, [{ applied: true }]]) {
      await expectStoreError(recordDeliveryStopResult(storeWith(answer).store, CLAIM, true, null), 'record_delivery_stop_result');
    }
  });
});
