/** @jest-environment node */

// 送り先を作る DB の関数（Task 4）だけを差し替える。置き場と送り先の表は、中身を持つ偽のクライアントで受ける
jest.mock('@/lib/orders/returns/customer-return-store', () => ({ createCustomerReturnPhotoUpload: jest.fn() }));

import { createCustomerReturnPhotoUpload } from '@/lib/orders/returns/customer-return-store';
import {
  RETURN_PHOTO_BUCKET,
  RETURN_PHOTO_PURGE_BATCH,
  RETURN_PHOTO_VIEW_SECONDS,
  ReturnPhotoStorageError,
  issueReturnPhotoUpload,
  purgeReturnPhotos,
  signReturnPhotoUrls,
  verifyReturnPhotoUploads,
  type ReturnPhotoClient,
} from '@/lib/orders/returns/return-photo-storage';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import type { ReturnPhotoRef } from '@/lib/orders/returns/return-types';
import {
  APP0_JFIF,
  EXIF_WITH_GPS,
  JPEG_WITH_LOCATION,
  PLAIN_JPEG,
  PLAIN_PNG,
  PNG_WITH_TEXT,
  SOI,
  concat,
  containsText,
  hex,
  text,
} from './return-photo-fixtures';

const mockCreateUpload = createCustomerReturnPhotoUpload as jest.MockedFunction<typeof createCustomerReturnPhotoUpload>;

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORDER_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const UPLOAD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOAD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UPLOAD_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UPLOAD_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UPLOAD_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PHOTO_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const INPUT = { orderId: ORDER_ID, customerId: CUSTOMER_ID };

const pathOf = (uploadId: string, orderId = ORDER_ID) => `requests/${orderId}/${uploadId}`;

type UploadRow = {
  id: string;
  order_id: string;
  customer_id: string;
  storage_path: string;
  created_at: string;
  attached_at: string | null;
  purged_at: string | null;
};
type StoredFile = { bytes: Uint8Array; contentType: string };

/** 今から数えて何時間前か（試験を流す時刻に頼らない） */
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function uploadRow(uploadId: string, overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    id: uploadId,
    order_id: ORDER_ID,
    customer_id: CUSTOMER_ID,
    storage_path: pathOf(uploadId),
    created_at: hoursAgo(0.1),
    attached_at: null,
    purged_at: null,
    ...overrides,
  };
}

const file = (bytes: Uint8Array, contentType = 'image/jpeg'): StoredFile => ({ bytes, contentType });

function storedBytes(stored: Map<string, StoredFile>, path: string): Uint8Array {
  const found = stored.get(path);
  if (!found) throw new Error(`置き場に ${path} が無い`);
  return found.bytes;
}

/**
 * 送り先の表（絞り込みを本当に適用する）と、置き場の入れ物（中身を Map に持つ）をまねる偽の service_role クライアント。
 * 署名つきの送り先・リンクは、試験用の決まった文字にする。
 */
