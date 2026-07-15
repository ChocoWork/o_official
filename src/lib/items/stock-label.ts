/**
 * 一覧カードの在庫表示ラベルを決める純粋関数。
 * - 在庫あり（stock_quantity >= 1、かつ SOLD OUT でない）: 残数「残り{n}点」
 * - それ以外（0 / NULL / 情報なし / SOLD OUT）: 受注生産（made-to-order）
 */
export function formatStockLabel(
  stockQuantity: number | null | undefined,
  soldOut: boolean,
): string {
  if (!soldOut && typeof stockQuantity === "number" && stockQuantity >= 1) {
    return `残り${stockQuantity}点`;
  }
  return "受注生産";
}

/**
 * 一覧カードでの SOLD OUT 判定（純粋関数）。
 * - description に "sold out" / "在庫切れ" を含む → 在庫なし
 * - sizes が空配列 → 在庫なし
 * - それ以外 → 在庫あり
 */
export function isItemInStock(item: {
  description?: string;
  sizes?: string[];
}): boolean {
  const soldOutText = `${item.description ?? ""}`.toLowerCase();
  if (soldOutText.includes("sold out") || soldOutText.includes("在庫切れ")) {
    return false;
  }
  if (Array.isArray(item.sizes) && item.sizes.length === 0) {
    return false;
  }
  return true;
}
