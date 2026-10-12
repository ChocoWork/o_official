import { clientFetch } from '@/lib/client-fetch';
import { RATE_LIMITED_MESSAGE } from '@/lib/orders/refund/refund-messages';

/**
 * 管理画面（ブラウザ）から返品の窓口を読む道具（グループ E-3 段1）。返品の画面と返品を作る画面が使う。
 * 書く窓口（POST）は callReturnApi。E-2 と同じ4分類に加え、断りの code と receiptId を保持する。
 * clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 */

const UNAUTHENTICATED_MESSAGE = '認証が必要です。再ログインしてください。';
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';

/** 読めた（窓口の答えの data）か、画面に出す文つきの失敗か */
export type ReturnReadResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; message: string };

/** 窓口が日本語で返す断りの文（`{ error }`）。文字でない・長すぎる時は使わない */
function ownErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' && error.length > 0 && error.length <= 200 ? error : null;
}

/**
 * 読めなかった時に画面へ出す文。回数の制限などの共通の守りは英語の短い文を返すので、窓口が日本語で返す
 * 400・404・409 の文だけをそのまま出し、権限（401・403）と回数の制限（429）は固定の文にする。
 */
function readFailureMessage(status: number, body: unknown, fallback: string): string {
  if (status === 401) return UNAUTHENTICATED_MESSAGE;
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 429) return RATE_LIMITED_MESSAGE;
  if (status === 400 || status === 404 || status === 409 || status === 422) return ownErrorMessage(body) ?? fallback;
  return fallback;
}

/**
 * 返品の窓口（GET）を読み、答えの包み（`{ data }`）の中身を返す。読み取りだけなので、通信が切れても例外にせず文を返す
 * （clientFetch は GET を1回だけ自動で送り直す）。
 */
export async function fetchReturnData<T>(url: string, fallbackMessage: string): Promise<ReturnReadResult<T>> {
  try {
    const response = await clientFetch(url, { cache: 'no-store' });
    if (!response.ok) {
      const body: unknown = response.status >= 500 ? null : await response.json().catch(() => null);
      return { kind: 'error', message: readFailureMessage(response.status, body, fallbackMessage) };
    }
    const body = (await response.json()) as { data?: T | null } | null;
    if (!body || body.data === undefined || body.data === null) return { kind: 'error', message: fallbackMessage };
    return { kind: 'ok', data: body.data };
  } catch {
    return { kind: 'error', message: fallbackMessage };
  }
}

/**
 * 返品の書く窓口（POST）の答え。E-2 の callRefundApi と同じ4つに分ける（処理の前の断り 401・403・429 は blocked、
 * 処理の中の断り 400・404・409・422 は refused、通信が切れた・500 番台・読めない成功は unknown）。
 * 違いは、refused に窓口の記号と受け取りの番号（receiptId）を付けること。受け取りの窓口は、受け取りを記録した後に返金だけが
 * 断られた時（Stripe の断り・E-2 の断り）に本文へ receiptId を足す（Task 7 の T7-5）。その時は記録が残っているので、
 * 画面は同じ受け取りを新しい番号で送り直してはいけない
 */
export type ReturnCallResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'blocked'; message: string }
  | { kind: 'refused'; message: string; code: string | null; receiptId: string | null }
  | { kind: 'unknown' };

export async function callReturnApi(url: string, body: unknown, fallbackMessage: string): Promise<ReturnCallResult> {
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
      return { kind: 'ok', body: (await response.json()) as unknown };
    } catch {
      return { kind: 'unknown' };
    }
  }
  const errorBody: unknown = await response.json().catch(() => null);
  const message = readFailureMessage(response.status, errorBody, fallbackMessage);
  if (response.status === 401 || response.status === 403 || response.status === 429) return { kind: 'blocked', message };
  const record = errorBody && typeof errorBody === 'object' ? (errorBody as { code?: unknown; receiptId?: unknown }) : null;
  return {
    kind: 'refused',
    message,
    code: typeof record?.code === 'string' ? record.code : null,
    receiptId: typeof record?.receiptId === 'string' ? record.receiptId : null,
  };
}

