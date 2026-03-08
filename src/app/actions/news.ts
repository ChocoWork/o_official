'use server';

import { getPublishedNews } from '@/features/news/services/public';
import { PublicNewsArticle } from '@/features/news/types';

export type NewsArticle = PublicNewsArticle;

/**
 * ホームページ用：最新の公開済みNEWS記事を3件取得
 */
export async function getLatestNews(): Promise<NewsArticle[]> {
  return getPublishedNews({ limit: 3 });
}
