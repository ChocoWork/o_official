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
import {
  CarouselArrowButton,
  CarouselSegmentIndicator,
  carouselIndexFromScroll,
  scrollCarouselTo,
} from "@/features/items/components/ItemImageCarousel";
import { SpecList } from "@/components/ui/SpecList/SpecList";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { ToastSnackbar } from "@/components/ui/ToastSnackbar/ToastSnackbar";
import { sortSizes } from "@/lib/items/sizes";

type Props = { id: string };

// 前後送りシェブロンのサイズ。タブレット（大きすぎた）と PC（小さすぎた）で見た目を
// 揃えるため、固定 px ではなく画像枠の幅に対する比率（4.5cqw）で決める。
// 枠幅 400px→18px / 480px→21.6px / 512px→23px。極端な枠幅でも破綻しないよう clamp する。
// 適用先の親には @container が必要（タブレット＝送りボタンの基準枠、PC＝メイン画像枠）。
const CAROUSEL_ARROW_ICON_CLASS =
  "h-[clamp(1rem,4.5cqw,1.625rem)] w-[clamp(1rem,4.5cqw,1.625rem)]";

type ItemActionButtonsProps = {
  addedToCart: boolean;
  addingToCart: boolean;
  isSoldOut: boolean;
  optionsSelected: boolean;
  isWishlisted: boolean;
  togglingWishlist: boolean;
  onAddToCart: () => void;
  onToggleWishlist: () => void;
};

