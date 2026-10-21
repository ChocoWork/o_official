import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ORDER_EMAIL_STATUSES } from '@/lib/orders/email/order-email-types';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import {
  DELIVERY_ATTENTION_KINDS,
  DELIVERY_ERROR_CODES,
  DELIVERY_EVENT_SOURCES,
  DELIVERY_STATUSES,
  TRACKING_FAILURE_KINDS,
  TRACKING_STATES,
  TRACKING_STOP_REASONS,
  type DeliveryAttentionItem,
  type DeliveryErrorCode,
  type DeliveryEvent,
  type DeliveryReadResult,
  type DeliveryRegistration,
  type DeliveryTrackingSettings,
  type FulfillmentDeliveryDetail,
  type MarkDeliveredInput,
  type MarkDeliveredResult,
  type OrderDeliveryDetail,
  type OrderDeliverySummary,
  type RegistrationOutcome,
  type TrackingChange,
  type TrackingClaim,
  type TrackingSignal,
  type TrackingState,
  type UpdateTrackingInput,
  type UpdateTrackingResult,
} from '@/lib/orders/tracking/delivery-types';

export type DeliveryStore = Pick<SupabaseClient, 'rpc'>;

export class DeliveryOperationError extends Error {
  constructor(readonly code: DeliveryErrorCode) {
    super(`delivery operation refused: ${code}`);
    this.name = 'DeliveryOperationError';
  }
}

/** DB の本文・返却値を保持せず、ログにも操作名と記号だけが出る。 */
export class DeliveryStoreError extends Error {
  constructor(readonly operation: string, readonly code: string | null = null) {
    super(`delivery store failed: ${operation}`);
    this.name = 'DeliveryStoreError';
  }
}

const DB_ERROR_WORDS: Array<readonly [string, DeliveryErrorCode]> = [
  ...DELIVERY_ERROR_CODES.map((code): readonly [string, DeliveryErrorCode] => [code, code]),
  ['TOO_MANY_ORDERS', 'DELIVERY_ARGUMENT_INVALID'],
  ['FULFILLMENT_REQUEST_MISMATCH', 'DELIVERY_REQUEST_MISMATCH'],
];
DB_ERROR_WORDS.sort((a, b) => b[0].length - a[0].length);

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function row(value: unknown, operation: string): Row {
  if (!isRow(value)) throw new DeliveryStoreError(operation);
  return value;
}

function array(value: unknown, operation: string): unknown[] {
  if (!Array.isArray(value)) throw new DeliveryStoreError(operation);
  return value;
}

function singleRow(value: unknown, operation: string): Row {
  const rows = array(value, operation);
  if (rows.length !== 1) throw new DeliveryStoreError(operation);
  return row(rows[0], operation);
}

function text(value: unknown, operation: string): string {
  if (typeof value !== 'string') throw new DeliveryStoreError(operation);
  return value;
}

function nullableText(value: unknown, operation: string): string | null {
  return value === null ? null : text(value, operation);
}

function uuid(value: unknown, operation: string): string {
  const result = text(value, operation);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) {
    throw new DeliveryStoreError(operation);
  }
  return result;
}

function boolean(value: unknown, operation: string): boolean {
  if (typeof value !== 'boolean') throw new DeliveryStoreError(operation);
  return value;
}

function integer(value: unknown, operation: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new DeliveryStoreError(operation);
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, operation: string): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new DeliveryStoreError(operation);
  return value as Values[number];
}

function nullableEnum<const Values extends readonly string[]>(value: unknown, values: Values, operation: string): Values[number] | null {
  return value === null ? null : enumValue(value, values, operation);
}

/** PostgREST の offset 付き時刻だけを受け、Date.parse が補正する2月30日なども拒む。文字列は保存時のまま返す。 */
function timestamp(value: unknown, operation: string): string {
  const result = text(value, operation);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(result);
  if (!parts || !Number.isFinite(Date.parse(result))) throw new DeliveryStoreError(operation);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    throw new DeliveryStoreError(operation);
  }
  return result;
}

function nullableTimestamp(value: unknown, operation: string): string | null {
  return value === null ? null : timestamp(value, operation);
}

function errorCode(error: unknown): string | null {
  return isRow(error) && typeof error.code === 'string' ? error.code : null;
}

