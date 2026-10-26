/**
 * ニュースの一覧のページ（src/app/news/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-102
 * @design DD-NEWS-002
 * @remarks ページを作るサーバーの中で取り出し、自分の API への往復をせずに記事を入れた HTML を返す。
 * URL の category は外から来る値なので、分類の一覧にある1つの値だけを取り出しの絞りに渡し、それ以外は ALL にする（窓口と同じ決まりを resolveNewsCategory に置く）。
 * 取り出しの失敗は投げ、同じ階層の error.tsx の誤りの画面に任せる。失敗を空の一覧に見せない（SEC-NEWS-020）。
 * 一覧の title と description は記事に左右されないので固定の文にする。
 */
import type { Metadata } from 'next';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { getPublishedNews } from '@/features/news/services/public';
import { resolveNewsCategory } from '@/features/news/lib/news-input';

type NewsPageSearchParams = {
  category?: string;
};

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'NEWS | Le Fil des Heures',
    description:
      'Le Fil des Heuresの最新ニュース一覧。コレクション、イベント、コラボレーション、サステナビリティ、ストア情報を掲載。',
  };
}

export default async function NewsPage({
  searchParams,
}: {
  searchParams?: Promise<NewsPageSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const activeCategory = resolveNewsCategory(resolvedSearchParams?.category);
  const articles = await getPublishedNews({ category: activeCategory });

  return (
    <div className="w-full">
      <PublicNewsGrid
        variant="catalog"
        articles={articles}
        initialCategory={activeCategory}
      />
    </div>
  );
}
