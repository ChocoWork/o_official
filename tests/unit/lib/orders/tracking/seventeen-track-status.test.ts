import {
  mapSeventeenTrackStatus,
  SEVENTEEN_TRACK_CARRIERS,
} from '@/lib/orders/tracking/seventeen-track-status';

// Task 4 の対応表を全行固定する。細かい状況だけで主の値を飛び越えない。
const STATUS_CASES = [
  ['InfoReceived', null, 'confirmed'],
  ['InfoReceived', 'InfoReceived', 'confirmed'],
  ['InfoReceived', 'FutureSub', 'confirmed'],
  ['NotFound', null, 'not_found'],
  ['NotFound', 'FutureSub', 'not_found'],
  ['InTransit', null, 'in_transit'],
  ['InTransit', 'InTransit_PickedUp', 'in_transit'],
  ['InTransit', 'InTransit_Other', 'in_transit'],
  ['InTransit', 'FutureSub', 'in_transit'],
  ['InTransit', 'Exception_Lost', 'in_transit'],
  ['OutForDelivery', null, 'out_for_delivery'],
  ['OutForDelivery', 'FutureSub', 'out_for_delivery'],
  ['DeliveryFailure', 'DeliveryFailure_NoBody', 'attempted_delivery'],
  ['DeliveryFailure', 'DeliveryFailure_Other', 'attempted_delivery'],
  ['AvailableForPickup', null, 'ready_for_pickup'],
  ['AvailableForPickup', 'FutureSub', 'ready_for_pickup'],
  ['Delivered', null, 'delivered'],
  ['Delivered', 'FutureSub', 'delivered'],
  ['Exception', 'Exception_Delayed', 'delayed'],
  ['Expired', null, 'delayed'],
  ['Expired', 'FutureSub', 'delayed'],
  ['Exception', 'Exception_Returning', 'failure'],
  ['Exception', 'Exception_Returned', 'failure'],
  ['Exception', 'Exception_Lost', 'failure'],
  ['Exception', 'Exception_Damage', 'failure'],
  ['Exception', 'Exception_Rejected', 'failure'],
  ['Exception', 'Exception_NoBody', 'failure'],
  ['Exception', 'Exception_Security', 'failure'],
  ['Exception', 'Exception_Destroyed', 'failure'],
  ['Exception', 'Exception_Cancel', 'failure'],
  ['Exception', 'Exception_Other', 'failure'],
  ['DeliveryFailure', 'DeliveryFailure_Security', 'failure'],
  ['DeliveryFailure', 'DeliveryFailure_Rejected', 'failure'],
  ['DeliveryFailure', 'DeliveryFailure_InvalidAddress', 'failure'],
  ['Exception', 'Exception_Future', null],
  ['Exception', null, null],
  ['DeliveryFailure', 'DeliveryFailure_Future', null],
  ['DeliveryFailure', null, null],
  ['NewStatus', 'NewSub', null],
  ['NewStatus', 'Exception_Lost', null],
  ['Exception', 'DeliveryFailure_NoBody', null],
  ['DeliveryFailure', 'Exception_Lost', null],
  ['', null, null],
] as const;

describe('17TRACK の状況の対応', () => {
  test.each(STATUS_CASES)('%s / %s → %s', (status, subStatus, expected) => {
    expect(mapSeventeenTrackStatus(status, subStatus)).toBe(expected);
  });

  test('未知のprovider状態をfailureへ推測しない', () => {
    expect(mapSeventeenTrackStatus('NewStatus', 'NewSub')).toBeNull();
  });

  test('運送会社の番号は承認した3社だけ', () => {
    expect(SEVENTEEN_TRACK_CARRIERS).toEqual({ yamato: 100062, sagawa: 100040, japanpost: 10021 });
  });
});