async function callRpc(store: DeliveryStore, operation: string, args?: Record<string, unknown>): Promise<unknown> {
  let response: unknown;
  try {
    response = await store.rpc(operation, args);
  } catch (error: unknown) {
    throw new DeliveryStoreError(operation, errorCode(error));
  }
  const answer = row(response, operation);
  if (answer.error !== null && answer.error !== undefined) {
    const error = row(answer.error, operation);
    const message = typeof error.message === 'string' ? error.message : '';
    const refusal = DB_ERROR_WORDS.find(([word]) => message.includes(word))?.[1];
    if (refusal) throw new DeliveryOperationError(refusal);
    throw new DeliveryStoreError(operation, errorCode(error));
  }
  return answer.data;
}

function parseEvent(value: unknown, operation: string): DeliveryEvent {
  const result = row(value, operation);
  return {
    id: uuid(result.id, operation), trackingVersion: integer(result.tracking_version, operation, 1),
    status: enumValue(result.status, DELIVERY_STATUSES, operation), happenedAt: timestamp(result.happened_at, operation),
    recordedAt: timestamp(result.recorded_at, operation), source: enumValue(result.source, DELIVERY_EVENT_SOURCES, operation),
    providerSubStatus: nullableText(result.provider_sub_status, operation), actorEmail: nullableText(result.actor_email, operation),
  };
}

function parseTrackingChange(value: unknown, operation: string): TrackingChange {
  const result = row(value, operation);
  return {
    id: uuid(result.id, operation), fromCarrier: nullableText(result.from_carrier, operation),
    fromTrackingNumber: nullableText(result.from_tracking_number, operation),
    toCarrier: enumValue(result.to_carrier, SHIPPING_CARRIER_IDS, operation), toTrackingNumber: text(result.to_tracking_number, operation),
    trackingVersion: integer(result.tracking_version, operation, 2), notifyCustomer: boolean(result.notify_customer, operation),
    changedAt: timestamp(result.changed_at, operation), actorEmail: nullableText(result.actor_email, operation),
    emailStatus: nullableEnum(result.email_status, ORDER_EMAIL_STATUSES, operation),
  };
}

function parseRegistration(value: unknown, operation: string): DeliveryRegistration {
  const result = row(value, operation);
  return {
    state: enumValue(result.state, TRACKING_STATES, operation),
    failureKind: nullableEnum(result.failure_kind, TRACKING_FAILURE_KINDS, operation),
    stopReason: nullableEnum(result.stop_reason, TRACKING_STOP_REASONS, operation), expiresAt: timestamp(result.expires_at, operation),
    everRegistered: boolean(result.ever_registered, operation),
  };
}

function parseFulfillment(value: unknown, operation: string): FulfillmentDeliveryDetail {
  const result = row(value, operation);
  return {
    fulfillmentId: uuid(result.fulfillment_id, operation), number: integer(result.number, operation, 1),
    carrier: nullableText(result.carrier, operation), trackingNumber: nullableText(result.tracking_number, operation),
    notifyCustomer: boolean(result.notify_customer, operation), shippedAt: timestamp(result.shipped_at, operation),
    cancelledAt: nullableTimestamp(result.cancelled_at, operation), trackingVersion: integer(result.tracking_version, operation, 1),
    deliveryStatus: enumValue(result.delivery_status, DELIVERY_STATUSES, operation), deliveryStatusAt: timestamp(result.delivery_status_at, operation),
    deliveredAt: nullableTimestamp(result.delivered_at, operation), deliveredSource: nullableEnum(result.delivered_source, ['tracking', 'manual'], operation),
    registration: result.registration === null ? null : parseRegistration(result.registration, operation),
    events: array(result.events, operation).map((event) => parseEvent(event, operation)),
    trackingChanges: array(result.tracking_changes, operation).map((change) => parseTrackingChange(change, operation)),
  };
}

function parseAttention(value: unknown, operation: string): DeliveryAttentionItem {
  const result = row(value, operation);
  return {
    id: uuid(result.id, operation), orderId: uuid(result.order_id, operation), orderNumber: text(result.order_number, operation),
    fulfillmentId: uuid(result.fulfillment_id, operation), fulfillmentNumber: integer(result.fulfillment_number, operation, 1),
    kind: enumValue(result.kind, DELIVERY_ATTENTION_KINDS, operation), openedAt: timestamp(result.opened_at, operation),
    status: enumValue(result.status, DELIVERY_STATUSES, operation),
  };
}

