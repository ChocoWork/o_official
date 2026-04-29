import { createClient } from '@/lib/supabase/server';
import type { SearchResult, SearchResultsResponse, SearchResultType, SearchSuggestion, SearchTab } from '@/features/search/types/search.types';

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
    meta: item.category,
  };
}

async function getPopularItems(limit: number): Promise<SearchResult[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('items')
    .select('id, name, description, category, image_url')
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Failed to fetch popular items:', error);
    return [];
  }

  return ((data ?? []) as SearchItemRow[]).map(mapPopularItem);
}

export async function executeSearch(options: SearchExecutionOptions): Promise<SearchResultsResponse> {
  const query = options.query.trim();
  const tab = options.tab ?? 'all';
  const limitPerType = typeof options.limitPerType === 'number' ? options.limitPerType : 6;

  const popularItems = await getPopularItems(4);

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

  if (itemResult.error) {
    console.error('Failed to search items:', itemResult.error);
  }
  if (lookResult.error) {
    console.error('Failed to search looks:', lookResult.error);
  }
  if (newsResult.error) {
    console.error('Failed to search news:', newsResult.error);
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
        meta: item.category,
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
        meta: article.category,
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

  return {
    query,
    tab,
    items: rankedItems,
    looks: rankedLooks,
    news: rankedNews,
    counts,
    popularItems,
    empty: counts.all === 0,
  };
}

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

  const items = (itemResult.data ?? []) as SearchItemRow[];
  const looks = (lookResult.data ?? []) as SearchLookRow[];
  const newsArticles = (newsResult.data ?? []) as SearchNewsRow[];

  const suggestions: SuggestionCandidate[] = [];

  items.forEach((item) => {
    const score = rankText([item.name, item.description ?? '', item.category], normalizedQuery);
    if (score > 0) {
      suggestions.push({ label: item.name, type: 'item', href: `/search?q=${encodeURIComponent(item.name)}&tab=item`, score });
    }
  });

  looks.forEach((look) => {
    const score = rankText([look.theme, look.theme_description ?? ''], normalizedQuery);
    if (score > 0) {
      suggestions.push({ label: look.theme, type: 'look', href: `/search?q=${encodeURIComponent(look.theme)}&tab=look`, score });
    }
  });

  newsArticles.forEach((article) => {
    const score = rankText([article.title, article.content, article.category], normalizedQuery);
    if (score > 0) {
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