import Image from "next/image";
import type { ReactNode } from "react";
import type { ColorSwatch } from "@/lib/items/colors";
import { ItemCardImageCarousel } from "./ItemImageCarousel";

// ホーム ITEM セクション / ITEM 一覧 / WISHLIST で共有する商品カードの見た目。
// media（画像＋SOLD OUT）と info（名称＋カラー／価格＋SEASON＋在庫）に分割し、
// 呼び出し側でリンクや操作ボタンを自由に合成できるようにする。

export function ItemCardMedia({
  imageUrl,
  imageUrls,
  alt,
  soldOut = false,
  priority = false,
  children,
}: {
  imageUrl?: string | null;
  /** FREQ-271: 2枚以上あるときはカード内をスワイプ / 三角ボタンで切り替える */
  imageUrls?: string[] | null;
  alt: string;
  soldOut?: boolean;
  priority?: boolean;
  children?: ReactNode;
}) {
  const frameClass = "relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden";
  const soldOutBadge = soldOut ? (
    <span
      className="absolute top-0 left-0 bg-black text-white px-2 py-0.75 tracking-widest"
      style={{ fontSize: "var(--lk-size-4xs)" }}
    >
      SOLD OUT
    </span>
  ) : null;

  if (imageUrls && imageUrls.length > 1) {
    return (
      <div className="mb-0.5 sm:mb-1.5 md:mb-2">
        <ItemCardImageCarousel
          imageUrls={imageUrls}
          alt={alt}
          priority={priority}
          frameClassName={frameClass}
          overlay={
            <>
              {soldOutBadge}
              {children}
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className={`${frameClass} mb-0.5 sm:mb-1.5 md:mb-2`}>
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={alt}
          width={600}
          height={800}
          className="w-full h-full object-cover object-top"
          priority={priority}
          data-testid="item-image"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[#999]">
          <span
            className="tracking-widest"
            style={{ fontSize: "var(--lk-size-3xs)" }}
          >
            NO IMAGE
          </span>
        </div>
      )}
      {soldOutBadge}
      {children}
    </div>
  );
}

export function ItemCardInfo({
  name,
  price,
  swatches = [],
  season = null,
}: {
  name: string;
  price: number;
  swatches?: ColorSwatch[];
  season?: "SS" | "AW" | null;
}) {
  return (
    // YOKE 参考: 商品名とカラースウォッチを同一行に横並び（縦中央そろえ）。
    // 価格・SEASON は下段。左右に同量の余白（px）。
    <div data-testid="item-info" className="px-2">
      <div className="flex items-center justify-between gap-2">
        <h3
          className="font-brand tracking-tight min-w-0"
          data-testid="item-name"
          // font-size は黄金比スケール（--lk-size-2xs）。weight は 500 の擬似ボールドの
          // にじみと 300 の細すぎの中間となる 400。
          style={{ fontSize: "var(--lk-size-2xs)", fontWeight: 400 }}
        >
          {name}
        </h3>
        {swatches.length > 0 ? (
          <div
            className="flex shrink-0 items-center gap-1"
            aria-label={`カラー ${swatches.length}色`}
          >
            {swatches.slice(0, 4).map((swatch) => (
              <span
                key={swatch.name}
                title={swatch.name}
                className="inline-block h-2.5 w-2.5 rounded-full border border-black/15"
                style={{ backgroundColor: swatch.hex ?? "transparent" }}
              />
            ))}
            {swatches.length > 4 ? (
              <span
                className="text-[#999]"
                style={{ fontSize: "var(--lk-size-4xs)" }}
              >
                +{swatches.length - 4}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <p
          data-testid="item-price"
          className="text-black"
          style={{ fontSize: "var(--lk-size-2xs)", fontWeight: 400 }}
        >
          ¥{price.toLocaleString("ja-JP")}
        </p>
        {season ? (
          <span
            className="shrink-0 font-brand tracking-widest text-[#999]"
            style={{ fontSize: "var(--lk-size-4xs)" }}
          >
            {season}
          </span>
        ) : null}
      </div>
    </div>
  );
}
