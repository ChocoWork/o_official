/**
 * 取扱店の一覧ページ /stockist とそのメタ情報（src/app/stockist/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-101
 * @design DD-STOCKIST-001
 * @remarks 店の数が少ない前提で、ページを作るサーバーの中で公開の店を 1 回で全部取り、絞り込みは部品に任せる。検索の結果や共有のカードで取扱店の頁だと分かるよう、題・説明・OGP は固定の値で返す。
 */
import type { Metadata } from 'next';
import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';
import { getPublicStockists } from '@/features/stockist/services/public';

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
  // フィルター（region/pref）クエリを読む PublicStockistGrid（catalog）が useSearchParams を
  // 使うため、searchParams を await して動的レンダリングへ切り替える。
  await searchParams;

  const stockists = await getPublicStockists();

  return (
    <div className="w-full">
      <PublicStockistGrid variant="catalog" stockists={stockists} />
    </div>
  );
}