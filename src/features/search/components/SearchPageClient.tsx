"use client";

import Image from "next/image";
import Link from "next/link";
import React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  SearchResult,
  SearchResultsResponse,
  SearchSuggestion,
  SearchTab,
} from "@/features/search/types/search.types";

const SEARCH_TABS = [
  { key: "all", label: "ALL" },
  { key: "item", label: "ITEM" },
  { key: "look", label: "LOOK" },
  { key: "news", label: "NEWS" },
] as const;

/* FREQ-184: 結果リストの初期表示行数。超過分は LOAD MORE で段階表示する。 */
const RESULTS_PAGE_SIZE = 8;

/* FREQ-190: サジェストの最大表示件数（多すぎる選択肢は判断を遅らせるため）。 */
const SUGGESTION_LIMIT = 8;

/* FREQ-182 と同じ細線ストロークのインライン SVG 描画（アイコンフォント不使用）。 */
function StrokeIcon({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={`block ${className ?? ""}`}
      style={style}
    >
      {children}
    </svg>
  );
}

const ICON_MAGNIFIER = (
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.5 16.5 21 21" />
  </>
);
const ICON_ARROW_RIGHT = <path d="M4 12h16M14 6l6 6-6 6" />;
// FREQ-196: 並び順表示（RELEVANCE）をコメントアウト中のため未使用。復帰時に戻す。
// const ICON_CHEVRON_DOWN = <path d="m6 9 6 6 6-6" />;

function normalizeTab(tab: string | null): SearchTab {
  if (tab === "item" || tab === "look" || tab === "news") {
    return tab;
  }
  return "all";
}

