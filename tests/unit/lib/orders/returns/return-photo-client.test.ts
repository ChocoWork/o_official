const mockClientFetch = jest.fn();
const mockRefreshSession = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
  refreshSessionOnce: (...args: unknown[]) => mockRefreshSession(...args),
}));

import {
  CUSTOMER_RETURN_ERROR_MESSAGES,
  CUSTOMER_RETURN_RATE_LIMITED_MESSAGE,
} from '@/lib/orders/returns/customer-return-messages';
import {
  RETURN_PHOTO_ACCEPT,
  RETURN_PHOTO_FILE_ERROR_MESSAGES,
  RETURN_PHOTO_JPEG_QUALITY,
  RETURN_PHOTO_MAX_EDGE,
  RETURN_PHOTO_MAX_SOURCE_BYTES,
  RETURN_PHOTO_UPLOAD_FAILED_MESSAGE,
  checkReturnPhotoFile,
  resizeReturnPhoto,
  uploadReturnPhoto,
} from '@/lib/orders/returns/return-photo-client';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// 試験用の決まった文字。本物の署名つきの送り先ではない
const SIGNED_URL = 'https://storage.example.test/put-target';
const FAILED = { kind: 'error', message: RETURN_PHOTO_UPLOAD_FAILED_MESSAGE };

