import { buildOrderHistory, type BuildOrderHistoryInput } from '@/lib/orders/email/order-history';
import type { FulfillmentDeliveryDetail } from '@/lib/orders/tracking/delivery-types';

const AT = '2026-10-21T01:00:00Z';
function detail(): FulfillmentDeliveryDetail {
  return {
    fulfillmentId: 'f-1', number: 1, carrier: 'sagawa', trackingNumber: 'NEW-1', notifyCustomer: false,
    shippedAt: '2026-10-20T00:00:00Z', cancelledAt: AT, trackingVersion: 2, deliveryStatus: 'confirmed',
    deliveryStatusAt: AT, deliveredAt: null, deliveredSource: null,
    registration: { state: 'pending', failureKind: null, stopReason: null, expiresAt: '2026-11-20T00:00:00Z', everRegistered: false },
    events: [{ id: 'e-1', trackingVersion: 2, status: 'confirmed', happenedAt: AT, recordedAt: AT, source: 'tracking_edit', providerSubStatus: null, actorEmail: 'actor@example.test' }],
    trackingChanges: [{ id: 'c-1', fromCarrier: 'yamato', fromTrackingNumber: 'OLD', toCarrier: 'sagawa', toTrackingNumber: 'NEW-1',
      trackingVersion: 2, notifyCustomer: true, changedAt: AT, actorEmail: 'actor@example.test', emailStatus: 'pending' }],
  };
}
function input(fulfillment = detail(), enabled = true): BuildOrderHistoryInput {
  return {
    order: { id: 'a1111111-1111-4111-8111-111111111111', status: 'shipped', shippingEmail: null, createdAt: '2026-10-19T00:00:00Z' },
    statusRows: [], emailRows: [], sendState: { paused: false, reason: null }, completions: [], refunds: [], returns: [],
    returnReceiptLines: [], returnRecords: [], cancelRequests: [], lines: [],
    fulfillments: [{ fulfillmentId: 'f-1', number: 1, shippingCarrier: 'yamato', trackingNumber: 'OLD', notifyCustomer: true,
      completesOrder: true, shippedAt: fulfillment.shippedAt, createdByEmail: null, cancelledAt: null, cancelledByEmail: null, legacy: false, lines: [] }],
    delivery: { enabled, fulfillments: [fulfillment] },
  };
}
test('履歴は出来事・直し・登録の現在値を別の形で返す', () => {
  const current = detail();
  const history = buildOrderHistory(input(current));
  expect(history.entries.map((entry) => entry.type)).toEqual(expect.arrayContaining(['fulfillment', 'delivery_event', 'tracking_change']));
  expect(history.entries.find((entry) => entry.type === 'fulfillment')).toMatchObject({
    carrierLabel: '佐川急便', trackingNumber: 'NEW-1', notifyCustomer: false, cancelled: true, cancellable: false, delivery: current,
  });
  expect(history.entries.filter((entry) => entry.type === 'delivery_event')).toEqual([
    { type: 'delivery_event', at: AT, fulfillmentId: 'f-1', number: 1, event: current.events[0] },
  ]);
  expect(history.entries.filter((entry) => entry.type === 'tracking_change')).toEqual([
    { type: 'tracking_change', at: AT, fulfillmentId: 'f-1', number: 1, change: current.trackingChanges[0] },
  ]);
  expect(history.entries).toHaveLength(4);
});
test.each(['sent', 'pending', 'retry_wait', 'dead', 'skipped', null] as const)('直しのemailStatus=%sはnotifyから推測しない', (emailStatus) => {
  const current = detail(); current.trackingChanges[0].emailStatus = emailStatus;
  const history = buildOrderHistory(input(current));
  expect(history.entries.find((entry) => entry.type === 'tracking_change')).toMatchObject({ change: { emailStatus } });
});
test('時刻降順・同時刻はtypeとidで安定し、入力の並びに左右されない', () => {
  const current = detail();
  current.events.push({ ...current.events[0], id: 'e-0' }, { ...current.events[0], id: 'e-2', happenedAt: '2026-10-22T00:00:00Z' });
  current.trackingChanges.push({ ...current.trackingChanges[0], id: 'c-0' });
  const first = buildOrderHistory(input(current));
  current.events.reverse(); current.trackingChanges.reverse();
  expect(buildOrderHistory(input(current))).toEqual(first);
  expect(first.entries.slice(0, 5)).toMatchObject([
    { type: 'delivery_event', event: { id: 'e-2' } },
    { type: 'delivery_event', event: { id: 'e-0' } }, { type: 'delivery_event', event: { id: 'e-1' } },
    { type: 'tracking_change', change: { id: 'c-0' } }, { type: 'tracking_change', change: { id: 'c-1' } },
  ]);
});
test('OFFも管理履歴には登録の現在値と過去の出来事を保つ（顧客用へ流用しない）', () => {
  const current = detail();
  expect(buildOrderHistory(input(current, false)).entries.find((entry) => entry.type === 'fulfillment')).toMatchObject({ delivery: current });
});
test('古い見本でdeliveryが無い時だけ従来の発送を使う', () => {
  const value = input(); delete value.delivery;
  const entry = buildOrderHistory(value).entries.find((row) => row.type === 'fulfillment');
  expect(entry).toMatchObject({ trackingNumber: 'OLD', notifyCustomer: true, cancelled: false });
  expect(entry).not.toHaveProperty('delivery');
});
test.each([true, false])('履歴の答えに追跡のオン・オフ（enabled=%s）を付ける（管理画面が現在の状況と登録の状態を出すかの根拠）', (enabled) => {
  expect(buildOrderHistory(input(detail(), enabled)).deliveryTrackingEnabled).toBe(enabled);
});
test('deliveryが無い古い見本には追跡のオン・オフを付けない（画面はオフとして読む）', () => {
  const value = input(); delete value.delivery;
  expect(buildOrderHistory(value)).not.toHaveProperty('deliveryTrackingEnabled');
});