function getResultTypeLabel(type: SearchResult["type"]): string {
  switch (type) {
    case "item":
      return "ITEM";
    case "look":
      return "LOOK";
    case "news":
      return "NEWS";
    default:
      return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedText(text: string, query: string): React.ReactNode {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${escapeRegExp(normalizedQuery)})`, "ig");
  const segments = text.split(pattern);

  return segments.map((segment, index) => {
    if (segment.toLowerCase() === normalizedQuery.toLowerCase()) {
      return (
        <mark
          key={`${segment}-${index}`}
          className="bg-black/10 px-0.5 text-black font-medium"
        >
          {segment}
        </mark>
      );
    }
    return (
      <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>
    );
  });
}

/* FREQ-184: ALL タブは種別ごとのセクションではなく、item / look / news を
   交互に混在させた1本のリストとして表示する。 */
function interleaveResults(results: SearchResultsResponse): SearchResult[] {
  const groups = [results.items, results.looks, results.news];
  const merged: SearchResult[] = [];
  const maxLength = Math.max(...groups.map((group) => group.length));

  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      const entry = group[index];
      if (entry) {
        merged.push(entry);
      }
    }
  }

  return merged;
}

/* FREQ-190: サジェストは一致箇所を黒・太字、それ以外を Graphite Grey で描き、
   どこが一致したのかを一目で分かるようにする（結果一覧のハイライトと対の表現）。 */
function renderSuggestionLabel(
  label: string,
  query: string,
): React.ReactNode {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return label;
  }

  const pattern = new RegExp(`(${escapeRegExp(normalizedQuery)})`, "ig");

  return label.split(pattern).map((segment, index) =>
    segment.toLowerCase() === normalizedQuery.toLowerCase() ? (
      <span key={`${segment}-${index}`} className="font-medium text-black">
        {segment}
      </span>
    ) : (
      <span key={`${segment}-${index}`} className="text-[#474747]">
        {segment}
      </span>
    ),
  );
}

function SearchResultRow({
  result,
  query,
}: {
  result: SearchResult;
  query: string;
}) {
  return (
    <li className="border-b border-black/10" data-testid="search-result-row">
      <Link
        href={result.href}
        className="group flex items-center gap-5 py-3 sm:gap-6 md:py-4"
      >
        <div className="relative aspect-[3/4] w-14 shrink-0 overflow-hidden bg-[#f5f5f5]">
          {result.imageUrl ? (
            <Image
              src={result.imageUrl}
              alt=""
              width={112}
              height={150}
              className="h-full w-full object-cover object-top"
            />
          ) : null}
        </div>
        {/* FREQ-199: モバイルは参考デザインに合わせ、各段を1段階小さくする。
            md 以上は従来のサイズを維持する。 */}
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--lk-size-3xs)] tracking-widest text-black/50 md:text-[length:var(--lk-size-2xs)]">
            {getResultTypeLabel(result.type)}
          </p>
          <p className="mt-1 truncate text-[length:var(--lk-size-sm)] text-black md:text-[length:var(--lk-size-md)]">
            {renderHighlightedText(result.title, query)}
          </p>
          <p className="mt-1 text-[length:var(--lk-size-2xs)] tracking-wide text-[#474747] md:text-[length:var(--lk-size-xs)]">
            {result.meta}
          </p>
        </div>
        <StrokeIcon
          className="shrink-0 text-black transition-transform duration-200 group-hover:translate-x-1"
          style={{ fontSize: "var(--lk-size-lg)" }}
        >
          {ICON_ARROW_RIGHT}
        </StrokeIcon>
      </Link>
    </li>
  );
}

function ResultListHeader({
  label,
}: {
  label: string;
  // FREQ-196: 並び順表示のコメントアウトに伴い未使用。復帰時に再び使う。
  showSort: boolean;
}) {
  // const x2sTextStyle = { fontSize: "var(--lk-size-2xs)" } as const;

  return (
    <div className="flex items-center justify-between gap-4 border-b border-black/10 pb-4">
      {/* FREQ-199: モバイルのみ1段階小さく */}
      <p className="text-[length:var(--lk-size-2xs)] tracking-widest text-black md:text-[length:var(--lk-size-xs)]">
        {label}
      </p>
      {/* FREQ-196: 並び順は RELEVANCE 固定で操作もできない飾りのため、いったん非表示。
          ソート機能を実装する際にこのブロックを復活させる。
      {showSort ? (
        <p
          className="flex items-center gap-1.5 tracking-widest text-black"
          style={x2sTextStyle}
        >
          <span>RELEVANCE</span>
          <StrokeIcon style={{ fontSize: "var(--lk-size-sm)" }}>
            {ICON_CHEVRON_DOWN}
          </StrokeIcon>
        </p>
      ) : null}
      */}
    </div>
  );
}

export function SearchPageClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const activeTab = normalizeTab(searchParams.get("tab"));

  const [inputValue, setInputValue] = React.useState(query);
  const [results, setResults] = React.useState<SearchResultsResponse | null>(
    null,
  );
  const [suggestions, setSuggestions] = React.useState<SearchSuggestion[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isInputFocused, setIsInputFocused] = React.useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = React.useState(-1);
  const [visibleCount, setVisibleCount] = React.useState(RESULTS_PAGE_SIZE);
  const searchBoxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setInputValue(query);
  }, [query]);

  React.useEffect(() => {
    setVisibleCount(RESULTS_PAGE_SIZE);
  }, [activeTab, query]);

  React.useEffect(() => {
    let cancelled = false;

    const fetchResults = async () => {
      // FREQ-186: 検索語が空でも POPULAR ITEMS を出すため、取得はスキップしない
      try {
        setIsLoading(true);
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&tab=${encodeURIComponent(activeTab)}`,
          {
            cache: "no-store",
          },
        );
        if (!response.ok) {
          throw new Error("検索結果の取得に失敗しました");
        }

        const payload = (await response.json()) as SearchResultsResponse;
        if (!cancelled) {
          setResults(payload);
          setErrorMessage(null);
        }
      } catch (error) {
        console.error("Failed to fetch search results:", error);
        if (!cancelled) {
          setResults(null);
          setErrorMessage("検索結果を読み込めませんでした");
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
        const response = await fetch(
          `/api/suggest?q=${encodeURIComponent(inputValue)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error("Failed to fetch suggestions");
        }

        const payload = (await response.json()) as {
          suggestions: SearchSuggestion[];
        };
        if (!cancelled) {
          setSuggestions(payload.suggestions ?? []);
        }
      } catch (error) {
        console.error("Failed to fetch search suggestions:", error);
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

  const commitSearch = React.useCallback(
    (nextQuery: string, nextTab: SearchTab = activeTab) => {
      const normalizedQuery = nextQuery.trim();
      const params = new URLSearchParams(searchParams.toString());

      if (normalizedQuery.length > 0) {
        params.set("q", normalizedQuery);
      } else {
        params.delete("q");
      }

      params.set("tab", nextTab);
      const nextUrl =
        params.toString().length > 0
          ? `${pathname}?${params.toString()}`
          : pathname;
      router.replace(nextUrl, { scroll: false });
    },
    [activeTab, pathname, router, searchParams],
  );

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitSearch(inputValue, activeTab);
    setIsInputFocused(false);
  };

  const handleTabChange = (tabKey: string) => {
    commitSearch(query, normalizeTab(tabKey));
  };

  /* FREQ-190: 候補数は Hick の法則に従い上限 8 件に抑える。 */
  const visibleSuggestions = React.useMemo(
    () => suggestions.slice(0, SUGGESTION_LIMIT),
    [suggestions],
  );

  const isSuggestionListOpen =
    isInputFocused &&
    inputValue.trim().length > 0 &&
    visibleSuggestions.length > 0;

  // 入力が変わったら選択位置をリセットする（別候補を選んだまま確定するのを防ぐ）
  React.useEffect(() => {
    setActiveSuggestionIndex(-1);
  }, [inputValue, isInputFocused]);

  // 外側クリックで閉じる。候補は searchBoxRef の内側にあるため選択操作は妨げない。
  React.useEffect(() => {
    if (!isSuggestionListOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        searchBoxRef.current &&
        !searchBoxRef.current.contains(event.target as Node)
      ) {
        setIsInputFocused(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isSuggestionListOpen]);

  const selectSuggestion = React.useCallback(
    (suggestion: SearchSuggestion) => {
      setInputValue(suggestion.label);
      commitSearch(suggestion.label, suggestion.type);
      setIsInputFocused(false);
      setActiveSuggestionIndex(-1);
    },
    [commitSearch],
  );

  /* FREQ-190: WAI-ARIA combobox パターンのキーボード操作。
     未選択（-1）のまま Enter を押した場合は form の submit に委ね、入力語で検索する。 */
  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsInputFocused(false);
      setActiveSuggestionIndex(-1);
      return;
    }

    if (!isSuggestionListOpen) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestionIndex(
        (index) => (index + 1) % visibleSuggestions.length,
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestionIndex((index) =>
        index <= 0 ? visibleSuggestions.length - 1 : index - 1,
      );
      return;
    }

    if (event.key === "Enter" && activeSuggestionIndex >= 0) {
      event.preventDefault();
      selectSuggestion(visibleSuggestions[activeSuggestionIndex]);
      return;
    }

    if (event.key === "Tab") {
      setIsInputFocused(false);
    }
  };

  const activeList = React.useMemo(() => {
    if (!results) {
      return [] as SearchResult[];
    }
    if (activeTab === "item") {
      return results.items;
    }
    if (activeTab === "look") {
      return results.looks;
    }
    if (activeTab === "news") {
      return results.news;
    }
    return interleaveResults(results);
  }, [activeTab, results]);

  const visibleResults = activeList.slice(0, visibleCount);
  const hasMoreResults = activeList.length > visibleCount;

  const x2sTextStyle = { fontSize: "var(--lk-size-2xs)" } as const;
  const smTextStyle = { fontSize: "var(--lk-size-sm)" } as const;
  const mdTextStyle = { fontSize: "var(--lk-size-md)" } as const;
  const xlTextStyle = { fontSize: "var(--lk-size-xl)" } as const;
  const x4lTextStyle = { fontSize: "var(--lk-size-8xl)" } as const;

  return (
    // FREQ-188: 検索画面をファーストビューいっぱいに表示する。
    // 差し引く値は main の上下マージン（52/54/56/58/60px）＋上下パディング（0/4/8/12px）。
    <div className="mx-auto flex min-h-[calc(100svh-6.5rem)] w-full max-w-7xl flex-col gap-8 py-2 sm:min-h-[calc(100svh-7.25rem)] sm:py-4 md:grid md:min-h-[calc(100svh-8rem)] md:grid-cols-[38.2fr_61.8fr] md:items-start md:gap-x-16 md:gap-y-10 md:py-10 lg:min-h-[calc(100svh-8.75rem)] xl:min-h-[calc(100svh-9rem)]">
      {/* 左カラム: 見出し・検索フィールド・種別フィルタ。
          FREQ-197: md（タブレット）以上でヘッダー下にビューポート高で sticky し、
          内容を縦中央に置く（PC と同じ見た目）。 */}
      <div className="flex flex-col gap-6 md:sticky md:top-14 md:min-h-[calc(100svh-3.5rem)] md:justify-center md:gap-10">
        {/* FREQ-198: モバイルでは見出しを表示しない。ただし h1 は文書構造として
            必要なため、削除ではなく視覚的にのみ隠す（スクリーンリーダーには残す）。 */}
        <h1 className="sr-only tracking-wider md:not-sr-only" style={x4lTextStyle}>
          SEARCH
        </h1>

        {/* FREQ-190: WAI-ARIA combobox パターン。候補はインラインではなく
            入力欄直下のドロップダウンとして重ね、下のフィルタを押し下げない。 */}
        <div ref={searchBoxRef} className="relative">
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 border-b border-black/50 transition-colors focus-within:border-black"
          >
            <input
              type="search"
              aria-label="Search"
              placeholder="Search items, news, looks..."
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onFocus={() => setIsInputFocused(true)}
              onKeyDown={handleInputKeyDown}
              autoComplete="off"
              role="combobox"
              aria-expanded={isSuggestionListOpen}
              aria-controls="search-suggestion-list"
              aria-autocomplete="list"
              aria-activedescendant={
                activeSuggestionIndex >= 0
                  ? `search-suggestion-${activeSuggestionIndex}`
                  : undefined
              }
              className="w-full min-w-0 appearance-none bg-transparent py-2 text-black outline-none placeholder:text-black/35 [&::-webkit-search-cancel-button]:appearance-none"
              style={mdTextStyle}
            />
            <button
              type="submit"
              aria-label="検索"
              className="-mr-2.5 flex h-10 w-10 shrink-0 items-center justify-center text-black transition-colors hover:text-[#474747]"
            >
              <StrokeIcon style={{ fontSize: "var(--lk-size-lg)" }}>
                {ICON_MAGNIFIER}
              </StrokeIcon>
            </button>
          </form>

          {isSuggestionListOpen ? (
            <ul
              id="search-suggestion-list"
              role="listbox"
              aria-label="検索候補"
              /* 背後のタブは左端が揃っているうえ、書体の「A」はグリフが
                 文字ボックスより 1px 左へ食み出す。left-0 のままだとその 1px が
                 候補リストの外に覗くため、左右を 1px ずつ外へ広げて覆う。 */
              className="absolute left-[-1px] right-[-1px] top-full z-20 border border-black/10 bg-white py-1 shadow-[0_10px_30px_rgba(0,0,0,0.08)]"
            >
              {visibleSuggestions.map((suggestion, index) => (
                <li key={`${suggestion.type}-${suggestion.label}`}>
                  <button
                    id={`search-suggestion-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestionIndex}
                    onClick={() => selectSuggestion(suggestion)}
                    onMouseEnter={() => setActiveSuggestionIndex(index)}
                    /* 選択状態は面の濃淡だけだとコントラストが足りないため、
                       黒の縦線を併用する（枠は常時確保しレイアウトをずらさない）。 */
                    className={`flex min-h-[40px] w-full items-center justify-between gap-4 border-l-2 pl-4 pr-4 text-left transition-colors ${
                      index === activeSuggestionIndex
                        ? "border-black bg-black/[0.04]"
                        : "border-transparent"
                    }`}
                    style={smTextStyle}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {renderSuggestionLabel(suggestion.label, inputValue)}
                    </span>
                    <span
                      className="shrink-0 tracking-widest text-black/40"
                      style={x2sTextStyle}
                    >
                      {getResultTypeLabel(suggestion.type)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {/* 候補件数をスクリーンリーダーに通知する */}
          <p role="status" aria-live="polite" className="sr-only">
            {isSuggestionListOpen
              ? `${visibleSuggestions.length} 件の検索候補があります`
              : ""}
          </p>
        </div>

        <div
          role="tablist"
          aria-label="検索カテゴリ"
          /* FREQ-199: モバイルは 4 タブを全幅に均等配置（参考デザイン）。
             md 以上は従来どおり左寄せの縦並び。 */
          className="flex flex-wrap justify-between gap-x-6 gap-y-2 px-4 md:flex-col md:items-start md:justify-start md:gap-y-2 md:px-0"
        >
          {SEARCH_TABS.map((tab) => {
            const isActive = tab.key === activeTab;
            return (
              /* FREQ-192: 選択・ホバーの下線はヘッダーナビと同じ
                 underline-animation-left2right（左から伸びる 1px・300ms）を再利用する。 */
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabChange(tab.key)}
                className="group py-1.5"
                style={mdTextStyle}
              >
                <span
                  className={`relative inline-block pb-0.5 tracking-[0.1em] transition-colors ${
                    isActive
                      ? "text-black"
                      : "text-[#474747] group-hover:text-black"
                  }`}
                >
                  {tab.label}
                  {/* letter-spacing は最後の文字の右にも余白を作るため、
                      w-full のままだと下線がその分だけ右へはみ出す。
                      tracking と同じ 0.1em を幅から差し引いて文字の真下に揃える。 */}
                  <span
                    className={`underline-animation-left2right w-[calc(100%-0.1em)] ${
                      isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                    }`}
                  />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右カラム: 結果リスト */}
      <div className="min-w-0">
        {errorMessage ? (
          <p role="alert" className="mb-6 text-red-600" style={mdTextStyle}>
            {errorMessage}
          </p>
        ) : null}

        {!query ? (
          <section>
            <ResultListHeader label="POPULAR ITEMS" showSort={false} />
            {(results?.popularItems ?? []).length > 0 ? (
              <ul>
                {(results?.popularItems ?? []).map((item) => (
                  <SearchResultRow
                    key={`popular-${item.id}`}
                    result={item}
                    query=""
                  />
                ))}
              </ul>
            ) : isLoading ? null : (
              <p
                className="pt-4 leading-relaxed text-[#474747]"
                style={mdTextStyle}
              >
                気になる商品名やトピックを入力すると、商品・ルック・ニュースを横断した結果を表示します。
              </p>
            )}
          </section>
        ) : isLoading ? (
          <div aria-hidden="true">
            <div className="border-b border-black/10 pb-4">
              <div className="h-3 w-20 animate-pulse bg-black/8" />
            </div>
            <ul>
              {Array.from({ length: 5 }).map((_, index) => (
                <li
                  key={index}
                  className="flex items-center gap-5 border-b border-black/10 py-4 sm:gap-6"
                >
                  <div className="aspect-[3/4] w-14 shrink-0 animate-pulse bg-black/8" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-2.5 w-10 animate-pulse bg-black/8" />
                    <div className="h-3.5 w-2/5 animate-pulse bg-black/8" />
                    <div className="h-2.5 w-16 animate-pulse bg-black/5" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : results?.empty ? (
          <div className="flex flex-col gap-10">
            <div className="space-y-2">
              <h2 className="tracking-tight text-black" style={xlTextStyle}>
                「{query}」の検索結果はありません
              </h2>
              <p className="leading-relaxed text-[#474747]" style={mdTextStyle}>
                別のキーワードをお試しください。人気商品もあわせてご覧いただけます。
              </p>
            </div>
            <section>
              <div className="border-b border-black/10 pb-4">
                <h3 className="text-[length:var(--lk-size-2xs)] tracking-widest text-black md:text-[length:var(--lk-size-xs)]">
                  POPULAR ITEMS
                </h3>
              </div>
              <ul>
                {results.popularItems.map((item) => (
                  <SearchResultRow
                    key={`empty-${item.id}`}
                    result={item}
                    query=""
                  />
                ))}
              </ul>
            </section>
          </div>
        ) : (
          <section>
            <ResultListHeader label={`${activeList.length} RESULTS`} showSort />
            <ul>
              {visibleResults.map((result) => (
                <SearchResultRow
                  key={`${result.type}-${result.id}`}
                  result={result}
                  query={query}
                />
              ))}
            </ul>
            {hasMoreResults ? (
              <div className="flex justify-center pt-10">
                <button
                  type="button"
                  onClick={() =>
                    setVisibleCount((count) => count + RESULTS_PAGE_SIZE)
                  }
                  className="border-b border-black pb-1 text-[length:var(--lk-size-2xs)] tracking-[0.2em] text-black transition-colors hover:border-[#474747] hover:text-[#474747] md:text-[length:var(--lk-size-xs)]"
                >
                  LOAD MORE
                </button>
              </div>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}
