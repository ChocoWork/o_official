const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import { LEGACY_FULFILLMENT_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import { submitManualDelivered, submitTrackingEdit } from '@/lib/orders/tracking/delivery-client';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
const REQUEST_KEY = '11111111-2222-4333-8444-555555555555';

const TRACKING_BODY = { requestKey: REQUEST_KEY, carrier: 'sagawa', trackingNumber: 'AB-123', notifyCustomer: true } as const;
const DELIVERED_BODY = { requestKey: REQUEST_KEY, deliveredOn: '2026-10-21', notifyCustomer: false } as const;

beforeEach(() => {
  mockClientFetch.mockReset();
});

// G-1 Task 15: 伝票番号の訂正と手動の配達済みの窓口は止めた（410）。画面の道具は窓口を呼ばずに固定の停止の文で断る
describe('submitTrackingEdit（G-1 で停止）', () => {
  it('窓口を呼ばず、発送の停止の文で断る（refused）', async () => {
    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({
      kind: 'refused',
      message: LEGACY_FULFILLMENT_DISABLED_TEXT,
    });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('submitManualDelivered（G-1 で停止）', () => {
  it('窓口を呼ばず、発送の停止の文で断る（refused）', async () => {
    await expect(submitManualDelivered(ORDER_ID, FULFILLMENT_ID, DELIVERED_BODY)).resolves.toEqual({
      kind: 'refused',
      message: LEGACY_FULFILLMENT_DISABLED_TEXT,
    });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});
