import React from "react";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/Button/Button";
import { Stepper } from "@/components/ui/Stepper/Stepper";
import { MAX_CART_ITEM_QUANTITY } from "@/features/cart/services/cart-stock";
import type { CartEntry } from "../_hooks/useCartItems";

interface CartItemRowProps {
  item: CartEntry;
  isUpdating: boolean;
  isTogglingWishlist: boolean;
  isWishlisted: boolean;
  syncError?: string;
  resyncing: boolean;
  onQuantityChange: (cartId: string, qty: number) => void;
  onRemove: (cartId: string) => void;
  onToggleWishlist: (itemId: number) => void;
  onRetryUpdate: (cartId: string) => void;
  onResync: () => void;
}

export function CartItemRow({
  item,
  isUpdating,
  isTogglingWishlist,
  isWishlisted,
  syncError,
  resyncing,
  onQuantityChange,
  onRemove,
  onToggleWishlist,
  onRetryUpdate,
  onResync,
}: CartItemRowProps) {
  if (!item.items) return null;
  const product = item.items;

  return (
    <div
      className="border-b border-black/10 flex"
      style={{
        paddingTop: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        paddingBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        gap: "calc(var(--lk-size-md) * var(--sqrt-phi))",
      }}
    >
      <Link
        href={`/item/${product.id}`}
        className="w-24 h-32 bg-[#f5f5f5] flex-shrink-0 overflow-hidden relative"
      >
        <Image
          alt={product.name}
          className="w-full h-full object-cover object-top hover:scale-105 transition-transform duration-500"
          src={product.image_url}
          fill
          sizes="96px"
        />
      </Link>

      <div className="flex-1 flex flex-col justify-between">
        <div
          className="flex items-start justify-between"
          style={{ gap: "var(--gap-icon2text)" }}
        >
          <Link
            href={`/item/${product.id}`}
            className="flex flex-col"
            style={{ gap: "var(--gap-icon2text)" }}
          >
            <span
              className="hover:text-[#474747] transition-colors"
              style={{ fontSize: "var(--lk-size-sm)" }}
            >
              {product.name}
            </span>
            <span
              className="text-[#474747]"
              style={{ fontSize: "var(--lk-size-xs)" }}
            >
              ¥{product.price.toLocaleString("ja-JP")}
            </span>
          </Link>
          <div
            className="flex items-center"
            style={{ gap: "var(--gap-icon2text)" }}
          >
            <Button
              onClick={() => onToggleWishlist(item.item_id)}
              disabled={isTogglingWishlist}
              variant="ghost"
              size="4xs"
              iconOnly
            >
              <div className="w-4 h-4 flex items-center justify-center">
                <i
                  className={`text-base ${
                    isWishlisted ? "ri-heart-fill text-red-500" : "ri-heart-line"
                  }`}
                />
              </div>
            </Button>
            <Button
              onClick={() => onRemove(item.id)}
              disabled={isUpdating}
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
                COLOR <span className="text-black/30">/</span> {item.color}
              </span>
            )}
            {item.size && (
              <span
                className="tracking-wider text-[#474747]"
                style={{ fontSize: "var(--lk-size-2xs)" }}
              >
                SIZE <span className="text-black/30">/</span> {item.size}
              </span>
            )}
          </div>
          <Stepper
            value={item.quantity}
            min={1}
            max={MAX_CART_ITEM_QUANTITY}
            onChange={(value) => onQuantityChange(item.id, value)}
            size="4xs"
          />
        </div>

        {syncError && (
          <div
            className="text-red-600 flex items-center justify-between"
            style={{ gap: "var(--pad-x)" }}
          >
            <span style={{ fontSize: "var(--lk-size-xs)" }}>{syncError}</span>
            <div
              className="flex items-center"
              style={{ gap: "var(--gap-icon2text)" }}
            >
              <Button onClick={() => onRetryUpdate(item.id)} variant="secondary" size="sm">
                再試行
              </Button>
              <Button onClick={onResync} disabled={resyncing} variant="ghost" size="sm">
                最新状態を再取得
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
