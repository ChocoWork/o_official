import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { signLookImageUrl } from '@/lib/storage/look-images';
import { signNewsImageUrl } from '@/lib/storage/news-images';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import type { SearchResult, SearchResultsResponse, SearchResultType, SearchSuggestion, SearchTab } from '@/features/search/types/search.types';

type SearchFunctionName = 'search_items' | 'search_looks' | 'search_news';

/**
 * 3つの検索関数のどれかが失敗したことを呼び手に伝える誤り。
 *
 * @impl IMPL-SEARCH-128
 * @design DD-SEARCH-006
 * @remarks 一部の種別だけ失敗したのに残りを「検索結果」として返すと、見つからないのか失敗なのか利用者に区別がつかないので、
 * 1つでも失敗したら全体を失敗にする（SEC-SEARCH-017）。DB の誤りの文には語が入りうるので、関数名と符号だけを持つ（SEC-SEARCH-018）。
 */
export class SearchBackendError extends Error {
  readonly fn: SearchFunctionName;
  readonly code: string | null;

  constructor(fn: SearchFunctionName, code: string | null) {
    super('Search backend function failed');
    this.name = 'SearchBackendError';
    this.fn = fn;
    this.code = code;
  }
}

function logSearchFunctionFailure(fn: SearchFunctionName, error: unknown): { name: string; code: string | null } {
  const described = describeErrorForLog(error);
  console.error('Search function failed:', { fn, ...described });
  return described;
}

type SearchExecutionOptions = {
  query: string;
  tab?: SearchTab;
  limitPerType?: number;
};

type RankedResult = SearchResult & {
  score: number;
};

type SuggestionCandidate = SearchSuggestion & {
  score: number;
};

type SearchItemRow = {
  id: number;
  name: string;
  description: string | null;
  category: string;
  image_url: string | null;
  price: number;
};

type SearchLookRow = {
  id: number;
  season_year: number;
  season_type: 'SS' | 'AW';
  theme: string;
  theme_description: string | null;
  image_urls: string[] | null;
};

