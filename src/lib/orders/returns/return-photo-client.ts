import { clientFetch, refreshSessionOnce } from '@/lib/client-fetch';
import {
  CUSTOMER_RETURN_ERROR_MESSAGES,
  CUSTOMER_RETURN_RATE_LIMITED_MESSAGE,
} from '@/lib/orders/returns/customer-return-messages';

/**
 * 申し込みの写真を、画面（ブラウザ）で選び・縮め・署名つきの送り先へ送る道具（グループ E-3 段2）。画面だけで使う。
 * 縮め直すと撮影の情報は消えるが、画面だけでは守りにならない（署名つきの送り先へ直接置けるため）ので、
 * サーバーが申し込みの時に必ず撮影の情報を消す（return-photo-sanitize）。
 * 署名つきの送り先は、画面の文言にもログにも出さない。
 */
export const RETURN_PHOTO_MAX_SOURCE_BYTES = 10_000_000;
export const RETURN_PHOTO_MAX_EDGE = 2000;
export const RETURN_PHOTO_JPEG_QUALITY = 0.85;
export const RETURN_PHOTO_ACCEPT = 'image/jpeg,image/png';

/** 選んだファイルが合わない時の文（C-5 の申し込みの画面の入力の誤り） */
export const RETURN_PHOTO_FILE_ERROR_MESSAGES = {
  type: 'JPEG か PNG の写真を選んでください。',
  size: '1枚 10MB までの写真を選んでください。',
} as const;

/** 写真を送れなかった時の文（C-5） */
export const RETURN_PHOTO_UPLOAD_FAILED_MESSAGE = '写真を送れませんでした。もう一度選んでください。';

const ACCEPTED_TYPES = RETURN_PHOTO_ACCEPT.split(',');

/** 選んだファイルを確かめる（種類を先に、次に大きさ）。縮める前の大きさの上限は 10MB（10,000,000 バイト） */
export function checkReturnPhotoFile(file: File): 'ok' | 'type' | 'size' {
  if (!ACCEPTED_TYPES.includes(file.type)) return 'type';
  return file.size > RETURN_PHOTO_MAX_SOURCE_BYTES ? 'size' : 'ok';
}

/** 写真を読み込む。撮影の情報を消した後に横向きにならないよう、向きを画素に反映する（指定を知らない古いブラウザは指定なしで読む） */
async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return createImageBitmap(file);
  }
}

/** 長い辺を 2000px までに縮め（小さい写真は拡大しない）、JPEG に作り直す。作り直すと撮影の情報は残らない */
export async function resizeReturnPhoto(file: File): Promise<Blob> {
  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(1, RETURN_PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_unavailable');
    // JPEG には透明が無い。PNG の透明な所が黒くならないよう、白で塗ってから描く
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('encode_failed'))),
        'image/jpeg',
        RETURN_PHOTO_JPEG_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}

type UploadResult = { kind: 'ok'; uploadId: string } | { kind: 'error'; message: string };

const uploadFailed = (): UploadResult => ({ kind: 'error', message: RETURN_PHOTO_UPLOAD_FAILED_MESSAGE });

/** 窓口が断った時の文。回数の制限は固定の文、記号のある断り（400・409）はお客様の言葉、ほかは送れなかった文 */
async function refusalMessage(response: Response): Promise<string> {
  if (response.status === 429) return CUSTOMER_RETURN_RATE_LIMITED_MESSAGE;
  if (response.status !== 400 && response.status !== 409) return RETURN_PHOTO_UPLOAD_FAILED_MESSAGE;
  const body: unknown = await response.json().catch(() => null);
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null;
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(CUSTOMER_RETURN_ERROR_MESSAGES, code)) {
    return CUSTOMER_RETURN_ERROR_MESSAGES[code as keyof typeof CUSTOMER_RETURN_ERROR_MESSAGES].message;
  }
  return RETURN_PHOTO_UPLOAD_FAILED_MESSAGE;
}

/**
 * 署名つきの送り先をもらう窓口（POST）を呼ぶ。clientFetch は POST を自動では送り直さない。ログインの印（アクセストークン。
 * 有効1時間）が古いと、窓口は送り先の行を作る前に 401 で断るので、印を1回だけ新しくして、1回だけ送り直しても送り先は
 * 1つしか作られない（カートの sendShoppingRequest と同じ考え）。新しくできない時（失効・一時的にできない）は 401 のまま返す
 * （失効の時は、clientFetch の通知で LoginContext が画面をログインの案内に切り替える）
 */
async function requestSignedUpload(orderId: string): Promise<Response> {
  const endpoint = `/api/orders/${encodeURIComponent(orderId)}/return-request/photos`;
  const response = await clientFetch(endpoint, { method: 'POST' });
  if (response.status === 401 && (await refreshSessionOnce()) === 'refreshed') {
    return clientFetch(endpoint, { method: 'POST' });
  }
  return response;
}

/**
 * 縮めた写真を送る。窓口で署名つきの送り先をもらい、ブラウザから置き場へ直接 PUT する（今の CSP の connect-src が許している）。
 * 上書きできない形は署名つきの送り先の側（createSignedUploadUrl の upsert: false）で決まる。x-upsert: false は添えるだけ。
 * 置き場への PUT は署名つきの送り先が許す物で、ログインの印と関係ないので、印を新しくせず送り直さない。
 * 送れなかった理由は文にして返し、署名つきの送り先は文にもログにも出さない。
 */
export async function uploadReturnPhoto(orderId: string, photo: Blob): Promise<UploadResult> {
  let uploadId: string;
  let signedUrl: string;
  try {
    const response = await requestSignedUpload(orderId);
    if (!response.ok) return { kind: 'error', message: await refusalMessage(response) };
    const body = (await response.json()) as { data?: { uploadId?: unknown; signedUrl?: unknown } } | null;
    const issuedUploadId = body?.data?.uploadId;
    const issuedSignedUrl = body?.data?.signedUrl;
    if (typeof issuedUploadId !== 'string' || typeof issuedSignedUrl !== 'string') return uploadFailed();
    uploadId = issuedUploadId;
    signedUrl = issuedSignedUrl;
  } catch {
    return uploadFailed();
  }
  try {
    const put = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'x-upsert': 'false' },
      body: photo,
    });
    return put.ok ? { kind: 'ok', uploadId } : uploadFailed();
  } catch {
    return uploadFailed();
  }
}
