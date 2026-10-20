const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import { submitCustomerCancelRequest, submitCustomerReturnRequest } from '@/features/account/returns/customer-return-client';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const CANCEL_URL = `/api/orders/${ORDER_ID}/cancel-request`;
const RATE_LIMITED = 'しばらくしてから、もう一度お試しください。';
const BODY = {
  requestKey: '0f8fad5b-d9cb-469f-a165-70867728950e',
  lines: [{ orderItemId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', quantity: 2 }],
  customerNote: 'サイズが合わなかったため',
};

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// 4つの答えの分け方そのものは Task 9 の customer-return-client.test.ts が確かめる。ここは、キャンセルの申し込みの窓口に
// つないだ所（URL・本文・キャンセルの申し込みで出る断りの言葉）を確かめる
describe('submitCustomerCancelRequest（キャンセルのお申し込みの窓口を呼ぶ）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  it('窓口 /api/orders/{id}/cancel-request へ中身を JSON で POST し、成功の答えをそのまま返す', async () => {
    const answer = { data: { cancelRequestId: 'cr-1', replayed: false } };
    mockClientFetch.mockResolvedValueOnce(json(answer));

    await expect(submitCustomerCancelRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'ok', body: answer });

    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith(CANCEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
    });
  });

  it('注文の番号は URL に使える形にして呼ぶ', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { cancelRequestId: 'cr-1', replayed: false } }));

    await submitCustomerCancelRequest('a/b?c', BODY);

    expect(mockClientFetch).toHaveBeenCalledWith('/api/orders/a%2Fb%3Fc/cancel-request', expect.objectContaining({ method: 'POST' }));
  });

  // キャンセルの申し込みの窓口が返しうる断り。窓口の文（英語のことがある）ではなく、記号から C-4 のお客様の言葉を引く
  const REFUSALS: Array<[string, number, string]> = [
    ['CANCEL_REQUEST_EXISTS', 409, 'キャンセルのお申し込みは、すでに受け付けています。'],
    ['CANCEL_REQUEST_NOT_ELIGIBLE', 409, 'この注文は、キャンセルのお申し込みを受け付けていません。'],
    ['CANCEL_REQUEST_QUANTITY_EXCEEDS', 409, 'お申し込みいただける数を超えています。画面を開き直してください。'],
    ['RETURN_REQUESTS_CLOSED', 409, '現在、キャンセルのお申し込みを受け付けていません。'],
    ['RETURN_REQUEST_MISMATCH', 409, 'お申し込みの内容が変わりました。画面を開き直してください。'],
    ['RETURN_ARGUMENT_INVALID', 400, '入力を確かめてください。'],
  ];

  it.each(REFUSALS)('窓口の断り %s（%i）は refused にし、お客様の言葉「%s」を返す', async (code, status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Conflict', code }, status));

    await expect(submitCustomerCancelRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused',
      message,
      code,
      invalidPhotoUploadIds: [],
    });
  });

  it('返品・交換の申し込みが受付オフで断られた時は、返品・交換の言葉を保つ', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Conflict', code: 'RETURN_REQUESTS_CLOSED' }, 409));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused',
      message: '現在、返品・交換のお申し込みを受け付けていません。',
      code: 'RETURN_REQUESTS_CLOSED',
      invalidPhotoUploadIds: [],
    });
  });

  it('回数の制限（429）は blocked にし、回数の制限の言葉を返す（二重防止の番号は保つ）', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));

    await expect(submitCustomerCancelRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'blocked', message: RATE_LIMITED });
  });

  it('サーバーが失敗した（500）時は unknown にする（受け付けられたかもしれないので、同じ番号・同じ中身で確かめ直す）', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'お申し込みを受け付けられませんでした。' }, 500));

    await expect(submitCustomerCancelRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信が切れた時は、例外にせず unknown にする', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(submitCustomerCancelRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'unknown' });
  });
});
