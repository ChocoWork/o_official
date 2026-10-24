'use server';

import { getPublishedNews } from '@/features/news/services/public';
import { PublicNewsArticle } from '@/features/news/types';

export type NewsArticle = PublicNewsArticle;

/**
 * ホームページ用：最新の公開済みNEWS記事を3件取得
 *
 * @impl IMPL-NEWS-163
 * @design DD-NEWS-066
 * @remarks 公開済みに絞る条件は呼ぶ先の getPublishedNews に任せて自分では書かず、絞りの決まりを公開の取り出しの1か所に残す（SEC-NEWS-001）。
 * どこからも呼ばれていない未使用の関数。削除の判断待ちなので、消えるまで範囲内の単位として動きを残す（ARC-NEWS-005）。
 */
export async function getLatestNews(): Promise<NewsArticle[]> {
  return getPublishedNews({ limit: 3 });
}
