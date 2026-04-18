'use client';

import Link from 'next/link';
import React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SearchField } from '@/components/ui/SearchField';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
import { TagLabel } from '@/components/ui/TagLabel';
import type { SearchResult, SearchResultsResponse, SearchSuggestion, SearchTab } from '@/features/search/types/search.types';

const SEARCH_HISTORY_KEY = 'search.history';
const SEARCH_TABS = [
  { key: 'all', label: 'ALL' },
  { key: 'item', label: 'ITEM' },
  { key: 'look', label: 'LOOK' },
  { key: 'news', label: 'NEWS' },
] as const;

function normalizeTab(tab: string | null): SearchTab {
  if (tab === 'item' || tab === 'look' || tab === 'news') {
    return tab;
  }
  return 'all';
}

function getResultTypeLabel(type: SearchResult['type']): string {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'ig');
  const segments = text.split(pattern);

  return segments.map((segment, index) => {
    if (segment.toLowerCase() === normalizedQuery.toLowerCase()) {
      return <mark key={`${segment}-${index}`} className="bg-[#f2e6bf] px-0.5 text-black">{segment}</mark>;
    }
    return <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>;
  });
}

function readSearchHistory(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string' && value.length > 0) : [];
  } catch {
    return [];
  }
}

function writeSearchHistory(query: string): string[] {
  const normalizedQuery = query.trim();
  if (typeof window === 'undefined' || normalizedQuery.length === 0) {
    return [];
  }

  const nextHistory = [normalizedQuery, ...readSearchHistory().filter((value) => value !== normalizedQuery)].slice(0, 8);
  window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(nextHistory));
  return nextHistory;
}

function SearchResultCard({ result, query }: { result: SearchResult; query: string }) {
  return (
    <Link href={result.href} className="block rounded-2xl border border-black/10 bg-white p-5 transition-colors hover:border-black/30">
      <div className="mb-3 flex items-center justify-between gap-3">
        <TagLabel size="sm">{getResultTypeLabel(result.type)}</TagLabel>
        <span className="text-[11px] tracking-widest text-black/50 font-brand">{result.meta}</span>
      </div>
      <h2 className="mb-2 text-lg text-black font-display leading-snug">{renderHighlightedText(result.title, query)}</h2>
      <p className="text-sm leading-relaxed text-[#474747] font-brand">{renderHighlightedText(result.description, query)}</p>
    </Link>
  );
}

function SearchSection({ title, results, query }: { title: string; results: SearchResult[]; query: string }) {
  if (results.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-black/10 pb-3">
        <h2 className="text-lg tracking-widest text-black font-display">{title}</h2>
        <span className="text-xs tracking-widest text-black/50 font-brand">{results.length} RESULTS</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {results.map((result) => (
          <SearchResultCard key={`${result.type}-${result.id}`} result={result} query={query} />
        ))}
      </div>
    </section>
  );
}

