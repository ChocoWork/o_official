"use client";

import React from "react";
import Link from "next/link";
import { EmptyPage } from "@/components/ui/EmptyPage/EmptyPage";
import { Button } from "@/components/ui/Button/Button";
import { useCartItems } from "./_hooks/useCartItems";
import { CartItemRow } from "./_components/CartItemRow";
import { OrderSummary } from "./_components/OrderSummary";

export default function CartPage() {
  const {
    cartItems,
    loading,
    error,
    updatingId,
    togglingWishlist,
    resyncing,
    syncErrorByItem,
    hasSyncError,
    subtotal,
    wishlistedItems,
    handleQuantityChange,
    handleRetryUpdate,
    handleRemove,
    handleToggleWishlist,
    handleResyncFromServer,
  } = useCartItems();

  if (loading) {
    // CT-1: 黒バー明滅 + デバッグ文言を廃し、カートレイアウトの控えめなスケルトンに
    return (
      <div className="max-w-5xl mx-auto w-full">
        <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-8" aria-hidden="true">
          <div>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border-b border-black/10 flex gap-4 py-6 animate-pulse">
                <div className="w-20 h-24 flex-shrink-0 bg-black/8" />
                <div className="flex-1 flex flex-col gap-2">
                  <div className="h-4 w-2/3 bg-black/8" />
                  <div className="h-3 w-1/4 bg-black/5" />
                  <div className="mt-auto flex items-end justify-between">
                    <div className="h-4 w-20 bg-black/8" />
                    <div className="h-7 w-24 bg-black/5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="border border-black/10 p-6 animate-pulse space-y-4">
              <div className="h-4 w-1/3 bg-black/8" />
              <div className="h-3 w-full bg-black/5" />
              <div className="h-3 w-full bg-black/5" />
              <div className="h-10 w-full bg-black/8 mt-4" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (cartItems.length === 0) {
    return (
      <EmptyPage
        iconClassName="ri-shopping-bag-line"
        label="YOUR CART IS EMPTY"
        size="xs"
        buttonLabel="CONTINUE SHOPPING"
        href="/item"
      />
    );
  }

  return (
    <div
      className="max-w-5xl mx-auto w-full"
      style={
        {
          "--pad-x": "calc(var(--lk-size-md) / var(--sqrt-phi))",
          "--pad-y": "calc((var(--lk-size-md) * var(--sqrt-phi)) / (var(--phi) * var(--phi)))",
          "--gap-icon2text": "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))",
        } as React.CSSProperties
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-8">
        <div>
          {error && (
            <div
              role="alert"
              className="text-red-600 border border-black/15 bg-black/[0.02] mb-6"
              style={{ fontSize: "var(--lk-size-md)", padding: "var(--pad-x)" }}
            >
              {error}
            </div>
          )}

          {hasSyncError && (
            <div
              role="status"
              className="text-[#474747] border border-black/20 bg-black/[0.02] flex items-center justify-between mb-6"
              style={{ fontSize: "var(--lk-size-xs)", padding: "var(--pad-x)", gap: "var(--pad-x)" }}
            >
              <span className="flex items-center gap-2">
                <i className="ri-error-warning-line" aria-hidden="true" />
                数量の更新に失敗した商品があります。再試行または再同期してください。
              </span>
              <Button
                onClick={handleResyncFromServer}
                disabled={resyncing}
                variant="secondary"
                size="sm"
              >
                {resyncing ? "再同期中..." : "最新状態を再取得"}
              </Button>
            </div>
          )}

          {cartItems.map((item) => (
            <CartItemRow
              key={item.id}
              item={item}
              isUpdating={updatingId === item.id}
              isTogglingWishlist={togglingWishlist === item.item_id.toString()}
              isWishlisted={wishlistedItems.has(item.item_id)}
              syncError={syncErrorByItem[item.id]}
              resyncing={resyncing}
              onQuantityChange={handleQuantityChange}
              onRemove={handleRemove}
              onToggleWishlist={handleToggleWishlist}
              onRetryUpdate={handleRetryUpdate}
              onResync={handleResyncFromServer}
            />
          ))}

          <div style={{ paddingTop: "calc(var(--lk-size-md) * var(--sqrt-phi))" }}>
            <Link
              href="/item"
              className="group inline-flex items-center text-[#767676]"
              style={{
                fontSize: "var(--lk-size-2xs)",
                gap: "var(--gap-icon2text)",
                letterSpacing: "0.08em",
              }}
            >
              <i className="ri-arrow-left-line transition-transform duration-150 group-hover:-translate-x-[3px] motion-reduce:transition-none" />
              CONTINUE SHOPPING
            </Link>
          </div>
        </div>

        <div>
          <OrderSummary subtotal={subtotal} />
        </div>
      </div>
    </div>
  );
}
