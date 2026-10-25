import { clientFetch } from '@/lib/client-fetch';
import {
  hasPurchaseOrderDocumentSignature,
  PURCHASE_ORDER_DOCUMENT_ERRORS,
  PURCHASE_ORDER_DOCUMENT_MAX_BYTES,
  PURCHASE_ORDER_DOCUMENT_SIGNATURE_LENGTH,
  PURCHASE_ORDER_DOCUMENT_TEXT,
  PURCHASE_ORDER_TEXT,
  purchaseOrderDocumentMimeOfName,
  purchaseOrderFailureMessage,
  type PurchaseOrderAttachmentKind,
  type PurchaseOrderDocumentMeta,
  type PurchaseOrderDocumentMime,
} from '@/lib/purchase-orders/purchase-order-types';

/**
 * 取引書類の原本（見積書・請求書 / G-2 Task 8・FREQ-530）を、画面（ブラウザ）で署名つきの送り先へ送って確定する道具。画面だけで使う。
 * 順は (1) ファイルの確かめ（拡張子・種類・先頭のバイト・大きさ）と SHA-256、(2) 置き場の予約、(3) 署名つきの送り先へ PUT、(4) 確定（sha256 を送る）。
 * (3) か (4) で失敗したら予約 ID を返して pending にする。予約 ID は発注書の詳細の pendingUploads にも出るので、ページを読み直しても
 * resumePurchaseOrderDocument で続きから保存できる。差し替えの関係（差し替える添付）は予約に残るので、続きから保存や確定では送らない。
 * 置き場のファイルが種類の検査に通らなかった時（確定が DOCUMENT_TYPE_UNSUPPORTED）は、続きから保存を繰り返しても通らないので
 * rejected を返し、画面が新しい予約で保存し直させる（置き場の上書きはできない）。署名つきの送り先は文にもログにも出さない。
 * 置き場への PUT は署名つきの送り先が許す物で、ログインの印と関係ないので、印を新しくせず送り直さない。
 */

export type PurchaseOrderDocumentUploadMeta = PurchaseOrderDocumentMeta & {
  /** 新しい書類を差し替えとして送る時の、差し替える添付。予約に残る */
  replacesAttachmentId: string | null;
};

export type PurchaseOrderDocumentUploadResult =
  | { kind: 'ok'; attachmentId: string }
  | { kind: 'pending'; reservationId: string; message: string }
  /** 置き場のファイルが種類の検査に通らなかった。この予約では保存できない（新しい予約で保存し直す） */
  | { kind: 'rejected'; reservationId: string; message: string }
  | { kind: 'error'; message: string };

export type PurchaseOrderDocumentResumeResult =
  | PurchaseOrderDocumentUploadResult
  | { kind: 'needs_file'; reservationId: string };

/** ファイルを選ぶ欄の accept */
export const PURCHASE_ORDER_DOCUMENT_ACCEPT = 'application/pdf,image/jpeg,image/png';

const ACCEPTED_TYPES: readonly string[] = PURCHASE_ORDER_DOCUMENT_ACCEPT.split(',');

/** ファイルの先頭のバイトを読む（FileReader は古いブラウザでも使える） */
function readHead(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsArrayBuffer(file.slice(0, PURCHASE_ORDER_DOCUMENT_SIGNATURE_LENGTH));
  });
}

/**
 * 選んだファイルを送る前に確かめる（置き場に使えない物が残って、続きから保存が通らない予約を作らないため）。合わなければ利用者に見せる文、
 * よければ null。サーバーの検査と同じ表で見る: 拡張子から種類を決め（続きから保存では予約の種類 expectedMime）、ブラウザが渡した種類が
 * 違えば断り、先頭のバイトがその種類の印と同じかを確かめ、空と 20 MiB 超を断る。
 */
