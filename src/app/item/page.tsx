import type { Metadata } from 'next';
import { PublicItemGrid } from '@/features/items/components/PublicItemGrid';
import { getPublishedItemsPage, ItemSort } from '@/lib/items/public';

type ItemPageSearchParams = {
  category?: string;
  collection?: string;
  size?: string;
  color?: string;
  priceMin?: string;
  priceMax?: string;
  sort?: string;
};

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseSort(value: string | undefined): ItemSort {
  if (value === 'price_asc' || value === 'price_desc' || value === 'popular') {
    return value;
  }
  return 'newest';
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'ITEM | Le Fil des Heures',
    description:
      'Le Fil des Heuresの公開済み商品一覧。カテゴリ・サイズ・カラー・価格帯で絞り込み、価格順や新着順で比較できます。',
  };
}

export default async function ItemPage({
  searchParams,
}: {
  searchParams?: Promise<ItemPageSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const pageSize = 12;

  const initialResult = await getPublishedItemsPage({
    category: resolvedSearchParams?.category,
    size: resolvedSearchParams?.size,
    priceMin: parsePositiveInt(resolvedSearchParams?.priceMin),
    priceMax: parsePositiveInt(resolvedSearchParams?.priceMax),
    sort: parseSort(resolvedSearchParams?.sort),
    page: 1,
    pageSize,
  });

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicItemGrid
          variant="catalog"
          items={initialResult.items}
          initialHasMore={initialResult.hasMore}
          pageSize={pageSize}
        />
      </div>
    </div>
  );
}
