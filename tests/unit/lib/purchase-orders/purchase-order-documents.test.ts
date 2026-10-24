/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  attachPurchaseOrderDocument,
  createPurchaseOrderDocumentUrl,
  inspectDocumentBytes,
  issueDocumentUploadUrl,
  PURCHASE_ORDER_DOCUMENT_BUCKET,
  reservePurchaseOrderDocument,
  revisePurchaseOrderDocument,
  searchPurchaseOrderDocuments,
} from '@/lib/purchase-orders/purchase-order-documents';
import { PurchaseOrderError } from '@/lib/purchase-orders/purchase-order-store';
import type { PurchaseOrderDocumentSearchFilters } from '@/lib/purchase-orders/purchase-order-types';
import { ACTOR_ID, ATTACHMENT_ID, confirmedDetail, ORDER_ID, RESERVATION_ID } from './purchase-order-fixtures';

const OBJECT_NAME = '99999999-9999-4999-8999-999999999999.pdf';
const STORAGE_PATH = `${ORDER_ID}/${OBJECT_NAME}`;
const SIGNED_UPLOAD = 'https://storage.example.test/object/upload/sign/purchase-order-documents/SECRET-UPLOAD-TOKEN';
const SIGNED_VIEW = 'https://storage.example.test/object/sign/purchase-order-documents/SECRET-VIEW-TOKEN';
const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const PDF = new Uint8Array(Buffer.from('%PDF-1.4 sample document'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Result = { data: unknown; error: unknown };

/** await できる問い合わせの代役（select / eq を連ねて最後に await する） */
function queryOf(result: Result) {
  const builder: Record<string, unknown> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.then = (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return builder as { select: jest.Mock; eq: jest.Mock };
}

const bucket = {
  createSignedUploadUrl: jest.fn(),
  list: jest.fn(),
  download: jest.fn(),
  createSignedUrl: jest.fn(),
};
const storageFrom = jest.fn(() => bucket);
const rpc = jest.fn();
const tables: Record<string, ReturnType<typeof queryOf>> = {};
const from = jest.fn((table: string) => tables[table]);
const client = { rpc, from, storage: { from: storageFrom } } as unknown as SupabaseClient;

const RESERVATIONS = 'purchase_order_attachment_reservations';
const ATTACHMENTS = 'purchase_order_attachments';

function blobOf(bytes: Uint8Array, type = 'application/pdf') {
  return { type, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

/** get_admin_purchase_order は読める発注書を返し、それ以外の RPC は個別に決める */
function readableOrder(other: (name: string, args: Record<string, unknown>) => Result = () => ({ data: null, error: null })) {
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
    name === 'get_admin_purchase_order' ? { data: confirmedDetail(), error: null } : other(name, args));
}

async function failureOf(run: () => Promise<unknown>): Promise<PurchaseOrderError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PurchaseOrderError);
    return error as PurchaseOrderError;
  }
  throw new Error('expected a PurchaseOrderError');
}

/** 誤りの文・code・状態に、署名つきの送り先・リンク・保存キー・本文の目印が無いこと */
function expectNoLeak(error: PurchaseOrderError): void {
  const text = inspect(error, { depth: null }) + JSON.stringify({ message: error.message, code: error.code });
  for (const secret of ['SECRET-UPLOAD-TOKEN', 'SECRET-VIEW-TOKEN', OBJECT_NAME, STORAGE_PATH, 'storage.example.test', 'sample document']) {
    expect(text).not.toContain(secret);
  }
}

beforeEach(() => {
  jest.resetAllMocks();
  storageFrom.mockImplementation(() => bucket);
  from.mockImplementation((table: string) => tables[table]);
  for (const key of Object.keys(tables)) delete tables[key];
});

describe('inspectDocumentBytes（共通の値の検査 (1)〜(4) と SHA-256）', () => {
  test.each([
    ['PDF', 'quote.pdf', PDF, 'application/pdf'],
    ['JPEG（jpg）', 'photo.JPG', JPEG, 'image/jpeg'],
    ['JPEG（jpeg）', 'photo.jpeg', JPEG, 'image/jpeg'],
    ['PNG', 'scan.png', PNG, 'image/png'],
  ])('FREQ-530-AC-02: %s は拡張子・先頭のバイトが合えば通り、種類・大きさ・SHA-256 を返す', (_name, fileName, bytes, mimeType) => {
    expect(inspectDocumentBytes(bytes, { fileName, contentType: mimeType })).toEqual({ mimeType, sizeBytes: bytes.length, sha256: sha256(bytes) });
  });

  test.each([
    ['拡張子が無い', 'quote', PDF],
    ['拡張子が許していない（txt）', 'quote.txt', PDF],
    ['二重拡張子で最後が許していない', 'quote.pdf.exe', PDF],
    ['先頭のバイトが拡張子の種類と違う（PDF の名前で PNG）', 'quote.pdf', PNG],
    ['先頭のバイトが拡張子の種類と違う（PNG の名前で JPEG）', 'scan.png', JPEG],
    ['先頭のバイトが拡張子の種類と違う（JPEG の名前で PDF）', 'photo.jpg', PDF],
    ['空のファイル', 'empty.pdf', new Uint8Array(0)],
  ])('FREQ-530-AC-02: %s は DOCUMENT_TYPE_UNSUPPORTED（422）', async (_name, fileName, bytes) => {
    const error = await failureOf(async () => inspectDocumentBytes(bytes, { fileName, contentType: null }));
    expect(error).toMatchObject({ status: 422, code: 'DOCUMENT_TYPE_UNSUPPORTED', message: 'PDF・JPEG・PNG のファイルを選んでください。' });
  });

  test('FREQ-530-AC-02: 置き場が記録した content-type が拡張子の種類と違えば DOCUMENT_TYPE_UNSUPPORTED。無い（null・空）なら見ない。パラメーターと大小は無視する', async () => {
    expect(inspectDocumentBytes(PDF, { fileName: 'a.pdf', contentType: null }).mimeType).toBe('application/pdf');
    expect(inspectDocumentBytes(PDF, { fileName: 'a.pdf', contentType: '' }).mimeType).toBe('application/pdf');
    expect(inspectDocumentBytes(PDF, { fileName: 'a.pdf', contentType: 'Application/PDF; charset=binary' }).mimeType).toBe('application/pdf');
    const error = await failureOf(async () => inspectDocumentBytes(PDF, { fileName: 'a.pdf', contentType: 'image/png' }));
    expect(error.code).toBe('DOCUMENT_TYPE_UNSUPPORTED');
  });

  test('FREQ-530-AC-02: 大きさは 20 MiB（20971520 バイト）ちょうどまで通り、1バイト超えると DOCUMENT_TOO_LARGE（422）', async () => {
    const atLimit = new Uint8Array(20971520);
    atLimit.set(PDF);
    expect(inspectDocumentBytes(atLimit, { fileName: 'big.pdf', contentType: null }).sizeBytes).toBe(20971520);
    const over = new Uint8Array(20971521);
    over.set(PDF);
    const error = await failureOf(async () => inspectDocumentBytes(over, { fileName: 'big.pdf', contentType: null }));
    expect(error).toMatchObject({ status: 422, code: 'DOCUMENT_TOO_LARGE', message: 'ファイルは 20 MiB までです。' });
  });
});

describe('reservePurchaseOrderDocument（予約 → 署名つきの送り先）', () => {
  const input = { purchaseOrderId: ORDER_ID, kind: 'invoice' as const, fileName: 'invoice.pdf', replacesAttachmentId: null, requestKey: REQUEST_KEY };
  const dbResult = { reservationId: RESERVATION_ID, storagePath: STORAGE_PATH, expiresAt: '2026-10-26T12:00:00+00:00', replayed: false };

  test('FREQ-530-AC-03: DB の関数を実行者つきで呼んだ後に、上書きできない形（upsert: false）で署名つきの送り先を作って返す', async () => {
    const order: string[] = [];
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: dbResult, error: null }; });
    bucket.createSignedUploadUrl.mockImplementation(async () => { order.push('storage'); return { data: { signedUrl: SIGNED_UPLOAD, token: 't', path: STORAGE_PATH }, error: null }; });
    const result = await reservePurchaseOrderDocument(client, ACTOR_ID, input);
    expect(result).toEqual({ reservationId: RESERVATION_ID, signedUrl: SIGNED_UPLOAD, expiresAt: dbResult.expiresAt, replayed: false });
    expect(order).toEqual(['rpc', 'storage']);
    expect(rpc).toHaveBeenCalledWith('admin_reserve_purchase_order_attachment', {
      _purchase_order_id: ORDER_ID, _kind: 'invoice', _file_name: 'invoice.pdf', _replaces_attachment_id: null, _actor_id: ACTOR_ID, _request_key: REQUEST_KEY,
    });
    expect(storageFrom).toHaveBeenCalledWith(PURCHASE_ORDER_DOCUMENT_BUCKET);
    expect(PURCHASE_ORDER_DOCUMENT_BUCKET).toBe('purchase-order-documents');
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(STORAGE_PATH, { upsert: false });
  });

  test('FREQ-530-AC-02: 差し替えの予約は、差し替える添付を DB の関数へそのまま渡して予約に残す。差し替え元が当発注書の物でなければ 400（置き場に触れない）', async () => {
    rpc.mockResolvedValue({ data: dbResult, error: null });
    bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: SIGNED_UPLOAD }, error: null });
    await reservePurchaseOrderDocument(client, ACTOR_ID, { ...input, replacesAttachmentId: ATTACHMENT_ID });
    expect(rpc).toHaveBeenCalledWith('admin_reserve_purchase_order_attachment', expect.objectContaining({ _replaces_attachment_id: ATTACHMENT_ID }));

    bucket.createSignedUploadUrl.mockClear();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID', code: '22023', details: 'PRIVATE-MARKER' } });
    const error = await failureOf(() => reservePurchaseOrderDocument(client, ACTOR_ID, { ...input, replacesAttachmentId: ATTACHMENT_ID }));
    expect(error).toMatchObject({ status: 400, code: 'GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID', message: '差し替え元の書類を確かめてください。' });
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 同じ要求の再送（replayed: true）も新しい送り先を作って返す', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
    bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: SIGNED_UPLOAD }, error: null });
    expect((await reservePurchaseOrderDocument(client, ACTOR_ID, input)).replayed).toBe(true);
  });

  test.each([
    ['置き場がエラーを返す', () => bucket.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: `boom ${SIGNED_UPLOAD}` } })],
    ['置き場が送り先を返さない', () => bucket.createSignedUploadUrl.mockResolvedValue({ data: {}, error: null })],
    ['置き場が空の送り先を返す', () => bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: '' }, error: null })],
    ['置き場の呼び出しが例外', () => bucket.createSignedUploadUrl.mockRejectedValue(new Error(`boom ${STORAGE_PATH}`))],
  ])('FREQ-530-AC-03: %s は DOCUMENT_STORAGE_UNAVAILABLE（503）。予約はすでに DB にあり、誤りに署名つきの送り先・保存キーが無い', async (_name, arrange) => {
    rpc.mockResolvedValue({ data: dbResult, error: null });
    arrange();
    const error = await failureOf(() => reservePurchaseOrderDocument(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE', message: 'ファイルの保存先に接続できません。時間をおいて再度お試しください。' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expectNoLeak(error);
  });

  test('FREQ-530-AC-02: DB の誤り（権限・発注書なし・拡張子・要求番号）は表のとおりに分類し、置き場には触れない', async () => {
    for (const [message, sqlstate, status] of [['GROUP_G_FORBIDDEN', '42501', 403], ['GROUP_G_PO_NOT_FOUND', 'P0002', 404], ['GROUP_G_ARGUMENT_INVALID', '22023', 400], ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409]] as const) {
      rpc.mockResolvedValueOnce({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER' } });
      const error = await failureOf(() => reservePurchaseOrderDocument(client, ACTOR_ID, input));
      expect({ status: error.status, code: error.code }).toEqual({ status, code: message });
      expect(error.message).not.toContain('PRIVATE-MARKER');
    }
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  test.each([
    ['戻りがオブジェクトでない', null],
    ['reservationId が uuid でない', { ...dbResult, reservationId: 'x' }],
    ['保存キーの形が違う', { ...dbResult, storagePath: 'a/b.exe' }],
    ['保存キーが別の発注書の物', { ...dbResult, storagePath: `${RESERVATION_ID}/${OBJECT_NAME}` }],
    ['期限が日時でない', { ...dbResult, expiresAt: 'tomorrow' }],
    ['replayed が真偽でない', { ...dbResult, replayed: 'no' }],
  ])('FREQ-530-AC-03: DB の戻りが崩れている（%s）時は固定の500で、置き場に触れない', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    const error = await failureOf(() => reservePurchaseOrderDocument(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 500, message: '発注の記録に失敗しました' });
    expect(error.code).toBeUndefined();
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });
});

describe('issueDocumentUploadUrl（署名つきの送り先の出し直し）', () => {
  const input = { purchaseOrderId: ORDER_ID, reservationId: RESERVATION_ID };

  function arrange(options: { reservation?: Result; attachment?: Result } = {}) {
    readableOrder();
    tables[RESERVATIONS] = queryOf(options.reservation ?? { data: [{ storage_path: STORAGE_PATH }], error: null });
    tables[ATTACHMENTS] = queryOf(options.attachment ?? { data: [], error: null });
  }

  test('FREQ-540-AC-07: 最初に get_admin_purchase_order を実行者つきで呼び、42501 は 403。表も置き場も見ない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    const error = await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    expect(rpc).toHaveBeenCalledWith('get_admin_purchase_order', { _purchase_order_id: ORDER_ID, _actor_id: ACTOR_ID });
    expect(from).not.toHaveBeenCalled();
    expect(bucket.list).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-07: 発注書が無ければ（NULL）404。表も置き場も見ない', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input))).toMatchObject({ status: 404, code: 'GROUP_G_PO_NOT_FOUND' });
    expect(from).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-07: 読取の確かめの他の失敗は固定の500', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: 'XX000' } });
    const error = await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 500, message: '発注の記録に失敗しました' });
    expect(error.message).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-530-AC-03: 予約が当発注書の物でなければ（行が無い）409 RESERVATION_INVALID。置き場は見ない', async () => {
    arrange({ reservation: { data: [], error: null } });
    expect(await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input))).toMatchObject({ status: 409, code: 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID' });
    expect(tables[RESERVATIONS].eq).toHaveBeenCalledWith('id', RESERVATION_ID);
    expect(tables[RESERVATIONS].eq).toHaveBeenCalledWith('purchase_order_id', ORDER_ID);
    expect(bucket.list).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: すでに添付に結ばれていれば 409 ALREADY_ATTACHED。置き場は見ない', async () => {
    arrange({ attachment: { data: [{ id: ATTACHMENT_ID }], error: null } });
    expect(await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input))).toMatchObject({ status: 409, code: 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED' });
    expect(tables[ATTACHMENTS].eq).toHaveBeenCalledWith('reservation_id', RESERVATION_ID);
    expect(bucket.list).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 置き場に保存済み（オブジェクト名の完全一致が1件）なら { uploaded: true }。送り先は作らない。list は発注書 id のフォルダでオブジェクト名を search に渡す', async () => {
    arrange();
    bucket.list.mockResolvedValue({ data: [{ name: OBJECT_NAME }], error: null });
    expect(await issueDocumentUploadUrl(client, ACTOR_ID, input)).toEqual({ uploaded: true });
    expect(bucket.list).toHaveBeenCalledWith(ORDER_ID, { search: OBJECT_NAME });
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 前だけ一致する別名・別の拡張子は「ない」。新しい署名つきの送り先（upsert: false）を返す', async () => {
    arrange();
    bucket.list.mockResolvedValue({ data: [{ name: `${OBJECT_NAME}.bak` }, { name: '99999999-9999-4999-8999-999999999999.pdf2' }, { name: 'other.pdf' }], error: null });
    bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: SIGNED_UPLOAD }, error: null });
    expect(await issueDocumentUploadUrl(client, ACTOR_ID, input)).toEqual({ uploaded: false, signedUrl: SIGNED_UPLOAD });
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(STORAGE_PATH, { upsert: false });
  });

  test('FREQ-530-AC-03: 置き場に何も無ければ新しい署名つきの送り先を返す', async () => {
    arrange();
    bucket.list.mockResolvedValue({ data: [], error: null });
    bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: SIGNED_UPLOAD }, error: null });
    expect(await issueDocumentUploadUrl(client, ACTOR_ID, input)).toEqual({ uploaded: false, signedUrl: SIGNED_UPLOAD });
  });

  test('FREQ-530-AC-03: 呼ぶ順は 読取の確かめ → 予約の表 → 添付の表 → 置き場の一覧', async () => {
    const order: string[] = [];
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: confirmedDetail(), error: null }; });
    from.mockImplementation((table: string) => { order.push(table); return queryOf({ data: table === RESERVATIONS ? [{ storage_path: STORAGE_PATH }] : [], error: null }); });
    bucket.list.mockImplementation(async () => { order.push('list'); return { data: [{ name: OBJECT_NAME }], error: null }; });
    await issueDocumentUploadUrl(client, ACTOR_ID, input);
    expect(order).toEqual(['rpc', RESERVATIONS, ATTACHMENTS, 'list']);
  });

  test.each([
    ['置き場の一覧がエラー', () => bucket.list.mockResolvedValue({ data: null, error: { message: STORAGE_PATH } })],
    ['置き場の一覧が例外', () => bucket.list.mockRejectedValue(new Error(STORAGE_PATH))],
    ['送り先を作れない', () => { bucket.list.mockResolvedValue({ data: [], error: null }); bucket.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: SIGNED_UPLOAD } }); }],
  ])('FREQ-530-AC-03: %s は 503 で、誤りに署名つきの送り先・保存キーが無い', async (_name, setup) => {
    arrange();
    setup();
    const error = await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expectNoLeak(error);
  });

  test.each([
    ['予約の表がエラー', { reservation: { data: null, error: { message: 'PRIVATE-MARKER' } } }],
    ['添付の表がエラー', { attachment: { data: null, error: { message: 'PRIVATE-MARKER' } } }],
    ['予約の保存キーの形が違う', { reservation: { data: [{ storage_path: 'x/y' }], error: null } }],
  ])('FREQ-530-AC-03: %s は固定の500', async (_name, options) => {
    arrange(options);
    const error = await failureOf(() => issueDocumentUploadUrl(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 500, message: '発注の記録に失敗しました' });
    expect(error.message).not.toContain('PRIVATE-MARKER');
  });
});