export async function checkPurchaseOrderDocumentFile(file: File, expectedMime?: PurchaseOrderDocumentMime): Promise<string | null> {
  const unsupported = PURCHASE_ORDER_DOCUMENT_ERRORS.DOCUMENT_TYPE_UNSUPPORTED[1];
  const mismatch = expectedMime === undefined ? unsupported : PURCHASE_ORDER_DOCUMENT_TEXT.resumeTypeMismatch;
  const target = expectedMime ?? purchaseOrderDocumentMimeOfName(file.name);
  if (file.size === 0 || target === null) return unsupported;
  if (file.size > PURCHASE_ORDER_DOCUMENT_MAX_BYTES) return PURCHASE_ORDER_DOCUMENT_ERRORS.DOCUMENT_TOO_LARGE[1];
  if (ACCEPTED_TYPES.includes(file.type) && file.type !== target) return mismatch;
  let head: Uint8Array;
  try {
    head = await readHead(file);
  } catch {
    return unsupported;
  }
  return hasPurchaseOrderDocumentSignature(head, target) ? null : mismatch;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const attachmentsUrl = (purchaseOrderId: string): string => `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrderId)}/attachments`;

/**
 * 確定の要求番号。応答を失った確定を同じ画面のまま送り直す時（同じ内容）は同じ番号で送り、DB が前の結果を返す。
 * 内容（ハッシュ・取引日・金額・取引先）が変わったら新しい番号にする。ページを読み直すと忘れるが、
 * 確定済みの予約はもう pendingUploads に出ない。
 */
const attachKeys = new Map<string, { signature: string; requestKey: string }>();

function attachRequestKey(reservationId: string, signature: string): string {
  const known = attachKeys.get(reservationId);
  if (known?.signature === signature) return known.requestKey;
  const requestKey = crypto.randomUUID();
  attachKeys.set(reservationId, { signature, requestKey });
  return requestKey;
}

/**
 * 予約の要求番号。予約は取れたが送り先を作れなかった（503）・応答を失った後の同じ書類の送り直しは、同じ番号で送って同じ予約を
 * 受け取る（送るたびに別の予約が増えない）。予約の応答を受けたら忘れる。応答を失った予約は ID が分からないまま続きから保存で
 * 終わることがあり、その後に同じ番号で送ると終わった予約を受け取ってしまうので、続きから保存で予約が終わった時
 * （forgetReserveKeys）にも、その発注書・ファイル名の番号を忘れる。
 */
const reserveKeys = new Map<string, { requestKey: string; purchaseOrderId: string; fileName: string }>();

function reserveRequestKey(signature: string, purchaseOrderId: string, fileName: string): string {
  const known = reserveKeys.get(signature);
  if (known !== undefined) return known.requestKey;
  const requestKey = crypto.randomUUID();
  reserveKeys.set(signature, { requestKey, purchaseOrderId, fileName: fileName.trim() });
  return requestKey;
}

/** 続きから保存で予約が終わった（確定できた・種類の検査で断られて使えなくなった）発注書・ファイル名の、残した予約の要求番号を忘れる */
function forgetReserveKeys(purchaseOrderId: string, fileName: string): void {
  const name = fileName.trim();
  for (const [signature, entry] of reserveKeys) {
    if (entry.purchaseOrderId === purchaseOrderId && entry.fileName === name) reserveKeys.delete(signature);
  }
}

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** 窓口の応答から JSON の本文を取り出す（取れなければ null） */
async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  const body: unknown = await response.json().catch(() => null);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * 原本を開く60秒の署名つきリンクを窓口からもらう（発注書の頁の「表示」「ダウンロード」「印刷」と書類検索の「原本を見る」が同じ道具を使う）。
 * もらえなければ利用者に見せる文（窓口の断りは誤りの表、応答の崩れ・通信の失敗は「原本を取得できません。」）。リンクは文にも記録にも出さない。
 */
export async function fetchPurchaseOrderDocumentUrl(
  purchaseOrderId: string,
  attachmentId: string,
  download: boolean,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const endpoint = `${attachmentsUrl(purchaseOrderId)}/${encodeURIComponent(attachmentId)}/url${download ? '?download=1' : ''}`;
    const response = await clientFetch(endpoint, { cache: 'no-store' });
    const body: unknown = await response.json().catch(() => null);
    const url = body !== null && typeof body === 'object' ? (body as { url?: unknown }).url : undefined;
    if (!response.ok || typeof url !== 'string' || url === '') {
      return { ok: false, message: response.ok ? PURCHASE_ORDER_DOCUMENT_TEXT.openFailed : purchaseOrderFailureMessage(response.status, body) };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, message: PURCHASE_ORDER_DOCUMENT_TEXT.openFailed };
  }
}

/**
 * 原本を表示・印刷する新しいタブを、利用者のクリックの中で（署名つきリンクを待つ前に）空で開く。
 * リンクを待った後の window.open は、Safari（特に iOS）が利用者の操作から外れたものとして止めることがあるため。
 * 開けた後はタブの opener を切る（noopener と同じ。リンクを取れたら呼び出し側が location.href を替える）。
 * ブラウザが止めた時は null（呼び出し側は PURCHASE_ORDER_DOCUMENT_TEXT.openBlocked を出す）。
 * 呼び出し側は、リンクを取る await より前に（同じクリックの中で）呼ぶこと。
 */
