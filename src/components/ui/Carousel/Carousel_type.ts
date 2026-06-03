// File: src/components/ui/Carousel/Carousel_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface CarouselSlide {
  src: string;
  alt: string;
}

export interface CarouselProps {
  children?: ReactNode;
  slides?: readonly CarouselSlide[];
  /** controlled index */
  index?: number;
  onIndexChange?: (index: number) => void;
  /** override viewport aspect-ratio via class */
  aspectClassName?: string;
  showDots?: boolean;
  showArrows?: boolean;
  className?: string;
  /** demo-friendly size: xs/sm/md/lg/xl default md */
  size?: ComponentSize;
}