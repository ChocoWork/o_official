"use client";

// 商品詳細ページのクライアントコンポーネント
// Server Component ラッパー（page.tsx）から id を受け取り、/api/items/:id でデータを取得する
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Item } from "@/types/item";
import { useCart } from "@/contexts/CartContext";
import { findVariantId, postCart } from "@/features/cart/client/cart-api";
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
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { Sheet } from "@/components/ui/Sheet/Sheet";
import "./ItemDetailClient.css";
import { sortSizes } from "@/lib/items/sizes";

type Props = { id: string };

// 前後送りシェブロンのサイズ。タブレット（大きすぎた）と PC（小さすぎた）で見た目を
// 揃えるため、固定 px ではなく画像枠の幅に対する比率（4.5cqw）で決める。
// 枠幅 400px→18px / 480px→21.6px / 512px→23px。極端な枠幅でも破綻しないよう clamp する。
// 適用先の親には @container が必要（タブレット＝送りボタンの基準枠、PC＝メイン画像枠）。
const CAROUSEL_ARROW_ICON_CLASS =
  "h-[clamp(1rem,4.5cqw,1.625rem)] w-[clamp(1rem,4.5cqw,1.625rem)]";

type ColorOption = { hex: string; name: string };

type OptionSelectorsProps = {
  item: Item;
  color: string;
  size: string | null;
  onSelectColor: (name: string) => void;
  onSelectSize: (value: string) => void;
  "data-testid": string;
  sizeSelectTestId: string;
};

/** COLOR / SIZE の選択 UI。商品仕様テーブルとモバイルの選択シートで共有する
 *  （反復: 同じ操作は同じ見た目・同じ挙動で繰り返す） */