type SearchNewsRow = {
  id: number;
  title: string;
  category: string;
  image_url: string | null;
  content: string;
  published_date: string;
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  const normalized = normalizeText(query);
  if (normalized.length === 0) {
    return [];
  }

  const tokens = normalized
    .split(/[\s/|:：,，.。!！?？()（）\[\]「」『』・-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return Array.from(new Set(tokens.length > 0 ? tokens : [normalized]));
}

function buildSnippet(source: string, query: string, fallback: string): string {
  const normalizedSource = normalizeText(source);
  const normalizedQuery = normalizeText(query);
  const matchIndex = normalizedSource.indexOf(normalizedQuery);

  if (matchIndex < 0) {
    return fallback;
  }

  const start = Math.max(0, matchIndex - 28);
  const end = Math.min(source.length, matchIndex + normalizedQuery.length + 68);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return `${prefix}${source.slice(start, end)}${suffix}`;
}

function rankText(texts: string[], query: string): number {
  const normalizedTexts = texts.map((text) => normalizeText(text));
  const normalizedQuery = normalizeText(query);
  const tokens = tokenizeQuery(query);

  if (normalizedQuery.length === 0 || tokens.length === 0) {
    return 0;
  }

  const haystack = normalizedTexts.join(' ');
  const hasFullQuery = haystack.includes(normalizedQuery);
  const allTokensMatched = tokens.every((token) => haystack.includes(token));

  if (!hasFullQuery && !allTokensMatched) {
    return 0;
  }

  let score = hasFullQuery ? 40 : 0;

  const title = normalizedTexts[0] ?? '';
  if (title.startsWith(normalizedQuery)) {
    score += 80;
  } else if (title.includes(normalizedQuery)) {
    score += 50;
  }

  for (const token of tokens) {
    normalizedTexts.forEach((text, index) => {
      if (text.includes(token)) {
        score += index === 0 ? 18 : 8;
      }
    });
  }

  return score;
}

function formatLookSeason(seasonYear: number, seasonType: 'SS' | 'AW'): string {
  return `${seasonYear} ${seasonType}`;
}

// ITEM のメタ表示は ItemCard と同じ「¥{カンマ区切り}」形式に揃える。
function formatItemPrice(price: number): string {
  return `¥${price.toLocaleString('ja-JP')}`;
}

// buildLikePattern removed: user input is now passed as a bind parameter to
// search_items / search_looks / search_news RPC functions, which escape ILIKE
// special characters internally (OWASP A03 – Injection prevention).

function mapPopularItem(item: SearchItemRow): SearchResult {
  return {
    id: String(item.id),
    type: 'item',
    title: item.name,
    description: item.description ?? item.category,
    href: `/item/${item.id}`,
    imageUrl: item.image_url ?? null,
    meta: formatItemPrice(item.price),
  };
}

/** 検索の結果に載せる署名つき URL の期限（秒）。呼び手が明示して、既定の変更に引きずられないようにする（SEC-SEARCH-014）。 */
export const SEARCH_IMAGE_URL_TTL_SECONDS = 3600;

// 画像バケットは private（migrations 030 / 044）で、配信は署名付き URL が前提。
// DB に保存されている public URL のままでは 400 になるため、種別ごとの署名関数を通す。
async function signResultImages(
  supabase: SupabaseClient,
  results: SearchResult[],
): Promise<SearchResult[]> {
  return Promise.all(
    results.map(async (result) => {
      if (!result.imageUrl) {
        return result;
      }

      let signedUrl: string | null;
      if (result.type === 'item') {
        signedUrl = await signItemImageUrl(supabase, result.imageUrl, SEARCH_IMAGE_URL_TTL_SECONDS);
      } else if (result.type === 'look') {
        signedUrl = await signLookImageUrl(supabase, result.imageUrl, SEARCH_IMAGE_URL_TTL_SECONDS);
      } else {
        signedUrl = await signNewsImageUrl(supabase, result.imageUrl, SEARCH_IMAGE_URL_TTL_SECONDS);
      }

      return { ...result, imageUrl: signedUrl };
    }),
  );
}

// FREQ-186: POPULAR ITEMS は購入数（status='paid' の注文数量合計）の多い順。
// 集計元の orders / order_items は RLS で本人・管理者のみに制限されているため、
// RPC は service_role 限定で、service role クライアントから呼ぶ。
async function getPopularItems(supabase: SupabaseClient, limit: number): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc('get_popular_items', { limit_count: limit });

  if (error) {
    console.error('Failed to fetch popular items:', describeErrorForLog(error));
    return [];
  }

  return ((data ?? []) as SearchItemRow[]).map(mapPopularItem);
}

/**
 * 人気商品と ITEM・LOOK・NEWS の検索結果を点の順に並べ、画像を署名つき URL にして返す。
 *
 * @impl IMPL-SEARCH-123
 * @design DD-SEARCH-006
 * @remarks 語は DB の関数の引数で渡し、フィルタの文字列に組まないので語で条件を書き換えられない。
 * 検索の関数は利用者の session の client で呼び、関数の中の公開の絞りに任せて下書きを返さない。
 * DB は部分一致で新しい順に返すだけなので、題の頭に語がある物を先に出す点と説明の切り出しはここで付ける。
 * 注文の表を数える人気商品の関数は service role の client から呼ぶ。商品ごとの売れ行きは外へ出さない情報なので、
 * 並びだけを人気の目安にして購入数は応答に写さない（SEC-SEARCH-009）。
 * 画像の置き場は非公開なので、応答を作るたびに種別ごとの関数で署名つき URL に置き換える。
 * 3つの検索関数のどれかが失敗したら SearchBackendError を投げて全体を失敗にし、「見つからない」と区別する（SEC-SEARCH-017）。
 * 記録に残すのは失敗した関数名と誤りの名前・符号だけで、検索語と DB の誤りの文は残さない（SEC-SEARCH-018）。
 */
export async function executeSearch(options: SearchExecutionOptions): Promise<SearchResultsResponse> {
  const query = options.query.trim();
  const tab = options.tab ?? 'all';
  const limitPerType = typeof options.limitPerType === 'number' ? options.limitPerType : 6;

  const signSupabase = await createServiceRoleClient();
  const popularItems = await signResultImages(signSupabase, await getPopularItems(signSupabase, 4));

  if (query.length === 0) {
    return {
      query,
      tab,
      items: [],
      looks: [],
      news: [],
      counts: { all: 0, item: 0, look: 0, news: 0 },
      popularItems,
      empty: false,
    };
  }

  const supabase = await createClient();

  // Use parameterized RPC functions so user input is never concatenated into
  // a PostgREST filter string (prevents filter-string injection).
  const [itemResult, lookResult, newsResult] = await Promise.all([
    supabase.rpc('search_items', { search_query: query, limit_count: limitPerType }),
    supabase.rpc('search_looks', { search_query: query, limit_count: limitPerType }),
    supabase.rpc('search_news',  { search_query: query, limit_count: limitPerType }),
  ]);

  // 1つでも失敗したら全体を失敗にする（SEC-SEARCH-017）。最初に見つけた1つを投げ、記録は失敗した関数ごとに1回。
  let firstFailure: SearchBackendError | null = null;
  const failures: Array<[SearchFunctionName, { error: unknown }]> = [
    ['search_items', itemResult],
    ['search_looks', lookResult],
    ['search_news', newsResult],
  ];
  for (const [fn, result] of failures) {
    if (result.error) {
      const described = logSearchFunctionFailure(fn, result.error);
      firstFailure ??= new SearchBackendError(fn, described.code);
    }
  }
  if (firstFailure) {
    throw firstFailure;
  }

  const items = (itemResult.data ?? []) as SearchItemRow[];
  const looks = (lookResult.data ?? []) as SearchLookRow[];
  const newsArticles = (newsResult.data ?? []) as SearchNewsRow[];

  const rankedItems: RankedResult[] = items
    .flatMap((item) => {
      const score = rankText([item.name, item.description ?? '', item.category], query);
      if (score === 0) {
        return [];
      }

      return [{
        id: String(item.id),
        type: 'item' as const,
        title: item.name,
        description: buildSnippet(item.description ?? item.category, query, item.category),
        href: `/item/${item.id}`,
        imageUrl: item.image_url ?? null,
        // FREQ-201: ITEM のメタは種別カテゴリではなく価格を表示する
        meta: formatItemPrice(item.price),
        score,
      }];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limitPerType);

  const rankedLooks: RankedResult[] = looks
    .flatMap((look) => {
      const score = rankText([look.theme, look.theme_description ?? ''], query);
      if (score === 0) {
        return [];
      }

      return [{
        id: String(look.id),
        type: 'look' as const,
        title: look.theme,
        description: buildSnippet(look.theme_description ?? '', query, formatLookSeason(look.season_year, look.season_type)),
        href: `/look/${look.id}`,
        imageUrl: Array.isArray(look.image_urls) ? (look.image_urls[0] ?? null) : null,
        meta: formatLookSeason(look.season_year, look.season_type),
        score,
      }];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limitPerType);

  const rankedNews: RankedResult[] = newsArticles
    .flatMap((article) => {
      const score = rankText([article.title, article.content, article.category], query);
      if (score === 0) {
        return [];
      }

      return [{
        id: String(article.id),
        type: 'news' as const,
        title: article.title,
        description: buildSnippet(article.content, query, article.category),
        href: `/news/${article.id}`,
        imageUrl: article.image_url ?? null,
        // FREQ-184: 参考デザインに合わせ、NEWS のメタは公開日（YYYY.MM.DD）を表示する
        meta: article.published_date.replace(/-/g, '.'),
        score,
      }];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limitPerType);

  const counts = {
    item: rankedItems.length,
    look: rankedLooks.length,
    news: rankedNews.length,
    all: rankedItems.length + rankedLooks.length + rankedNews.length,
  };

  const [signedItems, signedLooks, signedNews] = await Promise.all([
    signResultImages(signSupabase, rankedItems),
    signResultImages(signSupabase, rankedLooks),
    signResultImages(signSupabase, rankedNews),
  ]);

  return {
    query,
    tab,
    items: signedItems,
    looks: signedLooks,
    news: signedNews,
    counts,
    popularItems,
    empty: counts.all === 0,
  };
}

// FREQ-190: サジェストは「入力語がラベル自体に含まれる候補」に限る。
// 説明文や本文だけにヒットした候補を出すと、ラベルに入力語が現れず、なぜその候補が
// 出たのか利用者が判断できない（ハイライトも当たらない）。
function labelContainsQuery(label: string, query: string): boolean {
  return normalizeText(label).includes(normalizeText(query));
}

/**
 * 入力語をラベルに含む候補だけを、重なりを除いて点の順に返す。
 *
 * @impl IMPL-SEARCH-124
 * @design DD-SEARCH-007
 * @remarks ラベルに語が現れない候補は、なぜ出たのか利用者に分からず強調も当たらないので、ラベルに語を含む物だけを出す（ADR-0307）。
 * 語は DB の関数の引数で渡し、公開済みの絞りは関数に任せる（SEC-SEARCH-003・SEC-SEARCH-001）。
 * 候補は添え物なので、関数が失敗した種別は関数名と符号だけ記録して飛ばし、成功した種別で返す。投げない（SEC-SEARCH-017・018）。
 */
export async function getSearchSuggestions(query: string, limit = 8): Promise<SearchSuggestion[]> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const supabase = await createClient();

  // Parameterized RPC calls (same injection-prevention pattern as executeSearch).
  const [itemResult, lookResult, newsResult] = await Promise.all([
    supabase.rpc('search_items', { search_query: normalizedQuery, limit_count: limit }),
    supabase.rpc('search_looks', { search_query: normalizedQuery, limit_count: limit }),
    supabase.rpc('search_news',  { search_query: normalizedQuery, limit_count: limit }),
  ]);

  // 候補は添え物なので、失敗した種別は符号だけ記録して成功した種別で返す。投げない。
  if (itemResult.error) {
    logSearchFunctionFailure('search_items', itemResult.error);
  }
  if (lookResult.error) {
    logSearchFunctionFailure('search_looks', lookResult.error);
  }
  if (newsResult.error) {
    logSearchFunctionFailure('search_news', newsResult.error);
  }

  const items = (itemResult.data ?? []) as SearchItemRow[];
  const looks = (lookResult.data ?? []) as SearchLookRow[];
  const newsArticles = (newsResult.data ?? []) as SearchNewsRow[];

  const suggestions: SuggestionCandidate[] = [];

  items.forEach((item) => {
    const score = rankText([item.name, item.description ?? '', item.category], normalizedQuery);
    if (score > 0 && labelContainsQuery(item.name, normalizedQuery)) {
      suggestions.push({ label: item.name, type: 'item', href: `/search?q=${encodeURIComponent(item.name)}&tab=item`, score });
    }
  });

  looks.forEach((look) => {
    const score = rankText([look.theme, look.theme_description ?? ''], normalizedQuery);
    if (score > 0 && labelContainsQuery(look.theme, normalizedQuery)) {
      suggestions.push({ label: look.theme, type: 'look', href: `/search?q=${encodeURIComponent(look.theme)}&tab=look`, score });
    }
  });

  newsArticles.forEach((article) => {
    const score = rankText([article.title, article.content, article.category], normalizedQuery);
    if (score > 0 && labelContainsQuery(article.title, normalizedQuery)) {
      suggestions.push({ label: article.title, type: 'news', href: `/search?q=${encodeURIComponent(article.title)}&tab=news`, score });
    }
  });

  const unique = new Map<string, SuggestionCandidate>();
  suggestions
    .sort((left, right) => right.score - left.score)
    .forEach((suggestion) => {
      const key = `${suggestion.type}:${suggestion.label}`;
      if (!unique.has(key)) {
        unique.set(key, suggestion);
      }
    });

  return Array.from(unique.values()).slice(0, limit).map((candidate) => ({
    label: candidate.label,
    type: candidate.type,
    href: candidate.href,
  }));
}

/**
 * 検索結果の種別の表示名を返す。
 *
 * @impl IMPL-SEARCH-125
 * @design DD-SEARCH-008
 * @remarks 置いた理由の記録は無く、どこからも呼ばれない。画面の部品は自分の中に同じ写しを持つ（DD-SEARCH-008）。
 */
export function getResultTypeLabel(type: SearchResultType): string {
  switch (type) {
    case 'item':
      return 'ITEM';
    case 'look':
      return 'LOOK';
    case 'news':
      return 'NEWS';
    default:
      return '';
  }
}