function ItemActionButtons({
  addedToCart,
  addingToCart,
  isSoldOut,
  optionsSelected,
  isWishlisted,
  togglingWishlist,
  onAddToCart,
  onToggleWishlist,
}: ItemActionButtonsProps) {
  return (
    <div className="flex w-full gap-3 md:flex-col">
      <Button
        onClick={onAddToCart}
        disabled={addingToCart || isSoldOut || !optionsSelected}
        size="xs"
        className="w-full"
      >
        {isSoldOut ? (
          "SOLD OUT"
        ) : addedToCart ? (
          <div className="flex items-center justify-center gap-2">
            <i className="ri-check-line lk-text-lg" />
            ADDED
          </div>
        ) : addingToCart ? (
          "追加中..."
        ) : (
          <div className="flex items-center justify-center gap-2">
            <div className="flex h-4 w-4 items-center justify-center">
              <i className="ri-shopping-bag-line lk-text-lg" />
            </div>
            ADD TO CART
          </div>
        )}
      </Button>
      {/* FREQ-299: md 以上では商品名の右のハートボタンに集約するため表示しない */}
      <div className="md:hidden">
        <Button
          onClick={onToggleWishlist}
          disabled={togglingWishlist}
          variant="secondary"
          size="xs"
          aria-label="Add to wishlist"
          className="aspect-square h-full px-0 hover:bg-transparent hover:text-current"
        >
          <div className="flex items-center justify-center gap-2">
            <div className="flex h-4 w-4 items-center justify-center">
              <i
                className={`lk-text-lg ${
                  isWishlisted ? "ri-bookmark-fill" : "ri-bookmark-line"
                }`}
              />
            </div>
          </div>
        </Button>
      </div>
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
        className="inline-block lk-text-3xs tracking-widest text-white bg-black px-2 py-0.5"
      >
        SOLD OUT
      </span>
    );
  }

  if (stockStatus === "low_stock") {
    return (
      <span
        data-testid="stock-status"
        className="inline-block lk-text-3xs tracking-widest text-red-600 border border-red-400 px-2 py-0.5"
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
  // ウィッシュリストの失敗は validationError と分ける。カート用のインライン枠に混ぜると
  // サイズ・カラー選択のエラーに見えるうえ、固定フッターから押したときは画面外で見えない。
  const [wishlistError, setWishlistError] = useState<string | null>(null);
  const cartButtonRef = useRef<HTMLDivElement>(null);
  const tabletCarouselRef = useRef<HTMLDivElement>(null);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);

  const isWishlisted = item ? wishlistedItems.has(item.id) : false;
  const stockStatus = item ? resolveStockStatus(item) : "unknown";
  const isSoldOut = stockStatus === "sold_out";

  // FREQ-345: 選択肢がある軸はすべて選ばれるまで ADD TO CART を押せなくする。
  const optionsSelected =
    !!item &&
    (!(item.colors && Array.isArray(item.colors) && item.colors.length > 0) ||
      !!color) &&
    (!(item.sizes && item.sizes.length > 0) || !!size);

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
        // FREQ-345: 選択肢が 1 つしかない軸は選ぶ余地がないので自動選択する。
        // 2 つ以上ある軸は未選択のままにして、明示的に選ばせる。
        if (
          data.colors &&
          Array.isArray(data.colors) &&
          data.colors.length === 1
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

  // 商品データ取得でページ高さが変わると、ブラウザのスクロール復元により
  // 少し下にスクロールした位置で描画されることがある。読み込み直後は最上部に戻す。
  useLayoutEffect(() => {
    if (!item) return;
    window.scrollTo(0, 0);
  }, [item]);

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
    setSelectedImageIndex(index);
    scrollCarouselTo(tabletCarouselRef.current, index);
  };

  // モバイルカルーセル: インジケータの線をタップしたときの移動 (FREQ-271)
  const scrollMobileCarouselTo = (index: number) => {
    setSelectedImageIndex(index);
    scrollCarouselTo(mobileCarouselRef.current, index);
  };

  const handleCarouselScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // ピーク表示 (FREQ-158) によりスライド幅 < コンテナ幅のため、
    // スライド幅 + gap を1スライド分の移動量としてインデックスを算出する
    const index = carouselIndexFromScroll(e.currentTarget);
    if (index !== null) {
      setSelectedImageIndex(index);
    }
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
    setWishlistError(null);
    setTogglingWishlist(true);
    try {
      await toggleWishlist(item.id);
    } catch (err) {
      setWishlistError(
        err instanceof Error ? err.message : "エラーが発生しました",
      );
      console.error("Error toggling wishlist:", err);
    } finally {
      setTogglingWishlist(false);
    }
  };

  if (loading) {
    return (
      <div>
        <div className="element-width 2xl:max-w-360">
          <div className="mb-4 sm:mb-5 h-3 w-44 bg-black/5 animate-pulse" />
          <div className="grid grid-cols-1 gap-8 md:-mx-5 md:grid-cols-[58%_42%] md:gap-0">
            <div className="aspect-2/3 bg-black/5 animate-pulse" />
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
              className="lk-text-sm text-[#474747] hover:text-black transition-colors duration-300 flex items-center gap-2 px-0 py-0"
              size="md"
            >
              <i className="ri-arrow-left-line" />
              BACK TO ITEMS
            </Button>
          </div>
          <div className="text-center">
            <p className="lk-text-lg tracking-widest text-red-500">
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
  const productNoteText = item.product_note?.trim() || "";
  const itemNameStyle = {
    fontSize: "var(--item-detail-name-size)",
    lineHeight: 1.5,
    letterSpacing: "0.04em",
  } as const;
  const priceTextStyle = {
    fontFamily: "acumin-pro, sans-serif",
    fontSize: "var(--item-detail-price-size)",
  } as const;
  // FREQ-290: ADD TO WISHLIST の下に置く仕様リストの行。値のあるものだけ並べる
  const specRows = [
    materialText
      ? {
          label: "MATERIAL",
          value: <span data-testid="item-material">{materialText}</span>,
        }
      : null,
    careText
      ? {
          label: "CARE",
          value: <span data-testid="item-care">{careText}</span>,
        }
      : null,
    madeInText
      ? {
          label: "MADE IN",
          value: <span data-testid="item-made-in">{madeInText}</span>,
        }
      : null,
    // FREQ-293: 商品ごとの注意書き
    productNoteText
      ? {
          label: "PRODUCT NOTE",
          value: <span data-testid="item-product-note">{productNoteText}</span>,
        }
      : null,
  ].filter(
    (row): row is { label: string; value: React.ReactElement } => row !== null,
  );
  // 説明文は本文より1段階小さくする (FREQ-170)
  const descriptionTextStyle = {
    fontSize: "var(--lk-size-2xs)",
    lineHeight: 1.65,
  } as const;
  return (
    <div>
      <div className="element-width 2xl:max-w-360">
        <div
          data-testid="item-detail-first-view"
          className="min-h-[calc(100svh-4rem)]"
        >
          {/* md〜lg 未満の画像列は幅基準（w-full + aspect-2/3）なので、上限がないと
              高さが viewport を超えて画像下端が見切れる。lg の
              h-[min(48rem,calc(100svh-7rem))] と同じ考え方を、2:3 の枠を保ったまま
              幅側から効かせる（32rem=48rem*2/3、6rem=画像上端のオフセット 4rem＋
              インジケータと下余白）。56% は狭い md（768px 付近）で情報列の
              最小幅 18.125rem と右端の余白を確保するための上限。余った幅は情報列が使う。
              画像列は -ml-5 で 20px 左にはみ出すため、画像とテキストの見た目の間隔は
              gap-x-3(12px) + 20px = 32px。右端も pr-3(12px) + ページの px-5(20px) で
              同じ 32px に揃える。lg 以上は情報列の上限を画像の幅
              （h-[min(48rem,calc(100svh-7rem))] の 2:3 から逆算＝
              min(32rem,calc((100svh-7rem)*2/3))）に合わせ、横幅に余裕があるときは
              画像と同じ幅まで広げる。 */}
          <div
            data-testid="item-detail-layout"
            className="grid grid-cols-1 gap-y-3.5 md:-ml-5 md:grid-cols-[min(32rem,56%,calc((100svh-6rem)*2/3))_minmax(18.125rem,1fr)] md:gap-x-3 md:gap-y-0 md:pr-3 lg:ml-0 lg:pr-0 lg:grid-cols-[auto_minmax(18.125rem,min(32rem,calc((100svh-7rem)*2/3)))] lg:justify-center lg:gap-x-14"
          >
            <div className="md:-ml-5 md:w-full lg:ml-0">
              {/* モバイル: 横スクロールカルーセル (FREQ-162)
                  main の px-4 を負マージンで相殺してフルブリード化し、
                  ピーク表示が main の padding でクリップされないようにする (FREQ-159)。
                  負マージンが padding を超えると横スクロールが出て、スクロールバーが
                  固定フッターの下部を削るため、main と同じ 16px に揃える (FREQ-346) */}
              <div className="md:hidden -mx-4">
                {/* ピーク表示: 左右に余白を設け、2枚以上のときは
                    前後スライドの端が余白部分に見える (FREQ-158)。
                    余白は 320px 時の 20px / 280px を保つ画面幅比 6.25% で、
                    スライド幅は残りの 87.5%（w-full）になる。
                    隙間も 320px 時の 2px を保つ 0.625vw とし、
                    隙間 : 余白 = 1 : 10 を全幅で維持する (FREQ-307) */}
                <div
                  ref={mobileCarouselRef}
                  data-testid="item-detail-carousel"
                  className="flex w-full touch-pan-x snap-x snap-mandatory scroll-px-[6.25%] gap-[0.625vw] overflow-x-scroll px-[6.25%]"
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
                      className="relative aspect-2/3 w-full shrink-0 snap-start overflow-hidden bg-white"
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
                {/* FREQ-271: 画像下のセグメント線インジケータ。カルーセルと同じ左右余白に揃える */}
                <CarouselSegmentIndicator
                  testId="item-detail-carousel-indicator"
                  count={thumbnailImages.length}
                  selectedIndex={selectedImageIndex}
                  onSelect={scrollMobileCarouselTo}
                  label={`${item.name} の画像インジケータ`}
                  className="px-[6.25%]"
                />
              </div>

              {/* タブレット・デスクトップ: 画像領域 58%。lg 以上はサムネイル縦列（左）も表示 */}
              <div
                data-testid="item-detail-desktop-images"
                className="hidden w-full flex-row items-start gap-2 md:flex"
              >
                {thumbnailImages.length > 1 && (
                  <div
                    data-testid="item-detail-thumbnail-list"
                    className="hidden flex-none flex-col gap-2 p-0.5 lg:flex"
                  >
                    {thumbnailImages.map((imgUrl: string, index: number) => (
                      <button
                        key={index}
                        type="button"
                        aria-label={`${item.name} ${index + 1}枚目を表示`}
                        className={`relative aspect-2/3 w-16 shrink-0 overflow-hidden cursor-pointer focus-visible:outline-none transition-opacity duration-200 ${
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
                <div className="min-w-0 flex-1 lg:hidden">
                  {/* 送りボタンは画像枠に対して配置する（インジケータの高さを含めない）。
                      @container 化して、シェブロンのサイズを画像枠の幅に比例させる。 */}
                  <div className="@container relative">
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
                          className="relative aspect-2/3 w-full shrink-0 snap-start overflow-hidden bg-white"
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
                      <CarouselArrowButton
                        direction="prev"
                        testId="item-detail-tablet-carousel-prev"
                        onClick={() =>
                          scrollTabletCarouselTo(selectedImageIndex - 1)
                        }
                        className="absolute left-5 top-1/2 -translate-y-1/2 text-black"
                        iconClassName={CAROUSEL_ARROW_ICON_CLASS}
                      />
                    )}
                    {selectedImageIndex < thumbnailImages.length - 1 && (
                      <CarouselArrowButton
                        direction="next"
                        testId="item-detail-tablet-carousel-next"
                        onClick={() =>
                          scrollTabletCarouselTo(selectedImageIndex + 1)
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-black"
                        iconClassName={CAROUSEL_ARROW_ICON_CLASS}
                      />
                    )}
                  </div>
                  {/* FREQ-271: 画像下のセグメント線インジケータ */}
                  <CarouselSegmentIndicator
                    testId="item-detail-tablet-carousel-indicator"
                    count={thumbnailImages.length}
                    selectedIndex={selectedImageIndex}
                    onSelect={scrollTabletCarouselTo}
                    label={`${item.name} の画像インジケータ`}
                  />
                </div>

                {/* デスクトップ (lg 以上): メイン画像。左右の三角ボタンで切り替え、
                    画像下にセグメント線インジケータを表示する (FREQ-271) */}
                <div className="hidden flex-col lg:flex lg:w-auto lg:flex-none">
                  <div
                    data-testid="item-detail-main-image-frame"
                    className="@container relative aspect-2/3 overflow-hidden bg-white lg:h-[min(48rem,calc(100svh-7rem))] lg:w-auto"
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
                    {selectedImageIndex > 0 && (
                      <CarouselArrowButton
                        direction="prev"
                        testId="item-detail-main-image-prev"
                        onClick={() =>
                          setSelectedImageIndex(selectedImageIndex - 1)
                        }
                        className="absolute left-0 top-1/2 -translate-y-1/2"
                        iconClassName={CAROUSEL_ARROW_ICON_CLASS}
                      />
                    )}
                    {selectedImageIndex < thumbnailImages.length - 1 && (
                      <CarouselArrowButton
                        direction="next"
                        testId="item-detail-main-image-next"
                        onClick={() =>
                          setSelectedImageIndex(selectedImageIndex + 1)
                        }
                        className="absolute right-0 top-1/2 -translate-y-1/2"
                        iconClassName={CAROUSEL_ARROW_ICON_CLASS}
                      />
                    )}
                  </div>
                  <CarouselSegmentIndicator
                    testId="item-detail-main-image-indicator"
                    count={thumbnailImages.length}
                    selectedIndex={selectedImageIndex}
                    onSelect={setSelectedImageIndex}
                    label={`${item.name} の画像インジケータ`}
                  />
                </div>
              </div>
            </div>

            <div
              data-testid="item-detail-information"
              className="flex flex-col md:sticky md:top-36 md:w-full md:self-start"
            >
              <div
                data-testid="item-detail-identity"
                className="flex items-start justify-between gap-4"
              >
                <div className="min-w-0 flex-1">
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
                {/* FREQ-299: md 以上のウィッシュリストは商品名の右端にハートのみ */}
                <div
                  data-testid="item-wishlist-icon"
                  className="hidden shrink-0 md:block"
                >
                  <Button
                    onClick={handleToggleWishlist}
                    disabled={togglingWishlist}
                    variant="ghost"
                    size="md"
                    iconOnly
                    aria-label="Add to wishlist"
                  >
                    <i
                      className={`lk-text-4xl ${
                        isWishlisted ? "ri-bookmark-fill" : "ri-bookmark-line"
                      }`}
                    />
                  </Button>
                </div>
              </div>

              {item.description && (
                <div
                  data-testid="item-detail-description"
                  className="mt-[var(--lk-item-detail-section-gap)] border-b border-t border-black/10 py-3 md:py-4"
                >
                  <p
                    className="text-[#474747] leading-relaxed"
                    style={descriptionTextStyle}
                  >
                    {item.description}
                  </p>
                </div>
              )}

              {/* 商品仕様テーブル: カラー・サイズ選択 (FREQ-153)
                  FREQ-292: COLOR / SIZE のラベルは表示しない（各行は全幅） */}
              <div
                data-testid="item-spec-table"
                className="mt-[var(--lk-item-detail-section-gap)] grid grid-cols-[max-content_1fr] items-center gap-x-8 gap-y-[var(--lk-item-detail-select-gap)]"
              >
                {/* カラー選択: 参考サイト（roheframes）の実測に合わせ、外形 23px
                    （1px 枠 + 1px 余白）・塗り 19px・間隔 15px。選択中は黒枠
                    (FREQ-296 / FR-ITEM-DETAIL-008: aria-pressed) */}
                {item.colors &&
                  Array.isArray(item.colors) &&
                  item.colors.length > 0 && (
                    <>
                      <div className="col-span-2 flex gap-[15px] flex-wrap">
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
                            className={`h-[23px] w-[23px] border p-px cursor-pointer transition-colors duration-200 focus-visible:outline-none ${
                              color === colorOption.name
                                ? "border-black"
                                : "border-[#f1f0ed] hover:border-black/30"
                            }`}
                          >
                            <span
                              className="block w-full h-full"
                              style={{ backgroundColor: colorOption.hex }}
                            />
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                {/* サイズ選択: SingleSelect の inline 変種。左寄せで内容なりの幅、
                    未選択は文字だけ・選択中のみ黒枠で囲む (FREQ-303 / FREQ-304)
                    並び順は Admin の選択肢の並び（S → M → L → FREE）に合わせる (FREQ-305)
                    (FR-ITEM-DETAIL-008: aria-pressed) */}
                {item.sizes && item.sizes.length > 0 && (
                  <SingleSelect
                    data-testid="item-size-select"
                    className="col-span-2"
                    variant="inline"
                    size="3xs"
                    aria-label="SIZE"
                    options={sortSizes(item.sizes).map((sizeOption) => ({
                      value: sizeOption,
                      label: sizeOption,
                    }))}
                    value={size ?? ""}
                    onValueChange={(next) => {
                      setSize(next);
                      setValidationError(null);
                    }}
                  />
                )}
              </div>

              {/* バリデーションエラーメッセージ (FR-ITEM-DETAIL-008: role="alert") */}
              {validationError && (
                <p
                  role="alert"
                  className="mt-[var(--lk-item-detail-select-gap)] lk-text-3xs text-red-500"
                >
                  {validationError}
                </p>
              )}

              {/* カート追加・ウィッシュリストボタン */}
              <div
                ref={cartButtonRef}
                data-testid="item-actions-main"
                className="mt-[var(--lk-item-detail-action-gap)]"
              >
                <ItemActionButtons
                  addedToCart={addedToCart}
                  addingToCart={addingToCart}
                  isSoldOut={isSoldOut}
                  optionsSelected={optionsSelected}
                  isWishlisted={isWishlisted}
                  togglingWishlist={togglingWishlist}
                  onAddToCart={handleAddToCart}
                  onToggleWishlist={handleToggleWishlist}
                />
              </div>

              {/* FREQ-290: MATERIAL / CARE / MADE IN は選択操作ではないため
                  仕様テーブルから切り離し、ADD TO WISHLIST の下に罫線付きの
                  仕様リストとして置く */}
              {specRows.length > 0 && (
                <SpecList
                  data-testid="item-spec-list"
                  className="mt-[var(--lk-item-detail-section-gap)]"
                  rows={specRows}
                  size="sm"
                />
              )}
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
          className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-black/10 bg-white px-4 py-3 md:hidden"
        >
          <ItemActionButtons
            addedToCart={addedToCart}
            addingToCart={addingToCart}
            isSoldOut={isSoldOut}
            optionsSelected={optionsSelected}
            isWishlisted={isWishlisted}
            togglingWishlist={togglingWishlist}
            onAddToCart={handleAddToCart}
            onToggleWishlist={handleToggleWishlist}
          />
        </div>
      )}

      {/* FREQ-340: ウィッシュリストの失敗は3箇所のどのボタンから押しても見えるよう
          固定表示にする。成功はアイコンの塗りつぶしで伝わるので出さない。
          固定フッターが出ている間はその分持ち上げて重ならないようにする。 */}
      {wishlistError && (
        <div
          data-testid="item-wishlist-toast"
          role="alert"
          className={`fixed right-4 z-50 max-w-[min(92vw,420px)] ${
            isMainActionBelowViewport ? "bottom-24 md:bottom-4" : "bottom-4"
          }`}
        >
          <ToastSnackbar
            message={wishlistError}
            variant="error"
            actionLabel="閉じる"
            onAction={() => setWishlistError(null)}
          />
        </div>
      )}
    </div>
  );
}
