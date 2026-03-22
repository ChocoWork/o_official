import { getPublishedItems } from '@/lib/items/public';
import { Button } from '@/app/components/ui/Button';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';

type HomeItemsSectionProps = {
  limit?: number;
};

export default async function HomeItemsSection({ limit = 6 }: HomeItemsSectionProps) {
  const items = await getPublishedItems(8);

  return (
    <section id="items" className="lg:py-32 px-6 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-left mb-8">
          <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
            ITEMS
          </h2>
        </div>

        <div id="sym:success">
          <PublicItemGrid
            items={items}
            mobileLimit={limit}
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-6 sm:gap-8 md:gap-10 lg:gap-10 xl:gap-10"
          />
          {items.length > limit && (
            <div className="text-center mt-10 lg:hidden">
              <Button href="/item" variant="secondary" size="md" className="font-acumin">
                VIEW ALL ITEMS
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

