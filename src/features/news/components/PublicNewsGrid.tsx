"use client";

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { TagLabel } from '@/app/components/ui/TagLabel';
import { Button } from '@/app/components/ui/Button';
import { TabSegmentControl } from '@/app/components/ui/TabSegmentControl';
import { categories } from '@/lib/news-data';
import { PublicNewsArticle } from '@/features/news/types';

const DEFAULT_GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12';
const NEWS_CATEGORIES = categories;
type NewsCategory = (typeof NEWS_CATEGORIES)[number];

type PublicNewsGridHomeProps = {
  variant: 'home';
  articles?: PublicNewsArticle[];
  /** 未指定時は 3 */
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
  const fetchLimit = variant === 'home' ? (props.fetchLimit ?? 3) : undefined;

  useEffect(() => {
    if (!shouldFetch) {
      return;
    }

    const query = new URLSearchParams();
    if (typeof fetchLimit === 'number') {
      query.set('limit', String(fetchLimit));
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
  }, [shouldFetch, fetchLimit]);

  const resolvedArticles = useMemo(
    () => (typeof props.articles === 'undefined' ? fetchedArticles : props.articles),
    [fetchedArticles, props.articles],
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

  const renderGrid = () => (
    <div className={gridClassName}>
      {displayArticles.map((article) => (
        <Link key={article.id} href={resolveBuildHref(article)}>
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
                <TagLabel className="font-acumin" size="md">
                  {article.category}
                </TagLabel>
              </div>

              <h2
                className="text-xl text-black group-hover:text-[#474747] transition-colors duration-300"
                style={{ fontFamily: 'Didot, serif' }}
              >
                {article.title}
              </h2>

              <p
                className="text-sm text-[#474747] leading-relaxed line-clamp-3"
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
      ))}
    </div>
  );

  // home variant rendering
  if (variant === 'home') {
    return (
      <section id="news" className="lg:py-32 px-6 lg:px-12 bg-white w-full">
        <div className="max-w-7xl mx-auto">
          <div className="text-left mb-8">
            <h2 className="text-xl lg:text-2xl mb-2 text-black tracking-tight underline underline-offset-8 decoration-black decoration-1">
              NEWS
            </h2>
          </div>

          {loading ? (
            <div className="text-center py-20">
              <p className="text-lg text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                読み込み中...
              </p>
            </div>
          ) : error ? (
            <div className="text-center py-20">
              <p className="text-lg text-red-500" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                {error}
              </p>
            </div>
          ) : resolvedArticles.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-lg text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                現在、公開されている記事はありません
              </p>
            </div>
          ) : (
            renderGrid()
          )}

          <div className="text-center mt-16">
            <Button href="/news" variant="secondary" size="md" className="font-acumin">
              VIEW ALL NEWS
            </Button>
          </div>
        </div>
      </section>
    );
  }

  // catalog variant rendering
  return (
    <>
      <div className="flex items-center justify-center space-x-6 mb-16">
        <TabSegmentControl
          items={NEWS_CATEGORIES.map((category) => ({ key: category, label: category }))}
          activeKey={selectedCategory}
          onChange={(category) => setSelectedCategory(category as NewsCategory)}
          variant="segment-pill"
          size="md"
        />
      </div>
      {loading ? (
        <div className="text-center py-20">
          <p className="text-lg text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            読み込み中...
          </p>
        </div>
      ) : error ? (
        <div className="text-center py-20">
          <p className="text-lg text-red-500" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            {error}
          </p>
        </div>
      ) : resolvedArticles.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-lg text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            現在、公開されている記事はありません
          </p>
        </div>
      ) : displayArticles.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-lg text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            該当カテゴリの記事はありません
          </p>
        </div>
      ) : (
        renderGrid()
      )}
    </>
  );
}
