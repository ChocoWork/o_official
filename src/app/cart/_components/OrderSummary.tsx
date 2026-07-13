import React from "react";
import { Button } from "@/components/ui/Button/Button";

interface OrderSummaryProps {
  subtotal: number;
}

export function OrderSummary({ subtotal }: OrderSummaryProps) {
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
        <span style={{ fontSize: "var(--lk-size-lg)" }}>
          ¥{subtotal.toLocaleString("ja-JP")}
        </span>
      </div>

      <Button href="/checkout" variant="primary" size="md" className="w-full">
        ご購入手続きへ
      </Button>
    </div>
  );
}
