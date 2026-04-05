import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';
import { getPublishedItems } from '@/lib/items/public';

export default async function ItemPage() {
  const items = await getPublishedItems();

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicItemGrid variant="catalog" items={items} />
      </div>
    </div>
  );
}
