import React from "react";
import type { DiscountEffect } from "@/lib/discounts/discount-types";

export type DiscountBreakdownProps = {
  effects: readonly Pick<DiscountEffect, "name" | "code" | "amount">[];
  /** 本人が入力したコードを出す画面だけ true（カートでは false）。 */
  showCodes: boolean;
  /** ゲストの初回・１人１回など、確定前の見込みの額。 */
  provisional?: boolean;
};

const LIST_STYLE: React.CSSProperties = {
  listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--gap-group, 0.5rem)", fontSize: "inherit",
};
const ROW_STYLE: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", columnGap: "var(--gap-group, 0.5rem)",
};
const LABEL_STYLE: React.CSSProperties = { minWidth: 0, overflowWrap: "anywhere", color: "#474747" };

/**
 * 割引の内訳。正額の効果だけを１効果１行で「割引（名前） −¥金額」と出す。
 * 入力・最終確認・カート、顧客と管理の注文表示が同じ部品を使う。名前は文字として出す（HTMLは実行しない）。
 * 文字の大きさは呼び出し側に合わせる（inherit）。
 */
export function DiscountBreakdown({ effects, showCodes, provisional = false }: DiscountBreakdownProps): React.JSX.Element | null {
  const rows = effects.filter((effect) => effect.amount > 0);
  if (rows.length === 0) return null;
  return (
    <ul aria-label="割引の内訳" style={LIST_STYLE}>
      {rows.map((effect, index) => (
        <li key={`${index}|${effect.name}|${effect.code ?? ""}`} style={ROW_STYLE}>
          <span style={LABEL_STYLE}>
            割引（{effect.name}）
            {showCodes && effect.code ? <> <span>{effect.code}</span></> : null}
            {provisional ? <> <span>見込み</span></> : null}
          </span>{" "}
          <span>−¥{effect.amount.toLocaleString("ja-JP")}</span>
        </li>
      ))}
    </ul>
  );
}
