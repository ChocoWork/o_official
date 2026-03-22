'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/Button';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

type HomeItemsSectionProps = {
  limit?: number;
};

export default function HomeItemsSection({ limit = 6 }: HomeItemsSectionProps) {
  const [isWide, setIsWide] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(min-width: 1024px)');

    const updateIsWide = (matches: boolean) => {
      setIsWide(matches);
    };

    updateIsWide(mediaQuery.matches);

    const handleChange = (event: MediaQueryList | MediaQueryListEvent) => {
      updateIsWide(event.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // 画面幅に関係なく先に8件を取得し、狭い場合は表示だけ6件にする
  const { items, error } = usePublicItems({
    limit: 8,
    enabled: isWide !== null,
  });

  const isReadyToShow = !error && isWide !== null;

  const displayItems = isWide === false ? items.slice(0, Math.min(limit, items.length)) : items;

  return (
    <section id="items" className="lg:py-32 px-6 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-left mb-8">
          <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
            ITEMS
          </h2>
        </div>

        {error && (
          <div id="sym:error" className="text-center py-10">
            <div className="text-xl text-red-500">{error}</div>
          </div>
        )}

        {isReadyToShow && (
          <div id="sym:success">
            <PublicItemGrid
              items={displayItems}
              className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 sm:gap-8 md:gap-10 lg:gap-10 xl:gap-10"
            />
            {items.length > displayItems.length && (
              <div className="text-center mt-10">
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

