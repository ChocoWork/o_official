const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
}));

import {
  checkPurchaseOrderDocumentFile,
  fetchPurchaseOrderDocumentUrl,
  PURCHASE_ORDER_DOCUMENT_ACCEPT,
  resumePurchaseOrderDocument,
  uploadPurchaseOrderDocument,
} from '@/lib/purchase-orders/purchase-order-documents-client';
import { ATTACHMENT_ID, ORDER_ID, RESERVATION_ID } from './purchase-order-fixtures';

// 試験用の決まった値。本物の署名つきの送り先ではない
const SIGNED_URL = 'https://storage.example.test/put-target-SECRET';
const HASH = 'ab'.repeat(32);
const META = { transactionDate: '2026-10-26', amountYen: 6000, counterparty: '工場A' };
const UPLOAD_META = { ...META, replacesAttachmentId: null };
const BASE = `/api/admin/purchase-orders/${ORDER_ID}/attachments`;
const UPLOAD_URL = `${BASE}/reservations/${RESERVATION_ID}/upload-url`;
const REJECTED = 'このファイルは保存できませんでした。PDF・JPEG・PNG の正しいファイルを選び直して、新しく保存してください。';
const events: string[] = [];

// 種類ごとの先頭のバイト（本物のファイルの頭）
const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const headOf = (name: string): number[] => (/\.pdf$/i.test(name) ? PDF_HEAD : /\.jpe?g$/i.test(name) ? JPEG_HEAD : /\.png$/i.test(name) ? PNG_HEAD : [0x68, 0x69]);

/** 先頭のバイトは本物。size だけは 20 MiB の配列を作らずに決める */
function fileWith(name: string, type: string, head: number[], size?: number): File {
  const file = new File([new Uint8Array(head)], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
  return file;
}
const fileOf = (name: string, type: string, size?: number): File => fileWith(name, type, headOf(name), size);

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const digest = jest.fn();
const fetchMock = jest.fn();
let keyCount = 0;

beforeEach(() => {
  jest.resetAllMocks();
  events.length = 0;
  keyCount = 0;
  digest.mockImplementation(async () => { events.push('digest'); return new Uint8Array(32).fill(0xab).buffer; });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { subtle: { digest }, randomUUID: () => `00000000-0000-4000-8000-${String(++keyCount).padStart(12, '0')}` },
  });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchMock });
  fetchMock.mockImplementation(async () => { events.push('put'); return { ok: true, status: 200 } as Response; });
});

/** clientFetch の代役: 窓口ごとの返事を順に返す（無ければ失敗） */
function route(handlers: { reserve?: Response | Error; uploadUrl?: Response | Error; attach?: Response | Error }) {
  mockClientFetch.mockImplementation(async (url: string) => {
    const kind = url.endsWith('/upload-url') ? 'uploadUrl' : url.endsWith('/reservations') ? 'reserve' : url === BASE ? 'attach' : 'unknown';
    events.push(kind);
    const handler = handlers[kind as keyof typeof handlers];
    if (handler === undefined) throw new Error(`unexpected ${url}`);
    if (handler instanceof Error) throw handler;
    return handler;
  });
}

const reserved = () => json({ reservationId: RESERVATION_ID, signedUrl: SIGNED_URL, expiresAt: '2026-10-27T00:00:00+00:00', replayed: false }, 201);
const attached = () => json({ attachmentId: ATTACHMENT_ID, revisionNo: 1, replayed: false }, 201);
const callsTo = (url: string) => mockClientFetch.mock.calls.filter(([target]) => target === url);
const bodyOf = (call: unknown[]): Record<string, unknown> => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
const attachBody = (callIndex: number): Record<string, unknown> => bodyOf(callsTo(BASE)[callIndex]);
const reserveBody = (callIndex: number): Record<string, unknown> => bodyOf(callsTo(`${BASE}/reservations`)[callIndex]);
const noSecret = (value: unknown) => expect(JSON.stringify(value)).not.toContain('SECRET');

