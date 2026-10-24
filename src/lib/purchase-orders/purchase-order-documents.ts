import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  callWriter,
  getAdminPurchaseOrder,
  PurchaseOrderError,
  readFailure,
} from './purchase-order-store';
import {
  hasPurchaseOrderDocumentSignature,
  parsePurchaseOrderDocumentSearchRow,
  PURCHASE_ORDER_DOCUMENT_ERRORS,
  PURCHASE_ORDER_DOCUMENT_MAX_BYTES,
  PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
  purchaseOrderDocumentMimeOfName,
  type PurchaseOrderDocumentMime,
  type PurchaseOrderDocumentAttached,
  type PurchaseOrderDocumentAttachInput,
  type PurchaseOrderDocumentReserved,
  type PurchaseOrderDocumentReserveInput,
  type PurchaseOrderDocumentRevised,
  type PurchaseOrderDocumentReviseInput,
  type PurchaseOrderDocumentSearchFilters,
  type PurchaseOrderDocumentSearchRow,
  type PurchaseOrderDocumentUploadUrl,
  type PurchaseOrderDocumentUploadUrlInput,
  type PurchaseOrderDocumentUrl,
  type PurchaseOrderDocumentUrlInput,
} from './purchase-order-types';

/**
 * 取引書類の原本（見積書・請求書 / G-2 Task 8・FREQ-530）の置き場と DB の間を結ぶ。サーバーだけで使う。
 * 呼ぶ側は service_role のクライアントと、認可結果の userId を渡す。非公開の入れ物 purchase-order-documents の読み書きと、
 * 予約・添付・版の表の照会（service_role の SELECT だけ）を、DB の関数の前後に置く。DB の取引の中では置き場を使わない。
 *
 * 署名つきの送り先・リンクは、それを頼んだ本人への応答にだけ載せる。保存キー（storage_path）とファイルの中身は、投げる誤りにも戻りにも入れない。
 * 置き場や DB の思いがけない失敗は固定の文の PurchaseOrderError にする。
 */
export const PURCHASE_ORDER_DOCUMENT_BUCKET = 'purchase-order-documents';
/** 閲覧・ダウンロードの署名つきリンクの有効な長さ（秒） */
export const PURCHASE_ORDER_DOCUMENT_URL_SECONDS = 60;

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORAGE_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|jpg|jpeg|png))$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 原本の誤り（DB の前に store が投げる）。状態と本文は PURCHASE_ORDER_DOCUMENT_ERRORS の表のとおり */
function documentError(code: keyof typeof PURCHASE_ORDER_DOCUMENT_ERRORS): PurchaseOrderError {
  return new PurchaseOrderError(PURCHASE_ORDER_DOCUMENT_ERRORS[code][0], code);
}

/** 保存キーを「発注書の id」と「オブジェクト名（<uuid>.<拡張子>）」に分ける。形が違えば固定の失敗 */
function splitStoragePath(storagePath: unknown): { folder: string; objectName: string } {
  const match = typeof storagePath === 'string' ? STORAGE_PATH.exec(storagePath) : null;
  if (match === null) throw new PurchaseOrderError();
  return { folder: match[1], objectName: match[2] };
}

/**
 * 置き場の「無い」の応答か。署名つきの送り先に送られていない物は、404 か、statusCode が '404' の応答になる
 * （返品写真の確かめと同じ見方）。置き場の不調と分ける。
 */
function isNotFound(error: unknown): boolean {
  const { status, statusCode } = (isObject(error) ? error : {}) as { status?: unknown; statusCode?: unknown };
  return status === 404 || statusCode === '404' || statusCode === 404;
}

/**
 * ファイルのバイトを共通の値の検査(1)〜(4)にかけ、種類・大きさ・SHA-256 を返す。(1) ファイル名の拡張子が pdf / jpg / jpeg / png、
 * (2) 先頭のバイトが拡張子の種類と同じ、(3) 置き場が記録した content-type（あれば）が同じ、(4) 大きさが 20 MiB 以下。
 * 合わなければ DOCUMENT_TYPE_UNSUPPORTED（(1)〜(3)）か DOCUMENT_TOO_LARGE（(4)）。画像の再圧縮・変換はしない。
 */