describe('attachPurchaseOrderDocument（読み戻し → 検査 → 確定）', () => {
  const input = {
    purchaseOrderId: ORDER_ID, reservationId: RESERVATION_ID, sha256: sha256(PDF), transactionDate: '2026-10-26', amountYen: 6000,
    currency: 'JPY' as const, counterparty: '工場A', requestKey: REQUEST_KEY,
  };
  const dbResult = { attachmentId: ATTACHMENT_ID, revisionNo: 1, replayed: false };

  function arrange(options: { reservation?: Result; download?: Result } = {}) {
    tables[RESERVATIONS] = queryOf(options.reservation ?? { data: [{ storage_path: STORAGE_PATH }], error: null });
    bucket.download.mockResolvedValue(options.download ?? { data: blobOf(PDF), error: null });
    rpc.mockResolvedValue({ data: dbResult, error: null });
  }

  test('FREQ-530-AC-02: 予約の保存キーを引き、読み戻して検査し、ブラウザのハッシュと一致すれば sha256_source=browser で DB の関数を1回呼ぶ', async () => {
    arrange();
    expect(await attachPurchaseOrderDocument(client, ACTOR_ID, input)).toEqual(dbResult);
    expect(tables[RESERVATIONS].eq).toHaveBeenCalledWith('id', RESERVATION_ID);
    expect(tables[RESERVATIONS].eq).toHaveBeenCalledWith('purchase_order_id', ORDER_ID);
    expect(bucket.download).toHaveBeenCalledWith(STORAGE_PATH);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_attach_purchase_order_document', {
      _reservation_id: RESERVATION_ID, _purchase_order_id: ORDER_ID, _mime_type: 'application/pdf', _size_bytes: PDF.length,
      _sha256: sha256(PDF), _sha256_source: 'browser', _transaction_date: '2026-10-26', _amount_yen: 6000, _currency: 'JPY',
      _counterparty: '工場A', _actor_id: ACTOR_ID, _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-530-AC-03: 置き場の読み戻しが DB の関数より先（DB の取引の中では置き場を使わない）', async () => {
    const order: string[] = [];
    tables[RESERVATIONS] = queryOf({ data: [{ storage_path: STORAGE_PATH }], error: null });
    bucket.download.mockImplementation(async () => { order.push('download'); return { data: blobOf(PDF), error: null }; });
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: dbResult, error: null }; });
    await attachPurchaseOrderDocument(client, ACTOR_ID, input);
    expect(order).toEqual(['download', 'rpc']);
  });

  test('FREQ-530-AC-03: sha256 が null（ページを読み直した後でファイルが手元に無い再開）はサーバーが読み戻した本文のハッシュを使い sha256_source=server', async () => {
    arrange();
    await attachPurchaseOrderDocument(client, ACTOR_ID, { ...input, sha256: null });
    expect(rpc).toHaveBeenCalledWith('admin_attach_purchase_order_document', expect.objectContaining({ _sha256: sha256(PDF), _sha256_source: 'server' }));
  });

  test('FREQ-530-AC-02: 差し替え元は呼び手から受けず、DB の関数へ渡さない（予約に残した物を DB が版1へ写す）', async () => {
    arrange();
    await attachPurchaseOrderDocument(client, ACTOR_ID, { ...input, replacesAttachmentId: ATTACHMENT_ID } as typeof input);
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args)).not.toContain('_replaces_attachment_id');
    expect(JSON.stringify(args)).not.toContain(ATTACHMENT_ID);
  });

  test('FREQ-530-AC-02: ブラウザのハッシュが読み戻した本文と違えば 422 DOCUMENT_HASH_MISMATCH。DB の関数は呼ばない', async () => {
    arrange();
    const error = await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, { ...input, sha256: 'b'.repeat(64) }));
    expect(error).toMatchObject({ status: 422, code: 'DOCUMENT_HASH_MISMATCH', message: 'アップロードしたファイルの内容が一致しません。もう一度アップロードしてください。' });
    expect(rpc).not.toHaveBeenCalled();
    expectNoLeak(error);
  });

  test.each([
    ['status が 404', { status: 404, message: STORAGE_PATH }],
    ['statusCode が文字列の 404', { status: 400, statusCode: '404', message: 'Object not found' }],
    ['statusCode が数の 404', { statusCode: 404, message: 'Object not found' }],
  ])('FREQ-530-AC-03: 置き場にまだ無い（%s）は 409 DOCUMENT_NOT_UPLOADED。DB の関数は呼ばない', async (_name, storageError) => {
    arrange({ download: { data: null, error: storageError } });
    const error = await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 409, code: 'DOCUMENT_NOT_UPLOADED', message: 'ファイルがまだ届いていません。もう一度アップロードしてください。' });
    expect(rpc).not.toHaveBeenCalled();
    expectNoLeak(error);
  });

  test.each([
    ['置き場が 5xx', () => arrange({ download: { data: null, error: { status: 502, message: STORAGE_PATH } } })],
    ['エラーの形が不明', () => arrange({ download: { data: null, error: { message: 'timeout' } } })],
    ['読み出しが例外', () => { arrange(); bucket.download.mockRejectedValue(new Error(STORAGE_PATH)); }],
    ['本文を読めない', () => arrange({ download: { data: { type: 'application/pdf', arrayBuffer: async () => { throw new Error(STORAGE_PATH); } }, error: null } })],
  ])('FREQ-530-AC-03: %s は 503 DOCUMENT_STORAGE_UNAVAILABLE。DB の関数は呼ばず、誤りに保存キーが無い', async (_name, setup) => {
    setup();
    const error = await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expect(rpc).not.toHaveBeenCalled();
    expectNoLeak(error);
  });

  test.each([
    ['先頭のバイトが拡張子の種類と違う', 'DOCUMENT_TYPE_UNSUPPORTED', blobOf(PNG, 'application/pdf')],
    ['置き場が記録した content-type が違う', 'DOCUMENT_TYPE_UNSUPPORTED', blobOf(PDF, 'image/png')],
    ['20 MiB を超える', 'DOCUMENT_TOO_LARGE', blobOf((() => { const big = new Uint8Array(20971521); big.set(PDF); return big; })())],
  ])('FREQ-530-AC-02: %s は 422 %s で、DB の関数は呼ばない', async (_name, code, blob) => {
    arrange({ download: { data: blob, error: null } });
    const error = await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, { ...input, sha256: null }));
    expect(error).toMatchObject({ status: 422, code });
    expect(rpc).not.toHaveBeenCalled();
    expectNoLeak(error);
  });

  test('FREQ-530-AC-02: 予約が当発注書の物でなければ（行が無い）409 RESERVATION_INVALID。置き場も DB の関数も触れない', async () => {
    arrange({ reservation: { data: [], error: null } });
    expect(await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input))).toMatchObject({ status: 409, code: 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID' });
    expect(bucket.download).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['GROUP_G_PO_DOCUMENT_RESERVATION_INVALID', '55000', 409, '保存の予約が見つかりません。もう一度ファイルを選んでください。'],
    ['GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', '55000', 409, 'この書類はすでに登録されています。'],
    ['GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID', '22023', 400, '差し替え元の書類を確かめてください。'],
    ['GROUP_G_FORBIDDEN', '42501', 403, '発注を扱う権限がありません。'],
    ['GROUP_G_PO_NOT_FOUND', 'P0002', 404, '発注書が見つかりません。'],
    ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  ])('FREQ-530-AC-02: DB の %s（%s）は表の状態 %i と本文で返す（確定）', async (message, sqlstate, status, body) => {
    arrange();
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER' } });
    const error = await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input));
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status, code: message, message: body });
  });

  test.each([
    ['戻りがオブジェクトでない', null],
    ['attachmentId が uuid でない', { ...dbResult, attachmentId: 'x' }],
    ['revisionNo が 1 でない', { ...dbResult, revisionNo: 2 }],
    ['replayed が真偽でない', { ...dbResult, replayed: 1 }],
  ])('FREQ-530-AC-02: DB の戻りが崩れている（%s）時は固定の500', async (_name, data) => {
    arrange();
    rpc.mockResolvedValue({ data, error: null });
    expect(await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input))).toMatchObject({ status: 500, message: '発注の記録に失敗しました' });
  });

  test('FREQ-530-AC-02: 予約の表がエラー・保存キーの形が違う時は固定の500', async () => {
    arrange({ reservation: { data: null, error: { message: 'PRIVATE-MARKER' } } });
    expect(await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input))).toMatchObject({ status: 500 });
    arrange({ reservation: { data: [{ storage_path: 'x' }], error: null } });
    expect(await failureOf(() => attachPurchaseOrderDocument(client, ACTOR_ID, input))).toMatchObject({ status: 500 });
  });
});

