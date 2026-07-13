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
  // ラベル(COLOR/SIZE)は値より一段小さく・字間も狭めて従属させる（対比）
  const variantLabelStyle = {
    fontSize: "var(--lk-size-4xs)",
    letterSpacing: "0.02em",
  } as const;

  return (
    <div
      className="border-b border-black/10 flex"
      style={{
        paddingTop: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        paddingBottom: "calc(var(--lk-size-md) * var(--sqrt-phi))",
        gap: "calc(var(--lk-size-md) / var(--sqrt-phi))",
      }}
    >
      <Link
        href={`/item/${product.id}`}
        className="w-16 self-start flex-shrink-0 overflow-hidden relative block"
      >
        <Image
          alt={product.name}
          className="w-full h-auto object-contain hover:scale-105 transition-transform duration-500"
          src={product.image_url}
          width={0}
          height={0}
          sizes="64px"
        />
      </Link>

      <div className="flex-1 flex flex-col justify-between gap-y-4 sm:gap-y-0">
        {/* 上段: 商品名・バリアント */}
        <div
          className="flex flex-col"
          style={{ gap: "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi) / var(--phi))" }}
        >
          <div
            className="flex items-start justify-between"
            style={{ gap: "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))" }}
          >
            <Link
              href={`/item/${product.id}`}
              className="font-brand tracking-tight hover:text-[#474747] transition-colors"
              style={{ fontSize: "var(--lk-size-2xs)" }}
            >
              {product.name}
            </Link>
            <div
              className="flex items-center flex-shrink-0"
              style={{ gap: "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))" }}
            >
              <Button
                onClick={() => onToggleWishlist(item.item_id)}
                disabled={isTogglingWishlist}
                variant="ghost"
                size="4xs"
                iconOnly
                aria-label="ウィッシュリストに追加"
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
                aria-label="カートから削除"
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-close-line text-base" />
                </div>
              </Button>
            </div>
          </div>

          {/* バリアント（色/サイズ）: ラベル(COLOR/SIZE)＋値の2行。
              対比=ラベルは値より小さく淡い色で従属、値を優先。整列=ラベル/コロン/値を列で揃える。
              反復=両行で同一ルール。近接=行間を詰めて1グループに。 */}
          {(item.color || item.size) && (
            <div
              data-testid="cart-variant"
              className="text-[#474747] grid grid-cols-[auto_auto_1fr] items-baseline w-fit"
              style={{
                fontSize: "var(--lk-size-3xs)",
                rowGap: "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi) / var(--phi) / var(--phi))",
              }}
            >
              {item.color && (
                <>
                  <span data-variant-label className="text-[#767676]" style={variantLabelStyle}>
                    COLOR
                  </span>
                  <span aria-hidden="true" className="text-[#767676]" style={variantLabelStyle}>
                    ：
                  </span>
                  <span>{item.color}</span>
                </>
              )}
              {item.size && (
                <>
                  <span data-variant-label className="text-[#767676]" style={variantLabelStyle}>
                    SIZE
                  </span>
                  <span aria-hidden="true" className="text-[#767676]" style={variantLabelStyle}>
                    ：
                  </span>
                  <span>{item.size}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* 下段: 単価と数量。画像下端に揃える */}
        <div
          className="flex flex-col"
          style={{ gap: "calc(var(--lk-size-md) / var(--sqrt-phi))" }}
        >
          <div className="flex items-end justify-between">
            {/* 単価 */}
            <span
              className="text-black font-medium"
              style={{ fontSize: "var(--lk-size-2xs)" }}
            >
              ¥{product.price.toLocaleString("ja-JP")}
            </span>
            <Stepper
              value={item.quantity}
              min={1}
              max={MAX_CART_ITEM_QUANTITY}
              onChange={(value) => onQuantityChange(item.id, value)}
              size="2xs"
            />
          </div>

          {syncError && (
          <div
            className="text-red-600 flex items-center justify-between"
            style={{ gap: "calc(var(--lk-size-md) / var(--sqrt-phi))" }}
          >
            <span style={{ fontSize: "var(--lk-size-xs)" }}>{syncError}</span>
            <div
              className="flex items-center"
              style={{ gap: "calc(var(--lk-size-md) / var(--sqrt-phi) / var(--phi))" }}
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
    </div>
  );
}
