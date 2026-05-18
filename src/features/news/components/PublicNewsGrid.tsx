"use client";

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { Button } from '@/components/ui/Button/Button';
import { Drawer } from '@/components/ui/Drawer/Drawer';
import { SectionTitle } from '@/components/ui/SectionTitle/SectionTitle';
import { MultiSelect } from '@/components/ui/MultiSelect/MultiSelect';
import { categories } from '@/lib/news-data';
import { cn } from '@/lib/utils';
import { PublicNewsArticle } from '@/features/news/types';

const NEWS_CATEGORIES = categories;
const TAB_SCROLL_CONTAINER_CLASS =
  'w-full overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';
type NewsCategory = (typeof NEWS_CATEGORIES)[number];

type PublicNewsGridHomeProps = {
  variant: 'home';
  articles?: PublicNewsArticle[];
  /** 未指定時は 6 */
  fetchLimit?: number;
  className?: string;
};

type PublicNewsGridCatalogProps = {
  variant: 'catalog';
  articles?: PublicNewsArticle[];
  initialCategory?: NewsCategory;
  className?: string;
  buildHref?: (article: PublicNewsArticle) => string;
};

type PublicNewsGridProps = PublicNewsGridHomeProps | PublicNewsGridCatalogProps;

function parseCategorySelection(
  categoryParam: string | null,
  fallback: NewsCategory = 'ALL',
): NewsCategory[] {
  if (!categoryParam || categoryParam.trim().length === 0) {
    return [fallback];
  }

  const parsed = categoryParam
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is NewsCategory => NEWS_CATEGORIES.includes(value as NewsCategory));

  if (parsed.length === 0) {
    return ['ALL'];
  }

  if (parsed.includes('ALL')) {
    return ['ALL'];
  }

  return [...new Set(parsed)];
}

