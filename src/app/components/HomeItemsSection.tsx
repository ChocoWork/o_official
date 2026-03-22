'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/Button';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

type HomeItemsSectionProps = {
  limit?: number;
};

export default function HomeItemsSection({ limit = 6 }: HomeItemsSectionProps) {
  const [isLargeScreen, setIsLargeScreen] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const desiredItemCount = isLargeScreen ? 8 : limit;
  const { items, loading, error } = usePublicItems({ limit: desiredItemCount });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 1024px)');
    const setMatch = (event: MediaQueryList | MediaQueryListEvent) => {
      setIsLargeScreen(event.matches);
    };

    mediaQuery.addEventListener('change', setMatch);
    return () => mediaQuery.removeEventListener('change', setMatch);
  }, []);

  const displayItems = items;

  if (loading) {
    return (
      <section className="lg:py-32 px-6 bg-white w-full" aria-live="polite">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 sm:gap-8 md:gap-10 lg:gap-10 xl:gap-10 animate-pulse" aria-hidden="true">
            {Array.from({ length: desiredItemCount }).map((_, index) => (
              <div key={index} className="aspect-[3/4] bg-slate-100 dark:bg-slate-800" />
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="lg:py-32 px-6 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl text-red-500">{error}</div>
        </div>
      </section>
    );
  }

  return (
    <section className="lg:py-32 px-6 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-left mb-8">
          <h2
            className="text-xl lg:text-2xl mb-2 text-black font-semibold tracking-tight underline underline-offset-8 decoration-black decoration-1"
            style={{ fontFamily: "Didot, serif" }}
          >
            ITEMS
          </h2>
        </div>
        <PublicItemGrid 
          items={displayItems}
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 sm:gap-8 md:gap-10 lg:gap-10 xl:gap-10"
        />
        <div className="text-center mt-10">
          <Button href="/item" variant="secondary" size="md" className=" font-acumin">VIEW ALL ITEMS</Button>
        </div>
      </div>
    </section>
  );
}
