import { cn } from '@/lib/utils';
import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';

interface BaseListProps<T> {
  items: readonly T[];
  itemKey?: (item: T, index: number) => string;
  className?: string;
  /** 表示サイズ(sm/md/lg)。デフォルトは 'md'。 */
  size?: ComponentSize;
}

interface CustomListProps<T> extends BaseListProps<T> {
  renderItem: (item: T, index: number) => ReactNode;
  variant?: 'custom';
}

interface ShowcaseListProps<T> extends BaseListProps<T> {
  variant: 'showcase';
  getName: (item: T) => string;
  getCategory: (item: T) => string;
  getPrice: (item: T) => ReactNode;
  /** Optional callback returning the image URL for the preview. If absent,
   * a placeholder icon is shown. */
  getImage?: (item: T) => string | null | undefined;
  /** Optional link for row click */
  getHref?: (item: T) => string;
}

export type ListProps<T> = CustomListProps<T> | ShowcaseListProps<T>;

const showcaseSizeMap: Record<ComponentSize, {
  rowPadding: string;
  rowGap: string;
  previewSize: string;
  titleSize: string;
  categorySize: string;
  rightSize: string;
  iconSize: string;
}> = {
  sm: {
    rowPadding: 'px-3 py-2',
    rowGap: 'gap-3',
    previewSize: 'w-10 h-10',
    titleSize: 'text-xs',
    categorySize: 'text-[10px]',
    rightSize: 'text-xs',
    iconSize: 'text-lg',
  },
  md: {
    rowPadding: 'px-4 py-3',
    rowGap: 'gap-4',
    previewSize: 'w-12 h-12',
    titleSize: 'text-sm',
    categorySize: 'text-xs',
    rightSize: 'text-sm',
    iconSize: 'text-xl',
  },
  lg: {
    rowPadding: 'px-5 py-4',
    rowGap: 'gap-5',
    previewSize: 'w-14 h-14',
    titleSize: 'text-base',
    categorySize: 'text-sm',
    rightSize: 'text-base',
    iconSize: 'text-2xl',
  },
};

export function List<T>({ items, itemKey, className, size = 'md', ...props }: ListProps<T>) {
  const gapMap: Record<ComponentSize, string> = {
    sm: 'space-y-1',
    md: 'space-y-2',
    lg: 'space-y-4',
  };
  const textSizeMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };
  const gapClass = gapMap[size];
  const itemTextClass = textSizeMap[size];
  const isShowcaseVariant = props.variant === 'showcase';
  const showcaseClasses = showcaseSizeMap[size];

  return (
    <ul className={cn(gapClass, className)}>
      {items.map((item, index) => (
        <li key={itemKey ? itemKey(item, index) : index} className={cn(!isShowcaseVariant && itemTextClass, isShowcaseVariant && 'hover:bg-[#f5f5f5]') }>
          {isShowcaseVariant ? (
            props.getHref ? (
              <Link
                href={props.getHref(item)}
                className={cn(
                  'block flex items-center justify-between',
                  showcaseClasses.rowPadding,
                  index < items.length - 1 && 'border-b border-black/10',
                )}
              >
                <div className={cn('flex items-center', showcaseClasses.rowGap)}>
                  <div className={cn('bg-[#f5f5f5] relative overflow-hidden flex items-center justify-center', showcaseClasses.previewSize, 'h-auto')}>
                    {props.getImage ? (
                      <Image
                        src={props.getImage(item) || '/placeholder.png'}
                        alt={props.getName(item)}
                        fill
                        className="object-contain"
                      />
                    ) : (
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className={cn('ri-image-line text-black/40', showcaseClasses.iconSize)}></i>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className={cn('text-black mb-1', showcaseClasses.titleSize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      {props.getName(item)}
                    </p>
                    <p className={cn('text-black/40 tracking-wider', showcaseClasses.categorySize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      {props.getCategory(item)}
                    </p>
                  </div>
                </div>
                <div className={cn('flex items-center', showcaseClasses.rowGap)}>
                  <span className={cn('text-black', showcaseClasses.rightSize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                    {props.getPrice(item)}
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className={cn('ri-arrow-right-s-line text-black/40', showcaseClasses.iconSize)}></i>
                  </div>
                </div>
              </Link>
            ) : (
              <div
                className={cn(
                  'flex cursor-pointer items-center justify-between transition-colors hover:bg-[#f5f5f5]',
                  showcaseClasses.rowPadding,
                  index < items.length - 1 && 'border-b border-black/10',
                )}
              >
                <div className={cn('flex items-center', showcaseClasses.rowGap)}>
                  <div className={cn('bg-[#f5f5f5] relative overflow-hidden flex items-center justify-center', showcaseClasses.previewSize, 'h-auto')}>
                    {props.getImage ? (
                      <Image
                        src={props.getImage(item) || '/placeholder.png'}
                        alt={props.getName(item)}
                        fill
                        className="object-contain"
                      />
                    ) : (
                      <div className="w-5 h-5 flex items-center justify-center">
                        <i className={cn('ri-image-line text-black/40', showcaseClasses.iconSize)}></i>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className={cn('text-black mb-1', showcaseClasses.titleSize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      {props.getName(item)}
                    </p>
                    <p className={cn('text-black/40 tracking-wider', showcaseClasses.categorySize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                      {props.getCategory(item)}
                    </p>
                  </div>
                </div>
                <div className={cn('flex items-center', showcaseClasses.rowGap)}>
                  <span className={cn('text-black', showcaseClasses.rightSize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                    {props.getPrice(item)}
                  </span>
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className={cn('ri-arrow-right-s-line text-black/40', showcaseClasses.iconSize)}></i>
                  </div>
                </div>
              </div>
            )
          ) : (
            props.renderItem(item, index)
          )}
        </li>
      ))}
    </ul>
  );
}
