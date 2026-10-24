// File: src/lib/inventory/inventory-list-types.ts
// 在庫一覧表（G-2 / FREQ-525）の行・式・文。窓口・store・画面が同じ定義を使う（サーバー専用の物は入れない）。

/**
 * 在庫一覧表の1行（variant ごと）。
 * onHand = free + paidAllocated + paymentHeld（G-1 の在庫の数え方と同じ）。
 * orderQuantity は受注生産中と仕上がり待ちの注文の数（未払い・取消申請中・返品申請中は含まない）。
 * onOrder は数量が確定した発注の未納の数。required = max(0, orderQuantity - onHand - onOrder)。
 */
export type AdminInventoryRow = {
  variantId: number;
  itemId: number;
  itemName: string;
  colorName: string | null;
  sizeLabel: string | null;
  isActive: boolean;
  free: number;
  paidAllocated: number;
  paymentHeld: number;
  onHand: number;
  orderQuantity: number;
  onOrder: number;
  required: number;
};

/** 発注が要る数。在庫と発注済みで足りている時は 0（負にしない）。 */
export function calcRequiredQuantity(orderQuantity: number, onHand: number, onOrder: number): number {
  return Math.max(0, orderQuantity - onHand - onOrder);
}

/** 在庫の内訳の1行（画面の「在庫の内訳」を開いた時の文）。 */
export function formatStockBreakdown(row: Pick<AdminInventoryRow, 'free' | 'paidAllocated' | 'paymentHeld'>): string {
  return `空き ${row.free}・入金済みの割当 ${row.paidAllocated}・支払い前の仮確保 ${row.paymentHeld}`;
}

/** 在庫一覧表の固定の文。窓口は apiFailed と forbidden、画面は forbidden・screenFailed・empty を使う。 */
export const INVENTORY_LIST_TEXT = {
  forbidden: '在庫一覧を見る権限がありません。',
  apiFailed: '在庫一覧を読み込めませんでした。',
  screenFailed: '在庫一覧を読み込めませんでした。時間をおいて再度お試しください。',
  empty: '表示する商品がありません。',
} as const;
