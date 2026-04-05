import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { categories } from "@/lib/news-data";
import { Button } from '@/components/ui/Button';
import { TagLabel } from '@/components/ui/TagLabel';
import { getPublishedNewsDetailById, getPublishedNewsNavigation } from '@/features/news/services/public';

interface NewsDetailPageProps {
  params: Promise<{
    id: string;
  }>;
  searchParams?: Promise<{
    category?: string;
  }>;
}

export default async function NewsDetailPage({
  params,
  searchParams,
}: NewsDetailPageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const selectedCategory = (resolvedSearchParams?.category ?? "ALL").toUpperCase();
  const activeCategory = categories.includes(
    selectedCategory as (typeof categories)[number],
  )
    ? (selectedCategory as (typeof categories)[number])
    : "ALL";
  
  const article = await getPublishedNewsDetailById(resolvedParams.id, {
    category: activeCategory,
  });

  if (!article) {
    notFound();
  }

  const { prevArticle, nextArticle } = await getPublishedNewsNavigation(resolvedParams.id, {
    category: activeCategory,
  });

  const navCategoryParam = activeCategory === "ALL" ? "" : `?category=${activeCategory}`;

  return (
    <div className="pt-6 sm:pt-8 lg:pt-12 pb-12 sm:pb-16 lg:pb-20 px-5 sm:px-6 lg:px-12">
      <div className="max-w-3xl mx-auto">
        {/* Article Header */}
        <div className="mb-8 sm:mb-10">
          <div className="flex items-center gap-3 sm:gap-4 mb-4 sm:mb-5">
            <span
              className="text-[11px] sm:text-xs text-[#474747] tracking-widest"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              {article.published_date.replace(/-/g, '.')}
            </span>
            <TagLabel className="font-acumin" size="sm">
              {article.category}
            </TagLabel>
          </div>
          <h1
            className="text-base md:text-2xl text-black leading-snug"
            style={{ fontFamily: "Didot, serif" }}
          >
            {article.title}
          </h1>
        </div>

        {/* Article Content */}
        <div
          className="border-t border-black/10 pt-8 sm:pt-10"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          {article.detailed_content.split("\n\n").map((paragraph: string, index: number) => (
            <p
              key={index}
              className="text-xs md:text-sm text-[#474747] leading-loose mb-5 sm:mb-7 whitespace-pre-line"
            >
              {paragraph}
            </p>
          ))}
        </div>

        {/* Navigation */}
        <div className="mt-12 sm:mt-16 pt-6 sm:pt-8 border-t border-[#d5d0c9]">

          {/* Mobile layout: PREV/NEXT row → VIEW ALL centered */}
          <div className="sm:hidden">
            <div className="flex items-start justify-between mb-5">
              {/* Previous Article */}
              {prevArticle ? (
                <Link
                  href={`/news/${prevArticle.id}${navCategoryParam}`}
                  className="group flex items-start gap-2 max-w-[45%]"
                >
                  <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors mt-0.5 text-sm">
                    ←
                  </span>
                  <div className="min-w-0">
                    <p
                      className="text-[10px] text-[#999] tracking-widest mb-0.5"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      PREV
                    </p>
                    <p
                      className="text-[11px] text-[#474747] group-hover:text-black transition-colors leading-snug line-clamp-2"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      {prevArticle.title}
                    </p>
                  </div>
                </Link>
              ) : (
                <div className="max-w-[45%]" />
              )}

              {/* Next Article */}
              {nextArticle ? (
                <Link
                  href={`/news/${nextArticle.id}${navCategoryParam}`}
                  className="group flex items-start gap-2 max-w-[45%] text-right"
                >
                  <div className="min-w-0">
                    <p
                      className="text-[10px] text-[#999] tracking-widest mb-0.5"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      NEXT
                    </p>
                    <p
                      className="text-[11px] text-[#474747] group-hover:text-black transition-colors leading-snug line-clamp-2"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      {nextArticle.title}
                    </p>
                  </div>
                  <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors mt-0.5 text-sm">
                    →
                  </span>
                </Link>
              ) : (
                <div className="max-w-[45%]" />
              )}
            </div>

            {/* VIEW ALL centered */}
            <div className="flex justify-center pt-2">
              <Button href={`/news${navCategoryParam}`} size="sm" className="font-acumin">
                VIEW ALL
              </Button>
            </div>
          </div>

          {/* Desktop layout: 3-column grid (sm and up) */}
          <div className="hidden sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-4">
            {/* Previous Article */}
            {prevArticle ? (
              <Link
                href={`/news/${prevArticle.id}${navCategoryParam}`}
                className="group flex items-center gap-3 justify-self-start"
              >
                <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors">
                  ←
                </span>
                <div className="min-w-0">
                  <p
                    className="text-xs text-[#999] tracking-widest"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    PREV
                  </p>
                  <p
                    className="text-xs sm:text-sm text-[#474747] group-hover:text-black transition-colors max-w-[160px] md:max-w-[220px] lg:max-w-[280px] truncate"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    {prevArticle.title}
                  </p>
                </div>
              </Link>
            ) : (
              <div />
            )}

            {/* View All Button */}
            <Button href={`/news${navCategoryParam}`} size="sm" className="justify-self-center font-acumin">
              VIEW ALL
            </Button>

            {/* Next Article */}
            {nextArticle ? (
              <Link
                href={`/news/${nextArticle.id}${navCategoryParam}`}
                className="group flex items-center gap-3 justify-self-end text-right"
              >
                <div className="min-w-0">
                  <p
                    className="text-xs text-[#999] tracking-widest"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    NEXT
                  </p>
                  <p
                    className="text-xs sm:text-sm text-[#474747] group-hover:text-black transition-colors max-w-[160px] md:max-w-[220px] lg:max-w-[280px] truncate"
                    style={{ fontFamily: "acumin-pro, sans-serif" }}
                  >
                    {nextArticle.title}
                  </p>
                </div>
                <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors">
                  →
                </span>
              </Link>
            ) : (
              <div />
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
