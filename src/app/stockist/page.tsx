import type { Metadata } from 'next';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';

export async function generateMetadata(): Promise<Metadata> {
  const title = 'STOCKIST | Le Fil des Heures';
  const description = 'Le Fil des Heures の取扱店舗一覧です。店舗名・住所・営業時間・定休日をご確認いただけます。';

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

export default function StockistPage() {
  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicStockistGrid variant="catalog"/>
      </div>
    </div>
  );
}