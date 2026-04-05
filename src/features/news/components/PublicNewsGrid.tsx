"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { TagLabel } from '@/components/ui/TagLabel';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
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
  className?: string;
  buildHref?: (article: PublicNewsArticle) => string;
};

type PublicNewsGridProps = PublicNewsGridHomeProps | PublicNewsGridCatalogProps;

export function PublicNewsGrid(props: PublicNewsGridProps) {
  const { variant, className } = props;
  const [fetchedArticles, setFetchedArticles] = useState<PublicNewsArticle[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<NewsCategory>('ALL');
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const mobileFilterRef = useRef<HTMLDivElement>(null);

  // Close mobile dropdown when clicking outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (mobileFilterRef.current && !mobileFilterRef.current.contains(e.target as Node)) {
        setMobileFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

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
    if (variant !== 'catalog' || selectedCategory === 'ALL') {
      return resolvedArticles;
    }

    return resolvedArticles.filter((article) => article.category === selectedCategory);
  }, [resolvedArticles, selectedCategory, variant]);

  const resolveBuildHref = (article: PublicNewsArticle): string => {
    if (variant === 'catalog') {
      if (props.buildHref) return props.buildHref(article);
      return selectedCategory !== 'ALL'
        ? `/news/${article.id}?category=${selectedCategory}`
        : `/news/${article.id}`;
    }
    return `/news/${article.id}`;
  };

  // Mobile: show only 3 articles on home variant (hidden lg:block hides them below lg breakpoint)
  const resolvedMobileLimit = variant === 'home' ? 3 : undefined;
  const shouldLimitOnMobile = typeof resolvedMobileLimit === 'number';
  const hasHiddenItemsOnMobile = shouldLimitOnMobile && resolvedArticles.length > resolvedMobileLimit;

  const renderGrid = () => (
    <div className={cn('border-t border-black/10', className)}>
      {displayArticles.map((article, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit!;

        return (
          <Link
            key={article.id}
            href={resolveBuildHref(article)}
            className={hideOnMobile ? 'hidden md:block' : 'block'}
          >
            <article className="border-b border-black/10 py-4 sm:py-5 xl:py-7 group cursor-pointer">
              <div className="sm:flex sm:items-start sm:gap-8 xl:gap-12">
                {/* Date column: inline with category on mobile, fixed-width on sm+ */}
                <div className="flex items-center gap-3 mb-2 sm:mb-0 sm:w-28 xl:w-36 sm:flex-shrink-0 sm:pt-0.5">
                  <span
                    className="text-[11px] sm:text-xs text-[#474747] tracking-widest whitespace-nowrap"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                  >
                    {article.published_date.replace(/-/g, '.')}
                  </span>
                  {/* Category tag: mobile only */}
                  <div className="sm:hidden">
                    <TagLabel className="font-acumin" size="sm">
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

                  <h2
                    className="text-sm sm:text-base xl:text-lg text-black leading-snug mb-1.5 sm:mb-2 xl:mb-2.5 group-hover:text-[#474747] transition-colors duration-300 font-brand"
                  >
                    {article.title}
                  </h2>

                  <p
                    className="text-xs sm:text-sm text-[#474747] leading-relaxed line-clamp-2 sm:line-clamp-3"
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
      <p className="text-lg text-[#474747] font-brand">
        {message}
      </p>
    </div>
  );

  const renderError = () => (
    <div className="text-center py-20">
      <p className="text-lg text-red-500 font-brand">
        {error}
      </p>
    </div>
  );

  const renderLoading = () => (
    <div className="text-center py-20">
      <p className="text-lg text-[#474747] font-brand">
        読み込み中...
      </p>
    </div>
  );

  // home variant rendering
  if (variant === 'home') {
    return (
      <section id="news" className="mt-14 sm:mt-16 lg:mt-20 pb-14 sm:pb-16 md:pb-20 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto">
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
                  <Button href="/news" variant="secondary" size="md" className="font-acumin">
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
      {/* Category filter */}
      <div className="mb-8 sm:mb-10 md:mb-16">
        {/* Mobile: custom dropdown */}
        <div className="sm:hidden relative" ref={mobileFilterRef}>
          <button
            type="button"
            onClick={() => setMobileFilterOpen((prev) => !prev)}
            className="flex w-full items-center justify-between border border-black/20 px-4 py-3 text-xs tracking-widest transition-colors hover:border-black"
            style={{ fontFamily: 'acumin-pro, sans-serif' }}
            aria-expanded={mobileFilterOpen}
            aria-haspopup="listbox"
          >
            <span className="text-black/40">CATEGORY</span>
            <span className="flex items-center gap-2.5">
              <span className="text-black">{selectedCategory}</span>
              <i
                className={cn(
                  'ri-arrow-down-s-line text-base text-black transition-transform duration-200',
                  mobileFilterOpen && 'rotate-180',
                )}
              />
            </span>
          </button>
          {mobileFilterOpen && (
            <div
              role="listbox"
              aria-label="カテゴリ"
              className="absolute left-0 right-0 z-20 border border-t-0 border-black/20 bg-white shadow-sm"
            >
              {NEWS_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  role="option"
                  aria-selected={cat === selectedCategory}
                  onClick={() => {
                    setSelectedCategory(cat as NewsCategory);
                    setMobileFilterOpen(false);
                  }}
                  className={cn(
                    'block w-full text-left px-4 py-3 text-xs tracking-widest transition-colors',
                    cat === selectedCategory
                      ? 'bg-black text-white'
                      : 'text-black hover:bg-[#f5f5f5]',
                  )}
                  style={{ fontFamily: 'acumin-pro, sans-serif' }}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* sm+: pill tabs */}
        <div className={cn('hidden sm:block', TAB_SCROLL_CONTAINER_CLASS, 'md:flex md:justify-center')}>
          <TabSegmentControl
            items={NEWS_CATEGORIES.map((category) => ({ key: category, label: category }))}
            activeKey={selectedCategory}
            onChange={(category) => setSelectedCategory(category as NewsCategory)}
            variant="segment-pill"
            size="md"
            className="min-w-max"
          />
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
    </>
  );
}
