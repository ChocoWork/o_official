const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import { submitManualDelivered, submitTrackingEdit } from '@/lib/orders/tracking/delivery-client';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENT_ID = 'f1f1f1f1-1111-2222-8333-444455556666';
const REQUEST_KEY = '11111111-2222-4333-8444-555555555555';
const TRACKING_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/tracking`;
const DELIVERED_URL = `/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/delivered`;

const TRACKING_BODY = { requestKey: REQUEST_KEY, carrier: 'sagawa', trackingNumber: 'AB-123', notifyCustomer: true } as const;
const DELIVERED_BODY = { requestKey: REQUEST_KEY, deliveredOn: '2026-10-21', notifyCustomer: false } as const;
const TRACKING_DATA = { trackingChangeId: 'change-1', trackingVersion: 2, replayed: false };
const DELIVERED_DATA = { eventId: 'event-1', deliveredAt: '2026-10-21T03:00:00.000Z', replayed: true };
const FALLBACK = '入力を確かめてください。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function unreadable(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('submitTrackingEdit', () => {
  it('窓口へ JSON で POST し、成功の data を返す。本文はC-3の4項目だけを送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: TRACKING_DATA }));

    const result = await submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY);

    expect(mockClientFetch).toHaveBeenCalledWith(TRACKING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TRACKING_BODY),
    });
    expect(result).toEqual({ kind: 'ok', data: TRACKING_DATA });
  });

  it('前の結果の再送（replayed: true）も成功として返す', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { ...TRACKING_DATA, replayed: true } }));

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({
      kind: 'ok',
      data: { ...TRACKING_DATA, replayed: true },
    });
  });

  it('答えの data は名指しの3項目だけを写し、余計な項目は渡さない', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { ...TRACKING_DATA, secret: 'x' }, other: 1 }));

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({ kind: 'ok', data: TRACKING_DATA });
  });

  it.each([500, 502, 503])('%i は「記録されたか分からない」にする', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: '配送の記録を保存できませんでした。' }, status));

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信が切れた時は「記録されたか分からない」にする', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([
    ['読めない成功の本文', unreadable(200)],
    ['data が無い', json({})],
    ['data が object でない', json({ data: 'ok' })],
    ['trackingChangeId が文字でない', json({ data: { ...TRACKING_DATA, trackingChangeId: 1 } })],
    ['trackingVersion が数でない', json({ data: { ...TRACKING_DATA, trackingVersion: '2' } })],
    ['replayed が boolean でない', json({ data: { ...TRACKING_DATA, replayed: 'false' } })],
  ])('成功なのに答えが読めない・形が違う（%s）時も「記録されたか分からない」にする', async (_label, response) => {
    mockClientFetch.mockResolvedValueOnce(response);

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, 'しばらくしてから、もう一度お試しください。'],
  ])('%i は処理の前の断り（blocked）で、窓口の英語の文は出さず固定の文にする', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Forbidden: csrf' }, status));

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({ kind: 'blocked', message });
  });

  it.each([
    [400, '入力を確かめてください。'],
    [404, '発送の記録が見つかりません。'],
    [409, '配送業者か伝票番号を直してください。'],
  ])('%i は窓口が返した日本語の文をそのまま返す（refused）', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'X' }, status));

    await expect(submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY)).resolves.toEqual({ kind: 'refused', message });
  });

  it('窓口の文が無い・文字でない・長すぎる・読めない時は、代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ error: 42 }, 409))
      .mockResolvedValueOnce(json({ error: 'あ'.repeat(201) }, 409))
      .mockResolvedValueOnce(unreadable(409))
      .mockResolvedValueOnce(json({ error: '誤り' }, 422));

    for (let index = 0; index < 5; index += 1) {
      const result = await submitTrackingEdit(ORDER_ID, FULFILLMENT_ID, TRACKING_BODY);
      expect(result).toEqual(index === 4 ? { kind: 'refused', message: '誤り' } : { kind: 'refused', message: FALLBACK });
    }
  });
});

describe('submitManualDelivered', () => {
  it('配達済みの窓口へ JSON で POST し、成功の data を返す。本文はC-3の3項目だけを送る', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: DELIVERED_DATA }));

    const result = await submitManualDelivered(ORDER_ID, FULFILLMENT_ID, DELIVERED_BODY);

    expect(mockClientFetch).toHaveBeenCalledWith(DELIVERED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DELIVERED_BODY),
    });
    expect(result).toEqual({ kind: 'ok', data: DELIVERED_DATA });
  });

  it.each([500, 503])('%i は「記録されたか分からない」にする', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({}, status));

    await expect(submitManualDelivered(ORDER_ID, FULFILLMENT_ID, DELIVERED_BODY)).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信切れ・読めない成功・形が違う成功は「記録されたか分からない」にする', async () => {
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(unreadable(200))
      .mockResolvedValueOnce(json({ data: { ...DELIVERED_DATA, deliveredAt: 5 } }))
      .mockResolvedValueOnce(json({ data: { ...DELIVERED_DATA, eventId: null } }))
      .mockResolvedValueOnce(json({ data: { ...DELIVERED_DATA, replayed: 1 } }));

    for (let index = 0; index < 5; index += 1) {
      await expect(submitManualDelivered(ORDER_ID, FULFILLMENT_ID, DELIVERED_BODY)).resolves.toEqual({ kind: 'unknown' });
    }
  });

  it.each([
    [401, 'blocked', '認証が必要です。再ログインしてください。'],
    [403, 'blocked', 'この操作の権限がありません。'],
    [429, 'blocked', 'しばらくしてから、もう一度お試しください。'],
    [400, 'refused', '届いた日は、発送の日から今日までの日を選んでください。'],
    [404, 'refused', '発送の記録が見つかりません。'],
    [409, 'refused', 'すでに配達済みです。履歴を読み直してください。'],
  ])('%i は %s として文を返す', async (status, kind, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: kind === 'blocked' ? 'Too many requests' : message }, status));

    await expect(submitManualDelivered(ORDER_ID, FULFILLMENT_ID, DELIVERED_BODY)).resolves.toEqual({ kind, message });
  });
});
