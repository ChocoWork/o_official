'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/app/components/ui/Button';
import { Item } from '@/app/types/item';

type PublicItemGridHomeProps = {
  variant: 'home';
  items?: Item[];
  fetchLimit?: number;
  className?: string;
  /** home バリアント時のみ適用。未指定時は 6 */
  mobileLimit?: number;
};

type PublicItemGridCatalogProps = {
  variant: 'catalog';
  items: Item[];
  className?: string;
  mobileLimit?: number;
};

type PublicItemGridProps = PublicItemGridHomeProps | PublicItemGridCatalogProps;

export function PublicItemGrid(props: PublicItemGridProps) {
  const { variant, className, mobileLimit } = props;
  const [homeItems, setHomeItems] = useState<Item[]>([]);
  const [isLoadingHomeItems, setIsLoadingHomeItems] = useState(false);
  const [homeItemsError, setHomeItemsError] = useState<string | null>(null);

  const fetchLimit = variant === 'home' ? props.fetchLimit ?? 8 : 8;

  useEffect(() => {
    if (variant !== 'home' || typeof props.items !== 'undefined') {
      return;
    }

    const resolvedFetchLimit = Number.isFinite(fetchLimit) && fetchLimit > 0 ? Math.floor(fetchLimit) : 8;

    const fetchHomeItems = async () => {
      try {
        setIsLoadingHomeItems(true);
        const response = await fetch(`/api/items?limit=${resolvedFetchLimit}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to fetch home items');
        }

        const data: Item[] = await response.json();
        setHomeItems(data);
        setHomeItemsError(null);
      } catch (error) {
        console.error('Failed to fetch home items:', error);
        setHomeItems([]);
        setHomeItemsError('商品データの取得に失敗しました');
      } finally {
        setIsLoadingHomeItems(false);
      }
    };

    fetchHomeItems();
  }, [variant, props.items, fetchLimit]);

  const resolvedItems = variant === 'home' ? props.items ?? homeItems : props.items;

  const defaultCatalogGridClassName = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8';
  const defaultHomeGridClassName =
    'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 sm:gap-8 md:gap-10 lg:gap-10 xl:gap-10';
  const resolvedGridClassName =
    className ?? (variant === 'home' ? defaultHomeGridClassName : defaultCatalogGridClassName);
  const gridClassName = `${resolvedGridClassName} w-full`;

  const resolvedMobileLimit = variant === 'home' ? mobileLimit ?? 6 : undefined;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === 'number';

  const renderGrid = () => (
    <div className={gridClassName}>
      {resolvedItems.map((item, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit;

        return (
          <Link key={item.id} href={`/item/${item.id}`} className={hideOnMobile ? 'hidden lg:block' : undefined}>
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
                {item.image_url ? (
                  <Image
                    src={item.image_url}
                    alt={item.name}
                    width={600}
                    height={800}
                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    priority={false}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-400">
                    No Image
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-xs text-[#474747] tracking-widest font-brand">{item.category}</p>
                <h3 className="text-base text-black tracking-tight font-brand">{item.name}</h3>
                <p className="text-sm text-black font-brand">¥{item.price.toLocaleString('ja-JP')}</p>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );

  if (variant === 'home') {
    if (homeItemsError !== null && typeof props.items === 'undefined') {
      return (
        <section id="items" className="lg:py-32 px-6 bg-white w-full">
          <div className="max-w-7xl mx-auto text-center py-10">
            <div className="text-xl text-red-500">{homeItemsError}</div>
          </div>
        </section>
      );
    }

    return (
      <section id="items" className="lg:py-32 px-6 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <div className="text-left mb-8">
            <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
              ITEMS
            </h2>
          </div>

          {isLoadingHomeItems && typeof props.items === 'undefined' ? (
            <div className="text-center py-8 text-[#474747] font-brand">読み込み中...</div>
          ) : resolvedItems.length === 0 ? (
            <div className="text-center py-8 text-[#474747] font-brand">公開中のITEMがありません</div>
          ) : (
            <div id="sym:success">
              {renderGrid()}
              {shouldLimitOnMobile && resolvedItems.length > resolvedMobileLimit && (
                <div className="text-center mt-10 lg:hidden">
                  <Button href="/item" variant="secondary" size="md" className="font-acumin">
                    VIEW ALL ITEMS
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  return renderGrid();
}
