"use client";

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { TagLabel } from '@/components/ui/TagLabel';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { TabSegmentControl } from '@/components/ui/TabSegmentControl';
import { categories } from '@/lib/news-data';
import { cn } from '@/lib/utils';
import { PublicNewsArticle } from '@/features/news/types';

const DEFAULT_GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-8 lg:gap-12';
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

  const gridClassName = className ?? DEFAULT_GRID_CLASS;

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
    <div className={gridClassName}>
      {displayArticles.map((article, index) => {
        const hideOnMobile = shouldLimitOnMobile && index >= resolvedMobileLimit!;

        return (
          <Link key={article.id} href={resolveBuildHref(article)} className={hideOnMobile ? 'hidden lg:block' : undefined}>
            <article className="group cursor-pointer">
              <div className="aspect-[4/3] overflow-hidden mb-6 bg-[#f5f5f5] relative">
                <Image
                  alt={article.title}
                  className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                  src={article.image_url}
                  width={1200}
                  height={750}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-4">
                  <span
                    className="text-xs text-[#474747] tracking-widest"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                  >
                    {article.published_date.replace(/-/g, '.')}
                  </span>
                  <TagLabel className="font-acumin" size="sm">
                    {article.category}
                  </TagLabel>
                </div>

                <h2
                  className="text-sm md:text-base lg:text-lg text-black font-brand group-hover:text-[#474747] transition-colors duration-300"
                >
                  {article.title}
                </h2>

                <p
                  className="text-xs text-[#474747] leading-relaxed line-clamp-3"
                  style={{ fontFamily: 'acumin-pro, sans-serif' }}
                >
                  {article.content}
                </p>

                <div className="pt-2">
                  <span
                    className="text-xs text-black tracking-widest group-hover:underline"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                  >
                    READ MORE →
                  </span>
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
      <section id="news" className="mt-14 lg:mt-20 px-6 lg:px-12 bg-white w-full md:pb-20 lg:pb-20">
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
      <div className="mb-10 md:mb-16">
        <div className={cn(TAB_SCROLL_CONTAINER_CLASS, 'md:flex md:justify-center')}>
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
