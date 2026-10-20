const mockClientFetch = jest.fn();
const mockRefreshSession = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
  refreshSessionOnce: (...args: unknown[]) => mockRefreshSession(...args),
}));

import {
  callCustomerReturnApi,
  fetchCustomerReturnMaterials,
  submitCustomerReturnRequest,
} from '@/features/account/returns/customer-return-client';
import { ORDER_ID, materials } from './return-request-fixtures';

const LOAD_FAILED = 'お申し込みの画面を読み込めませんでした。時間をおいて、もう一度お試しください。';
const FAILURE = 'お申し込みを受け付けられませんでした。時間をおいて、もう一度お試しください。';
const RATE_LIMITED = 'しばらくしてから、もう一度お試しください。';
const REQUEST_URL = `/api/orders/${ORDER_ID}/return-request`;
const BODY = { requestKey: 'key-1', lines: [] };

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 本文が読めない答え（HTML の誤りページなど） */
function unreadable(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Response;
}

beforeEach(() => {
  mockClientFetch.mockReset();
  mockRefreshSession.mockReset();
});

describe('fetchCustomerReturnMaterials', () => {
  it('申し込みの材料を no-store で読み、答えの data を返す', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: materials() }));

    await expect(fetchCustomerReturnMaterials(ORDER_ID)).resolves.toEqual({ kind: 'ok', data: materials() });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith(REQUEST_URL, { cache: 'no-store' });
  });

  it('注文の番号は URL に使える形にして呼ぶ', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: materials() }));

    await fetchCustomerReturnMaterials('a/b?c');

    expect(mockClientFetch).toHaveBeenCalledWith('/api/orders/a%2Fb%3Fc/return-request', { cache: 'no-store' });
  });

  it('404（注文が無い・持ち主でない・お客様に隠す状態）は notFound を真にする', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Order not found' }, 404));

    await expect(fetchCustomerReturnMaterials(ORDER_ID)).resolves.toEqual({ kind: 'error', message: LOAD_FAILED, notFound: true });
  });

  it.each([401, 403, 429, 500, 502])('%i は読み込めなかった文を返す（notFound は偽）', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x' }, status));

    await expect(fetchCustomerReturnMaterials(ORDER_ID)).resolves.toEqual({ kind: 'error', message: LOAD_FAILED, notFound: false });
  });

  it.each([
    ['data が無い', json({})],
    ['data が null', json({ data: null })],
    ['答えが null', json(null)],
    ['答えが読めない', unreadable(200)],
  ])('成功でも%sなら、読み込めなかった文を返す', async (_label, response) => {
    mockClientFetch.mockResolvedValueOnce(response);

    await expect(fetchCustomerReturnMaterials(ORDER_ID)).resolves.toEqual({ kind: 'error', message: LOAD_FAILED, notFound: false });
  });

  it('通信が切れても例外にせず、読み込めなかった文を返す', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetchCustomerReturnMaterials(ORDER_ID)).resolves.toEqual({ kind: 'error', message: LOAD_FAILED, notFound: false });
  });
});