function createFakeClient(initial: { uploads?: UploadRow[]; files?: Record<string, StoredFile> } = {}) {
  const uploads = initial.uploads ?? [];
  const stored = new Map<string, StoredFile>(Object.entries(initial.files ?? {}));
  const state = { readFails: false, onDownload: undefined as (() => Promise<void>) | undefined };
  const queries: Array<{ table: string; columns: string; filters: Array<[string, unknown]> }> = [];

  const bucket = {
    createSignedUploadUrl: jest.fn(async (path: string) => ({
      data: { signedUrl: `https://storage.example.test/upload/${path}`, token: 'unused', path },
      error: null,
    })),
    createSignedUrls: jest.fn(async (paths: string[]) => ({
      data: paths.map((path) =>
        stored.has(path)
          ? { error: null, path, signedUrl: `https://storage.example.test/view/${path}` }
          : { error: 'Object not found', path, signedUrl: null },
      ),
      error: null,
    })),
    download: jest.fn(async (path: string) => {
      if (state.onDownload) await state.onDownload();
      const found = stored.get(path);
      if (!found) return { data: null, error: { status: 404, statusCode: '404', message: 'Object not found' } };
      const { bytes } = found;
      return {
        data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
        error: null,
      };
    }),
    upload: jest.fn(async (path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }) => {
      stored.set(path, { bytes: body, contentType: options.contentType });
      return { data: { path }, error: null };
    }),
    remove: jest.fn(async (paths: string[]) => {
      for (const path of paths) stored.delete(path);
      return { data: [], error: null };
    }),
  };
  const storage = { from: jest.fn(() => bucket) };
  const from = jest.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    let columns = '';
    const builder = {
      select: (value: string) => {
        columns = value;
        return builder;
      },
      in: (column: string, values: string[]) => {
        filters.push([column, values]);
        return builder;
      },
      eq: (column: string, value: string) => {
        filters.push([column, value]);
        return builder;
      },
      then: (resolve: (result: { data: unknown; error: unknown }) => void) => {
        queries.push({ table, columns, filters });
        if (state.readFails) {
          resolve({ data: null, error: { message: 'db down' } });
          return;
        }
        const rows = uploads.filter((row) =>
          filters.every(([column, expected]) => {
            const actual = (row as Record<string, unknown>)[column];
            return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
          }),
        );
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  });
  const rpc = jest.fn();
  return { client: { rpc, from, storage } as unknown as ReturnPhotoClient, bucket, storage, from, rpc, stored, queries, state };
}