describe('revisePurchaseOrderDocument（訂正・無効化）', () => {
  const input = {
    purchaseOrderId: ORDER_ID, attachmentId: ATTACHMENT_ID, transactionDate: '2026-10-27', amountYen: 7000, currency: 'JPY' as const,
    counterparty: '工場B', voided: true, reason: '宛先の誤り', requestKey: REQUEST_KEY,
  };

  test('FREQ-530-AC-02: DB の関数を1回呼び、次の版の番号を返す', async () => {
    rpc.mockResolvedValue({ data: { attachmentId: ATTACHMENT_ID, revisionNo: 2, replayed: false }, error: null });
    expect(await revisePurchaseOrderDocument(client, ACTOR_ID, input)).toEqual({ attachmentId: ATTACHMENT_ID, revisionNo: 2, replayed: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_revise_purchase_order_document', {
      _attachment_id: ATTACHMENT_ID, _purchase_order_id: ORDER_ID, _transaction_date: '2026-10-27', _amount_yen: 7000, _currency: 'JPY',
      _counterparty: '工場B', _voided: true, _reason: '宛先の誤り', _actor_id: ACTOR_ID, _request_key: REQUEST_KEY,
    });
    expect(storageFrom).not.toHaveBeenCalled();
  });

  test.each([
    ['GROUP_G_PO_REASON_REQUIRED', '22023', 400, '理由を入力してください。'],
    ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
    ['GROUP_G_FORBIDDEN', '42501', 403, '発注を扱う権限がありません。'],
    ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  ])('FREQ-530-AC-02: DB の %s は表の状態と本文で返す', async (message, sqlstate, status, body) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate } });
    const error = await failureOf(() => revisePurchaseOrderDocument(client, ACTOR_ID, input));
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({ status, code: message, message: body });
  });

  test.each([
    ['戻りが空', null],
    ['revisionNo が 1 未満', { attachmentId: ATTACHMENT_ID, revisionNo: 0, replayed: false }],
    ['attachmentId が崩れている', { attachmentId: 1, revisionNo: 2, replayed: false }],
  ])('FREQ-530-AC-02: DB の戻りが崩れている（%s）時は固定の500', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    expect(await failureOf(() => revisePurchaseOrderDocument(client, ACTOR_ID, input))).toMatchObject({ status: 500, message: '発注の記録に失敗しました' });
  });
});

