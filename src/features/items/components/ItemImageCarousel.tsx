"use client";

import Image from "next/image";
import { useRef, useState } from "react";

// FREQ-271: 商品画像が複数あるときのカルーセル。
// mobile / tablet: スワイプ（横スクロール + スナップ）
// desktop: 画像上の左右三角ボタン
// 全ビューポート共通で、画像下に枚数分のセグメント線インジケータを表示する。

/** 横スクロール位置から現在のスライド番号を求める（スライド幅 + gap が1枚分の移動量） */
export function carouselIndexFromScroll(el: HTMLElement): number | null {
  const firstSlide = el.children[0] as HTMLElement | undefined;
  if (!firstSlide) return null;
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  const stride = firstSlide.offsetWidth + gap;
  if (stride === 0) return null;
  return Math.round(el.scrollLeft / stride);
}

/** Tailwind の lg ブレークポイント（1024px）以上かどうか */
function isDesktopViewport(): boolean {
  return window.matchMedia("(min-width: 1024px)").matches;
}

/** 指定インデックスのスライドへスクロールする */
export function scrollCarouselTo(
  el: HTMLElement | null,
  index: number,
  behavior: ScrollBehavior = "smooth",
) {
  if (!el) return;
  const firstSlide = el.children[0] as HTMLElement | undefined;
  if (!firstSlide) return;
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  el.scrollTo({
    left: index * (firstSlide.offsetWidth + gap),
    behavior,
  });
}

/** 画像下のセグメント線インジケータ。現在位置だけ黒、他は薄いグレー */
export function CarouselSegmentIndicator({
  count,
  selectedIndex,
  onSelect,
  label,
  className,
  testId,
}: {
  count: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
  label: string;
  className?: string;
  testId?: string;
}) {
  if (count <= 1) {
    return null;
  }

  return (
    <div
      data-testid={testId}
      // 参考サイト同様、線と線の間に隙間を作らず1本の線を分割した見た目にする
      className={`flex w-full ${className ?? ""}`}
      role="tablist"
      aria-label={label}
    >
      {Array.from({ length: count }).map((_, index) => (
        <button
          key={index}
          type="button"
          role="tab"
          aria-selected={selectedIndex === index}
          aria-label={`${index + 1}枚目へ移動`}
          data-testid={testId ? `${testId}-segment` : undefined}
          data-active={selectedIndex === index ? "true" : "false"}
          // 線自体は 1px だが、タップ領域を確保するため上下に透明な余白を持たせる
          className="group flex-1 cursor-pointer py-[6px] focus-visible:outline-none"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(index);
          }}
        >
          <span
            aria-hidden="true"
            className={`block h-px w-full transition-colors duration-200 ${
              selectedIndex === index ? "bg-black" : "bg-black/15"
            }`}
          />
        </button>
      ))}
    </div>
  );
}

/**
 * 画像左右の送りボタン（desktop 用）。
 * アイコンは TOTEME（toteme.com）と同じ 15x15 の細いシェブロン。prev は左右反転して使う。
 */
