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
      <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl">商品データを読み込み中...</div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto text-center">
          <div className="text-xl text-red-500">{error}</div>
        </div>
      </section>
    );
  }

  const displayItems = items;

  return (
    <section className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 lg:mb-24">
          <h2
            className="text-4xl lg:text-5xl mb-4 text-black tracking-tight"
            style={{ fontFamily: "Didot, serif" }}
          >
            ITEMS
          </h2>
          <div className="w-16 h-px bg-black mx-auto"></div>
        </div>
        <PublicItemGrid
          items={displayItems}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-12"
        />
        <div className="text-center mt-16">
          <Button href="/item" variant="secondary" size="md" className=" font-acumin">VIEW ALL ITEMS</Button>
        </div>
      </div>
    </section>
  );
}