export function inspectDocumentBytes(
  bytes: Uint8Array,
  declared: { fileName: string; contentType: string | null },
): { mimeType: PurchaseOrderDocumentMime; sizeBytes: number; sha256: string } {
  const mimeType = purchaseOrderDocumentMimeOfName(declared.fileName);
  if (mimeType === null) throw documentError('DOCUMENT_TYPE_UNSUPPORTED');
  if (!hasPurchaseOrderDocumentSignature(bytes, mimeType)) throw documentError('DOCUMENT_TYPE_UNSUPPORTED');
  const recorded = declared.contentType?.split(';')[0].trim().toLowerCase() ?? '';
  if (recorded !== '' && recorded !== mimeType) throw documentError('DOCUMENT_TYPE_UNSUPPORTED');
  if (bytes.length > PURCHASE_ORDER_DOCUMENT_MAX_BYTES) throw documentError('DOCUMENT_TOO_LARGE');
  return { mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 上書きできない形（upsert: false）で署名つきの送り先を作る。失敗は DOCUMENT_STORAGE_UNAVAILABLE */
async function createUploadUrl(client: SupabaseClient, storagePath: string): Promise<string> {
  let response;
  try {
    response = await client.storage.from(PURCHASE_ORDER_DOCUMENT_BUCKET).createSignedUploadUrl(storagePath, { upsert: false });
  } catch {
    throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  }
  const signedUrl = response.data?.signedUrl;
  if (response.error || typeof signedUrl !== 'string' || signedUrl === '') throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  return signedUrl;
}

/**
 * 書類の置き場の予約（DB の関数 admin_reserve_purchase_order_attachment を1回呼び、続けて署名つきの送り先を作る）。
 * 予約は DB に残り、送り先を作れなかった時は DOCUMENT_STORAGE_UNAVAILABLE を投げるが予約は消えない（画面は
 * 保存が終わっていないファイルとして見せ、続きから送り先を出し直せる）。同じ requestKey の再送は同じ予約を replayed: true で返す
 * （送り先は新しく作る）。署名つきの送り先は応答にだけ載せる。差し替えの予約は、差し替える添付（この発注書の物）を予約に残す
 * （確定が版1へ写すので、頁を読み直しても差し替えの関係を失わない）。
 */
export async function reservePurchaseOrderDocument(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderDocumentReserveInput,
): Promise<PurchaseOrderDocumentReserved> {
  const data = await callWriter(client, 'admin_reserve_purchase_order_attachment', {
    _purchase_order_id: input.purchaseOrderId,
    _kind: input.kind,
    _file_name: input.fileName,
    _replaces_attachment_id: input.replacesAttachmentId,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  const { folder } = splitStoragePath(data.storagePath);
  if (typeof data.reservationId !== 'string' || !UUID_TEXT.test(data.reservationId)
    || folder !== input.purchaseOrderId.toLowerCase()
    || typeof data.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt))
    || typeof data.replayed !== 'boolean') {
    throw new PurchaseOrderError();
  }
  const signedUrl = await createUploadUrl(client, data.storagePath as string);
  return { reservationId: data.reservationId, signedUrl, expiresAt: data.expiresAt, replayed: data.replayed };
}

/**
 * 書き込みの無い照会（署名つきの送り先の出し直し・閲覧のリンク）の最初の確かめ。DB の関数 get_admin_purchase_order を実行者つきで呼び、
 * admin.purchase_orders.read を DB で確かめる（42501 は 403、発注書が無ければ 404）。manage は窓口だけが確かめる。
 */
async function assertCanReadOrder(client: SupabaseClient, actorId: string, purchaseOrderId: string): Promise<void> {
  let detail;
  try {
    detail = await getAdminPurchaseOrder(client, actorId, purchaseOrderId);
  } catch (error) {
    throw error instanceof PurchaseOrderError ? error : new PurchaseOrderError();
  }
  if (detail === null) throw new PurchaseOrderError(404, 'GROUP_G_PO_NOT_FOUND');
}

/** 表を service_role の SELECT で1行引く。DB の失敗は固定の失敗、行が無ければ null */
async function selectOne(
  client: SupabaseClient,
  table: string,
  columns: string,
  filters: Array<[column: string, value: string]>,
): Promise<Record<string, unknown> | null> {
  let response;
  try {
    let query = client.from(table).select(columns);
    for (const [column, value] of filters) query = query.eq(column, value);
    response = await query;
  } catch {
    throw new PurchaseOrderError();
  }
  if (response.error || !Array.isArray(response.data)) throw new PurchaseOrderError();
  const [row] = response.data as unknown[];
  return isObject(row) ? row : null;
}

/**
 * 予約の署名つき送り先を出し直す（ページを読み直した後・送れなかった後の再開）。最初に実行者の admin.purchase_orders.read を DB で確かめる。
 * 次に予約の表を引き、この発注書の物でなければ RESERVATION_INVALID（409）、すでに添付に結ばれていれば ALREADY_ATTACHED（409）。
 * 置き場にすでに保存済みなら { uploaded: true }（送り直さない）。無ければ新しい署名つきの送り先（upsert: false）。
 * 保存済みかは、保存キーのオブジェクト名（<uuid>.<拡張子>）の完全一致で見る（原ファイル名は使わない。list の search は前方一致なので、前だけ一致する別名は「ない」）。
 */
export async function issueDocumentUploadUrl(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderDocumentUploadUrlInput,
): Promise<PurchaseOrderDocumentUploadUrl> {
  await assertCanReadOrder(client, actorId, input.purchaseOrderId);
  const reservation = await selectOne(client, 'purchase_order_attachment_reservations', 'storage_path', [
    ['id', input.reservationId],
    ['purchase_order_id', input.purchaseOrderId],
  ]);
  if (reservation === null) throw new PurchaseOrderError(409, 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID');
  const attached = await selectOne(client, 'purchase_order_attachments', 'id', [['reservation_id', input.reservationId]]);
  if (attached !== null) throw new PurchaseOrderError(409, 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED');

  const { folder, objectName } = splitStoragePath(reservation.storage_path);
  let listed;
  try {
    listed = await client.storage.from(PURCHASE_ORDER_DOCUMENT_BUCKET).list(folder, { search: objectName });
  } catch {
    throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  }
  if (listed.error || !Array.isArray(listed.data)) throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  const stored = (listed.data as unknown[]).filter((entry) => isObject(entry) && entry.name === objectName);
  if (stored.length === 1) return { uploaded: true };
  return { uploaded: false, signedUrl: await createUploadUrl(client, reservation.storage_path as string) };
}

/**
 * 予約を添付に確定する。予約の保存キーを引き、置き場から読み戻して検査(1)〜(4)をかけ、sha256 が文字列なら読み戻した本文の SHA-256 と
 * 一致を確かめて sha256_source を browser にする（不一致は DOCUMENT_HASH_MISMATCH）。null（ページを読み直した後でファイルが手元に無い）なら
 * サーバーが読み戻した本文の SHA-256 を記録して server にする。そのうえで DB の関数 admin_attach_purchase_order_document を1回呼ぶ
 * （置き場の読み戻しとハッシュ計算は DB の取引の外）。置き場にまだ無ければ DOCUMENT_NOT_UPLOADED（409）。
 * 予約の期限切れでも確定できる。同じ requestKey の再送は同じ結果を replayed: true で返す。
 */
export async function attachPurchaseOrderDocument(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderDocumentAttachInput,
): Promise<PurchaseOrderDocumentAttached> {
  const reservation = await selectOne(client, 'purchase_order_attachment_reservations', 'storage_path', [
    ['id', input.reservationId],
    ['purchase_order_id', input.purchaseOrderId],
  ]);
  if (reservation === null) throw new PurchaseOrderError(409, 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID');
  const storagePath = reservation.storage_path as string;
  splitStoragePath(storagePath);

  let downloaded;
  try {
    downloaded = await client.storage.from(PURCHASE_ORDER_DOCUMENT_BUCKET).download(storagePath);
  } catch {
    throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  }
  if (downloaded.error) throw isNotFound(downloaded.error) ? documentError('DOCUMENT_NOT_UPLOADED') : documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  const blob = downloaded.data;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  }
  const inspected = inspectDocumentBytes(bytes, { fileName: storagePath, contentType: blob.type === '' ? null : blob.type });
  if (input.sha256 !== null && input.sha256 !== inspected.sha256) throw documentError('DOCUMENT_HASH_MISMATCH');

  const data = await callWriter(client, 'admin_attach_purchase_order_document', {
    _reservation_id: input.reservationId,
    _purchase_order_id: input.purchaseOrderId,
    _mime_type: inspected.mimeType,
    _size_bytes: inspected.sizeBytes,
    _sha256: inspected.sha256,
    _sha256_source: input.sha256 === null ? 'server' : 'browser',
    _transaction_date: input.transactionDate,
    _amount_yen: input.amountYen,
    _currency: input.currency,
    _counterparty: input.counterparty,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  return readAttachmentResult(data, 1);
}

/** 添付の確定・訂正の戻りを検査する（確定は revisionNo が 1） */
function readAttachmentResult(data: Record<string, unknown>, onlyRevisionNo?: number): PurchaseOrderDocumentAttached {
  const { attachmentId, revisionNo, replayed } = data;
  if (typeof attachmentId !== 'string' || !UUID_TEXT.test(attachmentId)
    || typeof revisionNo !== 'number' || !Number.isInteger(revisionNo) || revisionNo < 1
    || (onlyRevisionNo !== undefined && revisionNo !== onlyRevisionNo)
    || typeof replayed !== 'boolean') {
    throw new PurchaseOrderError();
  }
  return { attachmentId, revisionNo, replayed };
}

/**
 * 書類の情報の訂正と無効化（DB の関数 admin_revise_purchase_order_document を1回呼ぶ）。次の版を足し、前の版は残る。
 * 理由が必須で、前の版と同じ内容は 22023。同じ requestKey の再送は同じ結果を replayed: true で返す。
 */
export async function revisePurchaseOrderDocument(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderDocumentReviseInput,
): Promise<PurchaseOrderDocumentRevised> {
  const data = await callWriter(client, 'admin_revise_purchase_order_document', {
    _attachment_id: input.attachmentId,
    _purchase_order_id: input.purchaseOrderId,
    _transaction_date: input.transactionDate,
    _amount_yen: input.amountYen,
    _currency: input.currency,
    _counterparty: input.counterparty,
    _voided: input.voided,
    _reason: input.reason,
    _actor_id: actorId,
    _request_key: input.requestKey,
  });
  return readAttachmentResult(data);
}

/**
 * 原本を見る・保存するための短い署名つきリンク（60秒）を作る。最初に実行者の admin.purchase_orders.read を DB で確かめる。
 * download が真なら原ファイル名つきのダウンロード用、偽なら表示用。置き場に無ければ 404 DOCUMENT_NOT_FOUND。
 * リンクは応答にだけ載せ、記録しない。
 */
export async function createPurchaseOrderDocumentUrl(
  client: SupabaseClient,
  actorId: string,
  input: PurchaseOrderDocumentUrlInput,
): Promise<PurchaseOrderDocumentUrl> {
  await assertCanReadOrder(client, actorId, input.purchaseOrderId);
  const attachment = await selectOne(client, 'purchase_order_attachments', 'storage_path, original_file_name', [
    ['id', input.attachmentId],
    ['purchase_order_id', input.purchaseOrderId],
  ]);
  if (attachment === null) throw documentError('DOCUMENT_NOT_FOUND');
  const { folder, objectName } = splitStoragePath(attachment.storage_path);
  const fileName = attachment.original_file_name;
  if (typeof fileName !== 'string') throw new PurchaseOrderError();

  const bucket = client.storage.from(PURCHASE_ORDER_DOCUMENT_BUCKET);
  let response;
  try {
    response = input.download
      ? await bucket.createSignedUrl(`${folder}/${objectName}`, PURCHASE_ORDER_DOCUMENT_URL_SECONDS, { download: fileName })
      : await bucket.createSignedUrl(`${folder}/${objectName}`, PURCHASE_ORDER_DOCUMENT_URL_SECONDS);
  } catch {
    throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  }
  if (response.error) throw isNotFound(response.error) ? documentError('DOCUMENT_NOT_FOUND') : documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  const url = response.data?.signedUrl;
  if (typeof url !== 'string' || url === '') throw documentError('DOCUMENT_STORAGE_UNAVAILABLE');
  return { url, expiresInSeconds: PURCHASE_ORDER_DOCUMENT_URL_SECONDS };
}

/** DB の1行（snake_case）を検査した camelCase の行にする。決まった列だけを取る */
function toSearchRow(raw: unknown): { total: number; row: PurchaseOrderDocumentSearchRow } {
  if (!isObject(raw) || typeof raw.total !== 'number' || !Number.isSafeInteger(raw.total) || raw.total < 0) throw readFailure(null);
  return {
    total: raw.total,
    row: parsePurchaseOrderDocumentSearchRow({
      attachmentId: raw.attachment_id,
      purchaseOrderId: raw.purchase_order_id,
      purchaseOrderNumber: raw.purchase_order_number,
      kind: raw.kind,
      fileName: raw.original_file_name,
      mimeType: raw.mime_type,
      sizeBytes: raw.size_bytes,
      revisionNo: raw.revision_no,
      isCurrent: raw.is_current,
      transactionDate: raw.transaction_date,
      amountYen: raw.amount_yen,
      currency: raw.currency,
      counterparty: raw.counterparty,
      voided: raw.voided,
      reason: raw.reason,
      replacesAttachmentId: raw.replaces_attachment_id,
      createdAt: raw.created_at,
    }),
  };
}

/**
 * 取引書類の検索（DB の関数 search_purchase_order_documents を1回呼ぶ。読むだけ）。実行者の admin.purchase_orders.read は DB が確かめる
 * （偽は 403 の PurchaseOrderError）。既定は各添付の最新の版だけ、includeHistory が真なら訂正前の版も対象。保存キーは返さない。
 * 1頁50件。条件が合う全件の数が total（頁を切る前）。DB の生の文は返さない。
 */
export async function searchPurchaseOrderDocuments(
  client: SupabaseClient,
  actorId: string,
  { filters, page }: { filters: PurchaseOrderDocumentSearchFilters; page: number },
): Promise<{ rows: PurchaseOrderDocumentSearchRow[]; total: number }> {
  let response;
  try {
    response = await client.rpc('search_purchase_order_documents', {
      _date_from: filters.dateFrom,
      _date_to: filters.dateTo,
      _amount_min: filters.amountMin,
      _amount_max: filters.amountMax,
      _counterparty: filters.counterparty,
      _purchase_order_number: filters.number,
      _kind: filters.kind,
      _include_history: filters.includeHistory,
      _limit: PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
      _offset: (page - 1) * PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
      _actor_id: actorId,
    });
  } catch {
    throw readFailure(null);
  }
  if (response.error) throw readFailure(response.error);
  const data: unknown = response.data;
  if (!Array.isArray(data)) throw readFailure(null);

  const rows: PurchaseOrderDocumentSearchRow[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of data) {
    const parsed = toSearchRow(raw);
    // 行ごとに同じ total が入る。違えば別々の読み取りが混ざった形なので読み違いとして止める
    if (rows.length > 0 && parsed.total !== total) throw readFailure(null);
    const key = `${parsed.row.attachmentId}:${parsed.row.revisionNo}`;
    if (seen.has(key)) throw readFailure(null);
    seen.add(key);
    total = parsed.total;
    rows.push(parsed.row);
  }
  if (total < rows.length) throw readFailure(null);
  return { rows, total };
}
