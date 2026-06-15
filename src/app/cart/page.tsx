"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useCart } from "@/contexts/CartContext";
import { EmptyPage } from "@/components/ui/EmptyPage/EmptyPage";
import { Button } from "@/components/ui/Button/Button";
import { Stepper } from "@/components/ui/Stepper/Stepper";
import { TextField } from "@/components/ui/TextField/TextField";
import { MAX_CART_ITEM_QUANTITY } from "@/features/cart/services/cart-stock";

interface CartItem {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
  // `items` may be null when the product has been removed from inventory;
  // API filters these cases out but we keep the union here for safety.
  items: {
    id: number;
    name: string;
    price: number;
    image_url: string;
    category: string;
  } | null;
}

export default function CartPage() {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [togglingWishlist, setTogglingWishlist] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [syncErrorByItem, setSyncErrorByItem] = useState<
    Record<string, string>
  >({});
  const { updateCartCount, wishlistedItems, toggleWishlist } = useCart();

  // track pending network updates to debounce API calls per-item
  const pendingTimers = React.useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const lastDesired = React.useRef<Record<string, number>>({});
  const failedDesired = React.useRef<Record<string, number>>({});
  const confirmedQuantities = React.useRef<Record<string, number>>({});
  const inFlight = React.useRef<Set<string>>(new Set());

  // clear any outstanding timers on unmount
  useEffect(() => {
    const pendingTimersSnapshot = pendingTimers.current;
    const lastDesiredSnapshot = lastDesired.current;
    const failedDesiredSnapshot = failedDesired.current;
    const confirmedQuantitiesSnapshot = confirmedQuantities.current;
    const inFlightSnapshot = inFlight.current;

    return () => {
      Object.values(pendingTimersSnapshot).forEach(clearTimeout);
      for (const key of Object.keys(pendingTimersSnapshot)) {
        delete pendingTimersSnapshot[key];
      }
      for (const key of Object.keys(lastDesiredSnapshot)) {
        delete lastDesiredSnapshot[key];
      }
      for (const key of Object.keys(failedDesiredSnapshot)) {
        delete failedDesiredSnapshot[key];
      }
      for (const key of Object.keys(confirmedQuantitiesSnapshot)) {
        delete confirmedQuantitiesSnapshot[key];
      }
      inFlightSnapshot.clear();
    };
  }, []);

  useEffect(() => {
    fetchCart({ showLoading: true });
  }, []);

  const fetchCart = async ({
    showLoading = false,
  }: { showLoading?: boolean } = {}) => {
    if (showLoading) {
      setLoading(true);
    }

    try {
      const response = await fetch("/api/cart");
      if (!response.ok) {
        throw new Error("カートの取得に失敗しました");
      }
      const data: CartItem[] = await response.json();
      // filter out any entries where item details are missing (should be rare)
      const filteredItems = data.filter((ci) => ci.items !== null);
      setCartItems(filteredItems);

      const confirmedNext: Record<string, number> = {};
      for (const item of filteredItems) {
        confirmedNext[item.id] = item.quantity;
      }

      confirmedQuantities.current = confirmedNext;
      failedDesired.current = {};
      setSyncErrorByItem({});
      setError(null);
    } catch (err) {
      console.error("Error fetching cart:", err);
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  };

  const rollbackToConfirmed = (cartId: string) => {
    const confirmedQuantity = confirmedQuantities.current[cartId];
    if (typeof confirmedQuantity !== "number") {
      return;
    }

    setCartItems((prev) =>
      prev.map((item) =>
        item.id === cartId ? { ...item, quantity: confirmedQuantity } : item,
      ),
    );
  };

  const scheduleUpdate = (cartId: string) => {
    if (pendingTimers.current[cartId]) {
      clearTimeout(pendingTimers.current[cartId]);
    }
    pendingTimers.current[cartId] = setTimeout(() => sendUpdate(cartId), 500);
  };

  const sendUpdate = async (cartId: string) => {
    delete pendingTimers.current[cartId];
    if (inFlight.current.has(cartId)) {
      // another request already in flight; it will schedule again when done
      return;
    }

    const quantity = lastDesired.current[cartId];
    if (quantity === undefined) return;

    inFlight.current.add(cartId);
    setUpdatingId(cartId);
    try {
      const response = await fetch(`/api/cart/${cartId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        const errorMessage =
          typeof errorPayload?.message === "string"
            ? errorPayload.message
            : typeof errorPayload?.error === "string"
              ? errorPayload.error
              : "数量更新に失敗しました";
        throw new Error(errorMessage);
      }

      const updatedItem = await response.json().catch(() => null);
      const confirmedQuantity =
        typeof updatedItem?.quantity === "number"
          ? updatedItem.quantity
          : quantity;
      confirmedQuantities.current[cartId] = confirmedQuantity;
      delete failedDesired.current[cartId];

      setCartItems((prev) =>
        prev.map((item) =>
          item.id === cartId ? { ...item, quantity: confirmedQuantity } : item,
        ),
      );
      setSyncErrorByItem((prev) => {
        const next = { ...prev };
        delete next[cartId];
        return next;
      });

      await updateCartCount();
    } catch (err) {
      console.error("Error updating quantity:", err);
      failedDesired.current[cartId] = quantity;
      rollbackToConfirmed(cartId);
      setSyncErrorByItem((prev) => ({
        ...prev,
        [cartId]: err instanceof Error ? err.message : "エラーが発生しました",
      }));
    } finally {
      inFlight.current.delete(cartId);
      setUpdatingId(null);
      // if user adjusted quantity again while this request was running,
      // schedule another update reflecting the newest value
      if (lastDesired.current[cartId] !== quantity) {
        scheduleUpdate(cartId);
      }
    }
  };

  const handleRetryUpdate = (cartId: string) => {
    const desiredQuantity = failedDesired.current[cartId];
    if (typeof desiredQuantity !== "number") {
      return;
    }

    lastDesired.current[cartId] = desiredQuantity;
    setCartItems((prev) =>
      prev.map((item) =>
        item.id === cartId ? { ...item, quantity: desiredQuantity } : item,
      ),
    );
    setSyncErrorByItem((prev) => {
      const next = { ...prev };
      delete next[cartId];
      return next;
    });

    if (!inFlight.current.has(cartId)) {
      scheduleUpdate(cartId);
    }
  };

  const handleResyncFromServer = async () => {
    setResyncing(true);
    await fetchCart({ showLoading: false });
    setResyncing(false);
  };

  const hasSyncError = Object.keys(syncErrorByItem).length > 0;

  const handleQuantityChange = (cartId: string, newQuantity: number) => {
    if (newQuantity < 1) return;

    // track latest desired quantity for this item
    lastDesired.current[cartId] = newQuantity;

    // optimistic UI update
    setCartItems((prev) =>
      prev.map((item) =>
        item.id === cartId ? { ...item, quantity: newQuantity } : item,
      ),
    );

    // if no request is currently in flight, start debounce timer
    if (!inFlight.current.has(cartId)) {
      scheduleUpdate(cartId);
    }
  };

  const handleRemove = async (cartId: string) => {
    setUpdatingId(cartId);
    try {
      const response = await fetch(`/api/cart/${cartId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("削除に失敗しました");
      }

      setCartItems(cartItems.filter((item) => item.id !== cartId));

      // Update cart count in context
      await updateCartCount();
    } catch (err) {
      console.error("Error removing from cart:", err);
      alert(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleToggleWishlist = async (itemId: number) => {
    setTogglingWishlist(itemId.toString());
    try {
      await toggleWishlist(itemId);
    } catch (error) {
      console.error("Error toggling wishlist:", error);
      alert(error instanceof Error ? error.message : "エラーが発生しました");
    } finally {
      setTogglingWishlist(null);
    }
  };

  const subtotal = cartItems.reduce(
    (sum, item) => sum + (item.items?.price ?? 0) * item.quantity,
    0,
  );

  const total = subtotal;

  if (loading) {
    return (
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex flex-col">
          <div
            className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]"
            style={{ animationDelay: "0ms" }}
          />
          <div
            className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]"
            style={{ animationDelay: "200ms" }}
          />
          <div
            className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]"
            style={{ animationDelay: "400ms" }}
          />
          <div
            className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]"
            style={{ animationDelay: "600ms" }}
          />
          <div
            className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]"
            style={{ animationDelay: "800ms" }}
          />
        </div>
        <span
          className="relative text-sm tracking-wider text-white mix-blend-difference"
          style={{ fontFamily: "Didot, serif", fontSize: "var(--lk-size-md)" }}
        >
          Loading
        </span>
        <p
          className="absolute bottom-6 left-6 text-xs tracking-wider text-black/40 mix-blend-difference"
          style={{
            fontFamily: "acumin-pro, sans-serif",
            fontSize: "var(--lk-size-xs)",
          }}
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
          "--pad-y":
            "calc((var(--lk-size-md) * var(--sqrt-phi)) / (var(--phi) * var(--phi)))",
          "--gap-icon2text":
            "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))",
        } as React.CSSProperties
      }
    >
      {/* Page heading — 対比: display font vs tiny item count label */}
      {/* <div
        className="flex items-baseline justify-between border-b border-black/10"
        style={{
          paddingBottom: "var(--pad-y)",
          marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi) * var(--phi))",
        }}
      >
        <h1
          className="font-display tracking-tight"
          style={{ fontSize: "var(--lk-size-4xl)" }}
        >
          Cart
        </h1>
        <span
          className="tracking-widest text-[#474747]"
          style={{ fontSize: "var(--lk-size-2xs)" }}
        >
          {cartItems.length} {cartItems.length === 1 ? "ITEM" : "ITEMS"}
        </span>
      </div> */}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
        {/* Items column */}
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
              style={{
                fontSize: "var(--lk-size-xs)",
                padding: "var(--pad-x)",
                gap: "var(--pad-x)",
              }}
            >
              <span>
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

          {cartItems.map((item) => {
            if (!item.items) return null;
            return (
              <div
                key={item.id}
                className="border-b border-black/10 flex"
                style={{
                  paddingTop: "calc(var(--lk-size-md) * var(--sqrt-phi))",
                  paddingBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
                  gap: "calc(var(--lk-size-md) * var(--sqrt-phi))",
                }}
              >
                {/* Thumbnail */}
                <Link
                  href={`/item/${item.items.id}`}
                  className="w-24 h-32 bg-[#f5f5f5] flex-shrink-0 overflow-hidden relative"
                >
                  <Image
                    alt={item.items.name}
                    className="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-500"
                    src={item.items.image_url}
                    fill
                    sizes="96px"
                  />
                </Link>

                {/* Detail — 近接: 2 groups (name+price top / attrs+stepper bottom) */}
                <div className="flex-1 flex flex-col justify-between">
                  {/* Top: name + price / action buttons */}
                  <div
                    className="flex items-start justify-between"
                    style={{ gap: "var(--gap-icon2text)" }}
                  >
                    <Link
                      href={`/item/${item.items.id}`}
                      className="flex flex-col"
                      style={{ gap: "var(--gap-icon2text)" }}
                    >
                      <span
                        className="hover:text-[#474747] transition-colors"
                        style={{ fontSize: "var(--lk-size-sm)" }}
                      >
                        {item.items.name}
                      </span>
                      <span
                        className="text-[#474747]"
                        style={{ fontSize: "var(--lk-size-xs)" }}
                      >
                        ¥{item.items.price.toLocaleString("ja-JP")}
                      </span>
                    </Link>
                    <div
                      className="flex items-center"
                      style={{ gap: "var(--gap-icon2text)" }}
                    >
                      <Button
                        onClick={() => handleToggleWishlist(item.item_id)}
                        disabled={togglingWishlist === item.item_id.toString()}
                        variant="ghost"
                        size="4xs"
                        iconOnly
                      >
                        <div className="w-4 h-4 flex items-center justify-center">
                          <i
                            className={`text-base ${
                              wishlistedItems.has(item.item_id)
                                ? "ri-heart-fill text-red-500"
                                : "ri-heart-line"
                            }`}
                          />
                        </div>
                      </Button>
                      <Button
                        onClick={() => handleRemove(item.id)}
                        disabled={updatingId === item.id}
                        variant="ghost"
                        size="4xs"
                        iconOnly
                      >
                        <div className="w-4 h-4 flex items-center justify-center">
                          <i className="ri-close-line text-base" />
                        </div>
                      </Button>
                    </div>
                  </div>

                  {/* Bottom: attributes + stepper */}
                  <div className="flex items-end justify-between">
                    <div
                      className="flex flex-col"
                      style={{ gap: "var(--gap-icon2text)" }}
                    >
                      {item.color && (
                        <span
                          className="tracking-wider text-[#474747]"
                          style={{ fontSize: "var(--lk-size-2xs)" }}
                        >
                          COLOR <span className="text-black/30">/</span>{" "}
                          {item.color}
                        </span>
                      )}
                      {item.size && (
                        <span
                          className="tracking-wider text-[#474747]"
                          style={{ fontSize: "var(--lk-size-2xs)" }}
                        >
                          SIZE <span className="text-black/30">/</span>{" "}
                          {item.size}
                        </span>
                      )}
                    </div>
                    <Stepper
                      value={item.quantity}
                      min={1}
                      max={MAX_CART_ITEM_QUANTITY}
                      onChange={(value) => handleQuantityChange(item.id, value)}
                      size="4xs"
                    />
                  </div>

                  {/* Per-item sync error */}
                  {syncErrorByItem[item.id] && (
                    <div
                      className="text-red-600 flex items-center justify-between"
                      style={{ gap: "var(--pad-x)" }}
                    >
                      <span style={{ fontSize: "var(--lk-size-xs)" }}>
                        {syncErrorByItem[item.id]}
                      </span>
                      <div
                        className="flex items-center"
                        style={{ gap: "var(--gap-icon2text)" }}
                      >
                        <Button
                          onClick={() => handleRetryUpdate(item.id)}
                          variant="secondary"
                          size="sm"
                        >
                          再試行
                        </Button>
                        <Button
                          onClick={handleResyncFromServer}
                          disabled={resyncing}
                          variant="ghost"
                          size="sm"
                        >
                          最新状態を再取得
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Continue shopping */}
          <div
            style={{ paddingTop: "calc(var(--lk-size-md) * var(--sqrt-phi))" }}
          >
            <Link
              href="/item"
              className="inline-flex items-center text-black hover:text-[#474747] transition-colors tracking-wider"
              style={{
                fontSize: "var(--lk-size-2xs)",
                gap: "var(--gap-icon2text)",
              }}
            >
              <i className="ri-arrow-left-line" />
              CONTINUE SHOPPING
            </Link>
          </div>
        </div>

        {/* Order summary — 反復: all labels share tracking-widest 2xs uppercase */}
        <div className="md:col-span-1">
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

            {/* Promo code */}
            <div
              style={{
                marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
              }}
            >
              <label
                className="block tracking-wider text-[#474747]"
                style={{
                  fontSize: "var(--lk-size-2xs)",
                  marginBottom: "var(--pad-y)",
                }}
              >
                プロモーションコード
              </label>
              <div className="flex" style={{ gap: "var(--gap-icon2text)" }}>
                <TextField
                  placeholder="コードを入力"
                  className="flex-1"
                  type="text"
                  style={{ fontSize: "var(--lk-size-md)" }}
                  size="xs"
                />
                <Button size="xs">適用</Button>
              </div>
            </div>

            {/* Line items — 整列: labels left / amounts right, consistent baseline */}
            <div
              className="border-b border-black/10 flex flex-col"
              style={{
                gap: "var(--pad-x)",
                paddingBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
                marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
              }}
            >
              <div className="flex justify-between items-baseline">
                <span
                  className="tracking-wider text-[#474747]"
                  style={{ fontSize: "var(--lk-size-2xs)" }}
                >
                  小計
                </span>
                <span style={{ fontSize: "var(--lk-size-xs)" }}>
                  ¥{subtotal.toLocaleString("ja-JP")}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span
                  className="tracking-wider text-[#474747]"
                  style={{ fontSize: "var(--lk-size-2xs)" }}
                >
                  送料
                </span>
                <span style={{ fontSize: "var(--lk-size-xs)" }}>無料</span>
              </div>
            </div>

            {/* Total — 対比: 2xs label / 4xl amount */}
            <div
              className="flex items-baseline justify-between"
              style={{
                marginBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
              }}
            >
              <span
                className="tracking-wider text-[#474747]"
                style={{ fontSize: "var(--lk-size-2xs)" }}
              >
                合計
              </span>
              <span style={{ fontSize: "var(--lk-size-lg)" }}>
                ¥{total.toLocaleString("ja-JP")}
              </span>
            </div>

            <Button
              href="/checkout"
              variant="primary"
              size="lg"
              className="w-full"
            >
              ご購入手続きへ
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