function OptionSelectors({
  item,
  color,
  size,
  onSelectColor,
  onSelectSize,
  "data-testid": dataTestId,
  sizeSelectTestId,
}: OptionSelectorsProps) {
  return (
    <div
      data-testid={dataTestId}
      className="grid grid-cols-[max-content_1fr] items-center gap-x-8 gap-y-[var(--lk-item-detail-select-gap)]"
    >
      {/* カラー選択: 参考サイト（roheframes）の実測に合わせ、外形 23px
          （1px 枠 + 1px 余白）・塗り 19px・間隔 15px。選択中は黒枠
          (FREQ-296 / FR-ITEM-DETAIL-008: aria-pressed) */}
      {item.colors && Array.isArray(item.colors) && item.colors.length > 0 && (
        <div className="col-span-2 flex gap-[15px] flex-wrap">
          {(item.colors as unknown as ColorOption[]).map((colorOption) => (
            <button
              key={colorOption.name}
              type="button"
              onClick={() => onSelectColor(colorOption.name)}
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
      )}

      {/* サイズ選択: SingleSelect の inline 変種。左寄せで内容なりの幅、
          未選択は薄いグレー枠・ホバーで濃いグレー枠・選択中は黒枠で囲む
          並び順は Admin の選択肢の並び（S → M → L → FREE）に合わせる (FREQ-305)
          (FR-ITEM-DETAIL-008: aria-pressed) */}
      {item.sizes && item.sizes.length > 0 && (
        <SingleSelect
          data-testid={sizeSelectTestId}
          className="item-size-select col-span-2"
          variant="inline"
          size="3xs"
          aria-label="SIZE"
          options={sortSizes(item.sizes).map((sizeOption) => ({
            value: sizeOption,
            label: sizeOption,
          }))}
          value={size ?? ""}
          onValueChange={onSelectSize}
        />
      )}
    </div>
  );
}

type ItemActionButtonsProps = {
  addedToCart: boolean;
  addingToCart: boolean;
  optionsSelected: boolean;
  /** 未選択のとき押せなくするか。選択 UI が同じ視界にある場所（インライン）は true、
   *  選択 UI が見えない固定 CTA は false にしてシートを開かせる (FREQ-347) */
  enforceSelection: boolean;
  isWishlisted: boolean;
  togglingWishlist: boolean;
  onAddToCart: () => void;
  onToggleWishlist: () => void;
};

function ItemActionButtons({
  addedToCart,
  addingToCart,
  optionsSelected,
  enforceSelection,
  isWishlisted,
  togglingWishlist,
  onAddToCart,
  onToggleWishlist,
}: ItemActionButtonsProps) {
  return (
    <div className="flex w-full gap-3 md:flex-col">
      <Button
        onClick={onAddToCart}
        disabled={
          addingToCart || (enforceSelection && !optionsSelected)
        }
        size="xs"
        className="w-full"
      >
        {addedToCart ? (
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
            {/* 固定 CTA だけは未選択のとき「選ぶ」ことを予告する。インラインは
                選択 UI が同じ視界にあるのでラベルを変えない (FREQ-347) */}
            {enforceSelection || optionsSelected
              ? "ADD TO CART"
              : "SELECT OPTIONS"}
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

/**
 * 選んだ色 × サイズの納期（FREQ-400）。
 *
 * 在庫の有無は「買えるか」ではなく「納期」を分ける。どちらの場合も買えるので、
 * ここで注文を止めない。日数の区分は法令ページ（特定商取引法）と同じ。
 */
function DeliveryNote({
  availability,
  color,
  size,
}: {
  availability?: Item["variantAvailability"];
  color: string;
  size: string | null;
}) {
  const combination = availability?.find(
    (entry) =>
      (entry.colorName ?? "") === (color ?? "") && (entry.sizeLabel ?? "") === (size ?? ""),
  );

  // 組み合わせが決まっていない間は出さない（選ぶ前に納期を断定しない）。
  if (!combination) return null;

  return (
    <span
      data-testid="delivery-note"
      data-in-stock={combination.inStock ? "true" : "false"}
      className="inline-block lk-text-3xs tracking-widest text-black/70 border border-black/20 px-2 py-0.5"
    >
      {combination.inStock ? "在庫あり・3〜7営業日で発送" : "受注生産・数週間〜2ヶ月"}
    </span>
  );
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
  // 未選択バリデーションエラーを alert() の代わりにインライン表示する
  const [validationError, setValidationError] = useState<string | null>(null);
  // ウィッシュリストの失敗は validationError と分ける。カート用のインライン枠に混ぜると
  // サイズ・カラー選択のエラーに見えるうえ、固定フッターから押したときは画面外で見えない。
  const [wishlistError, setWishlistError] = useState<string | null>(null);
  const tabletCarouselRef = useRef<HTMLDivElement>(null);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);

  const isWishlisted = item ? wishlistedItems.has(item.id) : false;


  // FREQ-347: モバイルの固定 CTA から開く選択シート。選択肢とカート投入ボタンを
  // 同じ視界にまとめ、選択のためにページを往復させない（近接）。
  const [optionSheetOpen, setOptionSheetOpen] = useState(false);

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

  const handleSelectColor = (name: string) => {
    setColor(name);
    setValidationError(null);
  };

  const handleSelectSize = (next: string) => {
    setSize(next);
    setValidationError(null);
  };

  // モバイルの選択操作はシートに集約し、選択済みでも選び直せるようにする。
  const handleFixedAction = () => {
    if (
      !optionsSelected ||
      (item?.colors?.length ?? 0) > 1 ||
      (item?.sizes?.length ?? 0) > 1
    ) {
      setOptionSheetOpen(true);
      return;
    }
    void handleAddToCart();
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

    // 選んだ色・サイズのバリアントの番号を送る。合うバリアントが無い（未登録・在庫の取得に失敗した）時は入れられない。
    // 取り扱いを終えたバリアントは番号があるので、窓口が 404 の description で断る
    const variantId = findVariantId(item.variantAvailability, hasColors ? color : null, hasSizes ? size : null);
    if (variantId === null) {
      setValidationError("選んだ色・サイズは現在お求めいただけません。");
      return;
    }

    setAddingToCart(true);
    try {
      const result = await postCart("/api/cart/add", { items: [{ id: variantId, quantity: 1 }] }, "カートへの追加に失敗しました");
      if (!result.ok) throw new Error(result.description);
      await updateCartCount();
      // FREQ-347: シートから追加したときは閉じて、追加できたことを本体側で見せる
      setOptionSheetOpen(false);
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
          className="md:min-h-[calc(100svh-4rem)]"
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
              {/* モバイル: main の6.25%余白を相殺し、画像カルーセルを全幅で表示する。 */}
              <div className="detail-mobile-gallery md:hidden">
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
                    {/* 選んだ組み合わせの納期（FREQ-400） */}
                    <DeliveryNote
                      availability={item.variantAvailability}
                      color={color}
                      size={size}
                    />
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
                  className={`mt-[var(--lk-item-detail-section-gap)] border-t border-black/10 py-3 md:py-4 ${specRows.length > 0 ? "md:border-b" : "border-b"}`}
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
              <div className="hidden md:block mt-[var(--lk-item-detail-section-gap)]">
                <OptionSelectors
                  data-testid="item-spec-table"
                  sizeSelectTestId="item-size-select"
                  item={item}
                  color={color}
                  size={size}
                  onSelectColor={handleSelectColor}
                  onSelectSize={handleSelectSize}
                />
              </div>

              {/* バリデーションエラーメッセージ (FR-ITEM-DETAIL-008: role="alert")。
                  入れ物は常に置き、中身だけを入れ替える（FREQ-376）。画面幅ごとに見える場所は1つだけ */}
              <LiveMessage className="hidden md:block mt-[var(--lk-item-detail-select-gap)] lk-text-3xs text-red-500">
                {validationError}
              </LiveMessage>

              {/* カート追加・ウィッシュリストボタン */}
              <div
                data-testid="item-actions-main"
                className="hidden md:block mt-[var(--lk-item-detail-action-gap)]"
              >
                <ItemActionButtons
                  addedToCart={addedToCart}
                  addingToCart={addingToCart}
                  optionsSelected={optionsSelected}
                  enforceSelection
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
                  className={
                    item.description
                      ? "md:mt-[var(--lk-item-detail-section-gap)]"
                      : "mt-[var(--lk-item-detail-section-gap)]"
                  }
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

      <div
        data-testid="item-actions-fixed"
        className="fixed bottom-0 left-0 right-0 z-50 flex flex-col gap-2 border-t border-black/10 bg-white px-[6.25%] py-3 md:hidden"
      >
        <LiveMessage className="lk-text-3xs text-red-500">
          {!optionSheetOpen ? validationError : null}
        </LiveMessage>
        <ItemActionButtons
          addedToCart={addedToCart}
          addingToCart={addingToCart}
          optionsSelected={optionsSelected}
          enforceSelection={false}
          isWishlisted={isWishlisted}
          togglingWishlist={togglingWishlist}
          onAddToCart={handleFixedAction}
          onToggleWishlist={handleToggleWishlist}
        />
      </div>

      {/* FREQ-347: 固定 CTA から開く選択シート。選択肢と決定ボタンを同じ視界に置き、
          選択のためにページを往復させない。中身は仕様テーブルと同じ UI を再利用する */}
      <Sheet
        open={optionSheetOpen}
        onClose={() => setOptionSheetOpen(false)}
        size="md"
        className="item-option-sheet-panel"
        aria-label="COLOR / SIZE を選択"
      >
        <div data-testid="item-option-sheet" className="flex flex-col gap-4">
          <OptionSelectors
            data-testid="item-sheet-options"
            sizeSelectTestId="item-sheet-size-select"
            item={item}
            color={color}
            size={size}
            onSelectColor={handleSelectColor}
            onSelectSize={handleSelectSize}
          />

          {/* 選んだ組み合わせの納期はシートの中にも出す（FREQ-400）。
              モバイルは選択がシート内で完結するため、閉じるまで納期が分からないと
              「選び直す理由」に気づけない */}
          <DeliveryNote
            availability={item.variantAvailability}
            color={color}
            size={size}
          />

          <LiveMessage className="lk-text-3xs text-red-500">
            {validationError}
          </LiveMessage>

          <ItemActionButtons
            addedToCart={addedToCart}
            addingToCart={addingToCart}
            optionsSelected={optionsSelected}
            enforceSelection
            isWishlisted={isWishlisted}
            togglingWishlist={togglingWishlist}
            onAddToCart={handleAddToCart}
            onToggleWishlist={handleToggleWishlist}
          />
        </div>
      </Sheet>

      {/* FREQ-340: ウィッシュリストの失敗は3箇所のどのボタンから押しても見えるよう
          固定表示にする。成功はアイコンの塗りつぶしで伝わるので出さない。
          固定フッターが出ている間はその分持ち上げて重ならないようにする。 */}
      {/* 読み上げの入れ物は常に置き、トーストが出ている間だけ中身と data-testid を持たせる（FREQ-376） */}
      <LiveMessage
        as="div"
        data-testid={wishlistError ? "item-wishlist-toast" : undefined}
        className="fixed right-4 z-50 max-w-[min(92vw,420px)] bottom-24 md:bottom-4"
      >
        {wishlistError ? (
          <ToastSnackbar
            message={wishlistError}
            variant="error"
            actionLabel="閉じる"
            onAction={() => setWishlistError(null)}
          />
        ) : null}
      </LiveMessage>
    </div>
  );
}
