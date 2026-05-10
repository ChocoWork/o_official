import type { Metadata } from 'next';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

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

export default async function LookPage() {
  return (
    <div className="element-width">
      <PublicLookGrid variant="catalog" />
    </div>
  );
}
