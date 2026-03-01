"use client";

import { cn } from '@/lib/utils';
import Image from 'next/image';
import { useState, type ReactNode } from 'react';

export interface CarouselSlide {
  src: string;
  alt: string;
}

export interface CarouselProps {
  children?: ReactNode;
  slides?: readonly CarouselSlide[];
  index?: number;
  onIndexChange?: (index: number) => void;
  aspectClassName?: string;
  showDots?: boolean;
  showArrows?: boolean;
  className?: string;
}

export function Carousel({
  children,
  slides,
  index,
  onIndexChange,
  aspectClassName,
  showDots = true,
  showArrows = true,
  className,
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

  if (slides && slides.length > 0) {
    const activeSlide = slides[currentIndex] ?? slides[0];

    return (
      <div className={cn('relative mx-auto max-w-4xl', className)}>
        <div className={cn('relative aspect-[16/10] overflow-hidden bg-[#f5f5f5]', aspectClassName)}>
          <Image
            alt={activeSlide.alt}
            className="h-full w-full object-cover object-top"
            src={activeSlide.src}
            width={800}
            height={500}
            priority={false}
          />
          {showArrows ? (
            <>
              <button
                type="button"
                className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center bg-white/90 transition-colors hover:bg-white"
                onClick={() => setCurrentIndex(currentIndex - 1)}
              >
                <div className="flex h-6 w-6 items-center justify-center">
                  <i className="ri-arrow-left-s-line text-2xl"></i>
                </div>
              </button>
              <button
                type="button"
                className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center bg-white/90 transition-colors hover:bg-white"
                onClick={() => setCurrentIndex(currentIndex + 1)}
              >
                <div className="flex h-6 w-6 items-center justify-center">
                  <i className="ri-arrow-right-s-line text-2xl"></i>
                </div>
              </button>
            </>
          ) : null}
          {showDots ? (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2">
              {slides.map((slide, slideIndex) => (
                <button
                  key={slide.alt}
                  type="button"
                  className={cn(
                    'cursor-pointer transition-all',
                    currentIndex === slideIndex ? 'h-2 w-6 rounded-full bg-white' : 'h-2 w-2 rounded-full bg-white/50',
                  )}
                  onClick={() => setCurrentIndex(slideIndex)}
                ></button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex snap-x gap-4 overflow-x-auto pb-2', className)}>
      {Array.isArray(children)
        ? children.map((child, index) => (
            <div key={index} className="min-w-[260px] snap-start">
              {child}
            </div>
          ))
        : <div className="min-w-[260px] snap-start">{children}</div>}
    </div>
  );
}
