'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/Button';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

type HomeItemsSectionProps = {
  limit?: number;
};

export default function HomeItemsSection({ limit = 6 }: HomeItemsSectionProps) {
  const [desiredItemCount, setDesiredItemCount] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(min-width: 1024px)');

    const updateLimit = (matches: boolean) => {
      setDesiredItemCount(matches ? 8 : limit);
    };

    updateLimit(mediaQuery.matches);

    const setMatch = (event: MediaQueryList | MediaQueryListEvent) => {
      updateLimit(event.matches);
    };

    mediaQuery.addEventListener('change', setMatch);
    return () => mediaQuery.removeEventListener('change', setMatch);
  }, [limit]);

  const { items, loading, error } = usePublicItems({
    limit: desiredItemCount ?? undefined,
    enabled: desiredItemCount !== null,
  });

  const displayItems = items;
  const isReadyToShow = !loading && !error && desiredItemCount !== null;

  return (
    <section id="items" className="lg:py-32 px-6 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-left mb-8">
          <h2
            className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1"
          >
            ITEMS
          </h2>
        </div>

        {loading && (
          <div id="sym:loading" className="space-y-4">
            <div className="sr-only" aria-live="polite">
              アイテムの読み込み中です
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 sm:gap-8 md:gap-10 lg:gap-10 xl:gap-10 animate-pulse" aria-hidden="true">
              {Array.from({ length: desiredItemCount ?? 0 }).map((_, index) => (
                <div key={index} className="aspect-[3/4] bg-slate-100 dark:bg-slate-800" />
              ))}
            </div>
          </div>
        )}

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
            {items.length > desiredItemCount && (
              <div className="text-center mt-10">
                <Button href="/item" variant="secondary" size="md" className=" font-acumin">
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