beforeEach(() => {
  mockCreateUpload.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('定数', () => {
  it('入れ物の名前・お店が見るリンクの長さ（10分）・消す処理の1回の数', () => {
    expect(RETURN_PHOTO_BUCKET).toBe('return-photos');
    expect(RETURN_PHOTO_VIEW_SECONDS).toBe(600);
    expect(RETURN_PHOTO_PURGE_BATCH).toBe(500);
  });
});

describe('issueReturnPhotoUpload', () => {
  it('DB の関数で送り先を作り、その場所を上書きできない形（upsert: false）で署名して、番号と署名つきの送り先を返す', async () => {
    const { client, storage, bucket } = createFakeClient();
    mockCreateUpload.mockResolvedValue({ uploadId: UPLOAD_A, storagePath: pathOf(UPLOAD_A) });

    const issued = await issueReturnPhotoUpload(client, INPUT);

    expect(mockCreateUpload).toHaveBeenCalledWith(client, INPUT);
    expect(storage.from).toHaveBeenCalledWith(RETURN_PHOTO_BUCKET);
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(pathOf(UPLOAD_A), { upsert: false });
    expect(issued).toEqual({ uploadId: UPLOAD_A, signedUrl: `https://storage.example.test/upload/${pathOf(UPLOAD_A)}` });
  });

  it('DB の関数が断ったら、署名つきの送り先は作らず、断りをそのまま投げる', async () => {
    const { client, bucket } = createFakeClient();
    const refusal = new ReturnStoreError('RETURN_REQUESTS_CLOSED');
    mockCreateUpload.mockRejectedValue(refusal);

    await expect(issueReturnPhotoUpload(client, INPUT)).rejects.toBe(refusal);
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('署名つきの送り先を作れなければ ReturnPhotoStorageError(storage_unavailable)。文に場所を入れない', async () => {
    const { client, bucket } = createFakeClient();
    mockCreateUpload.mockResolvedValue({ uploadId: UPLOAD_A, storagePath: pathOf(UPLOAD_A) });
    bucket.createSignedUploadUrl.mockResolvedValue({
      data: null,
      error: { message: `failed for ${pathOf(UPLOAD_A)}`, status: 500 },
    } as never);

    const error = await issueReturnPhotoUpload(client, INPUT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReturnPhotoStorageError);
    expect(error).toMatchObject({ code: 'storage_unavailable' });
    expect((error as Error).message).not.toContain('requests/');
  });
});

describe('verifyReturnPhotoUploads', () => {
  const cleanCases: Array<[string, Uint8Array, Uint8Array, string, string]> = [
    ['JPEG', JPEG_WITH_LOCATION, PLAIN_JPEG, 'image/jpeg', 'GPSLatitude'],
    ['PNG', PNG_WITH_TEXT, PLAIN_PNG, 'image/png', 'Taro'],
  ];

  it('写真の番号が無ければ、DB も置き場も読まずに ok', async () => {
    const { client, from, storage } = createFakeClient();

    await expect(verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [] })).resolves.toEqual({ ok: true, photos: {} });
    expect(from).not.toHaveBeenCalled();
    expect(storage.from).not.toHaveBeenCalled();
  });

  it.each(cleanCases)(
    '撮影の情報の入った %s は、消した写しを同じ場所に upsert: true で置き直し、消した後の種類と大きさを返す（Review Focus 2）',
    async (_name, original, cleaned, contentType, secret) => {
      const { client, bucket, stored } = createFakeClient({
        uploads: [uploadRow(UPLOAD_A)],
        files: { [pathOf(UPLOAD_A)]: file(original, contentType) },
      });

      const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] });

      expect(result).toEqual({ ok: true, photos: { [UPLOAD_A]: { contentType, sizeBytes: cleaned.length } } });
      expect(bucket.upload).toHaveBeenCalledTimes(1);
      expect(bucket.upload).toHaveBeenCalledWith(pathOf(UPLOAD_A), expect.any(Uint8Array), { contentType, upsert: true });
      const after = storedBytes(stored, pathOf(UPLOAD_A));
      expect(hex(after)).toBe(hex(cleaned));
      expect(containsText(after, secret)).toBe(false);
    },
  );

  it('撮影の情報が無い写真は置き直さない', async () => {
    const { client, bucket } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A)],
      files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG) },
    });

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] });

    expect(result).toEqual({ ok: true, photos: { [UPLOAD_A]: { contentType: 'image/jpeg', sizeBytes: PLAIN_JPEG.length } } });
    expect(bucket.upload).not.toHaveBeenCalled();
  });

  it('通信が切れた後の送り直し: 2回目は消した写しを読むので置き直さず、同じ種類と大きさを返す（Review Focus 1）', async () => {
    const { client, bucket } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A)],
      files: { [pathOf(UPLOAD_A)]: file(JPEG_WITH_LOCATION) },
    });
    const input = { ...INPUT, uploadIds: [UPLOAD_A] };

    const first = await verifyReturnPhotoUploads(client, input);
    const second = await verifyReturnPhotoUploads(client, input);

    expect(first).toEqual({ ok: true, photos: { [UPLOAD_A]: { contentType: 'image/jpeg', sizeBytes: PLAIN_JPEG.length } } });
    expect(second).toEqual(first);
    expect(bucket.upload).toHaveBeenCalledTimes(1);
  });

  it('申し込みに使った後（attached_at あり）の送り先は、作ってから1日を過ぎていても止めない（送り直しのため。別の返品の写真かどうかは DB が断る）', async () => {
    const { client } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A, { attached_at: hoursAgo(30), created_at: hoursAgo(31) })],
      files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG) },
    });

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] });

    expect(result).toMatchObject({ ok: true });
  });

  it('無い番号・ほかのお客様の送り先・ほかの注文の送り先・消した送り先は、その番号を invalidUploadIds に返し（窓口が RETURN_PHOTO_INVALID の 400 にする）、置き場から読まない', async () => {
    const { client, bucket, queries } = createFakeClient({
      uploads: [
        uploadRow(UPLOAD_A),
        uploadRow(UPLOAD_B, { customer_id: OTHER_CUSTOMER_ID }),
        uploadRow(UPLOAD_C, { purged_at: '2026-10-14T00:00:00Z' }),
        uploadRow(UPLOAD_E, { order_id: OTHER_ORDER_ID, storage_path: pathOf(UPLOAD_E, OTHER_ORDER_ID) }),
      ],
      files: {
        [pathOf(UPLOAD_A)]: file(PLAIN_JPEG),
        [pathOf(UPLOAD_B)]: file(PLAIN_JPEG),
        [pathOf(UPLOAD_C)]: file(PLAIN_JPEG),
        [pathOf(UPLOAD_E, OTHER_ORDER_ID)]: file(PLAIN_JPEG),
      },
    });
    const uploadIds = [UPLOAD_A, UPLOAD_B, UPLOAD_C, UPLOAD_D, UPLOAD_E];

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds });

    // UPLOAD_D は表に行が無い。合わない番号は、渡された順にまとめて返す
    expect(result).toEqual({ ok: false, invalidUploadIds: [UPLOAD_B, UPLOAD_C, UPLOAD_D, UPLOAD_E] });
    expect(bucket.download).toHaveBeenCalledTimes(1);
    expect(bucket.download).toHaveBeenCalledWith(pathOf(UPLOAD_A));
    expect(queries).toEqual([
      {
        table: 'order_return_photo_uploads',
        columns: 'id, storage_path, created_at, attached_at, purged_at',
        filters: [
          ['id', uploadIds],
          ['order_id', ORDER_ID],
          ['customer_id', CUSTOMER_ID],
        ],
      },
    ]);
  });

  it('申し込みに使われないまま23時間たった送り先は期限切れとして invalid（消す処理が消す1日より前に断る）。22時間なら使える', async () => {
    const { client, bucket } = createFakeClient({
      uploads: [
        uploadRow(UPLOAD_A, { created_at: hoursAgo(24) }),
        uploadRow(UPLOAD_B, { created_at: hoursAgo(22) }),
      ],
      files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG), [pathOf(UPLOAD_B)]: file(PLAIN_JPEG) },
    });

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A, UPLOAD_B] });

    expect(result).toEqual({ ok: false, invalidUploadIds: [UPLOAD_A] });
    expect(bucket.download).toHaveBeenCalledTimes(1);
    expect(bucket.download).toHaveBeenCalledWith(pathOf(UPLOAD_B));
  });

  it('置き場に写真が無い（署名つきの送り先に送っていない）番号は invalid。ほかの写真は確かめ続ける', async () => {
    const { client } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A), uploadRow(UPLOAD_B)],
      files: { [pathOf(UPLOAD_B)]: file(PLAIN_PNG, 'image/png') },
    });

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A, UPLOAD_B] });

    expect(result).toEqual({ ok: false, invalidUploadIds: [UPLOAD_A] });
  });

  it('置き場に無い物が status 400・statusCode "404" で返っても（置き場の古い答え方）、その写真だけ合わない', async () => {
    const { client, bucket } = createFakeClient({ uploads: [uploadRow(UPLOAD_A)] });
    bucket.download.mockResolvedValue({
      data: null,
      error: { status: 400, statusCode: '404', message: 'Object not found' },
    } as never);

    await expect(verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] })).resolves.toEqual({
      ok: false,
      invalidUploadIds: [UPLOAD_A],
    });
  });

  it('画像でない物・作りが壊れた物は invalid にして、置き直さない（置き場の中身も変えない）', async () => {
    const gif = Uint8Array.from([...text('GIF89a'), 0x01, 0x00, 0x01, 0x00]);
    const truncated = concat(SOI, APP0_JFIF, EXIF_WITH_GPS.subarray(0, 12));
    const { client, bucket, stored } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A), uploadRow(UPLOAD_B)],
      files: { [pathOf(UPLOAD_A)]: file(gif), [pathOf(UPLOAD_B)]: file(truncated) },
    });

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A, UPLOAD_B] });

    expect(result).toEqual({ ok: false, invalidUploadIds: [UPLOAD_A, UPLOAD_B] });
    expect(bucket.upload).not.toHaveBeenCalled();
    expect(hex(storedBytes(stored, pathOf(UPLOAD_B)))).toBe(hex(truncated));
  });

  it('置き場の不調（404 以外の読み出しの失敗）は、写真が合わないことにせず ReturnPhotoStorageError で止める', async () => {
    const { client, bucket } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A)],
      files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG) },
    });
    bucket.download.mockResolvedValue({
      data: null,
      error: { status: 500, statusCode: '500', message: `storage down for ${pathOf(UPLOAD_A)}` },
    } as never);

    const error = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReturnPhotoStorageError);
    expect(error).toMatchObject({ code: 'storage_unavailable' });
    expect((error as Error).message).not.toContain('requests/');
  });

  it('消した写しを置き直せなければ ReturnPhotoStorageError で止める（消していない写真を通さない）', async () => {
    const { client, bucket } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A)],
      files: { [pathOf(UPLOAD_A)]: file(JPEG_WITH_LOCATION) },
    });
    bucket.upload.mockResolvedValue({ data: null, error: { status: 500, message: 'upload failed' } } as never);

    await expect(verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] })).rejects.toMatchObject({
      name: 'ReturnPhotoStorageError',
      code: 'storage_unavailable',
    });
  });

  it('送り先の表を読めなければ ReturnPhotoStorageError(db_unavailable) で止める', async () => {
    const { client, bucket, state } = createFakeClient({ uploads: [uploadRow(UPLOAD_A)] });
    state.readFails = true;

    await expect(verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A] })).rejects.toMatchObject({
      name: 'ReturnPhotoStorageError',
      code: 'db_unavailable',
    });
    expect(bucket.download).not.toHaveBeenCalled();
  });

  it('同じ番号が重なっても、確かめるのは1回', async () => {
    const { client, bucket } = createFakeClient({
      uploads: [uploadRow(UPLOAD_A)],
      files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG) },
    });

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds: [UPLOAD_A, UPLOAD_A, UPLOAD_A] });

    expect(result).toEqual({ ok: true, photos: { [UPLOAD_A]: { contentType: 'image/jpeg', sizeBytes: PLAIN_JPEG.length } } });
    expect(bucket.download).toHaveBeenCalledTimes(1);
  });

  it('置き場の読み書きは4枚ずつ同時に始め、結果は渡された順に返す', async () => {
    const uploadIds = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const { client, bucket, state } = createFakeClient({
      uploads: uploadIds.map((uploadId) => uploadRow(uploadId)),
      files: Object.fromEntries(uploadIds.map((uploadId) => [pathOf(uploadId), file(PLAIN_JPEG)])),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    state.onDownload = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
    };

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds });

    expect(result).toMatchObject({ ok: true });
    expect(bucket.download).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBe(4);
    expect(result.ok && Object.keys(result.photos)).toEqual(uploadIds);
  });

  it('番号が多ければ、50件ずつに分けて送り先の表を読む', async () => {
    const { client, queries } = createFakeClient();
    const uploadIds = Array.from({ length: 120 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

    const result = await verifyReturnPhotoUploads(client, { ...INPUT, uploadIds });

    expect(queries.map((query) => (query.filters[0][1] as string[]).length)).toEqual([50, 50, 20]);
    expect(result).toEqual({ ok: false, invalidUploadIds: uploadIds });
  });
});

