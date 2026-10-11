const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import { callRefundApi, fetchRefundMaterials } from '@/lib/orders/refund/refund-client';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const UNKNOWN_OUTCOME = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('callRefundApi', () => {
  it('本文を JSON で POST し、成功の答えをそのまま返す', async () => {
    const accepted = { refundId: 'refund-1', status: 'pending', amount: 800, replayed: false };
    mockClientFetch.mockResolvedValueOnce(json(accepted));

    const result = await callRefundApi<typeof accepted>('/api/x', { requestKey: 'k' }, '失敗');

    expect(mockClientFetch).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKey: 'k' }),
    });
    expect(result).toEqual({ kind: 'ok', body: accepted });
  });

  it.each([
    [500, { error: '返金の記録に失敗しました。', code: 'failed' }],
    [502, { error: UNKNOWN_OUTCOME, code: 'unknown_outcome', refundId: 'refund-1' }],
    [503, { error: 'Service Unavailable' }],
  ])('%i は「返金を頼んだか分からない」にする（窓口の文は使わない）', async (status, body) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));

    await expect(callRefundApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信が切れた時は「返金を頼んだか分からない」にする', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(callRefundApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it('成功なのに答えを読めない時も「返金を頼んだか分からない」にする（窓口は記録している）', async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    await expect(callRefundApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([
    [400, '入力を確かめてください。'],
    [404, '注文が見つかりません。'],
    [409, '返せる額を超えています。'],
    [422, 'Stripe が返金を受け付けませんでした（カードが使えません）。'],
  ])('%i は窓口が返した日本語の文をそのまま返す', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'x' }, status));

    await expect(callRefundApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'refused', message });
  });

  it('窓口の文が無い・文字でない・長すぎる・読めない時は、代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ error: 42 }, 409))
      .mockResolvedValueOnce(json({ error: 'あ'.repeat(201) }, 409))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response);

    for (let index = 0; index < 4; index += 1) {
      await expect(callRefundApi('/api/x', {}, '代わりの文')).resolves.toEqual({ kind: 'refused', message: '代わりの文' });
    }
  });

  it('401・403 は固定の文、回数の制限（429）など共通の守りの英語の文は出さずに代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));

    await expect(callRefundApi('/api/x', {}, '代わりの文')).resolves.toEqual({
      kind: 'refused',
      message: '認証が必要です。再ログインしてください。',
    });
    await expect(callRefundApi('/api/x', {}, '代わりの文')).resolves.toEqual({
      kind: 'refused',
      message: 'この操作の権限がありません。',
    });
    await expect(callRefundApi('/api/x', {}, '代わりの文')).resolves.toEqual({ kind: 'refused', message: '代わりの文' });
  });
});

describe('fetchRefundMaterials', () => {
  it('返金の材料の窓口を読み、そのまま返す', async () => {
    const materials = { order: { id: ORDER_ID }, lines: [], awaitingRefund: null };
    mockClientFetch.mockResolvedValueOnce(json(materials));

    const result = await fetchRefundMaterials(ORDER_ID);

    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/refund`, { cache: 'no-store' });
    expect(result).toEqual({ kind: 'ok', materials });
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '返金の材料を読み込めませんでした。'],
    [429, { error: 'Too many requests' }, '返金の材料を読み込めませんでした。'],
  ])('%i の時は画面に出す文を返す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));

    await expect(fetchRefundMaterials(ORDER_ID)).resolves.toEqual({ kind: 'error', message });
  });

  it('通信が切れても例外にせず、読めなかった文を返す', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetchRefundMaterials(ORDER_ID)).resolves.toEqual({
      kind: 'error',
      message: '返金の材料を読み込めませんでした。',
    });
  });

  it('成功なのに答えを読めない時も、読めなかった文を返す', async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    await expect(fetchRefundMaterials(ORDER_ID)).resolves.toEqual({
      kind: 'error',
      message: '返金の材料を読み込めませんでした。',
    });
  });
});