describe('checkPurchaseOrderDocumentFile（送る前の確かめ）', () => {
  test.each([
    ['PDF', fileOf('a.pdf', 'application/pdf'), null],
    ['JPEG（種類が空でも拡張子から）', fileOf('a.JPG', ''), null],
    ['JPEG（jpeg）', fileOf('a.jpeg', 'image/jpeg'), null],
    ['PNG', fileOf('a.png', 'image/png'), null],
    ['ブラウザが分からない種類（octet-stream）でも拡張子と先頭が合えば', fileOf('a.pdf', 'application/octet-stream'), null],
    ['20 MiB ちょうど', fileOf('a.pdf', 'application/pdf', 20971520), null],
    ['20 MiB を超える', fileOf('a.pdf', 'application/pdf', 20971521), 'ファイルは 20 MiB までです。'],
    ['空のファイル', fileOf('a.pdf', 'application/pdf', 0), 'PDF・JPEG・PNG のファイルを選んでください。'],
    ['拡張子が合わない（txt）', fileOf('a.txt', 'text/plain'), 'PDF・JPEG・PNG のファイルを選んでください。'],
    ['拡張子が無い', fileWith('scan', 'application/pdf', PDF_HEAD), 'PDF・JPEG・PNG のファイルを選んでください。'],
  ])('FREQ-530-AC-02: %s', async (_name, file, expected) => {
    expect(await checkPurchaseOrderDocumentFile(file)).toBe(expected);
  });

  test.each([
    ['PDF の名前で中身が PNG', fileWith('fake.pdf', '', PNG_HEAD)],
    ['PNG の名前で中身が PDF', fileWith('fake.png', 'image/png', PDF_HEAD)],
    ['JPEG の名前で中身が文字', fileWith('fake.jpg', '', [0x68, 0x65, 0x6c, 0x6c, 0x6f])],
    ['PDF の名前で先頭が短すぎる（%PD だけ）', fileWith('short.pdf', '', [0x25, 0x50, 0x44])],
    ['PDF の名前でブラウザの種類が PNG', fileWith('a.pdf', 'image/png', PDF_HEAD)],
  ])('FREQ-530-AC-02: 先頭のバイトまたは種類が拡張子と合わない（%s）ファイルは、置き場に置く前に断る', async (_name, file) => {
    expect(await checkPurchaseOrderDocumentFile(file)).toBe('PDF・JPEG・PNG のファイルを選んでください。');
  });

  test('FREQ-530-AC-02: 続きから保存で選び直すファイルは、予約の種類（expectedMime）の中身でなければ断る。名前は見ない', async () => {
    const mismatch = '予約したファイルと同じ種類のファイルを選んでください。';
    expect(await checkPurchaseOrderDocumentFile(fileOf('scan.png', 'image/png'), 'application/pdf')).toBe(mismatch);
    expect(await checkPurchaseOrderDocumentFile(fileWith('x.pdf', '', PNG_HEAD), 'application/pdf')).toBe(mismatch);
    expect(await checkPurchaseOrderDocumentFile(fileWith('whatever.png', '', PDF_HEAD), 'application/pdf')).toBeNull();
    expect(await checkPurchaseOrderDocumentFile(fileWith('x.pdf', 'application/pdf', PDF_HEAD), 'application/pdf')).toBeNull();
    expect(await checkPurchaseOrderDocumentFile(fileWith('x.jpg', 'image/jpeg', JPEG_HEAD), 'image/png')).toBe(mismatch);
    // 空・大きすぎは予約の種類の文より先に断る
    expect(await checkPurchaseOrderDocumentFile(fileOf('a.pdf', 'application/pdf', 0), 'application/pdf')).toBe('PDF・JPEG・PNG のファイルを選んでください。');
    expect(await checkPurchaseOrderDocumentFile(fileOf('a.pdf', 'application/pdf', 20971521), 'application/pdf')).toBe('ファイルは 20 MiB までです。');
  });

  test('FREQ-530-AC-02: ファイルの先頭を読めない時は、置き場に置かず断る（例外にしない）', async () => {
    const file = fileOf('a.pdf', 'application/pdf');
    jest.spyOn(file, 'slice').mockImplementation(() => { throw new Error('unreadable'); });
    expect(await checkPurchaseOrderDocumentFile(file)).toBe('PDF・JPEG・PNG のファイルを選んでください。');
  });

  test('FREQ-530-AC-02: ファイルを選ぶ欄の accept は PDF・JPEG・PNG', () => {
    expect(PURCHASE_ORDER_DOCUMENT_ACCEPT).toBe('application/pdf,image/jpeg,image/png');
  });
});

