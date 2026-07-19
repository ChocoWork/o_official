"use client";

// 商品詳細ページのクライアントコンポーネント
// Server Component ラッパー（page.tsx）から id を受け取り、/api/items/:id でデータを取得する
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Item, ItemStockStatus } from "@/types/item";
import { useCart } from "@/contexts/CartContext";
import { Button } from "@/components/ui/Button/Button";
import { RelatedItems } from "@/features/items/components/RelatedItems";

type Props = { id: string };

type ItemActionButtonsProps = {
  addedToCart: boolean;
  addingToCart: boolean;
  isSoldOut: boolean;
  isWishlisted: boolean;
  togglingWishlist: boolean;
  onAddToCart: () => void;
  onToggleWishlist: () => void;
};

function ItemActionButtons({
  addedToCart,
  addingToCart,
  isSoldOut,
  isWishlisted,
  togglingWishlist,
  onAddToCart,
  onToggleWishlist,
}: ItemActionButtonsProps) {
  return (
    <div className="flex w-full gap-3">
      <Button
        onClick={onAddToCart}
        disabled={addingToCart || isSoldOut}
        size="2xs"
        className="w-full"
      >
        {isSoldOut ? (
          "SOLD OUT"
        ) : addedToCart ? (
          <div className="flex items-center justify-center gap-2">
            <i className="ri-check-line text-base" />
            ADDED
          </div>
        ) : addingToCart ? (
          "追加中..."
        ) : (
          <div className="flex items-center justify-center gap-2">
            <div className="flex h-4 w-4 items-center justify-center">
              <i className="ri-shopping-bag-line text-base" />
            </div>
            ADD TO CART
          </div>
        )}
      </Button>
      <Button
        onClick={onToggleWishlist}
        disabled={togglingWishlist}
        variant="secondary"
        size="2xs"
        iconOnly
        aria-label="Add to wishlist"
        className="aspect-square px-0 hover:bg-transparent hover:text-current"
      >
        <div className="flex h-4 w-4 items-center justify-center">
          <i
            className={`text-base ${
              isWishlisted ? "ri-heart-fill text-red-500" : "ri-heart-line"
            }`}
          />
        </div>
      </Button>
    </div>
  );
}

/** 在庫状態ラベル: unknown=情報なし, sold_out=SOLD OUT, low_stock=残りわずか */
function StockBadge({ stockStatus }: { stockStatus?: ItemStockStatus }) {
  if (!stockStatus || stockStatus === "unknown" || stockStatus === "in_stock")
    return null;

  if (stockStatus === "sold_out") {
    return (
      <span
        data-testid="stock-status"
        className="inline-block text-xs tracking-widest text-white bg-black px-2 py-0.5"
      >
        SOLD OUT
      </span>
    );
  }

  if (stockStatus === "low_stock") {
    return (
      <span
        data-testid="stock-status"
        className="inline-block text-xs tracking-widest text-red-600 border border-red-400 px-2 py-0.5"
      >
        残りわずか
      </span>
    );
  }

  return null;
}

function resolveStockStatus(item: Item): ItemStockStatus {
  if (item.stockStatus) {
    return item.stockStatus;
  }

  // Backward compatibility for tests or old fixtures that still send stock_quantity.
  if (item.stock_quantity === null || item.stock_quantity === undefined) {
    return "unknown";
  }
  if (item.stock_quantity === 0) {
    return "sold_out";
  }
  if (item.stock_quantity <= 4) {
    return "low_stock";
  }
  return "in_stock";
}

