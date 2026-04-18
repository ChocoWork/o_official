import type { Metadata } from 'next';
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
  return <SearchPageClient />;
}