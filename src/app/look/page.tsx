import type { Metadata } from 'next';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { resolveLookSeasonFilter } from '@/lib/look/public';
import { getPublishedLooks } from '@/lib/look/server';

type LookPageSearchParams = {
  season?: string;
};

export async function generateMetadata(): Promise<Metadata> {
  const title = 'LOOK BOOK | Le Fil des Heures';
  const description = 'Le Fil des Heures の公開LOOKを一覧で掲載。シーズン別のスタイリングと関連アイテムを確認できます。';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: ['/mainphoto.png'],
    },
  };
}

export default async function LookPage({
  searchParams,
}: {
  searchParams?: Promise<LookPageSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialSeason = resolveLookSeasonFilter(resolvedSearchParams?.season);
  const loadedLooks = await getPublishedLooks();

  return (
    <div className="element-width w-full">
      <PublicLookGrid variant="catalog" looks={loadedLooks} initialSeason={initialSeason} />
    </div>
  );
}
