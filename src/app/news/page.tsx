import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { getPublishedNews } from '@/features/news/services/public';

export default async function NewsPage({
  searchParams,
}: {
  searchParams?: Promise<{ category?: string }>;
}) {
  await searchParams;
  const articles = await getPublishedNews();

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicNewsGrid variant="catalog" articles={articles} />
      </div>
    </div>
  );
}