export function SearchPageClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const activeTab = normalizeTab(searchParams.get('tab'));

  const [inputValue, setInputValue] = React.useState(query);
  const [results, setResults] = React.useState<SearchResultsResponse | null>(null);
  const [suggestions, setSuggestions] = React.useState<SearchSuggestion[]>([]);
  const [history, setHistory] = React.useState<string[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isInputFocused, setIsInputFocused] = React.useState(false);

  React.useEffect(() => {
    setInputValue(query);
  }, [query]);

  React.useEffect(() => {
    setHistory(readSearchHistory());
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const fetchResults = async () => {
      if (query.trim().length === 0) {
        setResults(null);
        setErrorMessage(null);
        return;
      }

      try {
        setIsLoading(true);
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&tab=${encodeURIComponent(activeTab)}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error('検索結果の取得に失敗しました');
        }

        const payload = (await response.json()) as SearchResultsResponse;
        if (!cancelled) {
          setResults(payload);
          setErrorMessage(null);
        }
      } catch (error) {
        console.error('Failed to fetch search results:', error);
        if (!cancelled) {
          setResults(null);
          setErrorMessage('検索結果を読み込めませんでした');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void fetchResults();

    return () => {
      cancelled = true;
    };
  }, [activeTab, query]);

  React.useEffect(() => {
    let cancelled = false;

    const fetchSuggestions = async () => {
      if (inputValue.trim().length === 0) {
        setSuggestions([]);
        return;
      }

      try {
        const response = await fetch(`/api/suggest?q=${encodeURIComponent(inputValue)}`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to fetch suggestions');
        }

        const payload = (await response.json()) as { suggestions: SearchSuggestion[] };
        if (!cancelled) {
          setSuggestions(payload.suggestions ?? []);
        }
      } catch (error) {
        console.error('Failed to fetch search suggestions:', error);
        if (!cancelled) {
          setSuggestions([]);
        }
      }
    };

    void fetchSuggestions();

    return () => {
      cancelled = true;
    };
  }, [inputValue]);

  const commitSearch = React.useCallback((nextQuery: string, nextTab: SearchTab = activeTab) => {
    const normalizedQuery = nextQuery.trim();
    const params = new URLSearchParams(searchParams.toString());

    if (normalizedQuery.length > 0) {
      params.set('q', normalizedQuery);
      setHistory(writeSearchHistory(normalizedQuery));
    } else {
      params.delete('q');
    }

    params.set('tab', nextTab);
    const nextUrl = params.toString().length > 0 ? `${pathname}?${params.toString()}` : pathname;
    router.replace(nextUrl, { scroll: false });
  }, [activeTab, pathname, router, searchParams]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitSearch(inputValue, activeTab);
    setIsInputFocused(false);
  };

  const handleTabChange = (tabKey: string) => {
    commitSearch(query, normalizeTab(tabKey));
  };

  const handleClear = () => {
    setInputValue('');
    const params = new URLSearchParams(searchParams.toString());
    params.delete('q');
    params.set('tab', activeTab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const displayedSuggestionButtons = React.useMemo(() => {
    if (!isInputFocused) {
      return [] as Array<{ key: string; label: string; onSelect: () => void }>;
    }

    if (inputValue.trim().length > 0) {
      return suggestions.map((suggestion) => ({
        key: `${suggestion.type}-${suggestion.label}`,
        label: suggestion.label,
        onSelect: () => {
          setInputValue(suggestion.label);
          commitSearch(suggestion.label, suggestion.type);
          setIsInputFocused(false);
        },
      }));
    }

    return history.map((entry) => ({
      key: `history-${entry}`,
      label: entry,
      onSelect: () => {
        setInputValue(entry);
        commitSearch(entry, activeTab);
        setIsInputFocused(false);
      },
    }));
  }, [activeTab, commitSearch, history, inputValue, isInputFocused, suggestions]);

  const activeResults = React.useMemo(() => {
    if (!results) {
      return [] as SearchResult[];
    }
    if (activeTab === 'item') {
      return results.items;
    }
    if (activeTab === 'look') {
      return results.looks;
    }
    if (activeTab === 'news') {
      return results.news;
    }
    return [];
  }, [activeTab, results]);

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <div className="space-y-3">
          <p className="text-xs tracking-[0.3em] text-black/50 font-brand">DISCOVER</p>
          <h1 className="text-4xl lg:text-5xl tracking-tight text-black font-display">SEARCH</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-[#474747] font-brand">
            商品、ルック、ニュースを横断して検索できます。キーワードは URL に保持され、再訪時には検索履歴から再利用できます。
          </p>
        </div>

        <div className="space-y-5">
          <form onSubmit={handleSubmit} className="relative max-w-3xl">
            <SearchField
              aria-label="Search"
              placeholder="商品名、ルックテーマ、ニュースタイトルで検索"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onFocus={() => setIsInputFocused(true)}
              showClearButton
              onClear={handleClear}
              size="lg"
              autoComplete="off"
            />
          </form>

          {displayedSuggestionButtons.length > 0 ? (
            <div className="rounded-2xl border border-black/10 bg-[#fafafa] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs tracking-widest text-black/50 font-brand">
                  {inputValue.trim().length > 0 ? 'SUGGESTIONS' : 'RECENT SEARCHES'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {displayedSuggestionButtons.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={entry.onSelect}
                    className="rounded-full border border-black/15 bg-white px-4 py-2 text-sm text-black transition-colors hover:border-black/40 font-brand"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <TabSegmentControl
          items={SEARCH_TABS.map((tab) => ({ key: tab.key, label: tab.label }))}
          activeKey={activeTab}
          onChange={handleTabChange}
          variant="tabs-standard"
        />

        {errorMessage ? <p className="text-sm text-[#b42318] font-brand">{errorMessage}</p> : null}

        {!query ? (
          <section className="space-y-4 rounded-[28px] border border-black/10 bg-[#fafafa] p-6">
            <h2 className="text-lg tracking-widest text-black font-display">START YOUR SEARCH</h2>
            <p className="text-sm leading-relaxed text-[#474747] font-brand">
              気になる商品名やトピックを入力すると、商品・ルック・ニュースを横断した結果を表示します。
            </p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {(results?.popularItems ?? []).map((item) => (
                <SearchResultCard key={`popular-${item.id}`} result={item} query="" />
              ))}
            </div>
          </section>
        ) : isLoading ? (
          <p className="text-sm text-[#474747] font-brand">検索中です…</p>
        ) : results?.empty ? (
          <section className="space-y-6 rounded-[28px] border border-black/10 bg-[#fafafa] p-6">
            <div className="space-y-2">
              <h2 className="text-2xl tracking-tight text-black font-display">「{query}」の検索結果はありません</h2>
              <p className="text-sm leading-relaxed text-[#474747] font-brand">
                別のキーワードをお試しください。人気商品もあわせてご覧いただけます。
              </p>
            </div>
            <div className="space-y-4">
              <h3 className="text-lg tracking-widest text-black font-display">POPULAR ITEMS</h3>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {results.popularItems.map((item) => (
                  <SearchResultCard key={`empty-${item.id}`} result={item} query="" />
                ))}
              </div>
            </div>
          </section>
        ) : activeTab === 'all' ? (
          <div className="space-y-10">
            <SearchSection title="ITEM" results={results?.items ?? []} query={query} />
            <SearchSection title="LOOK" results={results?.looks ?? []} query={query} />
            <SearchSection title="NEWS" results={results?.news ?? []} query={query} />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 border-b border-black/10 pb-3">
              <p className="text-lg tracking-widest text-black font-display">{activeTab.toUpperCase()}</p>
              <p className="text-xs tracking-widest text-black/50 font-brand">{activeResults.length} RESULTS</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {activeResults.map((result) => (
                <SearchResultCard key={`${result.type}-${result.id}`} result={result} query={query} />
              ))}
            </div>
          </div>
        )}

        {query ? (
          <div className="border-t border-black/10 pt-6">
            <Link href={`/?q=${encodeURIComponent(query)}`} className="text-sm tracking-widest text-black/60 transition-colors hover:text-black font-brand">
              VIEW PREVIEW ON HOME
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}