export function openBlankDocumentTab(): Window | null {
  const tab = window.open('', '_blank');
  if (!tab) return null;
  try {
    tab.opener = null;
  } catch {
    // opener を切れないブラウザでも、空のタブにリンクを移すだけなので続ける
  }
  return tab;
}

/** 署名つきの送り先へ PUT する。種類は予約の拡張子の種類（置き場の記録とサーバーの検査が同じ種類を見る）。上書きできない形は送り先の側で決まる（x-upsert: false は添えるだけ） */
async function putFile(signedUrl: string, file: File, mime: PurchaseOrderDocumentMime): Promise<boolean> {
  try {
    const response = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'content-type': mime, 'x-upsert': 'false' },
      body: file,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 確定の窓口を呼ぶ。失敗は予約 ID つきの pending（続きから保存できる）。種類の検査に通らない時だけ rejected（続きから保存では通らない） */
async function attach(
  purchaseOrderId: string,
  reservationId: string,
  sha256: string | null,
  meta: PurchaseOrderDocumentMeta,
): Promise<PurchaseOrderDocumentUploadResult> {
  const requestKey = attachRequestKey(reservationId, JSON.stringify([sha256, meta]));
  let response: Response;
  try {
    response = await clientFetch(attachmentsUrl(purchaseOrderId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reservationId,
        sha256,
        transactionDate: meta.transactionDate,
        amountYen: meta.amountYen,
        currency: 'JPY',
        counterparty: meta.counterparty,
        requestKey,
      }),
    });
  } catch {
    return { kind: 'pending', reservationId, message: PURCHASE_ORDER_TEXT.failed };
  }
  const body = await readBody(response);
  if (!response.ok) {
    if (body?.code === 'DOCUMENT_TYPE_UNSUPPORTED') {
      return { kind: 'rejected', reservationId, message: PURCHASE_ORDER_DOCUMENT_TEXT.rejectedFile };
    }
    return { kind: 'pending', reservationId, message: purchaseOrderFailureMessage(response.status, body) };
  }
  if (body === null || !isUuid(body.attachmentId)) return { kind: 'pending', reservationId, message: PURCHASE_ORDER_TEXT.failed };
  attachKeys.delete(reservationId);
  return { kind: 'ok', attachmentId: body.attachmentId };
}

/**
 * 新しい書類を送る。ファイルが合わなければ何もせず error。予約が取れなければ error（予約が残っていれば、ページを読み直すと
 * 保存が終わっていないファイルに出る。同じ書類の送り直しは同じ要求番号で同じ予約を受け取る）。置き場への PUT か確定が失敗したら、
 * 予約 ID つきの pending。差し替えなら meta.replacesAttachmentId を予約に残す（確定や続きから保存では送らない）。
 */
