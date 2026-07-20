'use client';

import { useMemo, useRef, useState } from 'react';
import Image from 'next/image';

type LookImageGalleryProps = {
  theme: string;
  imageUrls: string[];
};

// FREQ-179: 画像ギャラリーの3ビューポート仕様を ITEM 詳細ページと統一する。
// mobile: フルブリード・ピーク付きスワイプカルーセル / tablet: スワイプ + 前後送りボタン /
// desktop: 左サムネイル縦列 + メイン画像
export function LookImageGallery({ theme, imageUrls }: LookImageGalleryProps) {
  const normalizedImages = useMemo(() => {
    if (imageUrls.length === 0) {
      return ['/placeholder.png'];
    }

    return imageUrls;
  }, [imageUrls]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const tabletCarouselRef = useRef<HTMLDivElement>(null);
  const selectedImage = normalizedImages[selectedIndex] ?? normalizedImages[0];

  // タブレットカルーセルの前後送りボタン: 指定インデックスのスライドへスクロールする
  const scrollTabletCarouselTo = (index: number) => {
    const el = tabletCarouselRef.current;
    if (!el) return;
    const firstSlide = el.children[0] as HTMLElement | undefined;
    if (!firstSlide) return;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    el.scrollTo({
      left: index * (firstSlide.offsetWidth + gap),
      behavior: 'smooth',
    });
  };

  const handleCarouselScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const firstSlide = el.children[0] as HTMLElement | undefined;
    if (!firstSlide) return;
    // ピーク表示によりスライド幅 < コンテナ幅のため、
    // スライド幅 + gap を1スライド分の移動量としてインデックスを算出する
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const stride = firstSlide.offsetWidth + gap;
    setSelectedIndex(Math.round(el.scrollLeft / stride));
  };

  const hiddenScrollbarStyle = {
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
  } as React.CSSProperties;

  return (
    <div>
      {/* モバイル: 横スクロールカルーセル。main の px-5 を負マージンで相殺して
          フルブリード化し、前後スライドの端が余白部分に見える（ピーク表示） */}
      <div className="md:hidden -mx-5">
        <div
          data-testid="look-detail-carousel"
          className="flex w-full touch-pan-x snap-x snap-mandatory scroll-px-5 gap-0.5 overflow-x-scroll px-5"
          style={hiddenScrollbarStyle}
          onScroll={handleCarouselScroll}
        >
          {normalizedImages.map((imageUrl, index) => (
            <div
              key={`${theme}:carousel:${index}:${imageUrl}`}
              data-testid="look-detail-carousel-slide"
              className="relative aspect-[2/3] w-[calc(100vw-2.5rem)] flex-shrink-0 snap-start overflow-hidden bg-white"
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
      </div>

      {/* タブレット (md〜lg未満): スワイプ（横スクロール + スナップ）で切り替え、
          前後の画像があるときは左下・右下に送りボタンを表示する */}
      <div className="relative hidden md:block lg:hidden">
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
              className="relative aspect-[2/3] w-full flex-shrink-0 snap-start overflow-hidden bg-white"
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
        {selectedIndex > 0 && (
          <button
            type="button"
            data-testid="look-detail-tablet-carousel-prev"
            aria-label="前の画像を表示"
            className="absolute bottom-2 left-5 flex h-11 w-11 cursor-pointer items-center justify-center text-black transition-opacity duration-200 hover:opacity-60 focus-visible:outline-none"
            onClick={() => scrollTabletCarouselTo(selectedIndex - 1)}
          >
            <i className="ri-arrow-left-s-line text-2xl" aria-hidden="true" />
          </button>
        )}
        {selectedIndex < normalizedImages.length - 1 && (
          <button
            type="button"
            data-testid="look-detail-tablet-carousel-next"
            aria-label="次の画像を表示"
            className="absolute bottom-2 right-2 flex h-11 w-11 cursor-pointer items-center justify-center text-black transition-opacity duration-200 hover:opacity-60 focus-visible:outline-none"
            onClick={() => scrollTabletCarouselTo(selectedIndex + 1)}
          >
            <i className="ri-arrow-right-s-line text-2xl" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* デスクトップ (lg以上): サムネイル縦列（左）+ メイン画像 */}
      <div className="hidden w-full flex-row items-start gap-2 lg:flex">
        {normalizedImages.length > 1 && (
          <div
            data-testid="look-detail-thumbnail-list"
            className="flex flex-none flex-col gap-2 p-[2px]"
          >
            {normalizedImages.map((imageUrl, index) => (
              <button
                key={`${theme}:thumb:${index}:${imageUrl}`}
                data-testid="look-thumb-button"
                type="button"
                aria-label={`${theme} の ${index + 1}枚目を表示`}
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
                className={`relative aspect-[2/3] w-16 flex-shrink-0 overflow-hidden cursor-pointer focus-visible:outline-none transition-opacity duration-200 ${
                  selectedIndex === index
                    ? 'ring-1 ring-black opacity-100'
                    : 'opacity-50 hover:opacity-90'
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

        {/* 幅は列内に収め（min-w-0 + w-full）、高さは aspect 比から従属させる。
            max-w で従来の高さ上限 min(48rem, 100svh-5rem) 相当を超えないようにする */}
        <div
          data-testid="look-detail-main-image-frame"
          className="relative aspect-[2/3] w-full min-w-0 max-w-[calc(min(48rem,100svh-5rem)*2/3)] overflow-hidden bg-white"
        >
          <Image
            data-testid="look-main-image"
            key={`${theme}:${selectedImage}`}
            src={selectedImage}
            alt={`${theme} - ${selectedIndex + 1}枚目`}
            fill
            className="object-contain object-center motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
            sizes="(min-width: 1024px) 50vw, 100vw"
            priority
            unoptimized
          />
        </div>
      </div>
    </div>
  );
}
