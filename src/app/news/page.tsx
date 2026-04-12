import type { Metadata } from 'next';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { getPublishedNews } from '@/features/news/services/public';
import { categories } from '@/lib/news-data';

type NewsPageSearchParams = {
  category?: string;
};

function resolveCategory(category: string | undefined): (typeof categories)[number] {
  const normalizedCategory = (category ?? 'ALL').toUpperCase();
  return categories.includes(normalizedCategory as (typeof categories)[number])
    ? (normalizedCategory as (typeof categories)[number])
    : 'ALL';
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'NEWS | Le Fil des Heures',
    description:
      'Le Fil des Heuresの最新ニュース一覧。コレクション、イベント、コラボレーション、サステナビリティ、ストア情報を掲載。',
  };
}

export default async function NewsPage({
  searchParams,
}: {
  searchParams?: Promise<NewsPageSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const activeCategory = resolveCategory(resolvedSearchParams?.category);
  const articles = await getPublishedNews({ category: activeCategory });

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicNewsGrid
          variant="catalog"
          articles={articles}
          initialCategory={activeCategory}
        />
      </div>
    </div>
  );
}