export async function uploadPurchaseOrderDocument(input: {
  purchaseOrderId: string;
  file: File;
  kind: PurchaseOrderAttachmentKind;
  meta: PurchaseOrderDocumentUploadMeta;
}): Promise<PurchaseOrderDocumentUploadResult> {
  const fileMessage = await checkPurchaseOrderDocumentFile(input.file);
  if (fileMessage !== null) return { kind: 'error', message: fileMessage };
  const mime = purchaseOrderDocumentMimeOfName(input.file.name);
  if (mime === null) return { kind: 'error', message: PURCHASE_ORDER_DOCUMENT_ERRORS.DOCUMENT_TYPE_UNSUPPORTED[1] };

  let sha256: string;
  try {
    sha256 = await sha256Hex(input.file);
  } catch {
    return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
  }

  const { replacesAttachmentId, ...meta } = input.meta;
  const reserveSignature = JSON.stringify([input.purchaseOrderId, input.kind, input.file.name, replacesAttachmentId]);
  let response: Response;
  try {
    response = await clientFetch(`${attachmentsUrl(input.purchaseOrderId)}/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: input.kind,
        fileName: input.file.name,
        replacesAttachmentId,
        requestKey: reserveRequestKey(reserveSignature, input.purchaseOrderId, input.file.name),
      }),
    });
  } catch {
    return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
  }
  const body = await readBody(response);
  if (!response.ok) {
    // 確定した断り（4xx）は予約が残らないので、次は新しい要求番号にする。5xx・通信の失敗は予約が残りうるので同じ番号で送り直す
    if (response.status < 500) reserveKeys.delete(reserveSignature);
    return { kind: 'error', message: purchaseOrderFailureMessage(response.status, body) };
  }
  reserveKeys.delete(reserveSignature);
  if (body === null || !isUuid(body.reservationId) || typeof body.signedUrl !== 'string') {
    return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
  }
  const reservationId = body.reservationId;

  if (!(await putFile(body.signedUrl, input.file, mime))) {
    return { kind: 'pending', reservationId, message: PURCHASE_ORDER_DOCUMENT_TEXT.uploadFailed };
  }
  return attach(input.purchaseOrderId, reservationId, sha256, meta);
}

/**
 * 保存が終わっていない予約を、続きから保存する。reservationFileName は予約のファイル名（保存キーの拡張子を決めた名前）で、選び直した
 * ファイルはその拡張子の種類でなければ断る（置き場には予約の種類でしか置けず、違う種類は確定で断られて続きから保存が通らなくなる）。
 * 最初に署名つきの送り先を出し直す窓口を呼ぶ。すでに置き場にあれば PUT は省く（file があればそのハッシュ、無ければ sha256 なしで確定し、
 * サーバーが読み戻した本文のハッシュを記録する）。置き場に無ければ、file が無い時は needs_file（選び直しを頼む）、あれば PUT して
 * sha256 つきで確定する。差し替えの関係は予約に残っているので送らない。確定が種類の検査で断られたら rejected。
 * ok か rejected で予約が終わった時と、送り先を出す窓口が予約は無い・使われたと断った（404・409）時は、予約を取れなかった時に残した
 * 同じ書類の要求番号を忘れる（終わった予約を次の保存で受け取らない）。
 */
export async function resumePurchaseOrderDocument(input: PurchaseOrderDocumentResumeInput): Promise<PurchaseOrderDocumentResumeResult> {
  const result = await resumeReservation(input);
  if (result.kind === 'ok' || result.kind === 'rejected') forgetReserveKeys(input.purchaseOrderId, input.reservationFileName);
  return result;
}

type PurchaseOrderDocumentResumeInput = {
  purchaseOrderId: string;
  reservationId: string;
  reservationFileName: string;
  file: File | null;
  meta: PurchaseOrderDocumentMeta;
};

async function resumeReservation(input: PurchaseOrderDocumentResumeInput): Promise<PurchaseOrderDocumentResumeResult> {
  const { purchaseOrderId, reservationId, file, meta } = input;
  const expectedMime = purchaseOrderDocumentMimeOfName(input.reservationFileName);
  if (expectedMime === null) return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
  if (file !== null) {
    const fileMessage = await checkPurchaseOrderDocumentFile(file, expectedMime);
    if (fileMessage !== null) return { kind: 'error', message: fileMessage };
  }

  let response: Response;
  try {
    response = await clientFetch(
      `${attachmentsUrl(purchaseOrderId)}/reservations/${encodeURIComponent(reservationId)}/upload-url`,
      { method: 'POST' },
    );
  } catch {
    return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
  }
  const body = await readBody(response);
  if (!response.ok) {
    // 窓口が「その予約は無い（404）・この発注書の予約ではない／もう添付に使われた（409）」と断ったら、予約は終わっている。
    // 予約を取れなかった時に残した同じ書類の要求番号を持ち越すと、次の保存で終わった予約を受け取ってしまうので忘れる（5xx・通信の失敗は残す）
    if (response.status === 404 || response.status === 409) forgetReserveKeys(purchaseOrderId, input.reservationFileName);
    return { kind: 'error', message: purchaseOrderFailureMessage(response.status, body) };
  }

  if (body?.uploaded === true) {
    try {
      return await attach(purchaseOrderId, reservationId, file === null ? null : await sha256Hex(file), meta);
    } catch {
      return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
    }
  }
  if (body?.uploaded !== false || typeof body.signedUrl !== 'string') return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };

  if (file === null) return { kind: 'needs_file', reservationId };
  let sha256: string;
  try {
    sha256 = await sha256Hex(file);
  } catch {
    return { kind: 'error', message: PURCHASE_ORDER_TEXT.failed };
  }
  if (!(await putFile(body.signedUrl, file, expectedMime))) {
    return { kind: 'pending', reservationId, message: PURCHASE_ORDER_DOCUMENT_TEXT.uploadFailed };
  }
  return attach(purchaseOrderId, reservationId, sha256, meta);
}
