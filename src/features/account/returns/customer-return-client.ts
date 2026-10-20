import { clientFetch, refreshSessionOnce } from '@/lib/client-fetch';
import { REQUEST_TEXT } from '@/features/account/returns/return-request-model';
import {
  CUSTOMER_RETURN_ERROR_MESSAGES,
  CUSTOMER_RETURN_FAILURE_MESSAGE,
  CUSTOMER_RETURN_RATE_LIMITED_MESSAGE,
  type CustomerReturnErrorCode,
} from '@/lib/orders/returns/customer-return-messages';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';

/**
 * お客様の画面（ブラウザ）から、返品・交換の申し込みの窓口を呼ぶ道具（グループ E-3 段2。共通の約束 C-2・C-3・P13）。
 * 管理画面の return-client.ts と同じ4分類で、お客様の窓口に合わせて、窓口の文ではなく記号から言葉を引く
 * （窓口の `error` は英語の短い文のことがあるため、画面の言葉は C-4 のお客様の言葉だけを使う）。
 * clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 */

/**
 * 書く窓口（POST）の答え。
 * - ok: 受け付けた
 * - blocked: 処理に入る前の断り（401・403・429）。二重防止の番号を保つ。401 は、印を新しくして送り直してもまた 401 の時と、新しくできなかった時
 * - refused: 処理の中の断り（400・404・409 など）。申し込みは記録されていないので、番号を作り直す。
 *   写真が合わない時（RETURN_PHOTO_INVALID）は invalidPhotoUploadIds に合わない写真の送り先の番号が入る
 * - unknown: 通信が切れた・500番台・読めない成功。記録されたかもしれないので、同じ番号と同じ中身で確かめ直す
 */
export type CustomerReturnCallResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'blocked'; message: string }
  | { kind: 'refused'; message: string; code: string | null; invalidPhotoUploadIds: string[] }
  | { kind: 'unknown' };

export type CustomerMaterialsResult =
  | { kind: 'ok'; data: CustomerReturnRequestMaterials }
  | { kind: 'error'; message: string; notFound: boolean };

function returnRequestUrl(orderId: string): string {
  return `/api/orders/${encodeURIComponent(orderId)}/return-request`;
}

/** 窓口の記号を、C-4 のお客様の言葉にする。表に無い記号・記号の無い断りは、想定外の失敗の言葉 */
function refusalMessageOf(code: string | null): string {
  return code !== null && Object.hasOwn(CUSTOMER_RETURN_ERROR_MESSAGES, code)
    ? CUSTOMER_RETURN_ERROR_MESSAGES[code as CustomerReturnErrorCode].message
    : CUSTOMER_RETURN_FAILURE_MESSAGE;
}

/**
 * 申し込みの材料を読む。読み取りだけなので、通信が切れても例外にせず文を返す（clientFetch は GET を1回だけ送り直す）。
 * 注文が無い・持ち主でない・お客様に隠す状態（404）は notFound を真にする（画面は「申し込みを受け付けていません」の文を出す）
 */
export async function fetchCustomerReturnMaterials(orderId: string): Promise<CustomerMaterialsResult> {
  const failed = (notFound: boolean): CustomerMaterialsResult => ({ kind: 'error', message: REQUEST_TEXT.loadFailed, notFound });
  try {
    const response = await clientFetch(returnRequestUrl(orderId), { cache: 'no-store' });
    if (response.status === 404) return failed(true);
    if (!response.ok) return failed(false);
    const body = (await response.json()) as { data?: CustomerReturnRequestMaterials | null } | null;
    return body?.data ? { kind: 'ok', data: body.data } : failed(false);
  } catch {
    return failed(false);
  }
}

const postJson = (url: string, body: unknown) =>
  clientFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * お客様の書く窓口（POST）を呼び、答えを4分類にする。キャンセルの申し込みの窓口にもそのまま使う（Task 10）。
 * clientFetch は POST を自動では送り直さない。ログインの印（アクセストークン。有効1時間）が古いと、窓口は処理に入る前に
 * 401 で断るので、印を1回だけ新しくして、同じ二重防止の番号・同じ中身で送り直しても二重にならない（カートの
 * sendShoppingRequest と同じ考え）。新しくできない時（失効）は、clientFetch の通知で LoginContext が画面をログインの案内に
 * 切り替える。一時的にできない時は、そのまま 401 の分類（blocked）にする
 */
export async function callCustomerReturnApi(url: string, body: unknown): Promise<CustomerReturnCallResult> {
  let response: Response;
  try {
    response = await postJson(url, body);
    if (response.status === 401 && (await refreshSessionOnce()) === 'refreshed') {
      response = await postJson(url, body);
    }
  } catch {
    return { kind: 'unknown' };
  }
  if (response.status >= 500) return { kind: 'unknown' };
  if (response.ok) {
    try {
      return { kind: 'ok', body: (await response.json()) as unknown };
    } catch {
      return { kind: 'unknown' };
    }
  }
  if (response.status === 429) return { kind: 'blocked', message: CUSTOMER_RETURN_RATE_LIMITED_MESSAGE };
  if (response.status === 401 || response.status === 403) return { kind: 'blocked', message: CUSTOMER_RETURN_FAILURE_MESSAGE };

  const errorBody: unknown = await response.json().catch(() => null);
  const record = errorBody && typeof errorBody === 'object' ? (errorBody as { code?: unknown; invalidPhotoUploadIds?: unknown }) : null;
  const code = typeof record?.code === 'string' ? record.code : null;
  const photoIds = record?.invalidPhotoUploadIds;
  return {
    kind: 'refused',
    message: refusalMessageOf(code),
    code,
    invalidPhotoUploadIds: Array.isArray(photoIds) ? photoIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

export async function submitCustomerReturnRequest(orderId: string, body: unknown): Promise<CustomerReturnCallResult> {
  return callCustomerReturnApi(returnRequestUrl(orderId), body);
}
