"use client";

// 商品詳細ページのクライアントコンポーネント
// Server Component ラッパー（page.tsx）から id を受け取り、/api/items/:id でデータを取得する
import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { Item } from "@/types/item";
import { useCart } from "@/contexts/CartContext";
import { Button } from "@/components/ui/Button";
import { Stepper } from "@/components/ui/Stepper";
import { RelatedItems } from "@/features/items/components/RelatedItems";

type Props = { id: string };

/** 在庫状態ラベル: NULL=情報なし, 0=SOLD OUT, 1-4=残りわずか, 5+=在庫あり */
function StockBadge({ stockQuantity }: { stockQuantity?: number | null }) {
  if (stockQuantity === null || stockQuantity === undefined) return null;
  if (stockQuantity === 0) {
    return (
      <span
        data-testid="stock-status"
        className="inline-block text-xs tracking-widest font-brand text-white bg-black px-2 py-0.5"
      >
        SOLD OUT
      </span>
    );
  }
  if (stockQuantity <= 4) {
    return (
      <span
        data-testid="stock-status"
        className="inline-block text-xs tracking-widest font-brand text-red-600 border border-red-400 px-2 py-0.5"
      >
        残りわずか
      </span>
    );
  }
  return null;
}

export default function ItemDetailClient({ id }: Props) {
  const { updateCartCount, wishlistedItems, toggleWishlist } = useCart();
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState<string>("");
  const [size, setSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number>(1);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [addingToCart, setAddingToCart] = useState(false);
  const [togglingWishlist, setTogglingWishlist] = useState(false);
  const [isButtonVisible, setIsButtonVisible] = useState(false);
  // 未選択バリデーションエラーを alert() の代わりにインライン表示する
  const [validationError, setValidationError] = useState<string | null>(null);
  const cartButtonRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);

  const isWishlisted = item ? wishlistedItems.has(item.id) : false;
  const isSoldOut =
    item?.stock_quantity !== null &&
    item?.stock_quantity !== undefined &&
    item.stock_quantity === 0;

  useEffect(() => {
    const fetchItem = async () => {
      try {
        const response = await fetch(`/api/items/${id}`);
        if (!response.ok) {
          throw new Error(
            response.status === 404 ? "商品が見つかりません" : "商品データの取得に失敗しました"
          );
        }
        const data: Item = await response.json();
        setItem(data);
        if (data.colors && Array.isArray(data.colors) && data.colors.length > 0) {
          const firstColor = data.colors[0];
          if (typeof firstColor === "object" && firstColor !== null && "name" in firstColor) {
            setColor((firstColor as { name: string }).name);
          }
        }
        if (data.sizes && Array.isArray(data.sizes) && data.sizes.length === 1) {
          setSize(data.sizes[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "エラーが発生しました");
        console.error("Failed to fetch item:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchItem();
  }, [id]);

  useEffect(() => {
    if (!item) return;
    const el = cartButtonRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsButtonVisible(entry.isIntersecting),
      { threshold: 0.5 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [item]);

  const handleCarouselScroll = () => {
    if (!carouselRef.current) return;
    const { scrollLeft, offsetWidth } = carouselRef.current;
    setSelectedImageIndex(Math.round(scrollLeft / offsetWidth));
  };

  const handleAddToCart = async () => {
    if (!item) return;

    const hasColors = item.colors && Array.isArray(item.colors) && item.colors.length > 0;
    const hasSizes = item.sizes && item.sizes.length > 0;

    if ((hasColors && !color) || (hasSizes && !size)) {
      setValidationError("すべてのオプションを選択してください");
      return;
    }
    setValidationError(null);

    setAddingToCart(true);
    try {
      const response = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: item.id, quantity, color, size }),
      });
      if (!response.ok) throw new Error("カートへの追加に失敗しました");
      await updateCartCount();
      setQuantity(1);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : "エラーが発生しました");
      console.error("Error adding to cart:", err);
    } finally {
      setAddingToCart(false);
    }
  };

  const handleToggleWishlist = async () => {
    if (!item) return;
    setTogglingWishlist(true);
    try {
      await toggleWishlist(item.id);
    } catch (err) {
      console.error("Error toggling wishlist:", err);
    } finally {
      setTogglingWishlist(false);
    }
  };

  if (loading) {
    return (
      <div className="pb-12 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-base tracking-widest font-brand">読み込み中...</div>
        </div>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="pb-12 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <Button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                history.back();
              }}
              variant="ghost"
              className="text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 font-brand px-0 py-0"
              size="md"
            >
              <i className="ri-arrow-left-line" />
              BACK TO ITEMS
            </Button>
          </div>
          <div className="text-center">
            <p className="text-base tracking-widest font-brand text-red-500">
              {error || "商品が見つかりません"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const mainImage =
    item.image_urls && item.image_urls.length > selectedImageIndex
      ? item.image_urls[selectedImageIndex]
      : item.image_url;

  const thumbnailImages =
    item.image_urls && item.image_urls.length > 0 ? item.image_urls : [item.image_url];

  // 現在選択中のカラー名（alt テキスト用）
  const activeColorName = color || "";

  return (
    <div className="pb-16 sm:pb-20 lg:pb-24 px-6 sm:px-12 lg:px-24">
      <div className="max-w-7xl mx-auto">
        {/* パンくずナビゲーション (FR-ITEM-DETAIL-010) */}
        <nav aria-label="breadcrumb" className="mb-6 lg:mb-8">
          <ol className="flex items-center gap-2 text-xs tracking-widest font-brand text-[#888]">
            <li>
              <Link href="/" className="hover:text-black transition-colors">
                HOME
              </Link>
            </li>
            <li aria-hidden="true">
              <i className="ri-arrow-right-s-line" />
            </li>
            <li>
              <Link href="/item" className="hover:text-black transition-colors">
                ITEMS
              </Link>
            </li>
            <li aria-hidden="true">
              <i className="ri-arrow-right-s-line" />
            </li>
            <li className="text-black truncate max-w-[200px]" aria-current="page">
              {item.name}
            </li>
          </ol>
        </nav>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[5fr_7fr] gap-8 md:gap-6 lg:gap-12 xl:gap-16 lg:w-fit">
          <div className="md:sticky md:top-24 lg:top-28 lg:w-fit">
            {/* モバイル: 横スクロールカルーセル */}
            <div className="md:hidden">
              <div
                ref={carouselRef}
                className="flex overflow-x-scroll snap-x snap-mandatory w-full touch-pan-x"
                style={{ scrollbarWidth: "none", msOverflowStyle: "none" } as React.CSSProperties}
                onScroll={handleCarouselScroll}
              >
                {thumbnailImages.map((imgUrl: string, index: number) => (
                  <div
                    key={index}
                    className="snap-start flex-shrink-0 min-w-full relative bg-white overflow-hidden"
                    style={{ height: "min(calc(100svh - 14rem), 470px)" }}
                  >
                    {imgUrl ? (
                      <Image
                        src={imgUrl}
                        alt={
                          activeColorName
                            ? `${item.name} - ${activeColorName} - ${index + 1}枚目`
                            : `${item.name} - ${index + 1}枚目`
                        }
                        fill
                        className="object-contain object-center"
                        priority={index === 0}
                        sizes="100vw"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
                        No Image
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {thumbnailImages.length > 1 && (
                <div className="flex gap-1.5 justify-center mt-2">
                  {thumbnailImages.map((_, i) => (
                    <div
                      key={i}
                      className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${
                        i === selectedImageIndex ? "bg-black" : "bg-black/20"
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* デスクトップ: 静的画像 + サムネイル */}
            <div className="hidden md:flex flex-col gap-2 lg:w-fit">
              <div className="relative aspect-[3/4] lg:aspect-auto lg:h-[calc(100vh-22rem)] lg:w-[calc((100vh-22rem)*3/4)] lg:max-w-full bg-white overflow-hidden">
                {mainImage ? (
                  <Image
                    src={mainImage}
                    alt={
                      activeColorName
                        ? `${item.name} - ${activeColorName} - ${selectedImageIndex + 1}枚目`
                        : `${item.name} - ${selectedImageIndex + 1}枚目`
                    }
                    fill
                    className="object-contain object-left-top"
                    priority
                    sizes="(max-width: 1024px) 45vw, 35vw"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-400">
                    No Image
                  </div>
                )}
              </div>

              {thumbnailImages.length > 1 && (
                <div className="flex gap-3 overflow-x-auto px-[3px] py-[3px]">
                  {thumbnailImages.map((imgUrl: string, index: number) => (
                    <button
                      key={index}
                      type="button"
                      aria-label={`${item.name} ${index + 1}枚目を表示`}
                      className={`relative flex-shrink-0 w-20 md:w-24 aspect-[3/4] bg-[#f5f5f5] overflow-hidden cursor-pointer focus-visible:outline-none transition-opacity duration-200 ${
                        selectedImageIndex === index
                          ? "ring-2 ring-black opacity-100"
                          : "opacity-50 hover:opacity-90"
                      }`}
                      onClick={() => setSelectedImageIndex(index)}
                    >
                      <Image
                        src={imgUrl}
                        alt={`${item.name} サムネイル${index + 1}枚目`}
                        fill
                        className="object-cover object-top"
                        sizes="80px"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4 lg:space-y-6">
            <div>
              <h2 className="sm:text-base md:text-lg lg:text-xl text-black tracking-tight font-brand">
                {item.name}
              </h2>
              <div className="flex items-center gap-3 mt-1">
                <p className="text-sm md:text-base lg:text-lg text-black font-brand">
                  ¥{item.price.toLocaleString("ja-JP")}
                </p>
                {/* 在庫状態バッジ (FR-ITEM-DETAIL-007) */}
                <StockBadge stockQuantity={item.stock_quantity} />
              </div>
            </div>

            {/* カラー選択 (FR-ITEM-DETAIL-008: aria-pressed) */}
            {item.colors && Array.isArray(item.colors) && item.colors.length > 0 && (
              <div>
                <h3 className="text-xs md:text-sm tracking-widest mb-2 font-brand">COLOR</h3>
                <div className="flex gap-3 flex-wrap">
                  {(item.colors as unknown as Array<{ hex: string; name: string }>).map(
                    (colorOption) => (
                      <Button
                        key={colorOption.name}
                        onClick={() => {
                          setColor(colorOption.name);
                          setValidationError(null);
                        }}
                        variant={color === colorOption.name ? "primary" : "secondary"}
                        size="sm"
                        className="font-brand"
                        aria-pressed={color === colorOption.name}
                      >
                        {colorOption.name}
                      </Button>
                    )
                  )}
                </div>
              </div>
            )}

            {/* サイズ選択 (FR-ITEM-DETAIL-008: aria-pressed) */}
            {item.sizes && item.sizes.length > 0 && (
              <div>
                <h3 className="text-xs md:text-sm tracking-widest mb-2 font-brand">SIZE</h3>
                <div className="flex gap-3 flex-wrap">
                  {item.sizes.map((sizeOption: string) => (
                    <Button
                      key={sizeOption}
                      onClick={() => {
                        setSize(sizeOption);
                        setValidationError(null);
                      }}
                      variant={size === sizeOption ? "primary" : "secondary"}
                      size="sm"
                      className="font-brand"
                      aria-pressed={size === sizeOption}
                    >
                      {sizeOption}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-xs md:text-sm tracking-widest mb-2 font-brand">QUANTITY</h3>
              <Stepper value={quantity} min={1} onChange={setQuantity} size="sm" />
            </div>

            {/* バリデーションエラーメッセージ (FR-ITEM-DETAIL-008: role="alert") */}
            {validationError && (
              <p role="alert" className="text-xs text-red-500 font-brand">
                {validationError}
              </p>
            )}

            {item.description && (
              <div className="border-t border-black/10 pt-4 lg:pt-6">
                <p className="text-xs md:text-sm text-[#474747] leading-relaxed font-brand">
                  {item.description}
                </p>
              </div>
            )}

            {item.product_details && (
              <div className="border-t border-black/10 py-4 lg:py-6">
                <h3 className="text-sm tracking-widest mb-4 font-brand">PRODUCT DETAILS</h3>
                {typeof item.product_details === "string" ? (
                  <p className="text-xs md:text-sm text-[#474747] font-brand whitespace-pre-line">
                    {item.product_details}
                  </p>
                ) : Array.isArray(item.product_details) ? (
                  <ul className="space-y-2">
                    {item.product_details.map((detail: string, idx: number) => (
                      <li key={idx} className="text-xs md:text-sm text-[#474747] font-brand">
                        {detail}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="space-y-2">
                    {Object.entries(item.product_details!).map(
                      ([key, value]: [string, unknown]) => (
                        <li key={key} className="text-xs md:text-sm text-[#474747] font-brand">
                          {String(value)}
                        </li>
                      )
                    )}
                  </ul>
                )}
              </div>
            )}

            {/* カート追加・ウィッシュリストボタン */}
            <div ref={cartButtonRef} className="flex gap-4">
              <Button
                onClick={handleAddToCart}
                disabled={addingToCart || isSoldOut}
                size="md"
                className="w-full font-brand"
              >
                {isSoldOut ? (
                  "SOLD OUT"
                ) : addingToCart ? (
                  "追加中..."
                ) : (
                  <div className="gap-2 flex items-center justify-center">
                    <div className="w-4 h-4 flex items-center justify-center">
                      <i className="ri-shopping-bag-line text-base" />
                    </div>
                    ADD TO CART
                  </div>
                )}
              </Button>
              <Button
                onClick={handleToggleWishlist}
                disabled={togglingWishlist}
                variant="secondary"
                size="md"
                aria-label="Add to wishlist"
                className="aspect-square px-0 hover:bg-transparent hover:text-current"
              >
                <div className="w-5 h-5 flex items-center justify-center">
                  <i
                    className={`text-xl ${
                      isWishlisted ? "ri-heart-fill text-red-500" : "ri-heart-line"
                    }`}
                  />
                </div>
              </Button>
            </div>
          </div>
        </div>

        {/* 関連商品セクション (FR-ITEM-DETAIL-012) */}
        <RelatedItems currentItemId={item.id} category={item.category} />
      </div>

      {/* モバイル固定フッター (FR-ITEM-DETAIL-006) */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white border-t border-black/10 px-6 py-3 flex gap-3 transition-transform duration-300 ${
          isButtonVisible ? "translate-y-full" : "translate-y-0"
        }`}
      >
        <Button
          onClick={handleAddToCart}
          disabled={addingToCart || isSoldOut}
          size="sm"
          className="w-full font-brand"
        >
          {isSoldOut ? (
            "SOLD OUT"
          ) : addingToCart ? (
            "追加中..."
          ) : (
            <div className="gap-2 flex items-center justify-center">
              <div className="w-4 h-4 flex items-center justify-center">
                <i className="ri-shopping-bag-line text-base" />
              </div>
              ADD TO CART
            </div>
          )}
        </Button>
        <Button
          onClick={handleToggleWishlist}
          disabled={togglingWishlist}
          variant="secondary"
          size="sm"
          aria-label="Add to wishlist"
          className="aspect-square px-0 hover:bg-transparent hover:text-current"
        >
          <div className="w-5 h-5 flex items-center justify-center">
            <i
              className={`text-xl ${
                isWishlisted ? "ri-heart-fill text-red-500" : "ri-heart-line"
              }`}
            />
          </div>
        </Button>
      </div>
    </div>
  );
}