function isSameSelection(left: NewsCategory[], right: NewsCategory[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export function PublicNewsGrid(props: PublicNewsGridProps) {
  const { variant, className } = props;
  const catalogProps = props.variant === 'catalog' ? props : null;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const categoryQuery = searchParams.get('category');
  const [fetchedArticles, setFetchedArticles] = useState<PublicNewsArticle[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState<boolean>(false);
  const [selectedCategories, setSelectedCategories] = useState<NewsCategory[]>(() => {
    if (catalogProps) {
      return parseCategorySelection(categoryQuery, catalogProps.initialCategory ?? 'ALL');
    }
    return ['ALL'];
  });

  const syncCategoryQuery = (nextSelection: NewsCategory[]): void => {
    if (variant !== 'catalog') {
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    const normalizedSelection = nextSelection.filter((value) => value !== 'ALL');
    if (normalizedSelection.length > 0) {
      params.set('category', normalizedSelection.join(','));
    } else {
      params.delete('category');
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
      catalogProps.initialCategory ?? 'ALL',
    );

    setSelectedCategories((current) =>
      isSameSelection(current, nextSelection) ? current : nextSelection,
    );
  }, [catalogProps, categoryQuery]);

  const shouldFetch = typeof props.articles === 'undefined';
  const fetchLimit = variant === 'home' ? (props.fetchLimit ?? 6) : undefined;
  // Over-fetch by 1 to detect whether more articles exist beyond fetchLimit
  const overFetchLimit = typeof fetchLimit === 'number' ? fetchLimit + 1 : undefined;

  useEffect(() => {
    if (!shouldFetch) {
      return;
    }

    const query = new URLSearchParams();
    if (typeof overFetchLimit === 'number') {
      query.set('limit', String(overFetchLimit));
    }

    const url = query.toString() ? `/api/news?${query.toString()}` : '/api/news';

    const fetchNews = async () => {
      try {
        setLoading(true);
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to fetch news');
        }
        const data = (await response.json()) as PublicNewsArticle[];
        setFetchedArticles(data);
        setError(null);
      } catch (fetchError) {
        console.error('Failed to fetch public news:', fetchError);
        setFetchedArticles([]);
        setError('ニュースデータの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
  }, [shouldFetch, overFetchLimit]);

  const sourceArticles = useMemo(
    () => (typeof props.articles === 'undefined' ? fetchedArticles : props.articles),
    [fetchedArticles, props.articles],
  );

  const hasMoreArticles = typeof fetchLimit === 'number' && sourceArticles.length > fetchLimit;

  const resolvedArticles = useMemo(
    () => sourceArticles.slice(0, fetchLimit ?? sourceArticles.length),
    [sourceArticles, fetchLimit],
  );

  const displayArticles = useMemo(() => {
    if (variant !== 'catalog' || selectedCategories.includes('ALL')) {
      return resolvedArticles;
    }
    return resolvedArticles.filter((article) =>
      selectedCategories.includes(article.category as NewsCategory),
    );
  }, [resolvedArticles, selectedCategories, variant]);

  const resolveBuildHref = (article: PublicNewsArticle): string => {
    if (catalogProps) {
      if (catalogProps.buildHref) return catalogProps.buildHref(article);
      const normalizedSelection = selectedCategories.filter((value) => value !== 'ALL');
      if (normalizedSelection.length > 0) {
        return `/news/${article.id}?category=${encodeURIComponent(normalizedSelection.join(','))}`;
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
      nextSelection = ['ALL'];
      setSelectedCategories(nextSelection);
      syncCategoryQuery(nextSelection);
      return;
    }

    const hadAll = selectedCategories.includes('ALL');
    const hasAll = typedValues.includes('ALL');
    if (!hadAll && hasAll) {
      // ALL が追加された → ALL のみにリセット
      nextSelection = ['ALL'];
      setSelectedCategories(nextSelection);
      syncCategoryQuery(nextSelection);
      return;
    }

    if (hadAll && typedValues.length > 1) {
      // ALL 選択中に他が追加された → ALL を外して他のみに
      nextSelection = typedValues.filter((v) => v !== 'ALL') as NewsCategory[];
      setSelectedCategories(nextSelection);
      syncCategoryQuery(nextSelection);
      return;
    }

    nextSelection = typedValues;
    setSelectedCategories(nextSelection);
    syncCategoryQuery(nextSelection);
  };

  const renderCategoryFilter = () => (
    <MultiSelect
      variant="panel"
      options={NEWS_CATEGORIES.map((c) => ({ value: c, label: c }))}
      values={selectedCategories}
      onChange={applyCategorySelection}
      shape="square"
      checkStyle="fill"
      size="xs"
      className="tracking-widest"
      expandLabelHitArea={false}
    />
  );

  const mobileFilterStickyStyle = {
    top: 'var(--site-header-height)',
    transform: 'translateY(calc(var(--site-header-offset) - var(--site-header-height)))',
  } as const;

  const desktopFilterStickyStyle = {
    top: 'var(--site-header-offset)',
  } as const;

  const renderMobileFilterBar = (interactive: boolean) => (
    <div
      data-filter-bar={interactive ? 'floating' : 'placeholder'}
      aria-hidden={interactive ? undefined : true}
      className={cn(
        'flex items-center justify-between border-b border-black/5 bg-white/95 py-[13px] backdrop-blur',
        !interactive && 'pointer-events-none invisible',
      )}
    >
      <Button
        data-filter-button={interactive ? 'floating' : 'placeholder'}
        onClick={interactive ? () => setIsFilterDrawerOpen(true) : undefined}
        variant="secondary"
        size="xs"
        className="min-h-0 gap-2 px-[8px] sm:px-[13px] py-[3px] sm:py-[5px] text-[9px] sm:text-[10px] tracking-[0.15em] uppercase"
        style={{ fontFamily: 'acumin-pro, sans-serif' }}
        aria-haspopup={interactive ? 'dialog' : undefined}
        aria-expanded={interactive ? isFilterDrawerOpen : undefined}
        tabIndex={interactive ? undefined : -1}
      >
        <div className="w-4 h-4 flex items-center justify-center" aria-hidden="true">
          <i className="ri-equalizer-line text-base" />
        </div>
        FILTER
      </Button>
    </div>
  );

  // Mobile: show only 3 articles on home variant (hidden lg:block hides them below lg breakpoint)
  const resolvedMobileLimit = variant === 'home' ? 3 : undefined;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === 'number';
  const hasHiddenItemsOnMobile = shouldLimitOnMobile && resolvedArticles.length > resolvedMobileLimit;

  const renderGrid = () => (
    <div className={cn('w-full border-t border-black/10', className)}>
      {displayArticles.map((article, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit!;

        return (
          <Link
            key={article.id}
            href={resolveBuildHref(article)}
            className={hideOnMobile ? 'hidden md:block' : 'block'}
          >
            <article className="py-[13px] sm:py-[13px] md:py-[21px] xl:py-[21px] border-b border-black/5 group cursor-pointer">
              <div className="sm:flex sm:items-start">
                {/* Date column: inline with category on mobile, fixed-width on sm+ */}
                <div className="flex items-center gap-3 mb-2 sm:mb-0 sm:w-28 xl:w-36 sm:flex-shrink-0 sm:pt-0.5">
                  <span
                    className="text-[9px] sm:text-[10px] md:text-[11px] lg:text-[12px] flex-shrink-0 text-[#474747] tracking-widest whitespace-nowrap"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                  >
                    {article.published_date.replace(/-/g, '.')}
                  </span>
                  {/* Category tag: mobile only */}
                  <div className="sm:hidden">
                    <TagLabel className="font-acumin" size="xs">
                      {article.category}
                    </TagLabel>
                  </div>
                </div>

                {/* Content column */}
                <div className="flex-1 min-w-0">
                  {/* Category tag: sm+ only */}
                  <div className="hidden sm:block mb-2 xl:mb-2.5">
                    <TagLabel className="font-acumin" size="sm">
                      {article.category}
                    </TagLabel>
                  </div>

                  <h4
                    className="text-[13px] sm:text-[14px] md:text-[15px] lg:text-[16px]  mb-[5px] sm:mb-[8px] group-hover:text-black/50 transition-colors duration-300 leading-snug"
                  >
                    {article.title}
                  </h4>

                  <p
                    className="text-[10px] sm:text-[11px] md:text-[12px] lg:text-[13px] leading-[1.8] line-clamp-2 sm:line-clamp-3 text-[#474747]"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                  >
                    {article.content}
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
    <div className="text-center py-20">
      <p className="text-lg text-[#474747]">
        {message}
      </p>
    </div>
  );

  const renderError = () => (
    <div className="text-center py-20">
      <p className="text-lg text-red-500">
        {error}
      </p>
    </div>
  );

  const renderLoading = () => (
    <div className="text-center py-20">
      <p className="text-lg text-[#474747]">
        読み込み中...
      </p>
    </div>
  );

  // home variant rendering
  if (variant === 'home') {
    return (
      <section id="news" className="section-space">
        <div className="element-width">
          <SectionTitle title="NEWS" />

          {loading ? (
            renderLoading()
          ) : error ? (
            renderError()
          ) : resolvedArticles.length === 0 ? (
            renderEmpty('現在、公開されている記事はありません')
          ) : (
            <>
              {renderGrid()}
              {(hasHiddenItemsOnMobile || hasMoreArticles) && (
                <div className="text-center mt-6 md:mt-8 lg:mt-12">
                  <Button href="/news" variant="secondary" size="xs">
                    VIEW ALL NEWS
                  </Button>
                </div>
              )}
            </>
          )}
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
        size="sm"
        className="max-w-[280px] sm:max-w-sm"
      >
        <div className="flex h-full flex-col px-5 py-4 sm:px-6 sm:py-5">
          <div className="flex items-center justify-between border-b border-black/10 pb-3">
            <h2 className="text-[11px] tracking-[0.15em] text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              FILTER
            </h2>
            <button
              type="button"
              onClick={() => setIsFilterDrawerOpen(false)}
              aria-label="Close filter drawer"
              className="text-xl leading-none text-black"
            >
              ×
            </button>
          </div>

          <div className="pt-4">
            {renderCategoryFilter()}
          </div>
        </div>
      </Drawer>

      <div className="flex w-full">
        {/* Category filter */}
        <aside
          className="hidden lg:block w-[199px] xl:w-[233px] flex-shrink-0 sticky h-[calc(100vh-var(--site-header-offset))] overflow-visible transition-[top,height] duration-300 ease-in-out"
          style={desktopFilterStickyStyle}
        >
          <div
            className="h-full overflow-y-auto border-r border-black/5 px-[13px] xl:px-[21px] py-[21px] xl:py-[34px]"
          >
            <div className={TAB_SCROLL_CONTAINER_CLASS}>
              <div className="flex justify-center min-w-max w-full">
                {renderCategoryFilter()}
              </div>
            </div>
          </div>
        </aside>
        <div className="flex-1 min-w-0 w-full max-w-full px-0 md:px-[21px] lg:px-[21px] xl:px-[34px] 2xl:px-[55px] py-0 xl:py-[34px]">
          <div className="sm:-mt-1 md:-mt-2 lg:hidden">
            {renderMobileFilterBar(false)}
          </div>
          <div className="fixed inset-x-0 z-30 lg:hidden transition-transform duration-300 ease-in-out" style={mobileFilterStickyStyle}>
            <div className="element-width px-6 md:px-[45px]">
              {renderMobileFilterBar(true)}
            </div>
          </div>
          {loading ? (
            renderLoading()
          ) : error ? (
            renderError()
          ) : resolvedArticles.length === 0 ? (
            renderEmpty('現在、公開されている記事はありません')
          ) : displayArticles.length === 0 ? (
            renderEmpty('該当カテゴリの記事はありません')
          ) : (
            renderGrid()
          )}
        </div>
      </div>
    </>
  );
}
