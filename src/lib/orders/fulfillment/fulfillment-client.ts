import type { FulfillmentMaterialLine } from '@/lib/orders/fulfillment/fulfillment-types';

/**
 * 返品・返金・取消の申し込みの画面で同じに扱う、商品の見出しと数の入力の部品。
 * 発送・仕上がりの窓口を呼ぶ道具と材料の読み取りの停止の道具（G-1 Task 15）は、発送の窓口が発送票（shipment-slip-client.ts）へ
 * 移ったので G-3 Task 7 で整理した。サーバーからは import しない。
 */

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
