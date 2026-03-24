import React from "react";
import Link from "next/link";
import Image from "next/image";
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
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-4xl mx-auto">
        {/* Article Header */}
        <div className="mb-8">
          <div className="flex items-center space-x-4 mb-6">
            <span
              className="text-xs text-[#474747] tracking-widest"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              {article.published_date.replace(/-/g, '.')}
            </span>
            <TagLabel className="font-acumin" size="md">
              {article.category}
            </TagLabel>
          </div>
          <h1
            className="text-4xl lg:text-5xl text-black mb-8"
            style={{ fontFamily: "Didot, serif" }}
          >
            {article.title}
          </h1>
        </div>

        {/* Article Image */}
        <div className="aspect-[16/10] overflow-hidden mb-12 bg-[#f5f5f5] relative">
          <Image
            alt={article.title}
            className="w-full h-full object-cover object-center"
            src={article.image_url}
            width={1200}
            height={750}
            priority
          />
        </div>

        {/* Article Content */}
        <div
          className="prose prose-lg max-w-none"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          {article.detailed_content.split("\n\n").map((paragraph: string, index: number) => (
            <p
              key={index}
              className="text-[#474747] leading-relaxed mb-6 whitespace-pre-line"
            >
              {paragraph}
            </p>
          ))}
        </div>

        {/* Navigation */}
        <div className="mt-16 pt-8 border-t border-[#d5d0c9] grid grid-cols-[1fr_auto_1fr] items-center">
          {/* Previous Article */}
          {prevArticle ? (
            <Link
              href={`/news/${prevArticle.id}${navCategoryParam}`}
              className="group flex items-center space-x-3 cursor-pointer justify-self-start"
            >
              <span className="w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors">
                ←
              </span>
              <div>
                <p
                  className="text-xs text-[#999] tracking-widest"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  PREV
                </p>
                <p
                  className="text-sm text-[#474747] group-hover:text-black transition-colors max-w-[200px] truncate"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  {prevArticle.title}
                </p>
              </div>
            </Link>
          ) : (
            <div></div>
          )}

          {/* View All Button */}
          <Button href={`/news${navCategoryParam}`} size="sm" className="justify-self-center font-acumin">
            VIEW ALL
          </Button>

          {/* Next Article */}
          {nextArticle ? (
            <Link
              href={`/news/${nextArticle.id}${navCategoryParam}`}
              className="group flex items-center space-x-3 cursor-pointer text-right justify-self-end"
            >
              <div>
                <p
                  className="text-xs text-[#999] tracking-widest"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  NEXT
                </p>
                <p
                  className="text-sm text-[#474747] group-hover:text-black transition-colors max-w-[200px] truncate"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  {nextArticle.title}
                </p>
              </div>
              <span className="w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors">
                →
              </span>
            </Link>
          ) : (
            <div></div>
          )}
        </div>
      </div>
    </main>
  );
}
