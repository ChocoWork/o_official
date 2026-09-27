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
