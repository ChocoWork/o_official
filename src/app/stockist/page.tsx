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

export default async function StockistPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // フィルター（region/pref）クエリを読む PublicStockistCatalog が useSearchParams を
  // 使うため、searchParams を await して動的レンダリングへ切り替える。
  await searchParams;

  return (
    <div className="max-w-[1680px] mx-auto w-full">
      <PublicStockistGrid variant="catalog"/>
    </div>
  );
}