"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TagLabel } from "@/components/ui/TagLabel/TagLabel";
import { Button } from "@/components/ui/Button/Button";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { HomeSectionHeader } from "@/features/home/components/HomeSectionHeader";
import { HomeSectionViewAll } from "@/features/home/components/HomeSectionViewAll";
import { MultiSelect } from "@/components/ui/MultiSelect/MultiSelect";
import { categories } from "@/lib/news-data";
import { cn } from "@/lib/utils";
import { PublicNewsArticle } from "@/features/news/types";
import type { ComponentSize } from "@/components/ui/types";

const NEWS_CATEGORIES = categories;
const TAB_SCROLL_CONTAINER_CLASS =
  "w-full overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
type NewsCategory = (typeof NEWS_CATEGORIES)[number];

type PublicNewsGridHomeProps = {
  variant: "home";
  articles?: PublicNewsArticle[];
  /** 未指定時は 6 */
  fetchLimit?: number;
  /** FREQ-149: 公開 NEWS の総数。表示数（6 件）より多い場合のみ VIEW ALL を表示する */
  totalCount?: number;
  className?: string;
};

type PublicNewsGridCatalogProps = {
  variant: "catalog";
  articles?: PublicNewsArticle[];
  initialCategory?: NewsCategory;
  className?: string;
  buildHref?: (article: PublicNewsArticle) => string;
};

type PublicNewsGridProps = PublicNewsGridHomeProps | PublicNewsGridCatalogProps;

function parseCategorySelection(
  categoryParam: string | null,
  fallback: NewsCategory = "ALL",
): NewsCategory[] {
  if (!categoryParam || categoryParam.trim().length === 0) {
    return [fallback];
  }

  const parsed = categoryParam
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is NewsCategory =>
      NEWS_CATEGORIES.includes(value as NewsCategory),
    );

  if (parsed.length === 0) {
    return ["ALL"];
  }

  if (parsed.includes("ALL")) {
    return ["ALL"];
  }

  return [...new Set(parsed)];
}

