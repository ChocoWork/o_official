import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import Image from 'next/image';
import { Button } from './Button';
import { ComponentSize } from './types';

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
  /** optional label shown above content (e.g. for upload form) */
  label?: string;
  /** multiple preview images with removable icons (for upload UI) */
  previewUrls?: string[];
  onRemovePreview?: (index: number) => void;
  /** card size controlling padding/text. sm/md/lg default md */
  size?: ComponentSize;
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
  label,
  previewUrls,
  onRemovePreview,
  size = 'md',
}: CardProps) {
  const padMap: Record<ComponentSize, string> = {
    sm: 'p-4',
    md: 'p-6',
    lg: 'p-8',
  };
  const titleMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };
  const priceMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };
  // class names will be looked up inline to avoid unused-variable lint errors

  if (children) {
    return (
      <article
        className={cn(
          'border border-[#d5d0c9] bg-white',
          padMap[size],
          hoverable ? 'transition-colors hover:border-black' : null,
          className,
        )}
      >
        {label ? <p className="mb-2 text-xs tracking-widest text-black/80" style={{ fontFamily: 'acumin-pro, sans-serif' }}>{label}</p> : null}
        {children}
      </article>
    );
  }

  // if previewUrls given, render that grid before anything else
  if (previewUrls && previewUrls.length > 0) {
    return (
      <article className={cn('group cursor-pointer', padMap[size], className)}>
        {label ? <p className="mb-2 text-xs tracking-widest text-black/80" style={{ fontFamily: 'acumin-pro, sans-serif' }}>{label}</p> : null}
        <div className="grid grid-cols-2 gap-4 mb-6">
          {previewUrls.map((url, index) => (
            <div
              key={index}
              className="relative aspect-[3/4] bg-[#f5f5f5] overflow-hidden border border-black/20"
            >
              <Image
                src={url}
                alt={`プレビュー ${index + 1}`}
                fill
                className="w-full h-full object-cover object-center"
                unoptimized
              />
              {onRemovePreview ? (
                <Button
                  type="button"
                  onClick={() => onRemovePreview!(index)}
                  size="sm"
                  className="absolute top-2 right-2 h-8 w-8 p-0"
                >
                  ×
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </article>
    );
  }

  return (
    <article className={cn('group cursor-pointer', padMap[size], className)}>
      {label ? <p className="mb-2 text-xs tracking-widest text-black/80" style={{ fontFamily: 'acumin-pro, sans-serif' }}>{label}</p> : null}
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
            <h3
              className={cn('mb-2 text-black', titleMap[size])}
              style={{ fontFamily: 'acumin-pro, sans-serif' }}
            >
              {title}
            </h3>
          ) : null}
          {price ? (
            <p
              className={cn('text-black', priceMap[size])}
              style={{ fontFamily: 'acumin-pro, sans-serif' }}
            >
              {price}
            </p>
          ) : null}
          {footer}
        </div>
      ) : null}
    </article>
  );
}
