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
    return (
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex flex-col">
          {[0, 200, 400, 600, 800].map((delay) => (
            <div
              key={delay}
              className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
        <span
          className="relative text-sm tracking-wider text-white mix-blend-difference"
          style={{ fontFamily: "Didot, serif", fontSize: "var(--lk-size-md)" }}
        >
          Loading
        </span>
        <p
          className="absolute bottom-6 left-6 text-xs tracking-wider text-black/40 mix-blend-difference"
          style={{ fontFamily: "acumin-pro, sans-serif", fontSize: "var(--lk-size-xs)" }}
        >
          BARS REVEAL
        </p>
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
      className="element-width"
      style={
        {
          "--pad-x": "calc(var(--lk-size-md) / var(--sqrt-phi))",
          "--pad-y": "calc((var(--lk-size-md) * var(--sqrt-phi)) / (var(--phi) * var(--phi)))",
          "--gap-icon2text": "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))",
        } as React.CSSProperties
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
        <div className="md:col-span-2">
          {error && (
            <div
              className="text-red-500 border border-red-300 bg-red-50 mb-6"
              style={{ fontSize: "var(--lk-size-md)", padding: "var(--pad-x)" }}
            >
              {error}
            </div>
          )}

          {hasSyncError && (
            <div
              className="text-amber-700 border border-amber-300 bg-amber-50 flex items-center justify-between mb-6"
              style={{ fontSize: "var(--lk-size-xs)", padding: "var(--pad-x)", gap: "var(--pad-x)" }}
            >
              <span>数量の更新に失敗した商品があります。再試行または再同期してください。</span>
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
              className="inline-flex items-center text-black hover:text-[#474747] transition-colors tracking-wider"
              style={{ fontSize: "var(--lk-size-2xs)", gap: "var(--gap-icon2text)" }}
            >
              <i className="ri-arrow-left-line" />
              CONTINUE SHOPPING
            </Link>
          </div>
        </div>

        <div className="md:col-span-1">
          <OrderSummary subtotal={subtotal} />
        </div>
      </div>
    </div>
  );
}
