import React from "react";
import { Button } from "@/components/ui/Button/Button";
import { DiscountBreakdown } from "@/components/DiscountBreakdown";

interface OrderSummaryProps {
  /** 割引前の小計 */
  subtotal: number;
  /** 自動割引の内訳（コードは出さない）。無ければ割引の行を出さない */
  discounts?: ReadonlyArray<{ name: string; amount: number }>;
  totalDiscount?: number;
  /** ゲストの初回割引など、確定前の見込みの額を含む */
  provisional?: boolean;
  /** 数量の変更・削除の応答を待っている間。割引と合計は前回の応答の額なので、薄く出す */
  updating?: boolean;
}

export function OrderSummary({ subtotal, discounts = [], totalDiscount = 0, provisional = false, updating = false }: OrderSummaryProps) {
  const pendingStyle: React.CSSProperties | undefined = updating ? { opacity: 0.5 } : undefined;
  const total = Math.max(0, subtotal - totalDiscount);
  return (
    <div
      className="border border-black/10 sticky top-[var(--site-header-height)]"
      style={{ padding: "calc(var(--lk-size-md) * var(--sqrt-phi))" }}
    >
      <p
        className="font-bold font-display tracking-wider text-[#474747] border-b border-black/10"
        style={{
          fontSize: "var(--lk-size-sm)",
          paddingBottom: "var(--pad-y)",
          marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        }}
      >
        ORDER SUMMARY
      </p>

      <div
        className="border-b border-black/10 flex flex-col"
        style={{
          gap: "var(--pad-x)",
          paddingBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
          marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        }}
      >
        <div className="flex justify-between items-baseline">
          <span className="tracking-wider text-[#474747]" style={{ fontSize: "var(--lk-size-2xs)" }}>
            小計
          </span>
          <span style={{ fontSize: "var(--lk-size-xs)" }}>
            ¥{subtotal.toLocaleString("ja-JP")}
          </span>
        </div>
        {discounts.some((discount) => discount.amount > 0) ? (
          <div data-testid="cart-discount-rows" aria-busy={updating || undefined} style={{ fontSize: "var(--lk-size-xs)", ...pendingStyle }}>
            <DiscountBreakdown
              effects={discounts.map((discount) => ({ name: discount.name, code: null, amount: discount.amount }))}
              showCodes={false}
              provisional={provisional}
            />
          </div>
        ) : null}
        <div className="flex justify-between items-baseline">
          <span className="tracking-wider text-[#474747]" style={{ fontSize: "var(--lk-size-2xs)" }}>
            送料
          </span>
          <span style={{ fontSize: "var(--lk-size-xs)" }}>無料</span>
        </div>
      </div>

      <div
        className="flex items-baseline justify-between"
        style={{ marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))" }}
      >
        <span className="tracking-wider text-[#474747]" style={{ fontSize: "var(--lk-size-2xs)" }}>
          合計（税込）
        </span>
        <span data-testid="cart-total" aria-busy={updating || undefined} style={{ fontSize: "var(--lk-size-lg)", ...(totalDiscount > 0 ? pendingStyle : undefined) }}>
          ¥{total.toLocaleString("ja-JP")}
        </span>
      </div>

      <Button href="/checkout" variant="primary" size="md" className="w-full">
        ご購入手続きへ
      </Button>
    </div>
  );
}
