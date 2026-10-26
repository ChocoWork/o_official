/**
 * LOOK 一覧のページ（src/app/look/page.tsx）。URL の season を直し、公開の LOOK を 100 件まで取って格子に渡す。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-102
 * @design DD-LOOK-002
 * @remarks シーズンの絞り込みは画面の上で行うので、サーバーでは季節で絞らず新しい順に 100 件まで取る（SEC-LOOK-009。説明文は取らない）。URL の season は利用者が書き換えられるので、不正な値は誤りにせず ALL に直して一覧を空にしない。取り出しの失敗は握らずに投げ、error.tsx の誤りの画面に任せる（SEC-LOOK-022）。
 */
import type { Metadata } from 'next';
import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';
import { resolveLookSeasonFilter } from '@/lib/look/public';
import { getPublishedLookList } from '@/lib/look/server';

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
  const loadedLooks = await getPublishedLookList();

  return (
    <div className="w-full">
      <PublicLookGrid variant="catalog" looks={loadedLooks} initialSeason={initialSeason} />
    </div>
  );
}
