import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SearchPageClient } from '@/features/search/components/SearchPageClient';

export async function generateMetadata(): Promise<Metadata> {
  const title = 'Search | Le Fil des Heures';
  const description = 'Le Fil des Heures の商品・ルック・ニュースを横断検索できるページです。';

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

export default function SearchPage() {
  return (
    <Suspense fallback={<p className="text-sm text-[#474747]">読み込み中...</p>}>
      <SearchPageClient />
    </Suspense>
  );
}