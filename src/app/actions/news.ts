'use server';

import { createClient } from "@/lib/supabase/server";

export type NewsArticle = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  image_url: string;
  content: string;
};

/**
 * ホームページ用：最新の公開済みNEWS記事を3件取得
 */
export async function getLatestNews(): Promise<NewsArticle[]> {
  const supabase = await createClient();
  
  const { data: articles } = await supabase
    .from("news_articles")
    .select("id, title, published_date, category, image_url, content")
    .eq("status", "published")
    .order("published_date", { ascending: false })
    .limit(3);
  
  return articles || [];
}