export async function updateFulfillmentTracking(store: DeliveryStore, input: UpdateTrackingInput): Promise<UpdateTrackingResult> {
  const operation = 'admin_update_fulfillment_tracking';
  const result = singleRow(await callRpc(store, operation, {
    _order_id: input.orderId, _fulfillment_id: input.fulfillmentId, _actor_id: input.actorId, _request_key: input.requestKey,
    _shipping_carrier: input.carrier, _tracking_number: input.trackingNumber, _notify_customer: input.notifyCustomer,
  }), operation);
  return {
    trackingChangeId: uuid(result.tracking_change_id, operation), trackingVersion: integer(result.tracking_version, operation, 2),
    replayed: boolean(result.replayed, operation),
  };
}

export async function markFulfillmentDelivered(store: DeliveryStore, input: MarkDeliveredInput): Promise<MarkDeliveredResult> {
  const operation = 'admin_mark_fulfillment_delivered';
  const result = singleRow(await callRpc(store, operation, {
    _order_id: input.orderId, _fulfillment_id: input.fulfillmentId, _actor_id: input.actorId,
    _request_key: input.requestKey, _delivered_on: input.deliveredOn, _notify_customer: input.notifyCustomer,
  }), operation);
  return { eventId: uuid(result.event_id, operation), deliveredAt: timestamp(result.delivered_at, operation), replayed: boolean(result.replayed, operation) };
}

export async function setDeliveryTracking(
  store: DeliveryStore, input: { enabled: boolean; actorId: string },
): Promise<{ enabled: boolean; updatedAt: string | null; updatedBy: string | null; backfilledCount: number }> {
  const operation = 'admin_set_delivery_tracking';
  const result = singleRow(await callRpc(store, operation, { _enabled: input.enabled, _actor_id: input.actorId }), operation);
  return {
    enabled: boolean(result.enabled, operation), updatedAt: nullableTimestamp(result.updated_at, operation),
    updatedBy: result.updated_by === null ? null : uuid(result.updated_by, operation), backfilledCount: integer(result.backfilled_count, operation),
  };
}

export async function resolveDeliveryAttention(
  store: DeliveryStore, input: { attentionId: string; actorId: string },
): Promise<{ outcome: 'resolved' | 'already_resolved' }> {
  const operation = 'admin_resolve_delivery_attention';
  const result = singleRow(await callRpc(store, operation, { _attention_id: input.attentionId, _actor_id: input.actorId }), operation);
  return { outcome: enumValue(result.outcome, ['resolved', 'already_resolved'], operation) };
}

export async function getDeliveryTrackingSettings(store: DeliveryStore): Promise<Omit<DeliveryTrackingSettings, 'keyConfigured'>> {
  const operation = 'get_delivery_tracking_settings';
  const result = singleRow(await callRpc(store, operation), operation);
  return {
    enabled: boolean(result.enabled, operation), updatedAt: nullableTimestamp(result.updated_at, operation),
    updatedByEmail: nullableText(result.updated_by_email, operation), backfillCount: integer(result.backfill_count, operation),
  };
}

export async function listOrderDeliverySummaries(store: DeliveryStore, orderIds: readonly string[]): Promise<Map<string, OrderDeliverySummary>> {
  const operation = 'list_order_delivery_summaries';
  const ids = [...new Set(orderIds.map((id) => id.toLowerCase()))];
  const summaries = new Map<string, OrderDeliverySummary>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200);
    const expected = new Set(chunk);
    const rows = array(await callRpc(store, operation, { _order_ids: chunk }), operation);
    if (rows.length >= 1000) throw new DeliveryStoreError(operation);
    for (const value of rows) {
      const result = row(value, operation);
      const id = uuid(result.order_id, operation).toLowerCase();
      if (!expected.has(id) || summaries.has(id)) throw new DeliveryStoreError(operation);
      const activeCount = integer(result.active_count, operation);
      const deliveredCount = integer(result.delivered_count, operation);
      if (deliveredCount > activeCount) throw new DeliveryStoreError(operation);
      summaries.set(id, { activeCount, deliveredCount, attentionKind: nullableEnum(result.attention_kind, DELIVERY_ATTENTION_KINDS, operation) });
    }
  }
  // 行の無い注文に配達済みの発送を補わない。入力の大小・順序のままキーを返す。
  return new Map(orderIds.map((id) => [id, summaries.get(id.toLowerCase()) ?? { activeCount: 0, deliveredCount: 0, attentionKind: null }]));
}

export async function getOrderDeliveryDetail(store: DeliveryStore, orderId: string): Promise<OrderDeliveryDetail> {
  const operation = 'get_order_delivery_detail';
  const result = row(await callRpc(store, operation, { _order_id: orderId }), operation);
  return { enabled: boolean(result.enabled, operation), fulfillments: array(result.fulfillments, operation).map((value) => parseFulfillment(value, operation)) };
}

