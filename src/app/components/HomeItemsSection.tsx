'use client';

import { Button } from '@/app/components/ui/Button';
import { usePublicItems } from '@/features/items/hooks/usePublicItems';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

type HomeItemsSectionProps = {
  limit?: number;
};

export default function HomeItemsSection({ limit = 6 }: HomeItemsSectionProps) {
  const { items, loading, error } = usePublicItems({ limit });

  if (loading) {
    return (
      <section className="lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl">商品データを読み込み中...</div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl text-red-500">{error}</div>
        </div>
      </section>
    );
  }

  const displayItems = items;

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