describe('signReturnPhotoUrls', () => {
  const photo = (photoId: string, uploadId: string, overrides: Partial<ReturnPhotoRef> = {}): ReturnPhotoRef => ({
    photoId,
    returnLineId: 'line-1',
    storagePath: pathOf(uploadId),
    purged: false,
    ...overrides,
  });

  it('消していない写真は10分（600秒）のリンクを1回の問い合わせで作り、消した写真は置き場に問い合わせず url なしで、並びのまま返す', async () => {
    const { client, bucket } = createFakeClient({
      files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG), [pathOf(UPLOAD_C)]: file(PLAIN_JPEG) },
    });
    const photos = [photo('p1', UPLOAD_A), photo('p2', UPLOAD_B, { purged: true, returnLineId: 'line-2' }), photo('p3', UPLOAD_C)];

    const signed = await signReturnPhotoUrls(client, photos);

    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrls).toHaveBeenCalledWith([pathOf(UPLOAD_A), pathOf(UPLOAD_C)], 600);
    expect(signed).toEqual([
      { photoId: 'p1', returnLineId: 'line-1', url: `https://storage.example.test/view/${pathOf(UPLOAD_A)}`, purged: false },
      { photoId: 'p2', returnLineId: 'line-2', url: null, purged: true },
      { photoId: 'p3', returnLineId: 'line-1', url: `https://storage.example.test/view/${pathOf(UPLOAD_C)}`, purged: false },
    ]);
  });

  it('消した写真だけなら、置き場に問い合わせない', async () => {
    const { client, bucket } = createFakeClient();

    const signed = await signReturnPhotoUrls(client, [photo('p1', UPLOAD_A, { purged: true })]);

    expect(signed).toEqual([{ photoId: 'p1', returnLineId: 'line-1', url: null, purged: true }]);
    expect(bucket.createSignedUrls).not.toHaveBeenCalled();
  });

  it('リンクを作れなかった写真（置き場に無い）は url なしで、purged は false のまま', async () => {
    const { client } = createFakeClient({ files: { [pathOf(UPLOAD_C)]: file(PLAIN_JPEG) } });

    const signed = await signReturnPhotoUrls(client, [photo('p1', UPLOAD_A), photo('p2', UPLOAD_C)]);

    expect(signed.map((entry) => [entry.photoId, entry.url !== null, entry.purged])).toEqual([
      ['p1', false, false],
      ['p2', true, false],
    ]);
  });

  it('置き場への問い合わせごと失敗しても投げず、url なしで返す。ログに場所もリンクも出さない', async () => {
    const { client, bucket } = createFakeClient({ files: { [pathOf(UPLOAD_A)]: file(PLAIN_JPEG) } });
    bucket.createSignedUrls.mockResolvedValue({
      data: null,
      error: { status: 503, message: `down: ${pathOf(UPLOAD_A)}` },
    } as never);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    const signed = await signReturnPhotoUrls(client, [photo('p1', UPLOAD_A)]);

    expect(signed).toEqual([{ photoId: 'p1', returnLineId: 'line-1', url: null, purged: false }]);
    expect(logged).toHaveBeenCalledWith('[return-photo] createSignedUrls failed', 503);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('requests/');
  });

  it('100枚ずつに分けてリンクを作る', async () => {
    const { client, bucket } = createFakeClient();
    const photos = Array.from({ length: 250 }, (_, index) => photo(`p${index}`, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`));

    await signReturnPhotoUrls(client, photos);

    expect(bucket.createSignedUrls.mock.calls.map((call) => call[0].length)).toEqual([100, 100, 50]);
  });
});

describe('purgeReturnPhotos', () => {
  const target = (kind: string, id: string, storagePath: string) => ({ target_kind: kind, target_id: id, storage_path: storagePath });

  /** 対象の一覧を返し、印を付ける関数は渡された番号の数を返す DB */
  function answerRpc(rpc: jest.Mock, targets: unknown[]) {
    rpc.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      if (name === 'list_return_photo_purge_targets') return { data: targets, error: null };
      if (name === 'mark_return_photo_targets_purged') return { data: (params._ids as string[]).length, error: null };
      throw new Error(`想定しない呼び出し: ${name}`);
    });
  }

  it('対象を DB から読み、送り先と写真を種類ごとに置き場の窓口で消し、消せた後で印を付ける。数は印を付けた数', async () => {
    const { client, bucket, rpc } = createFakeClient();
    answerRpc(rpc, [
      target('upload', UPLOAD_A, pathOf(UPLOAD_A)),
      target('photo', PHOTO_ID, pathOf(UPLOAD_B)),
      target('upload', UPLOAD_C, pathOf(UPLOAD_C)),
    ]);

    const result = await purgeReturnPhotos(client);

    expect(result).toEqual({ uploads: 2, photos: 1 });
    expect(rpc.mock.calls).toEqual([
      ['list_return_photo_purge_targets', { _limit: RETURN_PHOTO_PURGE_BATCH }],
      ['mark_return_photo_targets_purged', { _target_kind: 'upload', _ids: [UPLOAD_A, UPLOAD_C] }],
      ['mark_return_photo_targets_purged', { _target_kind: 'photo', _ids: [PHOTO_ID] }],
    ]);
    expect(bucket.remove.mock.calls).toEqual([[[pathOf(UPLOAD_A), pathOf(UPLOAD_C)]], [[pathOf(UPLOAD_B)]]]);
    // 置き場から消した後で印を付ける
    expect(bucket.remove.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1]);
    expect(bucket.remove.mock.invocationCallOrder[1]).toBeLessThan(rpc.mock.invocationCallOrder[2]);
  });

  it('1000件ずつに分けて消し、印も1000件ずつ付ける（DB が返す数に頼らない）', async () => {
    const { client, bucket, rpc } = createFakeClient();
    const many = Array.from({ length: 1200 }, (_, index) =>
      target('upload', `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `requests/${ORDER_ID}/u${index}`),
    );
    answerRpc(rpc, many);

    const result = await purgeReturnPhotos(client);

    expect(result).toEqual({ uploads: 1200, photos: 0 });
    expect(bucket.remove.mock.calls.map((call) => call[0].length)).toEqual([1000, 200]);
    const marks = rpc.mock.calls.filter(([name]) => name === 'mark_return_photo_targets_purged');
    expect(marks.map(([, params]) => (params as { _ids: string[] })._ids.length)).toEqual([1000, 200]);
  });

  it('置き場の消去に失敗した分には印を付けない。残りは続け、最後に storage_unavailable で止める', async () => {
    const { client, bucket, rpc } = createFakeClient();
    answerRpc(rpc, [target('upload', UPLOAD_A, pathOf(UPLOAD_A)), target('photo', PHOTO_ID, pathOf(UPLOAD_B))]);
    bucket.remove.mockResolvedValueOnce({ data: null, error: { message: `failed ${pathOf(UPLOAD_A)}`, status: 500 } } as never);

    const error = await purgeReturnPhotos(client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReturnPhotoStorageError);
    expect(error).toMatchObject({ code: 'storage_unavailable' });
    expect((error as Error).message).not.toContain('requests/');
    expect(rpc.mock.calls.filter(([name]) => name === 'mark_return_photo_targets_purged')).toEqual([
      ['mark_return_photo_targets_purged', { _target_kind: 'photo', _ids: [PHOTO_ID] }],
    ]);
  });

  it('対象が無ければ、置き場にも印にも触れず 0 と 0 を返す', async () => {
    const { client, bucket, rpc } = createFakeClient();
    answerRpc(rpc, []);

    await expect(purgeReturnPhotos(client)).resolves.toEqual({ uploads: 0, photos: 0 });
    expect(bucket.remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('対象を読めなければ db_unavailable で止め、何も消さない', async () => {
    const { client, bucket, rpc } = createFakeClient();
    rpc.mockResolvedValue({ data: null, error: { message: 'db down' } });

    await expect(purgeReturnPhotos(client)).rejects.toMatchObject({ name: 'ReturnPhotoStorageError', code: 'db_unavailable' });
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it('印を付けられなければ db_unavailable で止める（置き場から消した物は、次の回にまた対象になり、消し直しても害は無い）', async () => {
    const { client, bucket, rpc } = createFakeClient();
    rpc.mockImplementation(async (name: string) =>
      name === 'list_return_photo_purge_targets'
        ? { data: [target('upload', UPLOAD_A, pathOf(UPLOAD_A))], error: null }
        : { data: null, error: { message: 'db down' } },
    );

    await expect(purgeReturnPhotos(client)).rejects.toMatchObject({ name: 'ReturnPhotoStorageError', code: 'db_unavailable' });
    expect(bucket.remove).toHaveBeenCalledTimes(1);
  });

  it('種類や番号・場所が読めない行は飛ばす', async () => {
    const { client, bucket, rpc } = createFakeClient();
    answerRpc(rpc, [
      target('other', UPLOAD_B, pathOf(UPLOAD_B)),
      { target_kind: 'upload', target_id: 1, storage_path: pathOf(UPLOAD_C) },
      { target_kind: 'upload', target_id: UPLOAD_C },
      target('upload', UPLOAD_A, pathOf(UPLOAD_A)),
    ]);

    const result = await purgeReturnPhotos(client);

    expect(result).toEqual({ uploads: 1, photos: 0 });
    expect(bucket.remove).toHaveBeenCalledTimes(1);
    expect(bucket.remove).toHaveBeenCalledWith([pathOf(UPLOAD_A)]);
  });
});