describe('createPurchaseOrderDocumentUrl（60秒の署名つきリンク）', () => {
  const input = { purchaseOrderId: ORDER_ID, attachmentId: ATTACHMENT_ID, download: false };

  function arrange(attachment: Result = { data: [{ storage_path: STORAGE_PATH, original_file_name: '請求書 10月.pdf' }], error: null }) {
    readableOrder();
    tables[ATTACHMENTS] = queryOf(attachment);
  }

  test('FREQ-540-AC-07: 最初に get_admin_purchase_order を実行者つきで呼び、42501 は 403・NULL は 404。表も置き場も見ない', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    expect(await failureOf(() => createPurchaseOrderDocumentUrl(client, ACTOR_ID, input))).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await failureOf(() => createPurchaseOrderDocumentUrl(client, ACTOR_ID, input))).toMatchObject({ status: 404, code: 'GROUP_G_PO_NOT_FOUND' });
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_admin_purchase_order', { _purchase_order_id: ORDER_ID, _actor_id: ACTOR_ID });
    expect(from).not.toHaveBeenCalled();
    expect(bucket.createSignedUrl).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 表示用は createSignedUrl(path, 60) で、ダウンロードの指定を付けない。{ url, expiresInSeconds: 60 } を返す', async () => {
    arrange();
    bucket.createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_VIEW }, error: null });
    expect(await createPurchaseOrderDocumentUrl(client, ACTOR_ID, input)).toEqual({ url: SIGNED_VIEW, expiresInSeconds: 60 });
    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrl.mock.calls[0]).toEqual([STORAGE_PATH, 60]);
    expect(tables[ATTACHMENTS].eq).toHaveBeenCalledWith('id', ATTACHMENT_ID);
    expect(tables[ATTACHMENTS].eq).toHaveBeenCalledWith('purchase_order_id', ORDER_ID);
  });

  test('FREQ-530-AC-03: ダウンロード用は原ファイル名つき（{ download: <原ファイル名> }）', async () => {
    arrange();
    bucket.createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_VIEW }, error: null });
    await createPurchaseOrderDocumentUrl(client, ACTOR_ID, { ...input, download: true });
    expect(bucket.createSignedUrl.mock.calls[0]).toEqual([STORAGE_PATH, 60, { download: '請求書 10月.pdf' }]);
  });

  test('FREQ-530-AC-03: 添付が無い（他の発注書の添付・存在しない id）は 404 DOCUMENT_NOT_FOUND。リンクは作らない', async () => {
    arrange({ data: [], error: null });
    expect(await failureOf(() => createPurchaseOrderDocumentUrl(client, ACTOR_ID, input))).toMatchObject({ status: 404, code: 'DOCUMENT_NOT_FOUND', message: '原本を取得できません。' });
    expect(bucket.createSignedUrl).not.toHaveBeenCalled();
  });

  test.each([
    ['置き場に無い（statusCode 404）', 404, 'DOCUMENT_NOT_FOUND', { data: null, error: { status: 400, statusCode: '404', message: STORAGE_PATH } }],
    ['置き場に無い（status 404）', 404, 'DOCUMENT_NOT_FOUND', { data: null, error: { status: 404 } }],
    ['置き場の不調', 503, 'DOCUMENT_STORAGE_UNAVAILABLE', { data: null, error: { status: 502, message: SIGNED_VIEW } }],
    ['リンクが返らない', 503, 'DOCUMENT_STORAGE_UNAVAILABLE', { data: {}, error: null }],
    ['リンクが空', 503, 'DOCUMENT_STORAGE_UNAVAILABLE', { data: { signedUrl: '' }, error: null }],
  ])('FREQ-530-AC-03: %s は %i %s。誤りに署名つきリンク・保存キーが無い', async (_name, status, code, response) => {
    arrange();
    bucket.createSignedUrl.mockResolvedValue(response);
    const error = await failureOf(() => createPurchaseOrderDocumentUrl(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status, code });
    expectNoLeak(error);
  });

  test('FREQ-530-AC-03: 置き場の呼び出しが例外でも 503 で、誤りに保存キーが無い', async () => {
    arrange();
    bucket.createSignedUrl.mockRejectedValue(new Error(STORAGE_PATH));
    const error = await failureOf(() => createPurchaseOrderDocumentUrl(client, ACTOR_ID, input));
    expect(error).toMatchObject({ status: 503, code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expectNoLeak(error);
  });

  test.each([
    ['表がエラー', { data: null, error: { message: 'PRIVATE-MARKER' } }],
    ['保存キーの形が違う', { data: [{ storage_path: 'x', original_file_name: 'a.pdf' }], error: null }],
    ['ファイル名が文字でない', { data: [{ storage_path: STORAGE_PATH, original_file_name: null }], error: null }],
  ])('FREQ-530-AC-03: 添付の表の %s は固定の500', async (_name, attachment) => {
    arrange(attachment);
    expect(await failureOf(() => createPurchaseOrderDocumentUrl(client, ACTOR_ID, input))).toMatchObject({ status: 500, message: '発注の記録に失敗しました' });
  });
});

