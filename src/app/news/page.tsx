import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';

export default async function NewsPage({
  searchParams,
}: {
  searchParams?: Promise<{ category?: string }>;
}) {
  await searchParams;

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicNewsGrid variant="catalog" />
      </div>
    </main>
  );
}
