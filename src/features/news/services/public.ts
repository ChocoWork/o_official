import { createPublicClient } from '@/lib/supabase/server';
import { PublicNewsArticle, PublicNewsDetailArticle, PublicNewsTitle } from '@/features/news/types';
import { isNewsId } from '@/features/news/lib/news-input';
import { describeErrorForLog } from '@/lib/logging/safe-error';

/**
 * 公開のニュースの取り出しが失敗したことを表す誤り。
 *
 * @impl IMPL-NEWS-174
 * @design DD-NEWS-003
 * @remarks 取り出しの失敗を「記事はまだありません」の空の一覧に見せないために投げる（SEC-NEWS-020）。
 * DB の誤りの文は画面や記録に出さないので、message は固定にし、突き合わせ用の code だけを持つ。
 */
export class NewsFetchError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super('Failed to fetch published news');
    this.name = 'NewsFetchError';
    this.code = code;
  }
}

/** 取り出しの失敗を名前と符号だけ記録し、固定の文の誤りにして返す。 */
function toFetchError(label: string, error: unknown): NewsFetchError {
  const described = describeErrorForLog(error);
  console.error(label, described);
  return new NewsFetchError(described.code);
}

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
 * 公開の画面は記事の画像を使わないので、画像の列は選ばず、署名のための service role も持たない（SEC-NEWS-005、ARC-NEWS-003）。
 * 取り出しの失敗は空の一覧に見せず NewsFetchError で投げ、呼び元が誤りの画面や固定の 500 にする（SEC-NEWS-020）。ホームだけは呼び元が握る。
 */
export async function getPublishedNews(options?: GetPublishedNewsOptions): Promise<PublicNewsArticle[]> {
  const supabase = await createPublicClient();

  let query = supabase
    .from('news_articles')
    .select('id, title, published_date, category, content')
    .eq('status', 'published')
    .order('published_date', { ascending: false });

  if (options?.category && options.category !== 'ALL') {
    query = query.eq('category', options.category);
  }

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    query = query.limit(Math.floor(options.limit));
  }

  const { data, error } = await query;

  if (error) {
    throw toFetchError('Failed to fetch published news:', error);
  }

  return (data ?? []) as PublicNewsArticle[];
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
    console.error('Failed to count published news:', describeErrorForLog(error));
    return 0;
  }

  return count ?? 0;
}

/**
 * 公開済みの記事を1件、本文つきで返す。無い時は null。
 *
 * @impl IMPL-NEWS-123
 * @design DD-NEWS-031
 * @remarks 非公開の記事を無い記事と同じ null にして、呼び元が 404 で有無を知らせないようにする（SEC-NEWS-001）。
 * 分類を受けて絞るのは、一覧で選んだ分類の外の記事を詳細でも出さないため（SCR-NEWS-002）。
 * 分類の値はここで確かめず、呼び元が許可の一覧で確かめた値を渡す前提にする。
 * 一覧と同じく画像の列は選ばず署名もしない（SEC-NEWS-005）。
 * id が bigint の形でなければ DB を呼ばず null にする（SEC-NEWS-012）。行が無い時は null、DB の失敗は NewsFetchError で投げ、「無い記事」の 404 と見分ける（SEC-NEWS-020）。
 */
export async function getPublishedNewsDetailById(
  id: string,
  options?: { category?: string },
): Promise<PublicNewsDetailArticle | null> {
  if (!isNewsId(id)) {
    return null;
  }

  const supabase = await createPublicClient();

  let query = supabase
    .from('news_articles')
    .select('id, title, published_date, category, content, detailed_content')
    .eq('status', 'published')
    .eq('id', id);

  if (options?.category && options.category !== 'ALL') {
    query = query.eq('category', options.category);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw toFetchError('Failed to fetch published news detail:', error);
  }

  return (data as PublicNewsDetailArticle | null) ?? null;
}

/**
 * 今の記事の前（1つ新しい）と次（1つ古い）の公開済みの記事を、id と題だけで返す。
 *
 * @impl IMPL-NEWS-124
 * @design DD-NEWS-032
 * @remarks 一覧と同じ公開日の新しい順で前後を決め、分類で絞って一覧で選んだ分類の中だけを辿れるようにする（FLOW-NEWS-001）。
 * 非公開の記事の題を前後のリンクに出さないよう、anon の client で公開済みの id と題だけを選ぶ（SEC-NEWS-001）。
 * 前後は添え物なので、取り出しの失敗は名前と符号だけ記録して前後なしで返し、記事の本体を隠さない（SEC-NEWS-020）。
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

  const { data, error } = await query;

  if (error) {
    console.error('Failed to fetch published news navigation:', describeErrorForLog(error));
    return { prevArticle: null, nextArticle: null };
  }

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
