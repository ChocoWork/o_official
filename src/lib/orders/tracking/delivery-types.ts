import type { OrderEmailStatus } from '@/lib/orders/email/order-email-types';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';

export const DELIVERY_STATUSES = [
  'confirmed', 'in_transit', 'out_for_delivery', 'attempted_delivery',
  'ready_for_pickup', 'delivered', 'delayed', 'failure',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_EVENT_SOURCES = ['shipment', 'tracking', 'manual', 'tracking_edit'] as const;
export type DeliveryEventSource = (typeof DELIVERY_EVENT_SOURCES)[number];

export const DELIVERY_ATTENTION_KINDS = [
  'delivery_failure', 'attempted_delivery', 'tracking_not_found',
  'tracking_registration_failed', 'tracking_stalled',
] as const;
export type DeliveryAttentionKind = (typeof DELIVERY_ATTENTION_KINDS)[number];

export const TRACKING_STATES = ['pending', 'registered', 'stopped', 'failed'] as const;
export type TrackingState = (typeof TRACKING_STATES)[number];

export const TRACKING_FAILURE_KINDS = ['invalid_number', 'repeated_error'] as const;
export type TrackingFailureKind = (typeof TRACKING_FAILURE_KINDS)[number];

export const TRACKING_STOP_REASONS = ['delivered', 'expired', 'replaced', 'cancelled', 'provider_stopped', 'disabled'] as const;
export type TrackingStopReason = (typeof TRACKING_STOP_REASONS)[number];
export type TrackingAction = 'register' | 'retrack' | 'read' | 'stop';

export const DELIVERY_ERROR_CODES = [
  'ORDER_NOT_FOUND', 'FULFILLMENT_NOT_FOUND', 'DELIVERY_ARGUMENT_INVALID', 'DELIVERY_REQUEST_MISMATCH',
  'DELIVERY_FULFILLMENT_CANCELLED', 'DELIVERY_TRACKING_UNCHANGED', 'DELIVERY_ALREADY_DELIVERED',
  'DELIVERY_DATE_INVALID', 'DELIVERY_TRACKING_KEY_MISSING', 'DELIVERY_ATTENTION_NOT_FOUND',
] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

export type DeliveryTrackingSettings = {
  enabled: boolean; updatedAt: string | null; updatedByEmail: string | null; keyConfigured: boolean; backfillCount: number;
};
export type DeliveryEvent = {
  id: string; trackingVersion: number; status: DeliveryStatus; happenedAt: string; recordedAt: string;
  source: DeliveryEventSource; providerSubStatus: string | null; actorEmail: string | null;
};
export type TrackingChange = {
  id: string; fromCarrier: string | null; fromTrackingNumber: string | null; toCarrier: ShippingCarrierId;
  toTrackingNumber: string; trackingVersion: number; notifyCustomer: boolean; changedAt: string;
  actorEmail: string | null; emailStatus: OrderEmailStatus | null;
};
export type DeliveryRegistration = {
  state: TrackingState; failureKind: TrackingFailureKind | null; stopReason: TrackingStopReason | null; expiresAt: string;
};
export type FulfillmentDeliveryDetail = {
  fulfillmentId: string; number: number; carrier: string | null; trackingNumber: string | null; notifyCustomer: boolean;
  shippedAt: string; cancelledAt: string | null; trackingVersion: number; deliveryStatus: DeliveryStatus;
  deliveryStatusAt: string; deliveredAt: string | null; deliveredSource: 'tracking' | 'manual' | null;
  registration: DeliveryRegistration | null; events: DeliveryEvent[]; trackingChanges: TrackingChange[];
};
export type OrderDeliveryDetail = { enabled: boolean; fulfillments: FulfillmentDeliveryDetail[] };
export type OrderDeliverySummary = { activeCount: number; deliveredCount: number; attentionKind: DeliveryAttentionKind | null };
export type DeliveryAttentionItem = {
  id: string; orderId: string; orderNumber: string; fulfillmentId: string; fulfillmentNumber: number;
  kind: DeliveryAttentionKind; openedAt: string; status: DeliveryStatus;
};
export type UpdateTrackingInput = {
  orderId: string; fulfillmentId: string; actorId: string; requestKey: string;
  carrier: ShippingCarrierId; trackingNumber: string; notifyCustomer: boolean;
};
export type UpdateTrackingResult = { trackingChangeId: string; trackingVersion: number; replayed: boolean };
export type MarkDeliveredInput = {
  orderId: string; fulfillmentId: string; actorId: string; requestKey: string; deliveredOn: string; notifyCustomer: boolean;
};
export type MarkDeliveredResult = { eventId: string; deliveredAt: string; replayed: boolean };
export type TrackingClaim = {
  fulfillmentId: string; trackingVersion: number; carrier: ShippingCarrierId; trackingNumber: string;
  action: TrackingAction; leaseToken: string; signalRevision: number; attempts: number; readAttempts: number; expiresAt: string;
};
export type RegistrationOutcome = 'registered' | 'invalid_number' | 'transient' | 'account' | 'retrack_exhausted';
export type DeliveryReadResult = {
  outcome: 'ok' | 'not_found' | 'not_registered' | 'invalid_number' | 'transient' | 'account'; status: DeliveryStatus | null;
  providerStatus: string | null; providerSubStatus: string | null; happenedAt: string | null;
  deliveredAt: string | null; readAt: string; errorCode: string | null;
};
export type TrackingSignal = { carrier: 100062 | 100040 | 10021; number: string; event: 'TRACKING_UPDATED' | 'TRACKING_STOPPED' };
export type CustomerDelivery = { status: DeliveryStatus; statusAt: string; events: Array<{ status: DeliveryStatus; happenedAt: string }> };
export type DeliveryCallResult<T> = { kind: 'ok'; data: T } | { kind: 'blocked' | 'refused'; message: string } | { kind: 'unknown' };