export default function ItemDetailClient({ id }: Props) {
  const router = useRouter();
  const { updateCartCount, wishlistedItems, toggleWishlist } = useCart();
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState<string>("");
  const [size, setSize] = useState<string | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [addingToCart, setAddingToCart] = useState(false);
  const [addedToCart, setAddedToCart] = useState(false);
  const [togglingWishlist, setTogglingWishlist] = useState(false);
  const [isMainActionBelowViewport, setIsMainActionBelowViewport] =
    useState(true);
  // 未選択バリデーションエラーを alert() の代わりにインライン表示する
  const [validationError, setValidationError] = useState<string | null>(null);
  const cartButtonRef = useRef<HTMLDivElement>(null);
  const tabletCarouselRef = useRef<HTMLDivElement>(null);

  const isWishlisted = item ? wishlistedItems.has(item.id) : false;
  const stockStatus = item ? resolveStockStatus(item) : "unknown";
  const isSoldOut = stockStatus === "sold_out";

  useEffect(() => {
    const fetchItem = async () => {
      try {
        const response = await fetch(`/api/items/${id}`);
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "商品が見つかりません"
              : "商品データの取得に失敗しました",
          );
        }
        const data: Item = await response.json();
        setItem(data);
        if (
          data.colors &&
          Array.isArray(data.colors) &&
          data.colors.length > 0
        ) {
          const firstColor = data.colors[0];
          if (
            typeof firstColor === "object" &&
            firstColor !== null &&
            "name" in firstColor
          ) {
            setColor((firstColor as { name: string }).name);
          }
        }
        if (
          data.sizes &&
          Array.isArray(data.sizes) &&
          data.sizes.length === 1
        ) {
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

  useLayoutEffect(() => {
    if (!item) return;
    const el = cartButtonRef.current;
    if (!el) return;

    const updateFixedActionVisibility = () => {
      const rect = el.getBoundingClientRect();
      setIsMainActionBelowViewport(rect.top >= window.innerHeight);
    };

    // Observer の初回通知を待たず、固定CTAを初期表示する。
    // 本体CTAが画面内または画面より上にある場合は、固定CTAを表示しない。
    updateFixedActionVisibility();

    let animationFrameId: number | null = null;
    const requestVisibilityUpdate = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        updateFixedActionVisibility();
      });
    };

    const observer = new IntersectionObserver(requestVisibilityUpdate, {
      threshold: 0,
    });
    observer.observe(el);
    window.addEventListener("scroll", requestVisibilityUpdate, {
      passive: true,
    });
    window.addEventListener("resize", requestVisibilityUpdate);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", requestVisibilityUpdate);
      window.removeEventListener("resize", requestVisibilityUpdate);
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [item]);

  // タブレットカルーセルの前後送りボタン: 指定インデックスのスライドへスクロールする (FREQ-172)
  const scrollTabletCarouselTo = (index: number) => {
    const el = tabletCarouselRef.current;
    if (!el) return;
    const firstSlide = el.children[0] as HTMLElement | undefined;
    if (!firstSlide) return;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    el.scrollTo({
      left: index * (firstSlide.offsetWidth + gap),
      behavior: "smooth",
    });
  };

  const handleCarouselScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const firstSlide = el.children[0] as HTMLElement | undefined;
    if (!firstSlide) return;
    // ピーク表示 (FREQ-158) によりスライド幅 < コンテナ幅のため、
    // スライド幅 + gap を1スライド分の移動量としてインデックスを算出する
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const stride = firstSlide.offsetWidth + gap;
    setSelectedImageIndex(Math.round(el.scrollLeft / stride));
  };

  const handleAddToCart = async () => {
    if (!item) return;

    const hasColors =
      item.colors && Array.isArray(item.colors) && item.colors.length > 0;
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
        body: JSON.stringify({ item_id: item.id, quantity: 1, color, size }),
      });
      if (!response.ok) throw new Error("カートへの追加に失敗しました");
      await updateCartCount();
      setAddedToCart(true);
      setTimeout(() => setAddedToCart(false), 2000);
    } catch (err) {
      setValidationError(
        err instanceof Error ? err.message : "エラーが発生しました",
      );
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
      <div>
        <div className="element-width 2xl:max-w-[90rem]">
          <div className="mb-4 sm:mb-5 h-3 w-44 bg-black/5 animate-pulse" />
          <div className="grid grid-cols-1 gap-8 md:-mx-5 md:grid-cols-[58%_42%] md:gap-0">
            <div className="aspect-[2/3] bg-black/5 animate-pulse" />
            <div className="space-y-6 pt-1 md:sticky md:top-36 md:mx-auto md:w-[max(18.125rem,calc(100%-8.75rem))] md:self-start">
              <div className="space-y-2">
                <div className="h-5 w-3/4 bg-black/5 animate-pulse" />
                <div className="h-4 w-1/4 bg-black/5 animate-pulse" />
              </div>
              <div className="space-y-2">
                <div className="h-3 w-12 bg-black/5 animate-pulse" />
                <div className="flex gap-2">
                  <div className="h-8 w-16 bg-black/5 animate-pulse" />
                  <div className="h-8 w-16 bg-black/5 animate-pulse" />
                </div>
              </div>
              <div className="space-y-2">
                <div className="h-3 w-10 bg-black/5 animate-pulse" />
                <div className="flex gap-2">
                  <div className="h-8 w-10 bg-black/5 animate-pulse" />
                  <div className="h-8 w-10 bg-black/5 animate-pulse" />
                  <div className="h-8 w-10 bg-black/5 animate-pulse" />
                </div>
              </div>
              <div className="h-10 w-full bg-black/5 animate-pulse" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="pb-12 px-6 lg:px-12">
        <div className="element-width">
          <div className="mb-8">
            <Button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                router.push("/item");
              }}
              variant="ghost"
              className="text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 px-0 py-0"
              size="md"
            >
              <i className="ri-arrow-left-line" />
              BACK TO ITEMS
            </Button>
          </div>
          <div className="text-center">
            <p className="text-base tracking-widest text-red-500">
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
    item.image_urls && item.image_urls.length > 0
      ? item.image_urls
      : [item.image_url];

  // 現在選択中のカラー名（alt テキスト用）
  const activeColorName = color || "";

  // 構造化カラム（material / origin / care）を優先し、
  // 旧データは product_details の「Material : 〜」「Made in : 〜」行から抽出する (FREQ-153)
  const detailsText =
    typeof item.product_details === "string" ? item.product_details : "";
  const parseDetailValue = (label: string): string => {
    const match = detailsText.match(
      new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, "im"),
    );
    return match ? match[1].trim() : "";
  };
  const materialText = item.material?.trim() || parseDetailValue("Material");
  const madeInText = item.origin?.trim() || parseDetailValue("Made in");
  const careText = item.care?.trim() || "";
  const itemNameStyle = {
    fontSize: "var(--item-detail-name-size)",
    lineHeight: 1.5,
    letterSpacing: "0.04em",
  } as const;
  const priceTextStyle = {
    fontFamily: "acumin-pro, sans-serif",
    fontSize: "var(--item-detail-price-size)",
    letterSpacing: "0.07em",
  } as const;
  const optionTitleStyle = {
    fontSize: "var(--lk-size-2xs)",
    letterSpacing: "0.07em",
  } as const;
  const bodyTextStyle = {
    fontSize: "var(--lk-size-xs)",
    lineHeight: 1.65,
  } as const;
  // 説明文は本文より1段階小さくする (FREQ-170)
  const descriptionTextStyle = {
    fontSize: "var(--lk-size-2xs)",
    lineHeight: 1.65,
  } as const;
  return (
    <div>
      <div className="element-width 2xl:max-w-[90rem]">
        <div
          data-testid="item-detail-first-view"
          className="min-h-[calc(100svh-4rem)]"
        >
          <div
            data-testid="item-detail-layout"
            className="grid grid-cols-1 gap-y-3.5 md:-mx-5 md:grid-cols-[58%_42%] md:gap-0 lg:mx-0 lg:grid-cols-[auto_minmax(18.125rem,23.75rem)] lg:justify-center lg:gap-x-14"
          >
            <div className="md:-ml-5 md:w-[calc(100%+1.25rem)] lg:ml-0 lg:w-full">
              {/* モバイル: 横スクロールカルーセル (FREQ-162)
                  main の px-5 を負マージンで相殺してフルブリード化し、
                  ピーク表示が main の padding でクリップされないようにする (FREQ-159) */}
              <div className="md:hidden -mx-5">
                {/* ピーク表示: 左右 px-5 の余白を設け、2枚以上のときは
                    前後スライドの端が余白部分に見える (FREQ-158) */}
                <div
                  data-testid="item-detail-carousel"
                  className="flex w-full touch-pan-x snap-x snap-mandatory scroll-px-5 gap-0.5 overflow-x-scroll px-5"
                  style={
                    {
                      scrollbarWidth: "none",
                      msOverflowStyle: "none",
                    } as React.CSSProperties
                  }
                  onScroll={handleCarouselScroll}
                >
                  {thumbnailImages.map((imgUrl: string, index: number) => (
                    <div
                      key={index}
                      data-testid="item-detail-carousel-slide"
                      className="relative aspect-[2/3] w-[calc(100vw-2.5rem)] flex-shrink-0 snap-start overflow-hidden bg-white"
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
              </div>

              {/* タブレット・デスクトップ: 画像領域 58%。lg 以上はサムネイル縦列（左）も表示 */}
              <div
                data-testid="item-detail-desktop-images"
                className="hidden w-full flex-row items-start gap-2 md:flex"
              >
                {thumbnailImages.length > 1 && (
                  <div
                    data-testid="item-detail-thumbnail-list"
                    className="hidden flex-none flex-col gap-2 p-[2px] lg:flex"
                  >
                    {thumbnailImages.map((imgUrl: string, index: number) => (
                      <button
                        key={index}
                        type="button"
                        aria-label={`${item.name} ${index + 1}枚目を表示`}
                        className={`relative aspect-[2/3] w-16 flex-shrink-0 overflow-hidden cursor-pointer focus-visible:outline-none transition-opacity duration-200 ${
                          selectedImageIndex === index
                            ? "ring-1 ring-black opacity-100"
                            : "opacity-50 hover:opacity-90"
                        }`}
                        onClick={() => setSelectedImageIndex(index)}
                      >
                        <Image
                          src={imgUrl}
                          alt={`${item.name} サムネイル${index + 1}枚目`}
                          fill
                          className="object-cover object-top"
                          sizes="64px"
                        />
                      </button>
                    ))}
                  </div>
                )}

                {/* タブレット (md〜lg未満): サムネイルがないため、モバイル同様
                    スワイプ（横スクロール + スナップ）で画像を切り替える (FREQ-171)。
                    前後の画像があるときは左下・右下に送りボタンを表示する (FREQ-172) */}
                <div className="relative min-w-0 flex-1 lg:hidden">
                  <div
                    ref={tabletCarouselRef}
                    data-testid="item-detail-tablet-carousel"
                    className="flex w-full touch-pan-x snap-x snap-mandatory gap-0.5 overflow-x-scroll"
                    style={
                      {
                        scrollbarWidth: "none",
                        msOverflowStyle: "none",
                      } as React.CSSProperties
                    }
                    onScroll={handleCarouselScroll}
                  >
                    {thumbnailImages.map((imgUrl: string, index: number) => (
                      <div
                        key={index}
                        data-testid="item-detail-tablet-carousel-slide"
                        className="relative aspect-[2/3] w-full flex-shrink-0 snap-start overflow-hidden bg-white"
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
                            sizes="61vw"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            No Image
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {selectedImageIndex > 0 && (
                    <button
                      type="button"
                      data-testid="item-detail-tablet-carousel-prev"
                      aria-label="前の画像を表示"
                      className="absolute bottom-2 left-5 flex h-11 w-11 cursor-pointer items-center justify-center text-black transition-opacity duration-200 hover:opacity-60 focus-visible:outline-none"
                      onClick={() =>
                        scrollTabletCarouselTo(selectedImageIndex - 1)
                      }
                    >
                      <i
                        className="ri-arrow-left-s-line text-2xl"
                        aria-hidden="true"
                      />
                    </button>
                  )}
                  {selectedImageIndex < thumbnailImages.length - 1 && (
                    <button
                      type="button"
                      data-testid="item-detail-tablet-carousel-next"
                      aria-label="次の画像を表示"
                      className="absolute bottom-2 right-2 flex h-11 w-11 cursor-pointer items-center justify-center text-black transition-opacity duration-200 hover:opacity-60 focus-visible:outline-none"
                      onClick={() =>
                        scrollTabletCarouselTo(selectedImageIndex + 1)
                      }
                    >
                      <i
                        className="ri-arrow-right-s-line text-2xl"
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>

                <div
                  data-testid="item-detail-main-image-frame"
                  className="relative hidden aspect-[2/3] overflow-hidden bg-white lg:block lg:h-[min(48rem,calc(100svh-5rem))] lg:w-auto lg:flex-none"
                >
                  {mainImage ? (
                    <Image
                      src={mainImage}
                      alt={
                        activeColorName
                          ? `${item.name} - ${activeColorName} - ${selectedImageIndex + 1}枚目`
                          : `${item.name} - ${selectedImageIndex + 1}枚目`
                      }
                      fill
                      className="object-contain object-center"
                      priority
                      sizes="(max-width: 1023px) 61vw, 54vw"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      No Image
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div
              data-testid="item-detail-information"
              className="space-y-3.5 md:sticky md:top-36 md:mx-auto md:w-[max(18.125rem,calc(100%-8.75rem))] md:self-start md:space-y-5 lg:mx-0 lg:w-full"
            >
              <div data-testid="item-detail-identity">
                <h1
                  className="[--item-detail-name-size:var(--lk-size-2xl)] md:[--item-detail-name-size:var(--lk-size-3xl)]"
                  style={itemNameStyle}
                >
                  {item.name}
                </h1>
                <div
                  data-testid="item-detail-price-row"
                  className="mt-1 flex items-center gap-3 md:mt-2"
                >
                  <p
                    data-testid="item-detail-price"
                    className="font-brand [--item-detail-price-size:var(--lk-size-md)] md:[--item-detail-price-size:1rem]"
                    style={priceTextStyle}
                  >
                    ¥{item.price.toLocaleString("ja-JP")}
                  </p>
                  {/* 在庫状態バッジ (FR-ITEM-DETAIL-007) */}
                  <StockBadge stockStatus={stockStatus} />
                </div>
              </div>

              {item.description && (
                <div
                  data-testid="item-detail-description"
                  className="border-b border-t border-black/10 py-3 md:py-4"
                >
                  <p
                    className="text-[#474747] leading-relaxed"
                    style={descriptionTextStyle}
                  >
                    {item.description}
                  </p>
                </div>
              )}

              {/* 商品仕様テーブル: COLOR / SIZE / MATERIAL / CARE / MADE IN (FREQ-153)
                  ラベル列は最長ラベルの max-content 幅を全行で共有し、値列の開始位置を揃える (FREQ-166) */}
              <div
                data-testid="item-spec-table"
                className="grid grid-cols-[max-content_1fr] items-center gap-x-8 gap-y-3.5"
              >
                {/* カラー選択: 色付きスウォッチ。選択中は黒枠 (FR-ITEM-DETAIL-008: aria-pressed) */}
                {item.colors &&
                  Array.isArray(item.colors) &&
                  item.colors.length > 0 && (
                    <>
                      <p style={optionTitleStyle}>COLOR</p>
                      <div className="flex gap-2 flex-wrap">
                        {(
                          item.colors as unknown as Array<{
                            hex: string;
                            name: string;
                          }>
                        ).map((colorOption) => (
                          <button
                            key={colorOption.name}
                            type="button"
                            onClick={() => {
                              setColor(colorOption.name);
                              setValidationError(null);
                            }}
                            aria-label={colorOption.name}
                            aria-pressed={color === colorOption.name}
                            title={colorOption.name}
                            className={`h-6 w-6 border p-[3px] cursor-pointer transition-colors duration-200 focus-visible:outline-none ${
                              color === colorOption.name
                                ? "border-black"
                                : "border-transparent hover:border-black/30"
                            }`}
                          >
                            <span
                              className="block w-full h-full border border-black/10"
                              style={{ backgroundColor: colorOption.hex }}
                            />
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                {/* サイズ選択: テキスト表示。選択中は下線 (FR-ITEM-DETAIL-008: aria-pressed) */}
                {item.sizes && item.sizes.length > 0 && (
                  <>
                    <p style={optionTitleStyle}>SIZE</p>
                    <div className="flex flex-wrap gap-4">
                      {item.sizes.map((sizeOption: string) => (
                        <button
                          key={sizeOption}
                          type="button"
                          onClick={() => {
                            setSize(sizeOption);
                            setValidationError(null);
                          }}
                          aria-pressed={size === sizeOption}
                          className={`pb-0.5 border-b cursor-pointer transition-colors duration-200 focus-visible:outline-none ${
                            size === sizeOption
                              ? "border-black"
                              : "border-transparent hover:border-black/30"
                          }`}
                          style={bodyTextStyle}
                        >
                          {sizeOption}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {materialText && (
                  <>
                    <p style={optionTitleStyle}>MATERIAL</p>
                    <p data-testid="item-material" style={bodyTextStyle}>
                      {materialText}
                    </p>
                  </>
                )}

                {careText && (
                  <>
                    <p style={optionTitleStyle}>CARE</p>
                    <p data-testid="item-care" style={bodyTextStyle}>
                      {careText}
                    </p>
                  </>
                )}

                {madeInText && (
                  <>
                    <p style={optionTitleStyle}>MADE IN</p>
                    <p data-testid="item-made-in" style={bodyTextStyle}>
                      {madeInText}
                    </p>
                  </>
                )}
              </div>

              {/* バリデーションエラーメッセージ (FR-ITEM-DETAIL-008: role="alert") */}
              {validationError && (
                <p role="alert" className="text-xs text-red-500">
                  {validationError}
                </p>
              )}

              {/* カート追加・ウィッシュリストボタン */}
              <div ref={cartButtonRef} data-testid="item-actions-main">
                <ItemActionButtons
                  addedToCart={addedToCart}
                  addingToCart={addingToCart}
                  isSoldOut={isSoldOut}
                  isWishlisted={isWishlisted}
                  togglingWishlist={togglingWishlist}
                  onAddToCart={handleAddToCart}
                  onToggleWishlist={handleToggleWishlist}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 関連商品セクション (FR-ITEM-DETAIL-012) */}
        <RelatedItems currentItemId={item.id} category={item.category} />
      </div>

      {/* モバイル固定フッター (FR-ITEM-DETAIL-006) */}
      {isMainActionBelowViewport && (
        <div
          data-testid="item-actions-fixed"
          className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-black/10 bg-white px-6 py-3 md:hidden"
        >
          <ItemActionButtons
            addedToCart={addedToCart}
            addingToCart={addingToCart}
            isSoldOut={isSoldOut}
            isWishlisted={isWishlisted}
            togglingWishlist={togglingWishlist}
            onAddToCart={handleAddToCart}
            onToggleWishlist={handleToggleWishlist}
          />
        </div>
      )}
    </div>
  );
}
