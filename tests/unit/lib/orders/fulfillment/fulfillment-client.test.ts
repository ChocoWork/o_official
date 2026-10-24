const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import {
  callFulfillmentApi,
  clampQuantity,
  fetchFulfillmentMaterials,
  lineLabel,
} from '@/lib/orders/fulfillment/fulfillment-client';
import {
  LEGACY_FULFILLMENT_DISABLED_TEXT,
  MANUAL_COMPLETION_DISABLED_TEXT,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

beforeEach(() => {
  mockClientFetch.mockReset();
});

// G-1 Task 15: 旧の発送・仕上がり・取消・発送の材料の窓口は止めた（410）。画面の道具は窓口を呼ばずに固定の停止の文で断る
describe('callFulfillmentApi（G-1 で停止）', () => {
  it.each([
    [`/api/admin/orders/${ORDER_ID}/fulfillments`, { requestKey: 'k' }],
    [`/api/admin/orders/${ORDER_ID}/fulfillments/f-1/cancel`, undefined],
  ])('発送の窓口 %s は窓口を呼ばず、発送の停止の文で断る', async (url, body) => {
    await expect(callFulfillmentApi(url, body, '失敗')).resolves.toEqual({ kind: 'refused', message: LEGACY_FULFILLMENT_DISABLED_TEXT });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it.each([
    [`/api/admin/orders/${ORDER_ID}/completions`, { requestKey: 'k', lines: [] }],
    [`/api/admin/orders/${ORDER_ID}/completions/c-1/cancel`, undefined],
  ])('仕上がりの窓口 %s は窓口を呼ばず、手動の仕上がりの停止の文で断る', async (url, body) => {
    await expect(callFulfillmentApi(url, body, '失敗')).resolves.toEqual({ kind: 'refused', message: MANUAL_COMPLETION_DISABLED_TEXT });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('fetchFulfillmentMaterials（G-1 で停止）', () => {
  it('発送の材料の窓口を呼ばず、発送の停止の文を返す', async () => {
    await expect(fetchFulfillmentMaterials(ORDER_ID)).resolves.toEqual({ ok: false, message: LEGACY_FULFILLMENT_DISABLED_TEXT });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});

describe('lineLabel', () => {
  it('色とサイズを括弧に入れる。片方だけでも、どちらも無くても崩れない', () => {
    expect(lineLabel({ name: 'シルクブラウス', color: '白', size: 'M' })).toBe('シルクブラウス（白 / M）');
    expect(lineLabel({ name: 'シルクブラウス', color: null, size: 'M' })).toBe('シルクブラウス（M）');
    expect(lineLabel({ name: 'シルクブラウス', color: '白', size: null })).toBe('シルクブラウス（白）');
    expect(lineLabel({ name: 'シルクブラウス', color: null, size: null })).toBe('シルクブラウス');
  });
});

describe('clampQuantity', () => {
  it.each([
    ['2', 5, 2],
    ['9', 5, 5],
    ['0', 5, 0],
    ['-3', 5, 0],
    ['', 5, 0],
    ['abc', 5, 0],
    ['1.9', 5, 1],
    ['3', 0, 0],
  ])('%j（上限 %i）は %i にする', (raw, max, expected) => {
    expect(clampQuantity(raw, max)).toBe(expected);
  });
});