function isSameSelection(left: NewsCategory[], right: NewsCategory[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

// N-6: プレビュー用に軽量 Markdown 記法を除去（見出し記号/強調/コード/引用/リンク等）
function toPlainPreview(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 画像
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // リンク → テキスト
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // インライン/ブロックコード
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // 見出し
    .replace(/^\s{0,3}>\s?/gm, "") // 引用
    .replace(/^\s{0,3}[-*+]\s+/gm, "") // 箇条書き
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // 太字
    .replace(/(\*|_)(.*?)\1/g, "$2") // 斜体
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function PublicNewsGrid(props: PublicNewsGridProps) {
  const { variant, className } = props;
  const catalogProps = props.variant === "catalog" ? props : null;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const categoryQuery = searchParams.get("category");
  const [fetchedArticles, setFetchedArticles] = useState<PublicNewsArticle[]>(
    [],
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState<boolean>(false);
  const [selectedCategories, setSelectedCategories] = useState<NewsCategory[]>(
    () => {
      if (catalogProps) {
        return parseCategorySelection(
          categoryQuery,
          catalogProps.initialCategory ?? "ALL",
        );
      }
      return ["ALL"];
    },
  );

  const syncCategoryQuery = (nextSelection: NewsCategory[]): void => {
    if (variant !== "catalog") {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    const normalizedSelection = nextSelection.filter(
      (value) => value !== "ALL",
    );
    if (normalizedSelection.length > 0) {
      params.set("category", normalizedSelection.join(","));
    } else {
      params.delete("category");
    }

    const query = params.toString();
    const nextUrl = query.length > 0 ? `${pathname}?${query}` : pathname;
    router.push(nextUrl, { scroll: false });
  };

  useEffect(() => {
    if (!catalogProps) {
      return;
    }

    const nextSelection = parseCategorySelection(
      categoryQuery,
      catalogProps.initialCategory ?? "ALL",
    );

    setSelectedCategories((current) =>
      isSameSelection(current, nextSelection) ? current : nextSelection,
    );
  }, [catalogProps, categoryQuery]);

  const shouldFetch = typeof props.articles === "undefined";
  const fetchLimit = variant === "home" ? (props.fetchLimit ?? 6) : undefined;
  // Over-fetch by 1 to detect whether more articles exist beyond fetchLimit
  const overFetchLimit =
    typeof fetchLimit === "number" ? fetchLimit + 1 : undefined;

  useEffect(() => {
    if (!shouldFetch) {
      return;
    }

    const query = new URLSearchParams();
    if (typeof overFetchLimit === "number") {
      query.set("limit", String(overFetchLimit));
    }

    const url = query.toString()
      ? `/api/news?${query.toString()}`
      : "/api/news";

    const fetchNews = async () => {
      try {
        setLoading(true);
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to fetch news");
        }
        const data = (await response.json()) as PublicNewsArticle[];
        setFetchedArticles(data);
        setError(null);
      } catch (fetchError) {
        console.error("Failed to fetch public news:", fetchError);
        setFetchedArticles([]);
        setError("ニュースデータの取得に失敗しました");
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
  }, [shouldFetch, overFetchLimit]);

  const sourceArticles = useMemo(
    () =>
      typeof props.articles === "undefined" ? fetchedArticles : props.articles,
    [fetchedArticles, props.articles],
  );

  const resolvedArticles = useMemo(
    () => sourceArticles.slice(0, fetchLimit ?? sourceArticles.length),
    [sourceArticles, fetchLimit],
  );

  const displayArticles = useMemo(() => {
    if (variant !== "catalog" || selectedCategories.includes("ALL")) {
      return resolvedArticles;
    }
    return resolvedArticles.filter((article) =>
      selectedCategories.includes(article.category as NewsCategory),
    );
  }, [resolvedArticles, selectedCategories, variant]);

  const resolveBuildHref = (article: PublicNewsArticle): string => {
    if (catalogProps) {
      if (catalogProps.buildHref) return catalogProps.buildHref(article);
      const normalizedSelection = selectedCategories.filter(
        (value) => value !== "ALL",
      );
      if (normalizedSelection.length > 0) {
        return `/news/${article.id}?category=${encodeURIComponent(normalizedSelection.join(","))}`;
      }
      return `/news/${article.id}`;
    }
    return `/news/${article.id}`;
  };

  const applyCategorySelection = (newValues: string[]): void => {
    const typedValues = newValues as NewsCategory[];
    let nextSelection: NewsCategory[];
    if (typedValues.length === 0) {
      // 全解除 → ALL に戻す
      nextSelection = ["ALL"];
      setSelectedCategories(nextSelection);
      syncCategoryQuery(nextSelection);
      return;
    }

    const hadAll = selectedCategories.includes("ALL");
    const hasAll = typedValues.includes("ALL");
    if (!hadAll && hasAll) {
      // ALL が追加された → ALL のみにリセット
      nextSelection = ["ALL"];
      setSelectedCategories(nextSelection);
      syncCategoryQuery(nextSelection);
      return;
    }

    if (hadAll && typedValues.length > 1) {
      // ALL 選択中に他が追加された → ALL を外して他のみに
      nextSelection = typedValues.filter((v) => v !== "ALL") as NewsCategory[];
      setSelectedCategories(nextSelection);
      syncCategoryQuery(nextSelection);
      return;
    }

    nextSelection = typedValues;
    setSelectedCategories(nextSelection);
    syncCategoryQuery(nextSelection);
  };

  // ITEM 一覧の Accordion 内 MultiSelect の子要素（選択肢）と同一の見た目・間隔に揃える。
  // .filter-sections（globals.css）で選択肢同士の間隔（option-list gap 0.5em）を ITEM と
  // 共通化し、MultiSelect 自体のプロパティ（panel / fill / square / space-y-2）も一致させる。
  const renderCategoryFilter = (
    size: ComponentSize = "3xs",
    expandHitArea = false,
  ) => (
    <div className="filter-sections">
      <MultiSelect
        variant="panel"
        options={NEWS_CATEGORIES.map((c) => ({ value: c, label: c }))}
        values={selectedCategories}
        onChange={applyCategorySelection}
        shape="square"
        checkStyle="fill"
        size={size}
        className="space-y-2"
        expandLabelHitArea={expandHitArea}
      />
    </div>
  );

  const mobileFilterStickyStyle = {
    top: "var(--site-header-height)",
    transform:
      "translateY(calc(var(--site-header-offset) - var(--site-header-height)))",
  } as const;

  const desktopFilterStickyStyle = {
    top: "var(--site-header-offset)",
  } as const;

  const renderMobileFilterBar = (interactive: boolean) => (
    <div
      data-filter-bar={interactive ? "floating" : "placeholder"}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        "flex items-center justify-between border-b border-black/5 bg-white/95 py-[13px] backdrop-blur",
        !interactive && "pointer-events-none invisible",
      )}
    >
      <Button
        data-filter-button={interactive ? "floating" : "placeholder"}
        onClick={interactive ? () => setIsFilterDrawerOpen(true) : undefined}
        variant="text"
        size="3xs"
        className="tracking-[0.06em]"
        style={{ marginLeft: "calc(-1 * var(--pad-x) - 1px)" }}
        aria-haspopup={interactive ? "dialog" : undefined}
        aria-expanded={interactive ? isFilterDrawerOpen : undefined}
        tabIndex={interactive ? undefined : -1}
      >
        FILTER
      </Button>
    </div>
  );

  // N-2: 見出し階層。catalog は ページ h1 → 記事 h2、home は セクション h2 → 記事 h3
  const ArticleTitleTag = (variant === "home" ? "h3" : "h2") as "h2" | "h3";

  const renderGrid = () => (
    <div className={cn("w-full border-t border-black/10", className)}>
      {displayArticles.map((article) => {
        return (
          <Link
            key={article.id}
            href={resolveBuildHref(article)}
            className="block"
          >
            <article className="relative py-[21px] md:py-[34px] lg:px-[13px] border-b border-black/5 cursor-pointer group">
              {/* N-7: 控えめな上下ラインのみ（delay付き4辺アニメ→簡素化、duration短縮） */}
              {/* Top: left → right */}
              <span aria-hidden="true" className="pointer-events-none absolute top-0 left-0 h-px w-0 bg-black transition-[width] duration-300 ease-out group-hover:w-full" />
              {/* Bottom: right → left */}
              <span aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-px w-0 bg-black transition-[width] duration-300 ease-out group-hover:w-full" />
              <div className="flex items-start">
                <div className="flex-1 min-w-0">
                  {/* Date column: inline with category on mobile, fixed-width on sm+ */}
                  <div className="flex items-center gap-3 mb-[var(--lk-size-4xs)] flex-shrink-0">
                    <time
                      dateTime={article.published_date}
                      className="flex-shrink-0 text-[#474747] tracking-widest whitespace-nowrap"
                      style={{
                        fontFamily: "acumin-pro, sans-serif",
                        fontSize: "var(--lk-size-4xs)",
                      }}
                    >
                      {article.published_date.replace(/-/g, ".")}
                    </time>
                    {/* Category tag */}
                    <div className="flex items-center">
                      <TagLabel className="font-acumin" size="6xs">
                        {article.category}
                      </TagLabel>
                    </div>
                  </div>

                  {/* Content column */}
                  <ArticleTitleTag
                    className="mb-[calc(var(--lk-size-sm)/var(--phi))] leading-snug"
                    style={{ fontSize: "var(--lk-size-sm)" }}
                  >
                    {article.title}
                  </ArticleTitleTag>

                  <p
                    className="leading-[1.8] line-clamp-2 sm:line-clamp-3 text-[#474747]"
                    style={{
                      fontFamily: "acumin-pro, sans-serif",
                      fontSize: "var(--lk-size-2xs)",
                    }}
                  >
                    {toPlainPreview(article.content)}
                  </p>
                </div>
              </div>
            </article>
          </Link>
        );
      })}
    </div>
  );

  const renderEmpty = (message: string) => (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <p
        className="text-[#474747] tracking-widest"
        style={{ fontFamily: "acumin-pro, sans-serif", fontSize: "var(--lk-size-sm)" }}
      >
        {message}
      </p>
    </div>
  );

  const renderError = () => (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <p
        className="text-red-500 tracking-widest"
        style={{ fontFamily: "acumin-pro, sans-serif", fontSize: "var(--lk-size-sm)" }}
      >
        {error}
      </p>
    </div>
  );

  const renderLoading = () => (
    <div className="w-full border-t border-black/10">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="py-[21px] md:py-[34px] border-b border-black/5 animate-pulse">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-[10px] w-20 rounded-sm bg-black/8" />
            <div className="h-[10px] w-14 rounded-sm bg-black/8" />
          </div>
          <div className="h-[13px] w-2/3 rounded-sm bg-black/8 mb-[10px]" />
          <div className="h-[11px] w-full rounded-sm bg-black/5 mb-1.5" />
          <div className="h-[11px] w-4/5 rounded-sm bg-black/5" />
        </div>
      ))}
    </div>
  );

  // home variant rendering
  if (variant === "home") {
    // FREQ-149: 表示数（6 件）より公開 NEWS の総数が多い場合のみ VIEW ALL を表示する
    const viewAllVisibilityClass =
      typeof props.totalCount === "number"
        ? props.totalCount > (fetchLimit ?? 6)
          ? "flex"
          : "hidden"
        : undefined;

    return (
      <section id="news" className="section-space">
        <div className="element-width">
          <HomeSectionHeader title="NEWS" />

          {loading ? (
            renderLoading()
          ) : error ? (
            renderError()
          ) : resolvedArticles.length === 0 ? (
            renderEmpty("現在、公開されている記事はありません")
          ) : (
            renderGrid()
          )}

          <HomeSectionViewAll
            href="/news"
            ariaLabel="VIEW ALL NEWS"
            className={viewAllVisibilityClass}
          />
        </div>
      </section>
    );
  }

  // catalog variant rendering
  return (
    <>
      <Drawer
        open={isFilterDrawerOpen}
        onClose={() => setIsFilterDrawerOpen(false)}
        side="left"
        size="md"
        className="[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <div
          className="flex flex-col h-full"
          style={{
            paddingInline: "calc(var(--lk-size-sm) * var(--phi))",
            paddingTop: "calc(var(--lk-size-sm) * var(--sqrt-phi))",
          }}
        >
          <div className="flex justify-end pb-[13px]">
            <Button
              variant="text"
              size="xs"
              onClick={() => setIsFilterDrawerOpen(false)}
              aria-label="Close filter drawer"
            >
              <i className="ri-close-line" aria-hidden="true" />
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pb-[21px]">
            {renderCategoryFilter("xs", true)}
          </div>
        </div>
      </Drawer>

      <div className="flex w-full">
        {/* Category filter */}
        <aside
          className="hidden lg:block w-[233px] xl:w-[288px] flex-shrink-0 sticky h-[calc(100vh-var(--site-header-offset))] overflow-visible transition-[top,height] duration-300 ease-in-out"
          style={desktopFilterStickyStyle}
        >
          <div
            className="h-full overflow-y-auto border-r border-black/5 px-[13px] xl:px-[21px]"
            style={{
              paddingBlock: "calc(var(--lk-size-sm) * var(--phi) * var(--phi)) calc(var(--lk-size-xs) * var(--phi))",
            }}
          >
            <div className={TAB_SCROLL_CONTAINER_CLASS}>
              {renderCategoryFilter("3xs")}
            </div>
          </div>
        </aside>
        <div
          data-testid="news-content-column"
          className="flex-1 min-w-0 w-full max-w-full px-0 md:px-[21px] lg:pl-[34px] lg:pr-[16px] xl:pl-[55px] xl:pr-[21px] 2xl:pl-[89px] 2xl:pr-[34px] py-0 xl:pb-[34px]"
        >
          <div className="sm:-mt-1 md:-mt-2 lg:hidden">
            {renderMobileFilterBar(false)}
          </div>
          <div
            className="fixed inset-x-0 z-30 lg:hidden transition-transform duration-300 ease-in-out bg-white"
            style={mobileFilterStickyStyle}
          >
            <div className="element-width px-6 md:px-[45px]">
              {renderMobileFilterBar(true)}
            </div>
          </div>
          {loading
            ? renderLoading()
            : error
              ? renderError()
              : resolvedArticles.length === 0
                ? renderEmpty("現在、公開されている記事はありません")
                : displayArticles.length === 0
                  ? renderEmpty("該当カテゴリの記事はありません")
                  : renderGrid()}
        </div>
      </div>
    </>
  );
}
