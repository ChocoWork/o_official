import { createPublicClient, createServiceRoleClient } from '@/lib/supabase/server';
import { signNewsImageFields } from '@/lib/storage/news-images';
import { PublicNewsArticle, PublicNewsDetailArticle, PublicNewsTitle } from '@/features/news/types';

type GetPublishedNewsOptions = {
  category?: string;
  limit?: number;
};

/**
 * 公開済みのニュースを公開日の新しい順に返す。分類と件数で絞れる。
 *
 * @impl IMPL-NEWS-121
 * @design DD-NEWS-003
 * @remarks 下書きを外へ出さないため、anon の client の RLS に加えて取り出しの条件でも公開済みに絞る2段にする（SEC-NEWS-001）。
 * 画像の置き場は非公開なので、service role は DB の読み出しに使わず、返す前の画像の署名だけに使う（ARC-NEWS-003）。
 */
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

/**
 * 公開済みのニュースの総数を返す。
 *
 * @impl IMPL-NEWS-122
 * @design DD-NEWS-033
 * @remarks FREQ-149: ホームの VIEW ALL 表示判定用に、記事を全部読まずに数だけを知るため、行の中身を返さない数え方にする（SCR-NEWS-006）。
 * 非公開の記事を数に入れないよう、anon の client で公開済みだけを数える（SEC-NEWS-001）。
 * 失敗はホームの表示を止めないよう記録して 0 に倒す。
 */
export async function getPublishedNewsCount(): Promise<number> {
  const supabase = await createPublicClient();

  const { count, error } = await supabase
    .from('news_articles')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'published');

  if (error) {
    console.error('Failed to count published news:', error);
    return 0;
  }

  return count ?? 0;
}

/**
 * 公開済みの記事を1件、本文と署名済みの画像の道つきで返す。無い時は null。
 *
 * @impl IMPL-NEWS-123
 * @design DD-NEWS-031
 * @remarks 非公開の記事を無い記事と同じ null にして、呼び元が 404 で有無を知らせないようにする（SEC-NEWS-001）。
 * 分類を受けて絞るのは、一覧で選んだ分類の外の記事を詳細でも出さないため（SCR-NEWS-002）。
 * 分類の値はここで確かめず、呼び元が許可の一覧で確かめた値を渡す前提にする。
 */
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

/**
 * 今の記事の前（1つ新しい）と次（1つ古い）の公開済みの記事を、id と題だけで返す。
 *
 * @impl IMPL-NEWS-124
 * @design DD-NEWS-032
 * @remarks 一覧と同じ公開日の新しい順で前後を決め、分類で絞って一覧で選んだ分類の中だけを辿れるようにする（FLOW-NEWS-001）。
 * 非公開の記事の題を前後のリンクに出さないよう、anon の client で公開済みの id と題だけを選ぶ（SEC-NEWS-001）。
 */
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

  // DB の id は bigint で数として返るので、文字にして引数の id と比べる
  const currentIndex = allArticles.findIndex((item) => String(item.id) === id);
  const prevArticle = currentIndex > 0 ? allArticles[currentIndex - 1] : null;
  const nextArticle =
    currentIndex >= 0 && currentIndex < allArticles.length - 1
      ? allArticles[currentIndex + 1]
      : null;

  return { prevArticle, nextArticle };
}
