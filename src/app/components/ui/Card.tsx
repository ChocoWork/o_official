import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface CardProps {
  children?: ReactNode;
  className?: string;
  hoverable?: boolean;
  image?: ReactNode;
  imageClassName?: string;
  overlayAction?: ReactNode;
  category?: string;
  title?: string;
  price?: string;
  footer?: ReactNode;
}

export function Card({
  children,
  className,
  hoverable = false,
  image,
  imageClassName,
  overlayAction,
  category,
  title,
  price,
  footer,
}: CardProps) {
  if (children) {
    return (
      <article
        className={cn(
          'border border-[#d5d0c9] bg-white p-6',
          hoverable ? 'transition-colors hover:border-black' : null,
          className,
        )}
      >
        {children}
      </article>
    );
  }

  return (
    <article className={cn('group cursor-pointer', className)}>
      {image ? (
        <div className={cn('relative mb-4 aspect-[4/5] overflow-hidden bg-[#f5f5f5]', imageClassName)}>
          {image}
          {overlayAction ? <div className="absolute right-4 top-4">{overlayAction}</div> : null}
        </div>
      ) : null}
      {(category || title || price || footer) ? (
        <div>
          {category ? (
            <p className="mb-2 text-xs tracking-widest text-black/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {category}
            </p>
          ) : null}
          {title ? (
            <h3 className="mb-2 text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {title}
            </h3>
          ) : null}
          {price ? (
            <p className="text-sm text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {price}
            </p>
          ) : null}
          {footer}
        </div>
      ) : null}
    </article>
  );
}
