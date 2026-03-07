"use client";

import { cn } from '@/lib/utils';
import Image from 'next/image';
import { Button } from './Button';
import { useState, type ReactNode } from 'react';
import { ComponentSize } from './types';

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
  /** demo-friendly size: sm/md/lg */
  size?: ComponentSize;
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

  if (slides && slides.length > 0) {
    const activeSlide = slides[currentIndex] ?? slides[0];

    // size-based style maps
    const aspectMap: Record<ComponentSize, string> = {
      sm: 'aspect-[4/3]',
      md: 'aspect-[16/10]',
      lg: 'aspect-[16/9]',
    };
    // container width similar to MapView sizing
    const containerWidthMap: Record<ComponentSize, string> = {
      sm: 'w-1/2',
      md: 'w-3/4',
      lg: 'w-full',
    };
    const arrowIconMap: Record<ComponentSize, string> = {
      sm: 'text-lg',
      md: 'text-2xl',
      lg: 'text-3xl',
    };
    // dots: small fixed circle, active expands to fixed width
    // regardless of carousel size, follow sample w-2 h-2 rounded-full bg-white w-6
    const dotActiveWidth = 'w-6';
    const dotInactiveSize = 'w-2 h-2';

    return (
      <div className={cn('relative mx-auto', containerWidthMap[size], className)}>
        <div className={cn('relative overflow-hidden bg-[#f5f5f5]', aspectMap[size], aspectClassName)}>
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
              <Button
                size={size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'md'}
                variant="ghost"
                className={cn('absolute left-4 top-1/2 flex -translate-y-1/2', 'bg-white/90', 'hover:bg-white',
                  'items-center justify-center px-0', 'aspect-square')}
                onClick={() => setCurrentIndex(currentIndex - 1)}
              >
                <i className={cn('ri-arrow-left-s-line', arrowIconMap[size])}></i>
              </Button>
              <Button
                size={size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'md'}
                variant="ghost"
                className={cn('absolute right-4 top-1/2 flex -translate-y-1/2', 'bg-white/90', 'hover:bg-white',
                  'items-center justify-center px-0', 'aspect-square')}
                onClick={() => setCurrentIndex(currentIndex + 1)}
              >
                <i className={cn('ri-arrow-right-s-line', arrowIconMap[size])}></i>
              </Button>
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
                    currentIndex === slideIndex
                      ? cn('rounded-full bg-white', dotInactiveSize, dotActiveWidth)
                      : cn('rounded-full bg-white/50', dotInactiveSize),
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
