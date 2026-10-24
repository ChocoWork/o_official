/**
 * LOOK 一覧のページ（src/app/look/page.tsx）。URL の season を直し、公開の LOOK を全部取って格子に渡す。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-102
 * @design DD-LOOK-002
 * @remarks シーズンの絞り込みは画面の上で行うので、サーバーでは件数の上限を付けずに全部取る。URL の season は利用者が書き換えられるので、不正な値は誤りにせず ALL に直して一覧を空にしない。
 */
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
    <div className="w-full">
      <PublicLookGrid variant="catalog" looks={loadedLooks} initialSeason={initialSeason} />
    </div>
  );
}
