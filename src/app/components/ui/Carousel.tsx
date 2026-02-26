import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface CarouselProps {
  children: ReactNode;
  className?: string;
}

export function Carousel({ children, className }: CarouselProps) {
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
