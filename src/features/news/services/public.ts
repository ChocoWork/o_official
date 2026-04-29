import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { signNewsImageFields } from '@/lib/storage/news-images';
import { PublicNewsArticle, PublicNewsDetailArticle, PublicNewsTitle } from '@/features/news/types';

type GetPublishedNewsOptions = {
  category?: string;
  limit?: number;
};

export async function getPublishedNews(options?: GetPublishedNewsOptions): Promise<PublicNewsArticle[]> {
  const [supabase, serviceSupabase] = await Promise.all([
    createPublicClient(),
    createServiceRoleClient(),
  ]);

  let query = supabase
    .from('news_articles')
    .select('id, title, published_date, category, image_url, content')
    .eq('status', 'published')
    .order('published_date', { ascending: false });

  if (options?.category && options.category !== 'ALL') {
    query = query.eq('category', options.category);
  }

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    query = query.limit(Math.floor(options.limit));
  }

  const { data } = await query;

  return Promise.all(
    ((data ?? []) as PublicNewsArticle[]).map((article) => signNewsImageFields(serviceSupabase, article)),
  );
}

export async function getPublishedNewsDetailById(
  id: string,
  options?: { category?: string },
): Promise<PublicNewsDetailArticle | null> {
  const [supabase, serviceSupabase] = await Promise.all([
    createPublicClient(),
    createServiceRoleClient(),
  ]);

  let query = supabase
    .from('news_articles')
    .select('id, title, published_date, category, image_url, content, detailed_content')
    .eq('status', 'published')
    .eq('id', id);

  if (options?.category && options.category !== 'ALL') {
    query = query.eq('category', options.category);
  }

  const { data } = await query.single();
  const article = (data as PublicNewsDetailArticle | null) ?? null;

  return article ? signNewsImageFields(serviceSupabase, article) : null;
}

export async function getPublishedNewsNavigation(
  id: string,
  options?: { category?: string },
): Promise<{ prevArticle: PublicNewsTitle | null; nextArticle: PublicNewsTitle | null }> {
  const supabase = await createPublicClient();

  let query = supabase
    .from('news_articles')
    .select('id, title')
    .eq('status', 'published')
    .order('published_date', { ascending: false });

  if (options?.category && options.category !== 'ALL') {
    query = query.eq('category', options.category);
  }

  const { data } = await query;
  const allArticles = (data ?? []) as PublicNewsTitle[];

  const currentIndex = allArticles.findIndex((item) => String(item.id) === id);
  const prevArticle = currentIndex > 0 ? allArticles[currentIndex - 1] : null;
  const nextArticle =
    currentIndex >= 0 && currentIndex < allArticles.length - 1
      ? allArticles[currentIndex + 1]
      : null;

  return { prevArticle, nextArticle };
}
