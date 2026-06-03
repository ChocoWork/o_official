// File: src/components/ui/Card/Card.tsx
import '@/components/ui/Card/Card.css';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import { Button } from '@/components/ui/Button/Button';
import type { CardProps } from '@/components/ui/Card/Card_types';

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
  const rootDataAttrs = {
    'data-ui-card': 'true',
    'data-ui-card-size': size,
  } as const;

  // --- パターン1：任意の children を内包する汎用カード ---
  if (children) {
    return (
      <article
        className={cn('card', className)}
        data-ui-card-bordered="true"
        data-ui-card-hoverable={hoverable ? 'true' : undefined}
        {...rootDataAttrs}
      >
        {label ? <p className="card__label">{label}</p> : null}
        {children}
      </article>
    );
  }

  // --- パターン2：プレビュー画像グリッド（アップロードUI）---
  if (previewUrls && previewUrls.length > 0) {
    return (
      <article
        className={cn('card', 'card--interactive', className)}
        data-ui-card-interactive="true"
        {...rootDataAttrs}
      >
        {label ? <p className="card__label">{label}</p> : null}
        <div className="card__preview-grid">
          {previewUrls.map((url, index) => (
            <div key={index} className="card__preview-item">
              <Image
                src={url}
                alt={`プレビュー ${index + 1}`}
                fill
                className="card__preview-image"
                unoptimized
              />
              {onRemovePreview ? (
                <Button
                  type="button"
                  onClick={() => onRemovePreview(index)}
                  size="sm"
                  className="card__preview-remove"
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

  // --- パターン3：商品カード（画像＋カテゴリ／タイトル／価格／フッター）---
  const hasMeta = Boolean(category || title || price || footer);

  return (
    <article
      className={cn('card', 'card--interactive', className)}
      data-ui-card-interactive="true"
      {...rootDataAttrs}
    >
      {label ? <p className="card__label">{label}</p> : null}
      {image ? (
        <div className={cn('card__media', imageClassName)}>
          {image}
          {overlayAction ? (
            <div className="card__overlay-action">{overlayAction}</div>
          ) : null}
        </div>
      ) : null}
      {hasMeta ? (
        <div className="card__meta">
          {category ? <p className="card__category">{category}</p> : null}
          {title ? <h3 className="card__title">{title}</h3> : null}
          {price ? <p className="card__price">{price}</p> : null}
          {footer ? <div className="card__footer">{footer}</div> : null}
        </div>
      ) : null}
    </article>
  );
}