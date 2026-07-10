import React from "react";
import { Button } from "@/components/ui/Button/Button";

interface OrderSummaryProps {
  subtotal: number;
}

export function OrderSummary({ subtotal }: OrderSummaryProps) {
  return (
    <div
      className="border border-black/10 sticky top-32"
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
        <div className="flex justify-between items-baseline">
          <span className="tracking-wider text-[#474747]" style={{ fontSize: "var(--lk-size-2xs)" }}>
            送料
          </span>
          <span style={{ fontSize: "var(--lk-size-xs)" }}>無料</span>
        </div>
      </div>

      <div
        className="flex items-baseline justify-between"
        style={{ marginBottom: "var(--pad-y)" }}
      >
        <span className="tracking-wider text-[#474747]" style={{ fontSize: "var(--lk-size-2xs)" }}>
          合計（税込）
        </span>
        <span style={{ fontSize: "var(--lk-size-lg)" }}>
          ¥{subtotal.toLocaleString("ja-JP")}
        </span>
      </div>

      {/* CT-4 / CT-5: 表示は税込。送料・最終金額は注文手続きで確定する旨を補記 */}
      <p
        className="text-[#474747]"
        style={{
          fontSize: "var(--lk-size-3xs)",
          marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        }}
      >
        価格は税込表示です。送料・最終金額はご購入手続きで確定します。
      </p>

      <Button href="/checkout" variant="primary" size="lg" className="w-full">
        ご購入手続きへ
      </Button>
    </div>
  );
}