describe('searchPurchaseOrderDocuments（検索）', () => {
  const filters: PurchaseOrderDocumentSearchFilters = {
    dateFrom: '2026-10-01', dateTo: '2026-10-31', amountMin: 1000, amountMax: 9000, counterparty: '工場', number: 'PO-2026', kind: 'invoice', includeHistory: true,
  };
  const dbRow = (total: number, overrides: Record<string, unknown> = {}) => ({
    total, attachment_id: ATTACHMENT_ID, purchase_order_id: ORDER_ID, purchase_order_number: 'PO-20261025-0001', kind: 'invoice',
    original_file_name: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, revision_no: 1, is_current: true,
    transaction_date: '2026-10-26', amount_yen: 6000, currency: 'JPY', counterparty: '工場A', voided: false, reason: null,
    replaces_attachment_id: null, created_at: '2026-10-26T03:00:00+00:00', ...overrides,
  });

  test('FREQ-530-AC-02: DB の関数を実行者つきで1回呼び、条件・50件・オフセットを渡して、行を camelCase にして返す', async () => {
    rpc.mockResolvedValue({ data: [dbRow(120), dbRow(120, { revision_no: 2, is_current: false })], error: null });
    const result = await searchPurchaseOrderDocuments(client, ACTOR_ID, { filters, page: 3 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_purchase_order_documents', {
      _date_from: '2026-10-01', _date_to: '2026-10-31', _amount_min: 1000, _amount_max: 9000, _counterparty: '工場', _purchase_order_number: 'PO-2026',
      _kind: 'invoice', _include_history: true, _limit: 50, _offset: 100, _actor_id: ACTOR_ID,
    });
    expect(result.total).toBe(120);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      attachmentId: ATTACHMENT_ID, purchaseOrderId: ORDER_ID, purchaseOrderNumber: 'PO-20261025-0001', kind: 'invoice', fileName: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 2048, revisionNo: 1, isCurrent: true, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY',
      counterparty: '工場A', voided: false, reason: null, replacesAttachmentId: null, createdAt: '2026-10-26T03:00:00+00:00',
    });
    expect(result.rows[1]).toMatchObject({ revisionNo: 2, isCurrent: false });
    expect(JSON.stringify(result)).not.toContain('storage_path');
  });

  test('FREQ-530-AC-02: 条件が空（null）でも通り、結果が空なら { rows: [], total: 0 }', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const empty: PurchaseOrderDocumentSearchFilters = { dateFrom: null, dateTo: null, amountMin: null, amountMax: null, counterparty: null, number: null, kind: null, includeHistory: false };
    expect(await searchPurchaseOrderDocuments(client, ACTOR_ID, { filters: empty, page: 1 })).toEqual({ rows: [], total: 0 });
    expect(rpc).toHaveBeenCalledWith('search_purchase_order_documents', expect.objectContaining({ _date_from: null, _kind: null, _include_history: false, _offset: 0 }));
  });

  test('FREQ-540-AC-07: DB が 42501 で断ると 403 の PurchaseOrderError。他の失敗は PURCHASE_ORDER_READ_FAILED の Error（生の文は持たない）', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    expect(await failureOf(() => searchPurchaseOrderDocuments(client, ACTOR_ID, { filters, page: 1 }))).toMatchObject({ status: 403, code: 'GROUP_G_FORBIDDEN' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'PRIVATE-MARKER', code: 'XX000' } });
    await expect(searchPurchaseOrderDocuments(client, ACTOR_ID, { filters, page: 1 })).rejects.toThrow(/^PURCHASE_ORDER_READ_FAILED$/);
    rpc.mockRejectedValueOnce(new Error('PRIVATE-MARKER'));
    await expect(searchPurchaseOrderDocuments(client, ACTOR_ID, { filters, page: 1 })).rejects.toThrow(/^PURCHASE_ORDER_READ_FAILED$/);
  });

  test.each([
    ['戻りが配列でない', { not: 'array' }],
    ['行が崩れている（kind）', [dbRow(1, { kind: 'memo' })]],
    ['total が負', [dbRow(-1)]],
    ['total が行数より少ない', [dbRow(1), dbRow(1, { revision_no: 2 })]],
    ['行ごとの total が食い違う', [dbRow(2), dbRow(3, { revision_no: 2 })]],
    ['同じ添付・同じ版が重なる', [dbRow(2), dbRow(2)]],
    ['行が文字', ['x']],
  ])('FREQ-530-AC-02: %s は読み違いとして PURCHASE_ORDER_READ_FAILED', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(searchPurchaseOrderDocuments(client, ACTOR_ID, { filters, page: 1 })).rejects.toThrow(/^PURCHASE_ORDER_READ_FAILED$/);
  });
});
