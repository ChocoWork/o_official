import type { DeliveryStatus } from '@/lib/orders/tracking/delivery-types';

export const SEVENTEEN_TRACK_CARRIERS = { yamato: 100062, sagawa: 100040, japanpost: 10021 } as const;

const PRIMARY_STATUSES = new Map<string, DeliveryStatus | 'not_found'>([
  ['InfoReceived', 'confirmed'], ['NotFound', 'not_found'], ['InTransit', 'in_transit'],
  ['OutForDelivery', 'out_for_delivery'], ['AvailableForPickup', 'ready_for_pickup'],
  ['Delivered', 'delivered'], ['Expired', 'delayed'],
]);
const EXCEPTION_STATUSES = new Map<string, DeliveryStatus>([
  ['Exception_Delayed', 'delayed'],
  ['Exception_Returning', 'failure'], ['Exception_Returned', 'failure'], ['Exception_Lost', 'failure'],
  ['Exception_Damage', 'failure'], ['Exception_Rejected', 'failure'], ['Exception_NoBody', 'failure'],
  ['Exception_Security', 'failure'], ['Exception_Destroyed', 'failure'], ['Exception_Cancel', 'failure'],
  ['Exception_Other', 'failure'],
]);
const DELIVERY_FAILURE_STATUSES = new Map<string, DeliveryStatus>([
  ['DeliveryFailure_NoBody', 'attempted_delivery'], ['DeliveryFailure_Other', 'attempted_delivery'],
  ['DeliveryFailure_Security', 'failure'], ['DeliveryFailure_Rejected', 'failure'], ['DeliveryFailure_InvalidAddress', 'failure'],
]);

/** 未知の細かい状況は、対応する主の値との組が分かるまで現在値を保つ。 */
export function mapSeventeenTrackStatus(status: string, subStatus: string | null): DeliveryStatus | 'not_found' | null {
  if (status === 'Exception') return EXCEPTION_STATUSES.get(subStatus ?? '') ?? null;
  if (status === 'DeliveryFailure') return DELIVERY_FAILURE_STATUSES.get(subStatus ?? '') ?? null;
  return PRIMARY_STATUSES.get(status) ?? null;
}
