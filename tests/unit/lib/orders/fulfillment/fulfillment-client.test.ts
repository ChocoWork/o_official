const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import {
  callFulfillmentApi,
  clampQuantity,
  fetchFulfillmentMaterials,
  lineLabel,
} from '@/lib/orders/fulfillment/fulfillment-client';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('callFulfillmentApi', () => {
  it('本文を JSON で POST し、成功の答えをそのまま返す', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ fulfillmentId: 'f-1', number: 1 }));

    const result = await callFulfillmentApi<{ fulfillmentId: string }>('/api/x', { requestKey: 'k' }, '失敗');

    expect(mockClientFetch).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKey: 'k' }),
    });
    expect(result).toEqual({ kind: 'ok', body: { fulfillmentId: 'f-1', number: 1 } });
  });

  it('本文が無い取消の呼び出しは、headers も body も付けない', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ outcome: 'cancelled' }));

    await callFulfillmentApi('/api/cancel', undefined, '失敗');

    expect(mockClientFetch).toHaveBeenCalledWith('/api/cancel', { method: 'POST' });
  });

  it.each([500, 502, 503])('%i は「記録されたか分からない」にする', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, status));

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信が切れた時は「記録されたか分からない」にする', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it('成功なのに答えを読めない時も「記録されたか分からない」にする（窓口は記録している）', async () => {
    mockClientFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([
    [400, '入力を確かめてください。'],
    [404, '注文が見つかりません。'],
    [409, '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
  ])('%i は窓口が返した日本語の文をそのまま返す', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'x' }, status));

    await expect(callFulfillmentApi('/api/x', {}, '失敗')).resolves.toEqual({ kind: 'refused', message });
  });

  it('窓口の文が無い・文字でない・長すぎる時は、代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ error: 42 }, 409))
      .mockResolvedValueOnce(json({ error: 'あ'.repeat(201) }, 409))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response);

    for (let index = 0; index < 4; index += 1) {
      await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({ kind: 'refused', message: '代わりの文' });
    }
  });

  it('401・403 は固定の文、回数の制限（429）など共通の守りの英語の文は出さずに代わりの文にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));

    await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({
      kind: 'refused',
      message: '認証が必要です。再ログインしてください。',
    });
    await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({
      kind: 'refused',
      message: 'この操作の権限がありません。',
    });
    await expect(callFulfillmentApi('/api/x', {}, '代わりの文')).resolves.toEqual({ kind: 'refused', message: '代わりの文' });
  });
});

describe('fetchFulfillmentMaterials', () => {
  it('発送の材料の窓口を読み、そのまま返す', async () => {
    const materials = { order: { id: ORDER_ID }, blockedReason: null, lines: [], fulfillments: [] };
    mockClientFetch.mockResolvedValueOnce(json(materials));

    const result = await fetchFulfillmentMaterials(ORDER_ID);

    expect(mockClientFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/fulfillments`, { cache: 'no-store' });
    expect(result).toEqual({ ok: true, materials });
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '発送の材料を読み込めませんでした。'],
    [429, { error: 'Too many requests' }, '発送の材料を読み込めませんでした。'],
  ])('%i の時は画面に出す文を返す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));

    await expect(fetchFulfillmentMaterials(ORDER_ID)).resolves.toEqual({ ok: false, message });
  });

  it('通信が切れても例外にせず、読めなかった文を返す', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetchFulfillmentMaterials(ORDER_ID)).resolves.toEqual({
      ok: false,
      message: '発送の材料を読み込めませんでした。',
    });
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
