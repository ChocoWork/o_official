const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import { callReturnApi, fetchReturnData } from '@/lib/orders/returns/return-client';

const RETURNS_URL = '/api/admin/orders/order-1/returns';
const FALLBACK = '返品の情報を読み込めませんでした。';
/** 回数の制限（429）で断られた時の文。E-2 の refund-messages と同じ物 */
const RATE_LIMITED = '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('fetchReturnData', () => {
  it('窓口を GET で読み、答えの包み（data）の中身を返す', async () => {
    const data = { returns: [], canRefund: true, returnableUnits: 3, refundableAmount: 1000, refundableShipping: 0 };
    mockClientFetch.mockResolvedValueOnce(json({ data }));

    const result = await fetchReturnData<typeof data>(RETURNS_URL, FALLBACK);

    expect(mockClientFetch).toHaveBeenCalledWith(RETURNS_URL, { cache: 'no-store' });
    expect(result).toEqual({ kind: 'ok', data });
  });

  it.each([
    [400, { error: '入力を確かめてください。', code: 'RETURN_ARGUMENT_INVALID' }, '入力を確かめてください。'],
    [404, { error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' }, '返品が見つかりません。'],
    [409, { error: 'この注文は返品を作れません。', code: 'ORDER_NOT_RETURNABLE' }, 'この注文は返品を作れません。'],
  ])('%i は窓口が返した日本語の文をそのまま返す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));

    await expect(fetchReturnData(RETURNS_URL, FALLBACK)).resolves.toEqual({ kind: 'error', message });
  });

  it.each([
    [401, { error: 'Unauthorized' }, '認証が必要です。再ログインしてください。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [429, { error: 'Too many requests' }, RATE_LIMITED],
  ])('%i は窓口の英語の文を出さず、固定の文にする', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));

    await expect(fetchReturnData(RETURNS_URL, FALLBACK)).resolves.toEqual({ kind: 'error', message });
  });

  it.each([500, 502, 503])('%i は代わりの文にする', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: '返品の記録に失敗しました。', code: 'failed' }, status));

    await expect(fetchReturnData(RETURNS_URL, FALLBACK)).resolves.toEqual({ kind: 'error', message: FALLBACK });
  });

  it('窓口の文が無い・文字でない・長すぎる・読めない時は、代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ error: 42 }, 409))
      .mockResolvedValueOnce(json({ error: 'あ'.repeat(201) }, 409))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response);

    for (let index = 0; index < 4; index += 1) {
      await expect(fetchReturnData(RETURNS_URL, FALLBACK)).resolves.toEqual({ kind: 'error', message: FALLBACK });
    }
  });

  it('通信が切れても例外にせず、代わりの文を返す', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetchReturnData(RETURNS_URL, FALLBACK)).resolves.toEqual({ kind: 'error', message: FALLBACK });
  });

  it('成功なのに答えを読めない・中身（data）が無い時も、代わりの文を返す', async () => {
    mockClientFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } } as unknown as Response)
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ data: null }))
      .mockResolvedValueOnce(json(null));

    for (let index = 0; index < 4; index += 1) {
      await expect(fetchReturnData(RETURNS_URL, FALLBACK)).resolves.toEqual({ kind: 'error', message: FALLBACK });
    }
  });
});

describe('callReturnApi', () => {
  const RECEIVE_URL = '/api/admin/returns/ret-1/receive';
  const BODY = { requestKey: '11111111-1111-4111-8111-111111111111' };

  it('POST で送り、成功の本文をそのまま返す', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { receiptId: 'receipt-1' } }));

    await expect(callReturnApi(RECEIVE_URL, BODY, FALLBACK)).resolves.toEqual({ kind: 'ok', body: { data: { receiptId: 'receipt-1' } } });
    expect(mockClientFetch).toHaveBeenCalledWith(RECEIVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
    });
  });

  it.each([401, 403, 429])('%i は処理の前の断り（blocked）', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x' }, status));

    await expect(callReturnApi(RECEIVE_URL, BODY, FALLBACK)).resolves.toMatchObject({ kind: 'blocked' });
  });

  it('受け取りの番号つきの 422・409 は、記号と番号を付けた refused にする（受け取りは記録済み）', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected', refundId: 'f', receiptId: 'receipt-1' }, 422))
      .mockResolvedValueOnce(json({ error: 'この注文は返金できません。', code: 'order_not_refundable', receiptId: 'receipt-1' }, 409));

    await expect(callReturnApi(RECEIVE_URL, BODY, FALLBACK)).resolves.toEqual({
      kind: 'refused', message: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected', receiptId: 'receipt-1',
    });
    await expect(callReturnApi(RECEIVE_URL, BODY, FALLBACK)).resolves.toEqual({
      kind: 'refused', message: 'この注文は返金できません。', code: 'order_not_refundable', receiptId: 'receipt-1',
    });
  });

  it('受け取りの番号の無い断りは receiptId が null', async () => {
    const message = '返品の状態が変わりました。画面を開き直してください。';
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'RETURN_STATE_CONFLICT' }, 409));

    await expect(callReturnApi(RECEIVE_URL, BODY, FALLBACK)).resolves.toEqual({
      kind: 'refused', message, code: 'RETURN_STATE_CONFLICT', receiptId: null,
    });
  });

  it('通信が切れた・500 番台・読めない成功は unknown', async () => {
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'x' }, 502))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response);

    for (let index = 0; index < 3; index += 1) {
      await expect(callReturnApi(RECEIVE_URL, BODY, FALLBACK)).resolves.toEqual({ kind: 'unknown' });
    }
  });
});

