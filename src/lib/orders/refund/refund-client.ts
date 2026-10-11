import { clientFetch } from '@/lib/client-fetch';
import { REFUND_FAILURE_MESSAGES } from '@/lib/orders/refund/refund-messages';
import type { RefundMaterials } from '@/lib/orders/refund/refund-types';

/**
 * 管理画面（ブラウザ）から返金の窓口を呼ぶ道具（グループ E-2 設計書 5-1・5-3）。返金の画面と支払い済みのキャンセルの画面が使う。
 * clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 * 答えの分け方は発送の画面（fulfillment-client.ts）と同じ。違いは、Stripe の断り（422）の文も画面に出すこと。
 */

const UNAUTHENTICATED_MESSAGE = '認証が必要です。再ログインしてください。';
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';

/** 窓口の答えを、画面が分けて扱う3つにする */
export type RefundCallResult<T> =
  | { kind: 'ok'; body: T }
  // 窓口が断った（お金は動いていない）。画面に出す文を持つ
  | { kind: 'refused'; message: string }
  // 通信が切れた・500番台・成功なのに答えを読めない。Stripe に返金を頼んだか分からない
  | { kind: 'unknown' };

/** 窓口が日本語で返す断りの文（`{ error }`）。文字でない・長すぎる時は使わない */
function ownErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' && error.length > 0 && error.length <= 200 ? error : null;
}

/**
 * 断られた時に画面へ出す文。回数の制限などの共通の守りは英語の短い文を返すので、窓口が日本語で返す
 * 400・404・409・422 の文だけをそのまま出し、権限（401・403）は固定の文にする。
 */
function refusalMessage(status: number, body: unknown, fallback: string): string {
  if (status === 401) return UNAUTHENTICATED_MESSAGE;
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 400 || status === 404 || status === 409 || status === 422) return ownErrorMessage(body) ?? fallback;
  return fallback;
}

/**
 * 返金・確かめ直し・支払い済みのキャンセルの窓口（POST）を呼ぶ。
 * 送信が途中で切れたかもしれない時は、画面が同じ二重防止の番号で送り直せるように unknown を返す
 * （clientFetch は書き込みを自動で送り直さない）。
 */
export async function callRefundApi<T>(url: string, body: unknown, fallbackMessage: string): Promise<RefundCallResult<T>> {
  let response: Response;
  try {
    response = await clientFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unknown' };
  }

  if (response.status >= 500) return { kind: 'unknown' };
  if (response.ok) {
    try {
      return { kind: 'ok', body: (await response.json()) as T };
    } catch {
      return { kind: 'unknown' };
    }
  }

  const errorBody: unknown = await response.json().catch(() => null);
  return { kind: 'refused', message: refusalMessage(response.status, errorBody, fallbackMessage) };
}

/** 返金の画面と支払い済みのキャンセルの画面が、開いた時に読む「返金の材料」 */
export async function fetchRefundMaterials(
  orderId: string,
): Promise<{ kind: 'ok'; materials: RefundMaterials } | { kind: 'error'; message: string }> {
  try {
    const response = await clientFetch(`/api/admin/orders/${orderId}/refund`, { cache: 'no-store' });
    if (response.status >= 500) return { kind: 'error', message: REFUND_FAILURE_MESSAGES.materials };
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      return { kind: 'error', message: refusalMessage(response.status, body, REFUND_FAILURE_MESSAGES.materials) };
    }
    return { kind: 'ok', materials: (await response.json()) as RefundMaterials };
  } catch {
    return { kind: 'error', message: REFUND_FAILURE_MESSAGES.materials };
  }
}
