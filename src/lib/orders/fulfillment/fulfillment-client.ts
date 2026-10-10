import { clientFetch } from '@/lib/client-fetch';
import { FULFILLMENT_FAILURE_MESSAGES } from '@/lib/orders/fulfillment/fulfillment-messages';
import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 管理画面（ブラウザ）から発送・仕上がりの窓口を呼ぶ道具と、発送の画面・仕上がりの画面・履歴の画面で同じに扱う部品。
 * clientFetch を使うのでブラウザだけで動く。サーバーからは import しない。
 */

/** 仕上がりを記録した後の知らせ（仕上がりの画面は閉じるので、管理画面の一覧が出す） */
export const COMPLETION_RECORDED_MESSAGE = '仕上がりを記録しました。';
export const NO_COMPLETION_QUANTITY_MESSAGE = '仕上がった数を入れてください。';

const UNAUTHENTICATED_MESSAGE = '認証が必要です。再ログインしてください。';
// 管理画面の隣の操作（src/app/admin/page.tsx の要対応・要確認の操作）と同じ文
const FORBIDDEN_MESSAGE = 'この操作の権限がありません。';

/** 窓口の答えを、画面が分けて扱う3つにする */
export type FulfillmentCallResult<T> =
  | { kind: 'ok'; body: T }
  // 窓口が断った（記録していない）。画面に出す文を持つ
  | { kind: 'refused'; message: string }
  // 通信が切れた・500番台・成功なのに答えを読めない。記録されたか分からない
  | { kind: 'unknown' };

export type FulfillmentMaterialsResult =
  | { ok: true; materials: FulfillmentMaterials }
  | { ok: false; message: string };

/** 窓口が日本語で返す断りの文（400・404・409 の `{ error }`）。文字でない・長すぎる時は使わない */
function ownErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' && error.length > 0 && error.length <= 200 ? error : null;
}

/**
 * 断られた時に画面へ出す文。回数の制限などの共通の守りは英語の短い文を返すので、窓口が日本語で返す
 * 400・404・409 の文だけをそのまま出し、権限（401・403）は固定の文にする。
 */
function refusalMessage(status: number, body: unknown, fallback: string): string {
  if (status === 401) return UNAUTHENTICATED_MESSAGE;
  if (status === 403) return FORBIDDEN_MESSAGE;
  if (status === 400 || status === 404 || status === 409) return ownErrorMessage(body) ?? fallback;
  return fallback;
}

/**
 * 発送・仕上がり・それぞれの取消の窓口（POST）を呼ぶ。body が undefined なら本文なしで送る。
 * 送信が途中で切れたかもしれない時は、画面が同じ重複防止キーで送り直せるように unknown を返す
 * （clientFetch は書き込みを自動で送り直さない）。
 */
export async function callFulfillmentApi<T>(
  url: string,
  body: unknown,
  fallbackMessage: string,
): Promise<FulfillmentCallResult<T>> {
  let response: Response;
  try {
    response = await clientFetch(url, {
      method: 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
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

/** 発送の画面と仕上がりの画面が、開いた時と仕上がりの記録の後に読む「発送の材料」 */
export async function fetchFulfillmentMaterials(orderId: string): Promise<FulfillmentMaterialsResult> {
  try {
    const response = await clientFetch(`/api/admin/orders/${orderId}/fulfillments`, { cache: 'no-store' });
    if (response.status >= 500) return { ok: false, message: FULFILLMENT_FAILURE_MESSAGES.materials };
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      return { ok: false, message: refusalMessage(response.status, body, FULFILLMENT_FAILURE_MESSAGES.materials) };
    }
    return { ok: true, materials: (await response.json()) as FulfillmentMaterials };
  } catch {
    return { ok: false, message: FULFILLMENT_FAILURE_MESSAGES.materials };
  }
}

/** 商品の見出し。「シルクブラウス（白 / M）」。色もサイズも無ければ名前だけ */
export function lineLabel(line: Pick<FulfillmentMaterialLine, 'name' | 'color' | 'size'>): string {
  const variant = [line.color, line.size].filter((part): part is string => Boolean(part)).join(' / ');
  return variant ? `${line.name}（${variant}）` : line.name;
}

/** 数の入力。整数にし、0 から上限までに収める（空・文字・負の数は 0） */
export function clampQuantity(raw: string, max: number): number {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.min(value, Math.max(0, max));
}
