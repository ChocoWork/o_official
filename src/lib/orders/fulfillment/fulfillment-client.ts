import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  LEGACY_FULFILLMENT_DISABLED_TEXT,
  MANUAL_COMPLETION_DISABLED_TEXT,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

/**
 * 管理画面（ブラウザ）から発送・仕上がりの窓口を呼ぶ道具と、返品・返金・取消の申し込みの画面で同じに扱う部品。
 * G-1 Task 14 で発送・仕上がりの窓口は止めた（410）ので、G-1 Task 15 から書く道具と材料の読み取りは窓口を呼ばずに
 * 固定の停止の文で断る。商品の見出し・数の入力の部品はそのまま使う。サーバーからは import しない。
 */

/** 仕上がりを記録した後の知らせ（仕上がりの画面は閉じるので、管理画面の一覧が出す） */
export const COMPLETION_RECORDED_MESSAGE = '仕上がりを記録しました。';
export const NO_COMPLETION_QUANTITY_MESSAGE = '仕上がった数を入れてください。';

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

/** 仕上がりの窓口（POST …/completions と …/completions/[completionId]/cancel）か */
function isCompletionUrl(url: string): boolean {
  return /\/completions(?:\/|$)/.test(url);
}

/**
 * 発送・仕上がり・それぞれの取消の窓口（POST）。窓口を呼ばずに断る（G-1 で停止。G-3 の新しい発送票まで再開しない）。
 * 仕上がりの窓口は手動の仕上がりの停止の文、ほかは発送の停止の文。
 */
export const callFulfillmentApi: <T>(
  url: string,
  body: unknown,
  fallbackMessage: string,
) => Promise<FulfillmentCallResult<T>> = async (url) => ({
  kind: 'refused',
  message: isCompletionUrl(url) ? MANUAL_COMPLETION_DISABLED_TEXT : LEGACY_FULFILLMENT_DISABLED_TEXT,
});

/** 発送の材料（GET …/fulfillments）。窓口を呼ばずに発送の停止の文を返す（G-1 で停止） */
export const fetchFulfillmentMaterials: (orderId: string) => Promise<FulfillmentMaterialsResult> = async () => ({
  ok: false,
  message: LEGACY_FULFILLMENT_DISABLED_TEXT,
});

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