export function CarouselArrowButton({
  direction,
  onClick,
  className,
  testId,
}: {
  direction: "prev" | "next";
  onClick: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={direction === "prev" ? "前の画像を表示" : "次の画像を表示"}
      className={`flex h-11 w-11 cursor-pointer items-center justify-center transition-opacity duration-200 hover:opacity-60 focus-visible:outline-none ${className ?? ""}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      <svg
        viewBox="0 0 15 15"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className={`h-[15px] w-[15px] ${direction === "prev" ? "-scale-x-100" : ""}`}
      >
        <path
          d="M8.621 7.492 6.146 5.017l.708-.707 3.182 3.182-3.182 3.182-.708-.708 2.475-2.474Z"
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
        />
      </svg>
    </button>
  );
}

/**
 * ホーム ITEM タブ / ITEM 一覧のカード内カルーセル（画像枠 + インジケータ）。
 * カードは <Link> の内側にあるため、操作系の click は preventDefault で遷移を止める。
 */
export function ItemCardImageCarousel({
  imageUrls,
  alt,
  priority = false,
  frameClassName,
  overlay,
}: {
  imageUrls: string[];
  alt: string;
  priority?: boolean;
  frameClassName: string;
  overlay?: React.ReactNode;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const goTo = (index: number, behavior: ScrollBehavior = "smooth") => {
    const clamped = Math.max(0, Math.min(index, imageUrls.length - 1));
    setSelectedIndex(clamped);
    scrollCarouselTo(scrollerRef.current, clamped, behavior);
  };

  // desktop の下線インジケータは画像が3枚以上あるときだけ、ホバー中に表示する。
  // 非表示は visibility で行い、ホバーでカードの高さが変わらないようにする。
  // 下線・送りボタンはどちらも「画像3枚以上」が条件
  const hasArrows = imageUrls.length >= 3;
  const indicatorClassName = hasArrows
    ? "lg:invisible lg:group-hover:visible"
    : "lg:invisible";

  return (
    <>
      <div
        className={frameClassName}
        // desktop: カードにホバーしている間だけ2枚目を表示し、離れたら1枚目へ戻す。
        // ホバーの切り替えは参考サイト同様スライドさせず即座に差し替える（behavior: auto）。
        // 2枚目以降の送りボタンによる移動は従来どおりスライドさせる。
        // タップで mouseenter が発火する端末で勝手に送られないよう lg 以上に限定する。
        onMouseEnter={() => {
          if (isDesktopViewport()) goTo(1, "auto");
        }}
        onMouseLeave={() => {
          if (isDesktopViewport()) goTo(0, "auto");
        }}
      >
        <div
          ref={scrollerRef}
          data-testid="item-card-carousel"
          // 縦横ともスクロールバーを出さない。scrollbar-width は Firefox 用、
          // ::-webkit-scrollbar は Chrome / Safari 用（inline style では書けない）
          className="flex h-full w-full touch-pan-x snap-x snap-mandatory overflow-x-scroll overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={(event) => {
            const index = carouselIndexFromScroll(event.currentTarget);
            if (index !== null) {
              setSelectedIndex(index);
            }
          }}
        >
          {imageUrls.map((imageUrl, index) => (
            <div
              key={`${index}:${imageUrl}`}
              data-testid="item-card-carousel-slide"
              className="relative h-full w-full shrink-0 snap-start"
            >
              <Image
                src={imageUrl}
                alt={`${alt} - ${index + 1}枚目`}
                fill
                className="object-cover object-top"
                priority={priority && index === 0}
                sizes="(min-width: 1280px) 20vw, (min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
                data-testid="item-image"
              />
            </div>
          ))}
        </div>

        {/* desktop: 画像が3枚以上あるときだけ、ホバー中に左右の送りボタンを表示する。
            2枚のカードはホバーで2枚目に切り替わるため送りボタンを出さない */}
        {hasArrows && selectedIndex > 0 && (
          <CarouselArrowButton
            direction="prev"
            testId="item-card-carousel-prev"
            onClick={() => goTo(selectedIndex - 1)}
            className="absolute left-0 top-1/2 hidden -translate-y-1/2 opacity-0 group-hover:opacity-100 lg:flex"
          />
        )}
        {hasArrows && selectedIndex < imageUrls.length - 1 && (
          <CarouselArrowButton
            direction="next"
            testId="item-card-carousel-next"
            onClick={() => goTo(selectedIndex + 1)}
            className="absolute right-0 top-1/2 hidden -translate-y-1/2 opacity-0 group-hover:opacity-100 lg:flex"
          />
        )}

        {overlay}
      </div>

      <CarouselSegmentIndicator
        testId="item-card-carousel-indicator"
        count={imageUrls.length}
        selectedIndex={selectedIndex}
        onSelect={goTo}
        label={`${alt} の画像インジケータ`}
        className={indicatorClassName}
      />
    </>
  );
}
