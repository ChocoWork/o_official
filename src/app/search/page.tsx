/**
 * 検索ページ `/search` の入口。固定のメタと、検索の画面を包む殻だけを返す。
 *
 * @packageDocumentation
 * @impl IMPL-SEARCH-101
 * @design DD-SEARCH-001
 * @remarks 画面は URL の検索の引数を端末で読むので、この頁は DB を読まない（ARC-SEARCH-001）。
 * title・description・OG の画像は検索語に左右されない固定の値にして、検索語を頁のメタに載せない（DRV-SEARCH-009）。
 * URL の引数を端末で読む部品は、Next.js が区切り（Suspense）で包むことを求める（包まないとビルドで落ちる）ので、読み込み中の文を出す区切りで包む。
 */
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
    <Suspense fallback={<p className="lk-text-sm text-[#474747]">読み込み中...</p>}>
      <SearchPageClient />
    </Suspense>
  );
}