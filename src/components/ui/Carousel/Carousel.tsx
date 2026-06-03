// File: src/components/ui/Carousel/Carousel.tsx
'use client';

import '@/components/ui/Carousel/Carousel.css';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import { Button } from '@/components/ui/Button/Button';
import { useState } from 'react';
import type { ComponentSize } from '@/components/ui/types';
import type { CarouselProps } from '@/components/ui/Carousel/Carousel_type';

/** size → Button の size へのマッピング（Button 側の公比スケールに委譲）*/
const arrowButtonSizeMap: Record<ComponentSize, 'sm' | 'md' | 'lg'> = {
  xs: 'sm',
  sm: 'sm',
  md: 'md',
  lg: 'lg',
  xl: 'lg',
};

export function Carousel({
  children,
  slides,
  index,
  onIndexChange,
  aspectClassName,
  showDots = true,
  showArrows = true,
  className,
  size = 'md',
}: CarouselProps) {
  const [internalIndex, setInternalIndex] = useState(0);
  const currentIndex = index ?? internalIndex;

  const setCurrentIndex = (nextIndex: number) => {
    if (!slides || slides.length === 0) {
      return;
    }

    const normalizedIndex = (nextIndex + slides.length) % slides.length;
    if (onIndexChange) {
      onIndexChange(normalizedIndex);
      return;
    }
    setInternalIndex(normalizedIndex);
  };

  const rootDataAttrs = {
    'data-ui-carousel': 'true',
    'data-ui-carousel-size': size,
  } as const;

  // --- パターン1：スライド配列モード（画像＋矢印＋ドット）---
  if (slides && slides.length > 0) {
    const activeSlide = slides[currentIndex] ?? slides[0];

    return (
      <div
        className={cn('carousel', className)}
        data-ui-carousel-mode="slides"
        {...rootDataAttrs}
      >
        <div className={cn('carousel__viewport', aspectClassName)}>
          <Image
            alt={activeSlide.alt}
            className="carousel__image"
            src={activeSlide.src}
            width={800}
            height={500}
            priority={false}
          />

          {showArrows ? (
            <>
              <Button
                size={size}
                variant="ghost"
                className="carousel__arrow carousel__arrow--prev"
                onClick={() => setCurrentIndex(currentIndex - 1)}
                aria-label="前のスライド"
              >
                <i className="ri-arrow-left-s-line carousel__arrow-icon" aria-hidden="true" />
              </Button>
              <Button
                size={size}
                variant="ghost"
                className="carousel__arrow carousel__arrow--next"
                onClick={() => setCurrentIndex(currentIndex + 1)}
                aria-label="次のスライド"
              >
                <i className="ri-arrow-right-s-line carousel__arrow-icon" aria-hidden="true" />
              </Button>
            </>
          ) : null}

          {showDots ? (
            <div className="carousel__dots">
              {slides.map((slide, slideIndex) => (
                <button
                  key={slide.alt}
                  type="button"
                  className="carousel__dot"
                  data-ui-carousel-dot-active={
                    currentIndex === slideIndex ? 'true' : undefined
                  }
                  onClick={() => setCurrentIndex(slideIndex)}
                  aria-label={`スライド ${slideIndex + 1} へ`}
                  aria-current={currentIndex === slideIndex ? 'true' : undefined}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // --- パターン2：任意 children の横スクロールトラック ---
  return (
    <div
      className={cn('carousel', 'carousel__track', className)}
      data-ui-carousel-mode="track"
      {...rootDataAttrs}
    >
      {Array.isArray(children)
        ? children.map((child, childIndex) => (
            <div key={childIndex} className="carousel__track-item">
              {child}
            </div>
          ))
        : (
            <div className="carousel__track-item">{children}</div>
          )}
    </div>
  );
}