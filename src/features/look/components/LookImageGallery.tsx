"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  CarouselArrowButton,
  CarouselSegmentIndicator,
  carouselIndexFromScroll,
  scrollCarouselTo,
} from "@/features/items/components/ItemImageCarousel";

type LookImageGalleryProps = {
  theme: string;
  imageUrls: string[];
};

// 前後送りシェブロンのサイズ。ITEM 詳細ページと同じく、固定 px ではなく
// 画像枠の幅に対する比率（4.5cqw）で決める。適用先の親には @container が必要。
const CAROUSEL_ARROW_ICON_CLASS =
  "h-[clamp(1rem,4.5cqw,1.625rem)] w-[clamp(1rem,4.5cqw,1.625rem)]";

// FREQ-179: 画像ギャラリーの3ビューポート仕様を ITEM 詳細ページと統一する。
// mobile: フルブリード・ピーク付きスワイプカルーセル / tablet: スワイプ + 前後送りボタン /
// desktop: 左サムネイル縦列 + メイン画像。全ビューポートで画像下にセグメント線インジケータ。
export function LookImageGallery({ theme, imageUrls }: LookImageGalleryProps) {
  const normalizedImages = useMemo(() => {
    if (imageUrls.length === 0) {
      return ["/placeholder.png"];
    }

    return imageUrls;
  }, [imageUrls]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);
  const tabletCarouselRef = useRef<HTMLDivElement>(null);
  const selectedImage = normalizedImages[selectedIndex] ?? normalizedImages[0];

  const scrollMobileCarouselTo = (index: number) => {
    setSelectedIndex(index);
    scrollCarouselTo(mobileCarouselRef.current, index);
  };

  const scrollTabletCarouselTo = (index: number) => {
    setSelectedIndex(index);
    scrollCarouselTo(tabletCarouselRef.current, index);
  };

  const handleCarouselScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const index = carouselIndexFromScroll(e.currentTarget);
    if (index !== null) {
      setSelectedIndex(index);
    }
  };

  const hiddenScrollbarStyle = {
    scrollbarWidth: "none",
    msOverflowStyle: "none",
  } as React.CSSProperties;

  return (
    <div>
      {/* モバイル: 横スクロールカルーセル。main の px-4 を負マージンで相殺して
          フルブリード化し、前後スライドの端が余白部分に見える（ピーク表示）。
          FREQ-344: ここを -mx-5（20px）にすると main の px-4（16px）を 4px 超過し、
          ページ全体が横スクロールしてしまう（横スクロールバーが固定ボトムナビの
          下部も削る）ので、main のパディングと同じ 4 に揃えること。 */}
      <div className="md:hidden -mx-4">
        <div
          ref={mobileCarouselRef}
          data-testid="look-detail-carousel"
          className="flex w-full touch-pan-x snap-x snap-mandatory scroll-px-5 gap-0.5 overflow-x-scroll px-5"
          style={hiddenScrollbarStyle}
          onScroll={handleCarouselScroll}
        >
          {normalizedImages.map((imageUrl, index) => (
            <div
              key={`${theme}:carousel:${index}:${imageUrl}`}
              data-testid="look-detail-carousel-slide"
              className="relative aspect-2/3 w-[calc(100vw-2.5rem)] shrink-0 snap-start overflow-hidden bg-white"
            >
              <Image
                src={imageUrl}
                alt={`${theme} - ${index + 1}枚目`}
                fill
                className="object-contain object-center"
                priority={index === 0}
                sizes="100vw"
                unoptimized
              />
            </div>
          ))}
        </div>
        <CarouselSegmentIndicator
          testId="look-detail-carousel-indicator"
          count={normalizedImages.length}
          selectedIndex={selectedIndex}
          onSelect={scrollMobileCarouselTo}
          label={`${theme} の画像インジケータ`}
          className="px-5"
        />
      </div>

      {/* タブレット・デスクトップ: lg 以上はサムネイル縦列（左）も表示 */}
      <div
        data-testid="look-detail-desktop-images"
        className="hidden w-full flex-row items-start gap-2 md:flex"
      >
        {normalizedImages.length > 1 && (
          <div
            data-testid="look-detail-thumbnail-list"
            className="hidden flex-none flex-col gap-2 p-0.5 lg:flex"
          >
            {normalizedImages.map((imageUrl, index) => (
              <button
                key={`${theme}:thumb:${index}:${imageUrl}`}
                data-testid="look-thumb-button"
                type="button"
                aria-label={`${theme} の ${index + 1}枚目を表示`}
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
                className={`relative aspect-2/3 w-16 shrink-0 overflow-hidden cursor-pointer focus-visible:outline-none transition-opacity duration-200 ${
                  selectedIndex === index
                    ? "ring-1 ring-black opacity-100"
                    : "opacity-50 hover:opacity-90"
                }`}
              >
                <Image
                  src={imageUrl}
                  alt={`${theme} サムネイル ${index + 1}`}
                  fill
                  className="object-cover object-top"
                  sizes="64px"
                  unoptimized
                />
              </button>
            ))}
          </div>
        )}

        {/* タブレット (md〜lg未満): スワイプ（横スクロール + スナップ）で切り替え、
            前後の画像があるときは左右中央に送りボタンを表示する */}
        <div className="min-w-0 flex-1 lg:hidden">
          {/* 送りボタンは画像枠に対して配置する（インジケータの高さを含めない）。
              @container 化して、シェブロンのサイズを画像枠の幅に比例させる。 */}
          <div className="@container relative">
            <div
              ref={tabletCarouselRef}
              data-testid="look-detail-tablet-carousel"
              className="flex w-full touch-pan-x snap-x snap-mandatory gap-0.5 overflow-x-scroll"
              style={hiddenScrollbarStyle}
              onScroll={handleCarouselScroll}
            >
              {normalizedImages.map((imageUrl, index) => (
                <div
                  key={`${theme}:tablet:${index}:${imageUrl}`}
                  data-testid="look-detail-tablet-carousel-slide"
                  className="relative aspect-2/3 w-full shrink-0 snap-start overflow-hidden bg-white"
                >
                  <Image
                    src={imageUrl}
                    alt={`${theme} - ${index + 1}枚目`}
                    fill
                    className="object-contain object-center"
                    priority={index === 0}
                    sizes="61vw"
                    unoptimized
                  />
                </div>
              ))}
            </div>
            {selectedIndex > 0 && (
              <CarouselArrowButton
                direction="prev"
                testId="look-detail-tablet-carousel-prev"
                onClick={() => scrollTabletCarouselTo(selectedIndex - 1)}
                className="absolute left-5 top-1/2 -translate-y-1/2 text-black"
                iconClassName={CAROUSEL_ARROW_ICON_CLASS}
              />
            )}
            {selectedIndex < normalizedImages.length - 1 && (
              <CarouselArrowButton
                direction="next"
                testId="look-detail-tablet-carousel-next"
                onClick={() => scrollTabletCarouselTo(selectedIndex + 1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-black"
                iconClassName={CAROUSEL_ARROW_ICON_CLASS}
              />
            )}
          </div>
          <CarouselSegmentIndicator
            testId="look-detail-tablet-carousel-indicator"
            count={normalizedImages.length}
            selectedIndex={selectedIndex}
            onSelect={scrollTabletCarouselTo}
            label={`${theme} の画像インジケータ`}
          />
        </div>

        {/* デスクトップ (lg以上): メイン画像。高さ基準で枠を決め、左右の送りボタンで切り替える */}
        <div className="hidden flex-col lg:flex lg:w-auto lg:flex-none">
          <div
            data-testid="look-detail-main-image-frame"
            className="@container relative aspect-2/3 overflow-hidden bg-white lg:h-[min(48rem,calc(100svh-7rem))] lg:w-auto"
          >
            <Image
              data-testid="look-main-image"
              key={`${theme}:${selectedImage}`}
              src={selectedImage}
              alt={`${theme} - ${selectedIndex + 1}枚目`}
              fill
              className="object-contain object-center motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
              sizes="(max-width: 1023px) 61vw, 54vw"
              priority
              unoptimized
            />
            {selectedIndex > 0 && (
              <CarouselArrowButton
                direction="prev"
                testId="look-detail-main-image-prev"
                onClick={() => setSelectedIndex(selectedIndex - 1)}
                className="absolute left-0 top-1/2 -translate-y-1/2"
                iconClassName={CAROUSEL_ARROW_ICON_CLASS}
              />
            )}
            {selectedIndex < normalizedImages.length - 1 && (
              <CarouselArrowButton
                direction="next"
                testId="look-detail-main-image-next"
                onClick={() => setSelectedIndex(selectedIndex + 1)}
                className="absolute right-0 top-1/2 -translate-y-1/2"
                iconClassName={CAROUSEL_ARROW_ICON_CLASS}
              />
            )}
          </div>
          <CarouselSegmentIndicator
            testId="look-detail-main-image-indicator"
            count={normalizedImages.length}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            label={`${theme} の画像インジケータ`}
          />
        </div>
      </div>
    </div>
  );
}