export async function listDeliveryAttention(store: DeliveryStore, limit: number): Promise<{ items: DeliveryAttentionItem[]; total: number }> {
  const operation = 'list_delivery_attention';
  const result = row(await callRpc(store, operation, { _limit: limit }), operation);
  const items = array(result.items, operation).map((value) => parseAttention(value, operation));
  const total = integer(result.total, operation);
  if (items.length > total) throw new DeliveryStoreError(operation);
  return { items, total };
}

export async function claimDeliveryTracking(store: DeliveryStore, input: { limit: number; leaseSeconds: number }): Promise<TrackingClaim[]> {
  const operation = 'claim_delivery_tracking';
  const rows = array(await callRpc(store, operation, { _limit: input.limit, _lease_seconds: input.leaseSeconds }), operation);
  return rows.map((value) => {
    const result = row(value, operation);
    return {
      fulfillmentId: uuid(result.fulfillment_id, operation), trackingVersion: integer(result.tracking_version, operation, 1),
      carrier: enumValue(result.carrier, SHIPPING_CARRIER_IDS, operation), trackingNumber: text(result.tracking_number, operation),
      action: enumValue(result.action, ['register', 'retrack', 'read', 'stop'], operation), leaseToken: uuid(result.lease_token, operation),
      signalRevision: integer(result.signal_revision, operation), attempts: integer(result.attempts, operation),
      readAttempts: integer(result.read_attempts, operation), expiresAt: timestamp(result.expires_at, operation),
    };
  });
}

export async function recordDeliveryRegistrationResult(
  store: DeliveryStore, claim: TrackingClaim, outcome: RegistrationOutcome, errorCode: string | null,
): Promise<{ applied: boolean; state: TrackingState | null }> {
  const operation = 'record_delivery_registration_result';
  const result = singleRow(await callRpc(store, operation, {
    _fulfillment_id: claim.fulfillmentId, _tracking_version: claim.trackingVersion, _lease_token: claim.leaseToken,
    _outcome: outcome, _error_code: errorCode,
  }), operation);
  const applied = boolean(result.applied, operation);
  // 設定OFF・発送なし・指定版なしは false/null。適用した結果には既知の状態が必要。
  const state = !applied && result.state === null ? null : enumValue(result.state, TRACKING_STATES, operation);
  return { applied, state };
}

export async function recordDeliveryReadResult(
  store: DeliveryStore, claim: TrackingClaim, result: DeliveryReadResult,
): Promise<{ applied: boolean; changed: boolean; stopped: boolean }> {
  const operation = 'record_delivery_read_result';
  const answer = singleRow(await callRpc(store, operation, {
    _fulfillment_id: claim.fulfillmentId, _tracking_version: claim.trackingVersion, _lease_token: claim.leaseToken,
    _result: { outcome: result.outcome, status: result.status, provider_status: result.providerStatus,
      provider_sub_status: result.providerSubStatus, happened_at: result.happenedAt, delivered_at: result.deliveredAt,
      read_at: result.readAt, error_code: result.errorCode },
  }), operation);
  return { applied: boolean(answer.applied, operation), changed: boolean(answer.changed, operation), stopped: boolean(answer.stopped, operation) };
}

export async function signalDeliveryTracking(store: DeliveryStore, signals: TrackingSignal[]): Promise<number> {
  const operation = 'signal_delivery_tracking';
  return integer(await callRpc(store, operation, { _signals: signals }), operation);
}

export async function expireDeliveryTracking(store: DeliveryStore, limit: number): Promise<number> {
  const operation = 'expire_delivery_tracking';
  return integer(await callRpc(store, operation, { _limit: limit }), operation);
}

export async function recordDeliveryStopResult(
  store: DeliveryStore, claim: TrackingClaim, succeeded: boolean, errorCode: string | null,
): Promise<boolean> {
  const operation = 'record_delivery_stop_result';
  return boolean(await callRpc(store, operation, {
    _fulfillment_id: claim.fulfillmentId, _tracking_version: claim.trackingVersion, _lease_token: claim.leaseToken,
    _succeeded: succeeded, _error_code: errorCode,
  }), operation);
}

export async function takeDeliveryProviderSlot(store: DeliveryStore): Promise<number> {
  const operation = 'take_delivery_provider_slot';
  return integer(await callRpc(store, operation), operation);
}