describe('fetchPurchaseOrderDocumentUrl（原本を開く60秒の署名つきリンク）', () => {
  const VIEW_URL = 'https://storage.example.test/object/sign/purchase-order-documents/SECRET-VIEW-TOKEN';

  test('FREQ-530-AC-03: 表示用は …/attachments/[attachmentId]/url、ダウンロードは ?download=1。どちらも no-store で GET し、リンクを返す', async () => {
    mockClientFetch.mockResolvedValue(json({ url: VIEW_URL, expiresInSeconds: 60 }));
    expect(await fetchPurchaseOrderDocumentUrl(ORDER_ID, ATTACHMENT_ID, false)).toEqual({ ok: true, url: VIEW_URL });
    expect(await fetchPurchaseOrderDocumentUrl(ORDER_ID, ATTACHMENT_ID, true)).toEqual({ ok: true, url: VIEW_URL });
    expect(mockClientFetch.mock.calls).toEqual([
      [`${BASE}/${ATTACHMENT_ID}/url`, { cache: 'no-store' }],
      [`${BASE}/${ATTACHMENT_ID}/url?download=1`, { cache: 'no-store' }],
    ]);
  });

  test.each([
    ['置き場に無い（404）', json({ code: 'DOCUMENT_NOT_FOUND', error: 'x' }, 404), '原本を取得できません。'],
    ['置き場の不調（503）', json({ code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'x' }, 503), 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
    ['権限が無い（403）', json({ code: 'GROUP_G_FORBIDDEN', error: 'x' }, 403), '発注を扱う権限がありません。'],
    ['ログインが切れた（401）', json({ error: 'Unauthorized' }, 401), 'ログインし直してください。'],
    ['成功の応答に url が無い', json({}), '原本を取得できません。'],
    ['成功の応答の url が空', json({ url: '' }), '原本を取得できません。'],
    ['成功の応答が JSON でない', { ok: true, status: 200, json: async () => { throw new Error('x'); } } as unknown as Response, '原本を取得できません。'],
  ])('FREQ-530-AC-03: リンクをもらえない（%s）時は { ok: false, message }。リンクは文に出ない', async (_name, response, message) => {
    mockClientFetch.mockResolvedValue(response);
    const result = await fetchPurchaseOrderDocumentUrl(ORDER_ID, ATTACHMENT_ID, false);
    expect(result).toEqual({ ok: false, message });
    noSecret(result);
  });

  test('FREQ-530-AC-03: 通信が失敗した時は「原本を取得できません。」', async () => {
    mockClientFetch.mockRejectedValue(new Error(`network ${VIEW_URL}`));
    const result = await fetchPurchaseOrderDocumentUrl(ORDER_ID, ATTACHMENT_ID, false);
    expect(result).toEqual({ ok: false, message: '原本を取得できません。' });
    noSecret(result);
  });
});

describe('uploadPurchaseOrderDocument（確かめ → SHA-256 → 予約 → PUT → 確定）', () => {
  const file = fileOf('invoice.pdf', 'application/pdf');
  const input = { purchaseOrderId: ORDER_ID, file, kind: 'invoice' as const, meta: UPLOAD_META };

  test('FREQ-530-AC-02: 順は ハッシュ → 予約 → 署名つきの送り先へ PUT → 確定。成功は { kind: ok, attachmentId }', async () => {
    route({ reserve: reserved(), attach: attached() });
    expect(await uploadPurchaseOrderDocument(input)).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(events).toEqual(['digest', 'reserve', 'put', 'attach']);
    expect(digest).toHaveBeenCalledWith('SHA-256', expect.anything());
  });

  test('FREQ-530-AC-02: 予約の本文は 種類・ファイル名・差し替え元・要求番号。確定の本文は 予約 ID・ブラウザのハッシュ・取引日・金額・通貨・取引先・要求番号で、差し替え元は含まない（予約に残る）', async () => {
    route({ reserve: reserved(), attach: attached() });
    await uploadPurchaseOrderDocument({ ...input, meta: { ...UPLOAD_META, replacesAttachmentId: ATTACHMENT_ID } });
    expect(mockClientFetch.mock.calls[0][0]).toBe(`${BASE}/reservations`);
    expect(mockClientFetch.mock.calls[0][1].method).toBe('POST');
    expect(reserveBody(0)).toEqual({ kind: 'invoice', fileName: 'invoice.pdf', replacesAttachmentId: ATTACHMENT_ID, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(attachBody(0)).toEqual({
      reservationId: RESERVATION_ID, sha256: HASH, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY', counterparty: '工場A',
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(Object.keys(attachBody(0))).not.toContain('replacesAttachmentId');
  });

  test('FREQ-530-AC-02: 新しい書類（差し替えでない）の予約は replacesAttachmentId: null', async () => {
    route({ reserve: reserved(), attach: attached() });
    await uploadPurchaseOrderDocument(input);
    expect(reserveBody(0).replacesAttachmentId).toBeNull();
  });

  test('FREQ-530-AC-02: PUT は署名つきの送り先へ PUT・content-type は拡張子の種類・x-upsert: false・本文はファイルそのもの', async () => {
    route({ reserve: reserved(), attach: attached() });
    await uploadPurchaseOrderDocument(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: file });
  });

  test('FREQ-530-AC-02: ブラウザが種類を渡さないファイルは拡張子から content-type を決める（jpg は image/jpeg）', async () => {
    route({ reserve: reserved(), attach: attached() });
    await uploadPurchaseOrderDocument({ ...input, file: fileOf('photo.JPG', '') });
    expect(fetchMock.mock.calls[0][1].headers['content-type']).toBe('image/jpeg');
  });

  test.each([
    ['大きすぎる', fileOf('a.pdf', 'application/pdf', 20971521), 'ファイルは 20 MiB までです。'],
    ['拡張子が合わない', fileOf('a.txt', 'text/plain'), 'PDF・JPEG・PNG のファイルを選んでください。'],
    ['先頭のバイトが拡張子の種類と違う（PDF の名前で中身が PNG）', fileWith('a.pdf', 'application/pdf', PNG_HEAD), 'PDF・JPEG・PNG のファイルを選んでください。'],
    ['ブラウザの種類が拡張子と違う', fileWith('a.pdf', 'image/png', PDF_HEAD), 'PDF・JPEG・PNG のファイルを選んでください。'],
  ])('FREQ-530-AC-02: ファイルが%sと、何も送らず（予約も作らず）{ kind: error }', async (_name, bad, message) => {
    expect(await uploadPurchaseOrderDocument({ ...input, file: bad })).toEqual({ kind: 'error', message });
    expect(mockClientFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 予約が断られた（403・503・通信の失敗）時は PUT せず { kind: error }。表の文を出す', async () => {
    route({ reserve: json({ code: 'GROUP_G_FORBIDDEN', error: 'x' }, 403) });
    expect(await uploadPurchaseOrderDocument(input)).toEqual({ kind: 'error', message: '発注を扱う権限がありません。' });
    route({ reserve: json({ code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'x' }, 503) });
    expect(await uploadPurchaseOrderDocument(input)).toEqual({ kind: 'error', message: 'ファイルの保存先に接続できません。時間をおいて再度お試しください。' });
    route({ reserve: new Error('network') });
    expect(await uploadPurchaseOrderDocument(input)).toEqual({ kind: 'error', message: '発注の記録に失敗しました' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 予約の要求番号は、予約を取れなかった（5xx・通信の失敗）後の送り直しで同じ番号を使い（同じ予約を受け取り、予約が増えない）、予約が取れたら・確定した断り（4xx）の後は新しい番号にする', async () => {
    const fresh = fileOf('retry.pdf', 'application/pdf');
    route({ reserve: json({ code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'x' }, 503) });
    await uploadPurchaseOrderDocument({ ...input, file: fresh });
    route({ reserve: new Error('network') });
    await uploadPurchaseOrderDocument({ ...input, file: fresh });
    route({ reserve: reserved(), attach: attached() });
    await uploadPurchaseOrderDocument({ ...input, file: fresh });
    const keys = callsTo(`${BASE}/reservations`).map((call) => bodyOf(call).requestKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);

    // 予約が取れた後の同じ書類は新しい番号
    route({ reserve: reserved(), attach: attached() });
    await uploadPurchaseOrderDocument({ ...input, file: fresh });
    expect(callsTo(`${BASE}/reservations`).map((call) => bodyOf(call).requestKey).at(-1)).not.toBe(keys[0]);

    // 確定した断り（4xx）の後も新しい番号
    const other = fileOf('other.pdf', 'application/pdf');
    route({ reserve: json({ code: 'GROUP_G_ARGUMENT_INVALID', error: 'x' }, 400) });
    await uploadPurchaseOrderDocument({ ...input, file: other });
    await uploadPurchaseOrderDocument({ ...input, file: other });
    const otherKeys = callsTo(`${BASE}/reservations`).slice(-2).map((call) => bodyOf(call).requestKey);
    expect(otherKeys[0]).not.toBe(otherKeys[1]);

    // 別の書類（ファイル名・種類・差し替え元が違う）は別の番号
    route({ reserve: json({ error: 'x' }, 503) });
    await uploadPurchaseOrderDocument({ ...input, file: fileOf('third.pdf', 'application/pdf') });
    await uploadPurchaseOrderDocument({ ...input, file: fileOf('third.pdf', 'application/pdf'), kind: 'quote' });
    const thirdKeys = callsTo(`${BASE}/reservations`).slice(-2).map((call) => bodyOf(call).requestKey);
    expect(thirdKeys[0]).not.toBe(thirdKeys[1]);
  });

  test.each([
    ['予約の応答に予約 ID が無い', json({ signedUrl: SIGNED_URL }, 201)],
    ['予約の応答に送り先が無い', json({ reservationId: RESERVATION_ID }, 201)],
    ['予約の応答が JSON でない', { ok: true, status: 201, json: async () => { throw new Error('x'); } } as unknown as Response],
  ])('FREQ-530-AC-03: %s 時は PUT せず { kind: error }', async (_name, response) => {
    route({ reserve: response });
    expect(await uploadPurchaseOrderDocument(input)).toMatchObject({ kind: 'error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['置き場が失敗の状態を返す', () => fetchMock.mockImplementation(async () => ({ ok: false, status: 400 }))],
    ['置き場への通信が失敗', () => fetchMock.mockRejectedValue(new Error(`boom ${SIGNED_URL}`))],
  ])('FREQ-530-AC-03: PUT の失敗（%s）は予約 ID つきの pending。確定は呼ばず、文に署名つきの送り先が無い', async (_name, arrange) => {
    route({ reserve: reserved() });
    arrange();
    const result = await uploadPurchaseOrderDocument(input);
    expect(result).toEqual({ kind: 'pending', reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' });
    expect(events).not.toContain('attach');
    noSecret(result);
  });

  test('FREQ-530-AC-03: 確定が断られた・通信が失敗した時は、置き場には保存済みなので予約 ID つきの pending（表の文）', async () => {
    route({ reserve: reserved(), attach: json({ code: 'DOCUMENT_HASH_MISMATCH', error: 'x' }, 422) });
    expect(await uploadPurchaseOrderDocument(input)).toEqual({
      kind: 'pending', reservationId: RESERVATION_ID, message: 'アップロードしたファイルの内容が一致しません。もう一度アップロードしてください。',
    });
    route({ reserve: reserved(), attach: new Error(`network ${SIGNED_URL}`) });
    const lost = await uploadPurchaseOrderDocument(input);
    expect(lost).toEqual({ kind: 'pending', reservationId: RESERVATION_ID, message: '発注の記録に失敗しました' });
    noSecret(lost);
  });

  test('FREQ-530-AC-03: 確定が種類の検査で断られた（DOCUMENT_TYPE_UNSUPPORTED）時は、続きから保存では通らないので rejected（予約 ID と「正しいファイルを選び直して新しく保存」の文）', async () => {
    route({ reserve: reserved(), attach: json({ code: 'DOCUMENT_TYPE_UNSUPPORTED', error: 'x' }, 422) });
    expect(await uploadPurchaseOrderDocument(input)).toEqual({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
  });

  test('FREQ-530-AC-03: 確定の応答に添付 ID が無ければ成功にせず pending', async () => {
    route({ reserve: reserved(), attach: json({ revisionNo: 1 }, 201) });
    expect(await uploadPurchaseOrderDocument(input)).toMatchObject({ kind: 'pending', reservationId: RESERVATION_ID });
  });
});

describe('resumePurchaseOrderDocument（続きから保存）', () => {
  const file = fileOf('invoice.pdf', 'application/pdf');
  const resume = (overrides: Record<string, unknown> = {}) => resumePurchaseOrderDocument({
    purchaseOrderId: ORDER_ID, reservationId: RESERVATION_ID, reservationFileName: 'invoice.pdf', file, meta: META, ...overrides,
  } as Parameters<typeof resumePurchaseOrderDocument>[0]);

  test('FREQ-530-AC-03: PUT 失敗 → 続きから保存 → ファイルが無ければ needs_file → 選び直して PUT → sha256 つきで確定', async () => {
    route({ uploadUrl: json({ uploaded: false, signedUrl: SIGNED_URL }), attach: attached() });
    expect(await resume({ file: null })).toEqual({ kind: 'needs_file', reservationId: RESERVATION_ID });
    expect(events).toEqual(['uploadUrl']);
    expect(fetchMock).not.toHaveBeenCalled();

    events.length = 0;
    expect(await resume()).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(events).toEqual(['uploadUrl', 'digest', 'put', 'attach']);
    expect(mockClientFetch.mock.calls[1][0]).toBe(UPLOAD_URL);
    expect(mockClientFetch.mock.calls[1][1]).toEqual({ method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: file });
    expect(attachBody(0)).toMatchObject({ reservationId: RESERVATION_ID, sha256: HASH });
  });

  test('FREQ-530-AC-03: 差し替えの関係は予約に残っているので、続きから保存の確定には含めない（頁を読み直した後でも同じ）', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: attached() });
    await resume({ file: null });
    expect(Object.keys(attachBody(0)).sort()).toEqual(['amountYen', 'counterparty', 'currency', 'requestKey', 'reservationId', 'sha256', 'transactionDate']);
    route({ uploadUrl: json({ uploaded: false, signedUrl: SIGNED_URL }), attach: attached() });
    await resume();
    expect(Object.keys(attachBody(1))).not.toContain('replacesAttachmentId');
    expect(Object.keys(attachBody(1))).not.toContain('replaces');
  });

  test('FREQ-530-AC-03: ページを読み直した後の再開: 置き場に保存済み（uploaded: true）でファイルが手元に無ければ、PUT せず sha256: null で確定する', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: attached() });
    expect(await resume({ file: null })).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(events).toEqual(['uploadUrl', 'attach']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(attachBody(0)).toMatchObject({ reservationId: RESERVATION_ID, sha256: null, transactionDate: '2026-10-26', amountYen: 6000, counterparty: '工場A' });
  });

  test('FREQ-530-AC-03: 置き場に保存済み（uploaded: true）でファイルを選んだ時は、PUT を省いてそのファイルのハッシュで確定する', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: attached() });
    expect(await resume()).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(events).toEqual(['uploadUrl', 'digest', 'attach']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attachBody(0)).toMatchObject({ sha256: HASH });
  });

  test('FREQ-530-AC-03: 置き場に保存済みで確定が失敗 → 再開は PUT を省いて確定し、同じ内容なら同じ要求番号で送る（DB が前の結果を返せる）', async () => {
    route({ reserve: reserved(), attach: new Error('lost response') });
    const first = await uploadPurchaseOrderDocument({ purchaseOrderId: ORDER_ID, file, kind: 'invoice', meta: UPLOAD_META });
    expect(first).toMatchObject({ kind: 'pending', reservationId: RESERVATION_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    route({ uploadUrl: json({ uploaded: true }), attach: attached() });
    expect(await resume()).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attachBody(1).requestKey).toBe(attachBody(0).requestKey);
  });

  test('FREQ-530-AC-03: 内容（取引日・金額・取引先・ハッシュ）が変わった再開は新しい要求番号', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: json({ code: 'GROUP_G_ARGUMENT_INVALID', error: 'x' }, 400) });
    expect(await resume({ meta: { ...META, amountYen: 100 } })).toMatchObject({ kind: 'pending' });
    expect(await resume({ meta: { ...META, amountYen: 100 } })).toMatchObject({ kind: 'pending' });
    expect(await resume({ meta: { ...META, amountYen: 200 } })).toMatchObject({ kind: 'pending' });
    const keys = [0, 1, 2].map((index) => attachBody(index).requestKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test('FREQ-530-AC-03: 送り先を出し直す窓口の断り（予約なし・添付済み・権限）は { kind: error } で、表の文を出す。確定は呼ばない', async () => {
    for (const [code, status, message] of [
      ['GROUP_G_PO_DOCUMENT_RESERVATION_INVALID', 409, '保存の予約が見つかりません。もう一度ファイルを選んでください。'],
      ['GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', 409, 'この書類はすでに登録されています。'],
      ['GROUP_G_FORBIDDEN', 403, '発注を扱う権限がありません。'],
    ] as const) {
      route({ uploadUrl: json({ code, error: 'x' }, status) });
      expect(await resume()).toEqual({ kind: 'error', message });
    }
    route({ uploadUrl: new Error('network') });
    expect(await resume()).toEqual({ kind: 'error', message: '発注の記録に失敗しました' });
    expect(events).not.toContain('attach');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['応答に uploaded が無い', json({})],
    ['送り先が無い', json({ uploaded: false })],
  ])('FREQ-530-AC-03: %s 時は { kind: error }', async (_name, response) => {
    route({ uploadUrl: response });
    expect(await resume()).toMatchObject({ kind: 'error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 選び直したファイルが種類・大きさ・中身で合わない時は error（窓口も置き場も呼ばない）、PUT が失敗した時は pending（確定は呼ばない）', async () => {
    route({ uploadUrl: json({ uploaded: false, signedUrl: SIGNED_URL }), attach: attached() });
    expect(await resume({ file: fileOf('a.txt', 'text/plain') })).toMatchObject({ kind: 'error' });
    expect(await resume({ file: fileWith('a.pdf', '', PNG_HEAD) })).toEqual({ kind: 'error', message: '予約したファイルと同じ種類のファイルを選んでください。' });
    expect(mockClientFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const result = await resume();
    expect(result).toEqual({ kind: 'pending', reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' });
    expect(events).not.toContain('attach');
    noSecret(result);
  });

  test('FREQ-530-AC-03: 選び直したファイルが予約の種類（保存キーの拡張子）と違えば、置き場に置く前に断る。名前でなく中身で見る（PDF の予約に PNG は不可・PDF の中身なら名前が違っても可）', async () => {
    route({ uploadUrl: json({ uploaded: false, signedUrl: SIGNED_URL }), attach: attached() });
    const png = fileOf('scan.png', 'image/png');
    expect(await resume({ file: png })).toEqual({ kind: 'error', message: '予約したファイルと同じ種類のファイルを選んでください。' });
    expect(await resume({ file: png, reservationFileName: 'scan.png' })).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(fetchMock).toHaveBeenCalledWith(SIGNED_URL, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-upsert': 'false' }, body: png });
    fetchMock.mockClear();
    const renamed = fileWith('copy-of-quote.PDF', '', PDF_HEAD);
    expect(await resume({ file: renamed, reservationFileName: 'quote.pdf' })).toEqual({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    expect(fetchMock.mock.calls[0][1].headers['content-type']).toBe('application/pdf');
  });

  test('FREQ-530-AC-03: 予約のファイル名の拡張子が許す物でなければ（崩れた予約）、何も送らず error', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: attached() });
    expect(await resume({ reservationFileName: 'invoice' })).toEqual({ kind: 'error', message: '発注の記録に失敗しました' });
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 置き場のファイルが種類の検査に通らない予約（uploaded: true → 確定が DOCUMENT_TYPE_UNSUPPORTED）は rejected。何度続きから保存しても通らない行き止まりを、新しい予約への案内に変える', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: json({ code: 'DOCUMENT_TYPE_UNSUPPORTED', error: 'x' }, 422) });
    expect(await resume({ file: null })).toEqual({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
    expect(await resume()).toEqual({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
  });

  test('FREQ-530-AC-03: 確定が成功したら { kind: ok }。置き場の送り先は文にも結果にも出さない', async () => {
    route({ uploadUrl: json({ uploaded: false, signedUrl: SIGNED_URL }), attach: attached() });
    noSecret(await resume());
  });

  test('FREQ-530-AC-03: 確定の応答が 409（別の要求番号で二重に確定した）の時は pending で表の文を出す', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: json({ code: 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', error: 'x' }, 409) });
    expect(await resume()).toEqual({ kind: 'pending', reservationId: RESERVATION_ID, message: 'この書類はすでに登録されています。' });
  });

  test('FREQ-530-AC-03: ハッシュの計算が失敗したら { kind: error }（ファイルを選んだ時だけ）', async () => {
    route({ uploadUrl: json({ uploaded: true }), attach: attached() });
    digest.mockRejectedValue(new Error('no crypto'));
    expect(await resume()).toEqual({ kind: 'error', message: '発注の記録に失敗しました' });
    expect(events).not.toContain('attach');
    route({ uploadUrl: json({ uploaded: false, signedUrl: SIGNED_URL }), attach: attached() });
    expect(await resume()).toEqual({ kind: 'error', message: '発注の記録に失敗しました' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