/** size は本物の中身を作らずに決める（10MB の配列を作らない） */
function fileOf(type: string, size = 1024): File {
  const file = new File(['x'], 'photo', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('定数', () => {
  it('縮める前の上限は 10MB（10,000,000 バイト）、長い辺は 2000px、JPEG の品質は 0.85、選べるのは JPEG と PNG', () => {
    expect(RETURN_PHOTO_MAX_SOURCE_BYTES).toBe(10_000_000);
    expect(RETURN_PHOTO_MAX_EDGE).toBe(2000);
    expect(RETURN_PHOTO_JPEG_QUALITY).toBe(0.85);
    expect(RETURN_PHOTO_ACCEPT).toBe('image/jpeg,image/png');
  });

  it('入力の誤りの文は C-5 のとおり', () => {
    expect(RETURN_PHOTO_FILE_ERROR_MESSAGES).toEqual({
      type: 'JPEG か PNG の写真を選んでください。',
      size: '1枚 10MB までの写真を選んでください。',
    });
    expect(RETURN_PHOTO_UPLOAD_FAILED_MESSAGE).toBe('写真を送れませんでした。もう一度選んでください。');
  });
});

describe('checkReturnPhotoFile', () => {
  const cases: Array<[string, string, number, 'ok' | 'type' | 'size']> = [
    ['JPEG', 'image/jpeg', 1024, 'ok'],
    ['PNG', 'image/png', 1024, 'ok'],
    ['10MB（10,000,000 バイト）ちょうどの JPEG', 'image/jpeg', 10_000_000, 'ok'],
    ['10MB を1バイト超える JPEG', 'image/jpeg', 10_000_001, 'size'],
    ['10MB を超える PNG', 'image/png', 12_000_000, 'size'],
    ['GIF', 'image/gif', 1024, 'type'],
    ['WebP', 'image/webp', 1024, 'type'],
    ['HEIC', 'image/heic', 1024, 'type'],
    ['種類が分からないファイル', '', 1024, 'type'],
    ['大きすぎる GIF（大きさより先に種類で断る）', 'image/gif', 20_000_000, 'type'],
  ];

  it.each(cases)('%s（種類 %s・%i バイト）の結果は %s', (_name, type, size, expected) => {
    expect(checkReturnPhotoFile(fileOf(type, size))).toBe(expected);
  });
});

describe('resizeReturnPhoto', () => {
  function stubCanvas() {
    const context = { fillStyle: '', fillRect: jest.fn(), drawImage: jest.fn() };
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const toBlob = jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }));
    });
    return { context, toBlob };
  }

  function stubBitmap(width: number, height: number) {
    const bitmap = { width, height, close: jest.fn() };
    const createImageBitmap = jest.fn().mockResolvedValue(bitmap);
    Object.assign(globalThis, { createImageBitmap });
    return { bitmap, createImageBitmap };
  }

  afterEach(() => {
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  });

  const sizeCases: Array<[string, number, number, number, number]> = [
    ['横長の4000×3000は2000×1500', 4000, 3000, 2000, 1500],
    ['縦長の3000×4000は1500×2000', 3000, 4000, 1500, 2000],
    ['長い辺が2000pxちょうどなら縮めない', 2000, 1500, 2000, 1500],
    ['小さい写真（1200×800）は拡大しない', 1200, 800, 1200, 800],
  ];

  it.each(sizeCases)('長い辺を2000pxまでにする: %s', async (_name, sourceWidth, sourceHeight, width, height) => {
    const { context, toBlob } = stubCanvas();
    const { bitmap, createImageBitmap } = stubBitmap(sourceWidth, sourceHeight);
    const file = fileOf('image/png');

    const blob = await resizeReturnPhoto(file);

    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, width, height);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
    expect(blob.type).toBe('image/jpeg');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('PNG の透明な所が黒くならないよう、白で塗ってから描く', async () => {
    const { context } = stubCanvas();
    stubBitmap(800, 600);

    await resizeReturnPhoto(fileOf('image/png'));

    expect(context.fillStyle).toBe('#ffffff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
  });

  it('向きの指定（from-image）を知らない古いブラウザ（TypeError）では、指定なしで読み直す', async () => {
    stubCanvas();
    const { createImageBitmap, bitmap } = stubBitmap(800, 600);
    createImageBitmap.mockRejectedValueOnce(new TypeError('unsupported option'));
    const file = fileOf('image/jpeg');

    await resizeReturnPhoto(file);

    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(createImageBitmap).toHaveBeenNthCalledWith(1, file, { imageOrientation: 'from-image' });
    expect(createImageBitmap).toHaveBeenNthCalledWith(2, file);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('読み込めない写真（TypeError 以外の失敗）は、読み直さずにそのまま投げる', async () => {
    stubCanvas();
    const { createImageBitmap } = stubBitmap(800, 600);
    const failure = new Error('decode failed');
    createImageBitmap.mockRejectedValue(failure);

    await expect(resizeReturnPhoto(fileOf('image/jpeg'))).rejects.toBe(failure);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it('2D の描画が使えなければ投げる。読み込んだ画像は閉じる', async () => {
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { bitmap } = stubBitmap(800, 600);

    await expect(resizeReturnPhoto(fileOf('image/jpeg'))).rejects.toThrow('canvas_unavailable');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('JPEG に作り直せなければ投げる。読み込んだ画像は閉じる', async () => {
    const { toBlob } = stubCanvas();
    toBlob.mockImplementation((callback) => {
      callback(null);
    });
    const { bitmap } = stubBitmap(800, 600);

    await expect(resizeReturnPhoto(fileOf('image/jpeg'))).rejects.toThrow('encode_failed');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe('uploadReturnPhoto', () => {
  const photo = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockClientFetch.mockReset();
    mockRefreshSession.mockReset();
    mockFetch = jest.fn();
    Object.assign(globalThis, { fetch: mockFetch });
  });

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  function arrangeIssued() {
    mockClientFetch.mockResolvedValue(json({ data: { uploadId: UPLOAD_ID, signedUrl: SIGNED_URL } }));
  }

  it('窓口で署名つきの送り先をもらい、x-upsert: false を添えて JPEG として PUT する', async () => {
    arrangeIssued();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await uploadReturnPhoto(ORDER_ID, photo);

    expect(result).toEqual({ kind: 'ok', uploadId: UPLOAD_ID });
    expect(mockClientFetch).toHaveBeenCalledWith(`/api/orders/${ORDER_ID}/return-request/photos`, { method: 'POST' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(SIGNED_URL, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'x-upsert': 'false' },
      body: photo,
    });
  });

  it('注文の番号は URL の部品として直す', async () => {
    arrangeIssued();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await uploadReturnPhoto('a/b', photo);

    expect(mockClientFetch).toHaveBeenCalledWith('/api/orders/a%2Fb/return-request/photos', { method: 'POST' });
  });

  it('回数の制限（429）は固定の文にして、置き場へは送らない', async () => {
    mockClientFetch.mockResolvedValue(json({ error: 'Too many requests' }, 429));

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual({
      kind: 'error',
      message: CUSTOMER_RETURN_RATE_LIMITED_MESSAGE,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  const refusals: Array<[number, 'RETURN_REQUESTS_CLOSED' | 'RETURN_NOT_ELIGIBLE' | 'RETURN_PHOTO_INVALID']> = [
    [409, 'RETURN_REQUESTS_CLOSED'],
    [409, 'RETURN_NOT_ELIGIBLE'],
    [400, 'RETURN_PHOTO_INVALID'],
  ];

  it.each(refusals)('窓口が %i と記号 %s で断ったら、お客様の言葉にする（置き場へは送らない）', async (status, code) => {
    mockClientFetch.mockResolvedValue(json({ error: 'server text', code }, status));

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual({
      kind: 'error',
      message: CUSTOMER_RETURN_ERROR_MESSAGES[code].message,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  const otherFailures: Array<[number, unknown]> = [
    [400, { error: 'x', code: 'SOMETHING_ELSE' }],
    [400, { error: 'x' }],
    [401, { error: 'Unauthorized' }],
    [403, { error: 'Forbidden' }],
    [404, { error: 'Order not found' }],
    [500, { error: 'お申し込みを受け付けられませんでした。時間をおいて、もう一度お試しください。' }],
    [503, { error: 'Service Unavailable' }],
  ];

  it.each(otherFailures)('窓口が %i（記号なし・知らない記号・権限・想定外）なら「写真を送れませんでした」にする', async (status, body) => {
    mockClientFetch.mockResolvedValue(json(body, status));

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('断りの答えが読めなくても「写真を送れませんでした」にする', async () => {
    mockClientFetch.mockResolvedValue({ ok: false, status: 400, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response);

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);
  });

  it.each([
    ['送り先が無い', { data: { uploadId: UPLOAD_ID } }],
    ['番号が無い', { data: { signedUrl: SIGNED_URL } }],
    ['文字でない', { data: { uploadId: 1, signedUrl: 2 } }],
    ['中身（data）が無い', {}],
    ['答えが空', null],
  ])('成功なのに答えの形が違う（%s）なら「写真を送れませんでした」にする', async (_name, body) => {
    mockClientFetch.mockResolvedValue(json(body));

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('窓口への通信が切れても例外にせず「写真を送れませんでした」にする', async () => {
    mockClientFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('置き場が断った（ok でない）ら「写真を送れませんでした」にする。署名つきの送り先は文に出さない', async () => {
    arrangeIssued();
    mockFetch.mockResolvedValue({ ok: false, status: 409 });

    const result = await uploadReturnPhoto(ORDER_ID, photo);

    expect(result).toEqual(FAILED);
    expect(JSON.stringify(result)).not.toContain(SIGNED_URL);
  });

  it('置き場への通信が切れても例外にせず「写真を送れませんでした」にする', async () => {
    arrangeIssued();
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);
  });

  describe('401（ログインの印が古い）', () => {
    const unauthorized = () => json({ error: 'Unauthorized' }, 401);

    it('印を新しくできたら、同じ窓口へ1回だけ送り直し、その答えの送り先へ PUT する', async () => {
      mockRefreshSession.mockResolvedValueOnce('refreshed');
      mockClientFetch
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(json({ data: { uploadId: UPLOAD_ID, signedUrl: SIGNED_URL } }));
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual({ kind: 'ok', uploadId: UPLOAD_ID });

      expect(mockClientFetch).toHaveBeenCalledTimes(2);
      expect(mockClientFetch.mock.calls[1]).toEqual(mockClientFetch.mock.calls[0]);
      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
      // 窓口（401）→ 印を新しくする → 窓口（送り直し）の順
      expect(mockClientFetch.mock.invocationCallOrder[0]).toBeLessThan(mockRefreshSession.mock.invocationCallOrder[0]);
      expect(mockRefreshSession.mock.invocationCallOrder[0]).toBeLessThan(mockClientFetch.mock.invocationCallOrder[1]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(SIGNED_URL, expect.objectContaining({ method: 'PUT' }));
    });

    it.each(['expired', 'unavailable'])('印を新しくできない（%s）時は送り直さず「写真を送れませんでした」にする', async (outcome) => {
      mockRefreshSession.mockResolvedValueOnce(outcome);
      mockClientFetch.mockResolvedValueOnce(unauthorized());

      await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);

      expect(mockClientFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('送り直しもまた 401 なら「写真を送れませんでした」にする（送り直しは1回だけ）', async () => {
      mockRefreshSession.mockResolvedValueOnce('refreshed');
      mockClientFetch.mockResolvedValue(unauthorized());

      await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);

      expect(mockClientFetch).toHaveBeenCalledTimes(2);
      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('送り直しの通信が切れても例外にせず「写真を送れませんでした」にする', async () => {
      mockRefreshSession.mockResolvedValueOnce('refreshed');
      mockClientFetch.mockResolvedValueOnce(unauthorized()).mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('置き場への PUT が 401 で断られても、印は新しくせず、PUT も送り直さない（署名つきの送り先はログインの印と関係ない）', async () => {
      arrangeIssued();
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      await expect(uploadReturnPhoto(ORDER_ID, photo)).resolves.toEqual(FAILED);

      expect(mockRefreshSession).not.toHaveBeenCalled();
      expect(mockClientFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