describe('submitCustomerReturnRequest', () => {
  it('申し込みの窓口へ JSON で POST する', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnId: 'ret-1', number: 1, label: 'x', replayed: false } }));

    await submitCustomerReturnRequest(ORDER_ID, BODY);

    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith(REQUEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(BODY),
    });
  });

  it('成功は、窓口の答えをそのまま ok で返す', async () => {
    const answer = { data: { returnId: 'ret-1', number: 3, label: 'ORD-A1B2C3D4-R3', replayed: true } };
    mockClientFetch.mockResolvedValueOnce(json(answer));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'ok', body: answer });
  });

  it.each([
    [429, RATE_LIMITED],
    [401, FAILURE],
    [403, FAILURE],
  ])('処理に入る前の断り %i は blocked（二重防止の番号を保つ分類。401 は印を新しくできなかった時）', async (status, message) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Too many requests' }, status));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'blocked', message });
  });

  it('窓口が断った（400・409）時は refused。画面の言葉は窓口の文ではなく記号から C-4 のお客様の言葉を引く', async () => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Quantity exceeds', code: 'RETURN_QUANTITY_EXCEEDS' }, 409));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused',
      message: 'お申し込みいただける数を超えています。画面を開き直してください。',
      code: 'RETURN_QUANTITY_EXCEEDS',
      invalidPhotoUploadIds: [],
    });
  });

  it('写真が合わない断りは、合わない写真の送り先の番号を文字だけ拾って返す', async () => {
    mockClientFetch.mockResolvedValueOnce(
      json({ error: 'x', code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: ['up-2', 3, null, 'up-4'] }, 400),
    );

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused',
      message: '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。',
      code: 'RETURN_PHOTO_INVALID',
      invalidPhotoUploadIds: ['up-2', 'up-4'],
    });
  });

  it('記号の無い断り（404 の Order not found）と、表に無い記号・本文が読めない断りは、想定外の失敗の言葉にする', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Order not found' }, 404))
      .mockResolvedValueOnce(json({ error: 'x', code: 'SOMETHING_NEW' }, 409))
      .mockResolvedValueOnce(unreadable(400));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused', message: FAILURE, code: null, invalidPhotoUploadIds: [],
    });
    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused', message: FAILURE, code: 'SOMETHING_NEW', invalidPhotoUploadIds: [],
    });
    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({
      kind: 'refused', message: FAILURE, code: null, invalidPhotoUploadIds: [],
    });
  });

  it.each(['toString', 'constructor', '__proto__'])('記号が Object の名前（%s）でも、表に無い記号として扱う', async (code) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x', code }, 409));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toMatchObject({ kind: 'refused', message: FAILURE, code });
  });

  it.each([500, 502, 503])('%i は答えが分からない（unknown）。申し込みは記録されたかもしれない', async (status) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: FAILURE }, status));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'unknown' });
  });

  it('通信が切れた時と、成功なのに答えが読めない時も unknown', async () => {
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(unreadable(200));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'unknown' });
    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('callCustomerReturnApi', () => {
  it('ほかの窓口（キャンセルの申し込み）にも同じ4分類で使える', async () => {
    mockClientFetch
      .mockResolvedValueOnce(json({ data: { cancelRequestId: 'cr-1', replayed: false } }))
      .mockResolvedValueOnce(json({ error: 'x', code: 'CANCEL_REQUEST_EXISTS' }, 409));

    await expect(callCustomerReturnApi(`/api/orders/${ORDER_ID}/cancel-request`, { requestKey: 'k' })).resolves.toEqual({
      kind: 'ok',
      body: { data: { cancelRequestId: 'cr-1', replayed: false } },
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(1, `/api/orders/${ORDER_ID}/cancel-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKey: 'k' }),
    });
    await expect(callCustomerReturnApi(`/api/orders/${ORDER_ID}/cancel-request`, { requestKey: 'k' })).resolves.toEqual({
      kind: 'refused',
      message: 'キャンセルのお申し込みは、すでに受け付けています。',
      code: 'CANCEL_REQUEST_EXISTS',
      invalidPhotoUploadIds: [],
    });
  });
});

describe('401（ログインの印が古い）', () => {
  const answer = { data: { returnId: 'ret-1', number: 1, label: 'ORD-A1B2C3D4-R1', replayed: false } };

  it('印を新しくできたら、同じ中身で1回だけ送り直し、その答えを返す', async () => {
    mockRefreshSession.mockResolvedValueOnce('refreshed');
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401)).mockResolvedValueOnce(json(answer));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'ok', body: answer });
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(mockClientFetch.mock.calls[1]).toEqual(mockClientFetch.mock.calls[0]);
  });

  it.each(['expired', 'unavailable'])('印を新しくできない（%s）時は送り直さず、blocked にする', async (outcome) => {
    mockRefreshSession.mockResolvedValueOnce(outcome);
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'blocked', message: FAILURE });
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('送り直しもまた 401 なら blocked にする（送り直しは1回だけ）', async () => {
    mockRefreshSession.mockResolvedValueOnce('refreshed');
    mockClientFetch.mockResolvedValue(json({ error: 'Unauthorized' }, 401));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'blocked', message: FAILURE });
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  it('送り直しの通信が切れたら unknown にする（送り直しは処理に入ったかもしれない）', async () => {
    mockRefreshSession.mockResolvedValueOnce('refreshed');
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401)).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(submitCustomerReturnRequest(ORDER_ID, BODY)).resolves.toEqual({ kind: 'unknown' });
  });
});
