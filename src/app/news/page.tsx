import React from "react";
import { categories } from "@/lib/news-data";
import { NewsCategoryTabs } from '@/app/news/NewsCategoryTabs';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';
import { getPublishedNews } from '@/features/news/services/public';
import { PublicNewsArticle } from '@/features/news/types';

export default async function NewsPage({
  searchParams,
}: {
  searchParams?: Promise<{ category?: string }>;
}) {
  const params = await searchParams;
  const selectedCategory = (params?.category ?? "ALL").toUpperCase();
  const activeCategory = categories.includes(
    selectedCategory as (typeof categories)[number],
  )
    ? (selectedCategory as (typeof categories)[number])
    : "ALL";

  const newsData: PublicNewsArticle[] = await getPublishedNews({
    category: activeCategory,
  });

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        {/* Category Filter Tabs */}
        <NewsCategoryTabs activeCategory={activeCategory} />

        {/* News Grid */}
        {newsData.length === 0 ? (
          <div className="text-center py-20">
            <p
              className="text-lg text-[#474747]"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              現在、公開されている記事はありません
            </p>
          </div>
        ) : (
          <PublicNewsGrid
            articles={newsData}
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12"
            buildHref={(article) =>
              activeCategory === "ALL"
                ? `/news/${article.id}`
                : `/news/${article.id}?category=${activeCategory}`
            }
          />
        )}
      </div>
    </main>
  );
}
