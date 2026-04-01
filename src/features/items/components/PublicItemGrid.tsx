'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
import { Item } from '@/types/item';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';

const ITEM_CATEGORIES = ['ALL', 'TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
type ItemCategory = typeof ITEM_CATEGORIES[number];

type PublicItemGridHomeProps = {
  variant: 'home';
  items?: Item[];
  fetchLimit?: number;
  className?: string;
};

type PublicItemGridCatalogProps = {
  variant: 'catalog';
  items?: Item[];
  className?: string;
};

type PublicItemGridProps = PublicItemGridHomeProps | PublicItemGridCatalogProps;

export function PublicItemGrid(props: PublicItemGridProps) {
  const { variant } = props;

  // Category filter state - catalog variant only
  const [selectedCategory, setSelectedCategory] = useState<ItemCategory>('ALL');

  // Self-fetch: triggered when items are not provided externally
  const isSelfFetch = typeof props.items === 'undefined';
  const fetchLimit = variant === 'home' ? (props.fetchLimit ?? 8) : undefined;
  // Over-fetch by 1 to detect whether more items exist beyond fetchLimit
  const overFetchLimit = typeof fetchLimit === 'number' ? fetchLimit + 1 : undefined;
  const { items: fetchedItems, loading, error } = usePublicItems({
    limit: overFetchLimit,
    enabled: isSelfFetch,
  });
  const sourceItems = props.items ?? fetchedItems;

  const hasMoreItems = typeof fetchLimit === 'number' && sourceItems.length > fetchLimit;

  const resolvedItems = sourceItems.slice(0, fetchLimit ?? sourceItems.length);

  // Apply category filter for catalog variant
  const displayItems =
    variant === 'catalog' && selectedCategory !== 'ALL'
      ? resolvedItems.filter((item) => item.category === selectedCategory)
      : resolvedItems;

  const resolvedMobileLimit = variant === 'home' ? 6 : undefined;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === 'number';
  const hasHiddenItemsOnTablet = shouldLimitOnMobile && resolvedItems.length > resolvedMobileLimit;

  const renderGrid = () => (
    <div className='grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-2 sm:gap-4 md:gap-6 lg:gap-8 w-full'>
      {displayItems.map((item, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit!;

        return (
          <Link key={item.id} href={`/item/${item.id}`} className={hideOnMobile ? 'hidden lg:block' : undefined}>
            <div className="group cursor-pointer">
              <div className="aspect-[3/4] bg-[#f5f5f5] mb-2 overflow-hidden">
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
              <div>
                <h3 className="mb-1 text-base text-black font-brand tracking-tight">{item.name}</h3>
                <p className="mb-2 text-sm text-black font-brand">¥{item.price.toLocaleString('ja-JP')}</p>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );

  // home variant rendering
  if (variant === 'home') {
    if (isSelfFetch && error) {
      return (
        <section id="items" className="px-6 lg:px-12 bg-white w-full md:pb-20 lg:pb-20">
          <div className="max-w-7xl mx-auto text-center py-10">
            <div className="text-xl text-red-500">{error}</div>
          </div>
        </section>
      );
    }

    return (
      <section id="items" className="px-6 lg:px-12 bg-white w-full md:pb-20 lg:pb-20">
        <div className="max-w-7xl mx-auto">
          <SectionTitle title="ITEMS" />

          {isSelfFetch && loading ? (
            <div className="text-center py-12 text-[#474747] font-brand">読み込み中...</div>
          ) : resolvedItems.length === 0 ? (
            <div className="text-center py-12 text-[#474747] font-brand">公開中のITEMがありません</div>
          ) : (
            <div id="sym:success">
              {renderGrid()}
              {(hasHiddenItemsOnTablet || hasMoreItems) && (
                <div className="text-center mt-12">
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

  // catalog variant rendering
  if (isSelfFetch && loading) {
    return (
      <div className="text-center py-12">
        <div className="text-base tracking-widest font-brand">読み込み中...</div>
      </div>
    );
  }

  if (isSelfFetch && error) {
    return (
      <div className="text-center py-12">
        <div className="text-base tracking-widest font-brand text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
        <div className="flex flex-wrap gap-3">
          <TabSegmentControl
            items={ITEM_CATEGORIES.map((category) => ({ key: category, label: category }))}
            activeKey={selectedCategory}
            onChange={(category) => setSelectedCategory(category as ItemCategory)}
            variant="segment-pill"
            size="md"
          />
        </div>
      </div>

      {renderGrid()}

      {displayItems.length === 0 && (
        <div className="text-center py-12">
          <p className="text-base tracking-widest font-brand text-gray-500">商品が見つかりません</p>
        </div>
      )}
    </>
  );
}
